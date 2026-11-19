import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { DEFAULTS } from './config.js';
import { jobDir, projectDir } from './paths.js';
import { registerProject, slugify, uniqueName } from './registry.js';
import { saveState, type JobState } from './state.js';

export interface NewProject {
  name: string;
  repoPath: string;
  jobId: string;
  jobDir: string;
}

export async function createNewProject(
  description: string,
  opts: { budgetUsd?: number } = {},
): Promise<NewProject> {
  const name = await uniqueName(slugify(description));
  const repoPath = projectDir(name);
  const jobId = '1-init';
  const dir = jobDir(repoPath, jobId);
  await fsp.mkdir(dir, { recursive: true });
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: repoPath });
  await fsp.writeFile(join(dir, 'description.txt'), description.endsWith('\n') ? description : description + '\n');
  const state: JobState = {
    jobId,
    project: name,
    stage: 'spec',
    round: 0,
    maxRounds: DEFAULTS.maxRounds,
    budgetUsd: opts.budgetUsd ?? DEFAULTS.budgetUsd,
    spentUsd: 0,
    warned80: false,
    completedTasks: [],
    updatedAt: '',
  };
  await saveState(dir, state);
  await registerProject(name, repoPath);
  return { name, repoPath, jobId, jobDir: dir };
}
