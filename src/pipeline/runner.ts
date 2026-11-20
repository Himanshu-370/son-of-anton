import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { BudgetExceeded, type StageCtx } from '../agent/host-runner.js';
import { defaultExec, type ExecFn } from '../core/exec.js';
import { assertOnJobBranch, currentJobId } from '../core/job.js';
import { acquireLock as defaultAcquireLock } from '../core/lock.js';
import { notify as defaultNotify } from '../core/notify.js';
import { jobDir as jobDirOf } from '../core/paths.js';
import { getProject } from '../core/registry.js';
import { loadSecrets, redact, secretsEnvFile } from '../core/secrets.js';
import { loadState, pause, saveState, transition, type JobState, type PauseReason } from '../core/state.js';
import {
  ensureImage,
  startContainer as dockerStartContainer,
  stopContainer as dockerStopContainer,
} from '../docker/container.js';
import { kitByName } from '../kits/index.js';
import type { Kit } from '../kits/types.js';
import { runBaseline as defaultRunBaseline } from '../stages/baseline.js';
import { runBuild as defaultRunBuild } from '../stages/build.js';
import { runDeliver as defaultRunDeliver, type DeliverInput } from '../stages/deliver.js';
import { failuresPath } from '../stages/qa.js';
import { PlanSchema, runPlan as defaultRunPlan, type Plan } from '../stages/plan.js';
import { SpecDocBaseSchema, type SpecDoc } from '../stages/spec.js';
import { runVerify as defaultRunVerify, type VerifyDeps, type VerifyResult } from '../stages/verify.js';

export const containerName = (slug: string) => `anton-${slug}`;

/** Stages the runner drives on its own; anything else is a waiting/paused/terminal stage. */
export const ACTIVE_STAGES: readonly JobState['stage'][] = ['plan', 'baseline', 'build', 'verify', 'deliver'];

export type RunnerDeps = {
  acquireLock?: (repo: string) => Promise<() => Promise<void>>;
  /** Start (or reuse) the job's container on the kit's image; returns its name. */
  startContainer?: (slug: string, repo: string, kit: Kit) => Promise<string>;
  stopContainer?: (name: string) => Promise<void>;
  notify?: (title: string, message: string) => Promise<void>;
  /** Overrides the approved spec's kit (tests). */
  kit?: Kit;
  runPlan?: (ctx: StageCtx, spec: SpecDoc) => Promise<{ plan: Plan; state: JobState }>;
  runBaseline?: (ctx: StageCtx, kit: Kit, plan: Plan) => Promise<JobState>;
  runBuild?: (ctx: StageCtx, spec: SpecDoc, plan: Plan) => Promise<JobState>;
  runVerify?: (ctx: StageCtx, kit: Kit, spec: SpecDoc, plan: Plan, deps?: VerifyDeps) => Promise<VerifyResult>;
  /** Injectable reviewers and git lookups, forwarded to runVerify. */
  verifyDeps?: VerifyDeps;
  runDeliver?: (ctx: StageCtx, spec: SpecDoc, plan: Plan, input: DeliverInput) => Promise<JobState>;
  log?: (line: string) => void;
  currentBranch?: (repo: string) => Promise<string>;
};

/**
 * Reuse a running `anton-<slug>` container when it runs the kit's image; otherwise start a fresh one
 * (startContainer removes the old one first, e.g. a spec-session container on the fallback image).
 */
export async function startOrReuseContainer(
  slug: string,
  repo: string,
  kit: Kit,
  exec: ExecFn = defaultExec,
  ensure: (kit: Kit, exec: ExecFn) => Promise<string> = ensureImage,
): Promise<string> {
  // Validate secrets before any docker call or API spend.
  const envFile = await secretsEnvFile(slug);
  const name = containerName(slug);
  const image = await ensure(kit, exec);
  const r = await exec('docker', ['inspect', '-f', '{{.State.Running}}', name]);
  if (r.exitCode === 0 && r.stdout.trim() === 'true') {
    const img = await exec('docker', ['inspect', '-f', '{{.Config.Image}}', name]);
    if (img.exitCode === 0 && img.stdout.trim() === image) return name;
  }
  return dockerStartContainer(slug, repo, image, exec, { envFile });
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await fsp.readFile(path, 'utf8'));
}

/** Which kinds of blockers the latest failures.json holds. Missing or corrupt means none. */
async function failureKinds(jobDir: string): Promise<{ security: boolean; other: boolean }> {
  try {
    const items: unknown = JSON.parse(await fsp.readFile(failuresPath(jobDir), 'utf8'));
    if (!Array.isArray(items)) return { security: false, other: false };
    const kinds = items.map((i) => (i as { kind?: unknown } | null)?.kind);
    return { security: kinds.includes('security'), other: kinds.some((k) => k !== 'security') };
  } catch {
    return { security: false, other: false };
  }
}

function pauseMessage(
  project: string,
  reason: PauseReason | undefined,
  kinds: { security: boolean; other: boolean } = { security: false, other: false },
): string {
  const risk = kinds.security
    ? ` Security findings can be accepted with: anton accept-risk ${project} <id> --reason "<text>", then: anton resume ${project} (re-verifies; the reviewers run again).` +
      ` Or: anton resume ${project} --accept-as-is delivers now and ships any other blockers too.` +
      (kinds.other ? ' Other blockers remain, so accepting risks alone will not pass verify.' : '')
    : '';
  switch (reason) {
    case 'budget_cap':
      return `${project}: paused, budget cap reached. Resume with: anton resume ${project} --budget <usd>`;
    case 'round_cap':
      return `${project}: paused, round cap reached. Run: anton resume ${project} --accept-as-is (or abandon).${risk}`;
    case 'no_progress':
      return `${project}: paused, no progress between rounds. See the failure report.${risk}`;
    case 'error':
      return `${project}: paused on an error. See logs/error.log, then: anton resume ${project}`;
    default:
      return `${project}: paused (${reason ?? 'unknown'})`;
  }
}

