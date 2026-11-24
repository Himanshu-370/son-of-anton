import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFile, writeFileAtomic } from './atomic.js';
import { budgetSettings, loadAntonConfig } from './anton-config.js';
import { allowanceUsage, cacheHitRate, parseUsage, stageGroup, totalUsage, usd } from './budget.js';
import { AREA_ORDER } from './config.js';
import { commitAll, currentBranch, isClean, listTags as defaultListTags, switchBranch, tag } from './git.js';
import { assertOnJobBranch, currentJobId } from './job.js';
import { isRunning, waitForLockFile } from './lock.js';
import { jobDir as jobDirOf } from './paths.js';
import { getProject, listProjects, type ProjectEntry } from './registry.js';
import { loadSecrets } from './secrets.js';
import { loadState, saveState, transition, unpause, type JobState, type Stage } from './state.js';
import { PreflightError } from '../docker/container.js';
import { ACTIVE_STAGES, allowanceHint, containerName, seededState } from '../pipeline/runner.js';
import { submitRetro, type RetroDeps } from '../retro/run.js';
import type { SecurityFinding } from '../security/review.js';
import { acceptRisk } from '../security/risks.js';
import { PlanSchema, type Plan } from '../stages/plan.js';
import { failuresPath, type FailureItem } from '../stages/qa.js';
import { readApprovedSpec } from '../stages/spec.js';
import { assertJobDir, failureReportPath } from '../stages/verify.js';

/**
 * The job decisions shared by the CLI and Slack. Each one rechecks its target under the repo's decision
 * lock, makes only the local transition (or durable claim) there, and does long work after release.
 */

/** What a decision acts on. `revision` binds a review decision to the exact spec or delivery the owner saw. */
export type ActionTarget = { project: string; jobId: string; stage: Stage; revision?: string };

export type ActionStatus = 'done' | 'stale' | 'refused';
/** `code` is the CLI exit code: 0 done, 1 refused or stale, 2 Docker preflight failed. */
export type ActionOutcome = { code: number; status: ActionStatus };

export type JobActionDeps = {
  out: (line: string) => void;
  err: (line: string) => void;
  preflight: () => Promise<void>;
  spawnRun: (name: string, jobDir: string) => void;
  stopContainer: (name: string) => Promise<void>;
  retro: Omit<RetroDeps, 'out'>;
  listTags?: (repo: string, pattern: string) => Promise<string[]>;
  /** How long to wait for another decision on the same repo (default 10 s). */
  lockWaitMs?: number;
};

export type LoadedJob = { name: string; repo: string; jobId: string; jobDir: string; state: JobState };

const done: ActionOutcome = { code: 0, status: 'done' };
const refused = (code = 1): ActionOutcome => ({ code, status: 'refused' });
const stale: ActionOutcome = { code: 1, status: 'stale' };

/** A project's current job and its state. Bench jobs are refused unless `allowBench`. */
export async function loadJob(name: string, opts: { allowBench?: boolean } = {}): Promise<LoadedJob> {
  const { repoPath: repo } = await getProject(name);
  const jobId = await currentJobId(repo);
  const jobDir = jobDirOf(repo, jobId);
  const job = { name, repo, jobId, jobDir, state: await loadState(jobDir) };
  if (!opts.allowBench && job.state.bench !== undefined) throw new Error('Bench jobs are managed by anton bench.');
  return job;
}

/** The CLI acts on whatever the current job is right now. */
export function targetOf(job: LoadedJob): ActionTarget {
  return { project: job.name, jobId: job.jobId, stage: job.state.stage };
}

const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/**
 * The review revision: the spec.json digest at spec approval (the spec-ready milestone occurrence) and the
 * newest numbered delivery tag (`delivered-<n>`, the delivery-ready occurrence) at final review.
 */
export async function checkpointRevision(
  job: LoadedJob,
  listTags: (repo: string, pattern: string) => Promise<string[]> = defaultListTags,
): Promise<string | undefined> {
  if (job.state.stage === 'awaiting_spec_approval') {
    try {
      const raw = await readRegularFile(join(job.jobDir, 'spec.json'));
      return raw === undefined ? undefined : sha256(raw);
    } catch {
      return undefined;
    }
  }
  if (job.state.stage === 'awaiting_final_review') {
    const prefix = `anton/${job.jobId}/`;
    return (await listTags(job.repo, `${prefix}delivered-*`))
      .filter((t) => t.startsWith(prefix))
      .map((t) => t.slice(prefix.length))
      .filter((t) => /^delivered-[1-9]\d{0,14}$/.test(t))
      .sort((a, b) => Number(b.slice(10)) - Number(a.slice(10)))[0];
  }
  return undefined;
}

