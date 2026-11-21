import { lstat, readdir, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { ALLOWANCE_ORDER, DEFAULT_ALLOWANCES } from '../core/anton-config.js';
import { readRegularFile } from '../core/atomic.js';
import { allowanceUsage, parseCosts, seedStageSpend, usd, type Allowances } from '../core/budget.js';
import { redact } from '../core/secrets.js';
import { JobStateSchema, type JobState } from '../core/state.js';
import { assertEvidenceDir, assertJobDir, listVerifyCopies } from '../stages/verify.js';

export const MAX_RECORD_CHARS = 60_000;
const REPEATED_AT = 25;
const UNREADABLE = '(unreadable)';

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const own = (o: Obj, k: string): unknown => (Object.hasOwn(o, k) ? o[k] : undefined);
const oneLine = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim();

/** undefined = missing, null = present but unreadable (symlink, bad JSON, wrong shape). */
async function readJson(path: string): Promise<unknown | undefined | null> {
  try {
    const raw = await readRegularFile(path);
    return raw === undefined ? undefined : (JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}
async function readText(path: string): Promise<string | undefined | null> {
  try {
    return await readRegularFile(path);
  } catch {
    return null;
  }
}
const names = (dir: string) => readdir(dir).catch(() => [] as string[]);

/** logs/ is container-writable too: every part of the path must be a real folder (missing is fine). */
async function logsDirOk(jobDir: string): Promise<boolean> {
  const st = await lstat(join(jobDir, 'logs')).catch(() => undefined);
  if (!st) return true;
  return st.isDirectory() && (await realpath(join(jobDir, 'logs'))) === join(await realpath(jobDir), 'logs');
}
const cap = (v: unknown, n = 500) => {
  const t = JSON.stringify(v ?? null) ?? 'null';
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

type Section = { heading: string; body: string };

export async function buildRunRecord(ctx: { repo: string; jobDir: string; secrets?: Record<string, string>; allowances?: Allowances }): Promise<string> {
  await assertJobDir(ctx.repo, ctx.jobDir);
  const f = (p: string) => join(ctx.jobDir, p);

  const stateJson = await readJson(f('state.json'));
  const parsed = JobStateSchema.safeParse(stateJson);
  const state: JobState | undefined = parsed.success ? parsed.data : undefined;
  const spec = await readJson(f('spec.json'));
  const approved = await readJson(f('spec.approved.json'));

  const job = !state
    ? UNREADABLE
    : [
        `- Kind: ${state.kind}`,
        `- Kit: ${isObj(approved) && typeof own(approved, 'kit') === 'string' ? (own(approved, 'kit') as string) : isObj(spec) && typeof own(spec, 'kit') === 'string' ? (own(spec, 'kit') as string) : 'unknown'}`,
        `- Outcome: ${state.stage === 'abandoned' ? 'abandoned' : 'approved'}`,
        `- Rounds: ${state.round}`,
      ].join('\n');

  let specEdits: string;
  if (spec === null || approved === null || (spec !== undefined && !isObj(spec)) || (approved !== undefined && !isObj(approved))) specEdits = UNREADABLE;
  else if (!spec || !approved) specEdits = 'Not available (no spec.json or spec.approved.json).';
  else {
    const keys = [...new Set([...Object.keys(spec), ...Object.keys(approved)])];
    const changed = keys.filter((k) => JSON.stringify(own(spec, k)) !== JSON.stringify(own(approved, k)));
    specEdits = changed.length
      ? changed.map((k) => `- ${k}\n  - proposed: ${cap(own(spec, k))}\n  - approved: ${cap(own(approved, k))}`).join('\n')
      : 'No edits: the approved spec matches the proposed spec.';
  }

  const evidenceOk = await assertEvidenceDir(ctx.repo, ctx.jobDir).then(() => true, () => false);
  const copies = evidenceOk ? await listVerifyCopies(ctx.jobDir).catch(() => []) : [];
  const rounds = await Promise.all(copies.map(async (c) => ({ n: c.n, rec: await readJson(f(`evidence/${c.name}`)) })));

  const failed: string[] = [];
  const findings: string[] = [];
  for (const { n, rec } of rounds) {
    if (!isObj(rec)) {
      failed.push(`### Verify ${n}\n${UNREADABLE}`);
      findings.push(`### Verify ${n}\n${UNREADABLE}`);
      continue;
    }
    const results = Array.isArray(own(rec, 'results')) ? (own(rec, 'results') as unknown[]) : [];
    const bad = results.filter((r): r is Obj => isObj(r) && own(r, 'status') === 'fail');
    const runOk = own(rec, 'runOk') === false ? ['- smoke run failed'] : [];
    const lines = [...runOk, ...bad.map((r) => `- ${oneLine(own(r, 'id'))} (${oneLine(own(r, 'reason') ?? 'failing')})${own(r, 'error') ? `: ${oneLine(own(r, 'error')).slice(0, 200)}` : ''}`)];
    failed.push(`### Verify ${n}\n${lines.length ? lines.join('\n') : 'No failed checks.'}`);

    const review = isObj(own(rec, 'review')) && Array.isArray(own(own(rec, 'review') as Obj, 'findings')) ? (own(own(rec, 'review') as Obj, 'findings') as unknown[]) : [];
    const sec = isObj(own(rec, 'security')) && Array.isArray(own(own(rec, 'security') as Obj, 'findings')) ? (own(own(rec, 'security') as Obj, 'findings') as unknown[]) : [];
    const fl = [
      ...review.filter(isObj).map((x) => `- code review ${oneLine(own(x, 'severity'))} ${oneLine(own(x, 'file'))}: ${oneLine(own(x, 'summary'))}`),
      ...sec.filter(isObj).map((x) => `- security ${oneLine(own(x, 'severity'))} ${oneLine(own(x, 'file'))}: ${oneLine(own(x, 'title'))}`),
    ];
    findings.push(`### Verify ${n}\n${fl.length ? fl.join('\n') : 'No findings.'}`);
  }
  // Only the latest round's structured failures survive on disk (each fix round overwrites them).
  const latest = evidenceOk ? await readJson(f('evidence/failures.json')) : null;
  if (!evidenceOk) {
    failed.push(UNREADABLE);
    findings.push(UNREADABLE);
  } else if (latest === null) failed.push(`### Latest failure items\n${UNREADABLE}`);
  else if (Array.isArray(latest) && latest.length)
    failed.push(`### Latest failure items\n${latest.filter(isObj).map((i) => `- ${oneLine(own(i, 'area'))} ${oneLine(own(i, 'kind'))} ${oneLine(own(i, 'id'))}: ${oneLine(own(i, 'text')).slice(0, 200)}`).join('\n')}`);

  const noteFiles = (await names(ctx.jobDir)).filter((n) => /^notes-round-\d+\.md$/.test(n)).sort((a, b) => parseInt(a.slice(12), 10) - parseInt(b.slice(12), 10));
  const notes = await Promise.all(noteFiles.map(async (n) => `### ${n}\n${(await readText(f(n)))?.trim() ?? UNREADABLE}`));

  const questions = await readText(f('questions.md'));

  let cost: string;
  if (!state) cost = UNREADABLE;
  else
    try {
    const rawCost = await readText(f('cost.json'));
    const seeded = seedStageSpend(state, rawCost ? parseCosts(rawCost).costs : {});
    const al = ctx.allowances ?? DEFAULT_ALLOWANCES;
    cost = ALLOWANCE_ORDER.filter((g): g is Exclude<typeof g, 'retro'> => g !== 'retro')
      .map((g) => {
        const u = allowanceUsage(seeded, g, al);
        const own$ = seeded.stageSpentUsd && Object.hasOwn(seeded.stageSpentUsd, g) ? seeded.stageSpentUsd[g]! : 0;
        return `- ${g}: ${usd(own$)} spent; cumulative ${usd(u.spentUsd)} of ${usd(u.limitUsd)} share${u.spentUsd > u.limitUsd ? ' (over)' : ''}`;
      })
      .join('\n');
    } catch {
      cost = UNREADABLE;
    }

  const tools: string[] = [];
  const logsOk = await logsDirOk(ctx.jobDir).catch(() => false);
  if (!logsOk) tools.push(UNREADABLE);
  for (const n of (logsOk ? await names(f('logs')) : []).filter((x) => x.endsWith('.log')).sort()) {
    const text = await readText(f(`logs/${n}`));
    if (text === null) {
      tools.push(`### ${n.slice(0, -4)}\n${UNREADABLE}`);
      continue;
    }
    const counts = new Map<string, number>();
    for (const m of (text ?? '').matchAll(/^tool: (\S.*)$/gm)) counts.set(m[1]!.trim(), (counts.get(m[1]!.trim()) ?? 0) + 1);
    if (counts.size)
      tools.push(`### ${n.slice(0, -4)}\n${[...counts].sort((a, b) => b[1] - a[1]).map(([k, c]) => `- ${k}: ${c}${c >= REPEATED_AT ? ' (repeated)' : ''}`).join('\n')}`);
  }

  const none = (a: string[]) => (a.length ? a.join('\n\n') : 'None recorded.');
  const sections: Section[] = [
    { heading: '## Job', body: job },
    { heading: '## Spec edits at checkpoint 1', body: specEdits },
    { heading: '## Failed checks by round', body: none(failed) },
    { heading: '## Reject notes', body: none(notes) },
    { heading: '## Reviewer findings', body: none(findings) },
    { heading: '## Questions and assumptions', body: questions === null ? UNREADABLE : questions?.trim() || 'None recorded.' },
    { heading: '## Cost and allowance by stage', body: cost },
    { heading: '## Tool use by stage', body: none(tools) },
  ];

  const render = () => `# Run record\n\n${sections.map((s) => `${s.heading}\n\n${s.body}`).join('\n\n')}\n`;
  let text = redact(render(), ctx.secrets);
  // Cut from the end: a section loses its body but keeps its heading.
  for (let i = sections.length - 1; i >= 0 && text.length > MAX_RECORD_CHARS; i--) {
    sections[i]!.body = '(truncated)';
    text = redact(render(), ctx.secrets);
  }
  return text;
}
