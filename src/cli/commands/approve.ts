import { commitAll, tag } from '../../core/git.js';
import { assertOnJobBranch } from '../../core/job.js';
import { loadSecrets } from '../../core/secrets.js';
import { saveState, transition } from '../../core/state.js';
import { submitRetro } from '../../retro/run.js';
import { readApprovedSpec } from '../../stages/spec.js';
import { guard, resolveDeps, resolveJob, type CliDeps } from '../deps.js';
import { preflightOr2, switchBackFromJob } from './shared.js';

/** `anton approve <project>`: approve the spec (start the background run) or the final delivery. */
export async function approveCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await resolveJob(project);
    const { state } = job;
    // The final accept makes no commit, so only spec approval needs the branch.
    if (state.stage === 'awaiting_spec_approval') await assertOnJobBranch(job.repo, state);
    if (state.stage === 'awaiting_spec_approval') {
      const code = await preflightOr2(d);
      if (code !== 0) return code;
      await readApprovedSpec(job.jobDir);
      await commitAll(job.repo, 'chore: spec approved', await loadSecrets(project));
      await tag(job.repo, `anton/${job.jobId}/spec-approved`);
      await saveState(job.jobDir, transition(state, 'plan'));
      d.spawnRun(project, job.jobDir);
      d.out(`Spec approved. ${project} is now running in the background.`);
      d.out(`Follow it with: anton logs -f ${project}`);
      return 0;
    }
    if (state.stage === 'awaiting_final_review') {
      await saveState(job.jobDir, transition(state, 'done'));
      d.out(`${project}: delivery approved. Done.`);
      // Switch back first: Retro may wait on the API, and Ctrl-C then must not strand the repo on anton/<id>.
      try {
        await switchBackFromJob(d, job.repo, state);
      } finally {
        await submitRetro(job, 'approved', { ...d.retro, out: d.out });
      }
      return 0;
    }
    d.err(`Nothing to approve (stage: ${state.stage})`);
    return 1;
  });
}
