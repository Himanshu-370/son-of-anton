import { createHash } from 'node:crypto';
import { prepareSlackArtifact, readCheckedFile } from '../../slack/artifacts.js';
import { loadSlackConfig } from '../../slack/config.js';
import { enqueueMilestone } from '../../slack/outbox.js';
import { guard, resolveDeps, resolveManualJob, type CliDeps } from '../deps.js';

export async function shareScreenshotCommand(project: string, checkId: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    if (!/^AC-[1-9]\d{0,5}$/.test(checkId)) throw new Error('Supply a check ID such as AC-1.');
    const config = await loadSlackConfig();
    if (!config) throw new Error('Run anton slack setup first.');
    const job = await resolveManualJob(project);
    if (job.state.stage !== 'awaiting_final_review' && job.state.stage !== 'done') {
      throw new Error('Share screenshots after the job reaches final review.');
    }
    const source = await readCheckedFile(job.repo, ['.anton', 'jobs', job.jobId, 'evidence', 'screens', `${checkId}.png`], 2 * 1024 * 1024);
    if (!source) throw new Error('The requested screenshot is missing or unsafe to read.');
    const sha256 = createHash('sha256').update(source).digest('hex');
    const artifact = await prepareSlackArtifact(job.jobDir, { kind: 'screenshot', checkId, sha256 });
    if (!artifact) throw new Error('The requested screenshot is not an eligible PNG.');
    await enqueueMilestone({
      scope: 'job', source: 'factory', project: job.name, jobId: job.jobId,
      kind: 'screenshot-ready', occurrence: `${checkId}:${sha256}`, checkId, sha256,
    }, { config });
    d.out(`Queued ${checkId}.png for the private Slack job thread.`);
    return 0;
  });
}
