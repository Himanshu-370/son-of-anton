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
});
