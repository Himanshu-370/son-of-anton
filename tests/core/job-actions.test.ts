import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import { acquireLock, waitForLockFile } from '../../src/core/lock.js';
import {
  abandonJob, acceptJobRisk, approveJob, interruptJob, isCurrent, resumeJob, stopJob, type ActionTarget, type JobActionDeps,
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

  it('does not signal a runner or stop its container when the stop target is stale', async () => {
    const { repo } = await project({ stage: 'verify' });
    await writeFile(join(repo, '.anton', 'run.lock'), JSON.stringify({ pid: 4242 }));
    const kill = vi.fn();
    const stopContainer = vi.fn(async () => undefined);
    const { d } = fake({ stopContainer });
    expect(await stopJob(target('build'), { ...d, kill })).toEqual({ code: 1, status: 'stale' });
    expect(kill).not.toHaveBeenCalled();
    expect(stopContainer).not.toHaveBeenCalled();
  });

  it('leaves a newer stage intact when the runner moved after the stop began', async () => {
    const { dir } = await project({ stage: 'build' });
    const { d } = fake({
      stopContainer: async () => saveState(dir, { ...(await loadState(dir)), stage: 'verify' }),
    });
    expect(await stopJob(target('build'), d)).toEqual({ code: 1, status: 'stale' });
    expect((await loadState(dir)).stage).toBe('verify');
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
