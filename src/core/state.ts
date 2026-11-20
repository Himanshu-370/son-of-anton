import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';

export const STAGES = [
  'spec',
  'awaiting_spec_approval',
  'plan',
  'baseline',
  'build',
  'verify',
  'deliver',
  'awaiting_final_review',
  'paused',
  'done',
  'abandoned',
] as const;
export type Stage = (typeof STAGES)[number];

export const PAUSE_REASONS = ['round_cap', 'budget_cap', 'no_progress', 'error', 'interrupted'] as const;
export type PauseReason = (typeof PAUSE_REASONS)[number];

export const JobStateSchema = z.object({
  jobId: z.string(),
  kind: z.enum(['new', 'change']).default('new'),
  branch: z.string().optional(),
  project: z.string(),
  stage: z.enum(STAGES),
  pausedFrom: z.enum(STAGES).optional(),
  pauseReason: z.enum(PAUSE_REASONS).optional(),
  round: z.number().int().min(0),
  maxRounds: z.number().int().min(1),
  budgetUsd: z.number().min(0),
  spentUsd: z.number().min(0),
  warned80: z.boolean(),
  completedTasks: z.array(z.string()),
  lastFailureSignature: z.string().optional(),
  /** Areas whose fix session finished in the current fix round; reset when verify or reject starts a new round. */
  completedFixAreas: z.array(z.enum(['frontend', 'backend', 'infra'])).optional(),
  /** HEAD at the last verify pass; the next review round diffs from here. */
  reviewedSha: z.string().optional(),
  updatedAt: z.string(),
});
export type JobState = z.infer<typeof JobStateSchema>;

export class InvalidTransition extends Error {
  constructor(
    public readonly from: Stage,
    public readonly to: Stage,
    detail?: string,
  ) {
    super(`Invalid transition ${from} -> ${to}${detail ? `: ${detail}` : ''}`);
    this.name = 'InvalidTransition';
  }
}

/**
 * Allowed edges. `paused` exits are dynamic (see `transition`): back to
 * `pausedFrom`, to `deliver` when pausedFrom is verify/build, or `abandoned`.
 */
const EDGES: Record<Stage, Stage[]> = {
  spec: ['awaiting_spec_approval', 'abandoned'],
  awaiting_spec_approval: ['plan', 'abandoned'],
  plan: ['baseline', 'build', 'paused', 'abandoned'],
  baseline: ['build', 'paused', 'abandoned'],
  build: ['verify', 'paused', 'abandoned'],
  verify: ['build', 'deliver', 'paused', 'abandoned'],
  deliver: ['awaiting_final_review', 'paused', 'abandoned'],
  awaiting_final_review: ['done', 'build', 'abandoned'],
  paused: ['abandoned'],
  done: [],
  abandoned: [],
};

function allowed(s: JobState, to: Stage): boolean {
  if (EDGES[s.stage].includes(to)) return true;
  if (s.stage !== 'paused' || !s.pausedFrom) return false;
  if (to === s.pausedFrom) return true;
  return to === 'deliver' && (s.pausedFrom === 'verify' || s.pausedFrom === 'build');
}

export function transition(s: JobState, to: Stage, extra: Partial<JobState> = {}): JobState {
  if (to === 'paused') throw new InvalidTransition(s.stage, to, 'use pause()');
  if (!allowed(s, to)) throw new InvalidTransition(s.stage, to);
  const next: JobState = { ...s, ...extra, stage: to };
  if (s.stage === 'paused') {
    delete next.pausedFrom;
    delete next.pauseReason;
  }
  return next;
}

export function pause(s: JobState, reason: PauseReason): JobState {
  if (!EDGES[s.stage].includes('paused')) throw new InvalidTransition(s.stage, 'paused');
  return { ...s, stage: 'paused', pausedFrom: s.stage, pauseReason: reason };
}

export function unpause(s: JobState): JobState {
  if (s.stage !== 'paused' || !s.pausedFrom) throw new InvalidTransition(s.stage, 'paused', 'not paused');
  return transition(s, s.pausedFrom);
}

export async function loadState(jobDir: string): Promise<JobState> {
  const raw = await fsp.readFile(join(jobDir, 'state.json'), 'utf8');
  return JobStateSchema.parse(JSON.parse(raw));
}

export async function saveState(jobDir: string, s: JobState): Promise<void> {
  const final = join(jobDir, 'state.json');
  const tmp = `${final}.tmp`;
  const out = JobStateSchema.parse({ ...s, updatedAt: new Date().toISOString() });
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2) + '\n');
  await fsp.rename(tmp, final);
}
