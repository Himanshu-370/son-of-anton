import * as fsp from 'node:fs/promises';
import { runAgent as defaultRunAgent, type StageCtx } from '../agent/host-runner.js';
import type { AgentRequest } from '../agent/protocol.js';
import { remainingUsd } from '../core/budget.js';
import { ROLE_MODELS } from '../core/config.js';
import { commitAll as defaultCommitAll } from '../core/git.js';
import { saveState, transition, type JobState } from '../core/state.js';
import { trimOutput } from '../core/trim.js';
import { loadPrompt } from './prompts.js';
import type { Plan } from './plan.js';
import type { SpecDoc } from './spec.js';
import { failureReportPath } from './verify.js';

export type BuildDeps = {
  runAgent?: typeof defaultRunAgent;
  commitAll?: (repo: string, message: string) => Promise<string | null>;
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

function taskPrompt(ctx: StageCtx, spec: SpecDoc, plan: Plan, task: Task): string {
  return [
    context(ctx, spec, plan),
    '',
    `## Current task — ${task.id}: ${task.title}`,
    '',
    `Acceptance checks: ${task.acceptanceChecks.join(', ') || '(none)'}`,
    '',
    task.instructions,
    '',
    "Implement only this task. Run this task's tests before finishing.",
  ].join('\n');
}

function fixPrompt(ctx: StageCtx, spec: SpecDoc, plan: Plan, failureReport: string): string {
  return [
    context(ctx, spec, plan),
    '',
    `## Fix round ${ctx.state.round}`,
    '',
    'All plan tasks have been built, but verification failed. Fix the failures below so every acceptance check passes.',
    '',
    '### Failure report',
    '',
    trimOutput(failureReport),
    '',
    'Run the failing checks\' tests and the full test command before finishing.',
  ].join('\n');
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
 * Fix mode (failureReport given, or every task done and evidence/failure-report.md present after a
 * crash): a single fix session. Ends by transitioning to verify.
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
  const systemPrompt = await loadPrompt('build.md');
  const { model, effort } = ROLE_MODELS.backend;
  let state = ctx.state;

  const session = async (prompt: string, role: string): Promise<void> => {
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

  if (failureReport === undefined && plan.tasks.every((t) => state.completedTasks.includes(t.id))) {
    failureReport = await readPersistedReport(ctx.jobDir);
  }

  if (failureReport !== undefined) {
    await session(fixPrompt({ ...ctx, state }, spec, plan, failureReport), 'backend');
    await commit(ctx.repo, `fix: round ${state.round}`);
  } else {
    for (const task of plan.tasks) {
      if (state.completedTasks.includes(task.id)) continue;
      await session(taskPrompt({ ...ctx, state }, spec, plan, task), 'backend');
      await commit(ctx.repo, `${task.id}: ${task.title}`);
      state = { ...state, completedTasks: [...state.completedTasks, task.id] };
      await saveState(ctx.jobDir, state);
    }
  }

  state = transition(state, 'verify');
  await saveState(ctx.jobDir, state);
  return state;
}
