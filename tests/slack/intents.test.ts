import { describe, expect, it } from 'vitest';
import { intentSchema, resolveIntent } from '../../src/slack/intents.js';
import type { LoadedJob } from '../../src/core/job-actions.js';

const job = {
  name: 'todo', jobId: '1-init', state: { stage: 'build' },
} as LoadedJob;
const context = { projects: ['todo', 'blog'], loadJob: async () => job };

describe('intent resolution', () => {
  it('asks for a project when multiple match and refuses a made-up name', async () => {
    expect(await resolveIntent({ intent: 'stop' }, context)).toMatchObject({ kind: 'clarification' });
    expect(await resolveIntent({ intent: 'stop', project: 'invented' }, context)).toMatchObject({ kind: 'refused' });
  });

  it('checks the stage and any explicitly named job', async () => {
    expect(await resolveIntent({ intent: 'approve', project: 'todo' }, context)).toMatchObject({ kind: 'refused' });
    expect(await resolveIntent({ intent: 'stop', project: 'todo', jobId: '2-new' }, context)).toMatchObject({ kind: 'refused' });
    expect(await resolveIntent({ intent: 'stop' }, { ...context, channelProject: 'todo' })).toEqual({
      kind: 'operation', operation: { kind: 'stop', target: { project: 'todo', jobId: '1-init', stage: 'build' } },
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

  it('asks for omitted notes and risk details', async () => {
    expect(intentSchema.safeParse({ intent: 'revise_spec' }).success).toBe(true);
    expect(await resolveIntent({ intent: 'revise_spec', project: 'todo' }, context)).toMatchObject({ kind: 'clarification' });
    expect(await resolveIntent({ intent: 'accept_risk', project: 'todo', riskId: 'SEC-1' }, context)).toMatchObject({ kind: 'clarification' });
  });
});
