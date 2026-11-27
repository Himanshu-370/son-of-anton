import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import { PRICES } from '../agent/pricing.js';
import { DEFAULTS, type Role } from './config.js';
import { antonHome } from './paths.js';

const entry = z.string().regex(/^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/);
const entries = z.array(entry);

const ROLES = [
  'pm', 'tech_lead', 'frontend', 'backend', 'infra', 'qa',
  'code_reviewer', 'security_reviewer', 'coach', 'mapper', 'browser_tester', 'plugin_reviewer',
] as const satisfies readonly Role[];

const pricedModel = z.string().refine((model) => Object.hasOwn(PRICES, model), {
  message: 'model must have a verified price',
});
const modelSelection = z.object({ model: pricedModel, effort: z.enum(['low', 'medium', 'high']) }).strict();
const roleModelOverride = modelSelection.partial().refine(({ model, effort }) => model !== undefined || effort !== undefined, {
  message: 'role override must set a model or effort',
});
const models = z.object({
  preset: z.enum(['economy', 'balanced', 'best']).optional(),
  roles: z.partialRecord(z.enum(ROLES), roleModelOverride).optional(),
  trial: modelSelection.extend({
    role: z.enum(ROLES),
    jobsLeft: z.number().int().positive(),
    revertTo: modelSelection,
  }).optional(),
}).strict();

export const ALLOWANCE_ORDER = ['spec', 'plan', 'build', 'verify', 'retro'] as const;
export const DEFAULT_ALLOWANCES = { spec: 10, plan: 10, build: 50, verify: 25, retro: 5 };

const pct = z.number().int().min(0).max(100);
const allowances = z
  .object({ spec: pct, plan: pct, build: pct, verify: pct, retro: pct })
  .strict()
  .refine((a) => Object.values(a).reduce((x, y) => x + y, 0) === 100, { message: 'budget.allowances must add up to 100' });

export const AntonConfigSchema = z
  .object({
    stages: z
      .object({ spec: entries.optional(), plan: entries.optional(), build: entries.optional(), verify: entries.optional() })
      .strict()
      .optional(),
    kits: z.object({ fallback: entries.optional(), web: entries.optional() }).strict().optional(),
    roles: z.object(Object.fromEntries(ROLES.map((r) => [r, entries.optional()]))).strict().optional(),
    budget: z
      .object({ defaultUsd: z.number().positive().optional(), allowances: allowances.optional(), taskBudgets: z.boolean().optional() })
      .strict()
      .optional(),
    models: models.optional(),
    retro: z.object({ batch: z.boolean().optional() }).strict().optional(),
    /** Paid Slack answers: a monthly pool (UTC month) and a cap per answer, separate from build budgets. */
    chat: z
      .object({ monthlyUsd: z.number().min(0).optional(), perAnswerUsd: z.number().positive().optional() })
      .strict()
      .optional(),
  })
  .strict();

export type AntonConfig = z.infer<typeof AntonConfigSchema>;

export async function loadAntonConfig(home = antonHome()): Promise<AntonConfig> {
  let text: string;
  try {
    text = await readFile(join(home, 'config.yaml'), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  try {
    return AntonConfigSchema.parse(parse(text) ?? {});
  } catch (e) {
    throw new Error(`Invalid ~/anton/config.yaml: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export function budgetSettings(cfg: AntonConfig): { defaultUsd: number; allowances: typeof DEFAULT_ALLOWANCES; taskBudgets: boolean } {
  return {
    defaultUsd: cfg.budget?.defaultUsd ?? DEFAULTS.budgetUsd,
    allowances: cfg.budget?.allowances ?? DEFAULT_ALLOWANCES,
    taskBudgets: cfg.budget?.taskBudgets ?? true,
  };
}

/** Defaults: $5 a month and $0.10 an answer. `monthlyUsd: 0` turns paid answers off (status stays free). */
export function chatSettings(cfg: AntonConfig): { monthlyUsd: number; perAnswerUsd: number } {
  return { monthlyUsd: cfg.chat?.monthlyUsd ?? 5, perAnswerUsd: cfg.chat?.perAnswerUsd ?? 0.1 };
}

/** Retro goes through the Batch API (half price, collected later) unless `retro.batch: false`. */
export const retroBatch = (cfg: AntonConfig): boolean => cfg.retro?.batch ?? true;

export type StageGroup = 'spec' | 'plan' | 'build' | 'verify';

export const STAGE_GROUP: Record<string, StageGroup> = {
  spec: 'spec',
  plan: 'plan',
  baseline: 'plan',
  build: 'build',
  verify: 'verify',
  deliver: 'verify',
};

export const READ_ONLY_ROLES: Role[] = ['code_reviewer', 'security_reviewer', 'browser_tester', 'mapper', 'plugin_reviewer'];

export function resolveEntries(
  cfg: AntonConfig,
  { stage, role, kit }: { stage: string; role: Role; kit: 'fallback' | 'web' },
): string[] {
  const group = STAGE_GROUP[stage];
  if (!group) throw new Error(`Unknown stage "${stage}"`);
  if (READ_ONLY_ROLES.includes(role)) return [];
  const kitEntries = group === 'spec' ? [] : (cfg.kits?.[kit] ?? []);
  return [...new Set([...(cfg.stages?.[group] ?? []), ...kitEntries, ...(cfg.roles?.[role] ?? [])])];
}
