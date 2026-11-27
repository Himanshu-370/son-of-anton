import { createHash, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { runAgent as RunAgent, StageCtx } from '../agent/host-runner.js';
import { selectKit, type KitName } from '../kits/index.js';
import { publishJobMilestone, type JobMilestone } from '../slack/job-milestones.js';
import { specRevision } from '../slack/artifacts.js';
import {
  answersPrompt, FINAL_ROUND_NOTE, initialSpecPrompt, MAX_QUESTION_ROUNDS, specTurn, writeSpec,
  type SpecDoc, type SpecHooks, type SpecTurn,
} from '../stages/spec.js';
import { readRegularFile, writeFileAtomic } from './atomic.js';
import { estimateCost, type HistoryEntry } from './history.js';
import { currentJobId } from './job.js';
import { withDecisionLock } from './job-actions.js';
import { waitForLockFile } from './lock.js';
import { antonHome } from './paths.js';
import { loadSecrets, redact, secretsEnvFile } from './secrets.js';
import { loadState, saveState, transition, type JobState } from './state.js';

/*
 * The host-side spec continuation, shared by the CLI and Slack. One file per job under
 * ~/anton/spec-sessions/<project>/<jobId>.json (outside every container mount) records the round, the
 * questions, the owner's answers and each PM exchange. A round is claimed under the file's lock before the
 * paid call (checkpoint), so two surfaces never answer the same round, and a claim whose process died is an
 * unknown in-flight turn: it is never repeated without an explicit retry.
 */

export const SPEC_REMINDER_MS = 24 * 3600_000;
export type SpecSurface = 'cli' | 'slack';

const slug = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const jobIdRe = /^[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const holderSchema = z.strictObject({ surface: z.enum(['cli', 'slack']), pid: z.number().int().positive(), claim: z.string().uuid(), at: z.number() });
const exchangeSchema = z.strictObject({
  prompt: z.string(),
  reply: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('questions'), questions: z.array(z.string()).max(50) }),
    z.strictObject({ kind: z.literal('spec'), spec: z.unknown() }),
  ]),
  answers: z.array(z.string()).max(50).optional(),
});
const continuationSchema = z.strictObject({
  version: z.literal(1),
  project: z.string().regex(slug),
  jobId: z.string().regex(jobIdRe),
  mode: z.enum(['new', 'change']),
  description: z.string(),
  origin: z.enum(['cli', 'slack']),
  status: z.enum(['running', 'awaiting', 'stopped', 'done']),
  holder: holderSchema.optional(),
  /** Question rounds asked so far (never reset; it numbers the Slack question messages). */
  round: z.number().int().min(0),
  /** PM calls since the conversation (or its latest revision) began; the 6th must write the spec. */
  calls: z.number().int().min(0),
  questions: z.array(z.string()).optional(),
  askedAt: z.number().optional(),
  reminded: z.boolean().optional(),
  /** The prompt of the call in flight (or the one that stopped), saved before the paid call. */
  pending: z.strictObject({ prompt: z.string(), final: z.boolean() }).optional(),
  exchanges: z.array(exchangeSchema),
  stopReason: z.string().max(500).optional(),
  updatedAt: z.string(),
});
export type SpecContinuation = z.infer<typeof continuationSchema>;
export type SpecStatus = SpecContinuation['status'];

function assertIds(project: string, jobId: string): void {
  if (!slug.test(project) || !jobIdRe.test(jobId)) throw new Error('Invalid project or job name for a spec session.');
}

export const specContinuationPath = (project: string, jobId: string, home = antonHome()) => {
  assertIds(project, jobId);
  return join(home, 'spec-sessions', project, `${jobId}.json`);
};

/** Claims running in this process. A holder in another process counts while that process is alive. */
const live = new Set<string>();

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function holderAlive(h: SpecContinuation['holder']): boolean {
  if (!h) return false;
  return h.pid === process.pid ? live.has(h.claim) : pidAlive(h.pid);
}

