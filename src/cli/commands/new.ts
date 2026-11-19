import { join } from 'node:path';
import { commitAll } from '../../core/git.js';
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
    // commitAll excludes .anton/ via .git/info/exclude before staging.
    await commitAll(p.repoPath, 'chore: initialize project');
    d.out(`Created project ${p.name} at ${p.repoPath}`);

    const container = await d.startContainer(p.name, p.repoPath, image);
    const hint = `anton abandon ${p.name}, then run anton new again.`;
    // Ctrl-C during the interactive spec stage would otherwise leave the container running.
    let interrupted = false;
    const removeSigint = d.onSigint(async () => {
      if (interrupted) return d.exit(130); // second Ctrl-C: don't wait for the stop
      interrupted = true;
      try {
        await d.stopContainer(container);
      } catch {
        // best effort; abandon also stops it
      }
      d.err(`\nInterrupted. Clean up with: ${hint}`);
      d.exit(130);
    });
    try {
      const state = await loadState(p.jobDir);
      const ctx = { project: p.name, repo: p.repoPath, container, jobDir: p.jobDir, state, stage: 'spec' };
      const r = await d.runSpec(ctx, description, d.ask);
      await writeSpec(p.jobDir, r.spec);
      await saveState(p.jobDir, transition(r.state, 'awaiting_spec_approval'));
    } catch (e) {
      // `spec` has no paused edge, so the job can't be resumed: point at abandon + a fresh new.
      const msg = e instanceof Error ? e.message : String(e);
      d.err(`Spec stage failed: ${msg}. Clean up with: ${hint}`);
      return 1;
    } finally {
      removeSigint();
      await d.stopContainer(container);
    }

    d.out('');
    d.out(`Spec written: ${join(p.jobDir, 'spec.md')}`);
    d.out(`Edit the title and acceptance checks in spec.md if you like, then run: anton approve ${p.name}`);
    d.out('(Other sections of spec.md are informational; the remaining structured fields come from spec.json.)');
    return 0;
  });
}
