import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { runPlan } from '../../src/stages/plan.js';
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
      { id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do' },
      { id: 'T2', title: 'two', acceptanceChecks: ['AC-2'], instructions: 'do' },
    ] };
    const r = await runPlan(ctx, spec, { runAgent: run(output, reqs) });
    expect(r.plan.tasks).toHaveLength(2);
    expect(r.state.spentUsd).toBe(2);
    expect(reqs[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'medium', maxTurns: 30 });
    expect(reqs[0]!.systemPrompt).toContain('$ANTON_JUNIT');
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'plan.json'), 'utf8')).commands.install).toBe('npm i');
    expect(await readFile(join(ctx.jobDir, 'plan.md'), 'utf8')).toContain('## T1: one');
  });

  it('rejects a plan missing AC-2', async () => {
    const output = { commands, tasks: [{ id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do' }] };
    await expect(runPlan(ctx, spec, { runAgent: run(output) })).rejects.toThrow(/AC-2/);
  });

  it('rejects unknown check ids', async () => {
    const output = { commands, tasks: [{ id: 'T1', title: 'one', acceptanceChecks: ['AC-1', 'AC-2', 'AC-9'], instructions: 'do' }] };
    await expect(runPlan(ctx, spec, { runAgent: run(output) })).rejects.toThrow(/AC-9/);
  });
});
