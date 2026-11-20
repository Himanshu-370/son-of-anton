import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { access, chmod, mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { commitAll, tag, headSha, ensureAntonIgnored, listTags, diffSince, revParse, changedFilesSince, isClean, createBranch } from '../../src/core/git.js';

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

  it('listTags returns tags matching a glob pattern', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    expect(await listTags(repo, 'anton/j1/delivered-*')).toEqual([]);
    await tag(repo, 'anton/j1/delivered-1');
    await tag(repo, 'anton/j1/delivered-2');
    await tag(repo, 'anton/j2/delivered-1');
    await tag(repo, 'anton/j1/spec-approved');
    expect((await listTags(repo, 'anton/j1/delivered-*')).sort()).toEqual(['anton/j1/delivered-1', 'anton/j1/delivered-2']);
  });

  it('authors commits as Son of Anton without touching repo config', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    const { stdout } = await git(repo, 'log', '-1', '--format=%an <%ae>');
    expect(stdout).toBe('Son of Anton <anton@localhost>');
    const cfg = await execa('git', ['config', '--local', '--list'], { cwd: repo });
    expect(cfg.stdout).not.toContain('Son of Anton');
  });

  it('does not run repo hooks: a pre-commit hook writing a marker never runs', async () => {
    const marker = join(repo, '..', `${repo.split('/').pop()}-hook-marker`);
    const hook = join(repo, '.git', 'hooks', 'pre-commit');
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\nexit 0\n`);
    await chmod(hook, 0o755);
    await writeFile(join(repo, 'a.txt'), 'a');
    expect(await commitAll(repo, 'first')).toMatch(/^[0-9a-f]{40}$/);
    await expect(access(marker)).rejects.toThrow();
  });

  it('ignores a repo-configured core.hooksPath with a failing hook', async () => {
    const hooks = join(repo, 'evil-hooks');
    await mkdir(hooks);
    await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n');
    await chmod(join(hooks, 'pre-commit'), 0o755);
    await git(repo, 'config', 'core.hooksPath', hooks);
    await writeFile(join(repo, 'a.txt'), 'a');
    expect(await commitAll(repo, 'first')).toMatch(/^[0-9a-f]{40}$/);
  });

  describe('with a hostile inherited environment', () => {
    const saved: Record<string, string | undefined> = {};
    const setEnv = (k: string, v: string) => { saved[k] = process.env[k]; process.env[k] = v; };
    afterEach(() => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    });

    it('ignores the global config (e.g. a clean filter driver) and GIT_AUTHOR_*/GIT_DIR vars', async () => {
      const marker = join(repo, '..', `${repo.split('/').pop()}-filter-marker`);
      const globalCfg = join(repo, '..', `${repo.split('/').pop()}-gitconfig`);
      await writeFile(globalCfg, `[filter "evil"]\n\tclean = touch "${marker}"; cat\n`);
      await writeFile(join(repo, '.gitattributes'), '* filter=evil\n');
      await writeFile(join(repo, 'a.txt'), 'a');
      setEnv('GIT_CONFIG_GLOBAL', globalCfg);
      setEnv('GIT_AUTHOR_NAME', 'Mallory');
      setEnv('GIT_COMMITTER_EMAIL', 'mallory@evil');
      setEnv('GIT_DIR', join(repo, 'nope'));
      setEnv('GIT_WORK_TREE', join(repo, 'nope'));
      const sha = await commitAll(repo, 'first');
      expect(sha).toMatch(/^[0-9a-f]{40}$/);
      await expect(access(marker)).rejects.toThrow();
      for (const k of Object.keys(saved)) delete process.env[k];
      const { stdout } = await git(repo, 'log', '-1', '--format=%an <%ae> / %cn <%ce>');
      expect(stdout).toBe('Son of Anton <anton@localhost> / Son of Anton <anton@localhost>');
    });
  });

  it('ensureAntonIgnored writes .anton/ to .git/info/exclude (not .gitignore), idempotently', async () => {
    await rm(join(repo, '.git', 'info'), { recursive: true, force: true }); // exclude file missing
    await ensureAntonIgnored(repo);
    await ensureAntonIgnored(repo);
    await mkdir(join(repo, '.anton'));
    await writeFile(join(repo, '.anton', 'x'), 'x');
    const { stdout } = await git(repo, 'status', '--porcelain');
    expect(stdout).not.toContain('.anton');
    const lines = (await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).split('\n');
    expect(lines.filter((l) => l === '.anton/')).toHaveLength(1);
    await expect(access(join(repo, '.gitignore'))).rejects.toThrow();
  });

  it('ensureAntonIgnored appends on its own line to an exclude file lacking a newline', async () => {
    await mkdir(join(repo, '.git', 'info'), { recursive: true });
    await writeFile(join(repo, '.git', 'info', 'exclude'), '*.log');
    await ensureAntonIgnored(repo);
    expect((await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8')).split('\n')).toEqual(['*.log', '.anton/', '']);
  });

  it('commitAll never tracks .anton/, even after the agent rewrites .gitignore without it', async () => {
    await writeFile(join(repo, '.gitignore'), '.anton/\n');
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    // the agent overwrites .gitignore and the pipeline writes job files
    await writeFile(join(repo, '.gitignore'), 'node_modules/\n');
    await mkdir(join(repo, '.anton', 'jobs', '1-init'), { recursive: true });
    await writeFile(join(repo, '.anton', 'jobs', '1-init', 'state.json'), '{}');
    await writeFile(join(repo, 'b.txt'), 'b');
    await commitAll(repo, 'second');
    const { stdout } = await git(repo, 'ls-files');
    expect(stdout.split('\n')).toContain('b.txt');
    expect(stdout).not.toContain('.anton');
  });

  it('diffSince returns only the changes after the given sha, and ignores repo hooks', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n');
    const base = (await commitAll(repo, 'first'))!;
    const marker = join(repo, '..', `${repo.split('/').pop()}-diff-marker`);
    await mkdir(join(repo, '.git', 'hooks'), { recursive: true });
    await writeFile(join(repo, '.git', 'hooks', 'post-commit'), `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(join(repo, '.git', 'hooks', 'post-commit'), 0o755);
    await writeFile(join(repo, 'b.txt'), 'two\n');
    await commitAll(repo, 'second');
    const d = await diffSince(repo, base);
    expect(d).toContain('b.txt');
    expect(d).toContain('+two');
    expect(d).not.toContain('a.txt');
    await expect(access(marker)).rejects.toThrow();
  });

  it('diffSince rejects a malformed sha', async () => {
    await expect(diffSince(repo, '--output=/tmp/x')).rejects.toThrow(/invalid sha/);
    await expect(diffSince(repo, 'HEAD~1')).rejects.toThrow(/invalid sha/);
  });

  it('changedFilesSince lists only paths changed after the given sha, and rejects a malformed sha', async () => {
    await writeFile(join(repo, 'a.txt'), 'one\n');
    const base = (await commitAll(repo, 'first'))!;
    await mkdir(join(repo, 'src'), { recursive: true });
    await writeFile(join(repo, 'src', 'b.ts'), 'two\n');
    await commitAll(repo, 'second');
    expect(await changedFilesSince(repo, base)).toEqual(['src/b.ts']);
    await expect(changedFilesSince(repo, '--output=/tmp/x')).rejects.toThrow(/invalid sha/);
  });

  it('revParse resolves a tag to its commit sha and rejects bad refs', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    const sha = (await commitAll(repo, 'first'))!;
    await tag(repo, 'anton/j1/spec-approved');
    expect(await revParse(repo, 'anton/j1/spec-approved')).toBe(sha);
    await expect(revParse(repo, 'anton/j1/missing')).rejects.toThrow();
    await expect(revParse(repo, '--output=/tmp/x')).rejects.toThrow(/invalid ref/);
  });
});

describe('isClean / createBranch', () => {
  it('isClean ignores .anton/ and flags real changes', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    await mkdir(join(repo, '.anton'));
    await writeFile(join(repo, '.anton', 'x'), 'x');
    expect(await isClean(repo)).toBe(true);
    await writeFile(join(repo, 'a.txt'), 'b');
    expect(await isClean(repo)).toBe(false);
  });
  it('createBranch switches, and fails if the branch exists', async () => {
    await writeFile(join(repo, 'a.txt'), 'a');
    await commitAll(repo, 'first');
    await createBranch(repo, 'anton/1-x');
    expect((await git(repo, 'branch', '--show-current')).stdout).toBe('anton/1-x');
    await expect(createBranch(repo, 'anton/1-x')).rejects.toThrow(/already exists/);
  });
});
