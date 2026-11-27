import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadAntonConfig } from '../../src/core/anton-config.js';
import { recordSpend } from '../../src/core/spend-log.js';
import { readSettingsHistory } from '../../src/core/settings-history.js';
import { completeTrialJob } from '../../src/core/trial.js';

const trialConfig = (jobsLeft: number) => [
  'models:',
  '  trial:',
  '    role: qa',
  '    model: claude-haiku-5-5',
  '    effort: medium',
  `    jobsLeft: ${jobsLeft}`,
  '    revertTo: { model: claude-sonnet-5-5, effort: high }',
  '',
].join('\n');

describe('model trial completion', () => {
  let home: string;
  beforeEach(async () => { home = await mkdtemp(join(tmpdir(), 'anton-trial-')); });
  afterEach(async () => { await rm(home, { recursive: true, force: true }); });

  const ranQa = (jobId: string, model = 'claude-haiku-5-5') => recordSpend({
    id: `b-${jobId}-${model}`, at: new Date().toISOString(), source: 'build', project: 'todo', jobId, role: 'qa', model, usd: 0.5,
  }, home);

  it('counts a finished job once when the trial role ran on the trial model', async () => {
    await writeFile(join(home, 'config.yaml'), trialConfig(3));
    await ranQa('1-init');
    expect(await completeTrialJob({ project: 'todo', jobId: '1-init' }, home)).toBe('Model trial: qa on claude-haiku-5-5 has 2 jobs left.');
    expect(await completeTrialJob({ project: 'todo', jobId: '1-init' }, home)).toBeUndefined();
    expect((await loadAntonConfig(home)).models?.trial?.jobsLeft).toBe(2);
    // An automatic count is not the Owner's change, so "undo that" never picks it.
    expect((await readSettingsHistory(home)).history.at(-1)).toMatchObject({ intent: 'trial_job:todo/1-init', source: 'auto' });
  });

  it('ignores a job where the trial role did not run on the trial model', async () => {
    await writeFile(join(home, 'config.yaml'), trialConfig(3));
    await ranQa('2-other', 'claude-sonnet-5-5');
    expect(await completeTrialJob({ project: 'todo', jobId: '2-other' }, home)).toBeUndefined();
    expect((await loadAntonConfig(home)).models?.trial?.jobsLeft).toBe(3);
  });

  it('ends the trial at zero and restores what was in effect before', async () => {
    await writeFile(join(home, 'config.yaml'), trialConfig(1));
    await ranQa('3-last');
    expect(await completeTrialJob({ project: 'todo', jobId: '3-last' }, home)).toBe('Model trial ended: qa is back on claude-sonnet-5-5 (high).');
    const models = (await loadAntonConfig(home)).models;
    expect(models?.trial).toBeUndefined();
    // Balanced QA is Sonnet at medium effort, so the earlier high effort is kept as an override.
    expect(models?.roles?.qa).toEqual({ model: 'claude-sonnet-5-5', effort: 'high' });
    expect(await readFile(join(home, 'config.yaml'), 'utf8')).not.toContain('trial');
  });
});
