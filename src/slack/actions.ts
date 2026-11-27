import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  abandonJob, acceptJobRisk, approveJob, checkpointRevision, isCurrent, loadJob, rejectJob, resumeJob, stopJob, targetOf,
  type ActionOutcome, type ActionTarget, type JobActionDeps, type StopProcessDeps,
} from '../core/job-actions.js';
import { RUN_NONCE, waitForLockFile } from '../core/lock.js';
import { budgetSettings, loadAntonConfig } from '../core/anton-config.js';
import { stageGroup, usd } from '../core/budget.js';
import { NoJobs } from '../core/job.js';
import { loadSecrets } from '../core/secrets.js';
import { antonHome } from '../core/paths.js';
import { listProjects } from '../core/registry.js';
import { STAGES } from '../core/state.js';
import { decideProposal, readProposals, proposalRevision } from '../lessons/proposals.js';
import {
  appIdSchema, teamIdSchema, userIdSchema, readSlackFile, slackDirectory, SLACK_ROLES, writeSlackFile, type SlackConfig, type SlackRole,
} from './config.js';
import { jobId as jobIdSchema, projectId as projectIdSchema } from './events.js';
import { sanitizeSlackText } from './inbound.js';
import type { SpecRoundDeps } from '../core/spec-continuation.js';
import { cardModal, renderConfirmReview, renderReview, type ModalKind, type ModalView } from './views.js';
import { claimIntentThreadReply, completeIntentThreadClarification, registerIntentThread, updateIntentThreadProject } from './intent-threads.js';
import type { classifyIntent, IntentProjectFact, IntentUnavailableReason } from './intent-router.js';
import type { Intent, IntentResolution } from './intents.js';
import { answerQuestion, scrub, statusLines, type ChatDeps } from './chat.js';

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
  | {
    via: 'message'; key: string; actor: SlackActor; source: SlackSource; text: string; eventType?: 'message' | 'app_mention';
    /** User and bot IDs mentioned in the raw text, in order. */
    mentions?: string[];
  };

export type ActionResultStatus =
  | 'done' | 'duplicate' | 'in-progress' | 'denied' | 'ignored' | 'stale' | 'refused' | 'unsupported' | 'failed';
export type ActionResult = { status: ActionResultStatus; lines: string[] };

