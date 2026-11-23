import type { JobState } from '../core/state.js';
import { publishMilestone, type Milestone } from './events.js';

type WithoutJobIdentity<T> = T extends unknown ? Omit<T, 'scope' | 'source' | 'project' | 'jobId'> : never;
type JobMilestone = WithoutJobIdentity<Extract<Milestone, { scope: 'job' }>>;

export async function publishJobMilestone(
  state: JobState, milestone: JobMilestone, publish: (event: Milestone) => Promise<void> = publishMilestone,
): Promise<void> {
  if (state.bench !== undefined) return;
  try {
    await publish({ ...milestone, scope: 'job', source: 'factory', project: state.project, jobId: state.jobId });
  } catch {
    // Milestone delivery is optional. Local state remains authoritative.
  }
}
