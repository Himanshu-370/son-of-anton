import { estimateUsd } from '../agent/pricing.js';
import type { Role } from './config.js';
import type { SpendEntry } from './spend-log.js';
import type { JobState } from './state.js';

const DAY_MS = 86_400_000;

type JobIdentity = Pick<JobState, 'project' | 'jobId'>;
export type InsightJob = Pick<JobState, 'project' | 'jobId' | 'stage' | 'updatedAt'> & {
  verifyRounds?: number;
  reviewFindings?: number;
  pausedForBudget?: boolean;
  // Later verify rounds and build retries after failed verify, as half-open time windows.
  reworkWindows?: readonly {
    stage: 'build' | 'verify';
    from: string;
    until: string;
  }[];
};

function jobKey({ project, jobId }: JobIdentity): string {
  return JSON.stringify([project, jobId]);
}

function indexJobs(jobs: readonly InsightJob[]): Map<string, InsightJob> {
  return new Map(jobs.map((job) => [jobKey(job), job]));
}

function entryJobKey(entry: SpendEntry): string | undefined {
  if (entry.project !== undefined && entry.jobId !== undefined) {
    return jobKey({ project: entry.project, jobId: entry.jobId });
  }
}

function finished(job: InsightJob): boolean {
  return job.stage === 'done' || job.stage === 'abandoned';
}

export function spendTotals(entries: readonly SpendEntry[], now: Date) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const lastStart = Date.UTC(year, month - 1, 1);
  const start = Date.UTC(year, month, 1);
  const dimensions = ['project', 'stage', 'role', 'model', 'source'] as const;
  const by = { project: new Map<string, number>(), stage: new Map<string, number>(),
    role: new Map<string, number>(), model: new Map<string, number>(), source: new Map<string, number>() };
  let thisMonthUsd = 0;
  let lastMonthUsd = 0;
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (at < lastStart || at > now.getTime()) continue;
    if (at < start) {
      lastMonthUsd += entry.usd;
      continue;
    }
    thisMonthUsd += entry.usd;
    for (const dimension of dimensions) {
      const label = entry[dimension];
      if (label !== undefined) by[dimension].set(label, (by[dimension].get(label) ?? 0) + entry.usd);
    }
  }
  return { thisMonthUsd, lastMonthUsd, by };
}

export function forecastSpend(thisMonthUsd: number, now: Date, capUsd?: number) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const start = Date.UTC(year, month, 1);
  const end = Date.UTC(year, month + 1, 1);
  const daysElapsed = Math.max(1, (now.getTime() - start) / DAY_MS);
  const projectedUsd = thisMonthUsd / daysElapsed * ((end - start) / DAY_MS);
  return { projectedUsd, capUsd, overCap: capUsd === undefined ? undefined : projectedUsd > capUsd };
}

export function spendWaste(entries: readonly SpendEntry[], jobs: readonly InsightJob[]) {
  const byJob = indexJobs(jobs);
  let abandonedUsd = 0;
  let reworkUsd = 0;
  for (const entry of entries) {
    const key = entryJobKey(entry);
    const job = key === undefined ? undefined : byJob.get(key);
    if (!job) continue;
    if (job.stage === 'abandoned') abandonedUsd += entry.usd;
    const at = Date.parse(entry.at);
    if (entry.source === 'build' && job.reworkWindows?.some(({ stage, from, until }) =>
      entry.stage === stage && at >= Date.parse(from) && at < Date.parse(until))) {
      reworkUsd += entry.usd;
    }
  }
  return { abandonedUsd, reworkUsd };
}

export function unusualBurn(
  entries: readonly SpendEntry[],
  jobs: readonly InsightJob[],
  alerted: readonly (JobIdentity & { stage: string })[] = [],
) {
  const stageCosts = new Map<string, number>();
  const stageKey = (key: string, stage: string) => JSON.stringify([key, stage]);
  for (const entry of entries) {
    const key = entryJobKey(entry);
    if (key === undefined || !entry.stage || entry.source !== 'build') continue;
    const bucket = stageKey(key, entry.stage);
    stageCosts.set(bucket, (stageCosts.get(bucket) ?? 0) + entry.usd);
  }
  const history = jobs.filter(finished).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  return jobs.flatMap((job) => {
    if (!['spec', 'plan', 'baseline', 'build', 'verify', 'deliver'].includes(job.stage) ||
      alerted.some((alert) => jobKey(alert) === jobKey(job) && alert.stage === job.stage)) return [];
    const spentUsd = stageCosts.get(stageKey(jobKey(job), job.stage));
    if (spentUsd === undefined) return [];
    const samples = history.flatMap((past) => {
      const usd = stageCosts.get(stageKey(jobKey(past), job.stage));
      return usd === undefined ? [] : [usd];
    }).slice(0, 10).sort((a, b) => a - b);
    if (samples.length < 5) return [];
    const lower = samples[Math.floor((samples.length - 1) / 2)];
    const upper = samples[Math.floor(samples.length / 2)];
    const medianUsd = (lower + upper) / 2;
    if (spentUsd <= 2 * medianUsd) return [];
    return [{ project: job.project, jobId: job.jobId, stage: job.stage, spentUsd, medianUsd, n: samples.length }];
  });
}

