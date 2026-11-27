import { homedir } from 'node:os';
import { join } from 'node:path';

export function antonHome(): string {
  return process.env.ANTON_HOME || join(homedir(), 'anton');
}

/** A new project's folder: under `projectsDir` from config.yaml when set, else ~/anton/projects. */
export function projectDir(slug: string, projectsDir?: string): string {
  const root = projectsDir?.startsWith('~/') ? join(homedir(), projectsDir.slice(2)) : projectsDir;
  return join(root ?? join(antonHome(), 'projects'), slug);
}

export function jobDir(repo: string, jobId: string): string {
  return join(repo, '.anton', 'jobs', jobId);
}
