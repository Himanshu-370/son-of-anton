import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, type EntryDeps } from '../../src/agent/entry.js';
import { AgentEventSchema, type AgentEvent, type AgentRequest } from '../../src/agent/protocol.js';

type QueryFn = NonNullable<EntryDeps['query']>;

const baseReq: AgentRequest = {
  role: 'builder', model: 'claude-test', effort: 'medium', systemPrompt: 'be terse', prompt: 'do it',
  maxTurns: 7, budgetUsd: 2.5,
};

const success = (total: number, extra: Record<string, unknown> = {}) => ({
  type: 'result', subtype: 'success', is_error: false, result: 'done', session_id: 'sess-1',
  total_cost_usd: total, num_turns: 1, ...extra,
});
type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number };
const assistant = (text: string, id = 'msg', usage: Usage = { input_tokens: 0, output_tokens: 0 }, model?: string) => ({
  type: 'assistant', session_id: 'sess-1', parent_tool_use_id: null,
  message: { id, model, content: [{ type: 'text', text }], usage },
});
const costs = (events: AgentEvent[]) =>
  events.filter((e): e is Extract<AgentEvent, { type: 'cost' }> => e.type === 'cost').map((e) => e.totalUsd);

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'anton-entry-'));
});

async function run(req: AgentRequest, script: (opts: unknown) => AsyncGenerator<unknown>) {
  const path = join(dir, 'req.json');
  await writeFile(path, JSON.stringify(req));
  const lines: string[] = [];
  const calls: unknown[] = [];
  const query = ((params: { prompt: string; options?: unknown }) => {
    calls.push(params);
    return script(params.options);
  }) as unknown as QueryFn;
  await main(path, { query, write: (l) => lines.push(l) });
  // every emitted line is exactly one JSON object that parses as a protocol event
  const events = lines.map((l) => {
    expect(l.endsWith('\n')).toBe(true);
    expect(l.trimEnd().includes('\n')).toBe(false);
    return AgentEventSchema.parse(JSON.parse(l)) as AgentEvent;
  });
  return { events, calls: calls as Array<{ prompt: string; options: Record<string, unknown> }> };
}

