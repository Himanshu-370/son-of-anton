import { approveJob, loadJob, targetOf } from '../../core/job-actions.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

/** `anton approve <project>`: approve the spec (start the background run) or the final delivery. */
export async function approveCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => (await approveJob(targetOf(await loadJob(project)), d)).code);
}
