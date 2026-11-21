import { z } from 'zod';

/**
 * Host <-> entry protocol version. The host stamps it on every request and refuses a result/error
 * event that does not echo it, so an image built from older agent code (which would, for example,
 * silently drop `tools`) fails closed instead of running with the wrong options.
 */
export const PROTOCOL_VERSION = 3;

export const AgentRequestSchema = z.object({
  role: z.string(),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high']),
  systemPrompt: z.string(),
  /**
   * 'replace' (default): systemPrompt replaces the SDK's default prompt. 'append': the Claude Code
   * preset prompt is kept and systemPrompt is appended to it (used by the role-split build agents).
   */
  systemPromptMode: z.enum(['replace', 'append']).optional(),
  prompt: z.string(),
  outputSchema: z.record(z.string(), z.unknown()).optional(), // JSON Schema
  resumeSessionId: z.string().optional(),
  maxTurns: z.number().int().min(1),
  budgetUsd: z.number().min(0),
  /**
   * Cumulative USD the resumed session's transcript already carries (the previous call's total).
   * The SDK's total_cost_usd on a resumed session continues from that saved total, so the host
   * counts only the increment over it, and the entry offsets its interim estimates by it. Default 0.
   */
  baseUsd: z.number().min(0).optional(),
  /**
   * Exact built-in tool set for the session (read-only reviewers). Passed as the SDK `tools`
   * option, so no other built-in tool exists for the session. Omitted: SDK defaults.
   */
  tools: z.array(z.string()).optional(),
  /**
   * Plugin folders inside the container (`/opt/anton/plugins/<dir>`), the `plugin:skill` names to
   * enable, and the MCP servers the host resolved from those plugins. Set by runAgent for sessions
   * without `tools`; a read-only session carrying any of them is refused.
   */
  plugins: z.array(z.string()).optional(),
  skills: z.array(z.string()).optional(),
  mcpServers: z.record(z.string(), z.unknown()).optional(),
  /** Set by the host (runAgent) to PROTOCOL_VERSION; the entry refuses a different value. */
  protocolVersion: z.number().int().optional(),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

/** One JSONL line on the agent's stdout. `totalUsd` is cumulative for the call. */
export const AgentEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('log'), text: z.string() }),
  z.object({ type: z.literal('cost'), totalUsd: z.number().min(0) }),
  z.object({
    type: z.literal('result'),
    ok: z.literal(true),
    output: z.unknown(),
    sessionId: z.string(),
    totalUsd: z.number().min(0),
    /** The entry's PROTOCOL_VERSION. Absent from Phase 1 entries; the host rejects a mismatch. */
    protocolVersion: z.number().int().optional(),
  }),
  z.object({
    type: z.literal('error'),
    message: z.string(),
    totalUsd: z.number().min(0),
    /** Machine-readable cause. 'budget': the SDK stopped at maxBudgetUsd (host throws BudgetExceeded). */
    code: z.enum(['budget']).optional(),
    protocolVersion: z.number().int().optional(),
  }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
