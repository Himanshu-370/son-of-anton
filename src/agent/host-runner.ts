import * as fsp from 'node:fs/promises';
import { basename, join } from 'node:path';
import { appendStageCost, recordCost, remainingUsd } from '../core/budget.js';
import { execIn } from '../docker/container.js';
import { notify as defaultNotify } from '../core/notify.js';
import { saveState, type JobState } from '../core/state.js';
import { AgentEventSchema, type AgentRequest } from './protocol.js';

export type StageCtx = {
  project: string;
  repo: string;
  container: string;
  jobDir: string;
  state: JobState;
  stage: string;
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
};

export class BudgetExceeded extends Error {
  constructor(message = 'budget exceeded') {
    super(message);
    this.name = 'BudgetExceeded';
  }
}

export class AgentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentError';
  }
}

async function nextRequestFile(jobDir: string, stage: string): Promise<string> {
  const dir = join(jobDir, 'requests');
  await fsp.mkdir(dir, { recursive: true });
  const prefix = `${stage}-`;
  const n = (await fsp.readdir(dir)).filter((f) => f.startsWith(prefix) && f.endsWith('.json')).length + 1;
  return `${stage}-${n}.json`;
}

export async function runAgent(
  ctx: StageCtx,
  req: AgentRequest,
  deps: RunAgentDeps = {},
): Promise<{ output: unknown; sessionId: string; state: JobState; totalUsd: number }> {
  if (remainingUsd(ctx.state) <= 0) throw new BudgetExceeded('no budget remaining');
  const spawn = deps.spawn ?? ((c, a) => execIn(c, a) as unknown as ChildLike);
  const notify = deps.notify ?? defaultNotify;

  const file = await nextRequestFile(ctx.jobDir, ctx.stage);
  await fsp.writeFile(join(ctx.jobDir, 'requests', file), JSON.stringify(req, null, 2) + '\n');
  const containerPath = `/workspace/.anton/jobs/${basename(ctx.jobDir)}/requests/${file}`;
  await fsp.mkdir(join(ctx.jobDir, 'logs'), { recursive: true });
  const logPath = join(ctx.jobDir, 'logs', `${ctx.stage}.log`);

  let state = ctx.state;
  /** Last seen cumulative total. A resumed session's SDK total starts from the transcript's (baseUsd). */
  let lastTotal = req.baseUsd ?? 0;
  let killed = false;

  /** Apply the increment since the last seen total; persist; notify/throw as needed. */
  const applyTotal = async (totalUsd: number, child: ChildLike, killOnCap: boolean): Promise<void> => {
    const inc = totalUsd - lastTotal;
    if (inc <= 0) return;
    lastTotal = totalUsd;
    const r = recordCost(state, ctx.stage, inc);
    state = r.state;
    await appendStageCost(ctx.jobDir, ctx.stage, inc);
    await saveState(ctx.jobDir, state);
    if (r.crossedWarn) await notify('Son of Anton', `${ctx.project}: 80% of budget used`);
    if (r.overCap && killOnCap) {
      killed = true;
      child.kill('SIGTERM');
      throw new BudgetExceeded();
    }
  };

  const child = spawn(ctx.container, ['node', '/opt/anton/entry.js', containerPath]);

  const handleLine = async (line: string): Promise<{ output: unknown; sessionId: string } | undefined> => {
    if (line.trim() === '') return undefined;
    await fsp.appendFile(logPath, line + '\n');
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
        return { output: ev.output, sessionId: ev.sessionId };
      case 'error':
        await applyTotal(ev.totalUsd, child, false);
        // The SDK's own budget stop pauses the job as budget_cap, like the host-side kill.
        if (ev.code === 'budget') throw new BudgetExceeded(ev.message);
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
          if (res) return { ...res, state, totalUsd: lastTotal };
        }
      }
    }
    const res = await handleLine(buf);
    if (res) return { ...res, state, totalUsd: lastTotal };
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