/** The status as seen now: a running turn whose process is gone is stopped (unknown outcome). */
export function specStatus(c: SpecContinuation): SpecStatus {
  return c.status === 'running' && !holderAlive(c.holder) ? 'stopped' : c.status;
}

export async function readSpecContinuation(project: string, jobId: string, home = antonHome()): Promise<SpecContinuation | undefined> {
  const raw = await readRegularFile(specContinuationPath(project, jobId, home));
  return raw === undefined ? undefined : continuationSchema.parse(JSON.parse(raw));
}

export function specContinuationDigest(c: SpecContinuation): string {
  return createHash('sha256').update(JSON.stringify({ ...c, reminded: undefined, updatedAt: undefined })).digest('hex');
}

async function save(c: SpecContinuation, home: string): Promise<void> {
  const secrets = await loadSecrets(c.project).catch(() => ({}));
  const out = continuationSchema.parse({ ...c, updatedAt: new Date().toISOString() });
  await writeFileAtomic(specContinuationPath(c.project, c.jobId, home), redact(JSON.stringify(out, null, 2) + '\n', secrets));
}

async function withContinuation<T>(project: string, jobId: string, home: string, body: (c: SpecContinuation | undefined) => Promise<T>): Promise<T> {
  const path = specContinuationPath(project, jobId, home);
  await fsp.mkdir(join(path, '..'), { recursive: true, mode: 0o700 });
  const release = await waitForLockFile(`${path}.lock`);
  try {
    return await body(await readSpecContinuation(project, jobId, home));
  } finally {
    await release();
  }
}

/** Every saved continuation (for the reminder sweep). Unreadable files are skipped. */
export async function listSpecContinuations(home = antonHome()): Promise<SpecContinuation[]> {
  const root = join(home, 'spec-sessions');
  const projects = await fsp.readdir(root).catch(() => [] as string[]);
  const out: SpecContinuation[] = [];
  for (const p of projects.filter((x) => slug.test(x))) {
    const files = await fsp.readdir(join(root, p)).catch(() => [] as string[]);
    for (const f of files.filter((x) => x.endsWith('.json'))) {
      const c = await readSpecContinuation(p, f.slice(0, -5), home).catch(() => undefined);
      if (c) out.push(c);
    }
  }
  return out;
}

/** Mark the reminder sent. True only for the caller that flips it, so exactly one reminder goes out per wait. */
export async function markReminded(project: string, jobId: string, round: number, home = antonHome()): Promise<boolean> {
  return withContinuation(project, jobId, home, async (c) => {
    if (!c || specStatus(c) !== 'awaiting' || c.round !== round || c.reminded) return false;
    await save({ ...c, reminded: true }, home);
    return true;
  });
}

/**
 * A turn whose process died (a serve restart or crash): record it as stopped, keeping its pending prompt
 * for an explicit retry. True only for the caller that records it, so the notice goes out once.
 */
export async function markTurnStopped(project: string, jobId: string, claim: string, home = antonHome()): Promise<boolean> {
  return withContinuation(project, jobId, home, async (c) => {
    if (!c || c.status !== 'running' || c.holder?.claim !== claim || holderAlive(c.holder)) return false;
    await save({ ...c, status: 'stopped', holder: undefined, stopReason: 'the process running the PM turn ended before it finished' }, home);
    return true;
  });
}

/** Another surface owns this spec conversation or round: the caller must stop, not continue without it. */
export class SpecConflict extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpecConflict';
  }
}

export type SpecJob = { project: string; repoPath: string; jobId: string; jobDir: string; description: string; mode: 'new' | 'change' };
export type SpecRoundConfirmation = { digest: string; expiresAt: number };
export type SpecRoundInput =
  | { kind: 'start' }
  | { kind: 'answers'; round: number; answers: string[]; confirmation?: SpecRoundConfirmation }
  | { kind: 'revise'; notes: string }
  | { kind: 'retry'; confirmation?: SpecRoundConfirmation };
