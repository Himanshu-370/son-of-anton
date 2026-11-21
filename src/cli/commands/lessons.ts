import { collectRetros } from '../../retro/run.js';
import { readProposals, removeProposal, type Proposal } from '../../lessons/proposals.js';
import { addLesson, cleanLessonText, DuplicateLessonError, KIT_LESSON_FILES, LESSON_FILES, MAX_LESSONS_PER_FILE, readLessons, removeLesson } from '../../lessons/store.js';
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
      if (ans === 'r') { await removeProposal(p.id, home); rejected++; continue; }
      if (ans === 'a' || ans === 'e') {
        if (p.kind === 'plugin') {
          d.out(`To add it: anton plugins add ${safe(p.plugin)}`);
          d.out(`and list it under stages.${safe(p.stage)} in ~/anton/config.yaml`);
          await removeProposal(p.id, home); accepted++; continue;
        }
        try {
          // The queue file is on disk and editable: only known lesson files are valid targets.
          if (!p.target || !ALL_FILES.includes(p.target)) throw new Error(`Unknown lesson file "${safe(p.target)}"`);
          let text = p.text ?? '';
          if (ans === 'e') text = (await d.ask(['New text:']))[0] ?? '';
          text = cleanLessonText(text);
          d.out(`  Saving: ${text}`);
          const l = await addLesson(p.target, text, home);
          d.out(`  Added ${l.id} to ${p.target}.md`);
          await removeProposal(p.id, home); accepted++; continue;
        } catch (e) {
          if (e instanceof DuplicateLessonError) {
            // Already in the file: keeping the proposal would ask again forever.
            d.out(`  Already saved: ${e.id}`);
            await removeProposal(p.id, home); accepted++; continue;
          }
          d.out(`  Not added: ${safe(e instanceof Error ? e.message : String(e))}`);
        }
      }
      kept++;
    }
    d.out(`Accepted ${accepted}, rejected ${rejected}, kept ${kept}.`);
    return 0;
  });
}

/** `anton lessons list`: every lessons file with its count and each lesson's id and text. */
export async function lessonsListCommand(deps: CliDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  return guard(d, async () => {
    for (const file of ALL_FILES) {
      const ls = await readLessons(file, d.retro.home);
      d.out(`${file}.md (${ls.length}/${MAX_LESSONS_PER_FILE})`);
      for (const l of ls) d.out(`  ${l.id}  ${safe(l.text)}`);
    }
    return 0;
  });
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
