import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  abandonJob, acceptJobRisk, approveJob, isCurrent, loadJob, rejectJob, resumeJob, targetOf,
  type ActionOutcome, type ActionTarget, type JobActionDeps,
} from '../core/job-actions.js';
import { waitForLockFile } from '../core/lock.js';
import { antonHome } from '../core/paths.js';
import { listProjects } from '../core/registry.js';
import { STAGES } from '../core/state.js';
import { decideProposal, readProposals, proposalRevision } from '../lessons/proposals.js';
import {
  appIdSchema, channelIdSchema, readSlackFile, slackDirectory, SLACK_ROLES, writeSlackFile, type SlackConfig, type SlackRole,
} from './config.js';
import { jobId as jobIdSchema, projectId as projectIdSchema } from './events.js';
import { sanitizeSlackText } from './inbound.js';
import type { SpecRoundDeps } from '../core/spec-continuation.js';
import { cardModal, type ModalKind, type ModalView } from './views.js';
import { answerQuestion, statusLines, type ChatDeps } from './chat.js';

/*
 * The Slack side of the shared job actions. Every input is a typed, allowlisted operation. Mutations need
 * the configured workspace and owner IDs and a source app that matches its role. Card targets come from the
 * stored binding, never from the click. Each mutation is claimed once per Slack identity in
 * ~/anton/slack/actions.json before any work, and the job action rechecks state under its own lock.
 */

export type SlackActor = { teamId: string; userId: string; isBot: boolean };
export type SlackSource = { appId: string; role: SlackRole; channelId: string; messageTs?: string; threadTs?: string };
/** Values a card's form (Task 5 modals) may carry. All text is cleaned here before use. */
export type CardInput = { notes?: string; reason?: string; text?: string; budgetUsd?: number };

export type SlackAction =
  | { via: 'command'; key: string; actor: SlackActor; source: SlackSource; text: string }
  | { via: 'card'; key: string; actor: SlackActor; source: SlackSource; token: string; input?: CardInput; triggerId?: string }
  /**
   * Plain messages are never orders, with two explicit exceptions for the owner: answers to waiting spec
   * questions in the job thread, and `new …` / `change <project> …` in a DM to the PM. Mentions of a role
   * bot, and DMs to one, are questions (role Q&A): answered from the records, never acted on.
   */
  | {
    via: 'message'; key: string; actor: SlackActor; source: SlackSource; text: string; eventType?: 'message' | 'app_mention';
    /** User and bot IDs mentioned in the raw text, in order. */
    mentions?: string[];
  };

export type ActionResultStatus =
  | 'done' | 'duplicate' | 'in-progress' | 'denied' | 'ignored' | 'stale' | 'refused' | 'unsupported' | 'failed';
export type ActionResult = { status: ActionResultStatus; lines: string[] };

export const CARD_KINDS = [
  'approve', 'reject', 'resume', 'abandon', 'accept-risk', 'spec-revise', 'lesson-accept', 'lesson-edit', 'lesson-reject',
] as const;
/** Cards whose click opens a form; the submission carries the input. */
const MODAL_KINDS: readonly CardKind[] = ['reject', 'spec-revise', 'accept-risk', 'lesson-edit', 'resume'];
export type CardKind = (typeof CARD_KINDS)[number];
/** Roles whose apps have interactivity enabled in the manifest. */
const INTERACTIVE_ROLES: readonly SlackRole[] = ['pm', 'qa', 'coach'];

/** The typed operations the router runs. */
export type Operation =
  | { kind: 'status'; project?: string }
  | { kind: 'approve'; target: ActionTarget }
  | { kind: 'reject'; target: ActionTarget; notes: string }
  | { kind: 'resume'; target: ActionTarget; budget?: number; acceptAsIs?: boolean }
  | { kind: 'abandon'; target: ActionTarget }
  | { kind: 'accept-risk'; target: ActionTarget; findingId: string; reason: string }
  | { kind: 'lesson'; decision: 'accept' | 'reject'; proposal: { id: string; revision: string }; text?: string }
  | { kind: 'start'; mode: 'new' | 'change'; project?: string; description: string }
  | { kind: 'spec-answer'; target: ActionTarget; round: number; answers: string[] }
  | { kind: 'spec-revise'; target: ActionTarget; notes: string }
  | { kind: 'spec-retry'; target: ActionTarget };

