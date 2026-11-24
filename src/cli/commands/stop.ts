import { publishJobMilestone } from '../../slack/job-milestones.js';
import { lockHolder, removeLockIfHeldBy } from '../../core/lock.js';
import { loadState, pause, saveState } from '../../core/state.js';
import { ACTIVE_STAGES, containerName } from '../../pipeline/runner.js';
import { guard, resolveDeps, resolveManualJob, type CliDeps, type Resolved } from '../deps.js';

const GRACE_MS = 10_000;
const POLL_MS = 250;
/** How long to wait for the process to vanish after SIGKILL. */
const KILL_WAIT_MS = 2_000;

function alive(d: Resolved, pid: number): boolean {
  try {
    d.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** `anton stop <project>`: SIGTERM the run, SIGKILL after 10s, remove the container, pause as interrupted. */
export async function stopCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await resolveManualJob(project);
    const pid = await lockHolder(job.repo);
    if (pid !== undefined && alive(d, pid)) {
      d.out(`Stopping ${project} (pid ${pid})…`);
      d.kill(pid, 'SIGTERM');
      let waited = 0;
      while (waited < GRACE_MS && alive(d, pid)) {
        await d.sleep(POLL_MS);
        waited += POLL_MS;
      }
      if (alive(d, pid)) {
        d.out('Still running after 10s; sending SIGKILL.');
        try {
          d.kill(pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
        let killWait = 0;
        while (killWait < KILL_WAIT_MS && alive(d, pid)) {
          await d.sleep(POLL_MS);
          killWait += POLL_MS;
        }
      }
    } else {
      d.out(`${project} has no running process.`);
    }
    // The runner dies without its finally, so clear its lock once the pid is confirmed dead.
    if (pid !== undefined) {
      if (alive(d, pid)) d.err(`pid ${pid} is still alive; leaving the run lock in place.`);
      else await removeLockIfHeldBy(job.repo, pid);
    }
    await d.stopContainer(containerName(project));
    const state = await loadState(job.jobDir);
    if (ACTIVE_STAGES.includes(state.stage)) {
      const paused = pause(state, 'interrupted');
      await saveState(job.jobDir, paused);
      await publishJobMilestone(paused, { kind: 'paused', occurrence: `paused-${paused.pauses ?? 0}`, reason: 'interrupted' });
      d.out(`${project}: paused (interrupted) at ${state.stage}. Continue with: anton resume ${project}`);
    } else {
      d.out(`${project}: stopped (stage: ${state.stage}).`);
    }
    return 0;
  });
}
