import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StageCtx } from '../../src/agent/host-runner.js';
import { loadState, type JobState } from '../../src/core/state.js';
import type { CheckResult } from '../../src/kits/types.js';
import { runDeliver } from '../../src/stages/deliver.js';
import type { Plan } from '../../src/stages/plan.js';
import type { SpecDoc } from '../../src/stages/spec.js';

const spec: SpecDoc = {
  title: 'Sum CLI', summary: 'Prints the sum of its arguments.', outOfScope: [], kit: 'fallback', tech: [],
  acceptanceChecks: [{ id: 'AC-1', text: 'sums two numbers' }, { id: 'AC-2', text: 'rejects | junk' }],
};
const plan: Plan = {
  commands: { install: 'pip install -e .', test: 'pytest --junitxml="$ANTON_JUNIT"', run: 'sumcli 1 2' },
  tasks: [{ id: 'T1', title: 'x', acceptanceChecks: ['AC-1', 'AC-2'], instructions: 'y', area: 'backend' }],
};
let ctx: StageCtx;
beforeEach(async () => {
  const jobDir = await mkdtemp(join(tmpdir(), 'anton-deliver-'));
  const state: JobState = {
    jobId: 'j1', project: 'p', stage: 'deliver', round: 2, maxRounds: 3, budgetUsd: 10, spentUsd: 1.5,
    warned80: false, completedTasks: ['T1'], updatedAt: 'x',
  };
  ctx = { project: 'p', repo: '/r', container: 'c', jobDir, stage: 'deliver', state };
});
const results: CheckResult[] = [
  { id: 'AC-1', status: 'pass', tests: ['AC-1: sums'] },
  { id: 'AC-2', status: 'pass', tests: ['AC-2: junk', 'AC-2: more'] },
];

