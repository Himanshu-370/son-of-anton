import { join } from 'node:path';
import type { StageCtx } from '../agent/host-runner.js';
import { writeFileAtomic } from '../core/atomic.js';
import { saveState, transition, type JobState } from '../core/state.js';
import type { Kit } from '../kits/types.js';
import { scannerRef } from '../security/review.js';
import { runScanners as defaultRunScanners } from '../security/scanners.js';
import type { Plan } from './plan.js';

export type BaselineDeps = { runScanners?: typeof defaultRunScanners };

/** Records the passing tests and scanner findings of the untouched repo, then moves to build (round 1). */
export async function runBaseline(ctx: StageCtx, kit: Kit, plan: Plan, deps: BaselineDeps = {}): Promise<JobState> {
  const { passingTests, ran } = await kit.baseline({ container: ctx.container, jobDir: ctx.jobDir, commands: plan.commands });
  const { findings, unavailable } = await (deps.runScanners ?? defaultRunScanners)(ctx.container);
  await writeFileAtomic(
    join(ctx.jobDir, 'evidence', 'baseline.json'),
    JSON.stringify({ passingTests, ran, scannerRefs: findings.map(scannerRef), unavailable }, null, 2) + '\n',
  );
  const state = transition(ctx.state, 'build', { round: 1 });
  await saveState(ctx.jobDir, state);
  return state;
}
