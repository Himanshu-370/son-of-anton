import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { DEFAULTS } from './config.js';
import { jobDir, projectDir } from './paths.js';
import { createBranch, isClean } from './git.js';
import { getProject, registerProject, slugify, uniqueName } from './registry.js';
import { loadState, saveState, type JobState } from './state.js';

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
    kind: 'new',
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

export class DirtyRepo extends Error {
  constructor() {
    super('Commit or stash your changes first');
    this.name = 'DirtyRepo';
  }
}

export class JobActive extends Error {
  constructor(project: string, jobId: string, stage: string) {
    super(`${project} already has an active job (${jobId}, stage ${stage})`);
    this.name = 'JobActive';
  }
}

/** Start a change job on a registered project: new `anton/<jobId>` branch, state at `spec`. */
export async function createChangeJob(
  project: string,
  description: string,
  opts: { budgetUsd?: number } = {},
): Promise<NewProject & { branch: string }> {
  const { repoPath } = await getProject(project);
  if (!(await isClean(repoPath))) throw new DirtyRepo();
  let n = 1;
  try {
    const latest = await currentJobId(repoPath);
    const s = await loadState(jobDir(repoPath, latest));
    if (s.stage !== 'done' && s.stage !== 'abandoned') throw new JobActive(project, latest, s.stage);
    n = parseInt(latest, 10) + 1;
  } catch (e) {
    if (!(e instanceof Error) || e.message !== `No job found in ${repoPath}`) throw e; // adopted repo: no jobs yet
  }
  // `anton/<n>-` prefix plus slug must fit in 60 chars
  const slug = slugify(description).slice(0, 60 - `anton/${n}-`.length).replace(/-+$/, '') || 'change';
  const id = `${n}-${slug}`;
  const branch = `anton/${id}`;
  await createBranch(repoPath, branch);
  const dir = jobDir(repoPath, id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(join(dir, 'description.txt'), description.endsWith('\n') ? description : description + '\n');
  await saveState(dir, {
    jobId: id,
    kind: 'change',
    branch,
    project,
    stage: 'spec',
    round: 0,
    maxRounds: DEFAULTS.maxRounds,
    budgetUsd: opts.budgetUsd ?? DEFAULTS.budgetUsd,
    spentUsd: 0,
    warned80: false,
    completedTasks: [],
    updatedAt: '',
  });
  return { name: project, repoPath, jobId: id, jobDir: dir, branch };
}
