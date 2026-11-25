import { formatStatusTable, jobStatusRows } from '../../core/job-status.js';
import { listProjects } from '../../core/registry.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

/** `anton status [project]`: one line per project with stage, round, spend, pause reason and cache hit rate. */
export async function statusCommand(project: string | undefined, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    if (!project && (await listProjects()).length === 0) {
      d.out('No projects yet. Start one with: anton new "<description>"');
      return 0;
    }
    for (const line of formatStatusTable(await jobStatusRows(project))) d.out(line);
    return 0;
  });
}
