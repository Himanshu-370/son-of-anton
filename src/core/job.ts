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

/** The project's current job: the folder in `.anton/jobs/` with the highest `<n>-` prefix. */
export async function currentJobId(repoPath: string): Promise<string> {
  let ids: string[] = [];
  try {
    ids = (await fsp.readdir(join(repoPath, '.anton', 'jobs'), { withFileTypes: true }))
      .filter((e) => e.isDirectory() && /^\d+-/.test(e.name))
      .map((e) => e.name);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (ids.length === 0) throw new Error(`No job found in ${repoPath}`);
  return ids.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0]!;
}
