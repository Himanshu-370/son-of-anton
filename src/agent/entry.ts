/**
 * In-container agent entry: `node /opt/anton/entry.js <requestPath>`.
 * Reads an AgentRequest (JSON) and runs one Claude Agent SDK `query()`. It writes only
 * AgentEvent JSONL to stdout (see ./protocol.ts).
 *
 * SDK facts, checked 2026-11-19 against code.claude.com/docs/en/agent-sdk/typescript,
 * the agent-sdk/cost-tracking page, and the installed @anthropic-ai/claude-agent-sdk@0.3.328 sdk.d.ts:
 * - `query({ prompt: string | AsyncIterable<SDKUserMessage>, options?: Options }): Query`.
 *   Query is an AsyncGenerator<SDKMessage>.
 * - Options used here: `model` (string), `effort` ('low'|'medium'|'high'|'xhigh'|'max'; it works with
 *   the default adaptive `thinking`, so `thinking` is left unset), `systemPrompt` (a string replaces
 *   the default prompt), `cwd`, `maxTurns`, `resume` (a session id),
 *   `outputFormat: { type: 'json_schema', schema }` (native structured output),
 *   `maxBudgetUsd` (a native budget; it stops with an `error_max_budget_usd` result. It is a
 *   client-side estimate that can overshoot, so the host-side kill from Task 9 stays), and
 *   `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, which are
 *   needed for unattended runs (the image sets IS_SANDBOX=1 because the container runs as root).
 * - Result message (`type: 'result'`): `subtype` is 'success' or 'error_during_execution' |
 *   'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'. It carries
 *   `total_cost_usd` (the cumulative USD estimate for the call; a resumed session includes its earlier
 *   spend), `session_id`, `result` (the final text, on success), `structured_output` (when
 *   outputFormat is set) and `errors: string[]` (on errors).
 *   `is_error: true` can also appear with subtype success (seen for "Not logged in"); treated as error.
 *   A single-shot query() THROWS after yielding an error result, so that throw is ignored once a
 *   result has been seen.
 * - Mid-run usage: assistant messages carry only token `usage` (with placeholder output_tokens) and
 *   NO USD figure. USD is reported only on result messages. So a `cost` event is emitted whenever
 *   a result message arrives (once per single-shot call, right before the terminal event), and no
 *   cost is estimated from tokens mid-run.
 * - Structured output is native, and we also validate the returned value against req.outputSchema
 *   with zod's `z.fromJSONSchema`, falling back to an "is a JSON object" check if zod can't convert
 *   the schema. If `structured_output` is absent, the final text is parsed as JSON.
 */
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { AgentRequestSchema, type AgentEvent, type AgentRequest } from './protocol.js';

export type EntryDeps = {
  query?: typeof import('@anthropic-ai/claude-agent-sdk').query;
  write?: (line: string) => void;
};

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function buildOptions(req: AgentRequest): Options {
  const options: Options = {
    model: req.model,
    effort: req.effort,
    systemPrompt: req.systemPrompt,
    cwd: '/workspace',
    maxTurns: req.maxTurns,
    maxBudgetUsd: req.budgetUsd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
  if (req.resumeSessionId) options.resume = req.resumeSessionId;
  if (req.outputSchema) options.outputFormat = { type: 'json_schema', schema: req.outputSchema };
  return options;
}

/** Returns the validated output, or an error string. */
function checkOutput(schema: Record<string, unknown>, value: unknown): { ok: true; value: unknown } | { ok: false; error: string } {
  let validator: z.ZodType | undefined;
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
  } catch {
    validator = undefined;
  }
  if (validator) {
    const r = validator.safeParse(value);
    return r.success ? { ok: true, value: r.data } : { ok: false, error: `output does not match outputSchema: ${r.error.message}` };
  }
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ok: true, value }
    : { ok: false, error: 'output is not a JSON object' };
}

function terminalFromResult(req: AgentRequest, msg: Extract<SDKMessage, { type: 'result' }>): AgentEvent {
  const totalUsd = msg.total_cost_usd ?? 0;
  if (msg.subtype !== 'success') {
    const errors = (msg.errors ?? []).filter(Boolean);
    return { type: 'error', message: errors.length ? `${msg.subtype}: ${errors.join('; ')}` : msg.subtype, totalUsd };
  }
  // Observed live: auth failures arrive as subtype 'success' with is_error: true and the reason in `result`.
  if (msg.is_error) return { type: 'error', message: msg.result || 'agent reported an error', totalUsd };
  if (!req.outputSchema) {
    return { type: 'result', ok: true, output: msg.result, sessionId: msg.session_id, totalUsd };
  }
  let value = msg.structured_output;
  if (value === undefined) {
    try {
      value = JSON.parse(msg.result);
    } catch {
      return { type: 'error', message: 'final text is not valid JSON for outputSchema', totalUsd };
    }
  }
  const checked = checkOutput(req.outputSchema, value);
  return checked.ok
    ? { type: 'result', ok: true, output: checked.value, sessionId: msg.session_id, totalUsd }
    : { type: 'error', message: checked.error, totalUsd };
}

export async function main(requestPath: string, deps: EntryDeps = {}): Promise<void> {
  const write = deps.write ?? ((line: string) => void process.stdout.write(line));
  const emit = (e: AgentEvent) => write(JSON.stringify(e) + '\n');

  let req: AgentRequest;
  try {
    req = AgentRequestSchema.parse(JSON.parse(await readFile(requestPath, 'utf8')));
  } catch (e) {
    emit({ type: 'error', message: `invalid request: ${errMessage(e)}`, totalUsd: 0 });
    return;
  }

  const query = deps.query ?? (await import('@anthropic-ai/claude-agent-sdk')).query;
  let lastTotal = 0;
  let terminal: AgentEvent | undefined;
  try {
    for await (const msg of query({ prompt: req.prompt, options: buildOptions(req) })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) emit({ type: 'log', text: block.text });
          else if (block.type === 'tool_use') emit({ type: 'log', text: `tool: ${block.name}` });
        }
      } else if (msg.type === 'result') {
        lastTotal = msg.total_cost_usd ?? lastTotal;
        emit({ type: 'cost', totalUsd: lastTotal });
        terminal = terminalFromResult(req, msg);
      }
    }
  } catch (e) {
    // After an error result, single-shot query() throws by design; the result already describes it.
    if (!terminal) terminal = { type: 'error', message: errMessage(e), totalUsd: lastTotal };
  }
  emit(terminal ?? { type: 'error', message: 'agent ended without a result', totalUsd: lastTotal });
}

async function isEntryScript(): Promise<boolean> {
  if (!process.argv[1]) return false;
  try {
    return (await realpath(process.argv[1])) === (await realpath(fileURLToPath(import.meta.url)));
  } catch {
    return false;
  }
}

if (await isEntryScript()) {
  const requestPath = process.argv[2];
  if (!requestPath) {
    process.stdout.write(JSON.stringify({ type: 'error', message: 'usage: entry.js <requestPath>', totalUsd: 0 }) + '\n');
    process.exitCode = 2;
  } else {
    await main(requestPath);
  }
}
