import { createHash, randomBytes, randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { z } from 'zod';
import { readRegularFile, writeFileAtomic } from '../core/atomic.js';
import { cacheHitRate, parseUsage, totalUsage } from '../core/budget.js';
import type { ExecFn } from '../core/exec.js';
import { commitAll, initRepoIfMissing } from '../core/git.js';
import { estimateCost, quantile, type HistoryEntry } from '../core/history.js';
import { approvePresetSpec, createChangeJob, createNewProject, type NewProject } from '../core/job.js';
import { antonHome } from '../core/paths.js';
import { registerProject, unregisterProject } from '../core/registry.js';
import { loadSecrets, redact } from '../core/secrets.js';
import { JobStateSchema } from '../core/state.js';
import { removeContainer } from '../docker/container.js';
import { containerName, runUnattended as defaultRunUnattended } from '../pipeline/runner.js';
import { readFirstTryPass } from '../stages/deliver.js';
import { assertEvidenceDir, assertJobDir } from '../stages/verify.js';
import type { BenchSample } from './samples.js';

export const BenchResultSchema = z.object({
  sample: z.string(),
  /** 'delivered', 'paused: <reason>' or 'failed: <message>'. */
  outcome: z.string(),
  /** Acceptance checks passing in the latest verify. */
  checks: z.number(),
  firstTryPass: z.number().optional(),
  rounds: z.number(),
  spentUsd: z.number(),
  cacheHitRate: z.number().optional(),
  cleanupErrors: z.array(z.string()).optional(),
});
export type BenchResult = z.infer<typeof BenchResultSchema>;

export const BenchRunSchema = z.object({
  runId: z.string(),
  label: z.string().optional(),
  configHash: z.string(),
  at: z.string(),
  results: z.array(BenchResultSchema),
});
export type BenchRun = z.infer<typeof BenchRunSchema>;

export type BenchDeps = {
  runUnattended?: (project: string) => Promise<void>;
  stopContainer?: (name: string) => Promise<void>;
  exec?: ExecFn;
  onInterrupt?: (cleanup: () => Promise<string[]>) => () => void;
  log?: (line: string) => void;
  home?: string;
};

/** `<ISO date without colons>-<4 hex>`, e.g. 2026-11-21T101500-3fa2. */
export const newRunId = (now = new Date()): string =>
  `${now.toISOString().slice(0, 19).replace(/:/g, '')}-${randomBytes(2).toString('hex')}`;

/** Bench project names are slug-shaped, so the run id is lowercased in them. */
export const benchProjectName = (sample: string, runId: string): string => `bench-${sample}-${runId.toLowerCase()}`;

/** Every earlier results file that parses; anything else in the folder is skipped. Oldest first. */
export async function readBenchRuns(home: string = antonHome()): Promise<BenchRun[]> {
  const dir = join(home, 'bench', 'results');
  let names: string[];
  try {
    names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.json'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw e;
  }
  const runs: BenchRun[] = [];
  for (const n of names) {
    try {
      const r = BenchRunSchema.safeParse(JSON.parse((await readRegularFile(join(dir, n))) ?? ''));
      if (r.success) runs.push(r.data);
    } catch {
      // unreadable or corrupt: skip
    }
  }
  return runs.sort((a, b) => a.at.localeCompare(b.at));
}

/** Per sample: p25–p75 of spend on earlier delivered bench jobs, else the history estimate, else its full budget; summed. */
export function estimateBench(samples: BenchSample[], history: HistoryEntry[], earlier: BenchRun[] = []): { lowUsd: number; highUsd: number } {
  let lowUsd = 0;
  let highUsd = 0;
  for (const s of samples) {
    const past = earlier.flatMap((run) => run.results
      .filter((result) => result.sample === s.name && result.outcome === 'delivered')
      .map((result) => result.spentUsd))
      .sort((a, b) => a - b);
    const est = past.length
      ? { lowUsd: quantile(past, 0.25), highUsd: quantile(past, 0.75) }
      : estimateCost(history, { kind: s.kind, kit: s.kit, checks: s.spec.acceptanceChecks.length }) ?? { lowUsd: s.budgetUsd, highUsd: s.budgetUsd };
    lowUsd += est.lowUsd;
    highUsd += est.highUsd;
  }
  return { lowUsd, highUsd };
}

async function configHash(home: string): Promise<string> {
  try {
    return createHash('sha256').update(await fsp.readFile(join(home, 'config.yaml'))).digest('hex').slice(0, 8);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
    throw e;
  }
}

/** Initialize a fresh working tree and create its job under the reserved project name. */
async function setUpSample(s: BenchSample, name: string, repo: string): Promise<NewProject> {
  await fsp.mkdir(dirname(repo), { recursive: true });
  await fsp.mkdir(repo);
  if (s.kind === 'change') {
    await fsp.cp(s.repoDir!, repo, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (src) => basename(src).toLowerCase() !== '.git',
    });
    await initRepoIfMissing(repo);
    await commitAll(repo, 'chore: bench sample');
    return createChangeJob(name, s.description, { budgetUsd: s.budgetUsd });
  }
  const job = await createNewProject(s.description, {
    budgetUsd: s.budgetUsd, registeredProject: { name, repoPath: repo },
  });
  // The spec-approved tag needs a commit; an empty new repo has none.
  await writeFileAtomic(join(repo, '.gitignore'), '.anton/\n');
  await commitAll(repo, 'chore: initialize project');
  return job;
}

