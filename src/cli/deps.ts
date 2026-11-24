import { spawn } from 'node:child_process';
import { mkdirSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { runAgent as defaultRunAgent, type StageCtx } from '../agent/host-runner.js';
import { ensureAnthropicKey } from '../core/api-key.js';
import { defaultExec, type ExecFn } from '../core/exec.js';
import { cloneShallow as gitCloneShallow, listFiles as gitListFiles } from '../core/git.js';
import { loadJob } from '../core/job-actions.js';
import type { JobState } from '../core/state.js';
import {
  ensureImage as dockerEnsureImage,
  preflight as dockerPreflight,
  startContainer as dockerStartContainer,
  stopContainer as dockerStopContainer,
} from '../docker/container.js';
import { fallbackKit } from '../kits/fallback/index.js';
import { runUnattended as defaultRunUnattended } from '../pipeline/runner.js';
import { readHistory as defaultReadHistory, type HistoryEntry } from '../core/history.js';
import { ensureRepoMap as defaultEnsureRepoMap } from '../stages/repo-map.js';
import { runSpec as defaultRunSpec } from '../stages/spec.js';
import type { RetroDeps } from '../retro/run.js';

/** Every external effect a command has, injectable for tests. */
export type CliDeps = {
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Used by the default preflight / image / container functions. */
  exec?: ExecFn;
  preflight?: () => Promise<void>;
  ensureImage?: () => Promise<string>;
  startContainer?: (slug: string, repo: string, image: string, opts?: { envFile?: string }) => Promise<string>;
  /** Opens the secrets file for editing (`$EDITOR`, or `open -t` on macOS). */
  openEditor?: (path: string) => Promise<void>;
  stopContainer?: (name: string) => Promise<void>;
  runSpec?: typeof defaultRunSpec;
  /** Builds or refreshes the repo map before a change's spec. */
  ensureRepoMap?: (ctx: StageCtx) => Promise<JobState>;
  ask?: (questions: string[]) => Promise<string[]>;
  /** Repo file names for kit detection (`git ls-files`, capped). */
  listFiles?: (repo: string) => Promise<string[]>;
  /** Past jobs for the cost estimate in spec.md (`~/anton/history.jsonl`). */
  readHistory?: () => Promise<HistoryEntry[]>;
  /** Start the detached background run for a project. */
  spawnRun?: (name: string, jobDir: string) => void;
  kill?: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep?: (ms: number) => Promise<void>;
  runUnattended?: (project: string) => Promise<void>;
  /** Install a SIGINT handler; returns a function that removes it. */
  onSigint?: (handler: () => Promise<void> | void) => () => void;
  exit?: (code: number) => void;
  /** Shallow git clone (`anton plugins add`); returns the HEAD sha. */
  cloneShallow?: (url: string, dest: string) => Promise<string>;
  /** Agent session runner (`anton plugins update`'s review). */
  runAgent?: typeof defaultRunAgent;
  /** Whether stdin is a terminal; when not, `anton plugins update` declines without asking. */
  isTTY?: () => boolean;
  /** `anton serve`: keep ANTHROPIC_API_KEY from the environment or load it from the macOS Keychain (memory only). */
  ensureApiKey?: () => Promise<'environment' | 'keychain' | undefined>;
  /** Retro client, env (for ANTHROPIC_API_KEY) and home; `out` comes from the command. */
  retro?: Omit<RetroDeps, 'out'>;
};

export type Resolved = Required<Omit<CliDeps, 'exec'>>;

/** The built CLI entry; resolves from both src/cli and dist/cli. */
export const cliPath = (): string => fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url));

export function defaultSpawnRun(name: string, jobDir: string): void {
  const logs = join(jobDir, 'logs');
  mkdirSync(logs, { recursive: true });
  const logFd = openSync(join(logs, 'runner.log'), 'a');
  try {
    spawn(process.execPath, [cliPath(), '_run', name], { detached: true, stdio: ['ignore', logFd, logFd] }).unref();
  } finally {
    closeSync(logFd);
  }
}

export function defaultOnSigint(handler: () => Promise<void> | void): () => void {
  const listener = () => void handler();
  process.on('SIGINT', listener);
  return () => {
    process.off('SIGINT', listener);
  };
}

