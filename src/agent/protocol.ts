import { z } from 'zod';

export const AgentRequestSchema = z.object({
  role: z.string(),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high']),
  systemPrompt: z.string(),
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
  }),
  z.object({ type: z.literal('error'), message: z.string(), totalUsd: z.number().min(0) }),
]);
export type AgentEvent = z.infer<typeof AgentEventSchema>;
