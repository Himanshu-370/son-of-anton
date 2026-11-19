import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { StageCtx } from '../../src/agent/host-runner.js';
import type { AgentRequest } from '../../src/agent/protocol.js';
import { blocking, runSecurityReview, type SecurityFinding } from '../../src/security/review.js';
import type { ScannerFinding } from '../../src/security/scanners.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = { title: 'T', summary: 's', outOfScope: [], kit: 'fallback', tech: [], acceptanceChecks: [{ id: 'AC-1', text: 'a' }] };
const plan: Plan = {
  commands: { install: 'npm i', test: 'npm test' },
  tasks: [{ id: 'T1', title: 'one', acceptanceChecks: ['AC-1'], instructions: 'do', area: 'backend' }],
};
let ctx: StageCtx;
beforeEach(() => {
  ctx = {
    project: 'p', repo: '/r', container: 'c', jobDir: '/j', stage: 'security',
    state: { jobId: 'j', project: 'p', stage: 'build', round: 1, maxRounds: 3, budgetUsd: 10, spentUsd: 4, warned80: false, completedTasks: [], updatedAt: 'x' },
  };
});

const scanned: ScannerFinding = { tool: 'gitleaks', ruleId: 'aws-key', severity: 'high', file: 'src/a.ts', line: 3, message: 'AKIAFAKEFAKE' };
const raw = (over: Record<string, unknown> = {}) => ({
  severity: 'high', area: 'backend', file: 'src/a.ts', line: 3, title: 'Hard-coded key', detail: 'd', source: 'scanner', tool: 'gitleaks', ...over,
});

const harness = (findings: unknown[], unavailable: string[] = []) => {
  const reqs: AgentRequest[] = [];
  const runAgent = vi.fn(async (c: StageCtx, req: AgentRequest) => {
    reqs.push(req);
    return { output: { findings }, sessionId: 's', totalUsd: 1, state: { ...c.state, spentUsd: 5 } };
  }) as never;
  const runScanners = vi.fn(async () => ({ findings: [scanned], unavailable }));
  const diffSince = vi.fn(async () => 'diff --git a/x b/x\n+hi');
  return { reqs, deps: { runAgent, runScanners, diffSince } };
};

describe('runSecurityReview', () => {
  it('request is read-only, role security_reviewer, sonnet-5-5/high', async () => {
    const h = harness([]);
    const r = await runSecurityReview(ctx, spec, plan, 'abc', h.deps);
    const req = h.reqs[0]!;
    expect(req.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(req.role).toBe('security_reviewer');
    expect(req.model).toBe('claude-sonnet-5-5');
    expect(req.effort).toBe('high');
    expect(req.maxTurns).toBe(30);
    expect(req.budgetUsd).toBe(6);
    expect(r.state.spentUsd).toBe(5);
    expect(h.deps.runScanners).toHaveBeenCalledWith('c');
    expect(h.deps.diffSince).toHaveBeenCalledWith('/r', 'abc');
  });

  it('scanner findings are passed into the prompt', async () => {
    const h = harness([]);
    await runSecurityReview(ctx, spec, plan, 'abc', h.deps);
    expect(h.reqs[0]!.prompt).toContain('AKIAFAKEFAKE');
    expect(h.reqs[0]!.prompt).toContain('aws-key');
    expect(h.reqs[0]!.prompt).toContain('+hi');
  });

  it('id ignores line: same finding on a different line keeps its id', async () => {
    const a = await runSecurityReview(ctx, spec, plan, 'abc', harness([raw({ line: 3 })]).deps);
    const b = await runSecurityReview(ctx, spec, plan, 'abc', harness([raw({ line: 99 })]).deps);
    expect(a.findings[0]!.id).toMatch(/^SEC-[0-9a-f]{8}$/);
    expect(a.findings[0]!.id).toBe(b.findings[0]!.id);
  });

  it('dedupes by id and distinguishes source/tool', async () => {
    const r = await runSecurityReview(ctx, spec, plan, 'abc', harness([raw(), raw({ line: 8 }), raw({ source: 'review', tool: undefined })]).deps);
    expect(r.findings).toHaveLength(2);
  });

  it('unavailable scanners are returned unchanged', async () => {
    const r = await runSecurityReview(ctx, spec, plan, 'abc', harness([], ['semgrep', 'osv-scanner']).deps);
    expect(r.unavailable).toEqual(['semgrep', 'osv-scanner']);
  });
});

describe('blocking', () => {
  const f = (id: string, severity: SecurityFinding['severity']): SecurityFinding => ({
    id, severity, area: 'backend', file: 'a', title: 't', detail: 'd', source: 'review',
  });
  it('blocking returns only critical/high not in accepted', () => {
    const all = [f('1', 'critical'), f('2', 'high'), f('3', 'medium'), f('4', 'low'), f('5', 'high')];
    expect(blocking(all, new Set(['5'])).map((x) => x.id)).toEqual(['1', '2']);
  });
});
