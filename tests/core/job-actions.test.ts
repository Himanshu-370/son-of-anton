import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import { acquireLock, acquireStoppedRun, readRunLock, waitForLockFile } from '../../src/core/lock.js';
import {
  abandonJob, acceptJobRisk, approveJob, interruptJob, isCurrent, resumeJob, stopJob, stopTarget, type ActionTarget, type JobActionDeps,
} from '../../src/core/job-actions.js';

let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-job-actions-'));
  process.env.ANTON_HOME = home;
});

async function project(over: Partial<JobState> = {}): Promise<{ repo: string; dir: string }> {
  const repo = join(home, 'projects', 'p');
  const dir = jobDirOf(repo, '1-init');
  await mkdir(dir, { recursive: true });
  await registerProject('p', repo);
  await saveState(dir, {
    jobId: '1-init', project: 'p', stage: 'plan', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: '', ...over,
  });
  return { repo, dir };
}

function fake(extra: Partial<JobActionDeps> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const spawned: string[] = [];
  const d: JobActionDeps = {
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    preflight: async () => undefined,
    spawnRun: (name) => { spawned.push(name); },
    stopContainer: async () => undefined,
    retro: { env: {} },
    ...extra,
  };
  return { d, out, err, spawned, errText: () => err.join('\n') };
}

const target = (stage: JobState['stage'], over: Partial<ActionTarget> = {}): ActionTarget => ({ project: 'p', jobId: '1-init', stage, ...over });
const nonce = '4242.00000000-0000-4000-8000-000000000001';
const nextNonce = '4242.00000000-0000-4000-8000-000000000002';
const writeRunLock = (repo: string, nonce: string) =>
  writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 4242, nonce }));
const writeClaim = (repo: string) =>
  writeFile(join(repo, '.anton', 'spawn-claim.json'), JSON.stringify({ jobId: '1-init', pid: process.pid, at: Date.now() }));
const paused = { stage: 'paused', pausedFrom: 'verify', pauseReason: 'round_cap', round: 1 } as const;

