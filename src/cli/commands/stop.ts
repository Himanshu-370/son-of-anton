import { interruptJob } from '../../core/job-actions.js';
import { lockHolder, removeLockIfHeldBy } from '../../core/lock.js';
import { containerName } from '../../pipeline/runner.js';
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
    try {
      return (await interruptJob({ project, jobId: job.jobId, stage: job.state.stage }, { ...d, lockWaitMs: deps.lockWaitMs })).code;
    } catch (e) {
      // The run is already dead, so say what is and is not recorded.
      const why = e instanceof Error ? e.message : String(e);
      d.err(`${project}: the run was stopped, but the pause was not recorded (${why}). Run anton stop ${project} again to record it.`);
      return 1;
    }
  });
}
