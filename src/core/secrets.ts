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

/** Checked env-file lookup: the path if the file exists and parses cleanly (private, Docker-safe), else undefined. */
export async function secretsEnvFile(project: string): Promise<string | undefined> {
  const p = secretsPath(project);
  if (!existsSync(p)) return undefined;
  await loadSecrets(project);
  return p;
}

/**
 * Parses KEY=value lines exactly as `docker --env-file` does (values verbatim, no quote stripping), so the
 * names we show are the names Docker passes. `{}` if the file is missing. Throws unless the file is private,
 * and on any line Docker would read differently than it looks (errors name the line, never the value).
 */
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
  for (const [i, raw] of (await readFile(path, 'utf8')).split(/\r?\n/).entries()) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const bad = (why: string) => new Error(`${path} line ${i + 1}: ${why}`);
    const eq = raw.indexOf('=');
    if (eq < 0) throw bad('a bare name with no "=" would be filled from your environment; write NAME=value');
    const key = raw.slice(0, eq);
    const v = raw.slice(eq + 1);
    if (!key) throw bad('empty name before "="');
    if (/\s/.test(key)) throw bad('no whitespace allowed in the name or before "=" (and no "export" prefix)');
    if (/^\s/.test(v)) throw bad('no whitespace allowed after "="');
    if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v.endsWith(v[0])) {
      throw bad('Docker does not strip quotes; remove the surrounding quotes');
    }
    out[key] = v;
  }
  return out;
}
