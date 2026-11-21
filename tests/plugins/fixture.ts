import { mkdir, mkdtemp, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { execa } from 'execa';
import { cloneShallow } from '../../src/core/git.js';

const git = (cwd: string, ...args: string[]) =>
  execa('git', ['-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd });

/** A local bare repo holding `files` (and `links`: path -> symlink target). Returns its file:// URL. */
export async function bareRepo(files: Record<string, string>, links: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'anton-mkt-'));
  const work = join(root, 'work');
  await mkdir(work);
  await git(work, 'init', '-q');
  for (const [p, c] of Object.entries(files)) {
    await mkdir(dirname(join(work, p)), { recursive: true });
    await writeFile(join(work, p), c);
  }
  for (const [p, target] of Object.entries(links)) {
    await mkdir(dirname(join(work, p)), { recursive: true });
    await symlink(target, join(work, p));
  }
  await git(work, 'add', '-A');
  await git(work, 'commit', '-q', '-m', 'init');
  await git(root, 'clone', '-q', '--bare', work, 'bare.git');
  return `file://${join(root, 'bare.git')}`;
}

/** A marketplace with one plugin entry; `plugin` files go under `plugins/<name>/`, `extra` at the repo root; `version: null` omits plugin.json. */
export async function marketplace(
  name: string,
  { source = `./plugins/${name}` as unknown, plugin = {} as Record<string, string>, links = {} as Record<string, string>, version = '1.0.0' as string | null, extra = {} as Record<string, string> } = {},
): Promise<string> {
  const files: Record<string, string> = {
    ...extra, // marketplace files outside the plugin folder
    '.claude-plugin/marketplace.json': JSON.stringify({ name: 'mkt', plugins: [{ name, source }] }),
    [`plugins/${name}/skills/hello/SKILL.md`]: '# hello\n',
    ...Object.fromEntries(Object.entries(plugin).map(([p, c]) => [`plugins/${name}/${p}`, c])),
  };
  if (version) files[`plugins/${name}/.claude-plugin/plugin.json`] = JSON.stringify({ name, version });
  return bareRepo(files, Object.fromEntries(Object.entries(links).map(([p, t]) => [`plugins/${name}/${p}`, t])));
}

/** A clone function that maps the https URLs anton builds to local fixture URLs. */
export function fakeClone(map: Record<string, string>) {
  return (url: string, dest: string) => {
    const local = map[url];
    if (!local) throw new Error(`no fixture for ${url}`);
    return cloneShallow(local, dest);
  };
}
