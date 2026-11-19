import { join } from 'node:path';
import { z } from 'zod';
import type { StageCtx } from '../agent/host-runner.js';
import { runAgent as defaultRunAgent } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { writeFileAtomic } from '../core/atomic.js';
import { remainingUsd } from '../core/budget.js';
import { DEFAULTS } from '../core/config.js';
import type { JobState } from '../core/state.js';
import type { Commands } from '../kits/types.js';
import { loadPrompt } from './prompts.js';
import type { SpecDoc } from './spec.js';

const CommandsSchema: z.ZodType<Commands> = z.object({
  install: z.string().min(1),
  test: z.string().min(1),
  run: z.string().min(1).optional(),
});

export const PlanSchema = z.object({
  commands: CommandsSchema,
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^T\d+$/),
        title: z.string().min(1),
        acceptanceChecks: z.array(z.string()),
        instructions: z.string().min(1),
      }),
    )
    .min(1),
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

export type PlanDeps = { runAgent?: typeof defaultRunAgent };

function renderPlan(p: Plan): string {
  const lines = ['# Plan', '', '## Commands', '', `- install: \`${p.commands.install}\``, `- test: \`${p.commands.test}\``];
  if (p.commands.run) lines.push(`- run: \`${p.commands.run}\``);
  for (const t of p.tasks) {
    lines.push('', `## ${t.id}: ${t.title}`, '', `Acceptance checks: ${t.acceptanceChecks.join(', ') || '(none)'}`, '', t.instructions);
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
  const { model, effort } = DEFAULTS.models.plan;
  const req: AgentRequest = {
    role: 'plan',
    model,
    effort,
    systemPrompt: await loadPrompt('plan.md'),
    prompt: `Approved spec:\n\n${JSON.stringify(spec, null, 2)}`,
    outputSchema: z.toJSONSchema(PlanSchema) as Record<string, unknown>,
    maxTurns: 30,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  const plan = PlanSchema.parse(res.output);
  validatePlanCoverage(plan, spec.acceptanceChecks.map((c) => c.id));
  await writeFileAtomic(join(ctx.jobDir, 'plan.json'), JSON.stringify(plan, null, 2) + '\n');
  await writeFileAtomic(join(ctx.jobDir, 'plan.md'), renderPlan(plan));
  return { plan, state: res.state };
}
