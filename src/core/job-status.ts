import { join } from 'node:path';
import { readRegularFile } from './atomic.js';
import { cacheHitRate, parseUsage, totalUsage, usd } from './budget.js';
import { currentJobId } from './job.js';
import { isRunning } from './lock.js';
import { jobDir as jobDirOf } from './paths.js';
import { getProject, listProjects, type ProjectEntry } from './registry.js';
import { loadState } from './state.js';
import { ACTIVE_STAGES } from '../pipeline/runner.js';
import { assertJobDir } from '../stages/verify.js';

export type StatusRow = [string, string, string, string, string, string];
export const STATUS_HEADER: StatusRow = ['PROJECT', 'STAGE', 'ROUND', 'SPENT / BUDGET', 'PAUSE REASON', 'CACHE'];

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

async function statusRow(p: ProjectEntry): Promise<StatusRow> {
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

/** One row per project (or the named one): read-only, no model calls. */
export async function jobStatusRows(project?: string): Promise<StatusRow[]> {
  const projects = project ? [await getProject(project)] : await listProjects();
  return Promise.all(projects.map(statusRow));
}

/** The status table as plain lines: the header first, every column but the last padded to its widest cell. */
export function formatStatusTable(rows: StatusRow[]): string[] {
  const all = [STATUS_HEADER, ...rows];
  const widths = all[0]!.map((_, i) => Math.max(...all.map((r) => r[i]!.length)));
  return all.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join('  '));
}