export type SpecRoundStatus = 'questions' | 'spec' | 'stale' | 'in-progress' | 'stopped' | 'refused';
export type SpecRoundResult = { status: SpecRoundStatus; lines: string[]; round?: number; questions?: string[] };

export type SpecRoundDeps = {
  surface: SpecSurface;
  home?: string;
  now?: () => number;
  ensureImage: () => Promise<string>;
  startContainer: (slug: string, repo: string, image: string, opts?: { envFile?: string }) => Promise<string>;
  stopContainer: (name: string) => Promise<void>;
  runAgent?: typeof RunAgent;
  ensureRepoMap: (ctx: StageCtx) => Promise<JobState>;
  listFiles: (repo: string) => Promise<string[]>;
  readHistory: () => Promise<HistoryEntry[]>;
  /** Job milestone intake (Slack outbox). Defaults to the shared publisher, which is optional and never throws. */
  publish?: (state: JobState, milestone: JobMilestone) => Promise<void>;
};

const publishOf = (d: { publish?: SpecRoundDeps['publish'] }) => d.publish ?? ((s: JobState, m: JobMilestone) => publishJobMilestone(s, m));

/** Kit, estimate, spec files, the move to checkpoint 1 and its milestone: the saved result for both surfaces. */
export async function finishSpec(
  job: SpecJob, spec: SpecDoc, state: JobState,
  deps: Pick<SpecRoundDeps, 'listFiles' | 'readHistory' | 'publish'>, secrets: Record<string, string>,
): Promise<{ kit: KitName; state: JobState }> {
  // The kit is picked here, not by the PM agent; the user can change the Kit: line at approval.
  const files = job.mode === 'change' ? await deps.listFiles(job.repoPath) : [];
  const kit = selectKit(job.description, files).name as KitName;
  // History is a convenience: an unreadable file must not fail the spec stage.
  const history = await deps.readHistory().catch(() => []);
  const estimate = estimateCost(history, { kind: job.mode, kit, checks: spec.acceptanceChecks.length });
  await writeSpec(job.jobDir, { ...spec, kit }, secrets, estimate);
  const next = transition(state, 'awaiting_spec_approval');
  await saveState(job.jobDir, next);
  const occurrence = await specRevision(job.jobDir);
  if (occurrence) await publishOf(deps)(next, { kind: 'spec-ready', occurrence });
  return { kit, state: next };
}

const fresh = (job: SpecJob, origin: SpecSurface): SpecContinuation => ({
  version: 1, project: job.project, jobId: job.jobId, mode: job.mode, description: job.description, origin,
  status: 'running', round: 0, calls: 0, exchanges: [], updatedAt: '',
});

function replyText(e: SpecContinuation['exchanges'][number]): string {
  if (e.reply.kind === 'questions') return e.reply.questions.map((q) => `- ${q}`).join('\n');
  return `(a spec)\n${JSON.stringify(e.reply.spec, null, 2)}`;
}

/**
 * The prompt for a fresh session. The SDK transcript lives in the container, which is removed between
 * rounds, so a later round replays the saved conversation instead of resuming.
 */
export function continuationPrompt(c: Pick<SpecContinuation, 'exchanges'>, prompt: string): string {
  if (!c.exchanges.length) return prompt;
  const earlier = c.exchanges.map((e, i) => [
    `--- Earlier message ${i + 1} to you ---`, e.prompt, '--- Your reply ---', replyText(e),
  ].join('\n')).join('\n\n');
  return [
    'This continues an earlier spec conversation whose session is no longer available. Here it is in order.',
    earlier, '--- New message ---', prompt,
  ].join('\n\n');
}