function average(values: readonly (number | undefined)[]) {
  const known = values.filter((value): value is number => value !== undefined);
  return { n: known.length, value: known.length ? known.reduce((sum, value) => sum + value, 0) / known.length : undefined };
}

export function modelResults(entries: readonly SpendEntry[], jobs: readonly InsightJob[]) {
  const byJob = indexJobs(jobs.filter(finished));
  const pairs = new Map<string, { role: Role; model: string; costByJob: Map<string, number> }>();
  for (const entry of entries) {
    const key = entryJobKey(entry);
    const { role, model } = entry;
    if (key === undefined || !byJob.has(key) || !role || !model) continue;
    const pairKey = JSON.stringify([role, model]);
    let pair = pairs.get(pairKey);
    if (!pair) {
      pair = { role, model, costByJob: new Map() };
      pairs.set(pairKey, pair);
    }
    pair.costByJob.set(key, (pair.costByJob.get(key) ?? 0) + entry.usd);
  }
  return Array.from(pairs.values(), ({ role, model, costByJob }) => {
    const sample = Array.from(costByJob.keys(), (key) => byJob.get(key)!);
    return {
      role, model, n: sample.length, tooFewJobs: sample.length < 3,
      costUsd: average([...costByJob.values()]),
      verifyRounds: average(sample.map((job) => job.verifyRounds)),
      reviewFindings: average(sample.map((job) => job.reviewFindings)),
      budgetPauseShare: average(sample.map((job) => job.pausedForBudget === undefined ? undefined : Number(job.pausedForBudget))),
    };
  });
}

export function cacheSavingsUsd(entries: readonly SpendEntry[]): number {
  return entries.reduce((sum, { model, tokens, vendor }) => {
    if (!model || !tokens?.cacheRead || (vendor && vendor !== 'anthropic')) return sum;
    return sum + (estimateUsd(model, { input_tokens: tokens.cacheRead }) -
      estimateUsd(model, { cache_read_input_tokens: tokens.cacheRead }));
  }, 0);
}

type ModelResult = ReturnType<typeof modelResults>[number];
type RecommendationHistory = {
  lastSuggestedAt?: string;
  dismissals?: readonly { role: Role; model: string; at: string }[];
};

export function recommendModel(
  results: readonly ModelResult[],
  currentModels: Partial<Record<Role, string>>,
  monthlyJobs: Partial<Record<Role, number>>,
  now: Date,
  history: RecommendationHistory = {},
) {
  if (history.lastSuggestedAt && now.getTime() - Date.parse(history.lastSuggestedAt) < 7 * DAY_MS) return undefined;
  let best: { current: ModelResult; candidate: ModelResult; monthlySavingUsd: number } | undefined;
  for (const candidate of results) {
    const current = results.find(({ role, model }) => role === candidate.role && model === currentModels[role]);
    if (!current || current.model === candidate.model) continue;
    if (history.dismissals?.some(({ role, model, at }) =>
      role === candidate.role && model === candidate.model && now.getTime() - Date.parse(at) < 30 * DAY_MS)) continue;
    const metrics = ['costUsd', 'verifyRounds', 'reviewFindings', 'budgetPauseShare'] as const;
    if (metrics.some((metric) => current[metric].n < 3 || candidate[metric].n < 3)) continue;
    if (candidate.verifyRounds.value! > current.verifyRounds.value! + 1 ||
      candidate.reviewFindings.value! > current.reviewFindings.value! ||
      candidate.budgetPauseShare.value !== current.budgetPauseShare.value) continue;
    const savingPerJob = current.costUsd.value! - candidate.costUsd.value!;
    const monthlySavingUsd = savingPerJob * (monthlyJobs[candidate.role] ?? 0);
    if (savingPerJob > 0 && monthlySavingUsd >= 5 && (!best || monthlySavingUsd > best.monthlySavingUsd)) {
      best = { current, candidate, monthlySavingUsd };
    }
  }
  return best;
}
