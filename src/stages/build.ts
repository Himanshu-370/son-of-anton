import * as fsp from 'node:fs/promises';
import { runAgent as defaultRunAgent, type StageCtx } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { remainingUsd } from '../core/budget.js';
import { z } from 'zod';
import { AREA_ORDER, ROLE_MODELS, type Area } from '../core/config.js';
import { commitAll as defaultCommitAll } from '../core/git.js';
import { saveState, transition, type JobState } from '../core/state.js';
import { trimOutput } from '../core/trim.js';
import { orderTasks, readHandoffs } from './handoffs.js';
import { loadPrompt } from './prompts.js';
import type { Plan } from './plan.js';
import type { SpecDoc } from './spec.js';
import { FailureItemSchema, failuresPath, renderFailureReport, type FailureItem } from './qa.js';
import { failureReportPath } from './verify.js';

export type BuildDeps = {
  runAgent?: typeof defaultRunAgent;
  commitAll?: (repo: string, message: string, secrets?: Record<string, string>) => Promise<string | null>;
};

type Task = Plan['tasks'][number];

function planSummary(plan: Plan): string {
  const cmds = [`- install: \`${plan.commands.install}\``, `- test: \`${plan.commands.test}\``];
  if (plan.commands.run) cmds.push(`- run: \`${plan.commands.run}\``);
  const tasks = plan.tasks.map((t) => `- ${t.id}: ${t.title} (checks: ${t.acceptanceChecks.join(', ') || 'none'})`);
  return ['## Plan', '', '### Commands', '', ...cmds, '', '### Tasks', '', ...tasks].join('\n');
}

function context(ctx: StageCtx, spec: SpecDoc, plan: Plan): string {
  const questions = `/workspace/.anton/jobs/${ctx.state.jobId}/questions.md`;
  return [
    '## Approved spec',
    '',
    '```json',
    JSON.stringify(spec, null, 2),
    '```',
    '',
    planSummary(plan),
    '',
    `Questions/assumptions file: \`${questions}\``,
  ].join('\n');
}

function containerHandoffPath(jobId: string, area: Area): string {
  return `/workspace/.anton/jobs/${jobId}/handoffs/${area}.md`;
}

function taskPrompt(
  ctx: StageCtx,
  spec: SpecDoc,
  plan: Plan,
  task: Task,
  handoffs: { area: Area; text: string }[],
  isLastOfArea: boolean,
): string {
  const extra: string[] = [];
  if (plan.contract?.trim()) extra.push('## Contract', '', plan.contract.trim(), '');
  if (handoffs.length) {
    extra.push('## Handoff notes from earlier developers', '');
    for (const h of handoffs) extra.push(`### ${h.area}`, '', trimOutput(h.text), '');
  }
  const handoff = isLastOfArea
    ? [
        '',
        `Before finishing, write a short handoff note for the next developer to \`${containerHandoffPath(ctx.state.jobId, task.area)}\`: what you built, where, and how to use it.`,
      ]
    : [];
  return [
    context(ctx, spec, plan),
    '',
    ...extra,
    `## Current task — ${task.id}: ${task.title}`,
    '',
    `Acceptance checks: ${task.acceptanceChecks.join(', ') || '(none)'}`,
    '',
    task.instructions,
    '',
    "Implement only this task. Run this task's tests before finishing.",
    ...handoff,
  ].join('\n');
}

function fixPrompt(
  ctx: StageCtx,
  plan: Plan,
  area: Area,
  failureText: string,
  handoffs: { area: Area; text: string }[],
  spec: SpecDoc,
): string {
  const extra: string[] = [];
  if (plan.contract?.trim()) extra.push('## Contract', '', plan.contract.trim(), '');
  if (handoffs.length) {
    extra.push('## Handoff notes from developers', '');
    for (const h of handoffs) extra.push(`### ${h.area}`, '', trimOutput(h.text), '');
  }
  return [
    context(ctx, spec, plan),
    '',
    ...extra,
    `## Fix round ${ctx.state.round} (${area})`,
    '',
    `All plan tasks have been built, but verification failed. Fix the ${area} failures below so every acceptance check passes.`,
    '',
    '### Failures',
    '',
    trimOutput(failureText),
    '',
    `Full failure report: /workspace/.anton/jobs/${ctx.state.jobId}/evidence/failure-report.md (read it with your tools if you need check details)`,
    '',
    "Run the failing checks' tests and the full test command before finishing.",
  ].join('\n');
}

