import { currentJobId } from '../../core/job.js';
import { isRunning } from '../../core/lock.js';
import { jobDir as jobDirOf } from '../../core/paths.js';
import { getProject, listProjects, type ProjectEntry } from '../../core/registry.js';
import { loadState } from '../../core/state.js';
import { ACTIVE_STAGES } from '../../pipeline/runner.js';
import { guard, resolveDeps, usd, type CliDeps } from '../deps.js';

type Row = [string, string, string, string, string];

async function row(p: ProjectEntry): Promise<Row> {
  try {
    const s = await loadState(jobDirOf(p.repoPath, await currentJobId(p.repoPath)));
    let stage: string = s.stage;
    if (ACTIVE_STAGES.includes(s.stage) && !(await isRunning(p.repoPath)).running) stage = `interrupted (${s.stage})`;
    return [p.name, stage, String(s.round), `${usd(s.spentUsd)} / ${usd(s.budgetUsd)}`, s.pauseReason ?? '-'];
  } catch (e) {
    return [p.name, `unreadable (${e instanceof Error ? e.message : String(e)})`, '-', '-', '-'];
  }
}

/** `anton status [project]`: one line per project with stage, round, spend and pause reason. */
export async function statusCommand(project: string | undefined, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const projects = project ? [await getProject(project)] : await listProjects();
    if (projects.length === 0) {
      d.out('No projects yet. Start one with: anton new "<description>"');
      return 0;
    }
    const rows: Row[] = [['PROJECT', 'STAGE', 'ROUND', 'SPENT / BUDGET', 'PAUSE REASON'], ...(await Promise.all(projects.map(row)))];
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) d.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '));
    return 0;
  });
}
