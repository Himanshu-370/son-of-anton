import * as fsp from 'node:fs/promises';
import { join } from 'node:path';
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
  projects: Record<string, { repoPath: string }>;
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

export async function registerProject(name: string, repoPath: string): Promise<void> {
  const reg = await readRegistry();
  reg.projects[name] = { repoPath };
  await fsp.mkdir(antonHome(), { recursive: true });
  const final = registryFile();
  const tmp = `${final}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(reg, null, 2) + '\n');
  await fsp.rename(tmp, final);
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
