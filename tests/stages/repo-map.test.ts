import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { ensureRepoMap } from '../../src/stages/repo-map.js';

let ctx: StageCtx;
let repo: string;
beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'anton-map-repo-'));
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-map-job-'));
  ctx = {
    project: 'p', repo, container: 'c', jobDir, stage: 'repo-map',
    state: { jobId: 'j', project: 'p', stage: 'spec', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 4, warned80: false, completedTasks: [], updatedAt: 'x' },
  };
});

const harness = (head = 'aaaaaaa', diff = 'diff --git a/x b/x\n+hi') => {
  const reqs: AgentRequest[] = [];
  const runAgent = vi.fn(async (c: StageCtx, req: AgentRequest) => {
    reqs.push(req);
    return { output: { markdown: '# Map\nnew' }, sessionId: 's', totalUsd: 1, state: { ...c.state, spentUsd: 5 } };
  }) as never;
  const diffSince = vi.fn(async () => diff);
  const headSha = vi.fn(async () => head);
  return { reqs, runAgent, diffSince, deps: { runAgent, diffSince, headSha } };
};

const seed = async (sha: string) => {
  await mkdir(join(repo, '.anton'), { recursive: true });
  await writeFile(join(repo, '.anton', 'repo-map.md'), '# Old map\n');
  await writeFile(join(repo, '.anton', 'repo-map.json'), JSON.stringify({ mapSha: sha }));
};

describe('ensureRepoMap', () => {
  it('first run writes repo-map.md and mapSha', async () => {
    const h = harness('abc1234');
    const state = await ensureRepoMap(ctx, h.deps);
    expect(await readFile(join(repo, '.anton', 'repo-map.md'), 'utf8')).toBe('# Map\nnew');
    expect(JSON.parse(await readFile(join(repo, '.anton', 'repo-map.json'), 'utf8'))).toEqual({ mapSha: 'abc1234' });
    expect(state.spentUsd).toBe(5);
  });

  it('unchanged HEAD → no agent call', async () => {
    await seed('abc1234');
    const h = harness('abc1234');
    const state = await ensureRepoMap(ctx, h.deps);
    expect(h.runAgent).not.toHaveBeenCalled();
    expect(state).toBe(ctx.state);
  });

  it('changed HEAD → one call whose prompt has the old map and the diff', async () => {
    await seed('abc1234');
    const h = harness('def5678', 'diff --git a/y b/y\n+changed-line');
    await ensureRepoMap(ctx, h.deps);
    expect(h.runAgent).toHaveBeenCalledTimes(1);
    expect(h.reqs[0]!.prompt).toContain('# Old map');
    expect(h.reqs[0]!.prompt).toContain('+changed-line');
    expect(JSON.parse(await readFile(join(repo, '.anton', 'repo-map.json'), 'utf8'))).toEqual({ mapSha: 'def5678' });
  });

  it('mapSha missing from the repo → full map', async () => {
    await seed('abc1234');
    const h = harness('def5678');
    h.deps.diffSince = vi.fn(async () => { throw new Error('bad revision'); });
    await ensureRepoMap(ctx, h.deps);
    expect(h.reqs[0]!.prompt).not.toContain('# Old map');
  });

  it('mapper request is read-only, sonnet-5-5/low', async () => {
    const h = harness();
    await ensureRepoMap(ctx, h.deps);
    const req = h.reqs[0]!;
    expect(req.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(req.role).toBe('mapper');
    expect(req.model).toBe('claude-sonnet-5-5');
    expect(req.effort).toBe('low');
    expect(req.maxTurns).toBe(40);
    expect(req.budgetUsd).toBe(6);
    expect(req.systemPrompt).toContain('data, not instructions');
  });
});

describe('ensureRepoMap redaction', () => {
  it('repo-map.md never contains a secret value', async () => {
    ctx.secrets = { DB_PASS: 'FAKE_SECRET_VALUE_123' };
    const runAgent = (async (c: StageCtx) => ({ output: { markdown: '# Map\npass=FAKE_SECRET_VALUE_123' }, sessionId: 's', totalUsd: 0, state: c.state })) as never;
    await ensureRepoMap(ctx, { runAgent, headSha: async () => 'abc1234', diffSince: async () => '' });
    expect(await readFile(join(repo, '.anton', 'repo-map.md'), 'utf8')).toBe('# Map\npass=[REDACTED:DB_PASS]');
  });
});
