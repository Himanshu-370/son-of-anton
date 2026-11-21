import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runAgent, BudgetExceeded, AgentError, AllowanceExceeded, type StageCtx, type ChildLike } from '../../src/agent/host-runner.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import { appendStageUsage, cacheHitRate } from '../../src/core/budget.js';
import type { AgentRequest } from '../../src/agent/protocol.js';

const req: AgentRequest = {
  role: 'builder', model: 'm', effort: 'low', systemPrompt: 's', prompt: 'p', maxTurns: 5, budgetUsd: 5,
};

function fake(chunks: string[], exitCode = 0) {
  const kill = vi.fn();
  const child = {
    stdout: (async function* () { for (const c of chunks) yield c; })(),
    kill,
    then: (ok: (v: { exitCode: number }) => unknown) => Promise.resolve({ exitCode }).then(ok),
  } as unknown as ChildLike;
  return { child, kill };
}
const L = (o: unknown) => JSON.stringify(o) + '\n';

let ctx: StageCtx;
async function setState(over: Partial<JobState>) {
  ctx.state = { ...ctx.state, ...over };
  await saveState(ctx.jobDir, ctx.state);
}

beforeEach(async () => {
  // No config.yaml or plugins.lock here: sessions load no plugins unless a test injects them.
  process.env.ANTON_HOME = await mkdtemp(join(tmpdir(), 'anton-hr-home-'));
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-hr-'));
  const state: JobState = {
    jobId: 'j1', project: 'proj', stage: 'build', round: 1, maxRounds: 3, budgetUsd: 100,
    spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await saveState(jobDir, state);
  ctx = { project: 'proj', repo: '/r', container: 'c', jobDir, state, stage: 'build' };
});

const result = (total: number, output: unknown = { ok: 1 }) =>
  L({ type: 'result', ok: true, output, sessionId: 'sess', totalUsd: total, protocolVersion: 4 });

describe('runAgent', () => {
  it('returns output and sessionId from result event', async () => {
    const f = fake([result(0.1, { a: 1 })]);
    const spawn = vi.fn(() => f.child);
    const r = await runAgent(ctx, req, { spawn, notify: vi.fn() });
    expect(r.output).toEqual({ a: 1 });
    expect(r.sessionId).toBe('sess');
    const [container, args] = spawn.mock.calls[0] as unknown as [string, string[]];
    expect(container).toBe('c');
    expect(args).toEqual([
      'node', '/opt/anton/entry.js',
      `/workspace/.anton/jobs/${basename(ctx.jobDir)}/requests/build-1.json`,
    ]);
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'requests', 'build-1.json'), 'utf8')).role).toBe('builder');
  });

  it('stamps protocolVersion 4 on the request file', async () => {
    await runAgent(ctx, req, { spawn: () => fake([result(0)]).child, notify: vi.fn() });
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'requests', 'build-1.json'), 'utf8')).protocolVersion).toBe(4);
  });

  it('a result without protocolVersion 4 (stale image) throws AgentError and still records its cost', async () => {
    const f = fake([L({ type: 'result', ok: true, output: {}, sessionId: 's', totalUsd: 0.4 })]);
    const p = runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    await expect(p).rejects.toBeInstanceOf(AgentError);
    await expect(runAgent(ctx, req, { spawn: () => fake([L({ type: 'result', ok: true, output: {}, sessionId: 's', totalUsd: 0, protocolVersion: 1 })]).child, notify: vi.fn() }))
      .rejects.toThrow('agent entry is out of date (protocol 1) — run: npm run build:image');
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(0.4);
  });

  it('an error event without protocolVersion (even a budget one) throws the out-of-date AgentError', async () => {
    const f = fake([L({ type: 'error', message: 'x', code: 'budget', totalUsd: 0.1 })]);
    const p = runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    await expect(p).rejects.toBeInstanceOf(AgentError);
    await expect(p).rejects.toThrow('agent entry is out of date (protocol none) — run: npm run build:image');
  });

  it('builder session gets plugin paths, expanded skills and host MCP servers', async () => {
    const plugins = vi.fn(async () => ({
      plugins: ['/opt/anton/plugins/a/cave/0123456789ab'], skills: ['cave:hello'], mcpServers: { db: { command: 'x' } }, used: [],
    }));
    await runAgent({ ...ctx, kit: 'web' }, { ...req, role: 'backend' }, { spawn: () => fake([result(0)]).child, notify: vi.fn(), plugins });
    expect(plugins).toHaveBeenCalledWith(expect.objectContaining({ stage: 'build', kit: 'web' }), 'backend');
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'requests', 'build-1.json'), 'utf8'))).toMatchObject({
      plugins: ['/opt/anton/plugins/a/cave/0123456789ab'], skills: ['cave:hello'], mcpServers: { db: { command: 'x' } },
    });
  });

  it('with no config and no lock a session gets empty plugins, skills and MCP servers', async () => {
    await runAgent(ctx, req, { spawn: () => fake([result(0)]).child, notify: vi.fn() });
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'requests', 'build-1.json'), 'utf8'))).toMatchObject({
      plugins: [], skills: [], mcpServers: {},
    });
  });

  it('read-only request with plugins is refused', async () => {
    const spawn = vi.fn(() => fake([result(0)]).child);
    const plugins = vi.fn();
    await expect(runAgent(ctx, { ...req, tools: ['Read'], plugins: ['/opt/anton/plugins/x'] }, { spawn, notify: vi.fn(), plugins }))
      .rejects.toThrow(new AgentError('read-only sessions cannot load plugins'));
    expect(spawn).not.toHaveBeenCalled();
    // A read-only session never resolves plugins.
    await runAgent(ctx, { ...req, tools: ['Read'] }, { spawn, notify: vi.fn(), plugins });
    expect(plugins).not.toHaveBeenCalled();
  });

  it('numbers request files incrementally', async () => {
    await runAgent(ctx, req, { spawn: () => fake([result(0)]).child, notify: vi.fn() });
    await runAgent(ctx, req, { spawn: () => fake([result(0)]).child, notify: vi.fn() });
    expect((await readdir(join(ctx.jobDir, 'requests'))).sort()).toEqual(['build-1.json', 'build-2.json']);
  });

  it('records cumulative cost as increments', async () => {
    const f = fake([L({ type: 'cost', totalUsd: 0.5 }), L({ type: 'cost', totalUsd: 1.2 }), result(1.5)]);
    const r = await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    expect(r.state.spentUsd).toBeCloseTo(1.5);
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(1.5);
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'cost.json'), 'utf8')).build).toBeCloseTo(1.5);
  });

  it('kills process and throws BudgetExceeded when cap crossed', async () => {
    await setState({ budgetUsd: 1 });
    const f = fake([L({ type: 'cost', totalUsd: 0.6 }), L({ type: 'cost', totalUsd: 1.1 })]);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(f.kill).toHaveBeenCalled();
    expect((await loadState(ctx.jobDir)).spentUsd).toBeGreaterThanOrEqual(1.1);
  });

  it('on error event, cost is still recorded and AgentError thrown', async () => {
    const f = fake([L({ type: 'cost', totalUsd: 0.2 }), L({ type: 'error', message: 'boom', totalUsd: 0.7, protocolVersion: 4 })]);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toThrow(AgentError);
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(0.7);
  });

  it('throws AgentError when process exits without a result', async () => {
    const f = fake([L({ type: 'log', text: 'hi' })], 3);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toThrow(
      'agent exited without a result (exit 3)',
    );
  });

  it('non-JSON lines are logged, not fatal; chunks split mid-line', async () => {
    const line = result(0.1);
    const f = fake(['not json\n', line.slice(0, 10), line.slice(10)]);
    const r = await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    expect(r.sessionId).toBe('sess');
    const log = await readFile(join(ctx.jobDir, 'logs', 'build.log'), 'utf8');
    expect(log).toContain('not json');
    expect(log).toContain('"type":"result"');
  });

  it('notifies once at 80%', async () => {
    await setState({ budgetUsd: 10 });
    ctx.stage = 'verify'; // verify may use 95% cumulative, so 9.5 stays inside its allowance
    const notify = vi.fn();
    const f = fake([L({ type: 'cost', totalUsd: 8.5 }), L({ type: 'cost', totalUsd: 9 }), result(9.5)]);
    await runAgent(ctx, req, { spawn: () => f.child, notify });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith('Son of Anton', 'proj: 80% of budget used');
  });

  it('result over cap returns output without killing', async () => {
    await setState({ budgetUsd: 1 });
    const f = fake([result(1.5, { z: 1 })]);
    const r = await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    expect(r.output).toEqual({ z: 1 });
    expect(f.kill).not.toHaveBeenCalled();
    expect((await loadState(ctx.jobDir)).spentUsd).toBeGreaterThan(1);
  });

  it('interim costs under the cap then a result over the cap returns output without killing (R4, real sequence)', async () => {
    await setState({ budgetUsd: 1 });
    const f = fake([L({ type: 'cost', totalUsd: 0.3 }), L({ type: 'cost', totalUsd: 0.6 }), result(1.4, { done: true })]);
    const r = await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    expect(r.output).toEqual({ done: true });
    expect(f.kill).not.toHaveBeenCalled();
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(1.4);
  });

  it('baseUsd: a resumed call counts only the increment over the transcript total, and returns totalUsd', async () => {
    const f = fake([L({ type: 'cost', totalUsd: 0.9 }), result(1.2)]);
    const r = await runAgent(ctx, { ...req, baseUsd: 0.5 }, { spawn: () => f.child, notify: vi.fn() });
    expect(r.state.spentUsd).toBeCloseTo(0.7, 10);
    expect(r.totalUsd).toBeCloseTo(1.2, 10);
  });

  it('returns totalUsd = last cumulative total (default base 0)', async () => {
    const r = await runAgent(ctx, req, { spawn: () => fake([result(0.3)]).child, notify: vi.fn() });
    expect(r.totalUsd).toBeCloseTo(0.3, 10);
  });

  it('refuses to start with no budget remaining', async () => {
    await setState({ budgetUsd: 1, spentUsd: 1 });
    const spawn = vi.fn(() => fake([result(0)]).child);
    await expect(runAgent(ctx, req, { spawn, notify: vi.fn() })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(spawn).not.toHaveBeenCalled();
    await expect(readdir(join(ctx.jobDir, 'requests'))).rejects.toThrow();
  });

  it('single increment crossing warn and cap notifies once, kills, throws', async () => {
    await setState({ budgetUsd: 1 });
    const notify = vi.fn();
    const f = fake([L({ type: 'cost', totalUsd: 1.2 })]);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(f.kill).toHaveBeenCalledTimes(1);
    expect((await loadState(ctx.jobDir)).warned80).toBe(true);
  });

  it("an error event with code 'budget' (SDK maxBudgetUsd stop) throws BudgetExceeded, cost recorded", async () => {
    const f = fake([L({ type: 'cost', totalUsd: 0.2 }), L({ type: 'error', message: 'error_max_budget_usd', code: 'budget', totalUsd: 0.6, protocolVersion: 4 })]);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toBeInstanceOf(BudgetExceeded);
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(0.6);
  });

  it('a cost.json that cannot be written still updates state.spentUsd (I5)', async () => {
    await mkdir(join(ctx.jobDir, 'cost.json', 'x'), { recursive: true }); // a folder: the write fails
    const warn = vi.fn();
    ctx.warn = warn;
    const r = await runAgent(ctx, req, { spawn: () => fake([result(0.4, { ok: 2 })]).child, notify: vi.fn() });
    expect(r.output).toEqual({ ok: 2 });
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(0.4);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('cost.json'));
  });

  it('a usage.json that is a folder still returns the finished result (I5)', async () => {
    await mkdir(join(ctx.jobDir, 'usage.json', 'x'), { recursive: true });
    const usage = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    const f = fake([L({ type: 'result', ok: true, output: { ok: 3 }, sessionId: 's', totalUsd: 0.1, usage, protocolVersion: 4 })]);
    expect((await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).output).toEqual({ ok: 3 });
  });

  it("a usage.json that is a folder does not mask a 'budget' error event (I5)", async () => {
    await mkdir(join(ctx.jobDir, 'usage.json', 'x'), { recursive: true });
    const usage = { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 };
    const ev = L({ type: 'error', message: 'error_max_budget_usd', code: 'budget', totalUsd: 0.6, usage, protocolVersion: 4 });
    const p = runAgent(ctx, req, { spawn: () => fake([ev]).child, notify: vi.fn() });
    await expect(p).rejects.toBeInstanceOf(BudgetExceeded);
    await setState({ budgetUsd: 10, spentUsd: 6, stageSpentUsd: { build: 6 } });
    const q = runAgent(ctx, req, { spawn: () => fake([ev]).child, notify: vi.fn() });
    await expect(q).rejects.toBeInstanceOf(AllowanceExceeded);
  });

  it('error event crossing cap throws AgentError', async () => {
    await setState({ budgetUsd: 1 });
    const f = fake([L({ type: 'error', message: 'boom', totalUsd: 1.5, protocolVersion: 4 })]);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toThrow(AgentError);
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(1.5);
  });
});

