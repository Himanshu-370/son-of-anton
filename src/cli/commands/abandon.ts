import { abandonJob, loadJob, targetOf } from '../../core/job-actions.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

/** `anton abandon <project>`: give up on the current job and stop its container. */
export async function abandonCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => (await abandonJob(targetOf(await loadJob(project)), d)).code);
}
