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
