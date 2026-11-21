import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent, type ChildLike, type StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { loadPrompt } from '../../src/stages/prompts.js';
import { runSpec, writeSpec, readApprovedSpec, SpecNotProduced, type SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'Habit Tracker', summary: 'Track habits.', outOfScope: ['accounts'], kit: 'fallback', tech: ['node'],
  acceptanceChecks: [{ id: 'AC-1', text: 'adds a habit' }, { id: 'AC-2', text: 'lists habits' }], services: [],
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
    for (const r of reqs) expect(r.outputSchema!.type).toBe('object');
    expect(reqs[0]).toMatchObject({ role: 'pm', model: 'claude-opus-5-5', effort: 'high', maxTurns: 30, budgetUsd: 9 });
  });

  it('forces the spec on the 6th call and throws SpecNotProduced', async () => {
    const { fn, reqs } = fakeRun([{ kind: 'questions', questions: ['?'] }]);
    await expect(runSpec(ctx, 'x', async (q) => q.map(() => 'a'), { runAgent: fn })).rejects.toBeInstanceOf(SpecNotProduced);
    expect(reqs).toHaveLength(6);
    expect(reqs[5]!.prompt).toContain('write the spec now');
    expect(reqs[4]!.prompt).not.toContain('write the spec now');
    for (const r of reqs) expect(r.outputSchema!.type).toBe('object');
    expect(JSON.stringify(reqs[4]!.outputSchema)).toContain('questions');
    expect(JSON.stringify(reqs[5]!.outputSchema)).not.toContain('questions');
  });

  it('rejects kind=questions with no questions, and kind=spec with no spec', async () => {
    for (const bad of [{ kind: 'questions' }, { kind: 'questions', questions: [] }, { kind: 'spec' }]) {
      const { fn } = fakeRun([bad]);
      await expect(runSpec(ctx, 'x', async () => [], { runAgent: fn })).rejects.toThrow();
    }
  });
});

describe('runSpec cost accounting across resumed turns', () => {
  it('three resumed turns with SDK cumulative totals 0.5, 1.2, 2.0 record 2.0 spent, not 3.7', async () => {
    ctx.state = { ...ctx.state, spentUsd: 0 };
    const turns = [
      { totalUsd: 0.5, output: { kind: 'questions', questions: ['a?'] } },
      { totalUsd: 1.2, output: { kind: 'questions', questions: ['b?'] } },
      { totalUsd: 2.0, output: { kind: 'spec', spec } },
    ];
    const reqs: AgentRequest[] = [];
    let call = 0;
    const spawn = (): ChildLike => {
      const t = turns[call++]!;
      const line = JSON.stringify({ type: 'result', ok: true, output: t.output, sessionId: 'sess', totalUsd: t.totalUsd, protocolVersion: 4 }) + '\n';
      return {
        stdout: (async function* () { yield line; })(),
        kill: () => undefined,
        then: (ok: (v: { exitCode: number }) => unknown) => Promise.resolve({ exitCode: 0 }).then(ok),
      } as unknown as ChildLike;
    };
    const run = (async (c: StageCtx, req: AgentRequest) => {
      reqs.push(req);
      return runAgent(c, req, { spawn, notify: async () => undefined, plugins: async () => ({ plugins: [], skills: [], mcpServers: {} }) });
    }) as typeof runAgent;
    const r = await runSpec(ctx, 'habit app', async (q) => q.map(() => 'yes'), { runAgent: run });
    expect(r.state.spentUsd).toBeCloseTo(2.0, 10);
    expect(reqs.map((q) => q.baseUsd ?? 0)).toEqual([0, 0.5, 1.2]);
  });
});

