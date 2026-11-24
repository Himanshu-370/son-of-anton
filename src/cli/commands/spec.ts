import { loadJob, preflightOr2 } from '../../core/job-actions.js';
import { readSpecContinuation, runSpecRound, specStatus, type SpecRoundDeps } from '../../core/spec-continuation.js';
import { specJobFor } from '../../slack/spec-session.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

/**
 * `anton spec <project> [--retry]`: answer the PM's waiting questions in the terminal, for a spec started in
 * Slack (or a terminal that closed). The round is claimed like a Slack answer, so only one surface answers it.
 * `--retry` reruns an interrupted PM turn; that is never done without asking, because it may cost again.
 */
export async function specCommand(project: string, opts: { retry?: boolean }, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const job = await loadJob(project);
    const c = await readSpecContinuation(project, job.jobId);
    if (job.state.stage !== 'spec' || !c) {
      d.err(`${project}: no spec questions are waiting (stage: ${job.state.stage}).`);
      return 1;
    }
    const code = await preflightOr2(d);
    if (code !== 0) return code;
    const spec = await specJobFor(project, job.jobId);
    const rounds: SpecRoundDeps = {
      surface: 'cli', ensureImage: d.ensureImage, startContainer: d.startContainer, stopContainer: d.stopContainer,
      runAgent: d.runAgent, ensureRepoMap: d.ensureRepoMap, listFiles: d.listFiles, readHistory: d.readHistory,
    };
    let retry = opts.retry === true;
    for (;;) {
      const now = await readSpecContinuation(project, job.jobId);
      if (!now) return 1;
      const status = specStatus(now);
      if (status === 'done') return 0;
      if (status === 'running') {
        d.err(`${project}: the PM is already working on this spec. Check back with: anton status ${project}`);
        return 1;
      }
      let r;
      if (status === 'stopped') {
        if (!retry) {
          d.err(`${project}: the last PM turn was interrupted and its result is unknown (it may have been charged).`);
          d.err(`Nothing was repeated. To run it again: anton spec ${project} --retry`);
          return 1;
        }
        retry = false;
        r = await runSpecRound(spec, { kind: 'retry' }, rounds);
      } else {
        const questions = now.questions ?? [];
        d.out(`The PM has ${questions.length} question(s) for ${project}:`);
        const answers = await d.ask(questions);
        r = await runSpecRound(spec, { kind: 'answers', round: now.round, answers }, rounds);
      }
      for (const line of r.lines) (r.status === 'questions' || r.status === 'spec' ? d.out : d.err)(line);
      if (r.status === 'spec') return 0;
      if (r.status !== 'questions') return 1;
    }
  });
}