/** A Slack card target: the current job with its review revision. */
export async function reviewTarget(project: string, listTags?: (repo: string, pattern: string) => Promise<string[]>): Promise<ActionTarget> {
  const job = await loadJob(project);
  return { ...targetOf(job), revision: await checkpointRevision(job, listTags) };
}

/** Run `body` under the repo's cross-process decision lock with freshly loaded state. Keep `body` short and local. */
async function underDecisionLock<T>(
  target: ActionTarget, deps: JobActionDeps, opts: { allowBench?: boolean }, body: (fresh: LoadedJob) => Promise<T>,
): Promise<T> {
  const { repoPath } = await getProject(target.project);
  await fsp.mkdir(join(repoPath, '.anton'), { recursive: true });
  const release = await waitForLockFile(join(repoPath, '.anton', 'decision.lock'), deps.lockWaitMs);
  try {
    return await body(await loadJob(target.project, opts));
  } finally {
    await release();
  }
}

/** Why the fresh job no longer matches the target, or undefined when it still does. */
async function mismatch(fresh: LoadedJob, target: ActionTarget, deps: JobActionDeps): Promise<'job' | 'stage' | 'revision' | undefined> {
  if (fresh.jobId !== target.jobId) return 'job';
  if (fresh.state.stage !== target.stage) return 'stage';
  if (target.revision !== undefined && (await checkpointRevision(fresh, deps.listTags)) !== target.revision) return 'revision';
  return undefined;
}

/** Run `body` under the project's decision lock (the spec session's own transitions). */
export async function withDecisionLock<T>(project: string, body: (fresh: LoadedJob) => Promise<T>, lockWaitMs?: number): Promise<T> {
  return underDecisionLock({ project, jobId: '', stage: 'spec' }, { lockWaitMs } as JobActionDeps, {}, body);
}

/**
 * Request changes at spec approval: under the lock, check the exact spec the owner saw and move the job back to
 * `spec`. `claim` runs inside the lock too (the spec continuation's round claim); its refusal leaves the job as it was.
 */
export async function reopenSpec<T>(
  target: ActionTarget,
  d: Pick<JobActionDeps, 'err' | 'listTags' | 'lockWaitMs'>,
  claim: (job: LoadedJob) => Promise<T>,
): Promise<{ outcome: ActionOutcome; claimed?: T; job?: LoadedJob }> {
  const nothing = 'Nothing to revise';
  const deps = d as JobActionDeps;
  const pre = await loadJob(target.project);
  if (await staleBeforeLock(pre, target, deps, nothing)) return { outcome: stale };
  return underDecisionLock(target, deps, {}, async (job) => {
    const why = await mismatch(job, target, deps);
    if (why) {
      d.err(staleMessage(job, target, why, nothing));
      return { outcome: stale };
    }
    if (job.state.stage !== 'awaiting_spec_approval') {
      d.err(`${nothing} (stage: ${job.state.stage})`);
      return { outcome: refused() };
    }
    await assertOnJobBranch(job.repo, job.state);
    const claimed = await claim(job);
    await saveState(job.jobDir, transition(job.state, 'spec'));
    return { outcome: done, claimed, job };
  });
}

/** Fast pre-lock check: a target that has already moved is stale before any slow work. */
async function staleBeforeLock(pre: LoadedJob, target: ActionTarget, d: JobActionDeps, nothing: string): Promise<boolean> {
  const why = await mismatch(pre, target, d);
  if (why) d.err(staleMessage(pre, target, why, nothing));
  return why !== undefined;
}

function staleMessage(fresh: LoadedJob, target: ActionTarget, why: 'job' | 'stage' | 'revision', nothing: string): string {
  if (why === 'job') return `${target.project}: job ${target.jobId} is no longer the current job (now ${fresh.jobId}). Nothing was changed.`;
  if (why === 'revision') return `${target.project}: this review is out of date; a newer version is waiting. Nothing was changed.`;
  return `${nothing} (stage: ${fresh.state.stage})`;
}

