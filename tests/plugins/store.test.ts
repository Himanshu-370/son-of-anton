import { appendFile, mkdtemp, readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { parseSpecifier } from '../../src/plugins/marketplace.js';
import { installPlugin, readLock, treeHash, verifyInstalled } from '../../src/plugins/store.js';
import { bareRepo, fakeClone, marketplace } from './fixture.js';

const MKT = 'https://github.com/acme/mkt.git';
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-store-'));
});

async function pluginsFolder(): Promise<string[]> {
  return readdir(join(home, 'plugins')).catch(() => []);
}

describe('parseSpecifier', () => {
  it('owner/repo becomes a github URL', () => {
    expect(parseSpecifier('cave@acme/mkt')).toEqual({ plugin: 'cave', marketplace: 'acme/mkt', url: MKT });
  });
  it('https git URL is kept', () => {
    expect(parseSpecifier('cave@https://example.com/a/b.git')).toEqual({
      plugin: 'cave', marketplace: 'https://example.com/a/b.git', url: 'https://example.com/a/b.git',
    });
  });
  it.each(['cave', 'cave@acme', '../x@acme/mkt', 'cave@file:///tmp/x', 'cave@http://e.com/a.git', 'cave@ext::sh -c x', 'cave@https://u:p@e.com/a.git'])(
    'rejects %s', (s) => {
      expect(() => parseSpecifier(s)).toThrow('Use <plugin>@<owner>/<repo> or <plugin>@<git url>');
    });
});

describe('installPlugin', () => {
  it('add pins name, version, commit and hash', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { plugin: { 'hooks/run.sh': 'echo hi\n' } }) });
    const e = await installPlugin('cave@acme/mkt', { home, clone });
    expect(e).toMatchObject({ name: 'cave', marketplace: 'acme/mkt', url: MKT, version: '1.0.0' });
    expect(e.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(e.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(e.dir).toBe(`acme-mkt/cave/${e.commit.slice(0, 12)}`);
    const dir = join(home, 'plugins', e.dir);
    expect(await readFile(join(dir, 'skills/hello/SKILL.md'), 'utf8')).toBe('# hello\n');
    expect(await treeHash(dir)).toBe(e.sha256);
    expect(await readLock(home)).toEqual([e]);
    await expect(verifyInstalled(e, home)).resolves.toBeUndefined();
  });

  it('missing plugin.json gives unversioned; lock:false + destRoot leaves the lock alone', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { version: null }) });
    const staging = join(home, 'staging');
    const e = await installPlugin('cave@acme/mkt', { home, clone }, { lock: false, destRoot: staging });
    expect(e.version).toBe('unversioned');
    expect(await treeHash(join(staging, e.dir))).toBe(e.sha256);
    expect(await readLock(home)).toEqual([]);
    expect(await pluginsFolder()).toEqual([]);
  });

  it('whole-repo source "./" skips .git', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { source: './' }) });
    const e = await installPlugin('cave@acme/mkt', { home, clone });
    const dir = join(home, 'plugins', e.dir);
    expect(await readdir(dir)).not.toContain('.git');
    expect(await readdir(dir)).toContain('plugins');
  });

  it('github object source is cloned and pinned at its own commit', async () => {
    const pluginRepo = await bareRepo({ 'skills/x/SKILL.md': 'x\n', '.claude-plugin/plugin.json': '{"version":"2.0.0"}' });
    const clone = fakeClone({
      [MKT]: await marketplace('cave', { source: { source: 'github', repo: 'acme/cave' } }),
      'https://github.com/acme/cave.git': pluginRepo,
    });
    const e = await installPlugin('cave@acme/mkt', { home, clone });
    expect(e.version).toBe('2.0.0');
    expect(await readdir(join(home, 'plugins', e.dir))).toEqual(['.claude-plugin', 'skills']);
  });

  it('relative source escaping the clone is refused', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { source: '../..' }) });
    await expect(installPlugin('cave@acme/mkt', { home, clone })).rejects.toThrow(/outside the marketplace/);
    expect(await readLock(home)).toEqual([]);
    expect(await pluginsFolder()).toEqual([]);
  });

  it('relative source escaping through a symlink is refused', async () => {
    const url = await bareRepo(
      { '.claude-plugin/marketplace.json': JSON.stringify({ plugins: [{ name: 'cave', source: './out' }] }) },
      { out: '/tmp' },
    );
    await expect(installPlugin('cave@acme/mkt', { home, clone: fakeClone({ [MKT]: url }) })).rejects.toThrow(/outside the marketplace/);
    expect(await pluginsFolder()).toEqual([]);
  });

  it('unsupported source type is refused', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { source: { source: 'npm', package: 'x' } }) });
    await expect(installPlugin('cave@acme/mkt', { home, clone })).rejects.toThrow('Unsupported plugin source "npm" for cave');
    expect(await readLock(home)).toEqual([]);
    expect(await pluginsFolder()).toEqual([]);
  });

  it('url object source must be https', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { source: { source: 'url', url: 'file:///etc' } }) });
    await expect(installPlugin('cave@acme/mkt', { home, clone })).rejects.toThrow(/https/);
  });

  it('plugin missing from the marketplace is refused', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave') });
    await expect(installPlugin('other@acme/mkt', { home, clone })).rejects.toThrow('Plugin other not found in the marketplace');
  });

  it('symlink inside the plugin is refused', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave', { links: { 'skills/evil': '/etc' } }) });
    await expect(installPlugin('cave@acme/mkt', { home, clone })).rejects.toThrow('Plugin contains a symlink: skills/evil');
    expect(await readLock(home)).toEqual([]);
    expect(await pluginsFolder()).toEqual([]);
  });

  it('same name from another marketplace is refused', async () => {
    const other = 'https://github.com/evil/mkt.git';
    const clone = fakeClone({ [MKT]: await marketplace('cave'), [other]: await marketplace('cave') });
    const first = await installPlugin('cave@acme/mkt', { home, clone });
    await expect(installPlugin('cave@evil/mkt', { home, clone })).rejects.toThrow(/already installed from acme\/mkt/);
    expect(await readLock(home)).toEqual([first]);
    expect(await pluginsFolder()).toEqual(['acme-mkt']);
  });

  it('re-adding from the same marketplace replaces the entry', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave') });
    await installPlugin('cave@acme/mkt', { home, clone });
    const again = await installPlugin('cave@acme/mkt', { home, clone });
    expect(await readLock(home)).toEqual([again]);
  });

  it('verifyInstalled detects an edited file', async () => {
    const clone = fakeClone({ [MKT]: await marketplace('cave') });
    const e = await installPlugin('cave@acme/mkt', { home, clone });
    await appendFile(join(home, 'plugins', e.dir, 'skills/hello/SKILL.md'), 'injected\n');
    await expect(verifyInstalled(e, home)).rejects.toThrow(
      'Plugin cave changed on disk since install — run: anton plugins update cave',
    );
  });
});
