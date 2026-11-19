import { join } from 'node:path';
import { AREA_ORDER, type Area } from '../core/config.js';
import type { CheckResult } from '../kits/types.js';
import type { Plan } from './plan.js';

/** One failure routed to one area's developer. `id` is stable across rounds (it feeds the R1 signature). */
export type FailureItem = { area: Area; kind: 'check' | 'run' | 'review' | 'security'; id: string; text: string };

/** Structured failures of the last verify round, next to the markdown report (R11). */
export function failuresPath(jobDir: string): string {
  return join(jobDir, 'evidence', 'failures.json');
}

function checkText(r: CheckResult): string {
  const lines = [`${r.id} — ${r.reason ?? 'failing'}`];
  if (r.tests.length) lines.push('Tests:', ...r.tests.map((t) => `- ${t}`));
  if (r.error) lines.push('First error:', '```', r.error, '```');
  return lines.join('\n');
}

/** infra if the plan has infra tasks, else backend if it has backend tasks, else the first area present. */
function runArea(plan: Plan): Area {
  const present = new Set(plan.tasks.map((t) => t.area));
  if (present.has('infra')) return 'infra';
  if (present.has('backend')) return 'backend';
  return plan.tasks[0]!.area;
}

/**
 * Code-only QA step: a failing check goes to every area whose tasks cover it (one item per area);
 * a failed smoke run goes to one area (see runArea). A check no task covers falls back to the run area.
 */
export function attributeFailures(results: CheckResult[], runOk: boolean, plan: Plan, runFailureText: string): FailureItem[] {
  const items: FailureItem[] = [];
  for (const r of results) {
    if (r.status !== 'fail') continue;
    const areas = AREA_ORDER.filter((a) => plan.tasks.some((t) => t.area === a && t.acceptanceChecks.includes(r.id)));
    const id = `${r.id}:${r.reason ?? 'failing'}`;
    const text = checkText(r);
    for (const area of areas.length ? areas : [runArea(plan)]) items.push({ area, kind: 'check', id, text });
  }
  if (!runOk) items.push({ area: runArea(plan), kind: 'run', id: 'run:failed', text: runFailureText });
  return items;
}

/** Markdown failure report: one `### <area>` section per area (AREA_ORDER), then the kit's check details. */
export function renderFailureReport(items: FailureItem[], checkDetails: string): string {
  const out: string[] = ['# Verification failures'];
  for (const area of AREA_ORDER) {
    const mine = items.filter((i) => i.area === area);
    if (!mine.length) continue;
    out.push('', `### ${area}`, '');
    for (const i of mine) {
      const [first, ...rest] = i.text.split('\n');
      out.push(`- [${i.kind}] ${i.id}: ${first ?? ''}`, ...rest.map((l) => (l ? `  ${l}` : '')));
    }
  }
  if (checkDetails.trim()) out.push('', '## Check details', '', checkDetails.trim());
  return out.join('\n') + '\n';
}
