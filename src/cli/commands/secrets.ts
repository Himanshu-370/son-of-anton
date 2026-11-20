import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
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
    // 'wx' never overwrites an existing file; a new file is created 0600 (the umask can only remove bits).
    await writeFile(path, HEADER, { flag: 'wx', mode: 0o600 }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== 'EEXIST') throw e;
    });
    if (((await stat(path)).mode & 0o077) !== 0) {
      await chmod(path, 0o600);
      d.err(`${path} was readable by others; tightened to 0600`);
    }
    await d.openEditor(path);
    d.out(`Edited ${path}`);
    return 0;
  });
}
