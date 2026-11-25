import { describe, it, expect, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { jobDir as jobDirOf } from '../../src/core/paths.js';
import { registerProject } from '../../src/core/registry.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import { acquireLock, waitForLockFile } from '../../src/core/lock.js';
import {
  abandonJob, acceptJobRisk, approveJob, isCurrent, resumeJob, type ActionTarget, type JobActionDeps,
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
});