/** Reads the finished job back through the safe reads (the job folder is container-writable). */
async function readOutcome(result: BenchResult, job: NewProject, errorLine: (e: unknown) => string): Promise<void> {
  await assertJobDir(job.repoPath, job.jobDir);
  try {
    const state = JobStateSchema.safeParse(JSON.parse((await readRegularFile(join(job.jobDir, 'state.json'))) ?? 'null'));
    if (!state.success) throw new Error('Invalid or missing job state');
    const { stage, pauseReason, round, spentUsd } = state.data;
    result.outcome = stage === 'awaiting_final_review' ? 'delivered'
      : stage === 'paused' ? `paused: ${errorLine(pauseReason ?? 'unknown')}`
      : `failed: stopped at ${stage}`;
    result.rounds = round;
    result.spentUsd = spentUsd;
  } catch (e) {
    result.outcome = `failed: ${errorLine(e)}`;
  }
  try {
    const usage = (await readRegularFile(join(job.jobDir, 'usage.json'))) ?? '';
    const hit = cacheHitRate(totalUsage(parseUsage(usage)));
    if (hit !== undefined) result.cacheHitRate = hit;
  } catch {
    // Refused or unreadable usage: cache hit rate is unknown.
  }
  try {
    await assertEvidenceDir(job.repoPath, job.jobDir, { create: false });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && !result.outcome.startsWith('failed:')) {
      result.outcome = `failed: ${errorLine(e)}`;
    }
    return;
  }
  try {
    const rec = JSON.parse((await readRegularFile(join(job.jobDir, 'evidence', 'results.json'))) ?? '{}') as { results?: unknown } | null;
    if (Array.isArray(rec?.results)) {
      result.checks = rec.results.filter((r) => (r as { status?: unknown } | null)?.status === 'pass').length;
    }
  } catch {
    // Missing or corrupt results: no checks known to pass.
  }
  const firstTryPass = await readFirstTryPass(job.jobDir);
  if (firstTryPass !== undefined) result.firstTryPass = firstTryPass;
}

/**
 * Runs each sample as a throwaway job in the foreground, one at a time, and stops at final review
 * (never approved or abandoned, so Retro never runs). One sample's pause or crash never stops the bench.
 */
export async function runBench(samples: BenchSample[], opts: { runId: string; label?: string; deps?: BenchDeps }): Promise<BenchRun> {
  const d = opts.deps ?? {};
  const home = d.home ?? antonHome();
  const run = d.runUnattended ?? ((p: string) => defaultRunUnattended(p));
  const stop = d.stopContainer ?? ((n: string) => removeContainer(n, d.exec));
  const log = d.log ?? ((l: string) => console.log(l));
  const results: BenchResult[] = [];
  let interrupted = false;
  let cleanActive: (() => Promise<string[]>) | undefined;
  const off = d.onInterrupt?.(async () => {
    interrupted = true;
    return await cleanActive?.() ?? [];
  });
  try {
    for (const s of samples) {
      if (interrupted) break;
      results.push(await runSample(s));
      cleanActive = undefined;
    }
  } finally {
    off?.();
  }

  async function runSample(s: BenchSample): Promise<BenchResult> {
    const name = benchProjectName(s.name, opts.runId);
    const repo = join(home, 'bench', 'runs', opts.runId, s.name);
    log(`bench: ${s.name} (${name})`);
    const result: BenchResult = { sample: s.name, outcome: 'failed: job not started', checks: 0, rounds: 0, spentUsd: 0 };
    const owner = randomUUID();
    const secrets: Record<string, string> = {};
    if (process.env.ANTHROPIC_API_KEY) secrets.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    const errorLine = (e: unknown) => redact(e instanceof Error ? e.message : String(e), secrets).split('\n')[0]!;
    let job: NewProject | undefined;
    let started = false;
    const setup = (async () => {
      await registerProject(name, repo, owner);
      Object.assign(secrets, await loadSecrets(name));
      job = await setUpSample(s, name, repo);
      await approvePresetSpec(job, { ...s.spec, kit: s.kit }, { budgetUsd: s.budgetUsd, bench: opts.runId });
    })();
    let cleanup: Promise<string[]> | undefined;
    const clean = () => cleanup ??= (async () => {
      await setup.catch(() => undefined);
      const errors: string[] = [];
      try {
        await unregisterProject(name, owner, async () => {
          if (!started) return;
          try {
            await stop(containerName(name));
          } catch (e) {
            errors.push(`Container cleanup: ${errorLine(e)}`);
          }
        });
      } catch (e) {
        errors.push(`Registry cleanup: ${errorLine(e)}`);
      }
      return errors;
    })();
    cleanActive = clean;

    let failure: string | undefined;
    try {
      await setup;
      if (!interrupted) {
        started = true;
        await run(name);
      }
    } catch (e) {
      failure = errorLine(e);
    }
    try {
      if (job) {
        try {
          await readOutcome(result, job, errorLine);
        } catch (e) {
          failure ??= errorLine(e);
        }
      }
      if (failure !== undefined) result.outcome = `failed: ${failure}`;
    } finally {
      const errors = await clean();
      if (errors.length) result.cleanupErrors = errors;
    }
    return result;
  }
  const out: BenchRun = {
    runId: opts.runId,
    ...(opts.label === undefined ? {} : { label: opts.label }),
    configHash: await configHash(home),
    at: new Date().toISOString(),
    results,
  };
  await writeFileAtomic(join(home, 'bench', 'results', `${opts.runId}.json`), JSON.stringify(out, null, 2) + '\n');
  return out;
}
