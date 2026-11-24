import { jobStatusRows, STATUS_HEADER, type StatusRow } from '../../core/job-actions.js';
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
    const rows: StatusRow[] = [STATUS_HEADER, ...(await jobStatusRows(project))];
    const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) d.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '));
    return 0;
  });
}
