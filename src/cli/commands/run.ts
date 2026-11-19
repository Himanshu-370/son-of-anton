import { guard, resolveDeps, type CliDeps } from '../deps.js';

/** `anton _run <project>` (hidden): the detached background pipeline run. */
export async function runCommand(project: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    await d.runUnattended(project);
    return 0;
  });
}
