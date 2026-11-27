import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRegularFile } from '../core/atomic.js';
import type { ProjectEntry } from '../core/registry.js';
import { importLegacyJobSpend } from '../core/spend-log.js';
import { JobStateSchema } from '../core/state.js';
import { assertJobDir } from '../stages/verify.js';
import { importMonthToDateSlackSpend } from './chat-budget.js';

/** Reconcile against stable snapshots before starting the runner and Slack workers. */
export async function reconcileMonthToDateSpend(input: {
  home: string;
  now: Date;
  projects: readonly ProjectEntry[];
  teamId: string;
}) {
  const { home, now, projects, teamId } = input;
  let jobs = 0;
  let jobUsd = 0;
  for (const project of projects) {
    const antonDir = join(project.repoPath, '.anton');
    const jobsDir = join(antonDir, 'jobs');
    let names: string[];
    try {
      if (!(await lstat(antonDir)).isDirectory() || !(await lstat(jobsDir)).isDirectory()) {
        throw new Error(`Invalid jobs directory for ${project.name}.`);
      }
      names = await readdir(jobsDir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
    for (const name of names) {
      if (!/^\d+-[a-z0-9][a-z0-9-]*$/.test(name)) continue;
      const dir = join(jobsDir, name);
      await assertJobDir(project.repoPath, dir);
      const raw = await readRegularFile(join(dir, 'state.json'));
      if (!raw) throw new Error(`Missing job state for ${project.name}/${name}.`);
      const state = JobStateSchema.parse(JSON.parse(raw));
      if (state.project !== project.name || state.jobId !== name) {
        throw new Error(`Job state does not match ${project.name}/${name}.`);
      }
      const imported = await importLegacyJobSpend(state, now, home);
      if (imported > 0) {
        jobs++;
        jobUsd += imported;
      }
    }
  }
  const slack = await importMonthToDateSlackSpend(teamId, now.getTime(), { home });
  return { jobs, jobUsd, slack };
}
