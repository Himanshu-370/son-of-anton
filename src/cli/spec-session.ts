import { join } from 'node:path';
import type { StageCtx } from '../agent/host-runner.js';
import { loadSecrets, secretsEnvFile } from '../core/secrets.js';
import { finishSpec, interactiveSpecHooks, type SpecJob } from '../core/spec-continuation.js';
import { loadState } from '../core/state.js';
import type { KitName } from '../kits/index.js';
import type { Resolved } from './deps.js';

/** Continuation hooks for a job whose names the store accepts (older or test job IDs just skip it). */
function hooksFor(job: SpecJob) {
  try {
    return interactiveSpecHooks(job);
  } catch {
    return undefined;
  }
}

/** Container + spec loop + approval hint, shared by `anton new` and `anton change`. Returns the exit code. */
export async function runSpecSession(
  d: Resolved,
  p: { name: string; repoPath: string; jobDir: string; description: string; image: string; jobId: string },
  mode: 'new' | 'change',
): Promise<number> {
  // Validates the secrets file first: a bad one fails here, before any container or API spend.
  const envFile = await secretsEnvFile(p.name);
  const secrets = await loadSecrets(p.name);
  const container = await d.startContainer(p.name, p.repoPath, p.image, { envFile });
  const hint = `anton abandon ${p.name}, then run anton ${mode} again.`;
  // Ctrl-C during the interactive spec stage would otherwise leave the container running.
  let interrupted = false;
  const removeSigint = d.onSigint(async () => {
    if (interrupted) return d.exit(130); // second Ctrl-C: don't wait for the stop
    interrupted = true;
    try {
      await d.stopContainer(container);
    } catch {
      // best effort; abandon also stops it
    }
    d.err(`\nInterrupted. Clean up with: ${hint}`);
    d.exit(130);
  });
  let services: { name: string; envVars: string[] }[] = [];
  let kit: KitName = 'fallback';
  const job: SpecJob = { project: p.name, repoPath: p.repoPath, jobId: p.jobId, jobDir: p.jobDir, description: p.description, mode };
  const hooks = /^[1-9]\d*-[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.jobId) ? hooksFor(job) : undefined;
  try {
    const state = await loadState(p.jobDir);
    let warned = false;
    // Spec is warn-only: its over-share line prints once per session, then the session goes on.
    const warn = (line: string) => {
      if (!warned) d.out(line);
      warned = true;
    };
    const ctx: StageCtx = { project: p.name, repo: p.repoPath, container, jobDir: p.jobDir, state, stage: 'spec', secrets, kit: 'fallback', warn };
    if (mode === 'change') ctx.state = await d.ensureRepoMap(ctx);
    const r = await d.runSpec(ctx, p.description, d.ask, hooks ? { hooks } : {}, mode);
    services = r.spec.services ?? [];
    kit = (await finishSpec(job, r.spec, r.state, d, secrets)).kit;
    hooks?.done();
  } catch (e) {
    await hooks?.stopped(e instanceof Error ? e.message : String(e));
    // `spec` has no paused edge, so the job can't be resumed: point at abandon + a fresh run.
    const msg = e instanceof Error ? e.message : String(e);
    d.err(`Spec stage failed: ${msg}. Clean up with: ${hint}`);
    return 1;
  } finally {
    removeSigint();
    await d.stopContainer(container);
  }

  const spec = join(p.jobDir, 'spec.md');
  d.out('');
  const names = Object.keys(secrets);
  d.out(`Kit: ${kit} (change the Kit: line in spec.md to fallback or web before approving if that's wrong)`);
  d.out(`Secrets this job will receive: ${names.length ? names.join(', ') : 'none'}`);
  for (const svc of services) {
    const missing = svc.envVars.filter((v) => !(v in secrets));
    if (missing.length) d.out(`Service ${svc.name}: missing from the secrets file: ${missing.join(', ')} (its [real] tests will skip)`);
  }
  if (mode === 'change') {
    d.out(`Spec ready: ${spec}. Edit the acceptance checks if you like, then run: anton approve ${p.name}. Work happens on branch anton/${p.jobId}.`);
  } else {
    d.out(`Spec written: ${spec}`);
    d.out(`Edit the title and acceptance checks in spec.md if you like, then run: anton approve ${p.name}`);
    d.out('(Other sections of spec.md are informational; the remaining structured fields come from spec.json.)');
  }
  return 0;
}
