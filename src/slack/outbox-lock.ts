import { randomUUID } from 'node:crypto';
import { link, rm, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { readRegularFile } from '../core/atomic.js';

export class OutboxLockBusy extends Error {}

interface Holder {
  pid: number;
  token: string;
}

async function readHolder(path: string): Promise<Holder | undefined> {
  const raw = await readRegularFile(path);
  if (raw === undefined) return undefined;
  const { pid, token } = JSON.parse(raw) as Partial<Holder>;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || typeof token !== 'string' || !/^[a-f0-9-]{36}$/.test(token)) {
    throw new Error('Invalid Slack outbox lock');
  }
  return { pid, token };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    throw error;
  }
}

async function linkIfFree(tmp: string, path: string): Promise<boolean> {
  try {
    await link(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return false;
  }
}

export async function acquireOutboxLock(root: string, purpose: 'write' | 'drain'): Promise<() => Promise<void>> {
  const token = randomUUID();
  const tmp = join(root, `.outbox-holder-${token}`);
  await writeFile(tmp, JSON.stringify({ pid: process.pid, token }), { flag: 'wx', mode: 0o600 });

  async function take(path: string): Promise<() => Promise<void>> {
    if (!(await linkIfFree(tmp, path))) {
      const holder = await readHolder(path);
      if (!holder) {
        if (!(await linkIfFree(tmp, path))) throw new OutboxLockBusy();
      } else {
        if (isAlive(holder.pid)) throw new OutboxLockBusy();
        // Only contenders for this exact dead holder serialize here. A new holder has a different token.
        const releaseRecovery = await take(join(root, `.outbox-recover-${holder.token}`));
        try {
          if ((await readHolder(path))?.token === holder.token) await unlink(path);
          if (!(await linkIfFree(tmp, path))) throw new OutboxLockBusy();
        } finally {
          await releaseRecovery();
        }
      }
    }
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      await unlink(path);
    };
  }

  try {
    return await take(join(root, `.outbox-${purpose}.lock`));
  } finally {
    await rm(tmp, { force: true });
  }
}
