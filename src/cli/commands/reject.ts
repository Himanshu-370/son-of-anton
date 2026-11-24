import { loadJob, rejectJob, targetOf } from '../../core/job-actions.js';
import { guard, resolveDeps, UsageError, type CliDeps } from '../deps.js';

/**
 * `anton reject <project> --notes "<text>"`: send the delivery back to build. The notes become
 * the persisted failure report (R11), which runBuild picks up in fix mode since every task is done.
 */
export async function rejectCommand(project: string, opts: { notes: string }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const notes = opts.notes?.trim();
    if (!notes) throw new UsageError('--notes "<text>" is required');
    return (await rejectJob(targetOf(await loadJob(project)), notes, d)).code;
  });
}
