import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { intentSchema, resolveIntent } from '../../src/slack/intents.js';
import type { LoadedJob } from '../../src/core/job-actions.js';

const job = {
  name: 'todo', jobId: '1-init', state: { stage: 'build' },
} as LoadedJob;
const context = { projects: ['todo', 'blog'], loadJob: async () => job };

const runNonce = `${process.pid}.00000000-0000-4000-8000-000000000001`;
async function fixtureJob() {
  const repo = await mkdtemp(join(tmpdir(), 'anton-intents-'));
  await mkdir(join(repo, '.anton'));
  return { ...job, repo };
}
describe('intent resolution', () => {
  it('asks for a project when multiple match and refuses a made-up name', async () => {
    expect(await resolveIntent({ intent: 'stop' }, context)).toMatchObject({ kind: 'clarification' });
    expect(await resolveIntent({ intent: 'stop', project: 'invented' }, context)).toMatchObject({ kind: 'refused' });
  });

  it('checks the stage and any explicitly named job', async () => {
    expect(await resolveIntent({ intent: 'approve', project: 'todo' }, context)).toMatchObject({ kind: 'refused' });
    expect(await resolveIntent({ intent: 'stop', project: 'todo', jobId: '2-new' }, context)).toMatchObject({ kind: 'refused' });
    const running = await fixtureJob();
    const channel = { ...context, channelProject: 'todo', loadJob: async () => running };
    expect(await resolveIntent({ intent: 'stop' }, channel)).toMatchObject({ kind: 'refused' });
    await writeFile(join(running.repo, '.anton', 'run.lock'), JSON.stringify({ pid: process.pid, nonce: runNonce }));
    expect(await resolveIntent({ intent: 'stop' }, channel)).toEqual({
      kind: 'operation', operation: { kind: 'stop', target: { project: 'todo', jobId: '1-init', stage: 'build', runNonce } },
    });
  });

  it('selects the only eligible checkpoint and binds its revision', async () => {
    const review = { ...job, state: { ...job.state, stage: 'awaiting_final_review' as const } };
    const result = await resolveIntent({ intent: 'approve' }, {
      ...context,
      loadJob: async (name) => name === 'todo' ? review : { ...job, name },
      listTags: async () => ['anton/1-init/delivered-2', 'anton/1-init/delivered-10'],
    });
    expect(result).toEqual({
      kind: 'operation', operation: {
        kind: 'approve', target: { project: 'todo', jobId: '1-init', stage: 'awaiting_final_review', revision: 'delivered-10' },
      },
    });
  });

  it('rejects an unknown finding before producing a preview', async () => {
    expect(await resolveIntent({ intent: 'accept_risk', project: 'todo', riskId: 'SEC-9', reason: 'Reviewed' }, {
      ...context,
      loadJob: async () => ({ ...job, jobDir: '/nonexistent', state: { ...job.state, stage: 'paused' } }),
    })).toEqual({ kind: 'refused', text: 'No finding named SEC-9 is recorded for this job.' });
  });

  it('refuses resume while a runner is live or a spawn is pending', async () => {
    const active = await fixtureJob();
    const intent = { intent: 'resume', project: 'todo' } as const;
    const activeContext = { ...context, loadJob: async () => active };
    expect(await resolveIntent(intent, activeContext)).toMatchObject({ kind: 'operation' });
    await writeFile(join(active.repo, '.anton', 'spawn-claim.json'), JSON.stringify({
      pid: process.pid, jobId: active.jobId, at: Date.now(),
    }));
    expect(await resolveIntent(intent, activeContext)).toMatchObject({ kind: 'refused' });
    await writeFile(join(active.repo, '.anton', 'run.lock'), JSON.stringify({ pid: process.pid, nonce: runNonce }));
    const paused = { ...active, state: { ...active.state, stage: 'paused' as const } };
    expect(await resolveIntent(intent, { ...context, loadJob: async () => paused })).toMatchObject({ kind: 'refused' });
  });

  it.each(['budget_cap', 'allowance'] as const)('allows previewing resume options on a %s pause', async (pauseReason) => {
    const active = await fixtureJob();
    const paused = {
      ...active, state: { ...active.state, stage: 'paused' as const, pausedFrom: 'build' as const, pauseReason, spentUsd: 5 },
    };
    const pausedContext = { ...context, loadJob: async () => paused };
    const intent = { intent: 'resume', project: 'todo' } as const;
    expect(await resolveIntent(intent, pausedContext)).toMatchObject({ kind: 'operation' });
    expect(await resolveIntent({ ...intent, budgetUsd: 5 }, pausedContext)).toMatchObject({ kind: 'refused' });
    expect(await resolveIntent({ ...intent, budgetUsd: 6 }, pausedContext)).toMatchObject({ kind: 'operation' });
    expect(await resolveIntent({ ...intent, acceptAsIs: true }, pausedContext)).toMatchObject({ kind: 'operation' });
  });

  it('asks for omitted notes and risk details', async () => {
    expect(intentSchema.safeParse({ intent: 'revise_spec' }).success).toBe(true);
    expect(await resolveIntent({ intent: 'revise_spec', project: 'todo' }, context)).toMatchObject({ kind: 'clarification' });
    expect(await resolveIntent({ intent: 'accept_risk', project: 'todo', riskId: 'SEC-1' }, context)).toMatchObject({ kind: 'clarification' });
  });
});
