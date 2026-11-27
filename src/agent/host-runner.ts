import { publishJobMilestone } from '../slack/job-milestones.js';
import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import { budgetSettings, loadAntonConfig, type AntonConfig } from '../core/anton-config.js';
import { allowanceShareText, allowanceUsage, appendStageCost, appendStageUsage, recordCost, remainingUsd, stageGroup, usd } from '../core/budget.js';
import { ROLE_MODELS, type Role } from '../core/config.js';
import { recordSpend } from '../core/spend-log.js';
import { execIn } from '../docker/container.js';
import { notify as defaultNotify } from '../core/notify.js';
import { redact } from '../core/secrets.js';
import { saveState, type JobState } from '../core/state.js';
import { lessonsBlock } from '../lessons/prompt.js';
import { pluginsForSession } from '../plugins/session.js';
import { loadPrompt } from '../stages/prompts.js';
import { priceFor } from './pricing.js';
import { AgentEventSchema, PROTOCOL_VERSION, type AgentRequest, type TokenTotals } from './protocol.js';

export type StageCtx = {
  project: string;
  repo: string;
  container: string;
  jobDir: string;
  state: JobState;
  stage: string;
  /** The settings snapshot used for this pipeline run. */
  config?: AntonConfig;
  /** The job's kit, for config.yaml `kits:` plugins. Unset means fallback (e.g. the spec session). */
  kit?: 'fallback' | 'web';
  /** Project secrets, loaded once by the runner. Optional: redact treats undefined as none. */
  secrets?: Record<string, string>;
  /** Prints a warning to the user (the attended spec session); unset means none. */
  warn?: (line: string) => void;
  /**
   * Host-only: the token usage a resumed session's transcript already carries (the previous call's
   * returned `usage`). The SDK's modelUsage on a resume includes it, so only the increase is recorded.
   */
  baseUsage?: TokenTotals;
};

/** Minimal process shape; satisfied by an execa child and by test fakes. */
export type ChildLike = {
  stdout: AsyncIterable<string | Buffer> | NodeJS.ReadableStream | null | undefined;
  kill(signal?: string): unknown;
  /** Awaiting the child resolves when the process exits. */
  then: PromiseLike<{ exitCode?: number | undefined }>['then'];
};

export type RunAgentDeps = {
  spawn?: (container: string, args: string[]) => ChildLike;
  notify?: typeof defaultNotify;
  /** Plugins, skills and MCP servers for a session without `tools` (default: config.yaml + plugins.lock). */
  plugins?: (ctx: StageCtx, role: string) => Promise<{ plugins: string[]; skills: string[]; mcpServers: Record<string, unknown> }>;
  /** Accepted lessons for the session's role and kit (default: ~/.anton/lessons). */
  lessons?: (role: string, kit: StageCtx['kit']) => Promise<{ text: string }>;
};