async function revisePrompt(job: SpecJob, notes: string): Promise<string> {
  const current = (await readRegularFile(join(job.jobDir, 'spec.md')).catch(() => undefined)) ?? '(spec.md is not readable)';
  return [
    'The owner reviewed the spec and requested changes. Their review notes:', notes,
    'The spec they reviewed (spec.md):', current,
    'Revise the spec to address the notes. Ask questions only if the notes leave something essential unclear.',
  ].join('\n\n');
}

type Claimed = { claim: string; prompt: string; final: boolean; continuation: SpecContinuation };

const stale = (...lines: string[]): SpecRoundResult => ({ status: 'stale', lines });
const refusedResult = (...lines: string[]): SpecRoundResult => ({ status: 'refused', lines });

function interrupted(job: SpecJob): SpecRoundResult {
  return refusedResult(
    `${job.project}: the last PM turn was interrupted and its result is unknown (it may have been charged).`,
    `Nothing was repeated. To run it again: anton spec ${job.project} --retry (or /anton spec retry in the project channel).`,
  );
}

/**
 * Claim the round under the continuation lock and record the prompt before any paid call. For `revise`,
 * the caller holds the decision lock and the job is still at checkpoint 1.
 */
export async function claimSpecRound(job: SpecJob, input: SpecRoundInput, deps: Pick<SpecRoundDeps, 'surface' | 'home' | 'now'>): Promise<Claimed | SpecRoundResult> {
  const home = deps.home ?? antonHome();
  const wantStage = input.kind === 'revise' ? 'awaiting_spec_approval' : 'spec';
  return withContinuation(job.project, job.jobId, home, async (found) => {
    const state = await loadState(job.jobDir);
    if ((await currentJobId(job.repoPath)) !== job.jobId) return stale(`${job.project}: job ${job.jobId} is no longer the current job. Nothing was changed.`);
    if (state.stage !== wantStage) return stale(`${job.project}: nothing is waiting on the spec (stage: ${state.stage}).`);
    if ('confirmation' in input && input.confirmation) {
      if ((deps.now ?? Date.now)() >= input.confirmation.expiresAt) return stale('That confirmation expired. Ask again.');
      if (!found || specContinuationDigest(found) !== input.confirmation.digest) {
        return stale('The spec conversation changed. Nothing was sent. Ask again.');
      }
    }
    let c = found;
    let prompt: string;
    if (input.kind === 'start') {
      if (c) return refusedResult(`${job.project}: this spec conversation has already started.`);
      c = fresh(job, deps.surface);
      prompt = initialSpecPrompt(job.description, job.mode);
    } else if (input.kind === 'revise') {
      c = c ? { ...c, calls: 0, questions: undefined, askedAt: undefined, reminded: undefined } : fresh(job, deps.surface);
      if (specStatus(c) === 'running') return { status: 'in-progress', lines: ['The PM is already working on this spec.'] };
      prompt = await revisePrompt(job, input.notes);
    } else {
      if (!c) return refusedResult(`${job.project}: no spec conversation is saved for job ${job.jobId}.`);
      const status = specStatus(c);
      if (status === 'running') return { status: 'in-progress', lines: ['The PM is already working on this round.'] };
      if (input.kind === 'retry') {
        if (status !== 'stopped' || !c.pending) return refusedResult(`${job.project}: there is no interrupted PM turn to retry.`);
        prompt = c.pending.prompt;
      } else {
        if (status === 'stopped') return interrupted(job);
        if (status !== 'awaiting' || c.round !== input.round || !c.questions) {
          return stale(`${job.project}: those questions were already answered. Nothing was sent.`);
        }
        if (holderAlive(c.holder)) return { status: 'in-progress', lines: ['Those questions are being answered in the terminal.'] };
        const last = c.exchanges.at(-1);
        if (last) c = { ...c, exchanges: [...c.exchanges.slice(0, -1), { ...last, answers: input.answers }] };
        prompt = answersPrompt(c.questions!, input.answers);
      }
    }
    const final = input.kind === 'retry' ? c.pending!.final : c.calls >= MAX_QUESTION_ROUNDS;
    if (final && input.kind !== 'retry') prompt += FINAL_ROUND_NOTE;
    const claim = randomUUID();
    live.add(claim);
    c = {
      ...c, status: 'running', holder: { surface: deps.surface, pid: process.pid, claim, at: (deps.now ?? Date.now)() },
      pending: { prompt, final }, questions: undefined, askedAt: undefined, reminded: undefined, stopReason: undefined,
    };
    try {
      await save(c, home);
    } catch (e) {
      live.delete(claim);
      throw e;
    }
    return { claim, prompt, final, continuation: c };
  });
}

