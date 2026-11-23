# Phase 5b: Scoreboard and Bench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let you see whether the factory is getting better. A scoreboard (`anton lessons list --stats`) shows, per lesson, how jobs did with it and without it, and flags lessons with no measurable benefit. `anton bench` runs 3 to 5 fixed practice projects unattended, shows the cost first, and compares the results with the previous bench run. It is the factory's own regression test after you accept lessons, update plugins or try Caveman or Ponytail. This phase also fixes the Phase 5a "Do first" code items.

**Architecture:**
- **Job metrics.** Every finished job's line in `~/anton/history.jsonl` gains its quality numbers:
  - checks passing on the first try
  - build⇄verify rounds
  - rejects at checkpoint 2
  - active lesson ids
  - a `bench` run id, when the job ran on the bench
- **Scoreboard.** The scoreboard is pure code over that history.
- **Bench samples.** They ship in the repo under `bench/` and are copied once to `~/anton/bench/` by `anton bench --init`.
- **Bench runs.**
  - Each sample becomes a real project in a throwaway folder `~/anton/bench/runs/<runId>/<sample>/`, with its pre-approved spec written in.
  - The job starts at `plan`, which skips checkpoint 1. The normal pipeline then runs it in the foreground, one sample at a time.
  - The run stops at `awaiting_final_review`, with no Retro.
  - The results file is `~/anton/bench/results/<runId>.json`.

**Tech Stack:** TypeScript ESM, vitest, zod. No new dependencies.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` §10.2 ("Measuring" and "Practice projects"), §7.1 (the scoreboard records cost and quality per stage and tracks the cache hit rate; `anton bench --only <name>` with an estimated cost first), §7 (CLI `lessons list`, `bench`), §12 (which sample projects go in the bench: they should cover both kits). Phase 5a follow-ups: `docs/superpowers/plans/2026-11-22-phase-5a-followups.md` ("Do first").

## Global Constraints

- **Scoreboard (§10.2).** "each run records active lessons. A scoreboard (`anton lessons list --stats`) tracks per run: acceptance checks passing first try, build⇄verify rounds, cost, rejects at checkpoint 2. Lessons with no measurable benefit after enough runs are flagged for removal (you decide). With few projects these numbers are noisy — they inform your review, they don't decide."
  - **Plan decision, "enough runs":** at least 5 runs with the lesson active and at least 3 runs without it, counting only the same kit when the lesson is a kit lesson.
  - **Plan decision, "no measurable benefit":** with the lesson active, the mean first-try pass rate is not higher, the mean rounds are not lower, and the mean cost is not lower.
  - Nothing is removed automatically. The flag prints the `anton lessons remove <id>` hint.
- **Cache tracking (§7.1).** "The scoreboard tracks the cache hit rate, so a change that silently breaks caching shows up."
  - **Plan decision:** compare the mean cache hit rate of the last 5 runs with the 5 before them. A drop of more than 15 percentage points prints a warning.
- **Bench (§10.2).**
  - "`~/anton/bench/` holds 3–5 small fixed sample projects with pre-approved specs. At least one is a change job on a small existing sample repo … `anton bench` runs them unattended (skipping checkpoint 1) and compares the scoreboard to the previous bench run … Costs a few dollars per run; only runs when you invoke it."
  - §7.1: "`anton bench` can run a subset of practice projects (`--only <name>`), and it shows the estimated cost before it starts."
- **Samples (§12, plan decision).** There are 4 samples:
  - `cli-wordcount`: fallback kit, new project
  - `web-counter`: web kit, new project
  - `api-todo`: fallback kit, new project, a small HTTP JSON API
  - `change-greeting`: fallback kit, a change job on a tiny included repo
  - Each sample's budget cap is $3. All their spec text is obviously synthetic.
- **Spending money.** The bench prints its estimate, then asks `Run the bench now (est. $a–$b)? [y/N]`. Only `y` or `yes` runs it. Without a terminal it refuses unless `--yes` is given.
- **Isolation.** Bench jobs never touch your real projects.
  - Bench projects are registered with the name prefix `bench-` and deregistered when the run ends.
  - Bench history lines carry `bench: <runId>` and are left out of the checkpoint-1 estimate.
  - Bench jobs never run Retro: they stop at `awaiting_final_review` and are never approved or abandoned through the CLI.
- **Caveman and Ponytail (spec and memory).** Measure them on the bench before turning them on. `anton bench --label <text>` records a label, such as `caveman-on`. The comparison shows the label and a hash of `config.yaml` for both runs.
- Existing rules from CLAUDE.md apply:
  - Effects go through `deps`.
  - Saves go through `writeFileAtomic` and `redact()`.
  - Host git goes only through `src/core/git.ts`.
  - Job-folder files are read with `readRegularFile` after `assertJobDir`, own keys only.
  - zod is the source of truth.
  - Unit tests never touch the network, real Docker or the real `~/anton`.
  - Fixtures are obviously fake.

## Review Focus

1. **A bench sample pauses (budget cap, error, round cap) or crashes.** Expected:
   - That sample is recorded as `paused: <reason>` or `failed: <message>`.
   - Its container is stopped, and the bench goes on to the next sample.
   - The run still writes its results and comparison.

   (Task 5)
2. **The first bench run, or a previous run made with a different set of samples.** Expected:
   - `First bench run; nothing to compare.`
   - Otherwise only samples in both runs are compared, and the others are listed as `new` or `removed`.

   (Task 6)
3. **A lesson with too few runs, or one that only appears in jobs of another kit.** Expected: `not enough runs (k with, m without)`. It is never flagged. (Task 3)
4. **The user's real projects, registry and history around a bench run.** Expected:
   - Nothing changes except new `bench`-tagged history lines.
   - The estimate at checkpoint 1 ignores bench lines.
   - Bench projects are deregistered even when the run fails partway.

   (Tasks 2, 5)
5. **Old history lines without the new fields.** Expected: they still parse. The stats skip a missing metric for that run instead of treating it as 0. (Tasks 2, 3)

---

### Task 1: Phase 5a "Do first" fixes

**Files:**
- Modify: `src/lessons/store.ts` (`cleanLessonText`, `.gitignore` commit), `src/cli/commands/lessons.ts` (the `Saving:` line), `src/retro/run.ts` (the unknown-target note)
- Test: `tests/lessons/store.test.ts`, `tests/cli/lessons.test.ts`, `tests/retro/run.test.ts`

**Interfaces:**
- Produces:
  - `cleanLessonText` also strips C1 controls (U+0080–U+009F).
  - The `Saving:` line goes through `safe()`.
  - The `dropped lesson for unknown target` note passes the target through `redact` with the secrets that include the key.
  - `addLesson` adds `.gitignore` to the commit paths whenever git doesn't track it yet.

- [ ] **Step 1: Write the failing tests.**
  - `'C1 controls are stripped from lessons'`
  - `'Saving line is sanitized'`
  - `'unknown-target note is redacted'`
  - `'an untracked .gitignore is committed with the next lesson'`
- [ ] **Step 2:** Run `npx vitest run tests/lessons tests/cli/lessons.test.ts tests/retro/run.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `fix(lessons): close Phase 5a follow-ups`.