describe('entry main', () => {
  it('emits cost events as usage arrives and a final result with output', async () => {
    // claude-test is unknown -> opus prices: $4/M in, $20/M out, cache read 0.4, cache write 5.
    const { events } = await run(baseReq, async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield assistant('working on it', 'm1', { input_tokens: 1000, output_tokens: 500 }); // 0.004 + 0.01
      // same id again (parallel tool use): must not double count
      yield assistant('more of m1', 'm1', { input_tokens: 1000, output_tokens: 500 });
      yield assistant('step 2', 'm2', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 10_000, cache_creation_input_tokens: 1000 }); // 0.004 + 0.005
      yield success(0.42);
    });
    expect(events).toContainEqual({ type: 'log', text: 'working on it' });
    const c = costs(events);
    // Only interim estimates: the result's authoritative total rides on the result event (R4).
    expect(c).toHaveLength(2);
    expect(c[0]).toBeCloseTo(0.014, 10);
    expect(c[1]).toBeCloseTo(0.023, 10);
    const firstCost = events.findIndex((e) => e.type === 'cost');
    expect(firstCost).toBeLessThan(events.findIndex((e) => e.type === 'log' && e.text === 'step 2'));
    expect(events.at(-1)).toEqual({ type: 'result', ok: true, output: 'done', sessionId: 'sess-1', totalUsd: 0.42, protocolVersion: 3 });
  });

  it('emits no cost event for the result message, even when its total exceeds the estimates (R4)', async () => {
    const { events } = await run(baseReq, async function* () {
      yield assistant('a', 'm1', { input_tokens: 1000, output_tokens: 500 }); // 0.014
      yield success(5);
    });
    expect(costs(events)).toEqual([expect.closeTo(0.014, 10)]);
    expect(events.at(-1)).toMatchObject({ type: 'result', totalUsd: 5 });
    // and an error result too
    const err = await run(baseReq, async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', total_cost_usd: 3, errors: ['x'] };
    });
    expect(costs(err.events)).toEqual([]);
    expect(err.events.at(-1)).toMatchObject({ type: 'error', totalUsd: 3 });
  });

  it('offsets interim estimates by baseUsd so they compare with the SDK cumulative total on resume', async () => {
    const { events } = await run({ ...baseReq, baseUsd: 1 }, async function* () {
      yield assistant('a', 'm1', { input_tokens: 1000, output_tokens: 500 }); // 0.014
      yield success(1.02);
    });
    expect(costs(events)).toEqual([expect.closeTo(1.014, 10)]);
    expect(events.at(-1)).toMatchObject({ type: 'result', totalUsd: 1.02 });
  });

  it('prices interim cost by the model on the assistant message (haiku)', async () => {
    const { events } = await run({ ...baseReq, model: 'claude-haiku-5-5' }, async function* () {
      yield assistant('a', 'h1', { input_tokens: 1_000_000, output_tokens: 1_000_000 }, 'claude-haiku-5-5');
      yield success(0.7);
    });
    expect(costs(events)[0]).toBeCloseTo(0.6, 10);
  });

  it('result total below the interim estimate does not emit a decreasing cost event', async () => {
    const { events } = await run(baseReq, async function* () {
      yield assistant('a', 'm1', { input_tokens: 1000, output_tokens: 500 }); // 0.014
      yield success(0.01);
    });
    expect(costs(events)).toEqual([expect.closeTo(0.014, 10)]);
    expect(events.at(-1)).toMatchObject({ type: 'result', totalUsd: 0.01 });
  });

  it('passes model, cwd=/workspace, maxTurns and systemPrompt through', async () => {
    const { calls } = await run(
      { ...baseReq, resumeSessionId: 'prev-sess' },
      async function* () { yield success(0.01); },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe('do it');
    expect(calls[0].options).toMatchObject({
      model: 'claude-test',
      cwd: '/workspace',
      maxTurns: 7,
      systemPrompt: 'be terse',
      effort: 'medium',
      maxBudgetUsd: 2.5,
      resume: 'prev-sess',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
    });
    expect(calls[0].options).not.toHaveProperty('outputFormat');
  });

  it("systemPromptMode 'append' uses the claude_code preset with the role prompt appended", async () => {
    const { calls } = await run({ ...baseReq, systemPromptMode: 'append' }, async function* () { yield success(0.01); });
    expect(calls[0].options.systemPrompt).toEqual({ type: 'preset', preset: 'claude_code', append: 'be terse' });
    const replace = await run({ ...baseReq, systemPromptMode: 'replace' }, async function* () { yield success(0.01); });
    expect(replace.calls[0].options.systemPrompt).toBe('be terse');
  });

  it('passes outputSchema as a json_schema outputFormat and returns structured_output', async () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
    const { events, calls } = await run({ ...baseReq, outputSchema: schema }, async function* () {
      yield success(0.1, { structured_output: { n: 3 } });
    });
    expect(calls[0].options.outputFormat).toEqual({ type: 'json_schema', schema });
    expect(events.at(-1)).toMatchObject({ type: 'result', output: { n: 3 }, totalUsd: 0.1 });
  });

  it('falls back to parsing the final text as JSON when structured_output is absent', async () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
    const { events } = await run({ ...baseReq, outputSchema: schema }, async function* () {
      yield success(0.1, { result: '{"n": 5}' });
    });
    expect(events.at(-1)).toMatchObject({ type: 'result', output: { n: 5 } });
  });

  it('when outputSchema is set and the final text is not valid against it, emits error', async () => {
    const schema = { type: 'object', properties: { n: { type: 'number' } }, required: ['n'] };
    const notJson = await run({ ...baseReq, outputSchema: schema }, async function* () {
      yield success(0.2, { result: 'sure, here you go' });
    });
    expect(notJson.events.at(-1)).toMatchObject({ type: 'error', totalUsd: 0.2 });
    expect(notJson.events.some((e) => e.type === 'result')).toBe(false);

    const wrongShape = await run({ ...baseReq, outputSchema: schema }, async function* () {
      yield success(0.3, { result: '{"n": "five"}' });
    });
    expect(wrongShape.events.at(-1)).toMatchObject({ type: 'error', totalUsd: 0.3 });
  });

  it('an SDK error result becomes an error event even if query() then throws', async () => {
    const { events } = await run(baseReq, async function* () {
      yield { type: 'result', subtype: 'error_max_budget_usd', is_error: true, session_id: 's', total_cost_usd: 2.6, errors: [] };
      throw new Error('Claude Code process exited with code 1');
    });
    const terminal = events.filter((e) => e.type === 'error' || e.type === 'result');
    expect(terminal).toHaveLength(1);
    expect(terminal[0]).toMatchObject({ type: 'error', totalUsd: 2.6 });
    expect((terminal[0] as { message: string }).message).toContain('error_max_budget_usd');
    expect(terminal[0]).toMatchObject({ code: 'budget' });
  });

  it('other error results carry no code', async () => {
    const { events } = await run(baseReq, async function* () {
      yield { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 's', total_cost_usd: 0.1, errors: [] };
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'error_max_turns', totalUsd: 0.1, protocolVersion: 3 });
  });

  it('uncaught SDK exception becomes an error event with totalUsd so far', async () => {
    // No result message yet, so "so far" is the interim token-based estimate.
    const { events } = await run(baseReq, async function* () {
      yield assistant('step', 'm1', { input_tokens: 1000, output_tokens: 500 });
      throw new Error('kaboom');
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'kaboom', totalUsd: expect.closeTo(0.014, 10), protocolVersion: 3 });

    // A crash result (error_during_execution) carries the total seen; a later throw adds nothing.
    const { events: ev2 } = await run(baseReq, async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 's', total_cost_usd: 0.09, errors: ['socket hang up'] };
      throw new Error('process exited');
    });
    expect(ev2.filter((e) => e.type === 'error' || e.type === 'result')).toEqual([
      { type: 'error', message: 'error_during_execution: socket hang up', totalUsd: 0.09, protocolVersion: 3 },
    ]);
  });

  it('a success-subtype result with is_error (e.g. not logged in) becomes an error event', async () => {
    const { events } = await run(baseReq, async function* () {
      yield success(0, { is_error: true, result: 'Not logged in · Please run /login' });
    });
    expect(events.at(-1)).toEqual({ type: 'error', message: 'Not logged in · Please run /login', totalUsd: 0, protocolVersion: 3 });
  });

  it('a stream that ends without a result emits an error', async () => {
    const { events } = await run(baseReq, async function* () { yield assistant('hm'); });
    expect(events.at(-1)).toMatchObject({ type: 'error', totalUsd: 0 });
  });

  it('an invalid request file becomes an error event', async () => {
    const path = join(dir, 'bad.json');
    await writeFile(path, '{"role": 1}');
    const lines: string[] = [];
    await main(path, { query: (() => { throw new Error('unused'); }) as unknown as QueryFn, write: (l) => lines.push(l) });
    expect(lines).toHaveLength(1);
    expect(AgentEventSchema.parse(JSON.parse(lines[0]))).toMatchObject({ type: 'error', totalUsd: 0, protocolVersion: 3 });
  });

  it('result and error events echo protocolVersion 3; log and cost events do not carry it', async () => {
    const ok = await run(baseReq, async function* () {
      yield assistant('step', 'm1', { input_tokens: 1000, output_tokens: 0 });
      yield success(0.1);
    });
    expect(ok.events.at(-1)).toMatchObject({ type: 'result', protocolVersion: 3 });
    expect(ok.events.filter((e) => e.type === 'log' || e.type === 'cost').every((e) => !('protocolVersion' in e))).toBe(true);
    const bad = await run(baseReq, async function* () { yield assistant('hm'); });
    expect(bad.events.at(-1)).toMatchObject({ type: 'error', protocolVersion: 3 });
  });

  it('a request for a different protocolVersion is refused', async () => {
    const { events, calls } = await run({ ...baseReq, protocolVersion: 4 } as AgentRequest, async function* () { yield success(0); });
    expect(calls).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: 'error', protocolVersion: 3 });
    expect((events.at(-1) as { message: string }).message).toContain('protocol');
  });

  it('tools restricts the session to exactly the listed tools', async () => {
    const { calls } = await run({ ...baseReq, tools: ['Read', 'Grep', 'Glob'] }, async function* () {
      yield success(0.1);
    });
    expect(calls[0]!.options.tools).toEqual(['Read', 'Grep', 'Glob']);
    expect(calls[0]!.options.allowedTools).toBeUndefined();
    expect(calls[0]!.options.strictMcpConfig).toBe(true);
    expect(calls[0]!.options.mcpServers).toEqual({});
    expect(calls[0]!.options.settingSources).toEqual([]);
  });

  it('no tools field leaves the built-in tool set at SDK defaults', async () => {
    const { calls } = await run(baseReq, async function* () {
      yield success(0.1);
    });
    expect('tools' in calls[0]!.options).toBe(false);
    expect('allowedTools' in calls[0]!.options).toBe(false);
  });

  it('entry sets strictMcpConfig, AskUserQuestion block and skills for every session', async () => {
    const server = { command: '/opt/anton/plugins/a-b/cave/0123456789ab/bin/db' };
    const builder = await run(
      { ...baseReq, plugins: ['/opt/anton/plugins/a-b/cave/0123456789ab'], skills: ['cave:hello'], mcpServers: { cavedb: server } },
      async function* () { yield success(0); },
    );
    expect(builder.calls[0]!.options).toMatchObject({
      disallowedTools: ['AskUserQuestion'],
      strictMcpConfig: true,
      mcpServers: { cavedb: server },
      plugins: [{ type: 'local', path: '/opt/anton/plugins/a-b/cave/0123456789ab', skipMcpDiscovery: true }],
      skills: ['cave:hello'],
    });
    for (const req of [baseReq, { ...baseReq, tools: ['Read'] }]) {
      const { calls } = await run(req, async function* () { yield success(0); });
      expect(calls[0]!.options).toMatchObject({ disallowedTools: ['AskUserQuestion'], strictMcpConfig: true, mcpServers: {}, plugins: [], skills: [] });
    }
  });

  it('no session loads repo settings: builder and reviewer both get settingSources []', async () => {
    const builder = await run(baseReq, async function* () { yield success(0); });
    expect(builder.calls[0]!.options.settingSources).toEqual([]);
    const reviewer = await run({ ...baseReq, tools: ['Read', 'Grep'] }, async function* () { yield success(0); });
    expect(reviewer.calls[0]!.options.settingSources).toEqual([]);
  });
});
