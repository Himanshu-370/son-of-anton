import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claimIntentThreadReply, completeIntentThreadClarification, registerIntentThread } from '../../src/slack/intent-threads.js';

const binding = { teamId: 'T1', channelId: 'D1', threadTs: '1700000000.000001', ownerId: 'U1' };
const clarification = { kind: 'clarification', project: 'todo-app', originalText: 'Please ship it' } as const;
const minute = 60_000;
let home: string;
let time: number;
const options = () => ({ home, now: () => time });

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'anton-intent-threads-'));
  time = Date.UTC(2026, 10, 27);
});
afterEach(async () => { await rm(home, { recursive: true, force: true }); });

describe('intent thread storage', () => {
  it('binds the saved conversation to every identity field and refuses an owner overwrite', async () => {
    expect(await registerIntentThread(binding, clarification, options())).toBe(true);
    for (const mismatch of [
      { teamId: 'T2' }, { channelId: 'D2' }, { threadTs: '1700000000.000002' }, { ownerId: 'U2' },
    ]) {
      expect(await claimIntentThreadReply({ ...binding, ...mismatch }, options())).toEqual({ kind: 'missing' });
    }
    expect(await registerIntentThread({ ...binding, ownerId: 'U2' }, clarification, options())).toBe(false);
    expect(await claimIntentThreadReply(binding, options())).toEqual({
      kind: 'retry', project: 'todo-app', originalText: 'Please ship it', retryClaim: expect.any(String),
    });
  });

  it('atomically binds a new thread when two owners race to register it', async () => {
    const contenders = [binding, { ...binding, ownerId: 'U2' }];
    const registrations = await Promise.all(contenders.map((identity) =>
      registerIntentThread(identity, clarification, options())));
    expect(registrations.filter(Boolean)).toHaveLength(1);
    const replies = await Promise.all(contenders.map((identity) => claimIntentThreadReply(identity, options())));
    expect(replies.map(({ kind }) => kind)).toEqual(registrations.map((won) => won ? 'retry' : 'missing'));
  });

  it('lets one concurrent delivery claim the retry and never rearms the thread', async () => {
    await registerIntentThread(binding, clarification, options());
    const replies = await Promise.all(Array.from({ length: 8 }, () => claimIntentThreadReply(binding, options())));
    expect(replies.filter(({ kind }) => kind === 'retry')).toHaveLength(1);
    expect(replies.filter(({ kind }) => kind === 'help')).toHaveLength(7);
    expect(await registerIntentThread(binding, clarification, options())).toBe(false);
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'help' });
    expect(await readFile(join(home, 'slack', 'intent-threads.json'), 'utf8')).not.toContain(clarification.originalText);
  });

  it('treats ten minutes and twenty-four hours as exclusive cutoffs', async () => {
    const second = { ...binding, threadTs: '1700000000.000002' };
    await registerIntentThread(binding, clarification, options());
    await registerIntentThread(second, clarification, options());
    time += 10 * minute - 1;
    expect(await claimIntentThreadReply(second, options())).toMatchObject({ kind: 'retry' });
    time += 1;
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'help' });
    time += (24 * 60 - 10) * minute - 1;
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'help' });
    time += 1;
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'missing' });
    expect(await readFile(join(home, 'slack', 'intent-threads.json'), 'utf8')).not.toContain(binding.threadTs);
  });

  it('promotes only the owner’s claimed retry and preserves the original expiry', async () => {
    await registerIntentThread(binding, clarification, options());
    time += 9 * minute;
    const retry = await claimIntentThreadReply(binding, options());
    if (retry.kind !== 'retry') throw new Error('Expected a clarification claim');
    expect(await completeIntentThreadClarification({ ...binding, ownerId: 'U2' }, retry.retryClaim, 'blog', options())).toBe(false);
    expect(await completeIntentThreadClarification(binding, 'wrong-claim', 'blog', options())).toBe(false);
    expect(await completeIntentThreadClarification(binding, retry.retryClaim, 'blog', options())).toBe(true);
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'context', project: 'blog' });
    time += (24 * 60 - 9) * minute;
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'missing' });
  });

  it('persists project context for ordinary intent threads without consuming it', async () => {
    await registerIntentThread(binding, { kind: 'context', project: 'todo-app' }, options());
    for (let i = 0; i < 2; i++) {
      expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'context', project: 'todo-app' });
    }
    time += 24 * 60 * minute;
    expect(await claimIntentThreadReply(binding, options())).toEqual({ kind: 'missing' });
  });

  it('redacts supplied secret values and common credential forms before writing', async () => {
    const secret = 'fixture-value-for-redaction';
    await registerIntentThread(binding, {
      kind: 'clarification', originalText: `Ship it ${secret} password=<fixture> xoxb-FAKE`,
    }, { ...options(), secrets: { TEST_SECRET: secret } });
    const disk = await readFile(join(home, 'slack', 'intent-threads.json'), 'utf8');
    for (const raw of [secret, 'fixture>', 'xoxb-FAKE']) expect(disk).not.toContain(raw);
    expect(await claimIntentThreadReply(binding, options())).toMatchObject({
      kind: 'retry', originalText: 'Ship it [REDACTED] password=[REDACTED] [REDACTED]',
    });
  });
});
