import { mkdir, link, readFile, rename, rm, writeFile } from 'node:fs/promises';
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

export async function isRunning(repo: string): Promise<{ running: boolean; pid?: number }> {
  const pid = await readHolder(lockPath(repo));
  return pid !== undefined && pidAlive(pid) ? { running: true, pid } : { running: false };
}

export async function acquireLock(repo: string): Promise<() => Promise<void>> {
  const path = lockPath(repo);
  await mkdir(join(repo, '.anton'), { recursive: true });
  const uniq = `${process.pid}.${Math.random().toString(36).slice(2)}`;
  const tmp = `${path}.${uniq}`;
  const stale = `${path}.stale.${uniq}`;
  try {
    await writeFile(tmp, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    for (let attempt = 0; ; attempt++) {
      try {
        // link() fails with EEXIST if the lock exists, and the lock appears with full content.
        await link(tmp, path);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const pid = await readHolder(path);
        if (pid !== undefined && pidAlive(pid)) throw new AlreadyRunning(pid);
        if (attempt >= 5) throw new AlreadyRunning(pid ?? 0);
        // Atomic takeover: only one renamer can move a given file.
        try {
          await rename(path, stale);
        } catch (re) {
          if ((re as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw re;
        }
        const moved = await readHolder(stale);
        if (moved !== undefined && pidAlive(moved)) {
          // We grabbed a live lock someone else just created; put it back.
          await link(stale, path).catch(() => {});
          throw new AlreadyRunning(moved);
        }
        // genuinely stale: discarded in finally, then retry link
        await rm(stale, { force: true });
      }
    }
  } finally {
    await rm(tmp, { force: true });
    await rm(stale, { force: true });
  }
  return async () => {
    if ((await readHolder(path)) === process.pid) await rm(path, { force: true });
  };
}
