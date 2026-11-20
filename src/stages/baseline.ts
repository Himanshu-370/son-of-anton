import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import type { StageCtx } from '../agent/host-runner.js';
import { writeFileAtomic } from '../core/atomic.js';
import { redact } from '../core/secrets.js';
import { isClean as defaultIsClean, resetWorktree as defaultResetWorktree } from '../core/git.js';
import { saveState, transition, type JobState } from '../core/state.js';
import type { Kit } from '../kits/types.js';
import { scannerRef } from '../security/review.js';
import { runScanners as defaultRunScanners } from '../security/scanners.js';
import type { Plan } from './plan.js';

export type BaselineDeps = { runScanners?: typeof defaultRunScanners; resetWorktree?: (repo: string) => Promise<void>; isClean?: (repo: string) => Promise<boolean> };

/** Records the passing tests and scanner findings of the untouched repo, then moves to build (round 1). */
export async function runBaseline(ctx: StageCtx, kit: Kit, plan: Plan, deps: BaselineDeps = {}): Promise<JobState> {
  // Install and tests dirty the tree and the reset below discards it, so never start from uncommitted work.
  if (!(await (deps.isClean ?? defaultIsClean)(ctx.repo))) {
    throw new Error('The working tree has uncommitted changes, so the baseline cannot run safely. Commit or stash them, then resume.');
  }
  try {
    const { passingTests, ran } = await kit.baseline({ container: ctx.container, jobDir: ctx.jobDir, commands: plan.commands, secrets: ctx.secrets });
    const { findings, unavailable } = await (deps.runScanners ?? defaultRunScanners)(ctx.container);
    await writeFileAtomic(
      join(ctx.jobDir, 'evidence', 'baseline.json'),
      redact(JSON.stringify({ passingTests, ran, scannerRefs: findings.map(scannerRef), unavailable }, null, 2) + '\n', ctx.secrets),
    );
  } finally {
    // Install and tests dirty the change branch; keep that out of T1's commit.
    await (deps.resetWorktree ?? defaultResetWorktree)(ctx.repo);
  }
  const state = transition(ctx.state, 'build', { round: 1 });
  await saveState(ctx.jobDir, state);
  return state;
}

export const BaselineSchema = z.object({
  passingTests: z.array(z.string()),
  ran: z.boolean(),
  scannerRefs: z.array(z.string()),
  unavailable: z.array(z.string()),
});
export type Baseline = z.infer<typeof BaselineSchema>;

/** The job's baseline, or null when absent (new job), unreadable or invalid: verify then skips regression logic. */
export async function loadBaseline(jobDir: string): Promise<Baseline | null> {
  try {
    return BaselineSchema.parse(JSON.parse(await readFile(join(jobDir, 'evidence', 'baseline.json'), 'utf8')));
  } catch {
    return null;
  }
}
