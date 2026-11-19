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

/** Sorted `id:reason` pairs of the failing checks, joined with `|`. */
export function failureSignature(results: CheckResult[]): string {
  return results
    .filter((r) => r.status === 'fail')
    .map((r) => `${r.id}:${r.reason ?? 'failing'}`)
    .sort()
    .join('|');
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
    state = transition(s, 'deliver');
  } else {
    const signature = failureSignature(results);
    if (s.round >= s.maxRounds) state = pause(s, 'round_cap');
    else if (signature === s.lastFailureSignature) state = pause(s, 'no_progress');
    else state = transition(s, 'build', { round: s.round + 1, lastFailureSignature: signature });
  }
  await saveState(ctx.jobDir, state);
  return { state, passed, results, runOk, failureReport };
}
