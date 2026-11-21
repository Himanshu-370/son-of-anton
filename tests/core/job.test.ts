import { describe, it, expect, beforeEach, vi } from 'vitest';
import { mkdir, mkdtemp, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createChangeJob, createNewProject, DirtyRepo, JobActive, NoCommits } from '../../src/core/job.js';
import { listProjects } from '../../src/core/registry.js';
import { commitAll } from '../../src/core/git.js';
import { loadState, saveState } from '../../src/core/state.js';

const failSave = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/core/state.js', async (orig) => {
  const m = await orig<typeof import('../../src/core/state.js')>();
  return {
    ...m,
    saveState: (...a: Parameters<typeof m.saveState>) =>
      failSave.on ? Promise.reject(new Error('disk full')) : m.saveState(...a),
  };
});

const failDrop = vi.hoisted(() => ({ on: false }));
vi.mock('../../src/core/git.js', async (orig) => {
  const m = await orig<typeof import('../../src/core/git.js')>();
  return {
    ...m,
    dropBranch: (...a: Parameters<typeof m.dropBranch>) =>
      failDrop.on ? Promise.reject(new Error('branch gone')) : m.dropBranch(...a),
  };
});

beforeEach(async () => {
  process.env.ANTON_HOME = await mkdtemp(join(tmpdir(), 'anton-job-'));
});

describe('config budget', () => {
  it('config defaultUsd sets a new job budget', async () => {
    await writeFile(join(process.env.ANTON_HOME!, 'config.yaml'), 'budget:\n  defaultUsd: 3\n');
    const p = await createNewProject('A CLI that cleans Downloads');
    expect((await loadState(p.jobDir)).budgetUsd).toBe(3);
    const q = await createNewProject('Another tool', { budgetUsd: 7 });
    expect((await loadState(q.jobDir)).budgetUsd).toBe(7);
  });
});

describe('invalid config', () => {
  it('invalid config.yaml leaves no project directory behind', async () => {
    await writeFile(join(process.env.ANTON_HOME!, 'config.yaml'), 'bogus: 1\n');
    await expect(createNewProject('A CLI that cleans Downloads')).rejects.toThrow(/Invalid ~\/anton\/config\.yaml/);
    await expect(stat(join(process.env.ANTON_HOME!, 'projects'))).rejects.toThrow();
  });
});

describe('createNewProject', () => {
  it('creates repo, job folder and initial state', async () => {
    const p = await createNewProject('A CLI that cleans Downloads');
    expect(p.name).toBe('a-cli-that-cleans-downloads');
    expect(p.repoPath).toBe(join(process.env.ANTON_HOME!, 'projects', p.name));
    expect(p.jobId).toBe('1-init');
    expect((await stat(join(p.repoPath, '.git'))).isDirectory()).toBe(true);
    expect(p.jobDir).toBe(join(p.repoPath, '.anton', 'jobs', '1-init'));
    expect(await readFile(join(p.jobDir, 'description.txt'), 'utf8')).toContain('cleans Downloads');
    const s = await loadState(p.jobDir);
    expect(s).toMatchObject({ jobId: '1-init', project: p.name, stage: 'spec', round: 0, budgetUsd: 10, spentUsd: 0 });
    expect(await listProjects()).toEqual([{ name: p.name, repoPath: p.repoPath }]);
  });
  it('honours budget and dedupes names', async () => {
    const a = await createNewProject('same thing', { budgetUsd: 5 });
    const b = await createNewProject('same thing');
    expect(b.name).toBe(`${a.name}-2`);
    expect((await loadState(a.jobDir)).budgetUsd).toBe(5);
  });
});

