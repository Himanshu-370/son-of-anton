import { commitAll } from '../../core/git.js';
import { createNewProject } from '../../core/job.js';
import { guard, parseBudget, resolveDeps, type CliDeps } from '../deps.js';
import { runSpecSession } from '../spec-session.js';
import { preflightOr2 } from '../../core/job-actions.js';

/** `anton new "<desc>" [--budget <usd>]`: create the project and run the spec loop in the foreground. */
export async function newCommand(description: string, opts: { budget?: string }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const budgetUsd = parseBudget(opts.budget);
    const code = await preflightOr2(d);
    if (code !== 0) return code;
    // Before creating anything, so a missing image leaves no half-made project.
    const image = await d.ensureImage();

    const p = await createNewProject(description, budgetUsd === undefined ? {} : { budgetUsd });
    // commitAll excludes .anton/ via .git/info/exclude before staging.
    await commitAll(p.repoPath, 'chore: initialize project');
    d.out(`Created project ${p.name} at ${p.repoPath}`);

    return runSpecSession(d, { ...p, description, image }, 'new');
  });
}
