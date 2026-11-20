import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readlink, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { execa } from 'execa';
import { writeFileAtomic } from './atomic.js';
import { redact } from './secrets.js';

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

/** Thrown by `commitAll` when the staged diff holds a secret value. Names keys only, never values. */
export class SecretInDiff extends Error {
  constructor(public keys: string[]) {
    super(`Refusing to commit: the change contains the value of secret(s) ${keys.join(', ')}. Remove it from the code (read it from the environment instead).`);
    this.name = 'SecretInDiff';
  }
}

/** The staged diff (`git diff --cached`). */
export async function stagedDiff(repo: string): Promise<string> {
  return git(repo, ['diff', '--cached', '--no-color', '--no-ext-diff']);
}

/**
 * Stage everything and commit as Son of Anton. Returns the sha, or null if nothing to commit.
 * Re-asserts the `.anton/` exclusion first (cheap, idempotent), so job files never enter history.
 * With `secrets`, a staged diff that contains a secret value is unstaged (work tree kept) and rejected
 * with SecretInDiff instead of committed.
 */
export async function commitAll(repo: string, message: string, secrets?: Record<string, string>): Promise<string | null> {
  await ensureAntonIgnored(repo);
  await git(repo, ['add', '-A']);
  const status = await git(repo, ['status', '--porcelain']);
  if (status.trim() === '') return null;
  if (Object.keys(secrets ?? {}).length) {
    // shortcut: binary files are not inspected (git diff shows no text for them); upgrade if agents may write binaries.
    const diff = (await stagedDiff(repo)).split('\n').filter((l) => l.startsWith('+') && !/^\+\+\+ ("?b\/|\/dev\/null)/.test(l)).join('\n');
    if (redact(diff, secrets) !== diff) {
      await git(repo, ['reset', '-q']);
      throw new SecretInDiff(Object.entries(secrets!).filter(([k, v]) => redact(diff, { [k]: v }) !== diff).map(([k]) => k));
    }
  }
  await git(repo, ['commit', '-q', '--no-verify', '-m', message]);
  return headSha(repo);
}

/** True when the work tree has no changes (`.anton/` is excluded, so it does not count). Writes .git/info/exclude first, by design. */
export async function isClean(repo: string): Promise<boolean> {
  await ensureAntonIgnored(repo);
  return (await git(repo, ['status', '--porcelain'])).trim() === '';
}

/**
 * Discards tracked edits and untracked files, back to HEAD. No `-x`: ignored files (node_modules,
 * `.anton/`) survive.
 */
export async function resetWorktree(repo: string): Promise<void> {
  await ensureAntonIgnored(repo);
  await git(repo, ['checkout', '--', '.']);
  await git(repo, ['clean', '-fd']);
}

/** sha1 of a work-tree path's content (a symlink's target text, not what it points to); 'missing' if absent. */
async function contentId(repo: string, p: string): Promise<string> {
  const abs = resolve(repo, p);
  const st = await lstat(abs).catch(() => undefined);
  if (!st) return 'missing';
  const h = createHash('sha1');
  if (st.isSymbolicLink()) h.update(`link:${await readlink(abs)}`);
  else if (st.isFile()) h.update(await readFile(abs));
  else h.update(`type:${st.mode}`);
  return h.digest('hex');
}

/**
 * `git status --porcelain` as path -> "XY <content sha1>", untracked files listed one by one, `.anton/`
 * left out. The content id makes a further edit to an already-dirty path show up as a change.
 * A rename/copy entry contributes both its new and its old path.
 */
export async function porcelainStatus(repo: string): Promise<Map<string, string>> {
  await ensureAntonIgnored(repo);
  const parts = (await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
  const out = new Map<string, string>();
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    const paths = [e.slice(3)];
    if (code[0] === 'R' || code[0] === 'C') paths.push(parts[++i] ?? '');
    for (const p of paths) if (p && !p.startsWith('.anton/')) out.set(p, `${code} ${await contentId(repo, p)}`);
  }
  return out;
}

/**
 * Puts repo-relative `paths` back to HEAD: tracked ones via `checkout HEAD --`, others are unstaged and
 * deleted if they are then untracked and not ignored (an ignored file is left alone). Refuses (throws, before touching anything) a path outside the repo, in `.git/` or in `.anton/`.
 */
export async function restorePaths(repo: string, paths: string[]): Promise<void> {
  for (const p of paths) {
    const rel = relative(repo, resolve(repo, p));
    const top = rel.split(/[\\/]/)[0]!.toLowerCase(); // case-insensitive file systems: .GIT is .git
    if (!rel || isAbsolute(p) || isAbsolute(rel) || top === '..' || top === '.git' || top === '.anton') {
      throw new Error(`refusing to restore ${JSON.stringify(p)}: outside the project files`);
    }
  }
  // Literal pathspecs: a file named `*.js` must not match every .js file.
  const lit = ['--literal-pathspecs'];
  const notInHead: string[] = [];
  for (const p of paths) {
    let inHead = true;
    try {
      await git(repo, [...lit, 'cat-file', '-e', `HEAD:${p}`]);
    } catch {
      inHead = false;
    }
    if (inHead) await git(repo, [...lit, 'checkout', '-q', 'HEAD', '--', p]);
    else {
      await git(repo, [...lit, 'rm', '-q', '--cached', '--ignore-unmatch', '--', p]);
      notInHead.push(p);
    }
  }
  if (!notInHead.length) return;
  // Tracked files (a restored .gitignore among them) are back first, so this status sees HEAD's ignore
  // rules: only paths still untracked and not ignored are deleted. Ignored files (.env, node_modules) never are.
  const untracked = new Set((await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0')
    .filter((e) => e.startsWith('?? ')).map((e) => e.slice(3)));
  for (const p of notInHead) if (untracked.has(p)) await rm(resolve(repo, p), { force: true, recursive: true });
}

/** The subset of repo-relative `paths` that git ignores under the current ignore rules. */
export async function ignoredPaths(repo: string, paths: string[]): Promise<Set<string>> {
  if (!paths.length) return new Set();
  const r = await execa('git', [...SAFE, 'check-ignore', '-z', '--stdin'], {
    cwd: repo, env: gitEnv(), extendEnv: false, input: paths.join('\0') + '\0', reject: false,
  });
  if (r.exitCode !== 0 && r.exitCode !== 1) throw new Error(`git check-ignore failed: ${String(r.stderr)}`);
  return new Set(String(r.stdout).split('\0').filter(Boolean));
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

/** Switch to an existing branch (or sha); git refuses if local changes would be lost. */
export async function switchBranch(repo: string, name: string): Promise<void> {
  await git(repo, ['checkout', '-q', name, '--']);
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

/** Tracked paths (`git ls-files`), at most `cap` of them; [] when `repo` is not a git repo. Names only, never contents. */
export async function listFiles(repo: string, cap = 2000): Promise<string[]> {
  try {
    return (await git(repo, ['ls-files', '-z'])).split('\0').filter(Boolean).slice(0, cap);
  } catch {
    return [];
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

/**
 * Clone `url` (untrusted) into `dest` at depth 1 and return its HEAD sha. Same hook/config blocking as
 * every call; `ext::` (runs a command) is refused, and `--` keeps a URL starting with `-` from being an option.
 */
export async function cloneShallow(url: string, dest: string): Promise<string> {
  await mkdir(dirname(dest), { recursive: true });
  await git(dirname(dest), ['-c', 'protocol.ext.allow=never', 'clone', '-q', '--depth', '1', '--no-tags', '--', url, dest]);
  return headSha(dest);
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
