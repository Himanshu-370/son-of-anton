import { usd } from '../core/budget.js';
import type { BenchRun } from './run.js';

export function previousBench(current: BenchRun, runs: BenchRun[], requested?: string): BenchRun | undefined {
  const candidates = runs.filter((run) => run.runId !== current.runId);
  if (requested !== undefined) {
    const match = candidates.find((run) => run.runId === requested);
    if (!match) throw new Error(`Unknown bench run "${requested}"`);
    return match;
  }
  return candidates.filter((run) => run.at < current.at).sort((a, b) => b.at.localeCompare(a.at))[0];
}

const cell = (value: string) => value.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replaceAll('|', '/');
const percent = (value: number) => `${Math.round(value * 100)}%`;
const count = (value: number) => String(value);

function change(before: number | undefined, after: number | undefined, format = count): string {
  const mark = before === undefined || after === undefined ? '' : after > before ? ' ▲' : after < before ? ' ▼' : '';
  return `${before === undefined ? '-' : format(before)} → ${after === undefined ? '-' : format(after)}${mark}`;
}

export function compareBench(current: BenchRun, previous?: BenchRun): string {
  const title = (run: BenchRun) => cell(`${run.runId}${run.label ? ` (${run.label})` : ''}, config ${run.configHash}`);
  const lines = [`# Bench ${title(current)}`, ''];
  if (!previous) return [...lines, 'First bench run; nothing to compare.'].join('\n');
  lines.push(`Previous run ${title(previous)}`, '',
    '| Sample | Outcome | Checks | First try | Rounds | Cost | Cache | Flag |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |');
  for (const after of current.results) {
    const before = previous.results.find((result) => result.sample === after.sample);
    if (!before) {
      lines.push(`| ${cell(after.sample)} | new | | | | | | |`);
      continue;
    }
    const passDrop = before.firstTryPass !== undefined && after.firstTryPass !== undefined
      && before.firstTryPass - after.firstTryPass > .2 + Number.EPSILON;
    const costLimit = before.spentUsd * 1.5;
    const costIncrease = after.spentUsd - costLimit > Number.EPSILON * after.spentUsd;
    const regression = (before.outcome === 'delivered' && after.outcome !== 'delivered') || passDrop || costIncrease;
    const values = [cell(after.sample), cell(`${before.outcome} → ${after.outcome}`),
      change(before.checks, after.checks), change(before.firstTryPass, after.firstTryPass, percent),
      change(before.rounds, after.rounds), change(before.spentUsd, after.spentUsd, usd),
      change(before.cacheHitRate, after.cacheHitRate, percent), regression ? 'REGRESSION' : ''];
    lines.push(`| ${values.join(' | ')} |`);
  }
  for (const before of previous.results) {
    if (!current.results.some((result) => result.sample === before.sample)) {
      lines.push(`| ${cell(before.sample)} | removed | | | | | | |`);
    }
  }
  const total = (run: BenchRun) => run.results.reduce((sum, result) => sum + result.spentUsd, 0);
  const delivered = (run: BenchRun) => run.results.filter((result) => result.outcome === 'delivered').length;
  lines.push('', `Total cost ${change(total(previous), total(current), usd)}`,
    `Delivered samples ${change(delivered(previous), delivered(current))}`);
  return lines.join('\n');
}
