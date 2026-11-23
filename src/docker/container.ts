import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdir, readdir, readFile, realpath, stat } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { defaultExec, type ExecFn } from '../core/exec.js';
import { antonHome } from '../core/paths.js';
import { CONTAINER_PLUGINS } from '../plugins/session.js';

/** Value of the `anton.mounts` container label: 2 = workspace + read-only plugin store. */
export const MOUNTS_VERSION = '2';

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

async function listFiles(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const ent of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...(await listFiles(join(dir, ent.name), rel)));
    else if (ent.isFile()) out.push(rel);
  }
  return out;
}

/** First 12 hex of sha256 over the Dockerfile and every file under `.stage/` (sorted paths + contents). */
async function kitContentHash(dockerfile: string, stageDir: string): Promise<string> {
  const h = createHash('sha256');
  h.update('Dockerfile\0').update(await readFile(dockerfile)).update('\0');
  for (const rel of (await listFiles(stageDir)).sort()) {
    h.update(`.stage/${rel}\0`).update(await readFile(join(stageDir, rel))).update('\0');
  }
  return h.digest('hex').slice(0, 12);
}

/** Compiled agent files that `npm run build:image` copies into `.stage/`. */
const AGENT_FILES = ['entry.js', 'pricing.js', 'protocol.js'] as const;

/** Repo `dist/agent/` (resolves the same from src/docker and dist/docker). */
const DEFAULT_AGENT_DIR = fileURLToPath(new URL('../../dist/agent/', import.meta.url));

async function readOrUndefined(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path);
  } catch {
    return undefined;
  }
}

/**
 * Fail closed on a stale stage: a `.stage/` built from older agent code would, for example, strip the
 * reviewers' `tools` field and give them every tool. Each staged agent file must equal the compiled one.
 */
async function assertStageCurrent(stageDir: string, agentDir: string): Promise<void> {
  for (const f of AGENT_FILES) {
    const [staged, built] = await Promise.all([readOrUndefined(join(stageDir, f)), readOrUndefined(join(agentDir, f))]);
    if (!staged || !built || !staged.equals(built)) {
      throw new Error('Kit image files are out of date — run: npm run build:image');
    }
  }
}

/**
 * Tag: `anton/kit-<name>:<version>-<hash>`. The content hash means a changed entry or Dockerfile
 * gets a new tag, so a stale image is never reused. A kit with a `base` builds on the base kit's
 * image (ensured first, passed as `--build-arg BASE`); its hash covers its Dockerfile plus the base
 * tag, and it has no `.stage/` of its own.
 */
export async function ensureImage(
  kit: { name: string; dockerfile: string; base?: { name: string; dockerfile: string } },
  exec: ExecFn = defaultExec,
  opts: { agentDir?: string } = {},
): Promise<string> {
  const context = dirname(kit.dockerfile);
  let hash: string;
  const buildArgs: string[] = [];
  if (kit.base) {
    const baseTag = await ensureImage(kit.base, exec, opts);
    hash = createHash('sha256').update(await readFile(kit.dockerfile)).update('\0').update(baseTag).digest('hex').slice(0, 12);
    buildArgs.push('--build-arg', `BASE=${baseTag}`);
  } else {
    const stageDir = join(context, '.stage');
    const staged = await stat(stageDir).then((s) => s.isDirectory(), () => false);
    if (!staged) throw new Error('Kit image files not staged — run: npm run build:image');
    await assertStageCurrent(stageDir, opts.agentDir ?? DEFAULT_AGENT_DIR);
    hash = await kitContentHash(kit.dockerfile, stageDir);
  }
  const tag = `anton/kit-${kit.name}:${packageVersion()}-${hash}`;
  const have = await exec('docker', ['image', 'inspect', tag]);
  if (have.exitCode === 0) return tag;
  const build = await exec('docker', ['build', '-t', tag, '-f', kit.dockerfile, ...buildArgs, context]);
  if (build.exitCode !== 0) {
    throw new Error(`docker build failed for ${tag}: ${build.stderr.trim()}`);
  }
  return tag;
}

async function resolvedHostPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    const parent = dirname(absolute);
    return parent === absolute ? absolute : join(await resolvedHostPath(parent), basename(absolute));
  }
}

function containsPath(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Keep local Slack configuration and credentials outside container bind mounts. */
export async function assertSlackDataOutsideMount(path: string, home = antonHome()): Promise<void> {
  const [mount, slack] = await Promise.all([resolvedHostPath(path), resolvedHostPath(join(home, 'slack'))]);
  if (containsPath(mount, slack) || containsPath(slack, mount)) {
    throw new Error('A container mount overlaps local Slack data. Put ANTON_HOME outside the project and plugin mounts.');
  }
}

/** Run a kit container: the repo at /workspace and `<home>/plugins` read-only at /opt/anton/plugins. */
export async function startContainer(
  slug: string,
  repoPath: string,
  image: string,
  exec: ExecFn = defaultExec,
  opts: { envFile?: string; home?: string } = {},
): Promise<string> {
  const name = `anton-${slug}`;
  // Created first so Docker does not create it (root-owned) for the bind mount.
  const home = opts.home ?? antonHome();
  const plugins = join(home, 'plugins');
  await Promise.all([assertSlackDataOutsideMount(repoPath, home), assertSlackDataOutsideMount(plugins, home)]);
  await mkdir(plugins, { recursive: true });
  await exec('docker', ['rm', '-f', name]).catch(() => undefined);
  const r = await exec('docker', [
    'run', '-d', '--name', name,
    // Bumped when the mount set changes; the runner replaces a running container without it.
    '--label', `anton.mounts=${MOUNTS_VERSION}`,
    '-v', `${repoPath}:/workspace`,
    '-v', `${plugins}:${CONTAINER_PLUGINS}:ro`,
    '-w', '/workspace',
    '-e', 'ANTHROPIC_API_KEY',
    // Docker reads the file itself, so secret values never appear in argv.
    ...(opts.envFile ? ['--env-file', opts.envFile] : []),
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

/** Removing an already absent container succeeds. Other Docker failures are reported. */
export async function removeContainer(name: string, exec: ExecFn = defaultExec): Promise<void> {
  const result = await exec('docker', ['rm', '-f', name]);
  if (result.exitCode !== 0 && !/No such container:/i.test(result.stderr)) {
    throw new Error(`Docker could not remove ${name}: ${result.stderr.trim() || `exit ${result.exitCode}`}`);
  }
}

export async function stopContainer(name: string, exec: ExecFn = defaultExec): Promise<void> {
  try {
    await removeContainer(name, exec);
  } catch {
    /* ignore */
  }
}
