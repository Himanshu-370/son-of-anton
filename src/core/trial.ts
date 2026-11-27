import { antonHome } from './paths.js';
import { resolveModel } from './model-settings.js';
import { applySettingsChange, readSettingsHistory, type SettingEdit } from './settings-history.js';
import { readSpendLog } from './spend-log.js';

/**
 * Count a finished (delivered or abandoned) job toward the model trial when the trial's role ran on the trial
 * model in it. At zero jobs left the trial ends and its role goes back to what was in effect when it started.
 * Counted once per job: the history entry's intent names the job. Returns what changed, for the caller's log.
 */
export async function completeTrialJob(job: { project: string; jobId: string }, home = antonHome()): Promise<string | undefined> {
  const { hash, config, history } = await readSettingsHistory(home);
  const trial = config.models?.trial;
  if (!trial) return undefined;
  const intent = `trial_job:${job.project}/${job.jobId}`;
  if (history.some((entry) => entry.intent === intent)) return undefined;
  const { entries } = await readSpendLog(home);
  const ran = entries.some((e) => e.source === 'build' && e.project === job.project && e.jobId === job.jobId
    && e.role === trial.role && e.model === trial.model);
  if (!ran) return undefined;

  const left = trial.jobsLeft - 1;
  let edits: SettingEdit[] = [{ path: ['models', 'trial', 'jobsLeft'], value: left }];
  if (left <= 0) {
    // Without the trial the role falls back to its override or preset; restore revertTo only where that differs.
    const { trial: _ended, ...models } = config.models!;
    const fallback = resolveModel({ ...config, models }, trial.role);
    edits = [{ path: ['models', 'trial'] }];
    if (fallback.model !== trial.revertTo.model || fallback.effort !== trial.revertTo.effort) {
      edits.push({ path: ['models', 'roles', trial.role], value: trial.revertTo } as SettingEdit);
    }
  }
  await applySettingsChange({ expectedHash: hash, intent, edits }, home);
  return left > 0
    ? `Model trial: ${trial.role} on ${trial.model} has ${left} ${left === 1 ? 'job' : 'jobs'} left.`
    : `Model trial ended: ${trial.role} is back on ${trial.revertTo.model} (${trial.revertTo.effort}).`;
}
