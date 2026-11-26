import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { chatSpentUsd } from '../../src/slack/chat-budget.js';
import { classifyIntent } from '../../src/slack/intent-router.js';

const input = { teamId: 'T0FAKE', requestKey: 'event:one', text: 'How is todo going?', projects: [{ project: 'todo' }] };
const fakeKey = 'fake-key-for-testing';
const usage = { input_tokens: 500, output_tokens: 20 };
const response = (text: string) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage }) as Message;

async function fixture(raw = '{"intent":"status","project":"todo"}') {
  const home = await mkdtemp(join(tmpdir(), 'anton-intent-router-'));
  const send = vi.fn(async (_params: MessageCreateParamsNonStreaming) => response(raw));
  const deps = {
    home, env: { ANTHROPIC_API_KEY: fakeKey }, client: () => ({ send }), settings: { monthlyUsd: 5, perAnswerUsd: 0.1 },
  };
  return { deps, send, home };
}

describe('classifyIntent', () => {
  it.each(['not json', '{"intent":"invented"}', '{"intent":"status","notes":"wrong field"}'])(
    'asks for clarification on invalid output %s and still settles usage', async (raw) => {
      const { home, deps } = await fixture(raw);
      expect(await classifyIntent(input, deps)).toMatchObject({ kind: 'clarification' });
      expect(await chatSpentUsd(input.teamId, Date.now(), { home })).toBeCloseTo(0.00006, 10);
    },
  );

  it('deduplicates simultaneous deliveries before the model call', async () => {
    const { deps, send } = await fixture();
    const results = await Promise.all([classifyIntent(input, deps), classifyIntent(input, deps)]);
    expect(results).toContainEqual({ kind: 'intent', intent: { intent: 'status', project: 'todo' } });
    expect(results).toContainEqual({ kind: 'duplicate' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('rejects oversized UTF-8 messages and reports missing keys and empty budgets', async () => {
    const { deps, send } = await fixture();
    expect(await classifyIntent({ ...input, text: '🙂'.repeat(1501) }, deps)).toEqual({ kind: 'unavailable', reason: 'input_too_large' });
    expect(await classifyIntent(input, { ...deps, env: {} })).toEqual({ kind: 'unavailable', reason: 'missing_key' });
    expect(await classifyIntent(input, { ...deps, settings: { ...deps.settings, monthlyUsd: 0 } })).toEqual({ kind: 'unavailable', reason: 'budget' });
    expect(send).not.toHaveBeenCalled();
  });

  it('keeps a conservative reservation when the provider outcome is unknown', async () => {
    const { deps, send, home } = await fixture();
    send.mockRejectedValueOnce(new Error('timeout'));
    expect(await classifyIntent(input, deps)).toEqual({ kind: 'unavailable', reason: 'provider_error' });
    expect(await chatSpentUsd(input.teamId, Date.now(), { home })).toBeGreaterThan(0.00006);
    expect(await classifyIntent(input, deps)).toEqual({ kind: 'duplicate' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('redacts project secrets from the message and from returned notes', async () => {
    const value = 'fixture-sensitive-value';
    const { deps, send } = await fixture(JSON.stringify({ intent: 'revise_spec', notes: `Remove ${value}` }));
    const result = await classifyIntent({ ...input, text: `Remove ${value}` }, {
      ...deps, loadSecrets: async () => ({ SECRET: value }),
    });
    expect(result).toMatchObject({ kind: 'intent', intent: { notes: 'Remove [REDACTED:todo/SECRET]' } });
    expect(send.mock.calls[0]?.[0].messages[0]?.content).not.toContain(value);
  });

  it('uses fixed fence delimiters and checks the escaped UTF-8 byte length', async () => {
    const { deps, send } = await fixture();
    const tick = String.fromCharCode(96);
    const fence = tick.repeat(3);
    const text = tick.repeat(1000);
    await classifyIntent({ ...input, text }, deps);
    const lines = String(send.mock.calls[0]?.[0].messages[0]?.content).split('\n');
    expect(lines.filter((line) => line === fence)).toHaveLength(4);
    expect(lines[2]).toBe('\\u0060'.repeat(1000));
    expect(Buffer.byteLength(lines[2]!)).toBe(6000);
    expect(await classifyIntent({ ...input, requestKey: 'event:larger', text: text + tick }, deps))
      .toEqual({ kind: 'unavailable', reason: 'input_too_large' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends bounded allowlisted facts and redacts fenced message text', async () => {
    const { deps, send } = await fixture();
    const projects = Array.from({ length: 300 }, (_, i) => ({
      project: `project-${i}`, jobId: '1-init', stage: 'build' as const, privateField: 'excluded',
    }));
    await classifyIntent({ ...input, projects, text: `Use ${fakeKey} and \`\`\`\` safely` }, deps);
    const [params] = send.mock.calls[0]!;
    expect(params).toMatchObject({
      model: 'claude-haiku-5-5', max_tokens: 600, thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { schema: { type: 'object' } } },
    });
    const content = String(params.messages[0]?.content);
    expect(content).toContain('Use [REDACTED:ANTHROPIC_API_KEY]');
    expect(content).not.toContain(fakeKey);
    expect(content).not.toContain('excluded');
    const match = /Project facts:\n`{3,}\n([^\n]*)/.exec(content);
    expect(match).not.toBeNull();
    expect(Buffer.byteLength(match![1]!)).toBeLessThanOrEqual(4000);
    expect(JSON.parse(match![1]!)).toContainEqual({ project: 'project-0', jobId: '1-init', stage: 'build' });
  });
});
