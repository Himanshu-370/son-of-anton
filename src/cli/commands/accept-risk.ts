import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { acceptRisk } from '../../security/risks.js';
import type { SecurityFinding } from '../../security/review.js';
import { guard, resolveDeps, resolveJob, UsageError, type CliDeps } from '../deps.js';

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
    const job = await resolveJob(project);
    const { stage } = job.state;
    if (stage !== 'paused' && stage !== 'awaiting_final_review') {
      throw new UsageError(`Can't accept a risk now (stage: ${stage}). Wait until the job is paused or awaiting final review.`);
    }
    let findings: SecurityFinding[] = [];
    try {
      const raw = JSON.parse(await fsp.readFile(join(job.jobDir, 'evidence', 'results.json'), 'utf8')) as {
        security?: { findings?: SecurityFinding[] };
      };
      findings = raw.security?.findings ?? [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const finding = findingId.startsWith('SEC-') ? findings.find((f) => f.id === findingId) : undefined;
    if (!finding) throw new UsageError(`Unknown security finding ${findingId}`);
    await acceptRisk(job.jobDir, finding.id, reason);
    d.out(`${finding.id}: ${finding.title} — accepted`);
    if (stage === 'awaiting_final_review') {
      d.out('Note: REPORT.md was written before this acceptance; it will show it after the next delivery.');
    }
    return 0;
  });
}
