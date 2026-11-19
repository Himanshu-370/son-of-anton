import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../core/atomic.js';
import { saveState, transition } from '../../core/state.js';
import { failureReportPath } from '../../stages/verify.js';
import { guard, resolveDeps, resolveJob, UsageError, type CliDeps } from '../deps.js';
import { preflightOr2 } from './shared.js';

/**
 * `anton reject <project> --notes "<text>"`: send the delivery back to build. The notes become
 * the persisted failure report (R11), which runBuild picks up in fix mode since every task is done.
 */
export async function rejectCommand(project: string, opts: { notes: string }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const notes = opts.notes?.trim();
    if (!notes) throw new UsageError('--notes "<text>" is required');
    const job = await resolveJob(project);
    if (job.state.stage !== 'awaiting_final_review') {
      d.err(`Nothing to reject (stage: ${job.state.stage})`);
      return 1;
    }
    const code = await preflightOr2(d);
    if (code !== 0) return code;

    const n = (await readdir(job.jobDir)).filter((f) => /^notes-round-\d+\.md$/.test(f)).length + 1;
    await writeFileAtomic(join(job.jobDir, `notes-round-${n}.md`), `${notes}\n`);
    await writeFileAtomic(
      failureReportPath(job.jobDir),
      `### Rejected at final review\n\nThe reviewer rejected the delivery. Address these notes:\n\n${notes}\n`,
    );
    const next = transition(job.state, 'build', { round: 1 });
    // A fresh review cycle: an old signature must not trigger a false no_progress.
    delete next.lastFailureSignature;
    await saveState(job.jobDir, next);
    d.spawnRun(project, job.jobDir);
    d.out(`Rejected (notes-round-${n}.md). ${project} is back in build, running in the background.`);
    return 0;
  });
}