export const NOTES_LIMIT = 4000;
export const REASON_LIMIT = 500;
export const DESCRIPTION_LIMIT = 2000;
export const ANSWER_LIMIT = 4000;
const LESSON_LIMIT = 300;
const COMMAND_LIMIT = 200;
const RECORD_TTL_MS = 30 * 24 * 3600_000;
const CARD_TTL_MS = 90 * 24 * 3600_000;
const MAX_RECORDS = 5000;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ts = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{64}|delivered-[1-9]\d{0,14}|paused-\d{1,15})$/);
const targetSchema = z.strictObject({ project: projectIdSchema, jobId: jobIdSchema, stage: z.enum(STAGES), revision: revision.optional() });
const proposalRef = z.strictObject({ id: z.string().min(1).max(200), revision: digest });
const cardSchema = z.strictObject({
  kind: z.enum(CARD_KINDS),
  appId: appIdSchema,
  role: z.enum(SLACK_ROLES),
  channelId: channelIdSchema,
  messageTs: ts.optional(),
  target: targetSchema.optional(),
  findingId: z.string().regex(/^SEC-[A-Za-z0-9-]{1,40}$/).optional(),
  proposal: proposalRef.optional(),
  createdAt: z.number(),
  /** Set once an action from this card is done: a card acts at most once. */
  usedAt: z.number().optional(),
});
const resultSchema = z.strictObject({
  status: z.enum(['done', 'duplicate', 'in-progress', 'denied', 'ignored', 'stale', 'refused', 'unsupported', 'failed']),
  lines: z.array(z.string().max(1000)).max(40),
});
const recordSchema = z.strictObject({
  status: z.enum(['claimed', 'finished']),
  pid: z.number().int().positive(),
  claim: z.string().uuid(),
  at: z.number(),
  token: z.string().max(64).optional(),
  /** The target bound when the action was claimed; a crashed claim is reconciled against it. */
  target: targetSchema.optional(),
  proposal: proposalRef.optional(),
  result: resultSchema.optional(),
});
const KEY = /^(?:cmd|card|event):[A-Za-z0-9._:-]{1,200}$/;
const storeSchema = z.strictObject({
  version: z.literal(1),
  records: z.record(z.string().regex(KEY), recordSchema),
  cards: z.record(z.string().regex(/^[a-f0-9]{32}$/), cardSchema),
});
type Store = z.infer<typeof storeSchema>;
type ActionRecord = z.infer<typeof recordSchema>;
export type CardBinding = z.infer<typeof cardSchema>;

/** Claims started by this process that are still running. A claim held by a dead process is reconciled. */
const inFlight = new Set<string>();

async function withStore<T>(home: string, body: (store: Store) => Promise<{ value: T; write: boolean }>): Promise<T> {
  const root = (await slackDirectory(home, true))!;
  const release = await waitForLockFile(join(root, 'actions.lock'));
  try {
    const store = (await readSlackFile(home, 'actions.json', storeSchema)) ?? { version: 1 as const, records: {}, cards: {} };
    const { value, write } = await body(store);
    if (write) await writeSlackFile(home, 'actions.json', prune(store));
    return value;
  } finally {
    await release();
  }
}