describe('runAgent unattended rule', () => {
  const sent = async (c: StageCtx, r: AgentRequest) => {
    await runAgent(c, r, { spawn: vi.fn(() => fake([result(0.1)]).child), notify: vi.fn() });
    return JSON.parse(await readFile(join(c.jobDir, 'requests', `${c.stage}-1.json`), 'utf8')).systemPrompt as string;
  };
  it('unattended instruction appended outside spec', async () => {
    const sp = await sent(ctx, req);
    expect(sp.startsWith('s\n\n')).toBe(true);
    expect(sp).toContain('no human is present');
    expect(sp.trimEnd().split('\n').pop()).toContain('/workspace/.anton/jobs/j1/questions.md');
    expect(sp).not.toContain('{jobId}');
    // read-only reviewer sessions get it too
    ctx.stage = 'verify';
    expect(await sent(ctx, { ...req, tools: ['Read'] })).toContain('no human is present');
  });
  it('spec session has no unattended instruction', async () => {
    ctx.stage = 'spec';
    expect(await sent(ctx, req)).toBe('s');
  });
});

describe('runAgent redaction', () => {
  it('agent log line containing the secret is saved redacted; request file too', async () => {
    ctx.secrets = { API_KEY: 'FAKE_SECRET_VALUE_123' };
    const f = fake([L({ type: 'log', text: 'saw FAKE_SECRET_VALUE_123' }), result(0)]);
    await runAgent(ctx, { ...req, prompt: 'use FAKE_SECRET_VALUE_123' }, { spawn: () => f.child, notify: vi.fn() });
    const log = await readFile(join(ctx.jobDir, 'logs', 'build.log'), 'utf8');
    expect(log).not.toContain('FAKE_SECRET_VALUE_123');
    expect(log).toContain('[REDACTED:API_KEY]');
    const reqText = await readFile(join(ctx.jobDir, 'requests', 'build-1.json'), 'utf8');
    expect(reqText).not.toContain('FAKE_SECRET_VALUE_123');
    expect(JSON.parse(reqText).prompt).toBe('use [REDACTED:API_KEY]');
  });

  describe('stage allowances', () => {
    const reqFile = async (name: string) => JSON.parse(await readFile(join(ctx.jobDir, 'requests', name), 'utf8'));

    it('session budget is clamped to the allowance', async () => {
      // $10 cap: build may use $7.00 cumulative; $6.00 is gone, so $1.00 is left.
      await setState({ budgetUsd: 10, spentUsd: 6, stageSpentUsd: { plan: 1, build: 5 } });
      await runAgent(ctx, req, { spawn: () => fake([result(0.1)]).child, notify: vi.fn() });
      expect((await reqFile('build-1.json')).budgetUsd).toBeCloseTo(1);
    });

    it('session budget is clamped to the job remainder for a stage outside the allowance groups', async () => {
      await setState({ budgetUsd: 10, spentUsd: 9, stageSpentUsd: { build: 9 } });
      ctx.stage = 'plugin-review';
      await runAgent(ctx, { ...req, tools: ['Read'] }, { spawn: () => fake([result(0.1)]).child, notify: vi.fn() });
      expect((await reqFile('plugin-review-1.json')).budgetUsd).toBeCloseTo(1);
    });

    it('allowance used up throws AllowanceExceeded before spawning', async () => {
      await setState({ budgetUsd: 10, spentUsd: 7, stageSpentUsd: { spec: 1, plan: 1, build: 5 } });
      const spawn = vi.fn(() => fake([result(0)]).child);
      const p = runAgent(ctx, req, { spawn, notify: vi.fn() });
      await expect(p).rejects.toBeInstanceOf(AllowanceExceeded);
      await expect(p).rejects.toBeInstanceOf(BudgetExceeded);
      await expect(p).rejects.toMatchObject({ group: 'build', spentUsd: 7, limitUsd: 7 });
      expect(spawn).not.toHaveBeenCalled();
    });

    it('mid-call allowance overrun kills the session', async () => {
      await setState({ budgetUsd: 10, spentUsd: 6.5, stageSpentUsd: { build: 6.5 } });
      const f = fake([L({ type: 'cost', totalUsd: 0.3 }), L({ type: 'cost', totalUsd: 0.6 }), result(0.7)]);
      await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toBeInstanceOf(AllowanceExceeded);
      expect(f.kill).toHaveBeenCalledTimes(1);
      expect((await loadState(ctx.jobDir)).stageSpentUsd).toEqual({ build: expect.closeTo(7.1, 5) });
    });

    it("the SDK's budget stop on an allowance-bound session is AllowanceExceeded", async () => {
      await setState({ budgetUsd: 10, spentUsd: 6, stageSpentUsd: { build: 6 } });
      const f = fake([L({ type: 'error', message: 'error_max_budget_usd', code: 'budget', totalUsd: 0.9, protocolVersion: 4 })]);
      await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toBeInstanceOf(AllowanceExceeded);
    });

    it('a result over the allowance returns output without killing (R4)', async () => {
      await setState({ budgetUsd: 10, spentUsd: 6.5, stageSpentUsd: { build: 6.5 } });
      const f = fake([result(0.8, { done: 1 })]);
      expect((await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).output).toEqual({ done: 1 });
      expect(f.kill).not.toHaveBeenCalled();
    });

    it('spec over its share warns and continues up to the job cap', async () => {
      await setState({ stage: 'spec', budgetUsd: 10, spentUsd: 1, stageSpentUsd: { spec: 1 } });
      ctx.stage = 'spec';
      const warn = vi.fn();
      ctx.warn = warn;
      const f = fake([L({ type: 'cost', totalUsd: 2 }), result(2.5, { s: 1 })]);
      expect((await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).output).toEqual({ s: 1 });
      expect(f.kill).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith('Spec has used its 10% share ($1.00); continuing up to the job cap.');
      expect((await reqFile('spec-1.json')).budgetUsd).toBeCloseTo(5);
    });
  });
});

