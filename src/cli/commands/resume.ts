import { loadJob, resumeJob, targetOf } from '../../core/job-actions.js';
import { guard, parseBudget, resolveDeps, type CliDeps } from '../deps.js';

/**
 * `anton resume <project> [--budget <usd>] [--accept-as-is]`: continue a paused job, or an
 * interrupted one (active stage, no live run). `--budget` sets a new total cap.
 */
export async function resumeCommand(
  project: string,
  opts: { budget?: string; acceptAsIs?: boolean },
  deps: CliDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const budget = parseBudget(opts.budget);
    const job = await loadJob(project);
    return (await resumeJob(targetOf(job), { budget, acceptAsIs: opts.acceptAsIs }, d)).code;
  });
}
