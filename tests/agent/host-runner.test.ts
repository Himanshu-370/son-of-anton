import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { runAgent, BudgetExceeded, AgentError, type StageCtx, type ChildLike } from '../../src/agent/host-runner.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
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
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-hr-'));
  const state: JobState = {
    jobId: 'j1', project: 'proj', stage: 'build', round: 1, maxRounds: 3, budgetUsd: 100,
    spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '2026-01-01T00:00:00.000Z',
  };
  await saveState(jobDir, state);
  ctx = { project: 'proj', repo: '/r', container: 'c', jobDir, state, stage: 'build' };
});

const result = (total: number, output: unknown = { ok: 1 }) =>
  L({ type: 'result', ok: true, output, sessionId: 'sess', totalUsd: total });

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
    const f = fake([L({ type: 'cost', totalUsd: 0.2 }), L({ type: 'error', message: 'boom', totalUsd: 0.7 })]);
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

  it('error event crossing cap throws AgentError', async () => {
    await setState({ budgetUsd: 1 });
    const f = fake([L({ type: 'error', message: 'boom', totalUsd: 1.5 })]);
    await expect(runAgent(ctx, req, { spawn: () => f.child, notify: vi.fn() })).rejects.toThrow(AgentError);
    expect((await loadState(ctx.jobDir)).spentUsd).toBeCloseTo(1.5);
  });
});
