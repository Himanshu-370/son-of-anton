import { join } from 'node:path';
import { readRegularFile } from '../../core/atomic.js';
import { cacheHitRate, parseUsage, totalUsage } from '../../core/budget.js';
import { currentJobId } from '../../core/job.js';
import { isRunning } from '../../core/lock.js';
import { jobDir as jobDirOf } from '../../core/paths.js';
import { getProject, listProjects, type ProjectEntry } from '../../core/registry.js';
import { loadState } from '../../core/state.js';
import { ACTIVE_STAGES } from '../../pipeline/runner.js';
import { assertJobDir } from '../../stages/verify.js';
import { guard, resolveDeps, usd, type CliDeps } from '../deps.js';

type Row = [string, string, string, string, string, string];

/** The job's cache hit rate as `cache 62%`, or `-` when there is no data or usage.json can't be read safely. */
async function cacheCell(repo: string, jobDir: string): Promise<string> {
  try {
    await assertJobDir(repo, jobDir);
    const rate = cacheHitRate(totalUsage(parseUsage(await readRegularFile(join(jobDir, 'usage.json')))));
    return rate === undefined ? '-' : `cache ${Math.round(rate * 100)}%`;
  } catch {
    return '-';
  }
}

async function row(p: ProjectEntry): Promise<Row> {
  try {
    const dir = jobDirOf(p.repoPath, await currentJobId(p.repoPath));
    const s = await loadState(dir);
    let stage: string = s.stage;
    if (ACTIVE_STAGES.includes(s.stage) && !(await isRunning(p.repoPath)).running) stage = `interrupted (${s.stage})`;
    return [p.name, stage, String(s.round), `${usd(s.spentUsd)} / ${usd(s.budgetUsd)}`, s.pauseReason ?? '-', await cacheCell(p.repoPath, dir)];
  } catch (e) {
    return [p.name, `unreadable (${e instanceof Error ? e.message : String(e)})`, '-', '-', '-', '-'];
  }
}

/** `anton status [project]`: one line per project with stage, round, spend, pause reason and cache hit rate. */
export async function statusCommand(project: string | undefined, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const projects = project ? [await getProject(project)] : await listProjects();
    if (projects.length === 0) {
      d.out('No projects yet. Start one with: anton new "<description>"');
      return 0;
    }
    const rows: Row[] = [['PROJECT', 'STAGE', 'ROUND', 'SPENT / BUDGET', 'PAUSE REASON', 'CACHE'], ...(await Promise.all(projects.map(row)))];
    const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
    for (const r of rows) d.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '));
    return 0;
  });
}
