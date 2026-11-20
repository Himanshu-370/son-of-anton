import { currentBranch, isClean, switchBranch } from '../../core/git.js';
import type { JobState } from '../../core/state.js';
import { isRunning } from '../../core/lock.js';
import { PreflightError } from '../../docker/container.js';
import type { Resolved } from '../deps.js';

/** Runs preflight; prints the message and returns 2 on a PreflightError, 0 when ready. */
export async function preflightOr2(d: Resolved): Promise<number> {
  try {
    await d.preflight();
    return 0;
  } catch (e) {
    if (!(e instanceof PreflightError)) throw e;
    d.err(e.message);
    return 2;
  }
}

/**
 * Prints an error and returns 1 when a background run already holds the project's lock.
 * `message` overrides the default text (e.g. when the run is known to be shutting down).
 */
export async function refuseIfRunning(
  d: Resolved,
  repo: string,
  project: string,
  message?: (pid: number | undefined) => string,
): Promise<number> {
  const r = await isRunning(repo);
  if (!r.running) return 0;
  d.err(message ? message(r.pid) : `${project} is already running (pid ${r.pid}). Stop it first with: anton stop ${project}`);
  return 1;
}

/**
 * After a change job ends, return the repo to the branch it started from. Only when HEAD is still on the
 * job branch (never move the user off a branch anton does not own) and the tree is clean; otherwise
 * print the `git switch` command. The job branch is kept.
 */
export async function switchBackFromJob(d: Resolved, repo: string, state: JobState): Promise<void> {
  const from = state.fromBranch;
  if (state.kind !== 'change' || !from || (await currentBranch(repo).catch(() => '')) !== state.branch) return;
  const back = await isClean(repo)
    .then((clean) => clean && switchBranch(repo, from).then(() => true))
    .catch(() => false);
  d.out(back ? `Switched back to ${from}. Branch ${state.branch} is kept.` : `Repo not switched back. To return: git switch ${from}`);
}