### Task 2: Quality metrics in job history

**Files:**
- Modify: `src/core/history.ts`, `src/core/state.ts` (`rejects`), `src/cli/commands/reject.ts`, `src/stages/deliver.ts`
- Test: `tests/core/history.test.ts`, `tests/stages/deliver.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Produces:
  - **State.** `JobStateSchema` gains `rejects: z.number().int().min(0).optional()`, which `reject` increments.
  - **History entry.** `HistoryEntrySchema` gains these optional fields. Old lines still parse.
    - `firstTryPass`: a number from 0 to 1. It is the share of acceptance checks that passed in verify round 1, read from `evidence/results-verify-1.json` through the safe reads.
    - `rounds: number`
    - `rejects: number`
    - `lessons: string[]`: the ids from `run-record.json`.
    - `bench: string`
  - **Deliver.** It fills these fields. `bench` comes from `state.bench` (new, optional), which the bench runner sets.
  - **Estimate.** `estimateCost` leaves out entries that have `bench`.

- [ ] **Step 1: Write the failing tests.**
  - `'reject increments rejects'`
  - `'history line has firstTryPass, rounds, rejects and lessons'`
  - `'firstTryPass reads round-1 results safely; missing file leaves it out'`
  - `'old history lines without new fields still parse'`
  - `'bench lines are ignored by the estimate'`
- [ ] **Step 2:** Run `npx vitest run tests/core/history.test.ts tests/stages/deliver.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(history): quality metrics per job`.

### Task 3: Scoreboard (`anton lessons list --stats`)

**Files:**
- Create: `src/lessons/stats.ts`
- Modify: `src/cli/commands/lessons.ts`, `src/cli/index.ts` (`--stats`)
- Test: `tests/lessons/stats.test.ts`, `tests/cli/lessons.test.ts`

**Interfaces:**
- Consumes: `readHistory`, `readLessons`, `LESSON_FILES`, `KIT_LESSON_FILES`.
- Produces:
  - **Per-lesson stats.** `lessonStats(history, lessonsByFile): LessonStat[]`, where `LessonStat = { id, file, text, withRuns, withoutRuns, with: Metrics, without: Metrics, verdict: 'not_enough_runs' | 'no_benefit' | 'ok' }` and `Metrics = { firstTryPass?, rounds?, costUsd?, rejects? }` (means).
    - A kit lesson compares only jobs of that kit.
    - A missing metric is skipped for that run.
    - The verdict follows the Global Constraints rule.
  - **Run summary.** `runSummary(history, n = 10): { rows; cacheTrend?: { recent: number; previous: number; dropped: boolean } }`.
  - **CLI.** `anton lessons list --stats` prints, in order:
    1. the run summary table (date, project, kit, first-try %, rounds, cost, rejects, cache %, plus `bench` when present)
    2. the cache trend line, with the warning when it dropped
    3. per lesson file, each lesson's with and without numbers and its verdict; `no_benefit` adds `→ consider: anton lessons remove <id>`
    4. a final line: `These numbers are noisy with few runs — they inform your review, they don't decide.`

