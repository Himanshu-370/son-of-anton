import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { antonHome } from './paths.js';
import { assertProjectName } from './registry.js';

/** `<antonHome>/secrets/<project>.env`. The name is validated: it becomes a path. */
export function secretsPath(project: string): string {
  assertProjectName(project);
  return join(antonHome(), 'secrets', `${project}.env`);
}

/** The secrets file path if it exists (for `docker --env-file`), else undefined. */
export function secretsEnvFile(project: string): string | undefined {
  const p = secretsPath(project);
  return existsSync(p) ? p : undefined;
}

/** Parses KEY=value lines; `{}` if the file is missing. Throws unless the file is private (0600). */
export async function loadSecrets(project: string): Promise<Record<string, string>> {
  const path = secretsPath(project);
  let st;
  try {
    st = await stat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw e;
  }
  if (st.mode & 0o077) throw new Error(`Secrets file must be private: chmod 600 ${path}`);
  const out: Record<string, string> = {};
  for (const raw of (await readFile(path, 'utf8')).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let v = line.slice(eq + 1).trim();
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) v = v.slice(1, -1);
    out[line.slice(0, eq).trim()] = v;
  }
  return out;
}
