import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readMonthlySpend } from '../../src/core/spend-log.js';
import { reserveChatSpend, settleChatSpend } from '../../src/slack/chat-budget.js';
import { reconcileMonthToDateSpend } from '../../src/slack/spend-migration.js';

it('reconciles old job and Slack costs once and refuses a symlinked job state', async () => {
  const home = await mkdtemp(join(tmpdir(), 'anton-migration-'));
  try {
    const repoPath = join(home, 'project');
    const jobDir = join(repoPath, '.anton', 'jobs', '1-init');
    await mkdir(jobDir, { recursive: true });
    const now = new Date('2026-11-27T12:00:00.000Z');
    const state = {
      project: 'tracker', jobId: '1-init', stage: 'done', spentUsd: 1,
      budgetUsd: 10, warned80: false, round: 1, maxRounds: 3, completedTasks: [],
      updatedAt: now.toISOString(),
    };
    const statePath = join(jobDir, 'state.json');
    await writeFile(statePath, JSON.stringify(state));
    const teamId = 'T0FAKE';
    const held = (await reserveChatSpend(teamId, 'a'.repeat(32), 0.2, now.getTime(), { home }))!;
    await settleChatSpend(held, 0.1, { home });

    const input = { home, now, projects: [{ name: 'tracker', repoPath }], teamId };
    expect(await reconcileMonthToDateSpend(input)).toEqual({ jobs: 1, jobUsd: 1, slack: { settled: 1, held: 0 } });
    expect(await reconcileMonthToDateSpend(input)).toEqual({ jobs: 0, jobUsd: 0, slack: { settled: 0, held: 0 } });
    expect(await readMonthlySpend('2026-11', home)).toEqual({ settledUsd: 1.1, reservedUsd: 0 });

    const replacement = join(home, 'outside.json');
    await writeFile(replacement, JSON.stringify(state));
    await rm(statePath);
    await symlink(replacement, statePath);
    await expect(reconcileMonthToDateSpend(input)).rejects.toThrow(/not a regular file/);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
