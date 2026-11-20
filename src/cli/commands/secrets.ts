import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { secretsPath } from '../../core/secrets.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

const HEADER = '# KEY=value, one per line. Passed to job containers as environment variables only.\n';

/** `anton secrets edit <project>`: create the private secrets file if missing, then open it. */
export async function secretsEditCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const path = secretsPath(project);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    // 'wx' leaves an existing file alone; chmod after, because the umask can mask the mode on create.
    await writeFile(path, HEADER, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    await chmod(path, 0o600).catch(() => undefined);
    await d.openEditor(path);
    d.out(`Edited ${path}`);
    return 0;
  });
}
