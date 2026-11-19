import { mkdir, link, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class AlreadyRunning extends Error {
  constructor(public readonly pid: number) {
    super(`anton is already running in this repo (pid ${pid})`);
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

async function readHolder(path: string): Promise<number | undefined> {
  try {
    const pid = JSON.parse(await readFile(path, 'utf8')).pid;
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
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
  const pid = await readHolder(lockPath(repo));
  return pid !== undefined && pidAlive(pid) ? { running: true, pid } : { running: false };
}

const MUTEX_MAX_AGE_MS = 10_000;

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

export async function acquireLock(repo: string): Promise<() => Promise<void>> {
  const path = lockPath(repo);
  const mutex = `${path}.takeover`;
  await mkdir(join(repo, '.anton'), { recursive: true });
  const uniq = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${path}.${uniq}`;
  const mtmp = `${path}.mtx.${uniq}`;
  let haveMutex = false;
  try {
    const body = () => JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });
    await writeFile(tmp, body());
    try {
      // link() fails with EEXIST if the lock exists, and the lock appears with full content.
      await link(tmp, path);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = await readHolder(path);
      if (pid !== undefined && pidAlive(pid)) throw new AlreadyRunning(pid);
      // Dead/unparseable holder: serialize takeover so a live lock is never moved or removed.
      await writeFile(mtmp, body());
      haveMutex = await takeMutex(mutex, mtmp);
      if (!haveMutex) throw new AlreadyRunning(pid ?? 0);
      const again = await readHolder(path);
      if (again !== undefined && pidAlive(again)) throw new AlreadyRunning(again);
      await rm(path, { force: true });
      try {
        await link(tmp, path);
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new AlreadyRunning((await readHolder(path)) ?? 0);
        }
        throw e2;
      }
    }
  } finally {
    if (haveMutex) await rm(mutex, { force: true });
    await rm(mtmp, { force: true });
    await rm(tmp, { force: true });
  }
  return async () => {
    if ((await readHolder(path)) === process.pid) await rm(path, { force: true });
  };
}
