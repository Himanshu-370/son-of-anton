import { isClean, switchBranch } from '../../core/git.js';
import { saveState, transition } from '../../core/state.js';
import { containerName } from '../../pipeline/runner.js';
import { guard, resolveDeps, resolveJob, type CliDeps } from '../deps.js';
import { refuseIfRunning } from './shared.js';

/** `anton abandon <project>`: give up on the current job and stop its container. */
export async function abandonCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await resolveJob(project);
    if ((await refuseIfRunning(d, job.repo, project)) !== 0) return 1;
    await saveState(job.jobDir, transition(job.state, 'abandoned'));
    await d.stopContainer(containerName(project));
    d.out(`${project}: abandoned.`);
    // Change jobs leave the repo on anton/<id>; go back to where the user was. The job branch is kept.
    const from = job.state.fromBranch;
    if (job.state.kind === 'change' && from) {
      const back = await isClean(job.repo).then((clean) => clean && switchBranch(job.repo, from).then(() => true), () => false);
      d.out(back ? `Switched back to ${from}. Branch ${job.state.branch} is kept.` : `Repo not switched back. To return: git switch ${from}`);
    }
    return 0;
  });
}
