import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFileAtomic } from '../../core/atomic.js';
import { saveState, transition } from '../../core/state.js';
import { AREA_ORDER } from '../../core/config.js';
import { PlanSchema, type Plan } from '../../stages/plan.js';
import { failuresPath, type FailureItem } from '../../stages/qa.js';
import { failureReportPath } from '../../stages/verify.js';
import { guard, resolveDeps, resolveManualJob, UsageError, type CliDeps } from '../deps.js';
import { preflightOr2, refuseIfRunning } from './shared.js';

/**
 * `anton reject <project> --notes "<text>"`: send the delivery back to build. The notes become
 * the persisted failure report (R11), which runBuild picks up in fix mode since every task is done.
 */
export async function rejectCommand(project: string, opts: { notes: string }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const notes = opts.notes?.trim();
    if (!notes) throw new UsageError('--notes "<text>" is required');
    const job = await resolveManualJob(project);
    if (job.state.stage !== 'awaiting_final_review') {
      d.err(`Nothing to reject (stage: ${job.state.stage})`);
      return 1;
    }
    // The runner that reached awaiting_final_review may still be stopping its container and
    // releasing the lock; a run spawned now would die with AlreadyRunning in runner.log.
    const busy = await refuseIfRunning(d, job.repo, project, (pid) =>
      `${project}'s previous run (pid ${pid}) is still finishing — try again in a moment.`,
    );
    if (busy !== 0) return 1;
    const code = await preflightOr2(d);
    if (code !== 0) return code;

    const n = (await readdir(job.jobDir)).filter((f) => /^notes-round-\d+\.md$/.test(f)).length + 1;
    await writeFileAtomic(join(job.jobDir, `notes-round-${n}.md`), `${notes}\n`);
    await writeFileAtomic(
      failureReportPath(job.jobDir),
      `### Rejected at final review\n\nThe reviewer rejected the delivery. Address these notes:\n\n${notes}\n`,
    );
    // Fan the notes out to every area in the plan (one review item each); without a readable plan the
    // markdown report above is all there is, and build routes it to every area (P2-R1).
    let plan: Plan | undefined;
    try {
      plan = PlanSchema.parse(JSON.parse(await readFile(join(job.jobDir, 'plan.json'), 'utf8')));
    } catch {
      plan = undefined;
    }
    if (plan) {
      const p = plan;
      const items: FailureItem[] = AREA_ORDER.filter((a) => p.tasks.some((t) => t.area === a)).map((area) => ({
        area,
        kind: 'review',
        id: `NOTES-${n}`,
        text: notes,
      }));
      await writeFileAtomic(failuresPath(job.jobDir), JSON.stringify(items, null, 2) + '\n');
    }
    const next = transition(job.state, 'build', { round: 1, completedFixAreas: [], rejects: (job.state.rejects ?? 0) + 1 });
    // A fresh review cycle: an old signature must not trigger a false no_progress.
    delete next.lastFailureSignature;
    await saveState(job.jobDir, next);
    d.spawnRun(project, job.jobDir);
    d.out(`Rejected (notes-round-${n}.md). ${project} is back in build, running in the background.`);
    return 0;
  });
}
