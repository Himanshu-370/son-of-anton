import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { PlanSchema, validatePlanAreas, runPlan } from '../../src/stages/plan.js';
import { loadPrompt } from '../../src/stages/prompts.js';
import type { SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'T', summary: 's', outOfScope: [], kit: 'fallback', tech: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'a' }, { id: 'AC-2', text: 'b' }],
};
const commands = { install: 'npm i', test: 'vitest run --reporter=junit --outputFile="$ANTON_JUNIT"' };
let ctx: StageCtx;
beforeEach(async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-plan-'));
  ctx = {
    project: 'p', repo: '/r', container: 'c', jobDir, stage: 'plan',
    state: { jobId: 'j', project: 'p', stage: 'plan', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: 'x' },
  };
});
const run = (output: unknown, reqs: AgentRequest[] = []) =>
  vi.fn(async (c: StageCtx, req: AgentRequest) => { reqs.push(req); return { output, sessionId: 's', state: { ...c.state, spentUsd: 2 } }; }) as never;

describe('runPlan', () => {
  it('writes plan files, uses plan model, returns updated state', async () => {
    const reqs: AgentRequest[] = [];
    const output = { commands, tasks: [
      { id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do', area: 'backend' },
      { id: 'T2', title: 'two', acceptanceChecks: ['AC-2'], instructions: 'do', area: 'backend' },
    ] };
    const r = await runPlan(ctx, spec, { runAgent: run(output, reqs) });
    expect(r.plan.tasks).toHaveLength(2);
    expect(r.state.spentUsd).toBe(2);
    expect(reqs[0]).toMatchObject({ role: 'tech_lead', model: 'claude-opus-5-5', effort: 'medium', maxTurns: 30 });
    expect(reqs[0]!.outputSchema!.type).toBe('object');
    expect(reqs[0]!.systemPrompt).toContain('$ANTON_JUNIT');
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'plan.json'), 'utf8')).commands.install).toBe('npm i');
    expect(await readFile(join(ctx.jobDir, 'plan.md'), 'utf8')).toContain('## T1: one');
  });

  it('rejects a plan missing AC-2', async () => {
    const output = { commands, tasks: [{ id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do', area: 'backend' }] };
    await expect(runPlan(ctx, spec, { runAgent: run(output) })).rejects.toThrow(/AC-2/);
  });

  it('rejects unknown check ids', async () => {
    const output = { commands, tasks: [{ id: 'T1', title: 'one', acceptanceChecks: ['AC-1', 'AC-2', 'AC-9'], instructions: 'do', area: 'backend' }] };
    await expect(runPlan(ctx, spec, { runAgent: run(output) })).rejects.toThrow(/AC-9/);
  });
});

describe('plan areas and contract', () => {
  const t = (id: string, area: string) => ({ id, title: id, acceptanceChecks: [], instructions: 'x', area });
  it('plan with backend+frontend tasks and no contract is rejected naming 2 areas', async () => {
    const output = { commands, tasks: [
      { id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do', area: 'backend' },
      { id: 'T2', title: 'two', acceptanceChecks: ['AC-2'], instructions: 'do', area: 'frontend' },
    ] };
    await expect(runPlan(ctx, spec, { runAgent: run(output) })).rejects.toThrow('plan spans 2 areas but has no contract');
    expect(() => validatePlanAreas(PlanSchema.parse({ commands, tasks: [t('T1', 'backend'), t('T2', 'frontend')], contract: '  ' }))).toThrow(/no contract/);
  });
  it('single-area plan without contract is valid', () => {
    expect(() => validatePlanAreas(PlanSchema.parse({ commands, tasks: [t('T1', 'backend'), t('T2', 'backend')] }))).not.toThrow();
  });
  it('task without area fails schema', () => {
    const { area: _a, ...noArea } = t('T1', 'backend');
    expect(() => PlanSchema.parse({ commands, tasks: [noArea] })).toThrow();
  });
  it('plan.md shows contract and [area] tags', async () => {
    const output = { commands, contract: 'GET /api/x -> {n:number}', tasks: [
      { id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do', area: 'backend' },
      { id: 'T2', title: 'two', acceptanceChecks: ['AC-2'], instructions: 'do', area: 'frontend' },
    ] };
    const reqs: AgentRequest[] = [];
    await runPlan(ctx, spec, { runAgent: run(output, reqs) });
    const md = await readFile(join(ctx.jobDir, 'plan.md'), 'utf8');
    expect(md).toContain('## Contract');
    expect(md).toContain('GET /api/x');
    expect(md).toContain('## T1: one [backend]');
    expect(md).toContain('## T2: two [frontend]');
    const props = JSON.stringify(reqs[0]!.outputSchema);
    expect(props).toContain('"area"');
    expect(props).toContain('"contract"');
  });
  it('tech lead prompt states the build order infra → backend → frontend and asks for an API/interface contract when more than one area is involved', async () => {
    const p = await loadPrompt('plan.md');
    expect(p).toContain('infra → backend → frontend');
    expect(p).toMatch(/contract/i);
    expect(p).toMatch(/API/);
    expect(p).toMatch(/more than one area/);
  });
});