describe('usage tracking', () => {
  const usageJson = async () => JSON.parse(await readFile(join(ctx.jobDir, 'usage.json'), 'utf8'));
  const u = (input: number, output: number, cacheRead: number, cacheWrite: number) => ({ input, output, cacheRead, cacheWrite });

  it('usage.json accumulates per stage', async () => {
    await appendStageUsage(ctx.jobDir, 'build', u(1, 2, 3, 4));
    await appendStageUsage(ctx.jobDir, 'build', u(10, 20, 30, 40));
    await appendStageUsage(ctx.jobDir, 'plan', u(5, 0, 0, 0));
    expect(await usageJson()).toEqual({ build: u(11, 22, 33, 44), plan: u(5, 0, 0, 0) });
    // runAgent records the terminal event's usage, on result and on error.
    const f = fake([L({ type: 'result', ok: true, output: {}, sessionId: 's', totalUsd: 0.1, usage: u(1, 1, 1, 1), protocolVersion: 4 })]);
    await runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() });
    const e = fake([L({ type: 'error', message: 'x', totalUsd: 0.2, usage: u(2, 0, 2, 0), protocolVersion: 4 })]);
    await expect(runAgent(ctx, req, { spawn: () => e.child, notify: vi.fn() })).rejects.toBeInstanceOf(AgentError);
    expect((await usageJson()).build).toEqual(u(14, 23, 36, 45));
    // A garbage usage.json (container-writable) is replaced, not fatal.
    const { writeFile } = await import('node:fs/promises');
    await writeFile(join(ctx.jobDir, 'usage.json'), '{"build": "x", "constructor": 1');
    await appendStageUsage(ctx.jobDir, 'build', u(1, 0, 0, 0));
    expect(await usageJson()).toEqual({ build: u(1, 0, 0, 0) });
  });

  it('cache hit rate formula and empty case', () => {
    expect(cacheHitRate(u(100, 999, 620, 280))).toBeCloseTo(0.62);
    expect(cacheHitRate(u(0, 50, 0, 0))).toBeUndefined();
  });

  describe('task budgets', () => {
    const sonnet = { ...req, model: 'claude-sonnet-5-5' };
    const sent = async () => JSON.parse(await readFile(join(ctx.jobDir, 'requests', 'build-1.json'), 'utf8')).taskBudgetTokens;
    const go = (r: AgentRequest) => runAgent(ctx, r, { spawn: () => fake([result(0)]).child, notify: vi.fn() });

    it('task budget follows the clamped dollar cap', async () => {
      await go({ ...sonnet, budgetUsd: 3 });
      expect(await sent()).toBe(1_500_000);
    });

    it('task budget is capped at 5M', async () => {
      await go({ ...sonnet, budgetUsd: 50 });
      expect(await sent()).toBe(5_000_000);
    });

    it('a task budget under the API minimum (20,000 tokens) is not sent (I3)', async () => {
      await go({ ...sonnet, budgetUsd: 0.03 }); // 15,000 tokens at sonnet's input price
      expect(await sent()).toBeUndefined();
    });

    it('a task budget of exactly 20,000 tokens is sent (I3)', async () => {
      await go({ ...sonnet, budgetUsd: 0.04 });
      expect(await sent()).toBe(20_000);
    });

    it('taskBudgets: false sends no task budget', async () => {
      await writeFile(join(process.env.ANTON_HOME!, 'config.yaml'), 'budget:\n  taskBudgets: false\n');
      await go({ ...sonnet, budgetUsd: 3 });
      expect(await sent()).toBeUndefined();
    });
  });
});