- [ ] **Step 1: Write the failing tests.**
  - `'means with and without a lesson'`
  - `'kit lesson compares only same-kit jobs'`
  - `'not enough runs below 5 with / 3 without'`
  - `'no benefit when nothing improves'`
  - `'ok when any metric improves'`
  - `'missing metrics are skipped, not zero'`
  - `'cache trend warns on a drop over 15 points'`
  - `'--stats prints summary, trend, lessons and the noise note'`
- [ ] **Step 2:** Run `npx vitest run tests/lessons/stats.test.ts tests/cli/lessons.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(lessons): scoreboard with per-lesson stats and cache trend`.

### Task 4: Bench samples and `anton bench --init`

**Files:**
- Create:
  - `bench/manifest.json`
  - `bench/cli-wordcount/spec.json`, `bench/web-counter/spec.json`, `bench/api-todo/spec.json`, `bench/change-greeting/spec.json`
  - `bench/change-greeting/repo/` (a tiny Node package with one test)
  - `src/bench/samples.ts`
- Modify: `package.json` (`files` includes `bench/`)
- Test: `tests/bench/samples.test.ts`

**Interfaces:**
- Produces:
  - **Manifest.** `BenchManifestSchema` = `{ samples: [{ name, kind: 'new'|'change', kit: 'fallback'|'web', budgetUsd: number, description: string }] }`. Each `spec.json` parses with `SpecDocBaseSchema` and is used as the pre-approved spec.
  - **`initBench(home?): Promise<{ copied: string[]; kept: string[] }>`** copies the shipped `bench/` to `<home>/bench/` without overwriting files that already exist.
  - **`loadSamples(home?, only?: string[]): Promise<BenchSample[]>`** validates every sample, and throws `Unknown bench sample "<x>" (have: …)` for an unknown `--only` name.
  - The sample texts are tiny and obviously synthetic. Each spec has 2 to 4 acceptance checks.

- [ ] **Step 1: Write the failing tests.**
  - `'shipped manifest and specs validate'`
  - `'there are 4 samples covering both kits and one change job'`
  - `'init copies without overwriting edits'`
  - `'--only filters and rejects unknown names'`
- [ ] **Step 2:** Run `npx vitest run tests/bench/samples.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(bench): practice samples and bench --init`.

### Task 5: Bench runner

**Files:**
- Create: `src/bench/run.ts`, `src/cli/commands/bench.ts`
- Modify: `src/cli/index.ts`, `src/core/job.ts` (an internal helper that creates a job at `plan` from a pre-approved spec), `src/core/state.ts` (`bench?`)
- Test: `tests/bench/run.test.ts`, `tests/cli/bench.test.ts`

**Interfaces:**
- Consumes: `loadSamples`, `createNewProject`, `createChangeJob`, adopt and registry helpers, `runUnattended(project, deps)`, `estimateCost`, `readHistory`, `stopContainer`, the git helpers.
- Produces:
  - **Run id.** `runId` is `<ISO date without colons>-<4 hex>`.
  - **Estimate.** `estimateBench(samples, history): { lowUsd; highUsd }`:
    - For each sample, it uses the p25 and p75 of that sample's earlier bench results.
    - Otherwise it uses `estimateCost`.
    - Otherwise it uses the full budget for both ends.
    - The per-sample figures are added up.
  - **`runBench(samples, { runId, label?, deps }): Promise<BenchResult>`**, for each sample in order:
    1. Copy it into `<home>/bench/runs/<runId>/<sample>/`. A change sample copies `repo/`, runs `git init` and commits through `git.ts`, then adopts it.
    2. Create the job, register it as `bench-<sample>-<runId>`, write the pre-approved spec (`spec.approved.json` and `spec.md`), and set the state to `plan` with `budgetUsd` set to the sample's budget and `bench: runId`.
    3. Run `runUnattended` in the foreground.
    4. Record `{ sample, outcome: 'delivered'|'paused: <reason>'|'failed: <msg>', checks, firstTryPass, rounds, spentUsd, cacheHitRate }`, read back through the safe reads.
    5. Stop its container in `finally` and deregister the project.

    It never throws from a single sample. It writes `<home>/bench/results/<runId>.json`, which holds `{ runId, label?, configHash, at, results }`, with `configHash` = sha8 of `config.yaml`.
  - **CLI.** `anton bench [--only a,b] [--label <text>] [--yes]`:
    1. Load the samples. If they are missing, print `Run anton bench --init first.` and exit 1.
    2. Print each sample and the estimated range.
    3. Ask for confirmation, as in the Global Constraints. Without a terminal and without `--yes`, refuse and exit 1.
    4. Run the bench, then print the comparison (Task 6).

    `anton bench --init` calls `initBench`.

