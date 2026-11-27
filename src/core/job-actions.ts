import { createHash } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFile, writeFileAtomic } from './atomic.js';
import { budgetSettings, loadAntonConfig } from './anton-config.js';
import { monthlyCapRefusal } from './spend-log.js';
import { allowanceUsage, stageGroup, usd } from './budget.js';
import { AREA_ORDER } from './config.js';
import { commitAll, currentBranch, isClean, listTags as defaultListTags, switchBranch, tagHead } from './git.js';
import { assertOnJobBranch, currentJobId } from './job.js';
import { AlreadyRunning, isRunning, waitForLockFile } from './lock.js';
import { jobDir as jobDirOf } from './paths.js';
import { getProject } from './registry.js';
import { loadSecrets } from './secrets.js';
import { loadState, pause, saveState, transition, unpause, type JobState, type Stage } from './state.js';
import { PreflightError } from '../docker/container.js';
import { ACTIVE_STAGES, allowanceHint, containerName, seededState } from '../pipeline/runner.js';
import { submitRetro, type RetroDeps } from '../retro/run.js';
import type { SecurityFinding } from '../security/review.js';
import { publishJobMilestone } from '../slack/job-milestones.js';
import { acceptRisk } from '../security/risks.js';
import { PlanSchema, type Plan } from '../stages/plan.js';
import { failuresPath, type FailureItem } from '../stages/qa.js';
import { readApprovedSpec } from '../stages/spec.js';
import { failureReportPath } from '../stages/verify.js';

/**
 * The Owner actions shared by the CLI and Slack. Each one rechecks its target under the repo's decision
 * lock, makes only the local transition (or durable claim) there, and does long work after release.
 */

/** What an Owner action acts on. `revision` binds a review action to the exact spec or delivery the owner saw. */
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
  // Every pause has its own number, whatever its reason, so a card for an earlier pause is stale.
  if (job.state.stage === 'paused') return `paused-${job.state.pauses ?? 0}`;
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

/** True when the target still names the project's current job, stage and (if set) review revision. */
export async function isCurrent(target: ActionTarget, listTags?: (repo: string, pattern: string) => Promise<string[]>): Promise<boolean> {
  return (await mismatch(await loadJob(target.project), target, listTags, true)) === undefined;
}

/** Run `body` under the repo's cross-process decision lock with freshly loaded state. Keep `body` short and local. */
async function underDecisionLock<T>(
  project: string, opts: { allowBench?: boolean }, body: (fresh: LoadedJob) => Promise<T>, lockWaitMs?: number,
): Promise<T> {
  const { repoPath } = await getProject(project);
  await fsp.mkdir(join(repoPath, '.anton'), { recursive: true });
  const release = await waitForLockFile(join(repoPath, '.anton', 'decision.lock'), lockWaitMs).catch((e: unknown) => {
    if (e instanceof AlreadyRunning) throw new Error(`Another decision on ${project} is in progress. Try again in a moment.`);
    throw e;
  });
  try {
    return await body(await loadJob(project, opts));
  } finally {
    await release();
  }
}

/** Why the fresh job no longer matches the target, or undefined when it still does. */
async function mismatch(
  fresh: LoadedJob,
  target: ActionTarget,
  listTags: ((repo: string, pattern: string) => Promise<string[]>) | undefined,
  matchStage: boolean,
): Promise<'job' | 'stage' | 'revision' | undefined> {
  if (fresh.jobId !== target.jobId) return 'job';
  if (matchStage && fresh.state.stage !== target.stage) return 'stage';
  if (target.revision !== undefined && (await checkpointRevision(fresh, listTags)) !== target.revision) return 'revision';
  return undefined;
}

/** Run `body` under the project's decision lock (the spec session's own transitions). */
export async function withDecisionLock<T>(project: string, body: (fresh: LoadedJob) => Promise<T>, lockWaitMs?: number): Promise<T> {
  return underDecisionLock(project, {}, body, lockWaitMs);
}