/** Runs preflight; prints the message and returns 2 on a PreflightError, 0 when ready. */
export async function preflightOr2(d: Pick<JobActionDeps, 'preflight' | 'err'>): Promise<number> {
  try {
    await d.preflight();
    return 0;
  } catch (e) {
    if (!(e instanceof PreflightError)) throw e;
    d.err(e.message);
    return 2;
  }
}

/**
 * Prints an error and returns 1 when a background run already holds the project's lock.
 * `message` overrides the default text (e.g. when the run is known to be shutting down).
 */
export async function refuseIfRunning(
  d: Pick<JobActionDeps, 'err'>,
  repo: string,
  project: string,
  message?: (pid: number | undefined) => string,
): Promise<number> {
  const r = await isRunning(repo);
  if (!r.running) return 0;
  d.err(message ? message(r.pid) : `${project} is already running (pid ${r.pid}). Stop it first with: anton stop ${project}`);
  return 1;
}

/**
 * After a change job ends, return the repo to the branch it started from. Only when HEAD is still on the
 * job branch (never move the user off a branch anton does not own) and the tree is clean; otherwise
 * print the `git switch` command. The job branch is kept.
 */
export async function switchBackFromJob(d: Pick<JobActionDeps, 'out'>, repo: string, state: JobState): Promise<void> {
  const from = state.fromBranch;
  if (state.kind !== 'change' || !from || (await currentBranch(repo).catch(() => '')) !== state.branch) return;
  const back = await isClean(repo)
    .then((clean) => clean && switchBranch(repo, from).then(() => true))
    .catch(() => false);
  d.out(back ? `Switched back to ${from}. Branch ${state.branch} is kept.` : `Repo not switched back. To return: git switch ${from}`);
}

/*
 * Spawn claim. A decision that starts a background run writes the claim and then the new state while still
 * holding the decision lock; the spawn itself happens after release. Until the runner takes its run lock,
 * the claim stops a second decision from starting another run. A crash after the state write leaves an
 * "interrupted" job that `resume` recovers once the claim expires.
 */
export const SPAWN_CLAIM_MS = 30_000;
const claimPath = (repo: string) => join(repo, '.anton', 'spawn-claim.json');
const ClaimSchema = z.object({ jobId: z.string(), pid: z.number().int(), at: z.number() });

async function writeSpawnClaim(job: LoadedJob): Promise<void> {
  await writeFileAtomic(claimPath(job.repo), JSON.stringify({ jobId: job.jobId, pid: process.pid, at: Date.now() }) + '\n');
}

/** True while a recent decision has claimed the spawn of this job's runner. */
export async function spawnClaimed(job: LoadedJob, now = Date.now()): Promise<boolean> {
  try {
    const raw = await readRegularFile(claimPath(job.repo));
    if (raw === undefined) return false;
    const c = ClaimSchema.parse(JSON.parse(raw));
    return c.jobId === job.jobId && now - c.at >= 0 && now - c.at < SPAWN_CLAIM_MS;
  } catch {
    return false;
  }
}

/** Approve the spec (start the background run) or the final delivery. */
export async function approveJob(target: ActionTarget, d: JobActionDeps): Promise<ActionOutcome> {
  const pre = await loadJob(target.project);
  const nothing = 'Nothing to approve';
  if (await staleBeforeLock(pre, target, d, nothing)) return stale;
  if (target.stage === 'awaiting_spec_approval' && pre.jobId === target.jobId && pre.state.stage === target.stage) {
    // Fail fast, before the lock: wrong branch, then Docker.
    await assertOnJobBranch(pre.repo, pre.state);
    const code = await preflightOr2(d);
    if (code !== 0) return refused(code);
  }
  const claimed = await underDecisionLock(target, d, {}, async (job) => {
    const why = await mismatch(job, target, d);
    if (why) {
      d.err(staleMessage(job, target, why, nothing));
      return { outcome: stale };
    }
    const { state } = job;
    if (state.stage === 'awaiting_spec_approval') {
      await assertOnJobBranch(job.repo, state);
      await readApprovedSpec(job.jobDir);
      await commitAll(job.repo, 'chore: spec approved', await loadSecrets(target.project), { emptyIfNoHead: true });
      await tag(job.repo, `anton/${job.jobId}/spec-approved`);
      await writeSpawnClaim(job);
      await saveState(job.jobDir, transition(state, 'plan'));
      return { job, next: 'spawn' as const };
    }
    if (state.stage === 'awaiting_final_review') {
      await saveState(job.jobDir, transition(state, 'done'));
      return { job, next: 'retro' as const };
    }
    d.err(`${nothing} (stage: ${state.stage})`);
    return { outcome: refused() };
  });
  if (claimed.outcome) return claimed.outcome;
  const { job, next } = claimed;
  if (next === 'spawn') {
    d.spawnRun(target.project, job.jobDir);
    d.out(`Spec approved. ${target.project} is now running in the background.`);
    d.out(`Follow it with: anton logs -f ${target.project}`);
    return done;
  }
  d.out(`${target.project}: delivery approved. Done.`);
  // Switch back first: Retro may wait on the API, and Ctrl-C then must not strand the repo on anton/<id>.
  try {
    await switchBackFromJob(d, job.repo, job.state);
  } finally {
    await submitRetro(job, 'approved', { ...d.retro, out: d.out });
  }
  return done;
}

