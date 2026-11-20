import { realpath } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { ensureAntonIgnored, repoRoot } from '../../core/git.js';
import { listProjects, registerProject, slugify, uniqueName } from '../../core/registry.js';
import { guard, resolveDeps, UsageError, type CliDeps } from '../deps.js';

/** `anton adopt <path> [--name <name>]`: register an existing git repo (its root) as a project. No job is created. */
export async function adoptCommand(path: string, opts: { name?: string }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const abs = resolve(path);
    // realpath: git reports the resolved path (macOS /var -> /private/var)
    const real = await realpath(abs).catch(() => null);
    if (!real || (await repoRoot(real)) !== real) throw new UsageError(`${abs} is not the root of a git repository`);
    let name: string;
    if (opts.name !== undefined) {
      name = opts.name;
      if (slugify(name) !== name) throw new UsageError('Project names may only use a-z, 0-9 and -');
      if ((await listProjects()).some((p) => p.name === name)) throw new UsageError(`A project named ${name} already exists`);
    } else {
      name = await uniqueName(slugify(basename(real)));
    }
    await ensureAntonIgnored(real);
    await registerProject(name, real);
    d.out(`Adopted ${name} (${real}). Start a change with: anton change ${name} "<what to change>"`);
    return 0;
  });
}