describe('Owner actions', () => {
  it('stale jobId changes nothing', async () => {
    const { dir } = await project({ stage: 'awaiting_final_review' });
    const before = await readFile(join(dir, 'state.json'), 'utf8');
    const f = fake();
    expect(await approveJob(target('awaiting_final_review', { jobId: '0-old' }), f.d)).toEqual({ code: 1, status: 'stale' });
    expect(f.errText()).toContain('is no longer the current job');
    expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(before);
  });

  it('stale revision', async () => {
    const { dir } = await project({ ...paused, pauses: 1 });
    const f = fake();
    expect(await abandonJob(target('paused', { revision: 'paused-0' }), f.d)).toEqual({ code: 1, status: 'stale' });
    expect(f.errText()).toContain('this review is out of date');
    expect((await loadState(dir)).stage).toBe('paused');
  });

  it('approve at spec approval ignores a leftover spawn claim', async () => {
    const { repo, dir } = await project({ stage: 'awaiting_spec_approval' });
    await execa('git', ['init', '-q', '-b', 'main'], { cwd: repo });
    await writeFile(join(repo, '.gitignore'), '.anton/\n');
    await writeFile(join(dir, 'spec.json'), JSON.stringify({
      title: 'Sum', summary: 's', outOfScope: [], kit: 'fallback', tech: [], acceptanceChecks: [{ id: 'AC-1', text: 'sums' }],
    }));
    await writeFile(join(dir, 'spec.md'), '# Sum\n\n## Acceptance checks\n\n- **AC-1**: sums\n');
    await writeClaim(repo);
    const f = fake();
    expect(await approveJob(target('awaiting_spec_approval'), f.d)).toEqual({ code: 0, status: 'done' });
    expect(f.spawned).toEqual(['p']);
    expect((await loadState(dir)).stage).toBe('plan');
  });

  it('resume refuses while a spawn claim is live', async () => {
    const { repo, dir } = await project({ stage: 'build' });
    await writeClaim(repo);
    const f = fake();
    expect(await resumeJob(target('build'), {}, f.d)).toEqual({ code: 1, status: 'refused' });
    expect(f.errText()).toContain('is starting in the background');
    expect(f.spawned).toEqual([]);
    expect((await loadState(dir)).stage).toBe('build');
  });

  it('approve at spec approval refuses while a run holds the lock', async () => {
    const { repo, dir } = await project({ stage: 'awaiting_spec_approval' });
    const release = await acquireLock(repo);
    try {
      const f = fake();
      expect(await approveJob(target('awaiting_spec_approval'), f.d)).toEqual({ code: 1, status: 'refused' });
      expect(f.errText()).toContain('is already running');
      expect(f.spawned).toEqual([]);
      expect((await loadState(dir)).stage).toBe('awaiting_spec_approval');
    } finally {
      await release();
    }
  });

  it('accept risk at the wrong stage is refused, not thrown', async () => {
    await project({ stage: 'plan' });
    const f = fake();
    expect(await acceptJobRisk(target('plan'), 'SEC-0000', 'ok', f.d)).toEqual({ code: 1, status: 'refused' });
    expect(f.errText()).toContain("Can't accept a risk now (stage: plan)");
  });

  it('accept risk with an unknown finding is refused', async () => {
    await project(paused);
    const f = fake();
    expect(await acceptJobRisk(target('paused'), 'SEC-0000', 'ok', f.d)).toEqual({ code: 1, status: 'refused' });
    expect(f.errText()).toContain('Unknown security finding SEC-0000');
  });

  it('a held decision lock fails with the in-progress message', async () => {
    const { repo, dir } = await project({ stage: 'awaiting_final_review' });
    const release = await waitForLockFile(join(repo, '.anton', 'decision.lock'));
    try {
      const f = fake({ lockWaitMs: 50 });
      await expect(approveJob(target('awaiting_final_review'), f.d)).rejects.toThrow('Another decision on p is in progress. Try again in a moment.');
      expect((await loadState(dir)).stage).toBe('awaiting_final_review');
    } finally {
      await release();
    }
  });

  it('isCurrent', async () => {
    const { dir } = await project(paused);
    expect(await isCurrent(target('paused'))).toBe(true);
    expect(await isCurrent(target('paused', { revision: 'paused-0' }))).toBe(true);
    expect(await isCurrent(target('paused', { revision: 'paused-3' }))).toBe(false);
    await saveState(dir, { ...(await loadState(dir)), stage: 'build' });
    expect(await isCurrent(target('paused'))).toBe(false);
  });

  it.each([
    ['verify', nonce, nonce],
    ['build', nextNonce, nonce],
    ['build', nonce, undefined],
  ] as const)('does not signal a stale or unbound stop (%s, %s, %s)', async (stage, holder, runNonce) => {
    const { repo } = await project({ stage });
    await writeRunLock(repo, holder);
    const kill = vi.fn();
    const { d } = fake();
    expect(await stopJob(target('build', { runNonce }), { ...d, kill })).toEqual({ code: 1, status: 'stale' });
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not kill, pause, or clean up a same-PID replacement during the grace period', async () => {
    const { repo, dir } = await project({ stage: 'build' });
    await writeRunLock(repo, nonce);
    const kill = vi.fn();
    const stopContainer = vi.fn(async () => undefined);
    const { d } = fake({ stopContainer });
    expect(await stopJob(target('build', { runNonce: nonce }), {
      ...d, kill, sleep: async () => writeRunLock(repo, nextNonce),
    })).toEqual({ code: 1, status: 'stale' });
    expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([[4242, 'SIGTERM']]);
    expect(stopContainer).not.toHaveBeenCalled();
    expect(await readFile(join(repo, '.anton', 'run.lock'), 'utf8')).toContain(nextNonce);
    expect((await loadState(dir)).stage).toBe('build');
  });

  it('does not pause a same-stage replacement even after the original has exited', async () => {
    const { repo, dir } = await project({ stage: 'build' });
    await writeRunLock(repo, nonce);
    let exited = false;
    const stopContainer = vi.fn(async () => undefined);
    const { d } = fake({ stopContainer });
    expect(await stopJob(target('build', { runNonce: nonce }), {
      ...d,
      kill: () => {
        if (exited) throw Object.assign(new Error('exited'), { code: 'ESRCH' });
      },
      sleep: async () => { await writeRunLock(repo, nextNonce); exited = true; },
    })).toEqual({ code: 1, status: 'stale' });
    expect(stopContainer).not.toHaveBeenCalled();
    expect((await loadState(dir)).stage).toBe('build');
  });

  it('pauses a matching stopped acquisition without a name-based container cleanup', async () => {
    const { repo, dir } = await project({ stage: 'build' });
    await writeRunLock(repo, nonce);
    const stopContainer = vi.fn(async () => undefined);
    const { d } = fake({ stopContainer });
    expect(await stopJob(target('build', { runNonce: nonce }), {
      ...d, kill: () => { throw Object.assign(new Error('exited'), { code: 'ESRCH' }); },
    })).toEqual({ code: 0, status: 'done' });
    expect(stopContainer).not.toHaveBeenCalled();
    expect((await loadState(dir)).stage).toBe('paused');
  });

  it('prevents an acquisition during stop bookkeeping and never targets the guard process', async () => {
    const { repo } = await project({ stage: 'build' });
    const release = await acquireStoppedRun(repo, undefined);
    try {
      const holding = await readRunLock(repo);
      expect(holding).toMatchObject({ pid: process.pid, stopping: true });
      await expect(acquireLock(repo)).rejects.toThrow('already running');
      const job = { name: 'p', repo, jobId: '1-init', jobDir: jobDirOf(repo, '1-init'), state: await loadState(jobDirOf(repo, '1-init')) };
      expect(await stopTarget(job)).toBeUndefined();
      const { d } = fake();
      const kill = vi.fn();
      expect(await stopJob(target('build', { runNonce: holding?.nonce }), { ...d, kill })).toEqual({ code: 1, status: 'stale' });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      await release();
    }
  });

  describe('interruptJob', () => {
    it('pauses an active job', async () => {
      const { dir } = await project({ stage: 'build', pauses: 1 });
      const f = fake();
      expect(await interruptJob(target('build'), f.d)).toEqual({ code: 0, status: 'done' });
      const s = await loadState(dir);
      expect(s.stage).toBe('paused');
      expect(s.pauseReason).toBe('interrupted');
      expect(s.pauses).toBe(2);
      expect(f.out.join('\n')).toContain('p: paused (interrupted) at build. Continue with: anton resume p');
    });

    it('leaves a replaced job alone', async () => {
      await project({ stage: 'build' });
      const dir2 = jobDirOf(join(home, 'projects', 'p'), '2-next');
      await mkdir(dir2, { recursive: true });
      await saveState(dir2, {
        jobId: '2-next', project: 'p', stage: 'build', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
        warned80: false, completedTasks: [], updatedAt: '',
      });
      const before = await readFile(join(dir2, 'state.json'), 'utf8');
      const f = fake();
      expect(await interruptJob(target('build'), f.d)).toEqual({ code: 1, status: 'stale' });
      expect(await readFile(join(dir2, 'state.json'), 'utf8')).toBe(before);
      const line = f.err.find((l) => l.includes('is no longer the current job'));
      expect(line).toContain("The run was stopped, but the job's state was not changed.");
      expect(line).not.toContain('Nothing was changed.');
    });

    it('on a finished job only reports', async () => {
      const { dir } = await project({ stage: 'done' });
      const before = await readFile(join(dir, 'state.json'), 'utf8');
      const f = fake();
      expect(await interruptJob(target('build'), f.d)).toEqual({ code: 0, status: 'done' });
      expect(f.out.join('\n')).toContain('p: stopped (stage: done).');
      expect(await readFile(join(dir, 'state.json'), 'utf8')).toBe(before);
    });

    it('with the decision lock held fails with the in-progress message', async () => {
      const { repo, dir } = await project({ stage: 'build' });
      const release = await waitForLockFile(join(repo, '.anton', 'decision.lock'));
      try {
        const f = fake({ lockWaitMs: 50 });
        await expect(interruptJob(target('build'), f.d)).rejects.toThrow('Another decision on p is in progress. Try again in a moment.');
        expect((await loadState(dir)).stage).toBe('build');
      } finally {
        await release();
      }
    });
  });
});
