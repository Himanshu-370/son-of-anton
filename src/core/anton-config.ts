import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import { z } from 'zod';
import type { Role } from './config.js';
import { antonHome } from './paths.js';

const entry = z.string().regex(/^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/);
const entries = z.array(entry);

const ROLES = [
  'pm', 'tech_lead', 'frontend', 'backend', 'infra', 'qa',
  'code_reviewer', 'security_reviewer', 'coach', 'mapper', 'browser_tester',
] as const satisfies readonly Role[];

export const AntonConfigSchema = z
  .object({
    stages: z
      .object({ spec: entries.optional(), plan: entries.optional(), build: entries.optional(), verify: entries.optional() })
      .strict()
      .optional(),
    kits: z.object({ fallback: entries.optional(), web: entries.optional() }).strict().optional(),
    roles: z.object(Object.fromEntries(ROLES.map((r) => [r, entries.optional()]))).strict().optional(),
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

export type StageGroup = 'spec' | 'plan' | 'build' | 'verify';

export const STAGE_GROUP: Record<string, StageGroup> = {
  spec: 'spec',
  plan: 'plan',
  baseline: 'plan',
  build: 'build',
  verify: 'verify',
  deliver: 'verify',
};

export const READ_ONLY_ROLES: Role[] = ['code_reviewer', 'security_reviewer', 'browser_tester', 'mapper'];

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
