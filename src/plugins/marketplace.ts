import { readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { cloneShallow } from '../core/git.js';

/** Plugin names become path segments and config.yaml entries; same shape as config entry names. */
export const PLUGIN_NAME = /^[a-z0-9][a-z0-9-]*$/;
const GH_PART = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const USAGE = 'Use <plugin>@<owner>/<repo> or <plugin>@<git url>';

export type Clone = (url: string, dest: string) => Promise<string>;

/** An https URL without credentials (they would end up in plugins.lock), or null. */
function httpsUrl(s: string): string | null {
  try {
    const u = new URL(s);
    return u.protocol === 'https:' && !u.username && !u.password && !/\s/.test(s) ? s : null;
  } catch {
    return null;
  }
}

function ghRepo(s: string): string | null {
  const [owner, repo, ...rest] = s.split('/');
  return !rest.length && owner && repo && GH_PART.test(owner) && GH_PART.test(repo) ? `https://github.com/${owner}/${repo}.git` : null;
}

export function parseSpecifier(s: string): { plugin: string; marketplace: string; url: string } {
  const at = s.indexOf('@');
  const plugin = s.slice(0, at);
  const marketplace = s.slice(at + 1);
  if (at < 1 || !PLUGIN_NAME.test(plugin)) throw new Error(USAGE);
  const url = marketplace.startsWith('https://') ? httpsUrl(marketplace) : ghRepo(marketplace);
  if (!url) throw new Error(USAGE);
  return { plugin, marketplace, url };
}

/** Path segment for a marketplace: `acme/mkt` → `acme-mkt`, an URL → host and path joined with `-`. */
export function marketplaceSlug(marketplace: string): string {
  const slug = marketplace.replace(/^https:\/\//, '').replace(/\.git$/, '').toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(slug)) throw new Error(`Invalid marketplace name ${JSON.stringify(marketplace)}`);
  return slug;
}

/**
 * The folder holding `plugin` per the clone's `.claude-plugin/marketplace.json`. Object sources are
 * cloned into `<cloneDir>.src`, next to the marketplace clone; the caller removes both.
 */
export async function resolvePluginDir(cloneDir: string, plugin: string, clone: Clone = cloneShallow): Promise<string> {
  const raw = JSON.parse(await readFile(join(cloneDir, '.claude-plugin', 'marketplace.json'), 'utf8')) as { plugins?: unknown };
  const entry = (Array.isArray(raw.plugins) ? raw.plugins : []).find((p: { name?: unknown }) => p?.name === plugin) as
    | { source?: unknown }
    | undefined;
  if (!entry) throw new Error(`Plugin ${plugin} not found in the marketplace`);
  const source = entry.source;
  if (typeof source === 'string') {
    const root = await realpath(cloneDir);
    const dir = await realpath(join(cloneDir, source)).catch(() => {
      throw new Error(`Plugin ${plugin}: source "${source}" does not exist in the marketplace`);
    });
    if (dir !== root && !dir.startsWith(root + sep)) throw new Error(`Plugin ${plugin}: source "${source}" points outside the marketplace repo`);
    return dir;
  }
  const s = (source ?? {}) as { source?: unknown; repo?: unknown; url?: unknown };
  let url: string | null;
  if (s.source === 'github') url = typeof s.repo === 'string' ? ghRepo(s.repo) : null;
  else if (s.source === 'url') url = typeof s.url === 'string' ? httpsUrl(s.url) : null;
  else throw new Error(`Unsupported plugin source "${String(s.source)}" for ${plugin}`);
  // shortcut: a source's `ref`/`sha` field is ignored (default branch is cloned); honour it if marketplaces pin that way.
  if (!url) throw new Error(`Plugin ${plugin}: ${s.source} source must be an owner/repo or an https URL without credentials`);
  const dest = `${cloneDir}.src`;
  await clone(url, dest);
  return dest;
}
