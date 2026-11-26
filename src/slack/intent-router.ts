import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { Message, MessageCreateParamsNonStreaming } from '@anthropic-ai/sdk/resources/messages';
import { z } from 'zod';
import { estimateUsd, PRICES } from '../agent/pricing.js';
import { chatSettings, loadAntonConfig } from '../core/anton-config.js';
import { antonHome } from '../core/paths.js';
import { loadSecrets } from '../core/secrets.js';
import { PAUSE_REASONS, STAGES } from '../core/state.js';
import { loadPrompt } from '../stages/prompts.js';
import { chatRequestKnown, reserveChatSpend, settleChatSpend } from './chat-budget.js';
import { anthropicChatClient, chatUpperBoundUsd, scrub, UNBILLED_STATUSES, validUsage, type ChatDeps } from './chat.js';
import { jobId, projectId } from './events.js';
import { sanitizeSlackText } from './inbound.js';
import { intentDescriptions, intentSchema, type Intent } from './intents.js';

const MODEL = 'claude-haiku-5-5';
const OUTPUT_TOKENS = 600;
const MESSAGE_BYTES = 6_000;
const FACT_BYTES = 4_000;
const ASK = 'What would you like the PM to do?';
const factSchema = z.object({
  project: projectId,
  jobId: jobId.optional(),
  stage: z.enum(STAGES).optional(),
  checkpoint: z.enum(['spec', 'final']).optional(),
  pauseReason: z.enum(PAUSE_REASONS).optional(),
});
export type IntentProjectFact = z.infer<typeof factSchema>;
export type IntentRouterInput = {
  teamId: string;
  requestKey: string;
  text: string;
  projects: readonly IntentProjectFact[];
};
export type IntentRouterDeps = ChatDeps & { loadSecrets?: typeof loadSecrets };
export type IntentUnavailableReason =
  | 'missing_key' | 'input_too_large' | 'budget' | 'provider_error' | 'missing_price' | 'router_error';
export type IntentClassification =
  | { kind: 'intent'; intent: Intent }
  | { kind: 'clarification'; text: string }
  | { kind: 'duplicate' }
  | { kind: 'unavailable'; reason: IntentUnavailableReason };

const unavailable = (reason: IntentUnavailableReason): IntentClassification => ({ kind: 'unavailable', reason });
const clarification = (text = ASK): IntentClassification => ({ kind: 'clarification', text });

const escapeFence = (text: string) => text.replaceAll('`', '\\u0060');

function projectFacts(facts: readonly IntentProjectFact[], secrets: Record<string, string>): string {
  const rows: string[] = [];
  let bytes = 2; // JSON array brackets
  for (const fact of facts) {
    const parsed = factSchema.safeParse(fact);
    if (!parsed.success) continue;
    const row = escapeFence(scrub(JSON.stringify(parsed.data), secrets));
    const size = Buffer.byteLength(row) + (rows.length ? 1 : 0);
    if (bytes + size > FACT_BYTES) break;
    rows.push(row);
    bytes += size;
  }
  return `[${rows.join(',')}]`;
}

function decode(response: Message, secrets: Record<string, string>): IntentClassification {
  if (response.stop_reason === 'refusal' || response.stop_reason === 'max_tokens') return clarification();
  const raw = response.content.filter((block) => block.type === 'text').map((block) => block.text).join('');
  try {
    const intent = intentSchema.safeParse(JSON.parse(scrub(raw, secrets)));
    if (!intent.success) return clarification();
    if (intent.data.intent === 'unclear') return clarification(sanitizeSlackText(intent.data.clarify, 300) || ASK);
    return { kind: 'intent', intent: intent.data };
  } catch {
    return clarification();
  }
}

/** Classify one pre-authorized Owner event as data. The caller owns previews and execution. */
export async function classifyIntent(input: IntentRouterInput, deps: IntentRouterDeps = {}): Promise<IntentClassification> {
  if (Buffer.byteLength(input.text) > MESSAGE_BYTES) return unavailable('input_too_large');
  const key = (deps.env ?? process.env).ANTHROPIC_API_KEY;
  if (!key) return unavailable('missing_key');
  const price = (deps.prices ?? PRICES)[MODEL];
  if (!price) return unavailable('missing_price');
  const home = deps.home ?? antonHome();
  const requestId = createHash('sha256').update(JSON.stringify(['slack-intent', input.teamId, input.requestKey])).digest('hex');

  try {
    if (await chatRequestKnown(input.teamId, requestId, { home })) return { kind: 'duplicate' };
    const settings = deps.settings ?? chatSettings(await loadAntonConfig(home));
    const names = [...new Set(input.projects.map(({ project }) => project).filter((p) => projectId.safeParse(p).success))];
    const secrets: Record<string, string> = { ANTHROPIC_API_KEY: key };
    const load = deps.loadSecrets ?? loadSecrets;
    for (const project of names) {
      for (const [name, value] of Object.entries(await load(project))) {
        secrets[`${project}/${name}`] = value;
      }
    }
    const message = escapeFence(scrub(input.text, secrets));
    if (Buffer.byteLength(message) > MESSAGE_BYTES) return unavailable('input_too_large');
    const facts = projectFacts(input.projects, secrets);
    const fence = '`'.repeat(3);
    const user = ['Slack message:', fence, message, fence, 'Project facts:', fence, facts, fence].join('\n');
    const system = `${await loadPrompt('slack-intent.md')}\n\nAvailable intents:\n${intentDescriptions}`;
    const schema = zodOutputFormat(intentSchema).schema;
    const params: MessageCreateParamsNonStreaming = {
      model: MODEL,
      max_tokens: OUTPUT_TOKENS,
      thinking: { type: 'disabled' },
      output_config: { effort: 'low', format: { type: 'json_schema', schema } },
      system,
      messages: [{ role: 'user', content: user }],
    };
    const bytes = Buffer.byteLength(system) + Buffer.byteLength(user) + Buffer.byteLength(JSON.stringify(schema));
    const bound = chatUpperBoundUsd(price, bytes, OUTPUT_TOKENS);
    if (bound > settings.perAnswerUsd) return unavailable('budget');
    const reservation = await reserveChatSpend(input.teamId, requestId, bound, (deps.now ?? Date.now)(), { home, monthlyUsd: settings.monthlyUsd });
    if (!reservation) {
      if (await chatRequestKnown(input.teamId, requestId, { home })) return { kind: 'duplicate' };
      return unavailable('budget');
    }

    let response: Message;
    try {
      response = await (deps.client ?? anthropicChatClient)(key).send(params);
    } catch (e) {
      const unbilled = e instanceof Anthropic.APIError && typeof e.status === 'number' && UNBILLED_STATUSES.has(e.status);
      await settleChatSpend(reservation, unbilled ? 0 : undefined, { home }).catch(() => undefined);
      return unavailable('provider_error');
    }
    const actual = validUsage(response?.usage) ? estimateUsd(MODEL, response.usage) : undefined;
    await settleChatSpend(reservation, actual, { home });
    return decode(response, secrets);
  } catch {
    return unavailable('router_error');
  }
}
