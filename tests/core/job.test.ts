import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { writeFile } from 'node:fs/promises';
import { createChangeJob, createNewProject, DirtyRepo, JobActive } from '../../src/core/job.js';
import { listProjects } from '../../src/core/registry.js';
import { commitAll } from '../../src/core/git.js';
import { loadState, saveState } from '../../src/core/state.js';

beforeEach(async () => {
  process.env.ANTON_HOME = await mkdtemp(join(tmpdir(), 'anton-job-'));
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
    expect(await loadState(c.jobDir)).toMatchObject({ kind: 'change', branch: c.branch, stage: 'spec', budgetUsd: 10 });
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
});
