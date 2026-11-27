import { join } from 'node:path';
import { z } from 'zod';
import { readRegularFile, writeFileAtomic } from '../core/atomic.js';
import type { ExecFn } from '../core/exec.js';
import { redact } from '../core/secrets.js';
import type { KitName } from '../kits/index.js';

/*
 * Run a delivered project so the Owner can try it before approving. The project's code was written by
 * agents, so it only ever runs inside its own container: no anton API key, no anton data, and a web port
 * published on 127.0.0.1 only. The host only runs fixed programs (docker, open, osascript) with arguments.
 */

export type PreviewCommands = { install: string; run?: string; serve?: string; url?: string; test?: string };
export type PreviewDeps = {
  /** docker, open and osascript; never a shell on the host. */
  exec: ExecFn;
  image: (kit: KitName) => Promise<string>;
  envFile: (slug: string) => Promise<string | undefined>;
  /** The project's secret values, redacted from install output before it reaches Slack. */
  secrets: (slug: string) => Promise<Record<string, string>>;
  portFree: (port: number) => Promise<boolean>;
  freePort: () => Promise<number>;
  reachable: (url: string) => Promise<boolean>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  home: string;
};

const record = z.strictObject({
  project: z.string(), container: z.string(), jobId: z.string(), revision: z.string(),
  startedAt: z.number(), url: z.string().optional(),
});
export type PreviewRecord = z.infer<typeof record>;
const store = z.strictObject({ version: z.literal(1), runs: z.array(record) });

export const PREVIEW_LIFETIME_MS = 30 * 60_000;
const INSTALL_MS = 5 * 60_000;
const READY_MS = 60_000;
const NAME = /^anton-preview-[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function previewName(slug: string): string {
  const name = `anton-preview-${slug}`;
  if (!NAME.test(name) || name.length > 120) throw new Error(`Invalid preview container name for ${slug}`);
  return name;
}

const file = (home: string) => join(home, 'previews.json');
async function readRuns(home: string): Promise<PreviewRecord[]> {
  const raw = await readRegularFile(file(home));
  if (raw === undefined) return [];
  const parsed = store.safeParse(JSON.parse(raw));
  return parsed.success ? parsed.data.runs : [];
}
const writeRuns = (home: string, runs: PreviewRecord[]) =>
  writeFileAtomic(file(home), JSON.stringify({ version: 1, runs }, null, 2) + '\n');

async function remove(container: string, deps: PreviewDeps): Promise<void> {
  if (NAME.test(container)) await deps.exec('docker', ['rm', '-f', container]);
}

/** Inside the container only: plan commands are untrusted text. */
const inBox = (name: string, cmd: string, deps: PreviewDeps, detach = false) =>
  deps.exec('docker', ['exec', ...(detach ? ['-d'] : []), name, 'sh', '-lc', cmd]);

function withTimeout<T>(p: Promise<T>, ms: number, deps: PreviewDeps): Promise<T | 'timeout'> {
  return Promise.race([p, deps.sleep(ms).then(() => 'timeout' as const)]);
}

export async function runPreview(
  input: { project: string; jobId: string; revision: string; repoPath: string; kit: KitName; commands: PreviewCommands },
  deps: PreviewDeps,
): Promise<{ ok: boolean; lines: string[] }> {
  const { project, repoPath, commands } = input;
  const name = previewName(project);
  if (!commands.run && !commands.serve) return { ok: false, lines: ['Nothing to run for this project.'] };
  // One run per project: an earlier one is replaced.
  await remove(name, deps);
  await writeRuns(deps.home, (await readRuns(deps.home)).filter((r) => r.project !== project));

  let appUrl: URL | undefined;
  let hostPort: number | undefined;
  if (commands.serve && commands.url) {
    appUrl = new URL(commands.url);
    const appPort = Number(appUrl.port || 80);
    hostPort = (await deps.portFree(appPort)) ? appPort : await deps.freePort();
  }
  const envFile = await deps.envFile(project);
  const started = await deps.exec('docker', [
    'run', '-d', '--name', name,
    '-v', `${repoPath}:/workspace`, '-w', '/workspace',
    ...(envFile ? ['--env-file', envFile] : []),
    ...(appUrl && hostPort ? ['-p', `127.0.0.1:${hostPort}:${Number(appUrl.port || 80)}`] : []),
    await deps.image(input.kit), 'sleep', 'infinity',
  ]);
  if (started.exitCode !== 0) return { ok: false, lines: ['Docker could not start the sandbox.'] };

  const installed = await withTimeout(inBox(name, commands.install, deps), INSTALL_MS, deps);
  if (installed === 'timeout' || installed.exitCode !== 0) {
    await remove(name, deps);
    const secrets = await deps.secrets(project).catch(() => ({}));
    const output = installed === 'timeout' ? 'The install took longer than 5 minutes.' : `${installed.stdout}\n${installed.stderr}`;
    const last = redact(output, secrets).split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-20);
    return { ok: false, lines: ['Install failed. Last lines:', ...last] };
  }

  const run: PreviewRecord = { project, container: name, jobId: input.jobId, revision: input.revision, startedAt: deps.now() };
  if (appUrl && hostPort) {
    await inBox(name, commands.serve!, deps, true);
    const local = `http://localhost:${hostPort}${appUrl.pathname}${appUrl.search}`;
    const deadline = deps.now() + READY_MS;
    let ready = false;
    while (!ready && deps.now() < deadline) {
      ready = await deps.reachable(`http://127.0.0.1:${hostPort}${appUrl.pathname}`).catch(() => false);
      if (!ready) await deps.sleep(1000);
    }
    await writeRuns(deps.home, [...(await readRuns(deps.home)), { ...run, url: local }]);
    if (!ready) {
      return { ok: false, lines: ['The app did not answer within 60 seconds. It may only listen inside the container; try the Terminal path from Open in VS Code.'] };
    }
    await deps.exec('open', [local]);
    return { ok: true, lines: [`Running at ${local}. It stops in 30 minutes, or press Stop.`] };
  }

  await writeRuns(deps.home, [...(await readRuns(deps.home)), run]);
  const hint = commands.run ?? commands.test ?? '';
  const script = [
    `tell application "Terminal" to do script "docker exec -it ${name} sh -l"`,
    'tell application "Terminal" to activate',
  ];
  // The container name (validated above) is the only variable in the script; the hint is shown in Slack.
  await deps.exec('osascript', script.flatMap((line) => ['-e', line]));
  return { ok: true, lines: ['A Terminal window opened inside the sandbox.', ...(hint ? [`Try: ${hint}`] : [])] };
}

