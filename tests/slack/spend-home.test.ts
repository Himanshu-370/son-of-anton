import { describe, expect, it, vi } from 'vitest';
import type { InsightJob } from '../../src/core/spend-insights.js';
import { createSpendHomePublisher, renderSpendHome, SPEND_HOME_ACTIONS, type SpendHomeData } from '../../src/slack/spend-home.js';

const target = { teamId: 'T1', appId: 'A1', userId: 'U1' };
const config = { teamId: 'T1', ownerId: 'U1', roles: { pm: { appId: 'A1' } } };
const data: SpendHomeData = {
  now: new Date('2026-11-16T00:00:00Z'),
  entries: [
    { id: '1', at: '2026-11-04T00:00:00Z', source: 'build', project: 'todo-app', role: 'qa',
      model: 'claude-sonnet-5-5', usd: 10, tokens: { input: 40, output: 0, cacheRead: 60, cacheWrite: 0 } },
    { id: '2', at: '2026-11-05T00:00:00Z', source: 'import', usd: 5 },
    { id: '3', at: '2026-10-05T00:00:00Z', source: 'chat', usd: 99 },
  ],
  config: { models: { preset: 'economy', roles: { tech_lead: { effort: 'high' } },
    trial: { role: 'qa', model: 'claude-haiku-5-5', effort: 'low', jobsLeft: 2,
      revertTo: { model: 'claude-sonnet-5-5', effort: 'medium' } } } },
  jobs: [],
  overallCapUsd: 30,
  skipped: 1,
};

describe('spend Home', () => {
  it('renders UTC month spend, breakdowns, effective models, insights and controls', () => {
    const view = JSON.stringify(renderSpendHome(config, target.userId, () => data));
    for (const label of ['November', '$15.00 of $30.00', 'on pace for $30.00', '▓▓▓▓▓░░░░░',
      'By source', 'By project', 'By role', 'By model', 'todo-app $10.00', 'Before tracking $5.00',
      'claude-sonnet-5-5 $10.00', 'Waste', 'preset economy', 'tech lead → claude-sonnet-5-5 (high)',
      'QA → claude-haiku-5-5 (low, trial, 2 jobs left)', '60% hit rate', '1 skipped spend log line',
      'Change a limit', 'Change models', 'Settings history']) expect(view).toContain(label);
    expect(view).not.toContain('$99');
    expect(view).not.toContain(SPEND_HOME_ACTIONS.reviewSuggestion);
    expect(JSON.stringify(renderSpendHome(config, target.userId, () => ({ ...data, overallCapUsd: 0 }))))
      .toContain('overall spending off');
  });

  it('shows watch and suggestion details using plain text and a review action', () => {
    const jobs: InsightJob[] = Array.from({ length: 6 }, (_, i) => ({
      project: 'todo-app', jobId: String(i), stage: i === 5 ? 'build' : 'done',
      updatedAt: '2026-11-05T00:00:00Z',
    }));
    const entries = jobs.map(({ project, jobId }, i) => ({
      id: jobId, at: '2026-10-05T00:00:00Z', project, jobId,
      source: 'build' as const, stage: 'build', usd: i === 5 ? 2.3 : 1,
    }));
    const metric = { n: 4, value: 1 };
    const candidate = { role: 'qa' as const, model: 'claude-haiku-5-5', n: 4, tooFewJobs: false,
      costUsd: metric, verifyRounds: metric, reviewFindings: metric, budgetPauseShare: metric };
    const view = renderSpendHome(config, target.userId, () => ({
      ...data, jobs, entries: [...data.entries, ...entries],
      editedByHandAt: '2026-11-10 <@U1>',
      suggestion: { candidate, current: { ...candidate, n: 6, model: 'claude-sonnet-5-5' }, monthlySavingUsd: 11 },
    }));
    const body = JSON.stringify(view);
    expect(body).toContain('todo-app job 5: build is burning 2.3× its usual rate');
    expect(body).toContain('QA on claude-haiku-5-5 would save about $11.00 a month (n = 4 vs 6)');
    expect(body).toContain(SPEND_HOME_ACTIONS.reviewSuggestion);
    expect(body).toContain('edited by hand at 2026-11-10 [mention]');
    expect(body).not.toContain('<@U1>');
  });

  it('shows only the owner notice for other viewers and never loads the snapshot', async () => {
    const load = vi.fn(() => data);
    const publish = vi.fn(async (_request: { user_id: string; view: ReturnType<typeof renderSpendHome> }) => {});
    const home = createSpendHomePublisher({ config, load, publish });
    const request = { ...target, userId: 'U2' };
    await home(request, 'open');
    expect(load).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledExactlyOnceWith({
      user_id: 'U2', view: { type: 'home', blocks: [{
        type: 'section', text: { type: 'plain_text', text: 'This dashboard is for the anton owner.', emoji: false },
      }] },
    });
    expect(renderSpendHome(config, 'U2', load)).toEqual(publish.mock.calls[0]?.[0]?.view);
    expect(load).not.toHaveBeenCalled();
  });

  it('ignores mismatched workspaces and apps, throttles refreshes, and rebuilds on reopen', async () => {
    const load = vi.fn(() => data);
    const publish = vi.fn(async () => {});
    let now = 0;
    const home = createSpendHomePublisher({ config, load, publish, clock: () => now });
    await home({ ...target, teamId: 'T2' }, 'open');
    await home({ ...target, appId: 'A2' }, 'open');
    await home(target, 'refresh');
    expect(publish).not.toHaveBeenCalled();
    await home(target, 'open');
    await home(target, 'refresh');
    now = 60_000;
    await Promise.all([home(target, 'refresh'), home(target, 'refresh')]);
    now++;
    await home(target, 'open');
    expect(load).toHaveBeenCalledTimes(3);
    expect(publish).toHaveBeenCalledTimes(3);
  });

  it('lets a later refresh retry after the publisher fails', async () => {
    const publish = vi.fn(async () => {}).mockRejectedValueOnce(new Error('offline'));
    const home = createSpendHomePublisher({ config, load: () => data, publish });
    await expect(home(target, 'open')).rejects.toThrow('offline');
    await home(target, 'refresh');
    expect(publish).toHaveBeenCalledTimes(2);
  });
});