/**
 * Send the delivery back to build. The notes become the persisted failure report (R11), which runBuild
 * picks up in fix mode since every task is done. Notes are the owner's review text; callers clean them.
 */
export async function rejectJob(target: ActionTarget, notes: string, d: JobActionDeps): Promise<ActionOutcome> {
  const nothing = 'Nothing to reject';
  const pre = await loadJob(target.project);
  if (await staleBeforeLock(pre, target, d, nothing)) return stale;
  if (pre.state.stage !== 'awaiting_final_review') {
    d.err(`${nothing} (stage: ${pre.state.stage})`);
    return refused();
  }
  // The runner that reached awaiting_final_review may still be stopping its container and
  // releasing the lock; a run spawned now would die with AlreadyRunning in runner.log.
  const busyMessage = (pid: number | undefined) => `${target.project}'s previous run (pid ${pid}) is still finishing — try again in a moment.`;
  if ((await refuseIfRunning(d, pre.repo, target.project, busyMessage)) !== 0) return refused();
  const code = await preflightOr2(d);
  if (code !== 0) return refused(code);

  const claimed = await underDecisionLock(target, d, {}, async (job) => {
    const why = await mismatch(job, target, d);
    if (why) {
      d.err(staleMessage(job, target, why, nothing));
      return { outcome: stale };
    }
    if ((await refuseIfRunning(d, job.repo, target.project, busyMessage)) !== 0) return { outcome: refused() };
    const n = (await fsp.readdir(job.jobDir)).filter((f) => /^notes-round-\d+\.md$/.test(f)).length + 1;
    await writeFileAtomic(join(job.jobDir, `notes-round-${n}.md`), `${notes}\n`);
    await writeFileAtomic(
      failureReportPath(job.jobDir),
      `### Rejected at final review\n\nThe reviewer rejected the delivery. Address these notes:\n\n${notes}\n`,
    );
    // Fan the notes out to every area in the plan (one review item each); without a readable plan the
    // markdown report above is all there is, and build routes it to every area (P2-R1).
    let plan: Plan | undefined;
    try {
      plan = PlanSchema.parse(JSON.parse(await fsp.readFile(join(job.jobDir, 'plan.json'), 'utf8')));
    } catch {
      plan = undefined;
    }
    if (plan) {
      const p = plan;
      const items: FailureItem[] = AREA_ORDER.filter((a) => p.tasks.some((t) => t.area === a)).map((area) => ({
        area,
        kind: 'review',
        id: `NOTES-${n}`,
        text: notes,
      }));
      await writeFileAtomic(failuresPath(job.jobDir), JSON.stringify(items, null, 2) + '\n');
    }
    const next = transition(job.state, 'build', { round: 1, completedFixAreas: [], rejects: (job.state.rejects ?? 0) + 1 });
    // A fresh review cycle: an old signature must not trigger a false no_progress.
    delete next.lastFailureSignature;
    await writeSpawnClaim(job);
    await saveState(job.jobDir, next);
    return { job, n };
  });
  if (claimed.outcome) return claimed.outcome;
  d.spawnRun(target.project, claimed.job.jobDir);
  d.out(`Rejected (notes-round-${claimed.n}.md). ${target.project} is back in build, running in the background.`);
  return done;
}

