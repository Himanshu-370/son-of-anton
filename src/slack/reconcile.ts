import { readdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { listTags as defaultListTags } from '../core/git.js';
import { antonHome, jobDir } from '../core/paths.js';
import type { ProjectEntry } from '../core/registry.js';
import { JobStateSchema, type JobState } from '../core/state.js';
import { readCheckedFile } from './artifacts.js';
import { configuredSlack, jobId, projectId, specRevision, type Milestone, type PublishMilestoneDeps } from './events.js';

const registrySchema = z.object({ projects: z.record(z.string(), z.object({ repoPath: z.string() })) });
type Checkpoint = Extract<Milestone, { kind: 'spec-ready' | 'delivery-ready' }>;

export async function registeredProjects(home: string): Promise<ProjectEntry[]> {
  const raw = await readCheckedFile(home, ['registry.json'], 1024 * 1024);
  if (!raw) return [];
  const { projects } = registrySchema.parse(JSON.parse(raw.toString('utf8')));
  return Object.entries(projects).flatMap(([name, { repoPath }]) => isAbsolute(repoPath) ? [{ name, repoPath }] : []);
}

export interface ReconcileCheckpointDeps extends PublishMilestoneDeps {
  listProjects?: () => Promise<ProjectEntry[]>;
  listTags?: (repo: string, pattern: string) => Promise<string[]>;
}

async function currentJob(repo: string): Promise<string | undefined> {
  const entries = await readdir(join(repo, '.anton', 'jobs'), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && jobId.safeParse(entry.name).success)
    .map(({ name }) => name)
    .sort((a, b) => Number.parseInt(b, 10) - Number.parseInt(a, 10))[0];
}

const stateBytes = (repo: string, id: string) => readCheckedFile(repo, ['.anton', 'jobs', id, 'state.json'], 256 * 1024);

async function checkpointFor(
  repoPath: string, state: JobState, listTags: typeof defaultListTags,
): Promise<Checkpoint | undefined> {
  const { jobId, project } = state;
  const event = { scope: 'job', source: 'factory', project, jobId } as const;
  if (state.stage === 'awaiting_spec_approval') {
    const occurrence = await specRevision(jobDir(repoPath, jobId));
    return occurrence ? { ...event, kind: 'spec-ready', occurrence } : undefined;
  }
  if (state.stage === 'awaiting_final_review') {
    const prefix = `anton/${jobId}/`;
    const tags = await listTags(repoPath, `${prefix}delivered-*`);
    const occurrence = tags.filter((tag) => tag.startsWith(prefix))
      .map((tag) => tag.slice(prefix.length))
      .filter((tag) => /^delivered-[1-9]\d{0,14}$/.test(tag))
      .sort((a, b) => Number(b.slice('delivered-'.length)) - Number(a.slice('delivered-'.length)))[0];
    return occurrence ? { ...event, kind: 'delivery-ready', occurrence } : undefined;
  }
  return undefined;
}

/**
 * Recheck a recovered checkpoint against the current job before making a new claim. An already-issued
 * claim must still be reconciled. State can advance between the last local read and the Slack write.
 */
export async function checkpointFreshness(event: Milestone, home: string): Promise<'current' | 'stale' | 'unknown'> {
  if (event.kind !== 'spec-ready' && event.kind !== 'delivery-ready') return 'current';
  try {
    const project = (await registeredProjects(home)).find(({ name }) => name === event.project);
    if (!project) return 'unknown';
    const { repoPath } = project;
    const id = await currentJob(repoPath);
    if (id !== event.jobId) return id ? 'stale' : 'unknown';
    const bytes = await stateBytes(repoPath, id);
    if (!bytes) return 'unknown';
    const state = JobStateSchema.parse(JSON.parse(bytes.toString('utf8')));
    if (state.bench !== undefined || state.project !== event.project || state.jobId !== id) return 'stale';
    const expectedStage = event.kind === 'spec-ready' ? 'awaiting_spec_approval' : 'awaiting_final_review';
    if (state.stage !== expectedStage) return 'stale';
    const current = await checkpointFor(repoPath, state, defaultListTags);
    if (await currentJob(repoPath) !== id) return 'stale';
    const confirmed = await stateBytes(repoPath, id);
    if (!confirmed) return 'unknown';
    if (!confirmed.equals(bytes)) {
      const latest = JobStateSchema.safeParse(JSON.parse(confirmed.toString('utf8')));
      if (latest.success && (latest.data.stage !== expectedStage || latest.data.bench !== undefined ||
          latest.data.project !== event.project || latest.data.jobId !== id)) return 'stale';
      return 'unknown';
    }
    if (!current) return 'unknown';
    return current.occurrence === event.occurrence ? 'current' : 'stale';
  } catch {
    return 'unknown';
  }
}

/**
 * Recover currently waiting checkpoints. Re-read job state after the revision lookup and validate
 * again at drain time. The queue and core state do not share a transaction or a complete history.
 */
export async function reconcileCheckpoints(deps: ReconcileCheckpointDeps = {}): Promise<void> {
  const home = deps.home ?? antonHome();
  try {
    const config = await configuredSlack(deps);
    if (!config) return;
    const projects = await (deps.listProjects?.() ?? registeredProjects(home));
    const { enqueueMilestone } = await import('./outbox.js');
    for (const { name, repoPath } of projects) {
      if (!projectId.safeParse(name).success) continue;
      try {
        const id = await currentJob(repoPath);
        if (!id) continue;
        const bytes = await stateBytes(repoPath, id);
        if (!bytes) continue;
        const state = JobStateSchema.parse(JSON.parse(bytes.toString('utf8')));
        if (state.bench !== undefined || state.project !== name || state.jobId !== id) continue;
        const event = await checkpointFor(repoPath, state, deps.listTags ?? defaultListTags);
        if (!event || !(await stateBytes(repoPath, id))?.equals(bytes) || await currentJob(repoPath) !== id) continue;
        await enqueueMilestone(event, { home, config }, { recovered: true });
      } catch {
        // An unavailable or invalid project must not stop recovery for the other projects.
      }
    }
  } catch {
    // Setup and the registry can be temporarily unavailable during startup.
  }
}
