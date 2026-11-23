import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { shareScreenshotCommand } from '../../src/cli/commands/slack-screenshot.js';
import { registerProject } from '../../src/core/registry.js';
import { saveState } from '../../src/core/state.js';
import { SLACK_ROLES, writeSlackFile, type SlackConfig } from '../../src/slack/config.js';
import { inspectOutbox } from '../../src/slack/outbox.js';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=', 'base64');
let home: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-screenshot-'));
  vi.stubEnv('ANTON_HOME', home);
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(home, { recursive: true, force: true });
});

it('queues just the explicitly selected screenshot from a delivered job', async () => {
  const config = {
    teamId: 'TTEST', channelId: 'CANTON', ownerId: 'UOWNER',
    roles: Object.fromEntries(SLACK_ROLES.map((role, index) => [
      role, { appId: `AAPP${index}`, botUserId: `UBOT${index}` },
    ])),
  } as SlackConfig;
  await writeSlackFile(home, 'config.json', config);
  const repo = join(home, 'repo');
  const jobDir = join(repo, '.anton', 'jobs', '1-init');
  const screens = join(jobDir, 'evidence', 'screens');
  await mkdir(screens, { recursive: true });
  await writeFile(join(screens, 'AC-1.png'), png);
  await writeFile(join(screens, 'AC-2.png'), png);
  await registerProject('demo', repo);
  await saveState(jobDir, {
    project: 'demo', jobId: '1-init', kind: 'new', stage: 'awaiting_final_review',
    round: 1, maxRounds: 3, budgetUsd: 1, spentUsd: 0, warned80: false, completedTasks: [], updatedAt: '',
  });
  const d = { out: vi.fn(), err: vi.fn() };
  expect(await shareScreenshotCommand('demo', '../AC-2', d)).toBe(1);
  const result = await shareScreenshotCommand('demo', 'AC-1', d);
  expect(result, JSON.stringify(d.err.mock.calls)).toBe(0);
  const { entries } = await inspectOutbox({ config, home });
  expect(entries.map((entry) => entry.event)).toEqual([expect.objectContaining({
    project: 'demo', jobId: '1-init', kind: 'screenshot-ready', checkId: 'AC-1', sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
  })]);
});