function prune(store: Store, now = Date.now()): Store {
  const records = Object.entries(store.records)
    .filter(([, r]) => r.status === 'claimed' || now - r.at < RECORD_TTL_MS)
    .sort(([, a], [, b]) => b.at - a.at)
    .slice(0, MAX_RECORDS);
  const cards = Object.entries(store.cards).filter(([, c]) => now - c.createdAt < CARD_TTL_MS);
  return { version: 1, records: Object.fromEntries(records), cards: Object.fromEntries(cards) };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type NewCard = Omit<CardBinding, 'appId' | 'createdAt' | 'messageTs'> & { messageTs?: string };

/** Store what a button acts on before posting it (Task 5 cards). Returns the opaque token for the button value. */
export async function registerActionCard(card: NewCard, opts: { config: SlackConfig; home?: string }): Promise<string> {
  const token = randomBytes(16).toString('hex');
  const binding = cardSchema.parse({ ...card, appId: opts.config.roles[card.role].appId, createdAt: Date.now() });
  const jobKind = !card.kind.startsWith('lesson-');
  if (jobKind ? !binding.target : !binding.proposal) throw new Error('A card needs its target.');
  if (card.kind === 'accept-risk' && !binding.findingId) throw new Error('A risk card needs its finding.');
  await withStore(opts.home ?? antonHome(), async (store) => {
    store.cards[token] = binding;
    return { value: undefined, write: true };
  });
  return token;
}

/** Record the message a card was posted as; a click from any other message is refused. */
export async function attachCardMessage(token: string, channelId: string, messageTs: string, opts: { home?: string } = {}): Promise<boolean> {
  if (!ts.safeParse(messageTs).success) return false;
  return withStore(opts.home ?? antonHome(), async (store) => {
    const card = store.cards[token];
    if (!card || card.channelId !== channelId || (card.messageTs !== undefined && card.messageTs !== messageTs)) return { value: false, write: false };
    card.messageTs = messageTs;
    return { value: true, write: true };
  });
}

export interface DispatchDeps {
  config: SlackConfig;
  home?: string;
  /** The job action effects (spawn, Docker, Retro); output is collected per action. */
  jobs: Omit<JobActionDeps, 'out' | 'err'>;
  /** The project whose recorded channel ID this is. Defaults to the outbox's channel map. */
  projectForChannel?: (channelId: string) => Promise<string | undefined>;
  /** The job whose thread this is. Defaults to the outbox's thread map. */
  jobForThread?: (channelId: string, threadTs: string) => Promise<{ project: string; jobId: string } | undefined>;
  /** Spec session effects (Docker, the PM agent). Without them, starting work and spec answers are unsupported. */
  spec?: SlackSpecDeps;
  /** The channel recorded for a project. Defaults to the outbox's channel map. */
  channelForProject?: (project: string) => Promise<string | undefined>;
  /**
   * Live Slack reads (the PM's token) that verify a channel and its members by user ID. Without them,
   * only the owner's own commands work: nobody gets project data from a question or a member status.
   */
  access?: SlackAccess;
  /** Role Q&A effects (the model client and the chat budget). */
  chat?: ChatDeps;
}

export type ChannelFacts = { isPrivate: boolean; isShared: boolean; isArchived: boolean; teamId?: string };
export interface SlackAccess {
  channel(channelId: string): Promise<ChannelFacts | undefined>;
  members(channelId: string): Promise<string[]>;
}

export type SlackSpecDeps = Omit<SpecRoundDeps, 'surface'> & { preflight: () => Promise<void> };

export type ModalDecision =
  | { kind: 'modal'; view: ModalView }
  | { kind: 'direct' }
  | { kind: 'denied' | 'refused'; result: ActionResult };

const result = (status: ActionResultStatus, ...lines: string[]): ActionResult => ({ status, lines });
const DENIED = result('denied', 'Only the Anton owner can do that here.');
const USED = result('stale', 'That card was already used. Nothing was changed.');

function authorized(a: SlackAction, config: SlackConfig): boolean {
  if (!KEY.test(a.key) || a.actor.isBot) return false;
  if (a.actor.teamId !== config.teamId || a.actor.userId !== config.ownerId) return false;
  const role = config.roles[a.source.role];
  if (!role || role.appId !== a.source.appId) return false;
  if (a.via === 'command') return a.source.role === 'pm';
  if (a.via === 'card') return INTERACTIVE_ROLES.includes(a.source.role);
  return true;
}

/** Route one normalized Slack input. Never throws; denied or forged input never reaches a job action. */
export async function dispatchSlackAction(input: SlackAction, deps: DispatchDeps): Promise<ActionResult> {
  try {
    const home = deps.home ?? antonHome();
    if (input.via === 'message') {
      const asked = await questionRoute(input, deps, home);
      if (asked) return asked;
      // Anyone else's message is discussion, never an answer or an order.
      if (!authorized(input, deps.config)) return result('ignored');
      const resolved = await messageOperation(input, deps, home);
      if ('status' in resolved) return resolved;
      if (resolved.op.kind === 'status') return result('ignored');
      return await claimAndRun(input, resolved.op, deps, home);
    }
    if (!authorized(input, deps.config)) {
      // A verified member of a project channel may read that project's status. Nothing else.
      if (input.via === 'command') return (await memberStatus(input, deps)) ?? DENIED;
      return DENIED;
    }
    const resolved = input.via === 'card' ? await cardOperation(input, home) : await commandOperation(input, deps);
    if ('status' in resolved) return resolved;
    const { op } = resolved;
    if (op.kind === 'status') return await status(op.project);
    return await claimAndRun(input, op, deps, home);
  } catch (e) {
    return result('failed', `That did not work: ${clean(e instanceof Error ? e.message : String(e))}`);
  }
}

async function boundCard(a: Extract<SlackAction, { via: 'card' }>, home: string): Promise<CardBinding | undefined> {
  if (!/^[a-f0-9]{32}$/.test(a.token)) return undefined;
  const card = (await readSlackFile(home, 'actions.json', storeSchema))?.cards[a.token];
  // Bound to the app, channel and message the card was posted as.
  if (!card || card.appId !== a.source.appId || card.role !== a.source.role || card.channelId !== a.source.channelId
    || card.messageTs === undefined || card.messageTs !== a.source.messageTs) return undefined;
  return card;
}

/**
 * For a click: whether to open the card's form first. Local reads only, so the modal opens before the trigger
 * expires. A click that is not the owner's, or not on the card as posted, opens nothing.
 */
export async function prepareCardModal(a: Extract<SlackAction, { via: 'card' }>, deps: DispatchDeps): Promise<ModalDecision> {
  if (!authorized(a, deps.config)) return { kind: 'denied', result: DENIED };
  const home = deps.home ?? antonHome();
  const card = await boundCard(a, home);
  if (!card || !a.source.messageTs) return { kind: 'denied', result: DENIED };
  if (card.usedAt !== undefined) return { kind: 'refused', result: USED };
  if (!MODAL_KINDS.includes(card.kind) || a.input) return { kind: 'direct' };
  let initial: string | undefined;
  if (card.kind === 'lesson-edit') {
    const p = (await readProposals(home)).find((x) => x.id === card.proposal?.id);
    if (!p || proposalRevision(p) !== card.proposal?.revision) return { kind: 'refused', result: result('stale', 'That proposal changed or was already decided.') };
    initial = p.text;
  }
  return { kind: 'modal', view: cardModal(card.kind as ModalKind, { token: a.token, channelId: card.channelId, messageTs: a.source.messageTs }, initial) };
}

async function cardOperation(a: Extract<SlackAction, { via: 'card' }>, home: string): Promise<{ op: Operation } | ActionResult> {
  const card = await boundCard(a, home);
  if (!card) return DENIED;
  const input = a.input ?? {};
  if (card.kind === 'lesson-accept' || card.kind === 'lesson-reject') {
    return { op: { kind: 'lesson', decision: card.kind === 'lesson-accept' ? 'accept' : 'reject', proposal: card.proposal! } };
  }
  if (card.kind === 'lesson-edit') {
    const text = sanitizeSlackText(input.text, LESSON_LIMIT);
    return text ? { op: { kind: 'lesson', decision: 'accept', proposal: card.proposal!, text } } : result('refused', 'Write the lesson text to save.');
  }
  const target = card.target!;
  switch (card.kind) {
    case 'approve': return { op: { kind: 'approve', target } };
    case 'abandon': return { op: { kind: 'abandon', target } };
    case 'reject': {
      const notes = sanitizeSlackText(input.notes, NOTES_LIMIT);
      return notes ? { op: { kind: 'reject', target, notes } } : result('refused', 'Add notes that say what to change.');
    }
    case 'spec-revise': {
      const notes = sanitizeSlackText(input.notes, NOTES_LIMIT);
      return notes ? { op: { kind: 'spec-revise', target, notes } } : result('refused', 'Add notes that say what to change in the spec.');
    }
    case 'resume': {
      const budget = input.budgetUsd;
      if (budget !== undefined && !(Number.isFinite(budget) && budget > 0)) return result('refused', 'The budget must be a positive number of USD.');
      return { op: { kind: 'resume', target, ...(budget === undefined ? {} : { budget }) } };
    }
    case 'accept-risk': {
      const reason = sanitizeSlackText(input.reason, REASON_LIMIT);
      return reason ? { op: { kind: 'accept-risk', target, findingId: card.findingId!, reason } } : result('refused', 'Give a reason for accepting the risk.');
    }
  }
}

const USAGE = 'Try: /anton status, /anton new <description> (in #anton), /anton change <description>, /anton spec retry, '
  + '/anton resume [budget <usd>] [accept-as-is], /anton abandon <job id>';

async function commandOperation(a: Extract<SlackAction, { via: 'command' }>, deps: DispatchDeps): Promise<{ op: Operation } | ActionResult> {
  const text = sanitizeSlackText(a.text, DESCRIPTION_LIMIT + 50);
  const first = (text.split(/\s+/)[0] ?? '').toLowerCase();
  const words = (first === 'new' || first === 'change' ? text : text.slice(0, COMMAND_LIMIT)).split(/\s+/).filter(Boolean);
  const verb = (words.shift() ?? 'status').toLowerCase();
  const inAnton = a.source.channelId === deps.config.channelId;
  const lookup = deps.projectForChannel ?? (async (channel: string) => {
    const { projectForChannel } = await import('./outbox.js');
    return projectForChannel({ config: deps.config, home: deps.home }, channel);
  });
  const project = inAnton ? undefined : await lookup(a.source.channelId);
  if (verb === 'help') return result('done', USAGE);
  if (verb === 'new' || verb === 'change') {
    const description = sanitizeSlackText(words.join(' '), DESCRIPTION_LIMIT);
    if (!description) return result('refused', `Describe the work: /anton ${verb} <description>`);
    if (verb === 'new') {
      return inAnton ? { op: { kind: 'start', mode: 'new', description } } : result('refused', 'Start new projects in #anton.');
    }
    return project ? { op: { kind: 'start', mode: 'change', project, description } } : result('refused', 'Run /anton change in the project channel.');
  }
  if (verb === 'spec') {
    if (words.join(' ').toLowerCase() !== 'retry') return result('refused', 'Answer spec questions in the job thread. To rerun an interrupted PM turn: /anton spec retry');
    if (!project) return result('refused', 'Run this in the project channel.');
    const job = await loadJob(project);
    return { op: { kind: 'spec-retry', target: targetOf(job) } };
  }
  if (verb === 'status') {
    if (words.length) return result('refused', USAGE);
    if (inAnton) return { op: { kind: 'status' } };
    return project ? { op: { kind: 'status', project } } : result('refused', 'Use /anton in #anton or in a project channel.');
  }
  if (verb === 'approve' || verb === 'reject' || verb === 'accept-risk') {
    return result('refused', 'Decide reviews with the buttons on the review card in the job thread.');
  }
  if (verb !== 'resume' && verb !== 'abandon') return result('refused', `Unknown command. ${USAGE}`);
  if (!project) return result('refused', 'Run this in the project channel.');
  const job = await loadJob(project);
  if (verb === 'abandon') {
    // Naming the job binds the order to it, so a newer job is never abandoned by an old intention.
    const [id, ...rest] = words;
    if (!id || rest.length) return result('refused', `Name the job to abandon: /anton abandon ${job.jobId}`);
    if (!jobIdSchema.safeParse(id).success || id !== job.jobId) {
      return result('stale', `${project}: job ${clean(id)} is not the current job (now ${job.jobId}). Nothing was changed.`);
    }
    return { op: { kind: 'abandon', target: { ...targetOf(job), jobId: id } } };
  }
  let budget: number | undefined;
  let acceptAsIs = false;
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!.toLowerCase().replace(/^--/, '');
    if (w === 'accept-as-is') acceptAsIs = true;
    else if (w === 'budget' && i + 1 < words.length) {
      budget = Number(words[++i]!.replace(/^\$/, ''));
      if (!Number.isFinite(budget) || budget <= 0) return result('refused', 'The budget must be a positive number of USD.');
    } else return result('refused', USAGE);
  }
  return { op: { kind: 'resume', target: targetOf(job), ...(budget === undefined ? {} : { budget }), ...(acceptAsIs ? { acceptAsIs } : {}) } };
}

