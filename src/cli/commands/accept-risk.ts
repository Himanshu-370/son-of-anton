import { acceptJobRisk, loadJob, targetOf } from '../../core/job-actions.js';
import { guard, resolveDeps, UsageError, type CliDeps } from '../deps.js';

/** `anton accept-risk <project> <findingId> --reason "<text>"`: record an accepted security risk. */
export async function acceptRiskCommand(
  project: string,
  findingId: string,
  opts: { reason?: string },
  deps: CliDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const reason = opts.reason?.trim();
    if (!reason) throw new UsageError('--reason is required and must not be blank');
    const job = await loadJob(project, { allowBench: true });
    return (await acceptJobRisk(targetOf(job), findingId, reason, d)).code;
  });
}
