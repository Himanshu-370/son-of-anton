import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { commitAll, tag, headSha, ensureAntonIgnored } from '../../src/core/git.js';

const git = (repo: string, ...args: string[]) =>
  execa('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: repo });

let repo: string;

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'anton-git-'));
  await git(repo, 'init', '-q');
});
afterEach(async () => {
  await rm(repo, { recursive: true, force: true });
});

describe('git helper', () => {
  it('commits in a fresh repo and returns a 40-char sha', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    const sha = await commitAll(repo, 'first');
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(await headSha(repo)).toBe(sha);
  });

  it('returns null when there is nothing to commit', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    expect(await commitAll(repo, 'second')).toBeNull();
  });

  it('tag creates a tag', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    await tag(repo, 'v1');
    const { stdout } = await git(repo, 'tag', '-l');
    expect(stdout.split('\n')).toContain('v1');
  });

  it('authors commits as Son of Anton without touching repo config', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    const { stdout } = await git(repo, 'log', '-1', '--format=%an <%ae>');
    expect(stdout).toBe('Son of Anton <anton@localhost>');
    const cfg = await execa('git', ['config', '--local', '--list'], { cwd: repo });
    expect(cfg.stdout).not.toContain('Son of Anton');
  });

  it('ensureAntonIgnored hides .anton/ and is idempotent', async () => {
    await ensureAntonIgnored(repo);
    await ensureAntonIgnored(repo);
    await mkdir(join(repo, '.anton'));
    await writeFile(join(repo, '.anton', 'x'), 'x');
    const { stdout } = await git(repo, 'status', '--porcelain');
    expect(stdout).not.toContain('.anton');
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(join(repo, '.gitignore'), 'utf8')).split('\n');
    expect(lines.filter((l) => l === '.anton/')).toHaveLength(1);
  });

  it('ensureAntonIgnored appends on its own line to an existing file lacking a newline', async () => {
    await writeFile(join(repo, '.gitignore'), 'node_modules');
    await ensureAntonIgnored(repo);
    const { readFile } = await import('node:fs/promises');
    expect((await readFile(join(repo, '.gitignore'), 'utf8')).split('\n')).toEqual([
      'node_modules',
      '.anton/',
      '',
    ]);
  });
});