export type ResumeOptions = { budget?: number; acceptAsIs?: boolean };

/** The resumed state, or an error line. Shared by the fast pre-lock check and the recheck under the lock. */
async function planResume(job: LoadedJob, opts: ResumeOptions, d: Pick<JobActionDeps, 'err'>): Promise<JobState | undefined> {
  const project = job.name;
  if ((await refuseIfRunning(d, job.repo, project)) !== 0) return undefined;
  let state = job.state;
  const paused = state.stage === 'paused';
  if (!paused && !ACTIVE_STAGES.includes(state.stage)) {
    d.err(`Nothing to resume (stage: ${state.stage})`);
    return undefined;
  }
  if (await spawnClaimed(job)) {
    d.err(`${project} is starting in the background. Check it with: anton status ${project}`);
    return undefined;
  }
  await assertOnJobBranch(job.repo, job.state);
  state = await seededState(job.repo, job.jobDir, state);
  if (opts.acceptAsIs && !(paused && (state.pausedFrom === 'verify' || state.pausedFrom === 'build'))) {
    d.err(`--accept-as-is only works when paused during build or verify (stage: ${state.stage}${paused ? `, paused from: ${state.pausedFrom}` : ''})`);
    return undefined;
  }
  const { budget } = opts;
  // Delivering costs nothing, so accept-as-is needs no extra budget.
  if (paused && state.pauseReason === 'budget_cap' && budget === undefined && !opts.acceptAsIs) {
    d.err(`Budget cap reached (${usd(state.spentUsd)} of ${usd(state.budgetUsd)} spent). Resume with: anton resume ${project} --budget <usd>`);
    return undefined;
  }
  const group = paused && state.pauseReason === 'allowance' ? stageGroup(state.pausedFrom ?? '') : undefined;
  if (group && budget === undefined && !opts.acceptAsIs) {
    const a = allowanceUsage(state, group, budgetSettings(await loadAntonConfig()).allowances);
    d.err(allowanceHint(project, group, a.spentUsd, a.limitUsd));
    return undefined;
  }
  // A new cap raises every allowance with it: they are shares of budgetUsd.
  if (budget !== undefined) {
    if (budget <= state.spentUsd) {
      d.err(`--budget must be more than the ${usd(state.spentUsd)} already spent`);
      return undefined;
    }
    // A raised cap restarts the 80% warning.
    state = { ...state, budgetUsd: budget, warned80: false };
  }
  if (paused) state = opts.acceptAsIs ? transition(state, 'deliver') : unpause(state);
  return state;
}

/** Continue a paused job, or an interrupted one (active stage, no live run). `budget` sets a new total cap. */
export async function resumeJob(target: ActionTarget, opts: ResumeOptions, d: JobActionDeps): Promise<ActionOutcome> {
  const pre = await loadJob(target.project);
  if (await staleBeforeLock(pre, target, d, `${target.project} changed before the resume`)) return stale;
  if (!(await planResume(pre, opts, d))) return refused();
  const code = await preflightOr2(d);
  if (code !== 0) return refused(code);
  const claimed = await underDecisionLock(target, d, {}, async (job) => {
    const why = await mismatch(job, target, d);
    if (why) {
      d.err(staleMessage(job, target, why, `${target.project} changed before the resume`));
      return { outcome: stale };
    }
    const state = await planResume(job, opts, d);
    if (!state) return { outcome: refused() };
    await writeSpawnClaim(job);
    await saveState(job.jobDir, state);
    return { job, state };
  });
  if (claimed.outcome) return claimed.outcome;
  d.spawnRun(target.project, claimed.job.jobDir);
  d.out(`${target.project}: resumed at ${claimed.state.stage}, running in the background. Follow with: anton logs -f ${target.project}`);
  return done;
}