/** Whether a thread message can be the owner's answer to the PM: it mentions no user or bot but the PM. */
function answersThePm(a: Extract<SlackAction, { via: 'message' }>, config: SlackConfig): boolean {
  return (a.mentions ?? []).every((id) => id === config.roles.pm.botUserId);
}

/** The owner's thread replies and DM instructions. Everything else is discussion (`ignored`). */
async function messageOperation(
  a: Extract<SlackAction, { via: 'message' }>, deps: DispatchDeps, home: string,
): Promise<{ op: Operation } | ActionResult> {
  // A mention also arrives as a message event; only the message event can act, so one reply acts once.
  if (a.eventType === 'app_mention' || a.source.role !== 'pm') return result('ignored');
  const text = sanitizeSlackText(a.text, ANSWER_LIMIT);
  if (/^D[A-Z0-9]+$/.test(a.source.channelId)) {
    if (a.source.threadTs) return result('ignored');
    const m = /^(new|change)\s+([\s\S]+)$/i.exec(text);
    if (!m) return result('ignored');
    if (m[1]!.toLowerCase() === 'new') {
      const description = sanitizeSlackText(m[2], DESCRIPTION_LIMIT);
      return description ? { op: { kind: 'start', mode: 'new', description } } : result('ignored');
    }
    const c = /^([a-z0-9]+(?:-[a-z0-9]+)*)\s+([\s\S]+)$/.exec(m[2]!);
    if (!c) return result('refused', 'Name the project: change <project> <description>');
    return { op: { kind: 'start', mode: 'change', project: c[1]!, description: sanitizeSlackText(c[2], DESCRIPTION_LIMIT) } };
  }
  if (!a.source.threadTs) return result('ignored');
  // An answer mentions nobody but the PM. A message that mentions another role or person is addressed to them.
  if (!answersThePm(a, deps.config)) return result('ignored');
  const lookup = deps.jobForThread ?? (async (channel: string, thread: string) => {
    const { jobForThread } = await import('./outbox.js');
    return jobForThread({ config: deps.config, home: deps.home }, channel, thread);
  });
  const job = await lookup(a.source.channelId, a.source.threadTs);
  if (!job) return result('ignored');
  const { readSpecContinuation, specStatus } = await import('../core/spec-continuation.js');
  const c = await readSpecContinuation(job.project, job.jobId, home).catch(() => undefined);
  if (!c) return result('ignored');
  const status = specStatus(c);
  if (status === 'stopped') {
    return result('refused', `${job.project}: the last PM turn was interrupted and its result is unknown (it may have been charged).`,
      'Nothing was repeated. To run it again: /anton spec retry');
  }
  if (status !== 'awaiting' || !c.questions?.length) return result('ignored');
  const { parseThreadAnswers } = await import('./spec-session.js');
  const answers = parseThreadAnswers(text, c.questions.length);
  if (!answers) return result('refused', `Number your answers 1. to ${c.questions.length}. so each reaches its question.`);
  return { op: { kind: 'spec-answer', target: { project: job.project, jobId: job.jobId, stage: 'spec' }, round: c.round, answers } };
}