export const CARD_KINDS = [
  'approve', 'reject', 'resume', 'abandon', 'accept-risk', 'spec-revise', 'lesson-accept', 'lesson-edit', 'lesson-reject', 'confirmation',
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
  | { kind: 'stop'; target: ActionTarget }
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
const targetSchema = z.strictObject({ project: projectIdSchema, jobId: jobIdSchema, stage: z.enum(STAGES), revision: revision.optional(), runNonce: z.string().regex(RUN_NONCE).optional() });
const positive = z.number().positive();
const notesField = z.string().min(1).max(NOTES_LIMIT);
const operationSchema = z.union([
  z.strictObject({ kind: z.literal('start'), mode: z.literal('new'), description: z.string().min(1).max(DESCRIPTION_LIMIT) }),
  z.strictObject({ kind: z.literal('start'), mode: z.literal('change'), project: projectIdSchema, description: z.string().min(1).max(DESCRIPTION_LIMIT) }),
  z.strictObject({ kind: z.enum(['approve', 'abandon']), target: targetSchema }),
  z.strictObject({ kind: z.literal('spec-retry'), target: targetSchema }),
  z.strictObject({ kind: z.literal('stop'), target: targetSchema.extend({ runNonce: z.string().regex(RUN_NONCE) }) }),
  z.strictObject({ kind: z.enum(['reject', 'spec-revise']), target: targetSchema, notes: notesField }),
  z.strictObject({ kind: z.literal('resume'), target: targetSchema, budget: positive.optional(), acceptAsIs: z.boolean().optional() }),
  z.strictObject({ kind: z.literal('accept-risk'), target: targetSchema, findingId: z.string().regex(/^SEC-[A-Za-z0-9-]{1,40}$/), reason: z.string().min(1).max(REASON_LIMIT) }),
  z.strictObject({ kind: z.literal('spec-answer'), target: targetSchema, round: z.number().int().positive(), answers: z.array(z.string().min(1).max(ANSWER_LIMIT)).min(1).max(20) }),
]);
const confirmationPayload = z.strictObject({
  operation: operationSchema,
  startTarget: targetSchema.optional(),
  specTurn: digest.optional(),
  startBudget: positive.optional(),
  threadTs: ts,
});
type ConfirmationPayload = z.infer<typeof confirmationPayload>;
const cardToken = z.string().regex(/^[a-f0-9]{32}$/);
const proposalRef = z.strictObject({ id: z.string().min(1).max(200), revision: digest });
const cardSchema = z.strictObject({
  kind: z.enum(CARD_KINDS),
  appId: appIdSchema,
  role: z.enum(SLACK_ROLES),
  channelId: z.string().regex(/^[CDG][A-Z0-9]+$/),
  messageTs: ts.optional(),
  target: targetSchema.optional(),
  findingId: z.string().regex(/^SEC-[A-Za-z0-9-]{1,40}$/).optional(),
  proposal: proposalRef.optional(),
  createdAt: z.number(),
  confirmation: z.strictObject({
    teamId: teamIdSchema, ownerId: userIdSchema, primary: cardToken,
    button: z.enum(['confirm', 'cancel', 'edit', 'accept-as-is']), expiresAt: z.number(),
    payload: confirmationPayload.optional(),
  }).optional(),
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
  if (card.kind === 'confirmation') throw new Error('Confirmations must be registered together.');
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
  jobs: Omit<JobActionDeps, 'out' | 'err'> & StopProcessDeps;
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
  classify?: (input: Parameters<typeof classifyIntent>[0]) => ReturnType<typeof classifyIntent>;
  postIntentThreadMessage?: (message: { channelId: string; threadTs: string; text: string; blocks?: unknown[] }) => Promise<{ ts: string }>;
  intentNow?: () => number;
  intentSecrets?: Record<string, string>;
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
const CONFIRM_STALE = result('stale', 'This is out of date. Nothing was changed. Ask again.');
const EXPIRED = result('stale', 'That confirmation expired. Ask again.');
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
      if (authorized(input, deps.config)) {
        const routed = await ownerIntentRoute(input, deps, home);
        if (routed) return routed;
      }
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
    let resolved: { op: Operation } | ActionResult;
    if (input.via === 'card') {
      const cards = await readActionCards(input, home);
      const card = cards[input.token];
      if (!matchesCard(input, card)) return DENIED;
      if (card.kind === 'confirmation') return await dispatchConfirmation(input, cards, deps, home);
      resolved = cardOperation(input, card);
    } else {
      resolved = await commandOperation(input, deps);
    }
    if ('status' in resolved) return resolved;
    const { op } = resolved;
    if (op.kind === 'status') return await status(op.project);
    return await claimAndRun(input, op, deps, home);
  } catch (e) {
    return result('failed', `That did not work: ${safePreviewText(e instanceof Error ? e.message : String(e), deps.intentSecrets ?? {}, 1000)}`);
  }
}

type CardAction = Extract<SlackAction, { via: 'card' }>;
type MessageAction = Extract<SlackAction, { via: 'message' }>;

function matchesCard(a: CardAction, card: CardBinding | undefined): card is CardBinding {
  return card !== undefined && card.appId === a.source.appId && card.role === a.source.role
    && card.channelId === a.source.channelId && card.messageTs !== undefined && card.messageTs === a.source.messageTs;
}

async function readActionCards(a: CardAction, home: string): Promise<Store['cards']> {
  if (!cardToken.safeParse(a.token).success) return {};
  return (await readSlackFile(home, 'actions.json', storeSchema))?.cards ?? {};
}

/**
 * For a click: whether to open the card's form first. Local reads only, so the modal opens before the trigger
 * expires. A click that is not the owner's, or not on the card as posted, opens nothing.
 */
export async function prepareCardModal(a: Extract<SlackAction, { via: 'card' }>, deps: DispatchDeps): Promise<ModalDecision> {
  if (!authorized(a, deps.config)) return { kind: 'denied', result: DENIED };
  const home = deps.home ?? antonHome();
  const cards = await readActionCards(a, home);
  const card = cards[a.token];
  if (!matchesCard(a, card) || !a.source.messageTs) return { kind: 'denied', result: DENIED };
  if (card.kind === 'confirmation') {
    const bound = readConfirmation(a, cards, (deps.intentNow ?? Date.now)());
    if ('status' in bound) return { kind: 'refused', result: bound };
    if (bound.button !== 'edit' || a.input) return { kind: 'direct' };
    const edit = confirmationEdit(bound.payload.operation);
    if (!edit) return { kind: 'refused', result: DENIED };
    const { kind, initial } = edit;
    const view = cardModal(kind, { token: a.token, channelId: card.channelId, messageTs: a.source.messageTs }, initial);
    return { kind: 'modal', view: { ...view, title: { type: 'plain_text', text: 'Edit confirmation' }, submit: { type: 'plain_text', text: 'Review' } } };
  }
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

function cardOperation(a: CardAction, card: CardBinding): { op: Operation } | ActionResult {
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
    case 'confirmation': return DENIED;
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

type BoundConfirmation = {
  card: CardBinding;
  primary: string;
  expiresAt: number;
  button: NonNullable<CardBinding['confirmation']>['button'];
  payload: ConfirmationPayload;
};

function readConfirmation(a: CardAction, cards: Store['cards'], now: number): BoundConfirmation | ActionResult {
  const clicked = cards[a.token];
  const ref = clicked?.confirmation;
  if (!matchesCard(a, clicked) || clicked.kind !== 'confirmation' || !ref
    || ref.teamId !== a.actor.teamId || ref.ownerId !== a.actor.userId) return DENIED;
  const card = cards[ref.primary];
  const main = card?.confirmation;
  if (!matchesCard(a, card) || card.kind !== 'confirmation' || !main?.payload || main.button !== 'confirm'
    || main.primary !== ref.primary || main.teamId !== ref.teamId || main.ownerId !== ref.ownerId) return DENIED;
  if (card.usedAt !== undefined) return USED;
  if (now >= main.expiresAt) return EXPIRED;
  return { card, primary: ref.primary, expiresAt: main.expiresAt, button: ref.button, payload: main.payload };
}

function confirmationEdit(op: ConfirmationPayload['operation']): { kind: ModalKind; initial?: string; label?: string } | undefined {
  switch (op.kind) {
    case 'reject':
    case 'spec-revise': return { kind: op.kind, initial: op.notes };
    case 'accept-risk': return { kind: op.kind, initial: op.reason };
    case 'resume': return { kind: op.kind, initial: op.budget?.toString(), label: 'Change budget' };
  }
}

async function dispatchConfirmation(a: CardAction, cards: Store['cards'], deps: DispatchDeps, home: string): Promise<ActionResult> {
  const now = deps.intentNow ?? Date.now;
  const bound = readConfirmation(a, cards, now());
  if ('status' in bound) return bound;
  const { payload, button } = bound;
  if (button === 'confirm') {
    if (a.input) return DENIED;
    return claimAndRun(a, payload.operation, deps, home, bound);
  }

  let updated: ConfirmationPayload | undefined;
  const op = payload.operation;
  if (button === 'edit') {
    if (!a.input) return result('refused', 'Open the edit form first.');
    if (op.kind === 'resume') {
      const budget = a.input.budgetUsd;
      if (budget !== undefined && !positive.safeParse(budget).success) return result('refused', 'The budget must be a positive number of USD.');
      if (budget !== undefined) {
        const job = await currentJob(op.target.project);
        if (!job || budget <= job.state.spentUsd) return result('refused', 'The new budget must exceed the amount already spent.');
      }
      updated = { ...payload, operation: { ...op, budget } };
    } else if (op.kind === 'reject' || op.kind === 'spec-revise' || op.kind === 'accept-risk') {
      const secrets = await previewSecrets(deps, op.target.project);
      const notes = safePreviewText(op.kind === 'accept-risk' ? a.input.reason : a.input.notes, secrets,
        op.kind === 'accept-risk' ? REASON_LIMIT : NOTES_LIMIT);
      if (!notes) return result('refused', 'Add the requested text.');
      updated = { ...payload, operation: op.kind === 'accept-risk' ? { ...op, reason: notes } : { ...op, notes } };
    } else return DENIED;
  } else if (button === 'accept-as-is') {
    if (a.input || op.kind !== 'resume') return DENIED;
    updated = { ...payload, operation: { ...op, acceptAsIs: true } };
  } else if (a.input) return DENIED;

  const consumed = await withStore<ActionResult | undefined>(home, async (current) => {
    const fresh = readConfirmation(a, current.cards, now());
    if ('status' in fresh) return { value: fresh, write: false };
    fresh.card.usedAt = now();
    return { value: undefined, write: true };
  });
  if (consumed) return consumed;
  if (!updated) return result('done', 'Cancelled. Nothing was changed.');
  return postConfirmation(a, updated, deps, home);
}

async function currentJob(project: string) {
  try {
    return await loadJob(project, { allowBench: true });
  } catch (e) {
    if (e instanceof NoJobs) return undefined;
    throw e;
  }
}

async function specTurnDigest(project: string, jobId: string, home: string): Promise<string | undefined> {
  const { readSpecContinuation, specContinuationDigest } = await import('../core/spec-continuation.js');
  const turn = await readSpecContinuation(project, jobId, home);
  return turn && specContinuationDigest(turn);
}

async function confirmationCurrent(payload: ConfirmationPayload, deps: DispatchDeps, home: string): Promise<boolean> {
  const op = payload.operation;
  const target = 'target' in op ? op.target : payload.startTarget;
  if (target && !await isCurrent(target, deps.jobs.listTags)) return false;
  if (op.kind === 'start') {
    if (op.mode === 'change' && !target && await currentJob(op.project)) return false;
    return payload.startBudget !== undefined;
  }
  if (op.kind === 'spec-answer' || op.kind === 'spec-retry') {
    return !!payload.specTurn && payload.specTurn === await specTurnDigest(op.target.project, op.target.jobId, home);
  }
  return true;
}

async function runConfirmed(confirmation: { payload: ConfirmationPayload; expiresAt: number }, deps: DispatchDeps, home: string): Promise<ActionResult> {
  const { payload, expiresAt } = confirmation;
  const { operation: op } = payload;
  const now = deps.intentNow ?? Date.now;
  if (now() >= expiresAt) return EXPIRED;
  if (deps.spec && op.kind === 'start') {
    const { startSlackJob } = await import('./spec-session.js');
    if (payload.startBudget === undefined) return CONFIRM_STALE;
    return startSlackJob(op, deps.spec, { budgetUsd: payload.startBudget, target: payload.startTarget, expiresAt, now });
  }
  if (deps.spec && (op.kind === 'spec-answer' || op.kind === 'spec-retry')) {
    if (!payload.specTurn) return CONFIRM_STALE;
    const { retrySlackSpec, submitSpecAnswers } = await import('./spec-session.js');
    const specDeps = { ...deps.spec, now };
    const claim = { digest: payload.specTurn, expiresAt };
    return op.kind === 'spec-retry'
      ? retrySlackSpec(op.target, specDeps, claim)
      : submitSpecAnswers({ ...op.target, round: op.round }, op.answers, specDeps, claim);
  }
  if (!await confirmationCurrent(payload, deps, home).catch(() => false)) return CONFIRM_STALE;
  if (now() >= expiresAt) return EXPIRED;
  return run(op, deps, home);
}

async function previewSecrets(deps: DispatchDeps, project?: string): Promise<Record<string, string>> {
  return {
    ...(process.env.ANTHROPIC_API_KEY ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY } : {}),
    ...deps.intentSecrets,
    ...(project ? await loadSecrets(project) : {}),
  };
}

function safePreviewText(value: unknown, secrets: Record<string, string>, limit: number): string {
  return sanitizeSlackText(scrub(typeof value === 'string' ? value : '', secrets), limit);
}

const CONFIRM_MS = 30 * 60_000;
const CONFIRM_LABELS = {
  approve: 'Approve', reject: 'Reject the delivery and request changes for', 'spec-revise': 'Request spec changes for',
  'spec-answer': 'Submit spec answers for', 'spec-retry': 'Retry the interrupted PM turn for',
  resume: 'Resume', stop: 'Stop the runner and pause', abandon: 'Permanently abandon', 'accept-risk': 'Accept a risk for',
};

async function postConfirmation(
  a: MessageAction | CardAction, payload: ConfirmationPayload, deps: DispatchDeps, home: string, fallback?: string, onPosted?: () => Promise<void>,
): Promise<ActionResult> {
  if (!deps.postIntentThreadMessage) return result('unsupported', 'Confirmation cards are available in anton serve.');
  if (!await confirmationCurrent(payload, deps, home).catch(() => false)) return CONFIRM_STALE;

  const op = payload.operation;
  const target = 'target' in op ? op.target : payload.startTarget;
  const job = target && await currentJob(target.project);
  const left = job ? Math.max(0, job.state.budgetUsd - job.state.spentUsd) : 0;
  const spending = `Future work uses the current budget (${usd(left)} left).`;
  let description: string;
  let effects: string;
  let notes: string | undefined;
  let offerAccept = false;
  let needsBudget = false;
  if (op.kind === 'start') {
    description = op.mode === 'new' ? 'Start a new project.' : `Start a change for ${op.project}${target ? ` after job ${target.jobId}` : ''}.`;
    effects = `The PM starts the spec with a ${usd(payload.startBudget!)} job budget.`;
    notes = op.description;
  } else {
    const checkpoint = op.target.stage === 'awaiting_spec_approval' ? 'spec review'
      : op.target.stage === 'awaiting_final_review' ? 'final review' : op.target.stage;
    const revision = op.target.revision?.startsWith('delivered-') ? `, ${op.target.revision}` : '';
    const verb = op.kind === 'approve' ? `Approve the ${checkpoint} for` : CONFIRM_LABELS[op.kind];
    description = `${verb} ${op.target.project} (job ${op.target.jobId}, ${checkpoint}${revision}).`;
    effects = spending;
    switch (op.kind) {
      case 'approve':
        effects = op.target.stage === 'awaiting_spec_approval' ? `Start planning. ${spending}` : 'Accept the final delivery and run the Retrospective. The Retrospective can spend from the remaining job budget and may be skipped if funds are insufficient.';
        break;
      case 'reject': effects = `Send the delivery back for rework. ${spending}`; notes = op.notes; break;
      case 'spec-revise': effects = `Ask the PM to revise the spec. ${spending}`; notes = op.notes; break;
      case 'spec-answer': notes = op.answers.map((answer, i) => `${i + 1}. ${answer}`).join('\n'); break;
      case 'resume':
        if (!job) return CONFIRM_STALE;
        if (op.budget !== undefined && op.budget <= job.state.spentUsd) return result('refused', 'The new budget must exceed the amount already spent.');
        offerAccept = !op.acceptAsIs && job.state.stage === 'paused' && (job.state.pausedFrom === 'build' || job.state.pausedFrom === 'verify');
        needsBudget = job.state.stage === 'paused' && op.budget === undefined && !op.acceptAsIs
          && (job.state.pauseReason === 'budget_cap'
            || (job.state.pauseReason === 'allowance' && !!stageGroup(job.state.pausedFrom ?? '')));
        effects = needsBudget ? 'Choose a new total budget to resume.' : op.budget === undefined ? spending : `Set the total job budget to ${usd(op.budget)} (${usd(op.budget - job.state.spentUsd)} left).`;
        if (op.acceptAsIs) effects = [
          'Deliver the current work as-is for review without more build or verification spend.',
          op.budget === undefined ? '' : effects,
        ].filter(Boolean).join(' ');
        break;
      case 'stop': effects = 'Stop the active runner. The job budget stays the same.'; break;
      case 'abandon': effects = 'End this job permanently and run the Retrospective. The Retrospective can spend from the remaining job budget and may be skipped if funds are insufficient.'; break;
      case 'accept-risk': effects = `Record acceptance of ${op.findingId}. Recording the decision has no model cost.`; notes = op.reason; break;
    }
  }

  const { channelId } = a.source;
  const { threadTs } = payload;
  const edit = confirmationEdit(op);
  const confirmToken = randomBytes(16).toString('hex');
  const cancelToken = randomBytes(16).toString('hex');
  const editToken = edit && randomBytes(16).toString('hex');
  const acceptToken = offerAccept && randomBytes(16).toString('hex');
  const tokens = [confirmToken, cancelToken, ...(editToken ? [editToken] : []), ...(acceptToken ? [acceptToken] : [])];
  const now = (deps.intentNow ?? Date.now)();
  await withStore(home, async (store) => {
    for (const token of tokens) {
      store.cards[token] = cardSchema.parse({
        kind: 'confirmation', role: 'pm', appId: a.source.appId, channelId, createdAt: Date.now(),
        confirmation: {
          teamId: a.actor.teamId, ownerId: a.actor.userId, primary: confirmToken, expiresAt: now + CONFIRM_MS,
          button: token === confirmToken ? 'confirm' : token === cancelToken ? 'cancel' : token === editToken ? 'edit' : 'accept-as-is',
          ...(token === confirmToken ? { payload } : {}),
        },
      });
    }
    return { value: undefined, write: true };
  });

  const view = renderConfirmReview({
    description, effects, notes, hideConfirm: needsBudget, dangerous: op.kind === 'abandon', confirmToken, cancelToken,
    ...(editToken ? { edit: { token: editToken, label: edit?.label } } : {}),
  });
  if (acceptToken) {
    const buttons = view.blocks.at(-1)?.elements;
    if (Array.isArray(buttons)) buttons.push({
      type: 'button', action_id: 'anton_accept_as_is', text: { type: 'plain_text', text: 'Review accept as-is' }, value: acceptToken,
    });
  }
  if (fallback) {
    view.text = `${fallback}\n${view.text}`;
    view.blocks.unshift({ type: 'section', text: { type: 'plain_text', text: fallback } });
  }
  const sent = await postIntentMessage(a, deps, { channelId, threadTs, ...view });
  if (!sent) return result('ignored');
  if (!ts.safeParse(sent.ts).success) throw new Error('Slack did not return a valid confirmation timestamp.');
  await withStore(home, async (store) => {
    for (const token of tokens) store.cards[token]!.messageTs = sent.ts;
    return { value: undefined, write: true };
  });
  await onPosted?.();
  return result('ignored');
}

const USAGE = 'Try: /anton status, /anton new <description> (in #anton), /anton change <description>, /anton spec retry, '
  + '/anton resume [budget <usd>] [accept-as-is], /anton abandon <job id>';

async function commandOperation(a: Extract<SlackAction, { via: 'command' }>, deps: DispatchDeps, context?: { project?: string; dm: boolean }): Promise<{ op: Operation } | ActionResult> {
  const text = sanitizeSlackText(a.text, DESCRIPTION_LIMIT + 50);
  const first = (text.split(/\s+/)[0] ?? '').toLowerCase();
  const words = (first === 'new' || first === 'change' ? text : text.slice(0, COMMAND_LIMIT)).split(/\s+/).filter(Boolean);
  const verb = (words.shift() ?? 'status').toLowerCase();
  const inAnton = a.source.channelId === deps.config.channelId;
  const lookup = deps.projectForChannel ?? (async (channel: string) => {
    const { projectForChannel } = await import('./outbox.js');
    return projectForChannel({ config: deps.config, home: deps.home }, channel);
  });
  const project = context ? context.project : inAnton ? undefined : await lookup(a.source.channelId);
  if (verb === 'help') return result('done', USAGE);
  if (verb === 'new' || verb === 'change') {
    const description = sanitizeSlackText(words.join(' '), DESCRIPTION_LIMIT);
    if (!description) return result('refused', `Describe the work: /anton ${verb} <description>`);
    if (verb === 'new') {
      return inAnton || context?.dm ? { op: { kind: 'start', mode: 'new', description } } : result('refused', 'Start new projects in #anton.');
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
    if (inAnton || (context?.dm && !project)) return { op: { kind: 'status' } };
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

/** The owner's replies in existing job threads. Everything else is discussion (`ignored`). */
async function messageOperation(
  a: Extract<SlackAction, { via: 'message' }>, deps: DispatchDeps, home: string,
): Promise<{ op: Operation } | ActionResult> {
  if (a.eventType === 'app_mention' || a.source.role !== 'pm') return result('ignored');
  const text = sanitizeSlackText(a.text, ANSWER_LIMIT);
  if (!a.source.threadTs) return result('ignored');
  // An answer mentions nobody but the PM. A message that mentions another role or person is addressed to them.
  if (!answersThePm(a, deps.config)) return result('ignored');
  const job = await lookupJobThread(deps)(a.source.channelId, a.source.threadTs);
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
  if (!deps.access || !await privateWorkspaceChannel(channelId, deps)) return false;
  try {
    return (await deps.access.members(channelId)).includes(userId);
  } catch {
    return false;
  }
}

async function privateWorkspaceChannel(channelId: string, deps: DispatchDeps): Promise<boolean> {
  try {
    const info = await deps.access?.channel(channelId);
    return !!info && info.isPrivate && !info.isShared && !info.isArchived
      && (info.teamId === undefined || info.teamId === deps.config.teamId);
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

const lookupJobThread = (deps: DispatchDeps) => deps.jobForThread ?? (async (channel: string, thread: string) => {
  const { jobForThread } = await import('./outbox.js');
  return jobForThread({ config: deps.config, home: deps.home }, channel, thread);
});

const INTENT_HELP = 'Ask me to show progress or explain a project, start a project or change, answer spec questions, '
  + 'review a spec or delivery, resume, stop or abandon a job, accept a risk, or show pending lessons. I’ll ask you to confirm changes.';
const PAUSED_REASONS: Record<IntentUnavailableReason, string> = {
  missing_key: 'no API key', input_too_large: 'the message is too long', budget: 'chat budget unavailable',
  provider_error: 'model request failed', missing_price: 'model pricing unavailable', router_error: 'router unavailable',
};

async function ownerIntentRoute(a: MessageAction, deps: DispatchDeps, home: string): Promise<ActionResult | undefined> {
  const { config } = deps;
  const { channelId, messageTs, threadTs } = a.source;
  if (a.source.role !== 'pm' || !messageTs || !deps.postIntentThreadMessage) return undefined;
  const dm = channelId.startsWith('D');
  const roleBots = new Set(Object.values(config.roles).map(({ botUserId }) => botUserId));
  if (roleBots.has(a.actor.userId)) return undefined;
  const mentionsPm = a.mentions?.find((id) => roleBots.has(id)) === config.roles.pm.botUserId;
  if (a.eventType === 'app_mention' && !mentionsPm) return undefined;
  if (!threadTs && !dm && !mentionsPm) return undefined;
  if (threadTs && !answersThePm(a, config)) return undefined;
  const channelProject = dm || channelId === config.channelId ? undefined : await lookupProject(deps)(channelId);
  if (!dm && channelId !== config.channelId && !channelProject) return undefined;
  if (threadTs && await lookupJobThread(deps)(channelId, threadTs)) return undefined;
  if (!dm && !await verifiedMember(channelId, a.actor.userId, deps)) return result('ignored');

  const text = sanitizeSlackText(a.text, 6001).replace(/^(?:\s*\[mention\]\s*)+/, '').trim();
  if (!text) return undefined;
  // One Slack message can arrive as both a message event and an app mention with different event IDs.
  const identity = createHash('sha256').update(JSON.stringify([a.actor.teamId, channelId, messageTs])).digest('hex');
  const requestKey = `event:intent:${identity}`;
  const claimed = await withStore(home, async (store) => {
    if (Object.hasOwn(store.records, requestKey)) return { value: false, write: false };
    store.records[requestKey] = { status: 'finished', pid: process.pid, claim: randomUUID(), at: Date.now() };
    return { value: true, write: true };
  });
  if (!claimed) return result('ignored');

  const binding = { teamId: a.actor.teamId, ownerId: a.actor.userId, channelId, threadTs: threadTs ?? messageTs };
  const options = { home, now: deps.intentNow };
  const send = async (message: string) => {
    await postIntentMessage(a, deps, { channelId, threadTs: binding.threadTs, text: message });
    return result('ignored');
  };
  const context = threadTs ? await claimIntentThreadReply(binding, options) : undefined;
  if (context?.kind === 'missing') return undefined;
  if (context?.kind === 'help') return send(INTENT_HELP);

  const contextProject = context?.project ?? channelProject;
  const secrets = await previewSecrets(deps, contextProject);
  const names = (await listProjects()).map(({ name }) => name).filter((name) => projectIdSchema.safeParse(name).success);
  // Order the channel/thread project first so it survives the router's fact limit.
  const projects = contextProject && names.includes(contextProject)
    ? [contextProject, ...names.filter((name) => name !== contextProject)] : names;
  const facts: IntentProjectFact[] = [];
  for (const project of projects) {
    const job = await currentJob(project).catch(() => undefined);
    if (job?.state.bench !== undefined) continue;
    const stage = job?.state.stage;
    facts.push({
      project, jobId: job?.jobId, stage, pauseReason: job?.state.pauseReason,
      checkpoint: stage === 'awaiting_spec_approval' ? 'spec' : stage === 'awaiting_final_review' ? 'final' : undefined,
    });
  }
  const describe = (question: string) => safePreviewText(question, secrets, 500);
  const ask = async (question: string) => {
    if (context?.kind === 'retry') return send(INTENT_HELP);
    const projectSecrets = await Promise.all(projects.map(async (project) =>
      Object.fromEntries(Object.entries(await loadSecrets(project)).map(([key, value]) => [`${project}/${key}`, value]))));
    const allSecrets = Object.assign({}, secrets, ...projectSecrets);
    const safeQuestion = safePreviewText(question, allSecrets, 500) || 'What would you like the PM to do?';
    const registered = await registerIntentThread(binding, { kind: 'clarification', project: contextProject, originalText: text, question: safeQuestion },
      { ...options, secrets: allSecrets, clarifyExisting: context?.kind === 'context' });
    return registered ? send(safeQuestion) : result('ignored');
  };

  const classifierInput = context?.kind === 'retry'
    ? `Original request:\n${context.originalText}${context.question ? `\n\nPM question:\n${context.question}` : ''}\n\nOwner clarification:\n${text}`
    : text;
  const classification = await (deps.classify?.({ teamId: a.actor.teamId, requestKey, text: classifierInput, contextProject, projects: facts })
    .catch(() => ({ kind: 'unavailable', reason: 'router_error' } as const))
    ?? Promise.resolve({ kind: 'unavailable', reason: 'missing_key' } as const));
  if (classification.kind === 'duplicate') return result('ignored');
  if (classification.kind === 'clarification') return ask(classification.text);

  let fallback: string | undefined;
  let resolution: IntentResolution;
  const { resolveIntent } = await import('./intents.js');
  const resolve = (intent: Intent, project = contextProject) =>
    resolveIntent(intent, { projects, channelProject: project, home, listTags: deps.jobs.listTags });
  if (classification.kind === 'intent') {
    resolution = await resolve(classification.intent);
  } else {
    const original = context?.kind === 'retry' ? context.originalText : text;
    const [verb = '', ...args] = original.split(/\s+/);
    const lower = verb.toLowerCase();
    const reason = `Plain English is paused (${PAUSED_REASONS[classification.reason]}).`;
    const chosen = context?.kind === 'retry' ? projects.find((project) => project === text.toLowerCase()) : undefined;
    if (context?.kind === 'retry' && !chosen) return send(`${reason}\n${INTENT_HELP}`);
    const exact = ['help', 'status', 'new', 'change', 'spec', 'resume', 'abandon', 'approve', 'reject', 'accept-risk'];
    if (!exact.includes(lower)) return send(`${reason}\n${USAGE}`);
    fallback = `${reason.slice(0, -1)}; I understood this as /anton ${lower}${lower === 'spec' ? ' retry' : ''}.`;
    let project = chosen ?? contextProject;
    let commandText = original;
    if (dm && lower === 'change') {
      const named = args[0];
      if (named && names.includes(named)) {
        if (chosen && chosen !== named) return send(`${fallback}\nThe two project names differ. Ask again.`);
        project = named;
        args.shift();
      }
      if (!project || (!chosen && named !== project) || !args.length) {
        return send(`${fallback}\nName a registered project: change <project> <description>.`);
      }
      commandText = `change ${args.join(' ')}`;
    }
    const parsed = await commandOperation({ ...a, via: 'command', text: commandText }, deps, { dm, project });
    if ('status' in parsed) return send([fallback, ...parsed.lines].join('\n'));
    const { op } = parsed;
    switch (op.kind) {
      case 'status': resolution = { kind: 'read-only', intent: 'status', project: chosen ?? op.project }; break;
      case 'start': resolution = await resolve(op.mode === 'new' ? { intent: 'start_new', description: op.description }
        : { intent: 'start_change', project: op.project, description: op.description }); break;
      case 'resume': resolution = await resolve({ intent: 'resume', project: op.target.project, jobId: op.target.jobId,
        budgetUsd: op.budget, acceptAsIs: op.acceptAsIs }); break;
      case 'abandon': resolution = await resolve({ intent: 'abandon', project: op.target.project, jobId: op.target.jobId }); break;
      case 'spec-retry': resolution = await resolve({ intent: 'spec_retry', project: op.target.project, jobId: op.target.jobId }); break;
      default: return send(`${fallback}\n${USAGE}`);
    }
  }

  if (resolution.kind === 'clarification') return ask(fallback ? `${fallback}\n${resolution.text}` : resolution.text);
  if (resolution.kind === 'refused') return send([fallback, describe(resolution.text)].filter(Boolean).join('\n'));
  const withFallback = (message: string) => fallback ? `${fallback}\n${message}` : message;
  const promote = async (project?: string) => {
    if (context?.kind === 'retry') await completeIntentThreadClarification(binding, context.retryClaim, project, options);
  };
  if (resolution.kind === 'read-only') {
    await promote(resolution.project ?? contextProject);
    if (resolution.intent === 'help') return send(INTENT_HELP);
    if (resolution.intent === 'status') return send(withFallback((await statusLines(resolution.project)).join('\n')));
    if (resolution.intent === 'lessons') return postIntentLessons(a, binding.threadTs, contextProject, deps, home);
    const project = resolution.project;
    if (!project) return ask('Which project is your question about?');
    const answer = await answerQuestion({ teamId: a.actor.teamId, userId: a.actor.userId, role: 'pm', project,
      question: context?.kind === 'retry' ? `${context.originalText}\n${text}` : text, requestKey }, { home, ...deps.chat });
    return answer.status === 'duplicate' ? result('ignored') : send(safePreviewText(answer.text, await previewSecrets(deps, project), 3900));
  }
  if (resolution.kind !== 'operation') return result('ignored');

  const { operation, target: startTarget } = resolution;
  if (operation.kind === 'lesson') return result('refused', 'Open the lesson card to decide.');
  const project = 'target' in operation ? operation.target.project : operation.project;
  const opSecrets = await previewSecrets(deps, project);
  switch (operation.kind) {
    case 'start': operation.description = safePreviewText(operation.description, opSecrets, DESCRIPTION_LIMIT); break;
    case 'reject':
    case 'spec-revise': operation.notes = safePreviewText(operation.notes, opSecrets, NOTES_LIMIT); break;
    case 'accept-risk': operation.reason = safePreviewText(operation.reason, opSecrets, REASON_LIMIT); break;
    case 'spec-answer': operation.answers = operation.answers.map((answer) => safePreviewText(answer, opSecrets, ANSWER_LIMIT)); break;
  }
  const parsed = operationSchema.safeParse(operation);
  if (!parsed.success) return send('Some action details could not be verified. Ask again.');
  const payload: ConfirmationPayload = { operation: parsed.data, startTarget, threadTs: binding.threadTs };
  if (parsed.data.kind === 'start') payload.startBudget = budgetSettings(await loadAntonConfig(home)).defaultUsd;
  if (parsed.data.kind === 'spec-answer' || parsed.data.kind === 'spec-retry') {
    payload.specTurn = resolution.specTurn;
  }
  return postConfirmation(a, payload, deps, home, fallback, async () => {
    if (!threadTs) await registerIntentThread(binding, { kind: 'context', project }, options);
    if (context?.kind === 'context' && project) await updateIntentThreadProject(binding, project, options);
    if (context?.kind === 'retry') await promote(project);
  });
}

async function postIntentMessage(
  a: MessageAction | CardAction, deps: DispatchDeps, message: Parameters<NonNullable<DispatchDeps['postIntentThreadMessage']>>[0],
): Promise<{ ts: string } | undefined> {
  if (!deps.postIntentThreadMessage) return undefined;
  if (!message.channelId.startsWith('D') && !await verifiedMember(message.channelId, a.actor.userId, deps)) return undefined;
  return deps.postIntentThreadMessage(message);
}

async function postIntentLessons(a: MessageAction, threadTs: string, project: string | undefined, deps: DispatchDeps, home: string): Promise<ActionResult> {
  const channelId = a.source.channelId;
  const proposals = (await readProposals(home)).filter((p) => !project || p.project === project).slice(0, 7);
  const tokens: string[] = [];
  const sections = [];
  for (const p of proposals) {
    const secrets = await previewSecrets(deps, p.project);
    const proposal = { id: p.id, revision: proposalRevision(p) };
    const buttons = [];
    for (const [kind, label] of [['lesson-accept', 'Accept'], ['lesson-edit', 'Edit…'], ['lesson-reject', 'Reject']] as const) {
      if (kind === 'lesson-edit' && p.kind !== 'lesson') continue;
      const token = await registerActionCard({ kind, role: 'pm', channelId, proposal }, { config: deps.config, home });
      tokens.push(token);
      buttons.push({ token, label });
    }
    sections.push({ text: safePreviewText(`${p.project}: ${p.text ?? p.plugin ?? ''}\nWhy: ${p.why}`, secrets, 2500), buttons });
  }
  const view = renderReview({ kind: 'lessons' }, { title: sections.length ? 'Pending lessons' : 'No pending lessons.', sections });
  const sent = await postIntentMessage(a, deps, { channelId, threadTs, ...view });
  if (sent) for (const token of tokens) await attachCardMessage(token, channelId, sent.ts, { home });
  return result('ignored');
}

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
  const bots = new Set(Object.values(config.roles).map((r) => r.botUserId));
  if (!KEY.test(a.key) || a.actor.isBot || bots.has(a.actor.userId) || a.actor.teamId !== config.teamId) return result('ignored');
  if (config.roles[a.source.role]?.appId !== a.source.appId) return result('ignored');
  // A message naming several role bots reaches each of them; only the first one named answers.
  const first = a.mentions?.find((id) => bots.has(id));
  if (first !== undefined && first !== config.roles[a.source.role].botUserId) return result('ignored');
  // The owner's mention reply to waiting spec questions is an answer, which the message event carries.
  // It is one only when it mentions nobody but the PM; a mention of another role is a question for it.
  if (isOwner && a.source.threadTs && answersThePm(a, config)) {
    const job = await lookupJobThread(deps)(a.source.channelId, a.source.threadTs);
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
  confirmation?: BoundConfirmation,
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
      if (confirmation && input.via === 'card') {
        const bound = readConfirmation(input, store.cards, (deps.intentNow ?? Date.now)());
        if ('status' in bound) return { value: { go: false, result: bound }, write: false };
        if (bound.primary !== confirmation.primary || bound.button !== 'confirm') return { value: { go: false, result: DENIED }, write: false };
        bound.card.usedAt = (deps.intentNow ?? Date.now)();
      }
      store.records[input.key] = fresh();
      return { value: { go: true, op }, write: true };
    }
    if (rec.status === 'finished') return { value: { go: false, result: { status: 'duplicate', lines: rec.result?.lines ?? [] } }, write: false };
    if (confirmation) return { value: { go: false, result: USED }, write: false };
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
    outcome = confirmation
      ? await runConfirmed(confirmation, deps, home)
      : await run(gate.op, deps, home);
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
    case 'stop': outcome = await stopJob(op.target, { ...d, kill: deps.jobs.kill, sleep: deps.jobs.sleep }); break;
    case 'abandon': outcome = await abandonJob(op.target, d); break;
    case 'accept-risk': outcome = await acceptJobRisk(op.target, op.findingId, op.reason, d); break;
  }
  return { status: outcome.status, lines };
}
