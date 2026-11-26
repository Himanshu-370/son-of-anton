import { stopJob, targetOf } from '../../core/job-actions.js';
import { guard, resolveDeps, resolveManualJob, type CliDeps } from '../deps.js';

/** `anton stop <project>`: stop the current run and pause it as interrupted. */
export async function stopCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await resolveManualJob(project);
    return (await stopJob(targetOf(job), { ...d, lockWaitMs: deps.lockWaitMs })).code;
  });
}