async function status(project?: string): Promise<ActionResult> {
  return result('done', ...(await statusLines(project)));
}

const NOT_MEMBER = result('denied', 'Anton answers project questions only for verified members of that project\'s channel.');
const POINTER = 'Ask in your project\'s channel. Anton answers project questions only there, to its members.';

/**
 * Whether the channel is a private, workspace-local, unarchived channel and the user is in it now, by user
 * ID. Read live every time, so a removed member loses access at once. Any doubt means no.
 */
async function verifiedMember(channelId: string, userId: string, deps: DispatchDeps): Promise<boolean> {
  if (!deps.access) return false;
  try {
    const info = await deps.access.channel(channelId);
    if (!info || !info.isPrivate || info.isShared || info.isArchived) return false;
    if (info.teamId !== undefined && info.teamId !== deps.config.teamId) return false;
    return (await deps.access.members(channelId)).includes(userId);
  } catch {
    return false;
  }
}

/** Registered projects named as whole words in the text. */
async function namedProjects(text: string): Promise<string[]> {
  const lower = text.toLowerCase();
  const names = (await listProjects().catch(() => [])).map((p) => p.name);
  return names.filter((name) => new RegExp(`(?:^|[^a-z0-9-])${name.replace(/[^a-z0-9-]/g, '')}(?:$|[^a-z0-9-])`).test(lower));
}

