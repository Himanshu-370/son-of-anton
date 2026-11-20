import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execa } from 'execa';
import { writeFileAtomic } from './atomic.js';

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

/**
 * Stage everything and commit as Son of Anton. Returns the sha, or null if nothing to commit.
 * Re-asserts the `.anton/` exclusion first (cheap, idempotent), so job files never enter history.
 */
export async function commitAll(repo: string, message: string): Promise<string | null> {
  await ensureAntonIgnored(repo);
  await git(repo, ['add', '-A']);
  const status = await git(repo, ['status', '--porcelain']);
  if (status.trim() === '') return null;
  await git(repo, ['commit', '-q', '--no-verify', '-m', message]);
  return headSha(repo);
}

/** True when the work tree has no changes (`.anton/` is excluded, so it does not count). Writes .git/info/exclude first, by design. */
export async function isClean(repo: string): Promise<boolean> {
  await ensureAntonIgnored(repo);
  return (await git(repo, ['status', '--porcelain'])).trim() === '';
}

/** Create and switch to a new branch; git's error surfaces if it already exists. */
export async function createBranch(repo: string, name: string): Promise<void> {
  await git(repo, ['switch', '-c', name]);
}

/** The checked-out branch name, or the commit sha when HEAD is detached. Needs at least one commit. */
export async function currentBranch(repo: string): Promise<string> {
  try {
    return (await git(repo, ['symbolic-ref', '--short', '-q', 'HEAD'])).trim();
  } catch {
    return headSha(repo);
  }
}

/** Undo `createBranch`: switch back to `back` (a branch name or sha from `currentBranch`) and force-delete `name`. */
export async function dropBranch(repo: string, name: string, back: string): Promise<void> {
  await git(repo, ['checkout', '-q', back]);
  await git(repo, ['branch', '-D', name]);
}

/** The work tree's root as git sees it (`rev-parse --show-toplevel`), or null if `path` is not in a repo. */
export async function repoRoot(path: string): Promise<string | null> {
  try {
    return (await git(path, ['rev-parse', '--show-toplevel'])).trim();
  } catch {
    return null;
  }
}

/** False for a repo with no commits (unborn HEAD). */
export async function hasCommits(repo: string): Promise<boolean> {
  try {
    await git(repo, ['rev-parse', '--verify', '--quiet', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function tag(repo: string, name: string): Promise<void> {
  await git(repo, ['tag', name]);
}

/** Tags matching a `git tag -l` glob pattern. */
export async function listTags(repo: string, pattern: string): Promise<string[]> {
  const out = await git(repo, ['tag', '-l', pattern]);
  return out.split('\n').map((t) => t.trim()).filter(Boolean);
}

/** Unified diff of everything committed after `sha` up to HEAD (`git diff <sha>..HEAD`). */
export async function diffSince(repo: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`invalid sha for diffSince: ${JSON.stringify(sha)}`);
  return git(repo, ['diff', '--no-color', '--no-ext-diff', `${sha}..HEAD`, '--']);
}

/** Paths changed after `sha` up to HEAD (`git diff --name-only <sha>..HEAD`). */
export async function changedFilesSince(repo: string, sha: string): Promise<string[]> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`invalid sha for changedFilesSince: ${JSON.stringify(sha)}`);
  const out = await git(repo, ['diff', '--no-color', '--no-ext-diff', '--name-only', `${sha}..HEAD`, '--']);
  return out.split('\n').map((l) => l.trim()).filter(Boolean);
}

/** The commit sha a ref (tag, branch, sha) points to. Throws if it does not resolve to a commit. */
export async function revParse(repo: string, ref: string): Promise<string> {
  if (ref === '' || ref.startsWith('-') || /\s/.test(ref)) throw new Error(`invalid ref for revParse: ${JSON.stringify(ref)}`);
  return (await git(repo, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`])).trim();
}

export async function headSha(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', 'HEAD'])).trim();
}

/**
 * Ensure `.anton/` is excluded via the repo's `.git/info/exclude` (created if missing; idempotent;
 * written atomically). Not `.gitignore`: the agent can rewrite that file, and the exclude file is
 * outside the work tree, so it never shows up in the user's project history.
 */
export async function ensureAntonIgnored(repo: string): Promise<void> {
  const file = resolve(repo, (await git(repo, ['rev-parse', '--git-path', 'info/exclude'])).trim());
  let current = '';
  try {
    current = await readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  if (current.split(/\r?\n/).some((l) => l.trim() === '.anton/' || l.trim() === '/.anton/')) return;
  const sep = current === '' || current.endsWith('\n') ? '' : '\n';
  await writeFileAtomic(file, `${current}${sep}.anton/\n`);
}
