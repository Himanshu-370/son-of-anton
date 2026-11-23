import { collectRetros } from '../../retro/run.js';
import { decideProposal, proposalRevision, readProposals, type Proposal } from '../../lessons/proposals.js';
import { cleanLessonText, KIT_LESSON_FILES, LESSON_FILES, MAX_LESSONS_PER_FILE, readLessons, removeLesson } from '../../lessons/store.js';
import { readHistory } from '../../core/history.js';
import { lessonStats, runSummary } from '../../lessons/stats.js';
import { guard, resolveDeps, type CliDeps } from '../deps.js';

const ALL_FILES = [...(Object.values(LESSON_FILES) as string[]), ...KIT_LESSON_FILES];
// Queue text came from a model: drop control characters (incl. ESC) and format characters (bidi, zero-width).
const safe = (s: string | undefined) => (s ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]|\p{Cf}/gu, '');

function show(p: Proposal): string[] {
  const head = p.kind === 'lesson'
    ? `Lesson for ${safe(p.target)}.md: ${safe(p.text)}`
    : `Plugin ${safe(p.plugin)} for stage ${safe(p.stage)}`;
  return [`\n${head}`, `  why: ${safe(p.why)}`, `  from: ${safe(p.project)} / ${safe(p.jobId)}`];
}

/** `anton lessons review`: collect finished Retros, then accept, edit, reject or skip each queued proposal. */
export async function lessonsReviewCommand(deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const home = d.retro.home;
    const r = await collectRetros({ ...d.retro, out: d.out });
    // Notes and failures carry project and job tags taken from folder names.
    for (const n of r.notes) d.out(safe(n));
    for (const f of r.failed) d.out(`Retro failed: ${safe(f)}`);
    if (r.pending > 0) d.out(`${r.pending} Retro(s) still running — try again later.`);
    const queue = await readProposals(home);
    if (!queue.length) { d.out('No lessons waiting.'); return 0; }
    if (!d.isTTY()) {
      d.out(`${queue.length} proposal(s) waiting. Run \`anton lessons review\` in a terminal to decide.`);
      for (const p of queue) show(p).forEach((l) => d.out(l));
      return 0;
    }
    let accepted = 0, rejected = 0, kept = 0;
    for (const p of queue) {
      show(p).forEach((l) => d.out(l));
      const menu = p.kind === 'lesson' ? '[a]ccept  [e]dit  [r]eject  [s]kip' : '[a]ccept  [r]eject  [s]kip';
      let ans = '';
      for (let i = 0; i < 2 && !ans; i++) {
        const a = ((await d.ask([menu]))[0] ?? '').trim().toLowerCase();
        if ('aers'.includes(a) && a.length === 1 && !(a === 'e' && p.kind === 'plugin')) ans = a;
      }
      // Decisions bind to the proposal as shown: one already decided in Slack is left alone.
      const revision = proposalRevision(p);
      const gone = () => d.out('  Already decided elsewhere.');
      if (ans === 'r') {
        if ((await decideProposal({ proposalId: p.id, decision: 'reject', revision }, home)).status === 'stale') gone();
        else rejected++;
        continue;
      }
      if (ans === 'a' || ans === 'e') {
        if (p.kind === 'plugin') {
          if ((await decideProposal({ proposalId: p.id, decision: 'accept', revision }, home)).status === 'stale') { gone(); continue; }
          d.out(`To add it: anton plugins add ${safe(p.plugin)}`);
          d.out(`and list it under stages.${safe(p.stage)} in ~/anton/config.yaml`);
          accepted++; continue;
        }
        try {
          // The queue file is on disk and editable: only known lesson files are valid targets.
          if (!p.target || !ALL_FILES.includes(p.target)) throw new Error(`Unknown lesson file "${safe(p.target)}"`);
          let text = p.text ?? '';
          if (ans === 'e') text = (await d.ask(['New text:']))[0] ?? '';
          text = cleanLessonText(text);
          d.out(`  Saving: ${safe(text)}`);
          const r = await decideProposal({ proposalId: p.id, decision: 'accept', text, revision }, home);
          if (r.status === 'accepted') { d.out(`  Added ${r.id} to ${r.file}.md`); accepted++; continue; }
          // Already in the file: the proposal is dropped so it is not asked again forever.
          if (r.status === 'duplicate') { d.out(`  Already saved: ${r.id}`); accepted++; continue; }
          if (r.status === 'stale') { gone(); continue; }
          if (r.status === 'failed') throw new Error(r.message);
        } catch (e) {
          d.out(`  Not added: ${safe(e instanceof Error ? e.message : String(e))}`);
        }
      }
      kept++;
    }
    d.out(`Accepted ${accepted}, rejected ${rejected}, kept ${kept}.`);
    return 0;
  });
}