describe('services', () => {
  const withSvc: SpecDoc = { ...spec, services: [{ name: 'Stripe', envVars: ['STRIPE_KEY', 'STRIPE_WEBHOOK'] }] };

  it('spec.md renders Outside services', async () => {
    await writeSpec(ctx.jobDir, withSvc);
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    expect(md).toContain('## Outside services\n\n- Stripe (env: STRIPE_KEY, STRIPE_WEBHOOK)');
    expect((await readApprovedSpec(ctx.jobDir)).services).toEqual(withSvc.services);
  });

  it('older spec.json without services still parses with services []', async () => {
    await writeSpec(ctx.jobDir, spec);
    const old = JSON.parse(await readFile(join(ctx.jobDir, 'spec.json'), 'utf8'));
    delete old.services;
    await writeFile(join(ctx.jobDir, 'spec.json'), JSON.stringify(old));
    expect((await readApprovedSpec(ctx.jobDir)).services).toEqual([]);
  });

  it('rejects value-like strings in envVars', async () => {
    await writeSpec(ctx.jobDir, withSvc);
    const j = JSON.parse(await readFile(join(ctx.jobDir, 'spec.json'), 'utf8'));
    j.services[0].envVars = ['KEY=abc123'];
    await writeFile(join(ctx.jobDir, 'spec.json'), JSON.stringify(j));
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow();
  });

  it('PM prompt requires services and stand-in default', async () => {
    const p = await loadPrompt('spec.md');
    expect(p).toMatch(/`services`.*EVERY outside service/);
    expect(p).toMatch(/stand-in.*default/);
  });

  it('build and infra prompts state the [real] rule and .env.example', async () => {
    const b = await loadPrompt('build.md');
    expect(b).toContain('`[real]`');
    expect(b).toMatch(/skip unless ALL/);
    expect(b).toMatch(/environment variables only/);
    expect(await loadPrompt('role-infra.md')).toMatch(/\.env\.example.*no values/s);
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

  it('collapses whitespace in check text so round-trip is lossless', async () => {
    const multi: SpecDoc = { ...spec, acceptanceChecks: [{ id: 'AC-1', text: 'adds  a\nhabit\n  fast' }] };
    await writeSpec(ctx.jobDir, multi);
    const out = await readApprovedSpec(ctx.jobDir);
    expect(out.acceptanceChecks[0]!.text).toBe('adds a habit fast');
  });

  it('spec.md Kit line round-trips; edited value wins', async () => {
    await writeSpec(ctx.jobDir, { ...spec, kit: 'web' });
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    expect(md).toMatch(/^# Habit Tracker\n\nKit: web\n/);
    expect((await readApprovedSpec(ctx.jobDir)).kit).toBe('web');
    await writeFile(join(ctx.jobDir, 'spec.md'), md.replace('Kit: web', 'Kit: fallback'));
    expect((await readApprovedSpec(ctx.jobDir)).kit).toBe('fallback');
  });

  it('only the Kit line before the first ## heading counts', async () => {
    await writeSpec(ctx.jobDir, { ...spec, kit: 'web' });
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    await writeFile(join(ctx.jobDir, 'spec.md'), `${md}\n## Notes\n\nKit: rails\n`);
    expect((await readApprovedSpec(ctx.jobDir)).kit).toBe('web');
    // No header Kit line: a body one is ignored too (spec.json's value stands).
    await writeFile(join(ctx.jobDir, 'spec.md'), `${md.replace('Kit: web\n\n', '')}\n## Notes\n\nKit: rails\n`);
    expect((await readApprovedSpec(ctx.jobDir)).kit).toBe('web');
    // `\s*` must not cross a newline: "Kit:" followed by a blank line is an empty value, not the next line.
    await writeFile(join(ctx.jobDir, 'spec.md'), md.replace('Kit: web', 'Kit:'));
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow('Unknown kit ""');
  });

  it('Kit line with CRLF reads as web', async () => {
    await writeSpec(ctx.jobDir, { ...spec, kit: 'fallback' });
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    await writeFile(join(ctx.jobDir, 'spec.md'), md.replace('Kit: fallback\n', 'Kit: web\r\n'));
    expect((await readApprovedSpec(ctx.jobDir)).kit).toBe('web');
  });

  it('unknown kit in spec.md throws', async () => {
    await writeSpec(ctx.jobDir, spec);
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    await writeFile(join(ctx.jobDir, 'spec.md'), md.replace('Kit: fallback', 'Kit: rails'));
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow('Unknown kit "rails" in spec.md (use fallback or web)');
  });

  it('old spec.json without kit loads as fallback', async () => {
    await writeSpec(ctx.jobDir, spec);
    const old = JSON.parse(await readFile(join(ctx.jobDir, 'spec.json'), 'utf8'));
    delete old.kit;
    await writeFile(join(ctx.jobDir, 'spec.json'), JSON.stringify(old));
    // An older spec.md has no Kit line either: spec.json's (defaulted) value is used.
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    await writeFile(join(ctx.jobDir, 'spec.md'), md.replace('Kit: fallback\n\n', ''));
    expect((await readApprovedSpec(ctx.jobDir)).kit).toBe('fallback');
  });

  it('PM agent schema and prompt no longer carry kit', async () => {
    const { fn, reqs } = fakeRun([{ kind: 'spec', spec }]);
    const r = await runSpec(ctx, 'd', async () => [], { runAgent: fn });
    expect(JSON.stringify(reqs[0]!.outputSchema)).not.toContain('"kit"');
    expect(r.spec.kit).toBe('fallback');
    expect(await loadPrompt('spec.md')).not.toMatch(/`kit`/);
  });

  it('rejects duplicates and zero checks', async () => {
    await writeSpec(ctx.jobDir, spec);
    const md = await readFile(join(ctx.jobDir, 'spec.md'), 'utf8');
    await writeFile(join(ctx.jobDir, 'spec.md'), md + '- **AC-1**: again\n');
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow(/duplicate.*AC-1/);
    await writeFile(join(ctx.jobDir, 'spec.md'), '# T\n\nnothing\n');
    await expect(readApprovedSpec(ctx.jobDir)).rejects.toThrow(/no acceptance checks/);
  });

  it('change mode prompt mentions repo-map.md and characterization checks', async () => {
    const { fn, reqs } = fakeRun([{ kind: 'spec', spec }]);
    await runSpec(ctx, 'add login', async () => [], { runAgent: fn }, 'change');
    expect(reqs[0]!.prompt).toContain('.anton/repo-map.md');
    expect(reqs[0]!.prompt).toContain('characterization');
    const n = fakeRun([{ kind: 'spec', spec }]);
    await runSpec(ctx, 'x', async () => [], { runAgent: n.fn });
    expect(n.reqs[0]!.prompt).not.toContain('repo-map.md');
  });

  it('PM prompt requires security acceptance checks for logins/user data/payments/network exposure', async () => {
    const p = await loadPrompt('spec.md');
    expect(p).toMatch(/security acceptance checks/i);
    for (const w of ['login', 'user data', 'payment', 'network']) expect(p.toLowerCase()).toContain(w);
    expect(p).toContain("logged-out user can't reach /admin");
  });
});