export class BudgetExceeded extends Error {
  constructor(message = 'budget exceeded') {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

/** A stage group used up its allowance (the job cap may still have room). */
export class AllowanceExceeded extends BudgetExceeded {
  constructor(
    public readonly group: string,
    public readonly spentUsd: number,
    public readonly limitUsd: number,
  ) {
    super(allowanceShareText(group, spentUsd, limitUsd));
    this.name = 'AllowanceExceeded';
  }
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

/**
 * Fail closed on a stale image: an entry built from older code does not echo PROTOCOL_VERSION (and,
 * for example, silently drops a reviewer's `tools` restriction), so its result must not be used.
 */
function checkProtocol(version: number | undefined): void {
  if (version !== PROTOCOL_VERSION) {
    throw new AgentError(`agent entry is out of date (protocol ${version ?? 'none'}) — run: npm run build:image`);
  }
}

async function nextRequestFile(jobDir: string, stage: string): Promise<string> {
  const dir = join(jobDir, 'requests');
  await fsp.mkdir(dir, { recursive: true });
  const prefix = `${stage}-`;
  const n = (await fsp.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).length + 1;
  return `${stage}-${n}.json`;
}

/** The API rejects a smaller `task_budget.total` (400); below it the dollar cap alone applies. */
export const TASK_BUDGET_MIN = 20_000;

/** Tokens the session may spend on input at its model's price for the dollar cap, capped at 5M. */
export function taskBudgetTokens(model: string, capUsd: number): number {
  return Math.min(5_000_000, Math.floor((capUsd * 1e6) / priceFor(model).inPerM));
}

export async function runAgent(
  ctx: StageCtx,
  req: AgentRequest,
  deps: RunAgentDeps = {},
): Promise<{ output: unknown; sessionId: string; state: JobState; totalUsd: number; usage?: TokenTotals }> {
  if (remainingUsd(ctx.state) <= 0) throw new BudgetExceeded('no budget remaining');
  // P4b-R1: only runner stages have an allowance; any other stage is limited by the job cap alone.
  const group = stageGroup(ctx.stage);
  const settings = budgetSettings(ctx.config ?? await loadAntonConfig());
  const allowances = group ? settings.allowances : undefined;
  const specWarning = () =>
    `Spec has used its ${allowances!.spec}% share (${usd(allowanceUsage(ctx.state, 'spec', allowances).limitUsd)}); continuing up to the job cap.`;
  const overAllowance = (s: JobState) => {
    const a = allowanceUsage(s, group!, allowances);
    return new AllowanceExceeded(group!, a.spentUsd, a.limitUsd);
  };
  let budgetUsd = Math.min(req.budgetUsd, remainingUsd(ctx.state));
  /** The session's budget is the allowance's remainder, so the SDK's own budget stop means the allowance ran out. */
  let allowanceBound = false;
  if (group === 'spec') {
    // Spec is warn-only: it may spend up to the job cap.
    const a = allowanceUsage(ctx.state, 'spec', allowances);
    if (a.spentUsd >= a.limitUsd) ctx.warn?.(specWarning());
  } else if (group) {
    const a = allowanceUsage(ctx.state, group, allowances);
    const left = a.limitUsd - a.spentUsd;
    if (left <= 0) throw new AllowanceExceeded(group, a.spentUsd, a.limitUsd);
    allowanceBound = left < budgetUsd;
    budgetUsd = Math.min(budgetUsd, left);
  }
  req = { ...req, budgetUsd };
  const tokens = taskBudgetTokens(req.model, budgetUsd);
  if (settings.taskBudgets && tokens >= TASK_BUDGET_MIN) req = { ...req, taskBudgetTokens: tokens };
  const spawn = deps.spawn ?? ((c, a) => execIn(c, a) as unknown as ChildLike);
  const notify = deps.notify ?? defaultNotify;
  if (req.tools) {
    // Read-only isolation (P2-R2): a reviewer never loads plugins, skills or MCP servers.
    if (req.plugins?.length || req.skills?.length || Object.keys(req.mcpServers ?? {}).length) {
      throw new AgentError('read-only sessions cannot load plugins');
    }
  } else {
    const p = await (deps.plugins ?? ((c, r) => pluginsForSession(c, r)))(ctx, req.role);
    req = { ...req, plugins: p.plugins, skills: p.skills, mcpServers: p.mcpServers };
  }

  // Lessons are operator-curated and change rarely, so they stay in the cache-stable part.
  const lessons = await (deps.lessons ?? ((r, k) => lessonsBlock(r, k)))(req.role, ctx.kit);
  if (lessons.text) req = { ...req, systemPrompt: `${req.systemPrompt}\n\n${lessons.text}` };

  if (ctx.stage !== 'spec') {
    // Unattended: the jobId is the only varying part and sits on the last line, keeping the rest cache-stable.
    const rule = (await loadPrompt('unattended.md')).replace('{jobId}', ctx.state.jobId).trimEnd();
    req = { ...req, systemPrompt: `${req.systemPrompt}\n\n${rule}` };
  }

  if (req.outputSchema && '$schema' in req.outputSchema) {
    // zod stamps draft 2020-12; the Claude Code CLI's --json-schema validator rejects that dialect line.
    const { $schema: _dialect, ...schema } = req.outputSchema;
    req = { ...req, outputSchema: schema };
  }

  const file = await nextRequestFile(ctx.jobDir, ctx.stage);
  await fsp.writeFile(
    join(ctx.jobDir, 'requests', file),
    redact(JSON.stringify({ ...req, protocolVersion: PROTOCOL_VERSION }, null, 2) + '\n', ctx.secrets),
  );
  const containerPath = `/workspace/.anton/jobs/${basename(ctx.jobDir)}/requests/${file}`;
  await fsp.mkdir(join(ctx.jobDir, 'logs'), { recursive: true });
  const logPath = join(ctx.jobDir, 'logs', `${ctx.stage}.log`);

  let state = ctx.state;
  /** Last seen cumulative total. A resumed session's SDK total starts from the transcript's (baseUsd). */
  let lastTotal = req.baseUsd ?? 0;
  let killed = false;
  const spendSession = randomUUID();
  let spendSequence = 0;
  const spendRole = Object.hasOwn(ROLE_MODELS, req.role) ? req.role as Role : undefined;
  /** A failed report-only write (cost.json, usage.json) must not drop a paid-for result or mask a pause. */
  const bestEffort = async (name: string, write: () => Promise<void>): Promise<void> => {
    try {
      await write();
    } catch (e) {
      const msg = `Could not update ${name}: ${e instanceof Error ? e.message : String(e)}`;
      ctx.warn?.(msg);
      // Unattended runs have no warn sink: leave a trace in the stage log too.
      await fsp.appendFile(logPath, redact(`warning: ${msg}`, ctx.secrets) + '\n').catch(() => undefined);
    }
  };

  const baseUsage = req.resumeSessionId ? ctx.baseUsage : undefined;
  /** The call's cumulative usage, returned so the caller can pass it as the next resume's base. */
  let usage: TokenTotals | undefined;
  const recordUsage = async (u: TokenTotals | undefined): Promise<void> => {
    if (!u) return;
    usage = u;
    const b = baseUsage;
    const inc: TokenTotals = b
      ? { input: Math.max(0, u.input - b.input), output: Math.max(0, u.output - b.output),
          cacheRead: Math.max(0, u.cacheRead - b.cacheRead), cacheWrite: Math.max(0, u.cacheWrite - b.cacheWrite) }
      : u;
    await bestEffort('usage.json', () => appendStageUsage(ctx.jobDir, ctx.stage, inc));
  };

  /** Apply the increment since the last seen total; persist; notify/throw as needed. */
  const applyTotal = async (totalUsd: number, child: ChildLike, killOnCap: boolean): Promise<void> => {
    const inc = totalUsd - lastTotal;
    if (inc <= 0) return;
    lastTotal = totalUsd;
    const r = recordCost(state, ctx.stage, inc, allowances);
    state = r.state;
    // state.json first: it is what the caps read. cost.json is the report's per-stage table only.
    await saveState(ctx.jobDir, state);
    await bestEffort('cost.json', () => appendStageCost(ctx.jobDir, ctx.stage, inc));
    await bestEffort('spend.jsonl', async () => {
      await recordSpend({
        id: `build:${spendSession}:${++spendSequence}`,
        at: new Date().toISOString(),
        source: 'build',
        project: ctx.project,
        jobId: state.jobId,
        stage: ctx.stage,
        role: spendRole,
        model: req.model,
        effort: req.effort,
        vendor: 'anthropic',
        usd: inc,
      });
    });
    if (r.crossedWarn) {
      await notify('Son of Anton', `${ctx.project}: 80% of budget used`);
      await publishJobMilestone(state, { kind: 'budget-warning', occurrence: `cap-${state.budgetUsd}` });
    }
    if (r.overCap && killOnCap) {
      killed = true;
      child.kill('SIGTERM');
      throw new BudgetExceeded();
    }
    if (r.overAllowance && group === 'spec') ctx.warn?.(specWarning());
    else if (r.overAllowance && killOnCap) {
      killed = true;
      child.kill('SIGTERM');
      throw overAllowance(state);
    }
  };

  const child = spawn(ctx.container, ['node', '/opt/anton/entry.js', containerPath]);

  const handleLine = async (line: string): Promise<{ output: unknown; sessionId: string } | undefined> => {
    if (line.trim() === '') return undefined;
    await fsp.appendFile(logPath, redact(line, ctx.secrets) + '\n');
    let json: unknown;
    try {
      json = JSON.parse(line);
    } catch {
      return undefined;
    }
    const parsed = AgentEventSchema.safeParse(json);
    if (!parsed.success) return undefined;
    const ev = parsed.data;
    switch (ev.type) {
      case 'log':
        return undefined;
      case 'cost':
        await applyTotal(ev.totalUsd, child, true);
        return undefined;
      case 'result':
        await applyTotal(ev.totalUsd, child, false);
        checkProtocol(ev.protocolVersion);
        await recordUsage(ev.usage);
        return { output: ev.output, sessionId: ev.sessionId };
      case 'error':
        await applyTotal(ev.totalUsd, child, false);
        checkProtocol(ev.protocolVersion);
        await recordUsage(ev.usage);
        // The SDK's own budget stop pauses the job like the host-side kill: allowance when the allowance set the session budget, else budget_cap.
        if (ev.code === 'budget') throw allowanceBound ? overAllowance(state) : new BudgetExceeded(ev.message);
        throw new AgentError(ev.message);
    }
  };

  try {
    let buf = '';
    if (child.stdout) {
      for await (const chunk of child.stdout as AsyncIterable<string | Buffer>) {
        buf += chunk.toString();
        let idx: number;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          const res = await handleLine(line);
          if (res) return { ...res, state, totalUsd: lastTotal, usage: usage ?? baseUsage };
        }
      }
    }
    const res = await handleLine(buf);
    if (res) return { ...res, state, totalUsd: lastTotal, usage: usage ?? baseUsage };
    const exit = await (child as unknown as PromiseLike<{ exitCode?: number }>);
    throw new AgentError(`agent exited without a result (exit ${exit?.exitCode ?? 'unknown'})`);
  } catch (e) {
    if (!killed) {
      killed = true;
      child.kill('SIGTERM');
    }
    throw e;
  }
}
