import { randomUUID } from 'node:crypto';
import { mkdir, link, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class AlreadyRunning extends Error {
  /** `pid` 0: the lock kept changing hands while we tried (another process is taking it right now). */
  constructor(public readonly pid: number) {
    super(pid > 0
      ? `anton is already running in this repo (pid ${pid})`
      : 'another anton process is taking this lock right now; try again in a moment');
    this.name = 'AlreadyRunning';
  }
}

const lockPath = (repo: string) => join(repo, '.anton', 'run.lock');

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * One read of a lock file decides everything. link() makes the file appear with its full content, so a single
 * read is reliable: absent (released), live or dead holder, or corrupt. `nonce` identifies one acquisition;
 * lock files from older versions have a pid and no nonce.
 */
type LockRead =
  | { kind: 'absent' }
  | { kind: 'live'; pid: number; nonce?: string }
  | { kind: 'dead'; pid: number; nonce?: string }
  | { kind: 'corrupt' };

async function readLock(path: string): Promise<LockRead> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'absent' };
    return { kind: 'corrupt' };
  }
  let body: { pid?: unknown; nonce?: unknown };
  try {
    body = JSON.parse(text);
  } catch {
    return { kind: 'corrupt' };
  }
  const pid = body?.pid;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return { kind: 'corrupt' };
  const nonce = typeof body.nonce === 'string' ? { nonce: body.nonce } : {};
  return { kind: pidAlive(pid as number) ? 'live' : 'dead', pid: pid as number, ...nonce };
}

async function readHolder(path: string): Promise<number | undefined> {
  const r = await readLock(path);
  return r.kind === 'live' || r.kind === 'dead' ? r.pid : undefined;
}

/** The pid recorded in the repo's run lock, alive or not. */
export async function lockHolder(repo: string): Promise<number | undefined> {
  return readHolder(lockPath(repo));
}

/** Remove the run lock only if it still records `pid` (e.g. after that process was killed). */
export async function removeLockIfHeldBy(repo: string, pid: number): Promise<void> {
  if ((await readHolder(lockPath(repo))) === pid) await rm(lockPath(repo), { force: true });
}

export async function isRunning(repo: string): Promise<{ running: boolean; pid?: number }> {
  const r = await readLock(lockPath(repo));
  return r.kind === 'live' ? { running: true, pid: r.pid } : { running: false };
}

const MUTEX_MAX_AGE_MS = 10_000;
/** Attempts while the lock is changing hands (released, or another waiter is taking over a dead lock). */
const HANDOFF_ATTEMPTS = 50;

/** Take the takeover mutex (exclusive link). Returns false if someone else holds it. */
async function takeMutex(mutex: string, src: string): Promise<boolean> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await link(src, mutex);
      return true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = await readHolder(mutex);
      let age = 0;
      try {
        age = Date.now() - (await stat(mutex)).mtimeMs;
      } catch {
        continue; // vanished; retry
      }
      const stale = (pid !== undefined && !pidAlive(pid)) || age > MUTEX_MAX_AGE_MS;
      if (!stale) return false;
      await rm(mutex, { force: true });
    }
  }
  return false;
}

export async function acquireLock(repo: string, filename = 'run.lock'): Promise<() => Promise<void>> {
  await mkdir(join(repo, '.anton'), { recursive: true });
  return acquireLockFile(join(repo, '.anton', filename));
}

const pause = () => new Promise((r) => setTimeout(r, 2 + Math.random() * 8));

/**
 * The same pid lock at an explicit path; its folder must exist. A live holder (this process included) throws
 * AlreadyRunning with its pid. Each acquisition writes its own nonce, and the release removes the file only
 * while it still holds that nonce, so a release never removes another holder's lock, even in this process.
 */
export async function acquireLockFile(path: string): Promise<() => Promise<void>> {
  const mutex = `${path}.takeover`;
  const uniq = `${process.pid}.${randomUUID()}`;
  const tmp = `${path}.${uniq}`;
  const mtmp = `${path}.mtx.${uniq}`;
  const body = JSON.stringify({ pid: process.pid, nonce: uniq, startedAt: new Date().toISOString() });
  try {
    await writeFile(tmp, body);
    for (let attempt = 0; attempt < HANDOFF_ATTEMPTS; attempt++) {
      try {
        // link() fails with EEXIST if the lock exists, and the lock appears with full content.
        await link(tmp, path);
        return release(path, uniq);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
      const seen = await readLock(path);
      if (seen.kind === 'live') throw new AlreadyRunning(seen.pid);
      if (seen.kind === 'absent') continue; // released in between: link again
      // Dead or corrupt: take over under the mutex, so a live lock is never moved or removed.
      await writeFile(mtmp, body);
      if (!(await takeMutex(mutex, mtmp))) {
        await rm(mtmp, { force: true });
        await pause(); // another waiter is taking over; it will hold the lock, or it gave up
        continue;
      }
      try {
        // The last check before removing. A dead or corrupt file cannot change now: its holder is gone, a plain
        // link fails while it exists, and every other takeover needs the mutex we hold.
        const now = await readLock(path);
        if (now.kind === 'live') throw new AlreadyRunning(now.pid);
        if (now.kind !== 'absent') await rm(path, { force: true });
      } finally {
        await rm(mutex, { force: true });
        await rm(mtmp, { force: true });
      }
    }
    throw new AlreadyRunning(0);
  } finally {
    await rm(mtmp, { force: true });
    await rm(tmp, { force: true });
  }
}

function release(path: string, nonce: string): () => Promise<void> {
  return async () => {
    // Only our own acquisition: nobody else can replace it while we hold it (our pid is alive).
    const r = await readLock(path);
    if (r.kind === 'live' && r.nonce === nonce) await rm(path, { force: true });
  };
}

/**
 * Wait up to `waitMs` for a pid lock. Locks are not re-entrant: a second caller in the same process waits too,
 * so concurrent decisions inside `anton serve` serialize like decisions from separate processes.
 */
export async function waitForLockFile(path: string, waitMs = 10_000): Promise<() => Promise<void>> {
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      return await acquireLockFile(path);
    } catch (e) {
      if (!(e instanceof AlreadyRunning) || Date.now() >= deadline) throw e;
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
    }
  }
}
