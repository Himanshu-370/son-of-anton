import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNewProject } from '../../src/core/job.js';
import { listProjects } from '../../src/core/registry.js';
import { loadState } from '../../src/core/state.js';

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
