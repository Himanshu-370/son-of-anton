import { createChangeJob } from '../../core/job.js';
import { guard, parseBudget, resolveDeps, type CliDeps } from '../deps.js';
import { runSpecSession } from '../spec-session.js';
import { preflightOr2 } from './shared.js';

/** `anton change <project> "<desc>" [--budget <usd>]`: branch the project and run the spec loop for a change. */
export async function changeCommand(project: string, description: string, opts: { budget?: string }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const budgetUsd = parseBudget(opts.budget);
    const code = await preflightOr2(d);
    if (code !== 0) return code;
    const image = await d.ensureImage();
    // Throws UnknownProject / JobActive / NoCommits / DirtyRepo; guard prints the message and exits 1.
    const p = await createChangeJob(project, description, budgetUsd === undefined ? {} : { budgetUsd });
    d.out(`Started change ${p.jobId} on branch ${p.branch}`);
    return runSpecSession(d, { ...p, description, image }, 'change');
  });
}
