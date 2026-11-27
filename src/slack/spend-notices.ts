import { forecastSpend, spendTotals, spendWaste, unusualBurn } from '../core/spend-insights.js';
import { readMonthlySpend } from '../core/spend-log.js';
import { usd } from '../core/budget.js';
import { publishMilestone, type Milestone } from './events.js';
import { loadSpendHomeData, type SpendHomeData } from './spend-home.js';

const DAY_MS = 86_400_000;
const WEEKLY_HOUR = 9;

const pad = (n: number) => String(n).padStart(2, '0');
/** The Monday that starts `now`'s local week, as YYYY-MM-DD. */
function localMonday(now: Date): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - ((now.getDay() + 6) % 7));
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Which spend notices are due now. The outbox drops a repeat of the same kind and occurrence, so this can run
 * on every tick: one 80% warning per UTC month, one summary per local week from Monday 09:00, and one
 * unusual-burn alert per job and stage.
 */
export function dueSpendNotices(data: SpendHomeData, monthUsd: number): Milestone[] {
  const { now, overallCapUsd: cap } = data;
  const due: Milestone[] = [];
  if (cap && monthUsd >= 0.8 * cap) {
    due.push({ scope: 'workspace', kind: 'spend-warning', occurrence: `month-${now.toISOString().slice(0, 7)}` });
  }
  if (now.getDay() === 1 && now.getHours() >= WEEKLY_HOUR) {
    due.push({ scope: 'workspace', kind: 'spend-summary', occurrence: `week-${localMonday(now)}` });
  }
  for (const { project, jobId, stage } of unusualBurn(data.entries, data.jobs)) {
    due.push({ scope: 'job', source: 'factory', kind: 'unusual-burn', project, jobId, occurrence: `burn-${stage}` });
  }
  return due;
}

export async function publishDueSpendNotices(home: string, now = new Date(), publish = publishMilestone): Promise<void> {
  const data = await loadSpendHomeData(home, now);
  const { settledUsd, reservedUsd } = await readMonthlySpend(now.toISOString().slice(0, 7), home);
  for (const event of dueSpendNotices(data, settledUsd + reservedUsd)) await publish(event, { home });
}

function sumBetween(data: SpendHomeData, from: number, until: number): number {
  return data.entries.reduce((sum, { at, usd: cost }) => {
    const t = Date.parse(at);
    return t >= from && t < until ? sum + cost : sum;
  }, 0);
}

function top(values: ReadonlyMap<string, number>): string {
  const [name, cost] = [...values].sort(([, a], [, b]) => b - a)[0] ?? [];
  return name === undefined ? 'none' : `${name} (${usd(cost!)})`;
}

/** Title and lines for a spend notice. Every figure is computed here from the host ledger; nothing is model-written. */
export function spendNoticeText(event: Milestone, data: SpendHomeData, monthUsd: number): { title: string; lines: string[] } | undefined {
  const { now, overallCapUsd: cap } = data;
  const { thisMonthUsd, by } = spendTotals(data.entries, now);
  const { projectedUsd } = forecastSpend(thisMonthUsd, now, cap);
  const pace = `On pace for ${usd(projectedUsd)} this month.`;
  if (event.kind === 'spend-warning') {
    if (!cap) return undefined;
    return {
      title: `Spending has passed 80% of the ${usd(cap)} overall monthly cap`,
      lines: [`${usd(monthUsd)} of ${usd(cap)} used, including holds for work in progress. ${pace}`,
        'At the cap, builds pause and Slack answers fall back to status. Raise budget.monthlyUsd to continue past it.'],
    };
  }
  if (event.kind === 'spend-summary') {
    const end = now.getTime();
    const week = sumBetween(data, end - 7 * DAY_MS, end);
    const before = sumBetween(data, end - 14 * DAY_MS, end - 7 * DAY_MS);
    const change = before > 0 ? ` (${week >= before ? 'up' : 'down'} ${Math.round(100 * Math.abs(week - before) / before)}% on the week before)` : '';
    const { abandonedUsd, reworkUsd } = spendWaste(data.entries, data.jobs);
    const lines = [
      `Last 7 days: ${usd(week)}${change}.`,
      `This month: ${usd(thisMonthUsd)}${cap === undefined ? '' : ` of the ${usd(cap)} cap`}. ${pace}`,
      `Top project: ${top(by.project)}. Top role: ${top(by.role)}.`,
      `Waste this month: abandoned ${usd(abandonedUsd)}, rework ${usd(reworkUsd)}.`,
    ];
    const burning = unusualBurn(data.entries, data.jobs);
    if (burning.length) lines.push(`Watch: ${burning.slice(0, 3).map(({ project, jobId, stage }) => `${project} job ${jobId} (${stage})`).join(', ')}.`);
    if (data.suggestion) {
      const { candidate, monthlySavingUsd } = data.suggestion;
      lines.push(`Suggestion: ${candidate.role} on ${candidate.model} would save about ${usd(monthlySavingUsd)} a month (n = ${candidate.n}).`);
    }
    return { title: 'Weekly spend summary', lines };
  }
  if (event.kind === 'unusual-burn') {
    const stage = event.occurrence.slice('burn-'.length);
    const hit = unusualBurn(data.entries, data.jobs).find((b) => b.project === event.project && b.jobId === event.jobId && b.stage === stage);
    if (!hit) return undefined;
    const rate = hit.medianUsd > 0 ? `${(hit.spentUsd / hit.medianUsd).toFixed(1)}× the usual ${usd(hit.medianUsd)}` : 'well above its usual rate';
    return { title: 'This job is spending faster than usual', lines: [`${stage} has spent ${usd(hit.spentUsd)}, ${rate} for that stage.`] };
  }
  return undefined;
}