describe('createChangeJob', () => {
  async function doneProject() {
    const p = await createNewProject('init thing');
    await writeFile(join(p.repoPath, 'a.txt'), 'a');
    await commitAll(p.repoPath, 'first');
    await saveState(p.jobDir, { ...(await loadState(p.jobDir)), stage: 'done' });
    return p;
  }
  const branch = async (repo: string) => (await execa('git', ['branch', '--show-current'], { cwd: repo })).stdout;

  it('change job ids increment: 1-init then 2-add-auth', async () => {
    const p = await doneProject();
    const c = await createChangeJob(p.name, 'Add auth');
    expect(c.jobId).toBe('2-add-auth');
    expect(c.branch).toBe('anton/2-add-auth');
    expect(await loadState(c.jobDir)).toMatchObject({ kind: 'change', branch: c.branch, fromBranch: 'main', stage: 'spec', budgetUsd: 10 });
  });
  it('branch anton/2-add-auth exists and is checked out', async () => {
    const p = await doneProject();
    await createChangeJob(p.name, 'Add auth');
    expect(await branch(p.repoPath)).toBe('anton/2-add-auth');
  });
  it('dirty repo → DirtyRepo, no job dir, no branch', async () => {
    const p = await doneProject();
    await writeFile(join(p.repoPath, 'a.txt'), 'dirty');
    await expect(createChangeJob(p.name, 'Add auth')).rejects.toBeInstanceOf(DirtyRepo);
    await expect(stat(join(p.repoPath, '.anton', 'jobs', '2-add-auth'))).rejects.toThrow();
    expect((await execa('git', ['branch', '--list', 'anton/*'], { cwd: p.repoPath })).stdout).toBe('');
  });
  it('active job → JobActive, nothing created', async () => {
    const p = await createNewProject('init thing');
    await writeFile(join(p.repoPath, 'a.txt'), 'a');
    await commitAll(p.repoPath, 'first');
    await expect(createChangeJob(p.name, 'Add auth')).rejects.toBeInstanceOf(JobActive);
    await expect(stat(join(p.repoPath, '.anton', 'jobs', '2-add-auth'))).rejects.toThrow();
    expect((await execa('git', ['branch', '--list', 'anton/*'], { cwd: p.repoPath })).stdout).toBe('');
  });
  it('keeps the branch name within 60 chars', async () => {
    const p = await doneProject();
    const c = await createChangeJob(p.name, 'x'.repeat(100));
    expect(c.branch.length).toBeLessThanOrEqual(60);
  });
  it('active job → JobActive message, checked before dirtiness', async () => {
    const p = await createNewProject('init thing');
    await writeFile(join(p.repoPath, 'a.txt'), 'a');
    await expect(createChangeJob(p.name, 'Add auth')).rejects.toThrow(
      `${p.name} already has an active job (1-init, stage spec)`,
    );
  });
  it('adopted repo with no jobs → first change job is 1-<slug>', async () => {
    const p = await doneProject();
    await rm(join(p.repoPath, '.anton'), { recursive: true });
    expect((await createChangeJob(p.name, 'Add auth')).jobId).toBe('1-add-auth');
  });
  it('repo with no commits → NoCommits, nothing created', async () => {
    const p = await createNewProject('init thing');
    await rm(join(p.repoPath, '.anton'), { recursive: true });
    await expect(createChangeJob(p.name, 'x')).rejects.toBeInstanceOf(NoCommits);
    await expect(createChangeJob(p.name, 'x')).rejects.toThrow('Make an initial commit first');
  });
  it('failed state write rolls back branch and job dir', async () => {
    const p = await doneProject();
    const before = await branch(p.repoPath);
    failSave.on = true;
    try {
      await expect(createChangeJob(p.name, 'Add auth')).rejects.toThrow('disk full');
    } finally {
      failSave.on = false;
    }
    expect(await branch(p.repoPath)).toBe(before);
    expect((await execa('git', ['branch', '--list', 'anton/*'], { cwd: p.repoPath })).stdout).toBe('');
    await expect(stat(join(p.repoPath, '.anton', 'jobs', '2-add-auth'))).rejects.toThrow();
  });
  it('failing dropBranch still removes the job dir and rethrows the original error', async () => {
    const p = await doneProject();
    failSave.on = true;
    failDrop.on = true;
    try {
      await expect(createChangeJob(p.name, 'Add auth')).rejects.toThrow('disk full');
    } finally {
      failSave.on = false;
      failDrop.on = false;
    }
    await expect(stat(join(p.repoPath, '.anton', 'jobs', '2-add-auth'))).rejects.toThrow();
  });
  it('unborn repo with untracked files → NoCommits', async () => {
    const p = await createNewProject('unborn thing');
    await rm(join(p.repoPath, '.anton'), { recursive: true });
    await writeFile(join(p.repoPath, 'a.txt'), 'x');
    await expect(createChangeJob(p.name, 'x')).rejects.toBeInstanceOf(NoCommits);
  });
  it('leftover job dir without state.json does not block, and its number is not reused', async () => {
    const p = await doneProject();
    await mkdir(join(p.repoPath, '.anton', 'jobs', '2-crashed'), { recursive: true });
    expect((await createChangeJob(p.name, 'Add auth')).jobId).toBe('3-add-auth');
  });
});
