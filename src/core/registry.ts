import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFileAtomic } from './atomic.js';
import { acquireLock, AlreadyRunning } from './lock.js';
import { antonHome } from './paths.js';

export class UnknownProject extends Error {
  constructor(public readonly projectName: string) {
    super(`Unknown project: ${projectName}`);
    this.name = 'UnknownProject';
  }
}

export interface ProjectEntry {
  name: string;
  repoPath: string;
}

interface Registry {
  projects: Record<string, { repoPath: string; owner?: string }>;
}

function registryFile(): string {
  return join(antonHome(), 'registry.json');
}

/** Project names become file paths (secrets), so only slug-shaped names are allowed. */
export function assertProjectName(name: string): void {
  // Charset check, not slugify(name) === name: uniqueName may append -N past slugify's 40-char cap.
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) throw new Error('Project names may only use a-z, 0-9 and -');
}

export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, 40)
    .replace(/^-+|-+$/g, '');
  return slug || 'project';
}

async function readRegistry(): Promise<Registry> {
  try {
    return JSON.parse(await fsp.readFile(registryFile(), 'utf8')) as Registry;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { projects: {} };
    throw e;
  }
}

async function withRegistryLock(mutate: () => Promise<void>): Promise<void> {
  const deadline = performance.now() + 5_000;
  let release: () => Promise<void>;
  for (;;) {
    try {
      release = await acquireLock(antonHome(), 'registry.lock');
      break;
    } catch (e) {
      if (!(e instanceof AlreadyRunning)) throw e;
      if (performance.now() >= deadline) throw new Error('Timed out waiting for the project registry lock');
      await delay(25);
    }
  }
  try {
    await mutate();
  } finally {
    await release();
  }
}

/** An owned registration reserves its name until its owner removes it. */
export async function registerProject(name: string, repoPath: string, owner?: string): Promise<void> {
  await withRegistryLock(async () => {
    const reg = await readRegistry();
    if (Object.hasOwn(reg.projects, name) && (owner !== undefined || reg.projects[name]!.owner !== undefined)) {
      throw new Error(`A project named ${name} already exists`);
    }
    reg.projects[name] = { repoPath, ...(owner === undefined ? {} : { owner }) };
    await writeRegistry(reg);
  });
}

/** Clean up an owned project's container and registration while its name is still reserved. */
export async function unregisterProject(name: string, owner: string, beforeRemove: () => Promise<void>): Promise<void> {
  await withRegistryLock(async () => {
    const reg = await readRegistry();
    if (!Object.hasOwn(reg.projects, name) || reg.projects[name]!.owner !== owner) return;
    await beforeRemove();
    delete reg.projects[name];
    await writeRegistry(reg);
  });
}

function writeRegistry(reg: Registry): Promise<void> {
  return writeFileAtomic(registryFile(), JSON.stringify(reg, null, 2) + '\n');
}

export async function getProject(name: string): Promise<ProjectEntry> {
  const { projects } = await readRegistry();
  const entry = Object.hasOwn(projects, name) ? projects[name] : undefined;
  if (!entry) throw new UnknownProject(name);
  return { name, repoPath: entry.repoPath };
}

export async function listProjects(): Promise<ProjectEntry[]> {
  const reg = await readRegistry();
  return Object.entries(reg.projects).map(([name, v]) => ({ name, repoPath: v.repoPath }));
}

export async function uniqueName(base: string): Promise<string> {
  const taken = new Set((await listProjects()).map((p) => p.name));
  if (!taken.has(base)) return base;
  let n = 2;
  while (taken.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}
