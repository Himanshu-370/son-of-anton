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
const scanners = async () => ({ findings: [finding], unavailable: ['semgrep'] });

describe('runBaseline', () => {
  it('baseline records passing test names and scanner refs', async () => {
    const c = await ctx();
    const s = await runBaseline(c, kit(0), plan, { runScanners: scanners });
    const out = JSON.parse(await readFile(join(c.jobDir, 'evidence', 'baseline.json'), 'utf8'));
    expect(out).toEqual({ passingTests: ['adds'], ran: true, scannerRefs: [scannerRef(finding)], unavailable: ['semgrep'] });
    expect(s).toMatchObject({ stage: 'build', round: 1 });
    expect((await loadState(c.jobDir)).stage).toBe('build');
  });
  it('install failure → ran false, still transitions to build', async () => {
    const c = await ctx();
    const s = await runBaseline(c, kit(1), plan, { runScanners: scanners });
    const out = JSON.parse(await readFile(join(c.jobDir, 'evidence', 'baseline.json'), 'utf8'));
    expect(out).toMatchObject({ passingTests: [], ran: false });
    expect(s.stage).toBe('build');
  });
});