function staleMessage(
  fresh: LoadedJob, target: ActionTarget, why: 'job' | 'stage' | 'revision', nothing: string, note = 'Nothing was changed.',
): string {
  if (why === 'job') return `${target.project}: job ${target.jobId} is no longer the current job (now ${fresh.jobId}). ${note}`;
  if (why === 'revision') return `${target.project}: this review is out of date; a newer version is waiting. ${note}`;
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

/** One Owner action, as `decide` runs it. */
type OwnerAction<R> = {
  /** Prefix for "<nothing> (stage: x)" refusals and stale messages, e.g. 'Nothing to approve'. */
  nothing: string;
  /** Replaces the closing "Nothing was changed." in the job and revision stale messages (e.g. when work already happened). */
  staleNote?: string;
  allowBench?: boolean;
  /** Compare stage with the target (default true). */
  matchStage?: boolean;
  /** D8 busy rule + Docker preflight before the lock + spawn claim with the state write. */
  startsRun?: { busyMessage?: (pid: number | undefined) => string };
  /** Runs before the lock and again under it. Prints its own refusal via d.err; returns false to refuse. */
  check?: (job: LoadedJob) => Promise<boolean>;
  /** Under the lock, after the re-check: local writes only. Returns the new state (saved by decide) and a result, or undefined to refuse. */
  apply: (job: LoadedJob) => Promise<{ state?: JobState; result: R } | undefined>;
  /** After release: spawn, stop container, Retro, messages. Optional (reopenSpec has none). */
  after?: (job: LoadedJob, result: R) => Promise<void>;
};

type DecideDeps = Pick<JobActionDeps, 'err' | 'listTags' | 'lockWaitMs'> & Partial<Pick<JobActionDeps, 'preflight'>>;

/**
 * Every Owner action: a fast stale check and `check` before the lock (and, for an action that starts a run,
 * the busy rule and Docker preflight), then the same checks again under the decision lock, the local writes,
 * and the slow work in `after` once the lock is released.
 */
async function decide<R>(target: ActionTarget, action: OwnerAction<R>, d: DecideDeps): Promise<ActionOutcome> {
  const { project } = target;
  const opts = { allowBench: action.allowBench };
  const isStale = async (job: LoadedJob) => {
    const why = await mismatch(job, target, d.listTags, action.matchStage ?? true);
    if (why) d.err(staleMessage(job, target, why, action.nothing, action.staleNote));
    return why !== undefined;
  };
  const passes = async (job: LoadedJob) => !action.check || (await action.check(job));
  // D8: a live run, or a run another decision is about to spawn, blocks starting another one. The claim is written
  // with the move to an active stage, so at a Checkpoint a live claim is a leftover and only the run lock counts.
  const busy = async (job: LoadedJob) => {
    if ((await refuseIfRunning(d, job.repo, project, action.startsRun?.busyMessage)) !== 0) return true;
    if (!ACTIVE_STAGES.includes(job.state.stage) || !(await spawnClaimed(job))) return false;
    d.err(`${project} is starting in the background. Check it with: anton status ${project}`);
    return true;
  };

  const pre = await loadJob(project, opts);
  if (await isStale(pre)) return stale;
  if (!(await passes(pre))) return refused();
  if (action.startsRun) {
    if (await busy(pre)) return refused();
    if (!d.preflight) throw new Error('An action that starts a run needs a Docker preflight.');
    const code = await preflightOr2({ err: d.err, preflight: d.preflight });
    if (code !== 0) return refused(code);
  }

  const decided = await underDecisionLock(project, opts, async (job): Promise<{ outcome: ActionOutcome } | { job: LoadedJob; result: R }> => {
    if (await isStale(job)) return { outcome: stale };
    if (!(await passes(job))) return { outcome: refused() };
    if (action.startsRun && (await busy(job))) return { outcome: refused() };
    const applied = await action.apply(job);
    if (!applied) return { outcome: refused() };
    if (action.startsRun) await writeSpawnClaim(job);
    if (applied.state) await saveState(job.jobDir, applied.state);
    return { job, result: applied.result };
  }, d.lockWaitMs);
  if ('outcome' in decided) return decided.outcome;
  await action.after?.(decided.job, decided.result);
  return done;
}

/**
 * Request changes at spec approval: under the lock, check the exact spec the owner saw and move the job back to
 * `spec`. `claim` runs inside the lock too (the spec continuation's round claim); its refusal leaves the job as it was.
 */
export async function reopenSpec<T>(
  target: ActionTarget,
  d: Pick<JobActionDeps, 'err' | 'listTags' | 'lockWaitMs'>,
  /** Returns undefined to refuse (it reports why itself); the job then stays at checkpoint 1. */
  claim: (job: LoadedJob) => Promise<T | undefined>,
): Promise<{ outcome: ActionOutcome; claimed?: T; job?: LoadedJob }> {
  const nothing = 'Nothing to revise';
  let opened: { claimed: T; job: LoadedJob } | undefined;
  const outcome = await decide(target, {
    nothing,
    check: async (job) => {
      if (job.state.stage === 'awaiting_spec_approval') return true;
      d.err(`${nothing} (stage: ${job.state.stage})`);
      return false;
    },
    apply: async (job) => {
      await assertOnJobBranch(job.repo, job.state);
      const claimed = await claim(job);
      if (claimed === undefined) return undefined;
      opened = { claimed, job };
      return { state: transition(job.state, 'spec'), result: undefined };
    },
  }, d);
  return { outcome, ...opened };
}

/** Approve the spec (start the background run) or the final delivery. */
export async function approveJob(target: ActionTarget, d: JobActionDeps): Promise<ActionOutcome> {
  const nothing = 'Nothing to approve';
  if (target.stage === 'awaiting_spec_approval') {
    return decide(target, {
      nothing,
      startsRun: {},
      check: async (job) => {
        await assertOnJobBranch(job.repo, job.state);
        return true;
      },
      apply: async (job) => {
        await readApprovedSpec(job.jobDir);
        await commitAll(job.repo, 'chore: spec approved', await loadSecrets(target.project), { emptyIfNoHead: true });
        await tagHead(job.repo, `anton/${job.jobId}/spec-approved`);
        return { state: transition(job.state, 'plan'), result: undefined };
      },
      after: async (job) => {
        d.spawnRun(target.project, job.jobDir);
        d.out(`Spec approved. ${target.project} is now running in the background.`);
        d.out(`Follow it with: anton logs -f ${target.project}`);
      },
    }, d);
  }
  if (target.stage === 'awaiting_final_review') {
    return decide(target, {
      nothing,
      apply: async (job) => ({ state: transition(job.state, 'done'), result: undefined }),
      after: async (job) => {
        d.out(`${target.project}: delivery approved. Done.`);
        // Switch back first: Retro may wait on the API, and Ctrl-C then must not strand the repo on anton/<id>.
        try {
          await switchBackFromJob(d, job.repo, job.state);
        } finally {
          await submitRetro(job, 'approved', { ...d.retro, out: d.out });
        }
      },
    }, d);
  }
  return decide(target, {
    nothing,
    check: async (job) => {
      d.err(`${nothing} (stage: ${job.state.stage})`);
      return false;
    },
    apply: async () => undefined,
  }, d);
}

/**
 * Send the delivery back to build. The notes become the persisted failure report (R11), which runBuild
 * picks up in fix mode since every task is done. Notes are the owner's review text; callers clean them.
 */
export async function rejectJob(target: ActionTarget, notes: string, d: JobActionDeps): Promise<ActionOutcome> {
  const nothing = 'Nothing to reject';
  return decide(target, {
    nothing,
    // The runner that reached awaiting_final_review may still be stopping its container and
    // releasing the lock; a run spawned now would die with AlreadyRunning in runner.log.
    startsRun: { busyMessage: (pid) => `${target.project}'s previous run (pid ${pid}) is still finishing — try again in a moment.` },
    check: async (job) => {
      if (job.state.stage === 'awaiting_final_review') return true;
      d.err(`${nothing} (stage: ${job.state.stage})`);
      return false;
    },
    apply: async (job) => {
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
      return { state: next, result: n };
    },
    after: async (job, n) => {
      d.spawnRun(target.project, job.jobDir);
      d.out(`Rejected (notes-round-${n}.md). ${target.project} is back in build, running in the background.`);
    },
  }, d);
}

export type ResumeOptions = { budget?: number; acceptAsIs?: boolean };

/** The resumed state, or an error line. Shared by the fast pre-lock check and the recheck under the lock. */
async function planResume(job: LoadedJob, opts: ResumeOptions, d: Pick<JobActionDeps, 'err'>): Promise<JobState | undefined> {
  const project = job.name;
  let state = job.state;
  const paused = state.stage === 'paused';
  if (!paused && !ACTIVE_STAGES.includes(state.stage)) {
    d.err(`Nothing to resume (stage: ${state.stage})`);
    return undefined;
  }
  await assertOnJobBranch(job.repo, job.state);
  state = await seededState(job.repo, job.jobDir, state);
  if (opts.acceptAsIs && !(paused && (state.pausedFrom === 'verify' || state.pausedFrom === 'build'))) {
    d.err(`--accept-as-is only works when paused during build or verify (stage: ${state.stage}${paused ? `, paused from: ${state.pausedFrom}` : ''})`);
    return undefined;
  }
  const { budget } = opts;
  const capRefusal = opts.acceptAsIs ? undefined : await monthlyCapRefusal();
  if (capRefusal) return void d.err(capRefusal);
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
  return decide(target, {
    nothing: `${target.project} changed before the resume`,
    startsRun: {},
    check: async (job) => (await planResume(job, opts, d)) !== undefined,
    apply: async (job) => {
      const state = await planResume(job, opts, d);
      return state && { state, result: state.stage };
    },
    after: async (job, stage) => {
      d.spawnRun(target.project, job.jobDir);
      d.out(`${target.project}: resumed at ${stage}, running in the background. Follow with: anton logs -f ${target.project}`);
    },
  }, d);
}

/** Give up on the current job and stop its container. */
export async function abandonJob(target: ActionTarget, d: JobActionDeps): Promise<ActionOutcome> {
  return decide(target, {
    nothing: `${target.project} changed before the abandon`,
    check: async (job) => (await refuseIfRunning(d, job.repo, target.project)) === 0,
    apply: async (job) => ({ state: transition(job.state, 'abandoned'), result: undefined }),
    after: async (job) => {
      await d.stopContainer(containerName(target.project));
      d.out(`${target.project}: abandoned.`);
      // Change jobs leave the repo on anton/<id>; go back to where the user was, before Retro waits on the API.
      try {
        await switchBackFromJob(d, job.repo, job.state);
      } finally {
        await submitRetro(job, 'abandoned', { ...d.retro, out: d.out });
      }
    },
  }, d);
}

/**
 * Pause the job `anton stop` just killed. The caller has already stopped the run and its container; under the lock
 * this pauses the job as `interrupted` only if it is still the same job and in an active stage (a stage that moved on
 * to a Checkpoint or an end is only reported). A replaced job is left alone.
 */
export async function interruptJob(target: ActionTarget, d: Pick<JobActionDeps, 'out' | 'err' | 'lockWaitMs'>): Promise<ActionOutcome> {
  const p = target.project;
  return decide<{ paused: JobState | undefined; stage: Stage }>(target, {
    nothing: `${p} changed before the stop`,
    staleNote: "The run was stopped, but the job's state was not changed.",
    matchStage: false,
    apply: async (job) => {
      if (!ACTIVE_STAGES.includes(job.state.stage)) return { result: { paused: undefined, stage: job.state.stage } };
      const paused = pause(job.state, 'interrupted');
      return { state: paused, result: { paused, stage: job.state.stage } };
    },
    after: async (_job, { paused, stage }) => {
      if (!paused) {
        d.out(`${p}: stopped (stage: ${stage}).`);
        return;
      }
      await publishJobMilestone(paused, { kind: 'paused', occurrence: `paused-${paused.pauses ?? 0}`, reason: 'interrupted' });
      d.out(`${p}: paused (interrupted) at ${stage}. Continue with: anton resume ${p}`);
    },
  }, d);
}

/** Record an accepted security risk. Allowed while paused or awaiting final review. */
export async function acceptJobRisk(target: ActionTarget, findingId: string, reason: string, d: JobActionDeps): Promise<ActionOutcome> {
  return decide(target, {
    nothing: 'Nothing to accept',
    allowBench: true,
    // The CLI's target carries no revision, so only the job must match; a Slack card also pins its revision.
    matchStage: false,
    check: async (job) => {
      const { stage } = job.state;
      if (stage === 'paused' || stage === 'awaiting_final_review') return true;
      d.err(`Can't accept a risk now (stage: ${stage}). Wait until the job is paused or awaiting final review.`);
      return false;
    },
    apply: async (job) => {
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
      if (!finding) {
        d.err(`Unknown security finding ${findingId}`);
        return undefined;
      }
      await acceptRisk(job.jobDir, finding.id, reason);
      return { result: { finding, stage: job.state.stage } };
    },
    after: async (_job, res) => {
      d.out(`${res.finding.id}: ${res.finding.title} — accepted`);
      if (res.stage === 'awaiting_final_review') {
        d.out('Note: REPORT.md was written before this acceptance; it will show it after the next delivery.');
      }
    },
  }, d);
}