const lookupProject = (deps: DispatchDeps) => deps.projectForChannel ?? (async (channel: string) => {
  const { projectForChannel } = await import('./outbox.js');
  return projectForChannel({ config: deps.config, home: deps.home }, channel);
});

/** `/anton status` from a verified member, in that project's channel only. */
async function memberStatus(a: Extract<SlackAction, { via: 'command' }>, deps: DispatchDeps): Promise<ActionResult | undefined> {
  const { config } = deps;
  if (!KEY.test(a.key) || a.actor.isBot || a.actor.teamId !== config.teamId) return undefined;
  if (a.source.role !== 'pm' || config.roles.pm.appId !== a.source.appId || a.source.channelId === config.channelId) return undefined;
  const verb = sanitizeSlackText(a.text, COMMAND_LIMIT).toLowerCase();
  if (verb !== '' && verb !== 'status') return undefined;
  const project = await lookupProject(deps)(a.source.channelId);
  if (!project || !(await verifiedMember(a.source.channelId, a.actor.userId, deps))) return undefined;
  return status(project);
}

/**
 * Role Q&A: a mention of a role bot, or a DM to one. Undefined when the input is not a question (the owner's
 * orders and thread answers go on to the action router). A project question is answered only in that
 * project's channel, to a verified member; elsewhere the answer is a pointer, never project data.
 */