describe('runDeliver', () => {
  it('deliver: REPORT.md contains the acceptance table with every AC id and the How to run section', async () => {
    await writeFile(join(ctx.jobDir, 'cost.json'), JSON.stringify({ spec: 0.5, plan: 0.25, build: 0.75 }));
    await writeFile(join(ctx.jobDir, 'questions.md'), '- Assumed integers only.\n');
    const tag = vi.fn(async () => {});
    const state = await runDeliver(ctx, spec, plan, { results, runOk: true }, { tag, listTags: async () => [] });
    const md = await readFile(join(ctx.jobDir, 'REPORT.md'), 'utf8');

    expect(md).toMatch(/^# Sum CLI\n/);
    expect(md).toContain('Prints the sum of its arguments.');
    expect(md).toContain('| ID | Check | Status | Tests | Evidence |');
    expect(md).toMatch(/\| AC-1 \| sums two numbers \| pass \| AC-1: sums \| evidence\/test-output.txt \|/);
    expect(md).toContain('| AC-2 | rejects \\| junk | pass | AC-2: junk<br>AC-2: more |');
    expect(md).toContain('## How to run');
    expect(md).toContain('pip install -e .');
    expect(md).toContain('sumcli 1 2');
    expect(md).toContain('| build | $0.75 |');
    expect(md).toContain('| **Total** | **$1.50** |');
    expect(md).toContain('Time by stage: not recorded');
    expect(md).toContain('Assumed integers only.');
    expect(md).toMatch(/## Not done\n\nNothing/);

    const order = ['# Sum CLI', '## Acceptance checks', '## How to run', '## Cost and time by stage', '## Assumptions', '## Not done']
      .map((h) => md.indexOf(h));
    expect(order.every((v, i) => v >= 0 && (i === 0 || v > order[i - 1]!))).toBe(true);

    expect(tag).toHaveBeenCalledWith('/r', 'anton/j1/delivered-1');
    expect(state.stage).toBe('awaiting_final_review');
    expect((await loadState(ctx.jobDir)).stage).toBe('awaiting_final_review');
  });

  it('deliver after accept-as-is lists failing checks from the latest results.json under Not done', async () => {
    await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
    const latest = {
      round: 3, runOk: false,
      results: [results[0], { id: 'AC-2', status: 'fail', reason: 'no_test', tests: [] }],
    };
    await writeFile(join(ctx.jobDir, 'evidence', 'results.json'), JSON.stringify(latest));
    const state = await runDeliver(ctx, spec, plan, undefined, { tag: async () => {}, listTags: async () => [] });
    const md = await readFile(join(ctx.jobDir, 'REPORT.md'), 'utf8');
    expect(md).toContain('| AC-2 | rejects \\| junk | fail (no_test) | — |');
    expect(md).toMatch(/## Not done\n\n- AC-2: rejects \| junk \(no_test\)\n- The smoke run command failed/);
    expect(md).toContain('No assumptions recorded');
    expect(md).toContain('No cost recorded');
    expect(state.stage).toBe('awaiting_final_review');
  });

  it('deliver numbers the tag after existing delivered-* tags', async () => {
    const tag = vi.fn(async () => {});
    const listTags = vi.fn(async () => ['anton/j1/delivered-1']);
    await runDeliver(ctx, spec, plan, { results, runOk: true }, { tag, listTags });
    expect(listTags).toHaveBeenCalledWith('/r', 'anton/j1/delivered-*');
    expect(tag).toHaveBeenCalledWith('/r', 'anton/j1/delivered-2');
  });

  describe('code review and security sections', () => {
    const sec = (id: string, severity: string, title: string) => ({
      id, severity, area: 'backend', file: 'src/a.ts', title, detail: 'd', source: 'review',
    });
    async function put(name: string, body: unknown) {
      await mkdir(join(ctx.jobDir, 'evidence'), { recursive: true });
      await writeFile(join(ctx.jobDir, 'evidence', name), JSON.stringify(body));
    }
    const deliver = async () => {
      await runDeliver(ctx, spec, plan, { results, runOk: true }, { tag: async () => {}, listTags: async () => [] });
      return readFile(join(ctx.jobDir, 'REPORT.md'), 'utf8');
    };

    it('Code review section says it did not run when results.json has no review section', async () => {
      const md = await deliver();
      expect(md).toMatch(/## Code review\n\nCode review did not run for this delivery\./);
    });

    it('Code review section says No findings. when the review ran and found nothing', async () => {
      await put('results.json', { round: 1, results, runOk: true, review: { findings: [] } });
      const md = await deliver();
      expect(md).toMatch(/## Code review\n\nNo findings\./);
    });

    it('Code review section lists findings', async () => {
      let md: string;
      await put('results.json', {
        round: 2, results, runOk: true,
        review: { findings: [{ id: 'CR-1', severity: 'non_blocking', area: 'frontend', file: 'ui.ts', line: 4, summary: 'Rename x' }] },
      });
      md = await deliver();
      expect(md).toContain('CR-1');
      expect(md).toContain('non_blocking');
      expect(md).toContain('frontend');
      expect(md).toContain('ui.ts');
      expect(md).toContain('Rename x');
      expect(md.indexOf('## Acceptance checks')).toBeLessThan(md.indexOf('## Code review'));
      expect(md.indexOf('## Security')).toBeLessThan(md.indexOf('## How to run'));
    });

    it('Security section lists accepted risk with reason', async () => {
      await put('results.json', {
        round: 2, results, runOk: true,
        security: { findings: [sec('SEC-aaaaaaaa', 'high', 'Weak hash'), sec('SEC-bbbbbbbb', 'low', 'Verbose errors')], unavailable: [] },
      });
      await put('accepted-risks.json', { risks: [{ id: 'SEC-aaaaaaaa', reason: 'internal tool only', acceptedAt: 'x' }] });
      const md = await deliver();
      expect(md).toContain('### high');
      expect(md).toContain('accepted — internal tool only');
      expect(md.indexOf('### high')).toBeLessThan(md.indexOf('### low'));
      const low = md.slice(md.indexOf('SEC-bbbbbbbb'));
      expect(low.split('\n')[0]).not.toContain('accepted');
    });

    const scn = (id: string, file: string, title: string) => ({ ...sec(id, 'high', title), file, source: 'scanner', tool: 'gitleaks' });

    it('a scanner finding gone from the latest verify is listed under "No longer reported"', async () => {
      await put('results-verify-1.json', { round: 1, security: { findings: [scn('SEC-11111111', 'src/x.ts', 'Leaked key')], unavailable: [] } });
      await put('results-verify-2.json', { round: 2, reviewedFiles: [], security: { findings: [], unavailable: [] } });
      await put('results.json', { round: 2, results, runOk: true, review: { findings: [] }, security: { findings: [], unavailable: [] } });
      const md = await deliver();
      expect(md).toContain('### No longer reported');
      expect(md).not.toContain('Fixed in earlier rounds');
      expect(md).toMatch(/SEC-11111111[^\n]*Leaked key/);
    });

    it('a review finding is listed only when its file appears in a later verify\'s diff', async () => {
      await put('results-verify-1.json', {
        round: 1,
        security: { findings: [sec('SEC-11111111', 'critical', 'SQL injection'), { ...sec('SEC-22222222', 'high', 'Open redirect'), file: 'src/r.ts' }], unavailable: [] },
      });
      await put('results-verify-2.json', { round: 2, reviewedFiles: ['src/a.ts'], security: { findings: [], unavailable: [] } });
      await put('results.json', { round: 2, results, runOk: true, review: { findings: [] }, security: { findings: [], unavailable: [] } });
      const md = await deliver();
      expect(md).toMatch(/SEC-11111111[^\n]*SQL injection/);
      expect(md).not.toContain('SEC-22222222');
    });

    it('a review finding whose file only changed in its own verify is not listed', async () => {
      await put('results-verify-1.json', { round: 1, reviewedFiles: ['src/a.ts'], security: { findings: [sec('SEC-11111111', 'critical', 'SQL injection')], unavailable: [] } });
      await put('results-verify-2.json', { round: 2, reviewedFiles: [], security: { findings: [], unavailable: [] } });
      await put('results.json', { round: 2, results, runOk: true, review: { findings: [] }, security: { findings: [], unavailable: [] } });
      const md = await deliver();
      expect(md).not.toContain('SEC-11111111');
      expect(md).not.toContain('No longer reported');
    });

    it('verify copies are ordered numerically (10 after 9)', async () => {
      for (let n = 1; n <= 9; n++) await put(`results-verify-${n}.json`, { round: 1, security: { findings: [], unavailable: [] } });
      await put('results-verify-9.json', { round: 1, security: { findings: [sec('SEC-33333333', 'high', 'XSS')], unavailable: [] } });
      await put('results-verify-10.json', { round: 2, reviewedFiles: ['src/a.ts'], security: { findings: [], unavailable: [] } });
      await put('results.json', { round: 2, results, runOk: true, security: { findings: [], unavailable: [] } });
      const md = await deliver();
      expect(md).toMatch(/SEC-33333333[^\n]*XSS/);
    });

    it('unavailable scanner noted', async () => {
      await put('results.json', { round: 1, results, runOk: true, security: { findings: [], unavailable: ['semgrep'] } });
      const md = await deliver();
      expect(md).toMatch(/Scanners unavailable[^\n]*semgrep/);
      expect(md).toContain('No findings.');
    });
  });
});

describe('runDeliver redaction', () => {
  it('REPORT.md never contains the raw value', async () => {
    ctx.secrets = { TOKEN: 'FAKE_SECRET_VALUE_123' };
    await writeFile(join(ctx.jobDir, 'questions.md'), '- Assumed FAKE_SECRET_VALUE_123 works.\n');
    await runDeliver(ctx, spec, plan, { results, runOk: true }, { tag: vi.fn(async () => {}), listTags: async () => [] });
    const md = await readFile(join(ctx.jobDir, 'REPORT.md'), 'utf8');
    expect(md).not.toContain('FAKE_SECRET_VALUE_123');
    expect(md).toContain('[REDACTED:TOKEN]');
  });
});
