import { join } from 'node:path';
import { commitAll, ensureAntonIgnored } from '../../core/git.js';
import { createNewProject } from '../../core/job.js';
import { loadState, saveState, transition } from '../../core/state.js';
import { writeSpec } from '../../stages/spec.js';
import { guard, parseBudget, resolveDeps, type CliDeps } from '../deps.js';
import { preflightOr2 } from './shared.js';

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
    await ensureAntonIgnored(p.repoPath);
    await commitAll(p.repoPath, 'chore: initialize project');
    d.out(`Created project ${p.name} at ${p.repoPath}`);

    const container = await d.startContainer(p.name, p.repoPath, image);
    try {
      const state = await loadState(p.jobDir);
      const ctx = { project: p.name, repo: p.repoPath, container, jobDir: p.jobDir, state, stage: 'spec' };
      const r = await d.runSpec(ctx, description, d.ask);
      await writeSpec(p.jobDir, r.spec);
      await saveState(p.jobDir, transition(r.state, 'awaiting_spec_approval'));
    } finally {
      await d.stopContainer(container);
    }

    d.out('');
    d.out(`Spec written: ${join(p.jobDir, 'spec.md')}`);
    d.out(`Edit the title and acceptance checks in spec.md if you like, then run: anton approve ${p.name}`);
    d.out('(Other sections of spec.md are informational; the remaining structured fields come from spec.json.)');
    return 0;
  });
}
