import { join } from 'node:path';
import { z } from 'zod';
import type { StageCtx } from '../agent/host-runner.js';
import { runAgent as defaultRunAgent } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { writeFileAtomic } from '../core/atomic.js';
import { redact } from '../core/secrets.js';
import { remainingUsd } from '../core/budget.js';
import { ROLE_MODELS } from '../core/config.js';
import type { JobState } from '../core/state.js';
import type { Commands } from '../kits/types.js';
import { loadPrompt } from './prompts.js';
import type { SpecDoc } from './spec.js';

const CommandsSchema: z.ZodType<Commands> = z.object({
  install: z.string().min(1),
  test: z.string().min(1),
  run: z.string().min(1).optional(),
  serve: z.string().min(1).optional(),
  url: z.string().regex(/^http:\/\/(localhost|127\.0\.0\.1):\d+(\/.*)?$/).optional(),
}).refine((c) => !!c.serve === !!c.url, { message: 'commands.serve and commands.url must be set together' });

export const PlanSchema = z.object({
  commands: CommandsSchema,
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^T\d+$/),
        title: z.string().min(1),
        acceptanceChecks: z.array(z.string()),
        instructions: z.string().min(1),
        area: z.enum(['frontend', 'backend', 'infra']),
      }),
    )
    .min(1),
  contract: z.string().optional(),
});
export type Plan = z.infer<typeof PlanSchema>;

export class PlanInvalid extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanInvalid';
  }
}

/** Every spec check must be covered by a task; tasks may only reference spec checks. */
export function validatePlanCoverage(plan: Plan, checkIds: string[]): void {
  const covered = new Set(plan.tasks.flatMap((t) => t.acceptanceChecks));
  const missing = checkIds.filter((id) => !covered.has(id));
  if (missing.length) throw new PlanInvalid(`plan does not cover acceptance checks: ${missing.join(', ')}`);
  const known = new Set(checkIds);
  const unknown = [...covered].filter((id) => !known.has(id));
  if (unknown.length) throw new PlanInvalid(`plan references unknown acceptance checks: ${unknown.join(', ')}`);
}

/** A plan spanning two or more areas must carry a contract that the areas build against. */
export function validatePlanAreas(plan: Plan): void {
  const areas = new Set(plan.tasks.map((t) => t.area));
  if (areas.size >= 2 && !plan.contract?.trim()) throw new PlanInvalid(`plan spans ${areas.size} areas but has no contract`);
}

export type PlanDeps = { runAgent?: typeof defaultRunAgent };

function renderPlan(p: Plan): string {
  const lines = ['# Plan', '', '## Commands', '', `- install: \`${p.commands.install}\``, `- test: \`${p.commands.test}\``];
  if (p.commands.run) lines.push(`- run: \`${p.commands.run}\``);
  if (p.commands.serve) lines.push(`- serve: \`${p.commands.serve}\``, `- url: \`${p.commands.url}\``);
  if (p.contract?.trim()) lines.push('', '## Contract', '', p.contract.trim());
  for (const t of p.tasks) {
    lines.push('', `## ${t.id}: ${t.title} [${t.area}]`, '', `Acceptance checks: ${t.acceptanceChecks.join(', ') || '(none)'}`, '', t.instructions);
  }
  return lines.join('\n') + '\n';
}

/** Returns the validated plan and the latest job state; writes plan.json and plan.md. */
export async function runPlan(
  ctx: StageCtx,
  spec: SpecDoc,
  deps: PlanDeps = {},
): Promise<{ plan: Plan; state: JobState }> {
  const run = deps.runAgent ?? defaultRunAgent;
  const { model, effort } = ROLE_MODELS.tech_lead;
  const req: AgentRequest = {
    role: 'tech_lead',
    model,
    effort,
    systemPrompt: (await loadPrompt('plan.md')) + (spec.kit === 'web' ? await loadPrompt('plan-web.md') : ''),
    prompt: `${ctx.state.kind === 'change' ? 'This is a change to an existing codebase (see the Change jobs section).\n\n' : ''}Approved spec:\n\n${JSON.stringify(spec, null, 2)}`,
    outputSchema: z.toJSONSchema(PlanSchema) as Record<string, unknown>,
    maxTurns: 30,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  let output = res.output as { commands?: Record<string, unknown> } | undefined;
  // serve/url only matter to the web kit; a stray url in another kit's plan must not fail a paid planning call.
  if (spec.kit !== 'web' && output?.commands && typeof output.commands === 'object') {
    const { serve: _serve, url: _url, ...rest } = output.commands;
    output = { ...output, commands: rest };
  }
  const plan = PlanSchema.parse(output);
  if (spec.kit === 'web' && !plan.commands.serve) throw new PlanInvalid('Web kit plans must set commands.serve and commands.url');
  validatePlanCoverage(plan, spec.acceptanceChecks.map((c) => c.id));
  validatePlanAreas(plan);
  await writeFileAtomic(join(ctx.jobDir, 'plan.json'), redact(JSON.stringify(plan, null, 2) + '\n', ctx.secrets));
  await writeFileAtomic(join(ctx.jobDir, 'plan.md'), redact(renderPlan(plan), ctx.secrets));
  return { plan, state: res.state };
}