async function readFailureItems(jobDir: string): Promise<FailureItem[] | undefined> {
  try {
    return z.array(FailureItemSchema).parse(JSON.parse(await fsp.readFile(failuresPath(jobDir), 'utf8')));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

async function readPersistedReport(jobDir: string): Promise<string | undefined> {
  try {
    return await fsp.readFile(failureReportPath(jobDir), 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw e;
  }
}

/**
 * Normal mode: one fresh agent session per unfinished task, committing after each.
 * Fix mode (failureReport given, or every task done and evidence/failures.json or failure-report.md
 * present): one session per area with failures, in AREA_ORDER, skipping areas in state.completedFixAreas.
 * Ends by transitioning to verify.
 */
export async function runBuild(
  ctx: StageCtx,
  spec: SpecDoc,
  plan: Plan,
  failureReport?: string,
  deps: BuildDeps = {},
): Promise<JobState> {
  const run = deps.runAgent ?? defaultRunAgent;
  const commit = deps.commitAll ?? defaultCommitAll;
  const baseSystemPrompt = await loadPrompt('build.md');
  let state = ctx.state;

  const session = async (prompt: string, role: Area): Promise<void> => {
    const { model, effort } = ROLE_MODELS[role];
    const systemPrompt = `${baseSystemPrompt}\n\n${await loadPrompt(`role-${role}.md`)}`;
    const req: AgentRequest = {
      role,
      model,
      effort,
      systemPrompt,
      // Keep Claude Code's default coding prompt and append the build rules (see entry.ts).
      systemPromptMode: 'append',
      prompt,
      maxTurns: 60,
      budgetUsd: remainingUsd(state),
    };
    state = (await run({ ...ctx, state }, req)).state;
  };

  const allDone = plan.tasks.every((t) => state.completedTasks.includes(t.id));
  // Area -> text of the failures that area must fix; undefined means normal (task) mode.
  let fixes: Map<Area, string> | undefined;
  const planAreas = AREA_ORDER.filter((a) => plan.tasks.some((t) => t.area === a));
  const everyArea = (text: string) => new Map<Area, string>(planAreas.map((a) => [a, text]));
  if (failureReport !== undefined) {
    fixes = everyArea(failureReport);
  } else if (allDone) {
    const items = await readFailureItems(ctx.jobDir);
    if (items?.length) {
      // P2-R4: route each item to its stated area, even when the plan has no tasks there.
      fixes = new Map();
      for (const area of AREA_ORDER) {
        const mine = items.filter((i) => i.area === area);
        if (mine.length) fixes.set(area, renderFailureReport(mine, ''));
      }
    } else {
      // P2-R1: no failures.json, but a persisted markdown report: every plan area gets it.
      const report = await readPersistedReport(ctx.jobDir);
      if (report !== undefined) fixes = everyArea(report);
    }
  }

  if (fixes) {
    // completedFixAreas is reset by verify (new build round) and by reject, so it only ever
    // holds areas finished in the current fix round.
    for (const [area, text] of fixes) {
      if (state.completedFixAreas?.includes(area)) continue;
      const handoffs = await readHandoffs(ctx.jobDir);
      await session(fixPrompt({ ...ctx, state }, plan, area, text, handoffs, spec), area);
      await commit(ctx.repo, `fix: round ${state.round} (${area})`, ctx.secrets);
      state = { ...state, completedFixAreas: [...(state.completedFixAreas ?? []), area] };
      await saveState(ctx.jobDir, state);
    }
  } else {
    const ordered = orderTasks(plan);
    for (const task of ordered) {
      if (state.completedTasks.includes(task.id)) continue;
      const isLastOfArea = ordered.filter((t) => t.area === task.area).at(-1)!.id === task.id;
      const handoffs = await readHandoffs(ctx.jobDir);
      await session(taskPrompt({ ...ctx, state }, spec, plan, task, handoffs, isLastOfArea), task.area);
      await commit(ctx.repo, `${task.id}: ${task.title}`, ctx.secrets);
      state = { ...state, completedTasks: [...state.completedTasks, task.id] };
      await saveState(ctx.jobDir, state);
    }
  }

  state = transition(state, 'verify');
  await saveState(ctx.jobDir, state);
  return state;
}
