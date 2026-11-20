import { readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { loadAntonConfig, resolveEntries, STAGE_GROUP } from '../core/anton-config.js';
import { ROLE_MODELS, type Role } from '../core/config.js';
import { antonHome } from '../core/paths.js';
import { readLock, verifyInstalled, type LockEntry } from './store.js';

/** Where `<home>/plugins` is mounted read-only in every job container. */
export const CONTAINER_PLUGINS = '/opt/anton/plugins';

export type Kit = 'fallback' | 'web';
export type PluginDeps = { home?: string };

export type SessionPlugins = {
  plugins: string[];
  skills: string[];
  mcpServers: Record<string, unknown>;
  used: LockEntry[];
};

/** Config entries (`plugin` or `plugin:skill`) mapped to their lock entries; a missing one throws the add hint. */
function lookup(names: string[], lock: LockEntry[]): Map<LockEntry, { whole: boolean; skills: string[] }> {
  const out = new Map<LockEntry, { whole: boolean; skills: string[] }>();
  for (const name of names) {
    const [plugin, skill] = name.split(':') as [string, string | undefined];
    const entry = lock.find((e) => e.name === plugin);
    if (!entry) {
      throw new Error(`Plugin ${plugin} is listed in config.yaml but not installed — run: anton plugins add ${plugin}@<marketplace>`);
    }
    const use = out.get(entry) ?? { whole: false, skills: [] };
    if (skill) use.skills.push(name);
    else use.whole = true;
    out.set(entry, use);
  }
  return out;
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw new Error(`Invalid plugin file ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

/** A `{ mcpServers: {...} }` file or a bare server map. */
const serversIn = (v: unknown): Record<string, unknown> =>
  isObject(v) ? (isObject(v.mcpServers) ? v.mcpServers : v) : {};

/** The plugin's MCP servers from `.mcp.json` and plugin.json `mcpServers` (inline, or a path inside the plugin). */
async function pluginServers(hostDir: string): Promise<Record<string, unknown>> {
  const servers = serversIn(await readJson(join(hostDir, '.mcp.json')));
  const manifest = await readJson(join(hostDir, '.claude-plugin', 'plugin.json'));
  const field = isObject(manifest) ? manifest.mcpServers : undefined;
  let extra: Record<string, unknown> = {};
  if (isObject(field)) extra = field;
  else if (typeof field === 'string') {
    const path = resolve(hostDir, field);
    if (!path.startsWith(hostDir + sep)) {
      throw new Error(`Plugin mcpServers path escapes the plugin: ${field}`);
    }
    extra = serversIn(await readJson(path));
  }
  return { ...servers, ...extra };
}

/** `plugin:<dir>` for every `skills/<dir>/SKILL.md` in the plugin. */
async function allSkills(name: string, hostDir: string): Promise<string[]> {
  const dirs = await readdir(join(hostDir, 'skills'), { withFileTypes: true }).catch(() => []);
  const out: string[] = [];
  for (const d of dirs) {
    if (d.isDirectory() && (await readFile(join(hostDir, 'skills', d.name, 'SKILL.md')).then(() => true, () => false))) {
      out.push(`${name}:${d.name}`);
    }
  }
  return out.sort();
}

/**
 * Plugins, skills and MCP servers for one session, from config.yaml (stage, kit, role) and the
 * pinned lock. Every used plugin is hash-checked first (fails closed on an edited folder). Container
 * paths come only from the zod-validated LockEntry.dir.
 */
export async function pluginsForSession(
  ctx: { stage: string; kit?: Kit },
  role: string,
  deps: PluginDeps = {},
): Promise<SessionPlugins> {
  const home = deps.home ?? antonHome();
  const names = resolveEntries(await loadAntonConfig(home), { stage: ctx.stage, role: role as Role, kit: ctx.kit ?? 'fallback' });
  const result: SessionPlugins = { plugins: [], skills: [], mcpServers: {}, used: [] };
  if (!names.length) return result;
  const lock = await readLock(home);
  for (const [entry, use] of lookup(names, lock)) {
    await verifyInstalled(entry, home);
    const hostDir = join(home, 'plugins', entry.dir);
    const root = `${CONTAINER_PLUGINS}/${entry.dir}`;
    result.used.push(entry);
    result.plugins.push(root);
    result.skills.push(...(use.whole ? await allSkills(entry.name, hostDir) : use.skills));
    // A `plugin:skill` entry selects one skill, not the plugin's servers.
    if (!use.whole) continue;
    const servers = await pluginServers(hostDir);
    for (const [server, cfg] of Object.entries(servers)) {
      if (server in result.mcpServers) throw new Error(`MCP server "${server}" is defined by more than one plugin (${entry.name})`);
      result.mcpServers[server] = JSON.parse(JSON.stringify(cfg).replaceAll('${CLAUDE_PLUGIN_ROOT}', root));
    }
  }
  return result;
}

/** Every lock entry config.yaml can load for a job on `kit`, across all stages and roles. */
export async function pluginsForJob(kit: Kit, deps: PluginDeps = {}): Promise<LockEntry[]> {
  const home = deps.home ?? antonHome();
  const cfg = await loadAntonConfig(home);
  const names = new Set<string>();
  for (const stage of Object.keys(STAGE_GROUP)) {
    for (const role of Object.keys(ROLE_MODELS) as Role[]) {
      for (const n of resolveEntries(cfg, { stage, role, kit })) names.add(n);
    }
  }
  if (!names.size) return [];
  return [...lookup([...names], await readLock(home)).keys()].sort((a, b) => a.name.localeCompare(b.name));
}