async function questionRoute(a: Extract<SlackAction, { via: 'message' }>, deps: DispatchDeps, home: string): Promise<ActionResult | undefined> {
  const { config } = deps;
  const dm = /^D[A-Z0-9]+$/.test(a.source.channelId);
  const isOwner = a.actor.userId === config.ownerId;
  if (a.eventType !== 'app_mention' && !(dm && !a.source.threadTs)) return undefined;
  // The owner's DM orders to the PM stay orders.
  if (dm && isOwner && a.source.role === 'pm' && /^(?:new|change)\s/i.test(sanitizeSlackText(a.text, 100))) return undefined;
  const bots = new Set(Object.values(config.roles).map((r) => r.botUserId));
  if (!KEY.test(a.key) || a.actor.isBot || bots.has(a.actor.userId) || a.actor.teamId !== config.teamId) return result('ignored');
  if (config.roles[a.source.role]?.appId !== a.source.appId) return result('ignored');
  // A message naming several role bots reaches each of them; only the first one named answers.
  const first = a.mentions?.find((id) => bots.has(id));
  if (first !== undefined && first !== config.roles[a.source.role].botUserId) return result('ignored');
  // The owner's mention reply to waiting spec questions is an answer, which the message event carries.
  // It is one only when it mentions nobody but the PM; a mention of another role is a question for it.
  if (isOwner && a.source.threadTs && answersThePm(a, config)) {
    const lookup = deps.jobForThread ?? (async (channel: string, thread: string) => {
      const { jobForThread } = await import('./outbox.js');
      return jobForThread({ config, home: deps.home }, channel, thread);
    });
    const job = await lookup(a.source.channelId, a.source.threadTs);
    if (job) {
      const { readSpecContinuation, specStatus } = await import('../core/spec-continuation.js');
      const c = await readSpecContinuation(job.project, job.jobId, home).catch(() => undefined);
      if (c && specStatus(c) === 'awaiting') return result('ignored');
    }
  }
  const question = sanitizeSlackText(a.text, 1000).replace(/^(?:\s*\[mention\]\s*)+/, '').trim();
  const project = dm || a.source.channelId === config.channelId ? undefined : await lookupProject(deps)(a.source.channelId);
  if (!project) {
    // Outside a project channel: an access-checked pointer, and nothing for an ambiguous reference.
    const named = await namedProjects(question);
    // DM chatter that names no project stays quiet (a mention elsewhere was addressed to the bot: it gets the pointer).
    if (dm && !named.length) return result('ignored');
    if (named.length === 1) {
      const lookupChannel = deps.channelForProject ?? (async (p: string) => {
        const { channelForProject } = await import('./outbox.js');
        return channelForProject({ config, home: deps.home }, p);
      });
      const channel = await lookupChannel(named[0]!);
      if (channel && await verifiedMember(channel, a.actor.userId, deps)) {
        return result('refused', `Ask in the project channel for ${named[0]}. Anton answers project questions only there.`);
      }
    }
    return result('refused', POINTER);
  }
  if (!(await verifiedMember(a.source.channelId, a.actor.userId, deps))) return NOT_MEMBER;
  if ((await namedProjects(question)).some((p) => p !== project)) {
    return result('refused', 'This channel answers questions about its own project only. Ask about another project in its channel.');
  }
  if (!question) return result('refused', 'Ask a question after the mention, for example: what is the status?');
  const answer = await answerQuestion({
    teamId: a.actor.teamId, userId: a.actor.userId, role: a.source.role, project, question, requestKey: a.key,
  }, { home, ...deps.chat });
  if (answer.status === 'duplicate') return result('ignored');
  return result('done', ...answer.text.split('\n').flatMap((l) => l.match(/[\s\S]{1,480}/g) ?? []).slice(0, 20));
}

/** Whether the job (or proposal) still looks exactly as it did when the op was bound: the earlier attempt did not land. */
async function stillPending(op: Exclude<Operation, { kind: 'status' }>, deps: DispatchDeps, home: string): Promise<boolean> {
  try {
    if (op.kind === 'lesson') {
      const p = (await readProposals(home)).find((x) => x.id === op.proposal.id);
      return p !== undefined && proposalRevision(p) === op.proposal.revision;
    }
    if (op.kind === 'accept-risk') return true; // recording a risk is idempotent
    // A paid PM turn whose outcome is unknown is never repeated automatically.
    if (op.kind === 'start' || op.kind === 'spec-retry') return false;
    if (op.kind === 'spec-answer') {
      const { readSpecContinuation, specStatus } = await import('../core/spec-continuation.js');
      const c = await readSpecContinuation(op.target.project, op.target.jobId, home);
      return c !== undefined && specStatus(c) === 'awaiting' && c.round === op.round;
    }
    return await isCurrent(op.target, deps.jobs.listTags);
  } catch {
    return op.kind !== 'start' && op.kind !== 'spec-retry' && op.kind !== 'spec-answer' && op.kind !== 'spec-revise';
  }
}

