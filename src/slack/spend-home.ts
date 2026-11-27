import { dirname, join } from 'node:path';
import { readRegularFile } from '../core/atomic.js';
import { listProjects } from '../core/registry.js';
import { jobDir } from '../core/paths.js';
import { JobStateSchema } from '../core/state.js';
import { loadAntonConfig } from '../core/anton-config.js';
import { readSpendLog } from '../core/spend-log.js';
import type { AntonConfig } from '../core/anton-config.js';
import { ROLE_MODELS, type Role } from '../core/config.js';
import { resolveModel } from '../core/model-settings.js';
import {
  cacheSavingsUsd, forecastSpend, spendTotals, spendWaste, unusualBurn,
  type InsightJob, type recommendModel,
} from '../core/spend-insights.js';
import type { SpendEntry } from '../core/spend-log.js';
import { userIdSchema, type SlackConfig } from './config.js';
import { displayText } from './views.js';

export const SPEND_HOME_ACTIONS = {
  changeLimit: 'anton_spend_change_limit',
  changeModels: 'anton_spend_change_models',
  settingsHistory: 'anton_spend_settings_history',
  reviewSuggestion: 'anton_spend_review_suggestion',
} as const;

export type SpendHomeData = {
  now: Date;
  entries: readonly SpendEntry[];
  jobs: readonly InsightJob[];
  config: AntonConfig;
  readOnly?: boolean;
  overallCapUsd?: number;
  skipped?: number;
  suggestion?: ReturnType<typeof recommendModel>;
  editedByHandAt?: string;
};

const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const usd = (amount: number) => currency.format(amount);
const monthName = new Intl.DateTimeFormat('en-US', { month: 'long', timeZone: 'UTC' });
const roleName = (role: string) => role === 'pm' || role === 'qa' ? role.toUpperCase() : role.replaceAll('_', ' ');
const plain = (text: string) => ({ type: 'plain_text' as const, text: displayText(text) || ' ', emoji: false });
const section = (text: string) => ({ type: 'section' as const, text: plain(text) });
const button = (label: string, id: string) => ({ type: 'button' as const, action_id: id, text: plain(label) });
const actions = (...elements: ReturnType<typeof button>[]) => ({ type: 'actions' as const, elements });

type HomeView = { type: 'home'; blocks: (ReturnType<typeof section> | ReturnType<typeof actions>)[] };
const ownerNotice = (): HomeView => ({
  type: 'home', blocks: [section('This dashboard is for the anton owner.')],
});

function breakdown(values: ReadonlyMap<string, number>, label: (key: string) => string = (key) => key): string {
  const ordered = [...values].sort(([a, costA], [b, costB]) => costB - costA || a.localeCompare(b));
  const top = ordered.slice(0, 10).map(([key, cost]) => `${displayText(label(key), 128)} ${usd(cost)}`);
  if (ordered.length > top.length) top.push(`+${ordered.length - top.length} more`);
  return top.join(' · ') || 'No attributed spend';
}

function modelSettings(config: AntonConfig): string {
  const { roles, preset, trial } = config.models ?? {};
  const overrides = (Object.keys(ROLE_MODELS) as Role[])
    .filter((role) => roles?.[role] || trial?.role === role)
    .map((role) => {
      const { model, effort } = resolveModel(config, role);
      const trialNote = trial?.role === role
        ? `, trial, ${trial.jobsLeft} ${trial.jobsLeft === 1 ? 'job' : 'jobs'} left`
        : '';
      return `${roleName(role)} → ${model} (${effort}${trialNote})`;
    });
  return `Models   preset ${preset ?? 'balanced'} · overrides: ${overrides.join(' · ') || 'none'}`;
}

const sourceLabels: Record<string, string> = {
  build: 'Builds', chat: 'Slack', router: 'Router', call: 'Calls', import: 'Before tracking',
};

