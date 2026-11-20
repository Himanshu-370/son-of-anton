import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { runAgent as defaultRunAgent, type StageCtx } from '../../agent/host-runner.js';
import type { AgentRequest } from '../../agent/protocol.js';
import { writeFileAtomic } from '../../core/atomic.js';
import { remainingUsd } from '../../core/budget.js';
import { ROLE_MODELS } from '../../core/config.js';
import { redact } from '../../core/secrets.js';
import type { JobState } from '../../core/state.js';
import { loadPrompt } from '../../stages/prompts.js';
import type { AcceptanceCheck, CheckResult } from '../types.js';

export type RunIn = (name: string, cmd: string) => Promise<{ exitCode: number; stdout: string; stderr: string }>;

const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

const PID = '/tmp/anton-app.pid';
/** Kills the app's whole process group (TERM, then KILL after 1 s); a no-op when no app runs. */
export const STOP_APP = `if [ -f ${PID} ]; then P=$(cat ${PID}); kill -s TERM -- -$P 2>/dev/null; sleep 1; kill -s KILL -- -$P 2>/dev/null; rm -f ${PID}; fi; true`;
export const READY_TRIES = 60;

/** Starts `serve` in its own process group (log to `logPath`, a container path) and polls `url` once a second. */
export async function startApp(
  runIn: RunIn, container: string, serve: string, url: string, logPath: string, sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  await runIn(container, STOP_APP); // an app left over from a crashed round would hold the port
  await runIn(container, `setsid sh -c ${shq(serve)} > ${shq(logPath)} 2>&1 & echo $! > ${PID}`);
  for (let i = 0; i < READY_TRIES; i++) {
    if ((await runIn(container, `curl -fsS --max-time 5 -o /dev/null ${shq(url)}`)).exitCode === 0) return true;
    // serve exited at once: no point waiting out the minute.
    if ((await runIn(container, `kill -0 $(cat ${PID})`)).exitCode !== 0) return false;
    await sleep(1000);
  }
  return false;
}

/**
 * Last `lines` lines of the app log, read inside the container (a symlink planted at the log path can then
 * reach only container files, never the host's), redacted. The on-disk copy is redacted too, but only
 * when it is a regular file: host reads never follow a link the container could have placed.
 */
export async function appLogTail(
  runIn: RunIn, container: string, boxPath: string, hostPath: string, secrets: Record<string, string> | undefined, lines = 40,
): Promise<string> {
  const st = await lstat(hostPath).catch(() => undefined);
  if (st?.isFile()) {
    const text = await readFile(hostPath, 'utf8');
    const red = redact(text, secrets);
    if (red !== text) await writeFileAtomic(hostPath, red);
  }
  const r = await runIn(container, `tail -n ${lines} ${shq(boxPath)}`);
  return redact(r.exitCode === 0 ? r.stdout.trimEnd() : '(no app.log)', secrets);
}

const BrowserOutputSchema = z.object({
  checks: z.array(z.object({ id: z.string(), status: z.enum(['pass', 'fail', 'n/a']), note: z.string() })),
});
export type BrowserCheck = z.infer<typeof BrowserOutputSchema>['checks'][number];
const OUTPUT_JSON_SCHEMA = z.toJSONSchema(BrowserOutputSchema) as Record<string, unknown>;

/** One browser_tester session over every check. `screens` is the container path for screenshots. */
export async function runBrowserAgent(
  ctx: StageCtx, checks: AcceptanceCheck[], url: string, screens: string, run: typeof defaultRunAgent = defaultRunAgent,
): Promise<{ checks: BrowserCheck[]; state: JobState }> {
  const { model, effort } = ROLE_MODELS.browser_tester;
  const prompt = [
    `App URL: ${url}`,
    `Screens path: ${screens}`,
    '',
    '## Acceptance checks',
    '',
    ...checks.map((c) => `- ${c.id}: ${c.text}`),
  ].join('\n');
  const req: AgentRequest = {
    role: 'browser_tester',
    model,
    effort,
    systemPrompt: await loadPrompt('browser-tester.md'),
    prompt,
    outputSchema: OUTPUT_JSON_SCHEMA,
    tools: ['Bash', 'Read', 'Glob', 'Grep'],
    maxTurns: 60,
    budgetUsd: remainingUsd(ctx.state),
  };
  const res = await run(ctx, req);
  return { checks: BrowserOutputSchema.parse(res.output).checks, state: res.state };
}

/** Paths whose porcelain status differs between two snapshots, sorted. */
export function changedPaths(before: Map<string, string>, after: Map<string, string>): string[] {
  return [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p)).sort();
}

/**
 * Folds the browser verdicts into passing test results. Only `fail` fails a check; a check the agent
 * left out fails as `not exercised`; ids that are not real checks are ignored. `changed` (project files
 * the agent touched) fails every check; so does `unsettled` (paths a restore could not settle).
 * `screensDir` is the host path.
 */
export function mergeBrowser(
  results: CheckResult[], agent: BrowserCheck[], changed: string[], screensDir: string, unsettled: string[] = [],
): CheckResult[] {
  const verdicts = new Map<string, BrowserCheck>();
  for (const c of agent) if (!verdicts.has(c.id) || c.status === 'fail') verdicts.set(c.id, c);
  return results.map((r) => {
    const v = unsettled.length
      ? { status: 'fail' as const, note: `Project files kept changing after 3 restores, so they may not be back to HEAD: ${unsettled.join(', ')}. Check them before the next build.` }
      : changed.length
      ? { status: 'fail' as const, note: `The browser session (agent or app) changed project files: ${changed.join(', ')}. If the app writes these at runtime, add them to .gitignore.` }
      : verdicts.get(r.id) ?? { status: 'fail' as const, note: 'not exercised' };
    const shot = join(screensDir, `${r.id}.png`);
    const browser: NonNullable<CheckResult['browser']> = { status: v.status, note: v.note, ...(existsSync(shot) ? { screenshot: shot } : {}) };
    if (v.status !== 'fail') return { ...r, browser };
    return { ...r, status: 'fail', reason: 'failing', error: `Browser check failed: ${v.note}`, browser };
  });
}

export function browserReport(results: CheckResult[]): string {
  return results
    .filter((r) => r.browser?.status === 'fail')
    .map((r) => `### ${r.id}: browser\n${r.browser!.note}`)
    .join('\n\n');
}
