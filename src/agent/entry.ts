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
 *   the default prompt; `{ type: 'preset', preset: 'claude_code', append }` keeps Claude Code's
 *   default prompt and appends ours), `cwd`, `maxTurns`, `resume` (a session id),
 *   `outputFormat: { type: 'json_schema', schema }` (native structured output),
 *   `maxBudgetUsd` (a native budget; it stops with an `error_max_budget_usd` result. It is a
 *   client-side estimate that can overshoot, so the host-side kill from Task 9 stays), and
 *   `permissionMode: 'bypassPermissions'` + `allowDangerouslySkipPermissions: true`, which are
 *   needed for unattended runs (the image sets IS_SANDBOX=1 because the container runs as root).
 * - Result message (`type: 'result'`): `subtype` is 'success' or 'error_during_execution' |
 *   'error_max_turns' | 'error_max_budget_usd' | 'error_max_structured_output_retries'. It carries
 *   `total_cost_usd` (the cumulative USD estimate for the call; a resumed session includes its earlier
 *   spend, so the host passes the previous call's total as req.baseUsd and counts only the increment
 *   over it, and interim estimates here are offset by baseUsd to match), `session_id`, `result` (the
 *   final text, on success), `structured_output` (when outputFormat is set) and `errors: string[]`
 *   (on errors).
 *   `is_error: true` can also appear with subtype success (seen for "Not logged in"); treated as error.
 *   A single-shot query() THROWS after yielding an error result, so that throw is ignored once a
 *   result has been seen.
 * - Mid-run usage: assistant messages carry only token `usage` (input, output, cache read and cache
 *   creation; per-step output_tokens is a placeholder from message_start, so it undercounts) and NO
 *   USD figure. USD is reported only on result messages. Per ruling R6 we emit interim cumulative
 *   `cost` events estimated from that usage with ./pricing.ts. Usage is deduplicated by message id,
 *   because parallel tool uses share one id. When the result arrives, its `total_cost_usd` is
 *   authoritative and is carried ONLY on the terminal result/error event (no `cost` event for the
 *   result message, so a finished call over the cap is returned, not killed: R4). A cost event is
 *   emitted only when the estimate rises, so cost events never decrease: if the estimate overshot,
 *   the host has already counted the higher figure.
 * - System prompt choice (req.systemPromptMode): the build roles (frontend/backend/infra) use 'append'
 *   (the preset form): they are long, tool-heavy coding sessions that benefit from Claude Code's
 *   default guidance on tools, editing and running commands, with the role rules appended. The
 *   pm and tech_lead roles keep 'replace' (the default): they are short structured-output turns
 *   whose role prompt fully defines the job, and the coding-agent default prompt would only add
 *   tokens and competing instructions.
 * - Tool restriction (req.tools, used by read-only reviewers): mapped to the SDK `tools` option,
 *   which "specifies the base set of available built-in tools", so only those tools exist in the
 *   session. NOT `allowedTools`: that only auto-approves tools without prompting, and since the
 *   session runs with bypassPermissions it would restrict nothing. NOT `disallowedTools` either:
 *   a deny-list would let any tool we forgot to list through. When req.tools is unset, `tools` is
 *   left out and SDK defaults apply.
 * - Read-only isolation (P2-R2): `tools` does not govern MCP tools, and /workspace is agent-writable,
 *   so a planted `.mcp.json` or `.claude/settings.json` could hand a reviewer write/shell tools.
 *   When req.tools is set we also pass `strictMcpConfig: true` (only MCP servers from the
 *   `mcpServers` option; ignores project .mcp.json, user settings, plugins), `mcpServers: {}`
 *   (so that set is empty) and `settingSources: []` (SDK isolation mode: no user/project/local
 *   filesystem settings are loaded). Builder sessions (no tools) are unchanged.
 * - SDK budget stop: an `error_max_budget_usd` result becomes an error event with `code: 'budget'`,
 *   which the host maps to BudgetExceeded (job pauses as budget_cap) rather than a generic error.
 * - Structured output is native, and we also validate the returned value against req.outputSchema
 *   with zod's `z.fromJSONSchema`, falling back to an "is a JSON object" check if zod can't convert
 *   the schema. If `structured_output` is absent, the final text is parsed as JSON.
 */
import { readFile, realpath } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { estimateUsd } from './pricing.js';
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
    systemPrompt:
      req.systemPromptMode === 'append'
        ? { type: 'preset', preset: 'claude_code', append: req.systemPrompt }
        : req.systemPrompt,
    cwd: '/workspace',
    maxTurns: req.maxTurns,
    maxBudgetUsd: req.budgetUsd,
    permissionMode: 'bypassPermissions',
    allowDangerouslySkipPermissions: true,
  };
  if (req.tools) {
    options.tools = req.tools;
    // MCP tools and settings are separate channels from `tools` (see header): close both.
    options.strictMcpConfig = true;
    options.mcpServers = {};
    options.settingSources = [];
  }
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
    const message = errors.length ? `${msg.subtype}: ${errors.join('; ')}` : msg.subtype;
    return msg.subtype === 'error_max_budget_usd'
      ? { type: 'error', message, totalUsd, code: 'budget' }
      : { type: 'error', message, totalUsd };
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
  /**
   * On a resumed session the SDK's total_cost_usd continues from the transcript's saved total, so
   * interim estimates are offset by req.baseUsd to stay comparable with it (and with the host's lastTotal).
   */
  const base = req.baseUsd ?? 0;
  /** Highest cumulative interim total emitted so far (base + estimate). Never decreases. */
  let emitted = base;
  const emitCost = (total: number) => {
    if (total > emitted) {
      emitted = total;
      emit({ type: 'cost', totalUsd: total });
    }
  };
  const perMessageUsd = new Map<string, number>();
  let terminal: AgentEvent | undefined;
  try {
    for await (const msg of query({ prompt: req.prompt, options: buildOptions(req) })) {
      if (msg.type === 'assistant') {
        for (const block of msg.message.content) {
          if (block.type === 'text' && block.text.trim()) emit({ type: 'log', text: block.text });
          else if (block.type === 'tool_use') emit({ type: 'log', text: `tool: ${block.name}` });
        }
        if (msg.message.usage) {
          const usd = estimateUsd(msg.message.model || req.model, msg.message.usage);
          const id = msg.message.id;
          perMessageUsd.set(id, Math.max(perMessageUsd.get(id) ?? 0, usd));
          let sum = 0;
          for (const v of perMessageUsd.values()) sum += v;
          emitCost(base + sum);
        }
      } else if (msg.type === 'result') {
        // No `cost` event here: the result/error event carries the authoritative total, and a cost
        // event over the cap would make the host kill a finished, paid-for call (R4).
        terminal = terminalFromResult(req, msg);
      }
    }
  } catch (e) {
    // After an error result, single-shot query() throws by design; the result already describes it.
    if (!terminal) terminal = { type: 'error', message: errMessage(e), totalUsd: emitted };
  }
  emit(terminal ?? { type: 'error', message: 'agent ended without a result', totalUsd: emitted });
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