/**
 * Background pipeline: loops on state.stage through plan → (baseline →) build ⇄ verify → deliver until a
 * waiting/paused stage. Stages persist and transition themselves (build→verify, verify→…,
 * deliver→awaiting_final_review); the runner only transitions plan→build (round 1, R1) or plan→baseline (change jobs; baseline then goes to build).
 * Build fix rounds read the persisted evidence/failure-report.md (R11); no report is passed in.
 */
export async function runUnattended(project: string, deps: RunnerDeps = {}): Promise<void> {
  let secrets: Record<string, string> = {};
  const rawLog = deps.log ?? ((l: string) => console.log(`[${new Date().toISOString()}] ${l}`));
  /** Every runner log line (it lands in logs/runner.log) is redacted with the secrets loaded so far. */
  const log = (l: string): void => rawLog(redact(l, secrets));
  const rawNotify = deps.notify ?? ((t: string, m: string) => defaultNotify(t, m));
  /** Notifications are best-effort: a failure must never turn into a run error. */
  const notify = async (t: string, m: string): Promise<void> => {
    try {
      await rawNotify(t, m);
    } catch (e) {
      log(`notify failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const stopContainer = deps.stopContainer ?? ((n: string) => dockerStopContainer(n));
  const startContainer = deps.startContainer ?? ((s: string, r: string, k: Kit) => startOrReuseContainer(s, r, k));
  const runPlan = deps.runPlan ?? defaultRunPlan;
  const runBaseline = deps.runBaseline ?? defaultRunBaseline;
  const runBuild = deps.runBuild ?? defaultRunBuild;
  const runVerify = deps.runVerify ?? defaultRunVerify;
  const runDeliver = deps.runDeliver ?? defaultRunDeliver;

  const { repoPath: repo } = await getProject(project);
  const jobDir = jobDirOf(repo, await currentJobId(repo));
  const release = await (deps.acquireLock ?? defaultAcquireLock)(repo);
  let startedContainer = false;
  /**
   * The end-of-run notification is sent only after the container is stopped and the lock released,
   * so a user acting on it (reject/resume) doesn't race this runner's shutdown.
   */
  let final: string | undefined;
  try {
    let state = await loadState(jobDir);
    if (!ACTIVE_STAGES.includes(state.stage)) {
      log(`nothing to run (stage: ${state.stage})`);
      return;
    }
    try {
      await assertOnJobBranch(repo, state, deps.currentBranch);
      let spec: SpecDoc | undefined;
      let plan: Plan | undefined;
      const getSpec = async () => (spec ??= SpecDocBaseSchema.parse(await readJson(join(jobDir, 'spec.approved.json'))));
      const kit = deps.kit ?? kitByName((await getSpec()).kit);
      startedContainer = true;
      const container = await startContainer(project, repo, kit);
      secrets = await loadSecrets(project);
      const getPlan = async () => (plan ??= PlanSchema.parse(await readJson(join(jobDir, 'plan.json'))));
      const ctx = (stage: string): StageCtx => ({ project, repo, container, jobDir, state, stage, secrets });
      let lastVerify: DeliverInput;

      while (ACTIVE_STAGES.includes(state.stage)) {
        log(`stage: ${state.stage} (round ${state.round})`);
        switch (state.stage) {
          case 'plan': {
            const r = await runPlan(ctx('plan'), await getSpec());
            plan = r.plan;
            // Change jobs record a baseline first; it moves the job to build (round 1).
            state = r.state.kind === 'change' ? transition(r.state, 'baseline') : transition(r.state, 'build', { round: 1 });
            await saveState(jobDir, state);
            break;
          }
          case 'baseline':
            state = await runBaseline(ctx('baseline'), kit, await getPlan());
            break;
          case 'build':
            state = await runBuild(ctx('build'), await getSpec(), await getPlan());
            break;
          case 'verify': {
            const r = await runVerify(ctx('verify'), kit, await getSpec(), await getPlan(), deps.verifyDeps);
            lastVerify = { results: r.results, runOk: r.runOk };
            state = r.state;
            break;
          }
          case 'deliver':
            state = await runDeliver(ctx('deliver'), await getSpec(), await getPlan(), lastVerify);
            break;
        }
      }
      log(`stopped at stage: ${state.stage}`);
      if (state.stage === 'paused') final = pauseMessage(project, state.pauseReason, await failureKinds(jobDir));
      else if (state.stage === 'awaiting_final_review') {
        final = `${project}: ready for review. See REPORT.md, then: anton approve ${project}`;
      }
    } catch (e) {
      const reason: PauseReason = e instanceof BudgetExceeded ? 'budget_cap' : 'error';
      const msg = e instanceof Error ? (e.stack ?? e.message) : String(e);
      log(`${reason}: ${e instanceof Error ? e.message : String(e)}`);
      if (reason === 'error') {
        await fsp.mkdir(join(jobDir, 'logs'), { recursive: true });
        await fsp.appendFile(join(jobDir, 'logs', 'error.log'), redact(`[${new Date().toISOString()}] ${msg}\n`, secrets));
      }
      // Stages persist cost as they go; pause from the latest saved state.
      const latest = await loadState(jobDir);
      if (ACTIVE_STAGES.includes(latest.stage)) {
        await saveState(jobDir, pause(latest, reason));
        final = pauseMessage(project, reason);
      }
    }
  } finally {
    try {
      if (startedContainer) await stopContainer(containerName(project));
    } finally {
      try {
        await release();
      } finally {
        if (final) await notify('Son of Anton', final);
      }
    }
  }
}
