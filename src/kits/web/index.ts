import { mkdir, rm } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { runAgent as defaultRunAgent } from '../../agent/host-runner.js';
import { porcelainStatus as defaultStatus, restorePaths as defaultRestore } from '../../core/git.js';
import type { JobState } from '../../core/state.js';
import { runIn as dockerRunIn } from '../../docker/container.js';
import { fallbackKit } from '../fallback/index.js';
import type { CheckResult, Kit, VerifyContext, VerifyOutcome } from '../types.js';
import {
  appLogTail, browserReport, changedPaths, mergeBrowser, READY_TRIES, runBrowserAgent, startApp, STOP_APP,
  type BrowserCheck, type RunIn,
} from './browser.js';

const WEB_FILE = /(^|\/)(next\.config\.[^/]+|vite\.config\.[^/]+|svelte\.config\.[^/]+|nuxt\.config\.[^/]+|angular\.json|[^/]+\.(tsx|jsx|vue|svelte)|index\.html)$/;
const WEB_WORDS = /\b(web ?app|website|web page|frontend|front-end|react|next\.js|vue|svelte|dashboard|landing page|browser)\b/i;

function detect(description: string, files: string[]): number {
  if (files.some((f) => WEB_FILE.test(f))) return 0.9;
  return WEB_WORDS.test(description) ? 0.8 : 0;
}

export type WebVerifyDeps = {
  runIn?: RunIn;
  runAgent?: typeof defaultRunAgent;
  porcelainStatus?: typeof defaultStatus;
  restorePaths?: typeof defaultRestore;
  sleep?: (ms: number) => Promise<void>;
};

/**
 * Fallback verify first; only when every check passes and runOk, start the app in the container, run one
 * browser_tester session over all checks, and merge its verdicts. The app is always stopped and any
 * project file the agent touched is restored (and fails every check).
 */
async function verify(ctx: VerifyContext, deps: WebVerifyDeps = {}): Promise<VerifyOutcome> {
  const base = await fallbackKit.verify(ctx, { runIn: deps.runIn });
  if (!base.runOk || base.results.some((r) => r.status === 'fail')) return base;
  const { serve, url } = ctx.commands;
  const stage = ctx.stage;
  if (!serve || !url || !stage) throw new Error('web verify needs commands.serve, commands.url and the stage context');
  const runIn: RunIn = deps.runIn ?? ((n, c) => dockerRunIn(n, c));
  const status = deps.porcelainStatus ?? defaultStatus;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const evidence = join(ctx.jobDir, 'evidence');
  const boxEvidence = `/workspace/.anton/jobs/${basename(ctx.jobDir)}/evidence`;
  const screens = join(evidence, 'screens');
  await rm(screens, { recursive: true, force: true }); // no stale screenshot from an earlier round
  await mkdir(screens, { recursive: true });

  let ready = false;
  let agent: { checks: BrowserCheck[]; state: JobState } | undefined;
  let changed: string[] = [];
  let tail: string;
  try {
    ready = await startApp(runIn, ctx.container, serve, url, `${boxEvidence}/app.log`, sleep);
    if (ready) {
      const before = await status(stage.repo);
      try {
        agent = await runBrowserAgent(stage, ctx.checks, url, `${boxEvidence}/screens`, deps.runAgent);
      } finally {
        changed = changedPaths(before, await status(stage.repo));
        if (changed.length) await (deps.restorePaths ?? defaultRestore)(stage.repo, changed);
      }
    }
  } finally {
    await runIn(ctx.container, STOP_APP);
    tail = await appLogTail(join(evidence, 'app.log'), ctx.secrets);
  }

  if (!ready) {
    const error = `App did not answer at ${url}. Last lines of app.log:\n${tail}`;
    const results: CheckResult[] = ctx.checks.map((c) => ({ id: c.id, status: 'fail', reason: 'run_failed', tests: [], error }));
    const failureReport = `### App did not start\n\`${serve}\` did not answer at ${url} within ${READY_TRIES} s, or exited. Last lines of app.log:\n\`\`\`\n${tail}\n\`\`\``;
    return { ...base, results, runOk: false, failureReport };
  }
  const results = mergeBrowser(base.results, agent!.checks, changed, screens);
  return { ...base, results, failureReport: browserReport(results), state: agent!.state };
}

export const webKit: Kit & { verify: typeof verify } = {
  name: 'web',
  dockerfile: fileURLToPath(new URL('../../../src/kits/web/Dockerfile', import.meta.url)),
  base: fallbackKit,
  detect,
  verify,
  baseline: (ctx) => fallbackKit.baseline(ctx),
};
