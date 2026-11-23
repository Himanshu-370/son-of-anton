import { randomBytes, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import {
  abandonJob, acceptJobRisk, approveJob, checkpointRevision, jobStatusRows, loadJob, rejectJob, resumeJob, STATUS_HEADER, targetOf,
  type ActionOutcome, type ActionTarget, type JobActionDeps,
} from '../core/job-actions.js';
import { waitForLockFile } from '../core/lock.js';
import { antonHome } from '../core/paths.js';
import { STAGES } from '../core/state.js';
import { decideProposal, readProposals, proposalRevision } from '../lessons/proposals.js';
import {
  appIdSchema, channelIdSchema, readSlackFile, slackDirectory, SLACK_ROLES, writeSlackFile, type SlackConfig, type SlackRole,
} from './config.js';
import { jobId as jobIdSchema, projectId as projectIdSchema } from './events.js';
import { sanitizeSlackText } from './inbound.js';

/*
 * The Slack side of the shared job actions. Every input is a typed, allowlisted operation. Mutations need
 * the configured workspace and owner IDs and a source app that matches its role. Card targets come from the
 * stored binding, never from the click. Each mutation is claimed once per Slack identity in
 * ~/anton/slack/actions.json before any work, and the job action rechecks state under its own lock.
 */

export type SlackActor = { teamId: string; userId: string; isBot: boolean };
export type SlackSource = { appId: string; role: SlackRole; channelId: string; messageTs?: string; threadTs?: string };
/** Values a card's form (Task 5 modals) may carry. All text is cleaned here before use. */
export type CardInput = { notes?: string; reason?: string; budgetUsd?: number };

export type SlackAction =
  | { via: 'command'; key: string; actor: SlackActor; source: SlackSource; text: string }
  | { via: 'card'; key: string; actor: SlackActor; source: SlackSource; token: string; input?: CardInput }
  /** Plain messages are never orders. Spec conversation and role Q&A (Tasks 5 and 6) plug in here. */
  | { via: 'message'; key: string; actor: SlackActor; source: SlackSource; text: string };

export type ActionResultStatus =
  | 'done' | 'duplicate' | 'in-progress' | 'denied' | 'ignored' | 'stale' | 'refused' | 'unsupported' | 'failed';
export type ActionResult = { status: ActionResultStatus; lines: string[] };

export const CARD_KINDS = ['approve', 'reject', 'resume', 'abandon', 'accept-risk', 'lesson-accept', 'lesson-reject'] as const;
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
  | { kind: 'lesson'; decision: 'accept' | 'reject'; proposal: { id: string; revision: string } };

export const NOTES_LIMIT = 4000;
export const REASON_LIMIT = 500;
const COMMAND_LIMIT = 200;
const RECORD_TTL_MS = 30 * 24 * 3600_000;
const CARD_TTL_MS = 90 * 24 * 3600_000;
const MAX_RECORDS = 5000;

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const ts = z.string().regex(/^\d{1,16}\.\d{1,6}$/);
const revision = z.string().regex(/^(?:[a-f0-9]{64}|delivered-[1-9]\d{0,14})$/);
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
}

const result = (status: ActionResultStatus, ...lines: string[]): ActionResult => ({ status, lines });
const DENIED = result('denied', 'Only the Anton owner can do that here.');

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
    if (input.via === 'message') return result('ignored');
    if (!authorized(input, deps.config)) return DENIED;
    const home = deps.home ?? antonHome();
    const resolved = input.via === 'card' ? await cardOperation(input, home) : await commandOperation(input, deps);
    if ('status' in resolved) return resolved;
    const { op } = resolved;
    if (op.kind === 'status') return await status(op.project);
    return await claimAndRun(input, op, deps, home);
  } catch (e) {
    return result('failed', `That did not work: ${clean(e instanceof Error ? e.message : String(e))}`);
  }
}

async function cardOperation(a: Extract<SlackAction, { via: 'card' }>, home: string): Promise<{ op: Operation } | ActionResult> {
  if (!/^[a-f0-9]{32}$/.test(a.token)) return DENIED;
  const card = (await readSlackFile(home, 'actions.json', storeSchema))?.cards[a.token];
  // Bound to the app, channel and message the card was posted as.
  if (!card || card.appId !== a.source.appId || card.role !== a.source.role || card.channelId !== a.source.channelId
    || card.messageTs === undefined || card.messageTs !== a.source.messageTs) return DENIED;
  const input = a.input ?? {};
  if (card.kind === 'lesson-accept' || card.kind === 'lesson-reject') {
    return { op: { kind: 'lesson', decision: card.kind === 'lesson-accept' ? 'accept' : 'reject', proposal: card.proposal! } };
  }
  const target = card.target!;
  switch (card.kind) {
    case 'approve': return { op: { kind: 'approve', target } };
    case 'abandon': return { op: { kind: 'abandon', target } };
    case 'reject': {
      const notes = sanitizeSlackText(input.notes, NOTES_LIMIT);
      return notes ? { op: { kind: 'reject', target, notes } } : result('refused', 'Add notes that say what to change.');
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

const USAGE = 'Try: /anton status, /anton resume [budget <usd>] [accept-as-is], /anton abandon <job id>';

async function commandOperation(a: Extract<SlackAction, { via: 'command' }>, deps: DispatchDeps): Promise<{ op: Operation } | ActionResult> {
  const words = sanitizeSlackText(a.text, COMMAND_LIMIT).split(/\s+/).filter(Boolean);
  const verb = (words.shift() ?? 'status').toLowerCase();
  const inAnton = a.source.channelId === deps.config.channelId;
  const lookup = deps.projectForChannel ?? (async (channel: string) => {
    const { projectForChannel } = await import('./outbox.js');
    return projectForChannel({ config: deps.config, home: deps.home }, channel);
  });
  const project = inAnton ? undefined : await lookup(a.source.channelId);
  if (verb === 'help') return result('done', USAGE);
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

async function status(project?: string): Promise<ActionResult> {
  const rows = await jobStatusRows(project);
  if (!rows.length) return result('done', 'No projects yet.');
  const all = [STATUS_HEADER, ...rows];
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return result('done', ...all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  ')));
}

/** Whether the job (or proposal) still looks exactly as it did when the op was bound: the earlier attempt did not land. */
async function stillPending(op: Exclude<Operation, { kind: 'status' }>, deps: DispatchDeps, home: string): Promise<boolean> {
  try {
    if (op.kind === 'lesson') {
      const p = (await readProposals(home)).find((x) => x.id === op.proposal.id);
      return p !== undefined && proposalRevision(p) === op.proposal.revision;
    }
    if (op.kind === 'accept-risk') return true; // recording a risk is idempotent
    const job = await loadJob(op.target.project);
    if (job.jobId !== op.target.jobId || job.state.stage !== op.target.stage) return false;
    return op.target.revision === undefined || (await checkpointRevision(job, deps.jobs.listTags)) === op.target.revision;
  } catch {
    return true;
  }
}

async function claimAndRun(
  input: Exclude<SlackAction, { via: 'message' }>, op: Exclude<Operation, { kind: 'status' }>, deps: DispatchDeps, home: string,
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
    return { value: undefined, write: true };
  });
  return final;
}

const clean = (line: string) => sanitizeSlackText(line, 1000);

async function run(op: Exclude<Operation, { kind: 'status' }>, deps: DispatchDeps, home: string): Promise<ActionResult> {
  if (op.kind === 'lesson') {
    const r = await decideProposal({ proposalId: op.proposal.id, decision: op.decision, revision: op.proposal.revision }, home);
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
