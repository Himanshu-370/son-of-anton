import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execa } from 'execa';

/**
 * Host git runs on the Mac, outside Docker, inside a repo the agent can write to. So every
 * invocation neutralises the config that could run repo-controlled code or change identity:
 * - hooks: `core.hooksPath=/dev/null` (overrides a repo-local hooksPath too) and `--no-verify` on commit;
 * - `core.fsmonitor=false` (an fsmonitor hook is an arbitrary command);
 * - `core.attributesFile=/dev/null`, and the system/global config is skipped via
 *   GIT_CONFIG_NOSYSTEM=1 / GIT_CONFIG_GLOBAL=/dev/null, so filter drivers defined there never run;
 * - identity and location env vars (GIT_AUTHOR_*, GIT_COMMITTER_*, GIT_DIR, GIT_WORK_TREE, ...)
 *   are removed from the env we pass, so commits are always Son of Anton's, in `repo`.
 * Residual risk: clean/smudge filter drivers (and other keys) defined in the repo-local
 * `.git/config`, which the agent can write, still apply to add/status. The fuller fix is to run
 * git inside the container (Phase 3).
 */
const SAFE = [
  '-c',
  'core.hooksPath=/dev/null',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'core.attributesFile=/dev/null',
  '-c',
  'user.name=Son of Anton',
  '-c',
  'user.email=anton@localhost',
  '-c',
  'commit.gpgsign=false',
];

const STRIPPED_ENV = /^GIT_(AUTHOR_|COMMITTER_|DIR$|WORK_TREE$|INDEX_FILE$|OBJECT_DIRECTORY$|ALTERNATE_OBJECT_DIRECTORIES$|NAMESPACE$|CEILING_DIRECTORIES$|DISCOVERY_ACROSS_FILESYSTEM$|COMMON_DIR$|CONFIG)/;

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !STRIPPED_ENV.test(k)) env[k] = v;
  }
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = '/dev/null';
  return env;
}

async function git(repo: string, args: string[]): Promise<string> {
  const r = await execa('git', [...SAFE, ...args], { cwd: repo, env: gitEnv(), extendEnv: false });
  return String(r.stdout);
}

/** Stage everything and commit as Son of Anton. Returns the sha, or null if nothing to commit. */
export async function commitAll(repo: string, message: string): Promise<string | null> {
  await git(repo, ['add', '-A']);
  const status = await git(repo, ['status', '--porcelain']);
  if (status.trim() === '') return null;
  await git(repo, ['commit', '-q', '--no-verify', '-m', message]);
  return headSha(repo);
}

export async function tag(repo: string, name: string): Promise<void> {
  await git(repo, ['tag', name]);
}

/** Tags matching a `git tag -l` glob pattern. */
export async function listTags(repo: string, pattern: string): Promise<string[]> {
  const out = await git(repo, ['tag', '-l', pattern]);
  return out.split('\n').map((t) => t.trim()).filter(Boolean);
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
