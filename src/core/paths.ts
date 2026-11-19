import { homedir } from 'node:os';
import { join } from 'node:path';

export function antonHome(): string {
  return process.env.ANTON_HOME || join(homedir(), 'anton');
}

export function projectDir(slug: string): string {
  return join(antonHome(), 'projects', slug);
}

export function jobDir(repo: string, jobId: string): string {
  return join(repo, '.anton', 'jobs', jobId);
}