/** `anton lessons list`: every lessons file with its count and each lesson's id and text; `--stats` adds the scoreboard. */
export async function lessonsListCommand(deps: CliDeps = {}, opts: { stats?: boolean } = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const byFile: Record<string, Awaited<ReturnType<typeof readLessons>>> = {};
    for (const file of ALL_FILES) {
      const ls = byFile[file] = await readLessons(file, d.retro.home);
      if (opts.stats) continue;
      d.out(`${file}.md (${ls.length}/${MAX_LESSONS_PER_FILE})`);
      for (const l of ls) d.out(`  ${l.id}  ${safe(l.text)}`);
    }
    if (opts.stats) printStats(d.out, await readHistory(d.retro.home), byFile);
    return 0;
  });
}

const pct = (x?: number) => (x === undefined ? '-' : `${Math.round(x * 100)}%`);
const num = (x?: number) => (x === undefined ? '-' : String(Math.round(x * 100) / 100));
const usd = (x?: number) => (x === undefined ? '-' : `$${x.toFixed(2)}`);
const nums = (m: { firstTryPass?: number; rounds?: number; costUsd?: number; rejects?: number }) =>
  `first-try ${pct(m.firstTryPass)}, rounds ${num(m.rounds)}, cost ${usd(m.costUsd)}, rejects ${num(m.rejects)}`;

function printStats(out: (s: string) => void, history: Awaited<ReturnType<typeof readHistory>>, byFile: Parameters<typeof lessonStats>[1]) {
  const { rows, cacheTrend } = runSummary(history);
  out('Recent runs:');
  if (!rows.length) out('  none yet');
  for (const r of rows) {
    out(safe(`  ${r.at.slice(0, 10)}  ${r.project}  ${r.kit}  first-try ${pct(r.firstTryPass)}  rounds ${num(r.rounds)}  cost ${usd(r.spentUsd)}  rejects ${num(r.rejects)}  cache ${pct(r.cacheHitRate)}${r.bench ? `  bench ${r.bench}` : ''}`));
  }
  if (cacheTrend) {
    out(`Cache hit rate: last 5 runs ${pct(cacheTrend.recent)}, 5 before ${pct(cacheTrend.previous)}`);
    if (cacheTrend.dropped) out('  warning: cache hit rate dropped more than 15 points. A prompt change may be breaking the cache.');
  }
  const stats = lessonStats(history, byFile);
  for (const file of Object.keys(byFile)) {
    out(`\n${file}.md`);
    for (const s of stats.filter((x) => x.file === file)) {
      out(safe(`  ${s.id}  ${s.text}`));
      out(`    with (${s.withRuns} runs): ${nums(s.with)}`);
      out(`    without (${s.withoutRuns} runs): ${nums(s.without)}`);
      out(`    verdict: ${s.verdict}`);
      if (s.verdict === 'no_benefit') out(safe(`    → consider: anton lessons remove ${s.id}`));
    }
  }
  out("\nThese numbers are noisy with few runs — they inform your review, they don't decide.");
}

/** `anton lessons remove <id>`. */
export async function lessonsRemoveCommand(id: string, deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    const r = await removeLesson(id, d.retro.home);
    d.out(`Removed ${r.lesson.id} from ${r.file}.md`);
    return 0;
  });
}