- [ ] **Step 1: Write the failing tests.** Use a fake `runUnattended` that moves the state to `awaiting_final_review` or `paused`, a fake exec and a temp home.
  - `'each sample becomes a bench job starting at plan with its pre-approved spec'`
  - `'change sample is a git repo adopted before the change job'`
  - `'a paused sample is recorded and the next still runs'`
  - `'a throwing sample is recorded as failed; containers stopped; projects deregistered'`
  - `'results file has runId, label, configHash and per-sample results'`
  - `'estimate uses earlier bench results, then history, then budget'`
  - `'no TTY without --yes refuses; --yes runs'`
  - `'answer other than y declines'`
  - `'bench never runs retro'`
  - `'real registry projects are untouched'`
- [ ] **Step 2:** Run `npx vitest run tests/bench tests/cli/bench.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite and `npx tsc --noEmit`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(bench): run practice samples unattended`.

### Task 6: Bench comparison

**Files:**
- Create: `src/bench/compare.ts`
- Modify: `src/cli/commands/bench.ts`
- Test: `tests/bench/compare.test.ts`

**Interfaces:**
- Produces:
  - **Comparison.** `compareBench(current, previous?): string`, markdown printed to the terminal and saved to `<home>/bench/results/<runId>.md`.
    - Without a previous run, it says `First bench run; nothing to compare.`
    - Otherwise its header has both run ids, their labels and their config hashes.
    - For each sample in both runs, it shows outcome, checks passing, first-try %, rounds, cost and cache %, the previous value next to each, with `▲`/`▼` marks.
    - A sample that went from delivered to not delivered, a drop of more than 20 points in first-try %, or cost up by more than 50% is marked `REGRESSION`.
    - Samples in only one run are listed as `new` or `removed`.
    - It ends with the totals of cost and delivered samples.
  - **Previous run.** The previous run is the newest results file older than the current one. `--compare <runId>` picks a specific one.

- [ ] **Step 1: Write the failing tests.**
  - `'first run says nothing to compare'`
  - `'side-by-side values with arrows'`
  - `'regressions are marked'`
  - `'new and removed samples are listed'`
  - `'--compare picks a specific run'`
  - `'header shows labels and config hashes'`
- [ ] **Step 2:** Run `npx vitest run tests/bench/compare.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(bench): compare with the previous bench run`.

### Task 7: Docs and end-to-end check

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `tests/e2e/bench.e2e.test.ts`. The free part runs under `ANTON_E2E` alone. The paid part also needs `ANTHROPIC_API_KEY`.

**Interfaces:**
- Produces:
  - **README "Scoreboard and bench" section.** It covers:
    - what `--stats` shows and the flag rule
    - that the numbers are noisy
    - the cache trend
    - `bench --init`, `bench`, `--only`, `--label`, `--compare` and `--yes`
    - the cost preview and confirmation
    - where results live
    - that bench jobs never touch your projects or estimates
    - how to measure Caveman or Ponytail. The steps:
      1. `anton bench --label baseline`
      2. Add the plugin under `roles:` for the builder roles.
      3. `anton bench --label caveman-on`
      4. Read the comparison.
      5. Keep the plugin or remove it.
  - **CLAUDE.md** gets one Commands line: `anton bench --only cli-wordcount` is the cheapest real end-to-end check.
  - **Free e2e:** `bench --init` into a temp home, then `loadSamples`, validates. A Docker-only run of the change-greeting sample's baseline (its repo's tests pass in the fallback image) proves the sample repo is sound.
  - **Paid e2e:** `anton bench --only cli-wordcount --yes` delivers, and the results file shows `delivered`. It is written but not run without a key.
- [ ] **Step 1:** Write the e2e tests and the docs.
- [ ] **Step 2:** Run `ANTON_E2E=1 npx vitest run tests/e2e`, the full suite, `npx tsc --noEmit` and `npm run build`. Expected: all pass; the paid tests are skipped.
- [ ] **Step 3:** Commit `feat: Phase 5b scoreboard and bench docs and e2e`.

## Not in this phase

- **Phase 6:** Slack (`anton serve`, posting bench results to `#anton`).
- **Running bench jobs in parallel.** They run one at a time, to keep costs and containers predictable.