export async function defaultOpenEditor(path: string): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL;
  // Via a shell so values with arguments ("code --wait") work; the path is a positional arg, never interpolated.
  const [cmd, args] = editor
    ? ['sh', ['-c', `${editor} "$1"`, 'sh', path]]
    : process.platform === 'darwin' ? ['open', ['-t', path]] : ['vi', [path]];
  await new Promise<void>((res, rej) =>
    spawn(cmd, args, { stdio: 'inherit' })
      .on('error', rej)
      .on('exit', (code) => (code === 0 ? res() : rej(new Error(`Editor exited with code ${code}`)))));
}

/** Interactive question loop on the terminal. */
export async function readlineAsk(questions: string[]): Promise<string[]> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  // In raw mode readline swallows Ctrl-C (it would just close the interface); forward it as a real
  // SIGINT so `anton new`'s handler stops the container.
  rl.on('SIGINT', () => process.kill(process.pid, 'SIGINT'));
  try {
    const answers: string[] = [];
    for (const [i, q] of questions.entries()) {
      answers.push((await rl.question(`\n${i + 1}. ${q}\n> `)).trim());
    }
    return answers;
  } finally {
    rl.close();
  }
}

export function resolveDeps(d: CliDeps = {}): Resolved {
  const exec = d.exec ?? defaultExec;
  return {
    out: d.out ?? ((l) => console.log(l)),
    err: d.err ?? ((l) => console.error(l)),
    preflight: d.preflight ?? (() => dockerPreflight(exec)),
    ensureImage: d.ensureImage ?? (() => dockerEnsureImage(fallbackKit, exec)),
    startContainer: d.startContainer ?? ((s, r, i, o) => dockerStartContainer(s, r, i, exec, o)),
    openEditor: d.openEditor ?? defaultOpenEditor,
    stopContainer: d.stopContainer ?? ((n) => dockerStopContainer(n, exec)),
    runSpec: d.runSpec ?? defaultRunSpec,
    ensureRepoMap: d.ensureRepoMap ?? ((ctx) => defaultEnsureRepoMap(ctx)),
    ask: d.ask ?? readlineAsk,
    listFiles: d.listFiles ?? ((r) => gitListFiles(r)),
    readHistory: d.readHistory ?? (() => defaultReadHistory()),
    spawnRun: d.spawnRun ?? defaultSpawnRun,
    kill: d.kill ?? ((pid, sig) => { process.kill(pid, sig); }),
    sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    runUnattended: d.runUnattended ?? ((p) => defaultRunUnattended(p)),
    onSigint: d.onSigint ?? defaultOnSigint,
    exit: d.exit ?? ((code) => { process.exit(code); }),
    cloneShallow: d.cloneShallow ?? gitCloneShallow,
    runAgent: d.runAgent ?? defaultRunAgent,
    isTTY: d.isTTY ?? (() => process.stdin.isTTY === true),
    ensureApiKey: d.ensureApiKey ?? (() => ensureAnthropicKey({ exec })),
    retro: d.retro ?? {},
  };
}

export type ResolvedJob = { name: string; repo: string; jobId: string; jobDir: string; state: JobState };

/** A project's current job and its state. */
export async function resolveJob(name: string): Promise<ResolvedJob> {
  return loadJob(name, { allowBench: true });
}

/** Bench owns the lifecycle of its temporary jobs. */
export async function resolveManualJob(name: string): Promise<ResolvedJob> {
  const job = await resolveJob(name);
  if (job.state.bench !== undefined) throw new UsageError('Bench jobs are managed by anton bench.');
  return job;
}

/** Parses a `--budget` value; returns undefined when absent, throws UsageError when invalid. */
export function parseBudget(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--budget must be a positive number of USD (got "${raw}")`);
  return n;
}

/** A usage or state error: printed without a stack, exit 1. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** Runs a command body; maps thrown errors to an exit code (1) with the message on stderr. */
export async function guard(d: Resolved, body: () => Promise<number>): Promise<number> {
  try {
    return await body();
  } catch (e) {
    d.err(e instanceof Error ? e.message : String(e));
    return 1;
  }
}

export { usd } from '../core/budget.js';
