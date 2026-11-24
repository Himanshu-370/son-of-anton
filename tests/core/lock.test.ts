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

  it('a stale .takeover file (dead pid) does not block acquisition', async () => {
    const repo = await tmp();
    await mkdir(join(repo, '.anton'));
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 999999, startedAt: 'x' }));
    await writeFile(join(repo, '.anton', 'run.lock.takeover'), JSON.stringify({ pid: 999998, startedAt: 'x' }));
    const release = await acquireLock(repo);
    expect(await isRunning(repo)).toEqual({ running: true, pid: process.pid });
    expect(await exists(join(repo, '.anton', 'run.lock.takeover'))).toBe(false);
    await release();
  });
});

describe('lock ownership and takeover', () => {
  it('a release removes only its own acquisition, even in the same process', async () => {
    const { acquireLockFile } = await import('../../src/core/lock.js');
    const dir = await tmp();
    const p = join(dir, 'x.lock');
    const releaseA = await acquireLockFile(p);
    await releaseA();
    const releaseB = await acquireLockFile(p);
    await releaseA(); // a late or repeated release from the earlier holder
    expect(await exists(p)).toBe(true);
    expect((await acquireLockFile(p).catch((e) => e))).toBeInstanceOf(AlreadyRunning);
    await releaseB();
    expect(await exists(p)).toBe(false);
  });

  it('takes over a dead holder (with or without a nonce) and a corrupt file', async () => {
    const { acquireLockFile } = await import('../../src/core/lock.js');
    const dir = await tmp();
    const p = join(dir, 'x.lock');
    for (const body of [
      JSON.stringify({ pid: 999999, nonce: '999999.old', startedAt: 'x' }), // dead, current format
      JSON.stringify({ pid: 999999, startedAt: 'x' }), // dead, older format without a nonce
      '{"pid": 12', // corrupt
      '',
    ]) {
      await writeFile(p, body);
      const release = await acquireLockFile(p);
      expect(JSON.parse(await readFile(p, 'utf8')).pid).toBe(process.pid);
      await release();
      expect(await exists(p)).toBe(false);
    }
  });

  it('a live lock from an older version (pid, no nonce) is respected and survives our release', async () => {
    const { acquireLockFile } = await import('../../src/core/lock.js');
    const dir = await tmp();
    const p = join(dir, 'x.lock');
    await writeFile(p, JSON.stringify({ pid: process.pid, startedAt: 'x' }));
    const err = await acquireLockFile(p).catch((e) => e);
    expect(err).toBeInstanceOf(AlreadyRunning);
    expect(err.pid).toBe(process.pid);
    expect(await exists(p)).toBe(true);
  });

  it('the hand-off case reads clearly instead of "pid 0"', () => {
    expect(new AlreadyRunning(0).message).toMatch(/taking this lock right now; try again/);
    expect(new AlreadyRunning(42).message).toMatch(/pid 42/);
  });

  it('stress: many in-process waiters never overlap, including through takeovers of dead locks', async () => {
    const { waitForLockFile } = await import('../../src/core/lock.js');
    const dir = await tmp();
    const p = join(dir, 'x.lock');
    const counter = join(dir, 'counter');
    await writeFile(counter, '0');
    let inside = 0;
    let most = 0;
    for (let round = 0; round < 3; round++) {
      // Each round starts from a dead holder's lock, so the first waiters race through takeover.
      await writeFile(p, JSON.stringify({ pid: 999999, startedAt: 'x' }));
      await Promise.all(Array.from({ length: 40 }, async () => {
        const release = await waitForLockFile(p, 30_000);
        inside++;
        most = Math.max(most, inside);
        const n = Number(await readFile(counter, 'utf8'));
        // Vary the hold time so releases land at every point of the other waiters' acquire steps.
        if (Math.random() < 0.5) await new Promise((r) => setTimeout(r, Math.random() * 3));
        await writeFile(counter, String(n + 1));
        inside--;
        await release();
      }));
    }
    expect(most).toBe(1);
    expect(Number(await readFile(counter, 'utf8'))).toBe(120);
  }, 30_000);
});
