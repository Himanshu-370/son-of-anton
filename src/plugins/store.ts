import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, rename, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { writeFileAtomic } from '../core/atomic.js';
import { cloneShallow, headSha } from '../core/git.js';
import { antonHome } from '../core/paths.js';
import { marketplaceSlug, parseSpecifier, PLUGIN_NAME, resolvePluginDir, type Clone } from './marketplace.js';

const LockEntrySchema = z.object({
  name: z.string().regex(PLUGIN_NAME),
  marketplace: z.string(),
  url: z.string(),
  version: z.string(),
  commit: z.string().regex(/^[0-9a-f]{40,64}$/),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  // Relative to <home>/plugins; later joined into host and container paths, so no `..` can get in.
  dir: z.string().regex(/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9-]*\/[0-9a-f]{12}$/),
});
export type LockEntry = z.infer<typeof LockEntrySchema>;

const lockPath = (home: string) => join(home, 'plugins.lock');

export async function readLock(home = antonHome()): Promise<LockEntry[]> {
  let text: string;
  try {
    text = await readFile(lockPath(home), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  try {
    return z.array(LockEntrySchema).parse(JSON.parse(text));
  } catch (e) {
    throw new Error(`Invalid ~/anton/plugins.lock: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function writeLock(entries: LockEntry[], home = antonHome()): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.name.localeCompare(b.name));
  await writeFileAtomic(lockPath(home), `${JSON.stringify(sorted, null, 2)}\n`);
}

const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

/** sha256 over sorted `<relpath>\0<x|->\0<sha256(content)>` lines; skips `.git`, refuses symlinks. */
export async function treeHash(dir: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    for (const name of await readdir(join(dir, rel))) {
      if (name === '.git') continue;
      const r = rel ? `${rel}/${name}` : name;
      const st = await lstat(join(dir, r));
      if (st.isSymbolicLink()) throw new Error(`Plugin contains a symlink: ${r}`);
      if (st.isDirectory()) await walk(r);
      else if (st.isFile()) lines.push(`${r}\0${st.mode & 0o111 ? 'x' : '-'}\0${sha256(await readFile(join(dir, r)))}`);
      else throw new Error(`Plugin contains an unsupported file type: ${r}`);
    }
  };
  await walk('');
  return sha256(lines.sort().join('\n'));
}

async function pluginVersion(dir: string): Promise<string> {
  try {
    const v = (JSON.parse(await readFile(join(dir, '.claude-plugin', 'plugin.json'), 'utf8')) as { version?: unknown }).version;
    return typeof v === 'string' && v.trim() ? v.trim() : 'unversioned';
  } catch {
    return 'unversioned';
  }
}

const exists = (p: string) => lstat(p).then(() => true, () => false);

export type StoreDeps = { home?: string; clone?: Clone };

/**
 * Clone the marketplace, copy the plugin (no `.git`) to `<destRoot>/<marketplace-slug>/<plugin>/<commit12>/`
 * and, unless `lock: false`, pin it in plugins.lock. A refused plugin leaves the lock and folder untouched;
 * an already pinned name is a no-op at the same commit and hash, otherwise refused (use `plugins update`).
 */
export async function installPlugin(
  spec: string,
  deps: StoreDeps = {},
  opts: { lock?: boolean; destRoot?: string } = {},
): Promise<LockEntry> {
  const home = deps.home ?? antonHome();
  const clone = deps.clone ?? cloneShallow;
  const destRoot = opts.destRoot ?? join(home, 'plugins');
  const { plugin, marketplace, url } = parseSpecifier(spec);
  const slug = marketplaceSlug(marketplace);
  const lock = await readLock(home);
  const clash = lock.find((e) => e.name === plugin && e.marketplace !== marketplace);
  if (clash) throw new Error(`Plugin ${plugin} is already installed from ${clash.marketplace}; plugin names must be unique`);

  const tmp = await mkdtemp(join(tmpdir(), 'anton-plugin-'));
  let staging: string | undefined;
  try {
    const cloneDir = join(tmp, 'marketplace');
    await clone(url, cloneDir);
    const src = await resolvePluginDir(cloneDir, plugin, clone);
    const hash = await treeHash(src); // refuses symlinks before anything is written
    const commit = await headSha(src);
    const entry: LockEntry = {
      name: plugin, marketplace, url, version: await pluginVersion(src), commit, sha256: hash,
      dir: `${slug}/${plugin}/${commit.slice(0, 12)}`,
    };
    // No silent updates (§10.1): moving a pin is `anton plugins update`'s job. Staging installs skip this.
    const pinned = (opts.lock ?? true) ? lock.find((e) => e.name === plugin) : undefined;
    if (pinned) {
      if (pinned.commit === commit && pinned.sha256 === hash) return pinned;
      throw new Error(`Plugin ${plugin} is already installed at ${pinned.commit.slice(0, 12)} — run: anton plugins update ${plugin}`);
    }
    const dest = join(destRoot, entry.dir);
    if (await exists(dest)) {
      // Folders are immutable: an existing one is reused only if it is byte-identical.
      if ((await treeHash(dest).catch(() => null)) !== hash) throw new Error(`${dest} exists with different content; remove it and retry`);
    } else {
      // Copy beside the target (same file system), then rename into place.
      staging = join(destRoot, `.staging-${randomUUID()}`);
      await cp(src, staging, { recursive: true, filter: (p) => basename(p) !== '.git', verbatimSymlinks: true });
      if ((await treeHash(staging)) !== hash) throw new Error(`Plugin ${plugin} changed while being copied`);
      await mkdir(dirname(dest), { recursive: true });
      await rename(staging, dest);
      staging = undefined;
    }
    if (opts.lock ?? true) await writeLock([...lock.filter((e) => e.name !== plugin), entry], home);
    return entry;
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true });
    await rm(tmp, { recursive: true, force: true });
  }
}

export async function verifyInstalled(entry: LockEntry, home = antonHome()): Promise<void> {
  if ((await treeHash(join(home, 'plugins', entry.dir)).catch(() => null)) !== entry.sha256) {
    throw new Error(`Plugin ${entry.name} changed on disk since install — run: anton plugins update ${entry.name}`);
  }
}
