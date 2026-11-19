import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { defaultExec, type ExecFn } from '../core/exec.js';

export class PreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PreflightError';
  }
}

export async function preflight(
  exec: ExecFn = defaultExec,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  let dockerOk = false;
  try {
    dockerOk = (await exec('docker', ['info'])).exitCode === 0;
  } catch {
    dockerOk = false;
  }
  if (!dockerOk) throw new PreflightError("Docker isn't running. Start Docker Desktop and try again.");
  if (!env.ANTHROPIC_API_KEY) throw new PreflightError('ANTHROPIC_API_KEY is not set.');
}

function packageVersion(): string {
  const pkgPath = fileURLToPath(new URL('../../package.json', import.meta.url));
  return (JSON.parse(readFileSync(pkgPath, 'utf8')) as { version: string }).version;
}

export async function ensureImage(
  kit: { name: string; dockerfile: string },
  exec: ExecFn = defaultExec,
): Promise<string> {
  const tag = `anton/kit-${kit.name}:${packageVersion()}`;
  const have = await exec('docker', ['image', 'inspect', tag]);
  if (have.exitCode === 0) return tag;
  const build = await exec('docker', ['build', '-t', tag, '-f', kit.dockerfile, dirname(kit.dockerfile)]);
  if (build.exitCode !== 0) {
    throw new Error(`docker build failed for ${tag}: ${build.stderr.trim()}`);
  }
  return tag;
}

export async function startContainer(
  slug: string,
  repoPath: string,
  image: string,
  exec: ExecFn = defaultExec,
): Promise<string> {
  const name = `anton-${slug}`;
  await exec('docker', ['rm', '-f', name]).catch(() => undefined);
  const r = await exec('docker', [
    'run', '-d', '--name', name,
    '-v', `${repoPath}:/workspace`,
    '-w', '/workspace',
    '-e', 'ANTHROPIC_API_KEY',
    image, 'sleep', 'infinity',
  ]);
  if (r.exitCode !== 0) throw new Error(`docker run failed: ${r.stderr.trim()}`);
  return name;
}

/** Streaming handle for `docker exec -i` (no shell). */
export function execIn(name: string, cmd: string[], opts: { timeoutMs?: number } = {}) {
  return execa('docker', ['exec', '-i', name, ...cmd], {
    timeout: opts.timeoutMs,
    reject: false,
  });
}

export function runIn(name: string, shellCmd: string, exec: ExecFn = defaultExec) {
  return exec('docker', ['exec', name, 'sh', '-lc', shellCmd]);
}

export async function stopContainer(name: string, exec: ExecFn = defaultExec): Promise<void> {
  try {
    await exec('docker', ['rm', '-f', name]);
  } catch {
    /* ignore */
  }
}
