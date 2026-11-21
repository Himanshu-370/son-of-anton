import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BudgetExceeded, type StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { ROLE_MODELS } from '../../src/core/config.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import { failuresPath, type FailureItem } from '../../src/stages/qa.js';
import { runBuild } from '../../src/stages/build.js';
import { loadPrompt } from '../../src/stages/prompts.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 's', outOfScope: [], kit: 'fallback', tech: ['python'],
  acceptanceChecks: [{ id: 'AC-1', text: 'sums' }],
};
const plan: Plan = {
  commands: { install: 'pip install -e .', test: 'pytest --junitxml="$ANTON_JUNIT"' },
  tasks: [
    { id: 'T1', title: 'scaffold', acceptanceChecks: [], instructions: 'make scaffold', area: 'backend' },
    { id: 'T2', title: 'sum args', acceptanceChecks: ['AC-1'], instructions: 'implement sum', area: 'backend' },
    { id: 'T3', title: 'polish', acceptanceChecks: [], instructions: 'polish it', area: 'backend' },
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
      ['/r', 'T1: scaffold', undefined], ['/r', 'T2: sum args', undefined], ['/r', 'T3: polish', undefined],
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
    expect(f.commitAll).toHaveBeenCalledWith('/r', 'fix: round 2 (backend)', undefined);
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
    expect(f.commitAll).toHaveBeenCalledWith('/r', 'fix: round 2 (backend)', undefined);
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
    expect(f.commitAll.mock.calls).toEqual([['/r', 'T1: scaffold', undefined]]);
    expect(await loadState(ctx.jobDir)).toMatchObject({ stage: 'build', completedTasks: ['T1'] });
  });

  describe('role split', () => {
    const multi: Plan = {
      commands: { install: 'i', test: 't' },
      contract: 'POST /api/sum returns {total}',
      tasks: [
        { id: 'T1', title: 'ui', acceptanceChecks: [], instructions: 'build ui', area: 'frontend' },
        { id: 'T2', title: 'api', acceptanceChecks: [], instructions: 'build api', area: 'backend' },
        { id: 'T3', title: 'api2', acceptanceChecks: [], instructions: 'more api', area: 'backend' },
        { id: 'T4', title: 'docker', acceptanceChecks: [], instructions: 'dockerize', area: 'infra' },
      ],
    };

    it('each session uses the task area as role and ROLE_MODELS[area]', async () => {
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      expect(f.reqs.map((r) => r.role)).toEqual(['infra', 'backend', 'backend', 'frontend']);
      for (const r of f.reqs) expect(r).toMatchObject({ model: 'claude-sonnet-5-5', effort: 'medium', systemPromptMode: 'append' });
    });

    it('system prompt is build.md + role-<area>.md', async () => {
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      const build = await loadPrompt('build.md');
      expect(build).toContain('CLAUDE.md'); // repo settings are not auto-loaded (P4a-R6)
      for (const r of f.reqs) {
        expect(r.systemPrompt).toBe(`${build}\n\n${await loadPrompt(`role-${r.role}.md`)}`);
      }
    });

    it('last task of an area asks for a handoff at the container path; other tasks do not', async () => {
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      const marker = 'write a short handoff note for the next developer to';
      const [infra, api1, api2, ui] = f.reqs.map((r) => r.prompt);
      expect(infra).toContain(`${marker} \`/workspace/.anton/jobs/j1/handoffs/infra.md\``);
      expect(api1).not.toContain(marker);
      expect(api2).toContain(`${marker} \`/workspace/.anton/jobs/j1/handoffs/backend.md\``);
      expect(ui).toContain('/workspace/.anton/jobs/j1/handoffs/frontend.md');
    });

    it('a frontend task prompt contains the backend handoff text and the contract', async () => {
      await mkdir(join(ctx.jobDir, 'handoffs'), { recursive: true });
      await writeFile(join(ctx.jobDir, 'handoffs', 'backend.md'), 'BACKEND HANDOFF: run uvicorn app:app');
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      const ui = f.reqs[3]!.prompt;
      expect(ui).toContain('BACKEND HANDOFF: run uvicorn app:app');
      expect(ui).toContain('POST /api/sum returns {total}');
    });

    it('role-infra prompt forbids deploying', async () => {
      expect(await loadPrompt('role-infra.md')).toMatch(/never deploy/i);
    });
  });

  describe('area-routed fix rounds', () => {
    const multi: Plan = {
      commands: { install: 'i', test: 't' },
      contract: 'POST /api/sum returns {total}',
      tasks: [
        { id: 'T1', title: 'ui', acceptanceChecks: ['AC-1'], instructions: 'build ui', area: 'frontend' },
        { id: 'T2', title: 'api', acceptanceChecks: ['AC-1'], instructions: 'build api', area: 'backend' },
      ],
    };
    const items: FailureItem[] = [
      { area: 'frontend', kind: 'check', id: 'AC-1:failing', text: 'FRONT-ONLY button broken' },
      { area: 'backend', kind: 'check', id: 'AC-1:failing', text: 'BACK-ONLY endpoint 500' },
      { area: 'backend', kind: 'security', id: 'S-1', text: 'BACK-SEC injection' },
    ];
    async function setup(over: Partial<JobState> = {}) {
      ctx.state = baseState({ round: 2, completedTasks: ['T1', 'T2'], ...over });
      await saveState(ctx.jobDir, ctx.state);
      await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
      await writeFile(failuresPath(ctx.jobDir), JSON.stringify(items));
      await writeFile(join(ctx.jobDir, 'evidence', 'failure-report.md'), 'WHOLE REPORT MARKER');
    }

    it('fix round runs backend then frontend sessions only, each with only its items', async () => {
      await setup();
      const f = fakes();
      const state = await runBuild(ctx, spec, multi, undefined, f.deps);
      expect(f.reqs.map((r) => r.role)).toEqual(['backend', 'frontend']);
      const [be, fe] = f.reqs.map((r) => r.prompt);
      expect(be).toContain('BACK-ONLY endpoint 500');
      expect(be).toContain('BACK-SEC injection');
      expect(be).not.toContain('FRONT-ONLY');
      expect(fe).toContain('FRONT-ONLY button broken');
      expect(fe).not.toContain('BACK-ONLY');
      for (const p of [be, fe]) {
        expect(p).toContain('POST /api/sum returns {total}');
        expect(p).toContain('/workspace/.anton/jobs/j1/evidence/failure-report.md');
        expect(p).not.toContain('WHOLE REPORT MARKER');
      }
      const build = await loadPrompt('build.md');
      for (const r of f.reqs) {
        const area = r.role as 'backend' | 'frontend';
        expect(r).toMatchObject({ model: ROLE_MODELS[area].model, effort: ROLE_MODELS[area].effort });
        expect(r.systemPrompt).toBe(`${build}\n\n${await loadPrompt(`role-${area}.md`)}`);
      }
      expect(state.stage).toBe('verify');
    });

    it('commit message per area', async () => {
      await setup();
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      expect(f.commitAll.mock.calls).toEqual([['/r', 'fix: round 2 (backend)', undefined], ['/r', 'fix: round 2 (frontend)', undefined]]);
    });

    it('routes an item to its area even when the plan has no tasks there', async () => {
      await setup();
      await writeFile(failuresPath(ctx.jobDir), JSON.stringify([{ area: 'infra', kind: 'run', id: 'run:failed', text: 'INFRA-ONLY' }]));
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      expect(f.reqs.map((r) => r.role)).toEqual(['infra']);
    });

    it('crash after backend fix: resume runs only frontend', async () => {
      await setup();
      const f = fakes();
      let n = 0;
      const crashing = vi.fn(async (c: StageCtx, req: AgentRequest) => {
        if (++n === 2) throw new Error('crash');
        return f.runAgent(c, req);
      });
      await expect(runBuild(ctx, spec, multi, undefined, { runAgent: crashing as never, commitAll: f.commitAll })).rejects.toThrow('crash');
      const saved = await loadState(ctx.jobDir);
      expect(saved.completedFixAreas).toEqual(['backend']);
      const f2 = fakes();
      const state = await runBuild({ ...ctx, state: saved }, spec, multi, undefined, f2.deps);
      expect(f2.reqs.map((r) => r.role)).toEqual(['frontend']);
      expect(state.stage).toBe('verify');
    });

    it('failures.json absent but report present: report goes to every plan area in AREA_ORDER', async () => {
      await setup();
      await rm(failuresPath(ctx.jobDir));
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      expect(f.reqs.map((r) => r.role)).toEqual(['backend', 'frontend']);
      for (const r of f.reqs) expect(r.prompt).toContain('WHOLE REPORT MARKER');
    });

    it('no failures.json and no persisted report → normal mode', async () => {
      ctx.state = baseState();
      const f = fakes();
      await runBuild(ctx, spec, multi, undefined, f.deps);
      expect(f.commitAll.mock.calls.map((c) => c[1])).toEqual(['T2: api', 'T1: ui']);
    });
  });
});

describe('runBuild secret guard', () => {
  it('passes the job secrets to the commit, and a SecretInDiff aborts the build before completing the task', async () => {
    ctx.secrets = { TOKEN: 'FAKE_SECRET_VALUE_123' };
    await saveState(ctx.jobDir, ctx.state);
    const f = fakes();
    f.commitAll.mockRejectedValueOnce(new Error('Refusing to commit: TOKEN'));
    await expect(runBuild(ctx, spec, plan, undefined, f.deps)).rejects.toThrow('Refusing to commit');
    expect(f.commitAll.mock.calls[0]![2]).toEqual({ TOKEN: 'FAKE_SECRET_VALUE_123' });
    expect((await loadState(ctx.jobDir)).completedTasks).toEqual([]);
  });
});
