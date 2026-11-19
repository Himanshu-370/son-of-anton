import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { StageCtx } from '../agent/host-runner.js';
import { writeFileAtomic } from '../core/atomic.js';
import { pause, saveState, transition, type JobState } from '../core/state.js';
import type { CheckResult, Kit } from '../kits/types.js';
import type { Plan } from './plan.js';
import type { SpecDoc } from './spec.js';

export type VerifyResult = {
  state: JobState;
  passed: boolean;
  results: CheckResult[];
  runOk: boolean;
  failureReport: string;
};

/** Persisted failure report, so a crashed fix round can resume (R11). */
export function failureReportPath(jobDir: string): string {
  return join(jobDir, 'evidence', 'failure-report.md');
}

/** Sorted `id:reason` pairs of the failing checks, plus `run:failed` when the smoke run failed, joined with `|`. */
export function failureSignature(results: CheckResult[], runOk: boolean): string {
  const parts = results.filter((r) => r.status === 'fail').map((r) => `${r.id}:${r.reason ?? 'failing'}`);
  if (!runOk) parts.push('run:failed');
  return parts.sort().join('|');
}

/** Code-only stage: run the kit, record evidence, then decide deliver / build / pause (ruling R1). */
export async function runVerify(ctx: StageCtx, kit: Kit, spec: SpecDoc, plan: Plan): Promise<VerifyResult> {
  const { results, runOk, failureReport } = await kit.verify({
    container: ctx.container,
    jobDir: ctx.jobDir,
    checks: spec.acceptanceChecks,
    commands: plan.commands,
  });
  const s = ctx.state;
  await writeFileAtomic(
    join(ctx.jobDir, 'evidence', 'results.json'),
    JSON.stringify({ round: s.round, results, runOk }, null, 2) + '\n',
  );

  const passed = runOk && results.every((r) => r.status === 'pass');
  let state: JobState;
  if (passed) {
    await rm(failureReportPath(ctx.jobDir), { force: true });
    state = transition(s, 'deliver');
  } else {
    await writeFileAtomic(failureReportPath(ctx.jobDir), failureReport);
    const signature = failureSignature(results, runOk);
    if (s.round >= s.maxRounds) state = pause(s, 'round_cap');
    else if (signature === s.lastFailureSignature) state = pause(s, 'no_progress');
    else state = transition(s, 'build', { round: s.round + 1, lastFailureSignature: signature });
  }
  await saveState(ctx.jobDir, state);
  return { state, passed, results, runOk, failureReport };
}