/** Update the continuation only while this claim still holds it. */
async function settle(job: SpecJob, claim: string, home: string, change: (c: SpecContinuation) => SpecContinuation): Promise<void> {
  await withContinuation(job.project, job.jobId, home, async (c) => {
    if (!c || c.holder?.claim !== claim) return;
    await save(change(c), home);
  });
}

/** Run a claimed round: one PM call in a fresh container, then questions (awaiting) or the finished spec. */
export async function runClaimedRound(job: SpecJob, claimed: Claimed, deps: SpecRoundDeps): Promise<SpecRoundResult> {
  const home = deps.home ?? antonHome();
  const now = deps.now ?? Date.now;
  const publish = publishOf(deps);
  const { claim, prompt, final, continuation } = claimed;
  let container: string | undefined;
  const stop = async (reason: string): Promise<SpecRoundResult> => {
    await settle(job, claim, home, (c) => ({ ...c, status: 'stopped', holder: undefined, stopReason: reason.slice(0, 500) }));
    const state = await loadState(job.jobDir).catch(() => undefined);
    if (state) await publish(state, { kind: 'spec-stopped', occurrence: claim });
    return { status: 'stopped', lines: [`The PM turn stopped: ${reason}`, `Nothing was repeated. Retry with: anton spec ${job.project} --retry`] };
  };
  try {
    const image = await deps.ensureImage();
    const envFile = await secretsEnvFile(job.project);
    const secrets = await loadSecrets(job.project);
    container = await deps.startContainer(job.project, job.repoPath, image, { envFile });
    const state = await loadState(job.jobDir);
    const ctx: StageCtx = { project: job.project, repo: job.repoPath, container, jobDir: job.jobDir, state, stage: 'spec', secrets, kit: 'fallback' };
    if (job.mode === 'change' && continuation.exchanges.length === 0) ctx.state = await deps.ensureRepoMap(ctx);
    // A fresh session: zero SDK offset, and the job's persisted spend stays the cost base.
    const res = await specTurn(ctx, { prompt: continuationPrompt(continuation, prompt), final }, { runAgent: deps.runAgent });
    const turn: SpecTurn = res.turn;
    const exchange = { prompt, reply: turn.kind === 'questions' ? { kind: 'questions' as const, questions: turn.questions } : { kind: 'spec' as const, spec: turn.spec } };
    if (turn.kind === 'questions') {
      if (final) return await stop('the PM did not produce a spec in its last round');
      let round = 0;
      await settle(job, claim, home, (c) => {
        round = c.round + 1;
        return {
          ...c, status: 'awaiting', holder: undefined, pending: undefined, calls: c.calls + 1, round,
          questions: turn.questions, askedAt: now(), reminded: false, exchanges: [...c.exchanges, exchange],
        };
      });
      if (round) await publish(res.state, { kind: 'spec-questions', occurrence: `round-${round}` });
      return { status: 'questions', round, questions: turn.questions, lines: [`The PM asked ${turn.questions.length} question(s) in the job thread (round ${round}).`] };
    }
    const finished = await withDecisionLock(job.project, async (fresh) => {
      if (fresh.jobId !== job.jobId || fresh.state.stage !== 'spec') return undefined;
      return finishSpec(job, turn.spec, { ...res.state, stage: fresh.state.stage }, deps, secrets);
    });
    if (!finished) return await stop('the job changed while the PM was writing the spec');
    await settle(job, claim, home, (c) => ({
      ...c, status: 'done', holder: undefined, pending: undefined, calls: c.calls + 1, exchanges: [...c.exchanges, exchange],
    }));
    return { status: 'spec', lines: [`Spec ready for approval: ${turn.spec.title.slice(0, 200)} (kit ${finished.kit}).`, `Approve on the card, or run: anton approve ${job.project}`] };
  } catch (e) {
    return await stop(e instanceof Error ? e.message : String(e));
  } finally {
    live.delete(claim);
    if (container) await deps.stopContainer(container).catch(() => undefined);
  }
}

