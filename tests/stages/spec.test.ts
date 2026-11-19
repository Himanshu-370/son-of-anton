import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { runSpec, writeSpec, readApprovedSpec, SpecNotProduced, type SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'Habit Tracker', summary: 'Track habits.', outOfScope: ['accounts'], kit: 'fallback', tech: ['node'],
  acceptanceChecks: [{ id: 'AC-1', text: 'adds a habit' }, { id: 'AC-2', text: 'lists habits' }],
};
let ctx: StageCtx;
beforeEach(async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-spec-'));
  ctx = {
    project: 'p', repo: '/r', container: 'c', jobDir, stage: 'spec',
    state: { jobId: 'j', project: 'p', stage: 'spec', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 1, warned80: false, completedTasks: [], updatedAt: 'x' },
  };
});

function fakeRun(outputs: unknown[]) {
  const reqs: AgentRequest[] = [];
  const fn = vi.fn(async (c: StageCtx, req: AgentRequest) => {
    reqs.push(req);
    return { output: outputs[Math.min(reqs.length - 1, outputs.length - 1)], sessionId: 's1', state: c.state };
  });
  return { fn: fn as never, reqs };
}

describe('runSpec', () => {
  it('loops questions then spec, resuming the session', async () => {
    const { fn, reqs } = fakeRun([
      { kind: 'questions', questions: ['a?'] }, { kind: 'questions', questions: ['b?', 'c?'] }, { kind: 'spec', spec },
    ]);
    const ask = vi.fn(async (q: string[]) => q.map(() => 'yes'));
    const r = await runSpec(ctx, 'habit app', ask, { runAgent: fn });
    expect(r.spec).toEqual(spec);
    expect(ask).toHaveBeenCalledTimes(2);
    expect(reqs[0]!.resumeSessionId).toBeUndefined();
    expect(reqs[1]!.resumeSessionId).toBe('s1');
    expect(reqs[2]!.prompt).toContain('A: yes');
    expect(reqs[0]).toMatchObject({ model: 'claude-opus-5-5', effort: 'high', maxTurns: 30, budgetUsd: 9 });
  });

  it('forces the spec on the 6th call and throws SpecNotProduced', async () => {
    const { fn, reqs } = fakeRun([{ kind: 'questions', questions: ['?'] }]);
    await expect(runSpec(ctx, 'x', async (q) => q.map(() => 'a'), { runAgent: fn })).rejects.toBeInstanceOf(SpecNotProduced);
    expect(reqs).toHaveLength(6);
    expect(reqs[5]!.prompt).toContain('write the spec now');
    expect(reqs[4]!.prompt).not.toContain('write the spec now');
  });
});

describe('writeSpec / readApprovedSpec', () => {
  it('picks up edited and added acceptance checks', async () => {
    await writeSpec(ctx.jobDir, spec);
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    expect(md).toContain('- **AC-1**: adds a habit');
    const edited = md.replace('- **AC-2**: lists habits', '- **AC-2**: lists habits sorted by name\n- **AC-3**: deletes a habit');
    await writeFile(join(ctx.jobDir, 'spec.md'), edited);
    const out = await readApprovedSpec(ctx.jobDir);
    expect(out.acceptanceChecks).toEqual([
      { id: 'AC-1', text: 'adds a habit' }, { id: 'AC-2', text: 'lists habits sorted by name' }, { id: 'AC-3', text: 'deletes a habit' },
    ]);
    expect(out.tech).toEqual(['node']);
    expect(await readFile(join(ctx.jobDir, 'spec.generated.md'), 'utf8')).toBe(md);
    expect(JSON.parse(await readFile(join(ctx.jobDir, 'spec.approved.json'), 'utf8')).acceptanceChecks).toHaveLength(3);
  });

  it('rejects duplicates and zero checks', async () => {
    await writeSpec(ctx.jobDir, spec);
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    await writeFile(join(ctx.jobDir, 'spec.md'), md + '- **AC-1**: again\n');
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow(/duplicate.*AC-1/);
    await writeFile(join(ctx.jobDir, 'spec.md'), '# T\n\nnothing\n');
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow(/no acceptance checks/);
  });
});
