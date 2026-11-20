import { assertOnJobBranch } from '../../core/job.js';
import { saveState, transition, unpause } from '../../core/state.js';
import { ACTIVE_STAGES } from '../../pipeline/runner.js';
import { guard, parseBudget, resolveDeps, resolveJob, usd, type CliDeps } from '../deps.js';
import { preflightOr2, refuseIfRunning } from './shared.js';

/**
 * `anton resume <project> [--budget <usd>] [--accept-as-is]`: continue a paused job, or an
 * interrupted one (active stage, no live run). `--budget` sets a new total cap.
 */
export async function resumeCommand(
  project: string,
  opts: { budget?: string; acceptAsIs?: boolean },
  deps: CliDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const budget = parseBudget(opts.budget);
    const job = await resolveJob(project);
    if ((await refuseIfRunning(d, job.repo, project)) !== 0) return 1;
    let state = job.state;
    const paused = state.stage === 'paused';

    if (!paused && !ACTIVE_STAGES.includes(state.stage)) {
      d.err(`Nothing to resume (stage: ${state.stage})`);
      return 1;
    }
    await assertOnJobBranch(job.repo, job.state);
    if (opts.acceptAsIs && !(paused && (state.pausedFrom === 'verify' || state.pausedFrom === 'build'))) {
      d.err(`--accept-as-is only works when paused during build or verify (stage: ${state.stage}${paused ? `, paused from: ${state.pausedFrom}` : ''})`);
      return 1;
    }
    // Delivering costs nothing, so accept-as-is needs no extra budget.
    if (paused && state.pauseReason === 'budget_cap' && budget === undefined && !opts.acceptAsIs) {
      d.err(`Budget cap reached (${usd(state.spentUsd)} of ${usd(state.budgetUsd)} spent). Resume with: anton resume ${project} --budget <usd>`);
      return 1;
    }
    if (budget !== undefined) {
      if (budget <= state.spentUsd) {
        d.err(`--budget must be more than the ${usd(state.spentUsd)} already spent`);
        return 1;
      }
      // A raised cap restarts the 80% warning.
      state = { ...state, budgetUsd: budget, warned80: false };
    }
    if (paused) state = opts.acceptAsIs ? transition(state, 'deliver') : unpause(state);

    const code = await preflightOr2(d);
    if (code !== 0) return code;
    await saveState(job.jobDir, state);
    d.spawnRun(project, job.jobDir);
    d.out(`${project}: resumed at ${state.stage}, running in the background. Follow with: anton logs -f ${project}`);
    return 0;
  });
}