/** Claim and run one round. */
export async function runSpecRound(job: SpecJob, input: SpecRoundInput, deps: SpecRoundDeps): Promise<SpecRoundResult> {
  const claimed = await claimSpecRound(job, input, deps);
  if ('status' in claimed) return claimed;
  return runClaimedRound(job, claimed, deps);
}

/**
 * The interactive CLI loop (`anton new` / `anton change`) keeps its in-container session and resumes it,
 * and records the same continuation, holding each round while the terminal asks.
 */
export function interactiveSpecHooks(job: SpecJob, deps: { home?: string; now?: () => number } = {}): SpecHooks & { stopped(reason: string): Promise<void>; done(): void } {
  const home = deps.home ?? antonHome();
  const now = deps.now ?? Date.now;
  const claim = randomUUID();
  live.add(claim);
  const holder = () => ({ surface: 'cli' as const, pid: process.pid, claim, at: now() });
  return {
    async beforeCall({ call, prompt, final, answers }) {
      await withContinuation(job.project, job.jobId, home, async (c) => {
        if (call === 0) {
          if (c && holderAlive(c.holder)) throw new SpecConflict('This spec conversation has already started elsewhere.');
          // The CLI just created this job, so a saved file for its name is left over (a reused project name):
          // keep it aside for reference and start fresh.
          if (c) await fsp.rename(specContinuationPath(job.project, job.jobId, home), `${specContinuationPath(job.project, job.jobId, home)}.replaced-${now()}`);
          await save({ ...fresh(job, 'cli'), holder: holder(), pending: { prompt, final } }, home);
          return;
        }
        if (!c || c.holder?.claim !== claim || c.status !== 'awaiting') throw new SpecConflict('This spec round was answered elsewhere.');
        const last = c.exchanges.at(-1);
        const exchanges = last && answers ? [...c.exchanges.slice(0, -1), { ...last, answers }] : c.exchanges;
        await save({ ...c, exchanges, status: 'running', holder: holder(), pending: { prompt, final }, questions: undefined, askedAt: undefined }, home);
      });
    },
    async afterCall({ prompt, turn }) {
      await settle(job, claim, home, (c) => {
        const exchange = { prompt, reply: turn.kind === 'questions' ? { kind: 'questions' as const, questions: turn.questions } : { kind: 'spec' as const, spec: turn.spec } };
        const base = { ...c, pending: undefined, calls: c.calls + 1, exchanges: [...c.exchanges, exchange] };
        return turn.kind === 'questions'
          ? { ...base, status: 'awaiting', round: c.round + 1, questions: turn.questions, askedAt: now(), reminded: false }
          : { ...base, status: 'done', holder: undefined };
      });
    },
    async stopped(reason) {
      live.delete(claim);
      await settle(job, claim, home, (c) => ({ ...c, status: c.status === 'awaiting' ? 'awaiting' : 'stopped', holder: undefined, stopReason: reason.slice(0, 500) }))
        .catch(() => undefined);
    },
    done() {
      live.delete(claim);
    },
  };
}
