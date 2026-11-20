import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StageCtx } from '../../src/agent/host-runner.js';
import { loadState, saveState, type JobState } from '../../src/core/state.js';
import { fallbackKit } from '../../src/kits/fallback/index.js';
import type { Kit } from '../../src/kits/types.js';
import type { Plan } from '../../src/stages/plan.js';
import { runBaseline } from '../../src/stages/baseline.js';
import { scannerRef } from '../../src/security/review.js';

const plan: Plan = {
  commands: { install: 'npm i', test: 'npm test' },
  tasks: [{ id: 'T1', title: 'x', acceptanceChecks: [], instructions: 'y', area: 'backend' }],
};
const xml = `<testsuite><testcase classname="a" name="adds"/><testcase name="bad"><failure message="x"/></testcase><testcase name="skip"><skipped/></testcase></testsuite>`;
const finding = { tool: 'gitleaks' as const, ruleId: 'r', severity: 'high' as const, file: 'f.ts', key: 'k', message: 'm' };

async function ctx(): Promise<StageCtx> {
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-baseline-'));
  const state: JobState = {
    jobId: 'j', kind: 'change', project: 'p', stage: 'baseline', round: 0, maxRounds: 3, budgetUsd: 10, spentUsd: 0,
    warned80: false, completedTasks: [], updatedAt: 'x',
  };
  await saveState(jobDir, state);
  return { project: 'p', repo: '/r', container: 'c', jobDir, stage: 'baseline', state };
}
const fakeRun = (installExit: number) => async (_c: string, cmd: string) => {
  if (cmd === 'npm i') return { exitCode: installExit, stdout: '', stderr: '' };
  if (cmd.startsWith('cat ')) return { exitCode: 0, stdout: xml, stderr: '' };
  return { exitCode: 0, stdout: '', stderr: '' };
};
// Real fallback kit with an injected runIn.
const kit = (installExit: number): Kit => ({ ...fallbackKit, baseline: (c) => fallbackKit.baseline(c, { runIn: fakeRun(installExit) }) });
const order: string[] = [];
const reset = async () => { order.push('reset'); };
const scanners = async () => ({ findings: [finding], unavailable: ['semgrep'] });

describe('runBaseline', () => {
  it('baseline records passing test names and scanner refs', async () => {
    const c = await ctx();
    const s = await runBaseline(c, kit(0), plan, { runScanners: scanners, resetWorktree: reset, isClean: async () => true });
    const out = JSON.parse(await readFile(join(c.jobDir, 'evidence', 'baseline.json'), 'utf8'));
    expect(out).toEqual({ passingTests: ['a::adds'], ran: true, scannerRefs: [scannerRef(finding)], unavailable: ['semgrep'] });
    expect(order).toEqual(['reset']);
    expect(s).toMatchObject({ stage: 'build', round: 1 });
    expect((await loadState(c.jobDir)).stage).toBe('build');
  });
  it('install failure → ran false, still transitions to build', async () => {
    const c = await ctx();
    const s = await runBaseline(c, kit(1), plan, { runScanners: scanners, resetWorktree: reset, isClean: async () => true });
    const out = JSON.parse(await readFile(join(c.jobDir, 'evidence', 'baseline.json'), 'utf8'));
    expect(out).toMatchObject({ passingTests: [], ran: false });
    expect(order).toEqual(['reset', 'reset']);
    expect(s.stage).toBe('build');
  });
  it('resets only after baseline.json is written', async () => {
    const c = await ctx();
    let existed = false;
    await runBaseline(c, kit(0), plan, { runScanners: scanners, isClean: async () => true, resetWorktree: async () => { existed = !!(await readFile(join(c.jobDir, 'evidence', 'baseline.json'), 'utf8')); } });
    expect(existed).toBe(true);
  });
});

describe('runBaseline guard', () => {
  it('refuses a tree that was dirty before the kit ran; no kit call, no reset', async () => {
    const c = await ctx();
    let kitCalled = false;
    let resets = 0;
    const k: Kit = { ...kit(0), baseline: async () => { kitCalled = true; return { passingTests: [], ran: true }; } };
    await expect(
      runBaseline(c, k, plan, { runScanners: scanners, isClean: async () => false, resetWorktree: async () => { resets++; } }),
    ).rejects.toThrow(/uncommitted changes/);
    expect(kitCalled).toBe(false);
    expect(resets).toBe(0);
  });
  it('resets even when the kit throws', async () => {
    const c = await ctx();
    let resets = 0;
    const k: Kit = { ...kit(0), baseline: async () => { throw new Error('kit boom'); } };
    await expect(
      runBaseline(c, k, plan, { runScanners: scanners, isClean: async () => true, resetWorktree: async () => { resets++; } }),
    ).rejects.toThrow('kit boom');
    expect(resets).toBe(1);
  });
});

describe('runBaseline redaction', () => {
  it('baseline.json is redacted and still parses', async () => {
    const c = await ctx();
    c.secrets = { TOKEN: 'FAKE_SECRET_VALUE_123' };
    const leaky = `<testsuite><testcase name="t FAKE_SECRET_VALUE_123"/></testsuite>`;
    const run = async (_c: string, cmd: string) =>
      cmd.startsWith('cat ') ? { exitCode: 0, stdout: leaky, stderr: '' } : { exitCode: 0, stdout: '', stderr: '' };
    const k: Kit = { ...fallbackKit, baseline: (x) => fallbackKit.baseline(x, { runIn: run }) };
    await runBaseline(c, k, plan, { runScanners: scanners, resetWorktree: reset, isClean: async () => true });
    const t = await readFile(join(c.jobDir, 'evidence', 'baseline.json'), 'utf8');
    expect(t).not.toContain('FAKE_SECRET_VALUE_123');
    expect(JSON.parse(t).passingTests).toEqual(['t [REDACTED:TOKEN]']);
  });
});