function ownerView(data: SpendHomeData): HomeView {
  const { now, entries, jobs, config, overallCapUsd, skipped, suggestion, editedByHandAt } = data;
  const month = now.toISOString().slice(0, 7);
  const monthly = entries.filter(({ at }) => at.startsWith(month) && Date.parse(at) <= now.getTime());
  const { thisMonthUsd, by } = spendTotals(monthly, now);
  const { projectedUsd } = forecastSpend(thisMonthUsd, now, overallCapUsd);
  let cap = ' · no overall cap';
  if (overallCapUsd === 0) cap = ' · overall spending off ($0.00 cap)';
  else if (overallCapUsd !== undefined) {
    const filled = Math.min(10, Math.round(10 * thisMonthUsd / overallCapUsd));
    cap = ` of ${usd(overallCapUsd)} overall cap   ${'▓'.repeat(filled)}${'░'.repeat(10 - filled)}`;
  }

  const { abandonedUsd, reworkUsd } = spendWaste(monthly, jobs);
  const blocks: HomeView['blocks'] = [
    section(`${monthName.format(now)}   ${usd(thisMonthUsd)}${cap}   on pace for ${usd(projectedUsd)}`),
    section(`By source   ${breakdown(by.source, (key) => sourceLabels[key] ?? key)}`),
    section(`By project   ${breakdown(by.project)}`),
    section(`By role   ${breakdown(by.role, roleName)}`),
    section(`By model   ${breakdown(by.model)}`),
    section(`Waste   abandoned ${usd(abandonedUsd)} · rework ${usd(reworkUsd)}`),
  ];

  for (const { project, jobId, stage, spentUsd, medianUsd } of unusualBurn(entries, jobs).slice(0, 10)) {
    const rate = medianUsd > 0 ? `${(spentUsd / medianUsd).toFixed(1)}× its usual rate` : `${usd(spentUsd)} against a zero median`;
    blocks.push(section(`Watch   ${project} job ${jobId}: ${stage} is burning ${rate}`));
  }

  blocks.push(section(modelSettings(config)));
  if (editedByHandAt) blocks.push(section(`Settings edited by hand at ${editedByHandAt}`));
  if (suggestion) {
    const { candidate, current, monthlySavingUsd } = suggestion;
    blocks.push(section(
      `Suggestion   ${roleName(candidate.role)} on ${candidate.model} would save about ${usd(monthlySavingUsd)} a month ` +
      `(n = ${candidate.n} vs ${current.n}).`,
    ));
    if (!data.readOnly) blocks.push(actions(button('Review', SPEND_HOME_ACTIONS.reviewSuggestion)));
  }

  let uncached = 0;
  let cached = 0;
  for (const { tokens, vendor } of monthly) {
    if (!tokens || (vendor && vendor !== 'anthropic')) continue;
    uncached += tokens.input + tokens.cacheWrite;
    cached += tokens.cacheRead;
  }
  const hitRate = cached + uncached ? ` (${Math.round(100 * cached / (cached + uncached))}% hit rate)` : '';
  blocks.push(section(`Cache   saved ${usd(cacheSavingsUsd(monthly))} this month${hitRate}`));
  if (skipped) blocks.push(section(`${skipped} skipped spend log ${skipped === 1 ? 'line' : 'lines'}`));
  if (!data.readOnly) blocks.push(actions(
    button('Change a limit', SPEND_HOME_ACTIONS.changeLimit),
    button('Change models', SPEND_HOME_ACTIONS.changeModels),
    button('Settings history', SPEND_HOME_ACTIONS.settingsHistory),
  ));
  return { type: 'home', blocks };
}

export function renderSpendHome(config: Pick<SlackConfig, 'ownerId'>, viewerId: string, load: () => SpendHomeData): HomeView {
  return userIdSchema.safeParse(viewerId).success && viewerId === config.ownerId ? ownerView(load()) : ownerNotice();
}

type HomeIdentity = Pick<SlackConfig, 'ownerId' | 'teamId'> & { roles: { pm: Pick<SlackConfig['roles']['pm'], 'appId'> } };
type HomeTarget = { teamId: string; appId: string; userId: string };
type PublishRequest = { user_id: string; view: HomeView };

/** Pass verified Home opens and refresh ticks for the open tab. Bind publish to the configured PM app. */
export function createSpendHomePublisher({ config, load, publish, clock = Date.now }: {
  config: HomeIdentity;
  load: () => SpendHomeData | Promise<SpendHomeData>;
  publish: (request: PublishRequest) => Promise<unknown>;
  clock?: () => number;
}) {
  let opened = false;
  let publishing = false;
  let lastPublished: number | undefined;
  return async ({ teamId, appId, userId }: HomeTarget, reason: 'open' | 'refresh'): Promise<void> => {
    if (teamId !== config.teamId || appId !== config.roles.pm.appId || !userIdSchema.safeParse(userId).success) return;
    if (userId !== config.ownerId) {
      if (reason === 'open') await publish({ user_id: userId, view: ownerNotice() });
      return;
    }

    if (reason === 'open') opened = true;
    if (!opened || publishing) return;
    if (reason === 'refresh' && lastPublished !== undefined && clock() - lastPublished < 60_000) return;

    publishing = true;
    try {
      await publish({ user_id: userId, view: ownerView(await load()) });
      lastPublished = clock();
    } finally {
      publishing = false;
    }
  };
}


/** Load host spend and only the state summaries needed to explain ledger rows. */
export async function loadSpendHomeData(home: string, now = new Date()): Promise<SpendHomeData> {
  const [{ entries, skipped }, config, projects] = await Promise.all([
    readSpendLog(home), loadAntonConfig(home), listProjects(),
  ]);
  const repos = new Map(projects.map(({ name, repoPath }) => [name, repoPath]));
  const seen = new Set<string>();
  const jobs: InsightJob[] = [];
  for (const { project, jobId } of entries) {
    if (!project || !jobId) continue;
    const lookup = JSON.stringify([project, jobId]);
    if (seen.has(lookup)) continue;
    seen.add(lookup);
    const repo = repos.get(project);
    if (!repo) continue;
    try {
      const directory = jobDir(repo, jobId);
      if (dirname(directory) !== join(repo, '.anton', 'jobs')) continue;
      const raw = await readRegularFile(join(directory, 'state.json'));
      if (!raw) continue;
      const state = JobStateSchema.parse(JSON.parse(raw));
      if (state.project === project && state.jobId === jobId) {
        jobs.push({ project, jobId, stage: state.stage, updatedAt: state.updatedAt });
      }
    } catch {
      // The spend remains visible even when a project or job record is no longer present.
    }
  }
  return { now, entries, skipped, config, jobs, readOnly: true };
}
