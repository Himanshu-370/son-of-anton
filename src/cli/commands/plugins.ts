import { join } from 'node:path';
import { loadAntonConfig, READ_ONLY_ROLES } from '../../core/anton-config.js';
import type { Role } from '../../core/config.js';
import { antonHome } from '../../core/paths.js';
import { installPlugin, readLock } from '../../plugins/store.js';
import { updatePlugin } from '../../plugins/update.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

/** `anton plugins add <specifier>`: install, pin, and show how to enable it. */
export async function pluginsAddCommand(specifier: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const e = await installPlugin(specifier, { clone: d.cloneShallow });
    d.out(`Installed ${e.name} ${e.version} from ${e.marketplace} at ${e.commit.slice(0, 12)}`);
    d.out(`  sha256 ${e.sha256}`);
    d.out(`  folder ${join(antonHome(), 'plugins', e.dir)}`);
    d.out(`It loads only where listed. Add it to ${join(antonHome(), 'config.yaml')}, for example:`);
    d.out(`  stages:\n    build: [${e.name}]`);
    return 0;
  });
}

/** `anton plugins list`: the lock, then each configured stage/kit/role list. */
export async function pluginsListCommand(deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const lock = await readLock();
    const cfg = await loadAntonConfig();
    if (!lock.length) d.out('No plugins installed.');
    else {
      d.out('Installed (plugins.lock):');
      for (const e of lock) d.out(`  ${e.name}  ${e.version}  ${e.marketplace}  ${e.commit.slice(0, 12)}`);
    }
    const installed = new Set(lock.map((e) => e.name));
    const show = (entries: string[]) =>
      entries.map((x) => (installed.has(x.split(':')[0]!) ? x : `${x} (NOT INSTALLED)`)).join(', ');
    const groups: [string, Record<string, string[] | undefined> | undefined][] = [
      ['stage', cfg.stages], ['kit', cfg.kits], ['role', cfg.roles],
    ];
    const lines: string[] = [];
    for (const [kind, map] of groups) {
      for (const [name, entries] of Object.entries(map ?? {})) {
        if (!entries?.length) continue;
        const ignored = kind === 'role' && READ_ONLY_ROLES.includes(name as Role) ? ' (ignored: read-only role)' : '';
        lines.push(`  ${kind} ${name}: ${show(entries)}${ignored}`);
      }
    }
    d.out(lines.length ? `Loaded by (config.yaml):\n${lines.join('\n')}` : 'No plugins listed in config.yaml.');
    return 0;
  });
}

/** `anton plugins update [name]`: review and, on a yes, re-pin the named plugin or every locked one, one at a time. */
export async function pluginsUpdateCommand(name: string | undefined, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const names = name ? [name] : (await readLock()).map((e) => e.name);
    if (!names.length) d.out('No plugins installed.');
    for (const n of names) {
      const r = await updatePlugin(n, d);
      d.out(r === 'up_to_date' ? `${n} is up to date` : r === 'updated' ? `Updated ${n}` : `Kept ${n} at its pinned version`);
    }
    return 0;
  });
}