export async function stopPreview(project: string, deps: PreviewDeps): Promise<boolean> {
  const runs = await readRuns(deps.home);
  const mine = runs.filter((r) => r.project === project);
  for (const r of mine) await remove(r.container, deps);
  if (mine.length) await writeRuns(deps.home, runs.filter((r) => r.project !== project));
  return mine.length > 0;
}

/** Remove runs past their 30 minutes, or whose job is no longer at that delivery. Returns what was removed. */
export async function expirePreviews(stillCurrent: (r: PreviewRecord) => Promise<boolean>, deps: PreviewDeps): Promise<PreviewRecord[]> {
  const runs = await readRuns(deps.home);
  const gone: PreviewRecord[] = [];
  for (const r of runs) {
    if (deps.now() - r.startedAt >= PREVIEW_LIFETIME_MS || !(await stillCurrent(r).catch(() => false))) gone.push(r);
  }
  for (const r of gone) await remove(r.container, deps);
  if (gone.length) await writeRuns(deps.home, runs.filter((r) => !gone.includes(r)));
  return gone;
}

/** At service start and stop: no run outlives the service that started it. */
export async function cleanupAll(deps: PreviewDeps): Promise<void> {
  const runs = await readRuns(deps.home);
  for (const r of runs) await remove(r.container, deps);
  if (runs.length) await writeRuns(deps.home, []);
}

/** Open the folder for reading, never running anything in it. */
export async function openFolder(repoPath: string, deps: Pick<PreviewDeps, 'exec'>): Promise<'vscode' | 'finder'> {
  const code = await deps.exec('open', ['-a', 'Visual Studio Code', repoPath]);
  if (code.exitCode === 0) return 'vscode';
  await deps.exec('open', [repoPath]);
  return 'finder';
}
