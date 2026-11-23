import { publishMilestone } from '../../slack/events.js';
import { join } from 'node:path';
import { compareBench, previousBench } from '../../bench/compare.js';
import { estimateBench, newRunId, readBenchRuns, runBench } from '../../bench/run.js';
import { initBench, loadSamples, type BenchSample } from '../../bench/samples.js';
import { writeFileAtomic } from '../../core/atomic.js';
import { antonHome } from '../../core/paths.js';
import { guard, resolveDeps, usd, type CliDeps } from '../deps.js';
import { preflightOr2 } from './shared.js';

export type BenchOpts = { init?: boolean; only?: string; label?: string; compare?: string; yes?: boolean };

/** `anton bench [--only a,b] [--label <text>] [--yes]` and `anton bench --init`. Spends real money: asks first. */
export async function benchCommand(opts: BenchOpts, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const home = antonHome();
    if (opts.init) {
      const r = await initBench(home);
      d.out(`Bench samples in ${home}/bench: ${r.copied.length} file(s) copied, ${r.kept.length} kept.`);
      return 0;
    }
    const only = opts.only?.split(',').map((x) => x.trim()).filter(Boolean);
    if (only?.length === 0) {
      d.err('--only requires at least one sample name.');
      return 1;
    }
    let samples: BenchSample[];
    try {
      samples = await loadSamples(home, only);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      d.err('Run anton bench --init first.');
      return 1;
    }
    const history = await d.readHistory();
    const earlier = await readBenchRuns(home);
    if (opts.compare !== undefined && !earlier.some((run) => run.runId === opts.compare)) {
      d.err(`Unknown bench run ${JSON.stringify(opts.compare)}.`);
      return 1;
    }
    for (const s of samples) {
      const e = estimateBench([s], history, earlier);
      d.out(`- ${s.name} (${s.kind}, ${s.kit} kit, cap ${usd(s.budgetUsd)}): est. ${usd(e.lowUsd)}–${usd(e.highUsd)}`);
    }
    const est = estimateBench(samples, history, earlier);
    const range = `${usd(est.lowUsd)}–${usd(est.highUsd)}`;
    d.out(`Estimated total: ${range}`);
    if (!opts.yes) {
      if (!d.isTTY()) {
        d.err('Not a terminal: re-run with --yes to start the bench (it spends real money).');
        return 1;
      }
      const a = ((await d.ask([`Run the bench now (est. ${range})? [y/N]`]))[0] ?? '').trim().toLowerCase();
      if (a !== 'y' && a !== 'yes') {
        d.out('Bench not started.');
        return 0;
      }
    }
    const code = await preflightOr2(d);
    if (code !== 0) return code;

    const runId = newRunId();
    const run = await runBench(samples, {
      runId,
      ...(opts.label === undefined ? {} : { label: opts.label }),
      deps: {
        runUnattended: d.runUnattended,
        ...(deps.stopContainer === undefined ? {} : { stopContainer: deps.stopContainer }),
        ...(deps.exec === undefined ? {} : { exec: deps.exec }),
        log: d.out,
        home,
        onInterrupt: (cleanup) => d.onSigint(async () => {
          for (const error of await cleanup()) d.err(error);
          d.err('Bench interrupted.');
          d.exit(130);
        }),
      },
    });
    d.out(`Bench ${run.runId}${run.label ? ` (${run.label})` : ''}, config ${run.configHash}:`);
    for (const r of run.results) {
      const pct = (n: number | undefined) => (n === undefined ? '-' : `${Math.round(n * 100)}%`);
      d.out(`- ${r.sample}: ${r.outcome}, ${r.checks} check(s) passing, first try ${pct(r.firstTryPass)}, ${r.rounds} round(s), ${usd(r.spentUsd)}, cache ${pct(r.cacheHitRate)}`);
      for (const error of r.cleanupErrors ?? []) d.err(`${r.sample}: ${error}`);
    }
    d.out(`Results: ${home}/bench/results/${run.runId}.json`);
    const comparison = compareBench(run, previousBench(run, earlier, opts.compare));
    await writeFileAtomic(join(home, 'bench', 'results', `${run.runId}.md`), `${comparison}\n`);
    d.out(comparison);
    await publishMilestone({
      scope: 'workspace', kind: 'bench-summary', occurrence: run.runId,
      count: run.results.length, passed: run.results.filter((result) => result.outcome === 'delivered').length,
    }, { home });
    return 0;
  });
}
