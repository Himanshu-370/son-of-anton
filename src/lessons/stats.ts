import { KIT_LESSON_FILES, type Lesson } from './store.js';
import type { HistoryEntry } from '../core/history.js';

export type Metrics = { firstTryPass?: number; rounds?: number; costUsd?: number; rejects?: number };
export type Verdict = 'not_enough_runs' | 'no_benefit' | 'ok';
export type LessonStat = {
  id: string; file: string; text: string;
  withRuns: number; withoutRuns: number; with: Metrics; without: Metrics; verdict: Verdict;
};

export const MIN_WITH = 5;
export const MIN_WITHOUT = 3;
const DROP_POINTS = 15;

/** Mean of the values that exist; undefined when none (a missing metric is never 0). */
function mean(xs: (number | undefined)[]): number | undefined {
  const v = xs.filter((x): x is number => typeof x === 'number');
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : undefined;
}

const metrics = (rs: HistoryEntry[]): Metrics => ({
  firstTryPass: mean(rs.map((r) => r.firstTryPass)),
  rounds: mean(rs.map((r) => r.rounds)),
  costUsd: mean(rs.map((r) => r.spentUsd)),
  rejects: mean(rs.map((r) => r.rejects)),
});

/** No benefit: pass rate not higher, rounds not lower and cost not lower (an unmeasurable metric counts as no improvement). */
function noBenefit(w: Metrics, o: Metrics): boolean {
  const better = (a?: number, b?: number, lower = false) => a !== undefined && b !== undefined && (lower ? a < b : a > b);
  return !better(w.firstTryPass, o.firstTryPass) && !better(w.rounds, o.rounds, true) && !better(w.costUsd, o.costUsd, true);
}

export function lessonStats(history: HistoryEntry[], lessonsByFile: Record<string, Lesson[]>): LessonStat[] {
  const out: LessonStat[] = [];
  for (const [file, lessons] of Object.entries(lessonsByFile)) {
    const pool = KIT_LESSON_FILES.includes(file) ? history.filter((h) => h.kit === file) : history;
    for (const l of lessons) {
      const withR = pool.filter((h) => h.lessons?.includes(l.id));
      // Runs without a lessons field are unknown, not "without".
      const withoutR = pool.filter((h) => h.lessons && !h.lessons.includes(l.id));
      const w = metrics(withR), o = metrics(withoutR);
      const verdict: Verdict = withR.length < MIN_WITH || withoutR.length < MIN_WITHOUT ? 'not_enough_runs' : noBenefit(w, o) ? 'no_benefit' : 'ok';
      out.push({ id: l.id, file, text: l.text, withRuns: withR.length, withoutRuns: withoutR.length, with: w, without: o, verdict });
    }
  }
  return out;
}

export function runSummary(history: HistoryEntry[], n = 10): { rows: HistoryEntry[]; cacheTrend?: { recent: number; previous: number; dropped: boolean } } {
  const sorted = [...history].sort((a, b) => a.at.localeCompare(b.at));
  const rows = sorted.slice(-n);
  const rates = sorted.map((h) => h.cacheHitRate).filter((x): x is number => typeof x === 'number');
  const recent = mean(rates.slice(-5));
  const previous = mean(rates.slice(-10, -5));
  if (recent === undefined || previous === undefined) return { rows };
  return { rows, cacheTrend: { recent, previous, dropped: (previous - recent) * 100 > DROP_POINTS } };
}