/** Give up on the current job and stop its container. */
export async function abandonJob(target: ActionTarget, d: JobActionDeps): Promise<ActionOutcome> {
  const pre = await loadJob(target.project);
  if (await staleBeforeLock(pre, target, d, `${target.project} changed before the abandon`)) return stale;
  if ((await refuseIfRunning(d, pre.repo, target.project)) !== 0) return refused();
  const claimed = await underDecisionLock(target, d, {}, async (job) => {
    const why = await mismatch(job, target, d);
    if (why) {
      d.err(staleMessage(job, target, why, `${target.project} changed before the abandon`));
      return { outcome: stale };
    }
    if ((await refuseIfRunning(d, job.repo, target.project)) !== 0) return { outcome: refused() };
    await saveState(job.jobDir, transition(job.state, 'abandoned'));
    return { job };
  });
  if (claimed.outcome) return claimed.outcome;
  const { job } = claimed;
  await d.stopContainer(containerName(target.project));
  d.out(`${target.project}: abandoned.`);
  // Change jobs leave the repo on anton/<id>; go back to where the user was, before Retro waits on the API.
  try {
    await switchBackFromJob(d, job.repo, job.state);
  } finally {
    await submitRetro(job, 'abandoned', { ...d.retro, out: d.out });
  }
  return done;
}

/** Thrown for a decision the job's state does not allow; the CLI prints it and exits 1. */
export class ActionRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ActionRefused';
  }
}

/** Record an accepted security risk. Allowed while paused or awaiting final review. */
export async function acceptJobRisk(target: ActionTarget, findingId: string, reason: string, d: JobActionDeps): Promise<ActionOutcome> {
  const res = await underDecisionLock(target, d, { allowBench: true }, async (job) => {
    const { stage } = job.state;
    if (job.jobId !== target.jobId) {
      d.err(staleMessage(job, target, 'job', ''));
      return undefined;
    }
    if (stage !== 'paused' && stage !== 'awaiting_final_review') {
      throw new ActionRefused(`Can't accept a risk now (stage: ${stage}). Wait until the job is paused or awaiting final review.`);
    }
    if (target.revision !== undefined && (await mismatch(job, target, d))) {
      d.err(staleMessage(job, target, 'revision', ''));
      return undefined;
    }
    let findings: SecurityFinding[] = [];
    try {
      const raw = JSON.parse(await fsp.readFile(join(job.jobDir, 'evidence', 'results.json'), 'utf8')) as {
        security?: { findings?: SecurityFinding[] };
      };
      findings = raw.security?.findings ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const finding = findingId.startsWith('SEC-') ? findings.find((f) => f.id === findingId) : undefined;
    if (!finding) throw new ActionRefused(`Unknown security finding ${findingId}`);
    await acceptRisk(job.jobDir, finding.id, reason);
    return { finding, stage };
  });
  if (!res) return stale;
  d.out(`${res.finding.id}: ${res.finding.title} — accepted`);
  if (res.stage === 'awaiting_final_review') {
    d.out('Note: REPORT.md was written before this acceptance; it will show it after the next delivery.');
  }
  return done;
}

export type StatusRow = [string, string, string, string, string, string];
export const STATUS_HEADER: StatusRow = ['PROJECT', 'STAGE', 'ROUND', 'SPENT / BUDGET', 'PAUSE REASON', 'CACHE'];

/** The job's cache hit rate as `cache 62%`, or `-` when there is no data or usage.json can't be read safely. */
async function cacheCell(repo: string, jobDir: string): Promise<string> {
  try {
    await assertJobDir(repo, jobDir);
    const rate = cacheHitRate(totalUsage(parseUsage(await readRegularFile(join(jobDir, 'usage.json')))));
    return rate === undefined ? '-' : `cache ${Math.round(rate * 100)}%`;
  } catch {
    return '-';
  }
}

async function statusRow(p: ProjectEntry): Promise<StatusRow> {
  try {
    const dir = jobDirOf(p.repoPath, await currentJobId(p.repoPath));
    const s = await loadState(dir);
    let stage: string = s.stage;
    if (ACTIVE_STAGES.includes(s.stage) && !(await isRunning(p.repoPath)).running) stage = `interrupted (${s.stage})`;
    return [p.name, stage, String(s.round), `${usd(s.spentUsd)} / ${usd(s.budgetUsd)}`, s.pauseReason ?? '-', await cacheCell(p.repoPath, dir)];
  } catch (e) {
    return [p.name, `unreadable (${e instanceof Error ? e.message : String(e)})`, '-', '-', '-', '-'];
  }
}

/** One row per project (or the named one): read-only, no model calls. */
export async function jobStatusRows(project?: string): Promise<StatusRow[]> {
  const projects = project ? [await getProject(project)] : await listProjects();
  return Promise.all(projects.map(statusRow));
}