async function claimAndRun(
  input: SlackAction, op: Exclude<Operation, { kind: 'status' }>, deps: DispatchDeps, home: string,
): Promise<ActionResult> {
  // Only targets the store can hold are claimable, so a record never makes the store unreadable.
  if ('target' in op && !targetSchema.safeParse(op.target).success) return result('refused', 'That project or job name cannot be used from Slack.');
  const claim = randomUUID();
  const bound = (r: ActionRecord) => ({
    ...('target' in op ? { target: r.target ?? op.target } : {}),
    ...(op.kind === 'lesson' ? { proposal: r.proposal ?? op.proposal } : {}),
  });
  const fresh = (): ActionRecord => ({
    status: 'claimed', pid: process.pid, claim, at: Date.now(),
    ...(input.via === 'card' ? { token: input.token } : {}),
    ...('target' in op ? { target: op.target } : {}),
    ...(op.kind === 'lesson' ? { proposal: op.proposal } : {}),
  });
  const gate = await withStore<{ go: true; op: typeof op } | { go: false; result: ActionResult }>(home, async (store) => {
    const rec = store.records[input.key];
    if (!rec) {
      // A redelivery of the same click still gets its stored answer (below); a new click on a used card does nothing.
      if (input.via === 'card' && store.cards[input.token]?.usedAt !== undefined) return { value: { go: false, result: USED }, write: false };
      store.records[input.key] = fresh();
      return { value: { go: true, op }, write: true };
    }
    if (rec.status === 'finished') return { value: { go: false, result: { status: 'duplicate', lines: rec.result?.lines ?? [] } }, write: false };
    const live = rec.pid === process.pid ? inFlight.has(rec.claim) : pidAlive(rec.pid);
    if (live) return { value: { go: false, result: result('in-progress', 'Already working on that.') }, write: false };
    // The claimer died with an unknown outcome. Reconcile against the target it bound before doing it again.
    const previous = { ...op, ...bound(rec) } as typeof op;
    if (await stillPending(previous, deps, home)) {
      store.records[input.key] = { ...fresh(), ...bound(rec) };
      return { value: { go: true, op: previous }, write: true };
    }
    const done = result('duplicate', 'That was already handled.');
    store.records[input.key] = { ...rec, status: 'finished', at: Date.now(), result: done };
    return { value: { go: false, result: done }, write: true };
  });
  if (!gate.go) return gate.result;
  inFlight.add(claim);
  let outcome: ActionResult;
  try {
    outcome = await run(gate.op, deps, home);
  } catch (e) {
    outcome = result('refused', clean(e instanceof Error ? e.message : String(e)));
  } finally {
    inFlight.delete(claim);
  }
  const final = { status: outcome.status, lines: outcome.lines.slice(0, 40).map((l) => l.slice(0, 1000)) };
  await withStore(home, async (store) => {
    const rec = store.records[input.key];
    if (rec?.claim !== claim) return { value: undefined, write: false };
    store.records[input.key] = { ...rec, status: 'finished', at: Date.now(), result: final };
    const card = input.via === 'card' ? store.cards[input.token] : undefined;
    if (card && final.status === 'done') card.usedAt = Date.now();
    return { value: undefined, write: true };
  });
  return final;
}

const clean = (line: string) => sanitizeSlackText(line, 1000);


async function run(op: Exclude<Operation, { kind: 'status' }>, deps: DispatchDeps, home: string): Promise<ActionResult> {
  if (op.kind === 'start' || op.kind === 'spec-answer' || op.kind === 'spec-revise' || op.kind === 'spec-retry') {
    if (!deps.spec) return result('unsupported', 'Spec sessions run in anton serve.');
    const session = await import('./spec-session.js');
    switch (op.kind) {
      case 'start': return session.startSlackJob(op, deps.spec);
      case 'spec-answer': return session.submitSpecAnswers({ ...op.target, round: op.round }, op.answers, deps.spec);
      case 'spec-revise': return session.reviseSlackSpec(op.target, op.notes, deps.spec, deps.jobs.listTags);
      case 'spec-retry': return session.retrySlackSpec(op.target, deps.spec);
    }
  }
  if (op.kind === 'lesson') {
    const r = await decideProposal({
      proposalId: op.proposal.id, decision: op.decision, revision: op.proposal.revision, ...(op.text ? { text: op.text } : {}),
    }, home);
    switch (r.status) {
      case 'accepted': return result('done', `Added ${r.id} to ${r.file}.md`);
      case 'duplicate': return result('done', `Already saved: ${r.id}`);
      case 'rejected': return result('done', 'Proposal rejected.');
      case 'plugin': return result('done', `To add it, run on the Mac: anton plugins add ${clean(r.plugin)}`);
      case 'stale': return result('stale', 'That proposal changed or was already decided.');
      case 'failed': return result('refused', `Not added: ${clean(r.message)}`);
    }
  }
  const lines: string[] = [];
  const d: JobActionDeps = { ...deps.jobs, out: (l) => lines.push(clean(l)), err: (l) => lines.push(clean(l)) };
  let outcome: ActionOutcome;
  switch (op.kind) {
    case 'approve': outcome = await approveJob(op.target, d); break;
    case 'reject': outcome = await rejectJob(op.target, op.notes, d); break;
    case 'resume': outcome = await resumeJob(op.target, { budget: op.budget, acceptAsIs: op.acceptAsIs }, d); break;
    case 'abandon': outcome = await abandonJob(op.target, d); break;
    case 'accept-risk': outcome = await acceptJobRisk(op.target, op.findingId, op.reason, d); break;
  }
  return { status: outcome.status, lines };
}
