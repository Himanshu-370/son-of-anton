import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

const IDENT = [
  '-c',
  'user.name=Son of Anton',
  '-c',
  'user.email=anton@localhost',
  '-c',
  'commit.gpgsign=false',
];

async function git(repo: string, args: string[]): Promise<string> {
  const r = await execa('git', [...IDENT, ...args], { cwd: repo });
  return String(r.stdout);
}

/** Stage everything and commit as Son of Anton. Returns the sha, or null if nothing to commit. */
export async function commitAll(repo: string, message: string): Promise<string | null> {
  await git(repo, ['add', '-A']);
  const status = await git(repo, ['status', '--porcelain']);
  if (status.trim() === '') return null;
  await git(repo, ['commit', '-q', '-m', message]);
  return headSha(repo);
}

export async function tag(repo: string, name: string): Promise<void> {
  await git(repo, ['tag', name]);
}

export async function headSha(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

/** Ensure `.anton/` is listed in the repo's .gitignore (idempotent). */
export async function ensureAntonIgnored(repo: string): Promise<void> {
  const file = join(repo, '.gitignore');
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch {
    // missing: will be created
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === '.anton/')) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFile(file, `${current}${sep}.anton/\n`);
}
