import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir, access, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireLock, isRunning, AlreadyRunning } from '../../src/core/lock.js';

const tmp = () => mkdtemp(join(tmpdir(), 'anton-lock-'));
const exists = (p: string) => access(p).then(() => true, () => false);

describe('lock', () => {
  it('second acquire throws AlreadyRunning while first holds it', async () => {
    const repo = await tmp();
    const release = await acquireLock(repo);
    const err = await acquireLock(repo).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyRunning);
    expect(err.pid).toBe(process.pid);
    expect(await isRunning(repo)).toEqual({ running: true, pid: process.pid });
    await release();
  });

  it('stale lock with dead pid (e.g. 999999) is replaced', async () => {
    const repo = await tmp();
    await mkdir(join(repo, '.anton'));
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 999999, startedAt: 'x' }));
    expect(await isRunning(repo)).toEqual({ running: false });
    const release = await acquireLock(repo);
    const data = JSON.parse(await readFile(join(repo, '.anton', 'run.lock'), 'utf8'));
    expect(data.pid).toBe(process.pid);
    expect(typeof data.startedAt).toBe('string');
    await release();
  });

  it('release removes the lock file', async () => {
    const repo = await tmp();
    const release = await acquireLock(repo);
    expect(await exists(join(repo, '.anton', 'run.lock'))).toBe(true);
    await release();
    expect(await exists(join(repo, '.anton', 'run.lock'))).toBe(false);
    expect(await isRunning(repo)).toEqual({ running: false });
  });

  it('simultaneous acquirers: exactly one wins', async () => {
    const repo = await tmp();
    const results = await Promise.allSettled([acquireLock(repo), acquireLock(repo), acquireLock(repo)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('concurrent acquirers against a stale lock: exactly one wins, rest AlreadyRunning', async () => {
    const repo = await tmp();
    await mkdir(join(repo, '.anton'));
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 999999, startedAt: 'x' }));
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => acquireLock(repo)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok).toHaveLength(1);
    for (const b of bad) expect(b.reason).toBeInstanceOf(AlreadyRunning);
  });

  it('release does not remove a lock owned by another pid', async () => {
    const repo = await tmp();
    const release = await acquireLock(repo);
    const p = join(repo, '.anton', 'run.lock');
    await writeFile(p, JSON.stringify({ pid: 1, startedAt: 'x' }));
    await release();
    expect(await exists(p)).toBe(true);
  });
});
