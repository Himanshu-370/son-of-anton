import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';
import { budgetSettings, loadAntonConfig } from './anton-config.js';
import { DEFAULTS } from './config.js';
import { jobDir, projectDir } from './paths.js';
import { createBranch, currentBranch, dropBranch, hasCommits, isClean } from './git.js';
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
  // Read config before any filesystem work: an invalid config.yaml must leave nothing behind.
  const budgetUsd = opts.budgetUsd ?? budgetSettings(await loadAntonConfig()).defaultUsd;
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
    budgetUsd: budgetUsd,
    spentUsd: 0,
    warned80: false,
    completedTasks: [],
    updatedAt: '',
  };
  await saveState(dir, state);
  await registerProject(name, repoPath);
  return { name, repoPath, jobId, jobDir: dir };
}

export class NoJobs extends Error {
  constructor(repoPath: string) {
    super(`No job found in ${repoPath}`);
    this.name = 'NoJobs';
  }
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
  if (ids.length === 0) throw new NoJobs(repoPath);
  return ids.sort((a, b) => parseInt(b, 10) - parseInt(a, 10))[0]!;
}

export class DirtyRepo extends Error {
  constructor() {
    super('Commit or stash your changes first');
    this.name = 'DirtyRepo';
  }
}

/**
 * Change jobs only ever touch their own branch. Throws unless the repo is on it (no-op for new jobs),
 * so a user who switched branches never gets anton commits or resets on their own branch.
 */
export async function assertOnJobBranch(
  repo: string,
  state: Pick<JobState, 'kind' | 'branch'>,
  current: (repo: string) => Promise<string> = currentBranch,
): Promise<void> {
  if (state.kind !== 'change' || !state.branch) return;
  if ((await current(repo)) !== state.branch) throw new Error(`Switch back to the job branch first: git switch ${state.branch}`);
}

export class NoCommits extends Error {
  constructor() {
    super('Make an initial commit first');
    this.name = 'NoCommits';
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
  const budgetUsd = opts.budgetUsd ?? budgetSettings(await loadAntonConfig()).defaultUsd;
  const { repoPath } = await getProject(project);
  let n = 1;
  try {
    const latest = await currentJobId(repoPath);
    n = parseInt(latest, 10) + 1;
    let stage: string | undefined;
    try {
      stage = (await loadState(jobDir(repoPath, latest))).stage;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; // crashed leftover: not active, number still counts
    }
    if (stage && stage !== 'done' && stage !== 'abandoned') throw new JobActive(project, latest, stage);
  } catch (e) {
    if (!(e instanceof NoJobs)) throw e; // adopted repo: no jobs yet
  }
  if (!(await hasCommits(repoPath))) throw new NoCommits();
  if (!(await isClean(repoPath))) throw new DirtyRepo();
  // `anton/<n>-` prefix plus slug must fit in 60 chars
  const slug = slugify(description).slice(0, 60 - `anton/${n}-`.length).replace(/-+$/, '');
  const id = `${n}-${slug}`;
  const branch = `anton/${id}`;
  const dir = jobDir(repoPath, id);
  const back = await currentBranch(repoPath);
  await createBranch(repoPath, branch);
  try {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.writeFile(join(dir, 'description.txt'), description.endsWith('\n') ? description : description + '\n');
    await saveState(dir, {
      jobId: id,
      kind: 'change',
      branch,
      fromBranch: back,
      project,
      stage: 'spec',
      round: 0,
      maxRounds: DEFAULTS.maxRounds,
      budgetUsd: budgetUsd,
      spentUsd: 0,
      warned80: false,
      completedTasks: [],
      updatedAt: '',
    });
  } catch (e) {
    await fsp.rm(dir, { recursive: true, force: true });
    await dropBranch(repoPath, branch, back).catch(() => undefined); // best effort; always surface the original error
    throw e;
  }
  return { name: project, repoPath, jobId: id, jobDir: dir, branch };
}
