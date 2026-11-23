import { saveState, transition } from '../../core/state.js';
import { containerName } from '../../pipeline/runner.js';
import { submitRetro } from '../../retro/run.js';
import { guard, resolveDeps, resolveManualJob, type CliDeps } from '../deps.js';
import { refuseIfRunning, switchBackFromJob } from './shared.js';

/** `anton abandon <project>`: give up on the current job and stop its container. */
export async function abandonCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await resolveManualJob(project);
    if ((await refuseIfRunning(d, job.repo, project)) !== 0) return 1;
    await saveState(job.jobDir, transition(job.state, 'abandoned'));
    await d.stopContainer(containerName(project));
    d.out(`${project}: abandoned.`);
    // Change jobs leave the repo on anton/<id>; go back to where the user was, before Retro waits on the API.
    try {
      await switchBackFromJob(d, job.repo, job.state);
    } finally {
      await submitRetro(job, 'abandoned', { ...d.retro, out: d.out });
    }
    return 0;
  });
}
