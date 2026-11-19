import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceeded, type StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { loadState, type JobState } from '../../src/core/state.js';
import { runBuild } from '../../src/stages/build.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 's', outOfScope: [], kit: 'fallback', tech: ['python'],
  acceptanceChecks: [{ id: 'AC-1', text: 'sums' }],
};
const plan: Plan = {
  commands: { install: 'pip install -e .', test: 'pytest --junitxml="$ANTON_JUNIT"' },
  tasks: [
    { id: 'T1', title: 'scaffold', acceptanceChecks: [], instructions: 'make scaffold' },
    { id: 'T2', title: 'sum args', acceptanceChecks: ['AC-1'], instructions: 'implement sum' },
    { id: 'T3', title: 'polish', acceptanceChecks: [], instructions: 'polish it' },
  ],
};

let ctx: StageCtx;
const baseState = (over: Partial<JobState> = {}): JobState => ({
  jobId: 'j1', project: 'p', stage: 'build', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
  warned80: false, completedTasks: [], updatedAt: 'x', ...over,
});
beforeEach(async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-build-'));
  ctx = { project: 'p', repo: '/r', container: 'c', jobDir, stage: 'build', state: baseState() };
});

function fakes() {
  const reqs: AgentRequest[] = [];
  const events: string[] = [];
  const runAgent = vi.fn(async (c: StageCtx, req: AgentRequest) => {
    reqs.push(req);
    events.push(`agent:${c.state.completedTasks.join(',')}`);
    return { output: 'ok', sessionId: `s${reqs.length}`, state: { ...c.state, spentUsd: c.state.spentUsd + 1 } };
  });
  const commitAll = vi.fn(async (_repo: string, msg: string) => { events.push(`commit:${msg}`); return 'sha'; });
  return { reqs, events, deps: { runAgent: runAgent as never, commitAll } , runAgent, commitAll };
}

describe('runBuild', () => {
  it('build resumes after crash: with completedTasks [T1], only T2 and T3 start agent sessions', async () => {
    ctx.state = baseState({ completedTasks: ['T1'] });
    const f = fakes();
    const state = await runBuild(ctx, spec, plan, undefined, f.deps);
    expect(f.reqs).toHaveLength(2);
    expect(f.reqs[0]!.prompt).toContain('T2: sum args');
    expect(f.reqs[1]!.prompt).toContain('T3: polish');
    for (const r of f.reqs) {
      expect(r.resumeSessionId).toBeUndefined();
      expect(r).toMatchObject({ role: 'backend', model: 'claude-sonnet-5-5', effort: 'medium', maxTurns: 60, systemPromptMode: 'append' });
    }
    expect(f.reqs[1]!.budgetUsd).toBe(9); // remaining after the first session's cost
    expect(state.completedTasks).toEqual(['T1', 'T2', 'T3']);
    expect(state.stage).toBe('verify');
    expect(await loadState(ctx.jobDir)).toMatchObject({ stage: 'verify', completedTasks: ['T1', 'T2', 'T3'], spentUsd: 2 });
  });

  it('build commits once per task with message "T2: <title>"', async () => {
    const f = fakes();
    await runBuild(ctx, spec, plan, undefined, f.deps);
    expect(f.commitAll).toHaveBeenCalledTimes(3);
    expect(f.commitAll.mock.calls.map((c) => c)).toEqual([
      ['/r', 'T1: scaffold'], ['/r', 'T2: sum args'], ['/r', 'T3: polish'],
    ]);
    // commit happens after the session, before the next one; completedTasks grows after the commit
    expect(f.events).toEqual([
      'agent:', 'commit:T1: scaffold', 'agent:T1', 'commit:T2: sum args', 'agent:T1,T2', 'commit:T3: polish',
    ]);
    const p = f.reqs[1]!.prompt;
    expect(p).toContain('"title": "Sum CLI"');
    expect(p).toContain('implement sum');
    expect(p).toContain('pytest --junitxml="$ANTON_JUNIT"');
    expect(p).toMatch(/run this task's tests before finishing/i);
  });

  it('build in fix mode starts exactly one session whose prompt contains the trimmed failure report', async () => {
    ctx.state = baseState({ round: 2, completedTasks: ['T1', 'T2', 'T3'] });
    const f = fakes();
    const report = ['### AC-1 — failing', ...Array.from({ length: 300 }, (_, i) => `line ${i}`)].join('\n');
    const state = await runBuild(ctx, spec, plan, report, f.deps);
    expect(f.reqs).toHaveLength(1);
    const p = f.reqs[0]!.prompt;
    expect(p).toContain('### AC-1 — failing');
    expect(p).toContain('lines trimmed');
    expect(p).not.toContain('line 100\n');
    expect(p).toContain('line 299');
    expect(f.reqs[0]!.resumeSessionId).toBeUndefined();
    expect(f.commitAll).toHaveBeenCalledTimes(1);
    expect(f.commitAll).toHaveBeenCalledWith('/r', 'fix: round 2');
    expect(f.reqs.every((r) => r.systemPromptMode === 'append')).toBe(true);
    expect(state.stage).toBe('verify');
  });

  it('build resumes fix mode from evidence/failure-report.md when all tasks are done and no report is passed', async () => {
    ctx.state = baseState({ round: 2, completedTasks: ['T1', 'T2', 'T3'] });
    await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
    await writeFile(join(ctx.jobDir, 'evidence', 'failure-report.md'), '### AC-1 — persisted failure');
    const f = fakes();
    const state = await runBuild(ctx, spec, plan, undefined, f.deps);
    expect(f.reqs).toHaveLength(1);
    expect(f.reqs[0]!.prompt).toContain('### AC-1 — persisted failure');
    expect(f.commitAll).toHaveBeenCalledWith('/r', 'fix: round 2');
    expect(state.stage).toBe('verify');
  });

  it('build with all tasks done and no failure report file goes straight to verify', async () => {
    ctx.state = baseState({ completedTasks: ['T1', 'T2', 'T3'] });
    const f = fakes();
    const state = await runBuild(ctx, spec, plan, undefined, f.deps);
    expect(f.reqs).toHaveLength(0);
    expect(state.stage).toBe('verify');
  });

  it('BudgetExceeded on T2: T1 committed and recorded, T2 not, error propagates', async () => {
    const f = fakes();
    let n = 0;
    const runAgent = vi.fn(async (c: StageCtx, _req: AgentRequest) => {
      if (++n === 2) throw new BudgetExceeded();
      return { output: 'ok', sessionId: 's', state: { ...c.state, spentUsd: c.state.spentUsd + 1 } };
    });
    await expect(runBuild(ctx, spec, plan, undefined, { runAgent: runAgent as never, commitAll: f.commitAll })).rejects.toBeInstanceOf(BudgetExceeded);
    expect(f.commitAll.mock.calls).toEqual([['/r', 'T1: scaffold']]);
    expect(await loadState(ctx.jobDir)).toMatchObject({ stage: 'build', completedTasks: ['T1'] });
  });
});
