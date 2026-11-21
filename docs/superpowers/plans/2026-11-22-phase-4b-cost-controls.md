# Phase 4b: Cost Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make each job's cost predictable and visible. This phase adds a cache-friendly prompt layout with cache-hit tracking, stage allowances with borrowing, task budgets so agents pace themselves, and a cost estimate at checkpoint 1 built from past jobs. It also fixes the Phase 4a "Do first" code items.

**Architecture:**
- **Usage reporting.** The entry reports token usage, including cache reads and writes, on every terminal event. The host records it per stage in `usage.json`, and `status` and `REPORT.md` show the cache hit rate.
- **Stage allowances.**
  - `runAgent` caps every session at the smaller of two amounts: what remains of the job cap, and what remains of the stage's allowance.
  - It passes that cap to the SDK as `maxBudgetUsd` and as a matching `taskBudget` token figure.
  - The runner pauses with a new reason, `allowance`, when a stage's share runs out.
- **Cost estimate.** At deliver, every finished job appends one line to `~/anton/history.jsonl`. The spec session reads that file to print an expected cost range in `spec.md`.

**Tech Stack:** TypeScript ESM, vitest, zod, Claude Agent SDK 0.3.328. It uses the `systemPrompt` preset with `excludeDynamicSections` and `snapshot`, the `taskBudget` option, and `result.modelUsage`.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` §7.1, under "Prompt caching" and "Budgets with visibility", and §7 Budgets. Phase 4a follow-ups: `docs/superpowers/plans/2026-11-22-phase-4a-followups.md` ("Do first").

## Global Constraints

- §7.1 guiding rule: "the quality bar is fixed and cost is minimised within it." Savings never come from skipping verification.
- §7.1 caching: "Each stage's prompt is laid out with stable content first and changing content last. … Nothing changing, like timestamps or run IDs, goes into the stable part." "The scoreboard tracks the cache hit rate". The scoreboard is Phase 5. In 4b the hit rate appears in `usage.json`, `anton status` and `REPORT.md`.
  - Cache hit rate is `cacheRead / (input + cacheRead + cacheWrite)`.
- §7.1 allowances: "The job cap (default $10) is split into stage allowances: Spec 10%, Plan 10%, Build 50%, Verify 25%, Retro 5%. An allowance can borrow what's left of earlier allowances. When a stage runs out of its share, the factory pauses before the whole cap is gone."
  - The order is spec, plan, build, verify, retro.
  - Runner stages map to groups through 4a's `STAGE_GROUP`: `baseline` counts as `plan`, `deliver` as `verify`.
  - **Plan decision: the spec allowance only warns.** Spec is attended: you are at the keyboard in the spec session. Going over its share prints one warning and the session carries on up to the job cap. The overspend then shrinks what later stages can borrow.
- §7.1 estimate: "the spec shows an expected cost range for the job, based on past jobs of similar size and kit … It shows 'no history yet' until enough jobs have run."
  - **Plan decision for "similar":** same kit and same kind (`new` or `change`), with an acceptance-check count within ±50% of this spec's. Enough means at least 3 jobs. The range is p25 to p75 of their total cost.
- §7.1: "You get a warning at 80% of the cap. Cost so far is visible at any time in `anton status`." This already exists; keep it.
- §7.1 task budgets: "Agent loops are given a token budget so they pace themselves instead of being cut off mid-task."
  - **Plan decision:** `taskBudget.total = min(5_000_000, floor(sessionCapUsd * 1e6 / inPerM))`, where `inPerM` is the model's input price from `src/agent/pricing.ts`.
  - The budget follows the same dollar cap the SDK already enforces, so it guides pacing without cutting anything earlier.
  - `budget.taskBudgets: false` in config.yaml turns it off.
- `config.yaml` gains:
  - `budget: { defaultUsd?: number > 0, allowances?: { spec, plan, build, verify, retro } }`. The allowances are whole percentages that must sum to 100.
  - `taskBudgets?: boolean`, default true.
- Existing rules from CLAUDE.md apply:
  - Effects go through `deps`.
  - Saves go through `writeFileAtomic` and `redact()`.
  - Host files under `.anton/jobs/<id>/` are read with `readRegularFile`, after `assertJobDir`.
  - zod is the source of truth.
  - A stale image fails closed. The protocol version bumps, so the image is rebuilt.

## Review Focus

1. **A job started before 4b, whose state has no `stageSpentUsd`, is resumed.** Expected: the per-group spend is seeded once from `cost.json`. The job is not paused wrongly, and it doesn't get a fresh allowance either. (Task 2)
2. **Fix rounds alternate build and verify.** Expected: verify spend never uses up build's share. In round 2, build may spend up to 70% of the cap minus what spec, plan and build have already spent. (Task 2)
3. **A job paused with `allowance` is resumed with `--budget <higher>`.** Expected: every allowance grows with the new cap, and the job continues. Plain `resume` without `--budget` refuses with a hint. (Task 2)
4. **The spec session goes over its 10%.** Expected: one warning line, the session continues, and it stops only at the job cap. (Task 2)
5. **`history.jsonl` has fewer than 3 similar jobs, or contains a corrupt line.** Expected: `Expected cost: no history yet`. Corrupt lines are skipped, and a missing file is fine. The line never breaks `readApprovedSpec`. (Task 5)

---

### Task 1: Phase 4a "Do first" fixes and the budget config

**Files:**
- Modify: `src/stages/deliver.ts` (the `cost.json` read), `src/pipeline/runner.ts` (`writeRunRecord`), `src/core/anton-config.ts`, `src/core/job.ts` (default budget)
- Test: `tests/stages/deliver.test.ts`, `tests/pipeline/runner.test.ts`, `tests/core/anton-config.test.ts`

**Interfaces:**
- Produces:
  - **`cost.json` read.** Deliver reads `cost.json` with `readRegularFile` after `assertJobDir`. A symlink is refused, and the cost section then says `cost.json was refused (not a regular file).`
  - **Bad run record.** When `run-record.json` holds JSON that isn't an object, `writeRunRecord` throws `run-record.json is not a JSON object — fix or delete it`.
  - **Config schema.** `AntonConfigSchema` gains `budget?: { defaultUsd?: number; allowances?: Record<'spec'|'plan'|'build'|'verify'|'retro', number>; taskBudgets?: boolean }`.
    - Allowances are whole numbers from 0 to 100, all five keys are required when `allowances` is given, and they must sum to 100. Otherwise it throws `budget.allowances must add up to 100`.
  - **Constants and helpers.**
    - `DEFAULT_ALLOWANCES = { spec: 10, plan: 10, build: 50, verify: 25, retro: 5 }` and `ALLOWANCE_ORDER = ['spec','plan','build','verify','retro'] as const` live in `src/core/anton-config.ts`.
    - `budgetSettings(cfg): { defaultUsd: number; allowances: typeof DEFAULT_ALLOWANCES; taskBudgets: boolean }` fills in the defaults: $10, `DEFAULT_ALLOWANCES` and `true`.
  - **New jobs.** `createNewProject` and `createChangeJob` take their default budget from `budgetSettings(await loadAntonConfig()).defaultUsd` when `--budget` isn't given.

- [ ] **Step 1: Write the failing tests.**
  - `'symlinked cost.json is refused in the report'`
  - `'non-object run-record.json gives a clear error'`
  - `'allowances must add up to 100'`
  - `'allowances need all five stages'`
  - `'budgetSettings fills defaults'`
  - `'config defaultUsd sets a new job budget'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/deliver.test.ts tests/pipeline/runner.test.ts tests/core/anton-config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(budget): budget config; close Phase 4a follow-ups`.

### Task 2: Stage allowances with borrowing

**Files:**
- Modify:
  - `src/core/state.ts`: `stageSpentUsd`, and the pause reason `allowance`
  - `src/core/budget.ts`
  - `src/agent/host-runner.ts`
  - `src/pipeline/runner.ts`: the pause message
  - `src/cli/commands/resume.ts`
  - `src/cli/commands/status.ts`
  - `src/cli/spec-session.ts`: warn-only
- Test: `tests/core/budget.test.ts`, `tests/agent/host-runner.test.ts`, `tests/pipeline/runner.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `STAGE_GROUP`, `budgetSettings`, `ALLOWANCE_ORDER`.
- Produces:
  - **State.**
    - `JobStateSchema` gains `stageSpentUsd: z.record(z.string(), z.number().min(0)).optional()`. Its keys are allowance groups.
    - `PAUSE_REASONS` gains `'allowance'`.
  - **Spend tracking.** `recordCost(s, stage, usd)` adds `usd` to `stageSpentUsd[STAGE_GROUP[stage] ?? stage]`. Its return value gains `overAllowance: boolean`.
  - **Allowance math.** `allowanceLeftUsd(s, group, allowances): number` is `budgetUsd * cumulative%(group) / 100 - Σ stageSpentUsd[g]` over every group `g` that comes up to and including `group` in `ALLOWANCE_ORDER`, floored at 0.
  - **Old jobs.** `seedStageSpend(s, costJson): JobState` fills `stageSpentUsd` from `cost.json` (stage keys mapped to groups) when it is absent. The runner and resume call it after `loadState`.
  - **`runAgent`.**
    - For a stage whose group is not `spec`: when `allowanceLeftUsd <= 0` it throws `AllowanceExceeded(group, spentUsd, limitUsd)`, a subclass of `BudgetExceeded`.
    - Otherwise it clamps `req.budgetUsd` to `min(req.budgetUsd, remainingUsd, allowanceLeftUsd)`.
    - Mid-call, when `overAllowance` is true it kills the session the same way as `overCap`.
  - **Spec session.** When the spec group's allowance is used up, the spec session prints `Spec has used its ${pct}% share (${usd}); continuing up to the job cap.` once per session, then keeps going.
  - **Runner.**
    - An `AllowanceExceeded` pauses the job with `allowance`.
    - The notification and printed message is `${project}: paused, ${group} allowance used (${spent} of ${limit}). Resume with: anton resume ${project} --budget <usd>`.
  - **`resume`.** With reason `allowance` and no `--budget`, it refuses with the same hint and exits 1. A new `--budget` raises the cap, so every allowance grows.
  - **`status`.** The budget column becomes `$spent / $cap`. A paused job also shows its reason, which can now be `allowance`.

- [ ] **Step 1: Write the failing tests.**
  - `'allowance borrows unused earlier shares'`: plan spent $0.20, build's limit is $7.00 - (spec + plan + build spend)
  - `'verify spend does not count against build'`
  - `'build round 2 limit after a verify round'`
  - `'session budget is clamped to the allowance'`
  - `'allowance used up throws AllowanceExceeded before spawning'`
  - `'mid-call allowance overrun kills the session'`
  - `'runner pauses with allowance and the hint'`
  - `'resume without --budget on allowance refuses'`
  - `'resume --budget raises every allowance'`
  - `'old state without stageSpentUsd is seeded from cost.json'`
  - `'spec over its share warns once and continues'`
- [ ] **Step 2:** Run `npx vitest run tests/core/budget.test.ts tests/agent tests/pipeline tests/cli`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(budget): stage allowances with borrowing`.

### Task 3: Cache-friendly prompts and usage tracking

**Files:**
- Modify: `src/agent/protocol.ts` (`PROTOCOL_VERSION = 4`), `src/agent/entry.ts`, `src/agent/host-runner.ts`, `src/core/budget.ts` (`appendStageUsage`), `src/cli/commands/status.ts`, `src/stages/deliver.ts`
- Test: `tests/agent/entry.test.ts`, `tests/agent/host-runner.test.ts`, `tests/agent/prompt-stability.test.ts` (new), `tests/stages/deliver.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Produces:
  - **Protocol.**
    - `TokenTotals = { input: number; output: number; cacheRead: number; cacheWrite: number }`.
    - The `result` and `error` events gain an optional `usage: TokenTotals`. The entry sums every `result.modelUsage` entry into it: `inputTokens`, `outputTokens`, `cacheReadInputTokens`, `cacheCreationInputTokens`.
    - The request gains an optional `taskBudgetTokens: number`. The entry maps it to `taskBudget: { total }`. Task 4 sets the value.
  - **Entry.**
    - Preset sessions use `{ type: 'preset', preset: 'claude_code', append, excludeDynamicSections: true, snapshot: true }`.
    - Custom-prompt sessions use `{ type: 'custom', prompt, snapshot: true }`.
  - **Host.** `appendStageUsage(jobDir, stage, totals)` adds the totals into `<jobDir>/usage.json`, keyed by stage, written atomically. `runAgent` calls it once per call, from the terminal event.
  - **Hit rate.**
    - `cacheHitRate(t): number | undefined` is `cacheRead / (input + cacheRead + cacheWrite)`. It is undefined when the denominator is 0.
    - `status` shows `cache 62%`, or `-` when there is no data.
    - The `REPORT.md` "Cost and time by stage" table gains a `Cache hit` column.
  - **Prompt stability test.**
    - For every stage that builds a request (spec, plan, repo-map, build per area, code review, security review, browser tester, plugin review), build the request twice with different rounds and clock times, using fakes.
    - Assert that `systemPrompt` is byte-identical.
    - Assert that it doesn't match `/\d{4}-\d{2}-\d{2}T/` or `/round \d/`.
    - The jobId may appear only on the final line.

- [ ] **Step 1: Write the failing tests.**
  - `'entry sums modelUsage into usage'`
  - `'preset sessions exclude dynamic sections and snapshot'`
  - `'custom prompt sessions snapshot'`
  - `'usage.json accumulates per stage'`
  - `'cache hit rate formula and empty case'`
  - `'status shows cache rate'`
  - `'report has a Cache hit column'`
  - `'system prompts are stable across rounds and time'`
- [ ] **Step 2:** Run `npx vitest run tests/agent tests/stages/deliver.test.ts tests/cli`. Expected: FAIL.
- [ ] **Step 3:** Implement. Move anything changing out of system prompts into the user prompt if the stability test finds any.
- [ ] **Step 4:** Run `npm run build:image`, `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`, then the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cost): cache-friendly prompts and cache-hit tracking`.

### Task 4: Task budgets

**Files:**
- Modify: `src/agent/host-runner.ts`, `src/agent/pricing.ts` (`inputPricePerToken`)
- Test: `tests/agent/host-runner.test.ts`

**Interfaces:**
- Consumes: `budgetSettings(cfg).taskBudgets`, `priceFor(model)`, and the clamped `req.budgetUsd` from Task 2.
- Produces: `taskBudgetTokens(model, capUsd): number = Math.min(5_000_000, Math.floor(capUsd * 1e6 / priceFor(model).inPerM))`. `runAgent` sets `req.taskBudgetTokens` from it after clamping, unless `taskBudgets` is false.

- [ ] **Step 1: Write the failing tests.**
  - `'task budget follows the clamped dollar cap'`: a sonnet session with a $3 cap gives 1_500_000
  - `'task budget is capped at 5M'`
  - `'taskBudgets: false sends no task budget'`
- [ ] **Step 2:** Run `npx vitest run tests/agent/host-runner.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cost): task budgets from the session cap`.

### Task 5: Job history and the estimate at checkpoint 1

**Files:**
- Create: `src/core/history.ts`
- Modify: `src/stages/deliver.ts` (append), `src/stages/spec.ts` (`renderSpec` line; `readApprovedSpec` ignores it), `src/cli/spec-session.ts`
- Test: `tests/core/history.test.ts`, `tests/stages/spec.test.ts`, `tests/stages/deliver.test.ts`

**Interfaces:**
- Produces:
  - **History entries.** `HistoryEntry = { jobId, project, kind: 'new'|'change', kit: 'fallback'|'web', checks: number, spentUsd: number, stageUsd: Record<string, number>, cacheHitRate?: number, at: string }`.
    - Only numbers, ids, the project name and the kit are stored. No descriptions and no secrets.
  - **Writing.** `appendHistory(entry, home?)` appends one JSON line to `<home>/history.jsonl`. It is called once when deliver finishes. `at` is an ISO date.
  - **Reading.**
    - `readHistory(home?): Promise<HistoryEntry[]>` skips lines that fail to parse.
    - A missing file gives `[]`.
  - **Estimate.** `estimateCost(history, { kind, kit, checks }): { lowUsd: number; highUsd: number; n: number } | undefined`.
    - It considers jobs with the same kind and kit whose `checks` are within ±50% of this spec's.
    - It returns `undefined` when there are fewer than 3.
    - `lowUsd` is p25 and `highUsd` is p75 of `spentUsd`, using linear interpolation.
  - **`spec.md` line.** `renderSpec` adds a line under the `Kit:` line:
    - `Expected cost: $1.20–$3.40 (from 5 similar past jobs)` when there is an estimate
    - `Expected cost: no history yet` when there isn't

    `readApprovedSpec` ignores this line. The `Kit:` header parse still stops at the first `## `.

- [ ] **Step 1: Write the failing tests.**
  - `'deliver appends one history line without the description'`
  - `'corrupt history lines are skipped'`
  - `'fewer than 3 similar jobs: no estimate'`
  - `'estimate uses same kind, kit and ±50% checks'`
  - `'p25–p75 range'`
  - `'spec.md shows the estimate line'`
  - `'spec.md shows no history yet'`
  - `'readApprovedSpec ignores the estimate line'`
- [ ] **Step 2:** Run `npx vitest run tests/core/history.test.ts tests/stages`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cost): job history and cost estimate at checkpoint 1`.

### Task 6: Docs and end-to-end check

**Files:**
- Modify: `README.md` ("Budgets" section), `CLAUDE.md`
- Test: `tests/e2e/docker.e2e.test.ts`

**Interfaces:**
- Produces:
  - The README "Budgets" section covers:
    - the 10/10/50/25/5 split, with a borrowing example
    - the `allowance` pause and `resume --budget`
    - the spec warning
    - the `budget:` keys in `config.yaml`
    - task budgets and how to turn them off
    - the cache hit rate in `status` and `REPORT.md`
    - the checkpoint-1 estimate and "no history yet"
    - `history.jsonl`, and what it stores
  - CLAUDE.md gets one Rules line: system prompts hold only stable text. Changing values go in the user prompt, and the prompt-stability test enforces this.
  - Docker e2e: one real entry run with a fake SDK isn't possible in Docker. Instead, assert that the rebuilt image's entry echoes `protocolVersion: 4` on an invalid request.
- [ ] **Step 1:** Write the e2e assertion and update the docs.
- [ ] **Step 2:** Run `npm run build:image`, `ANTON_E2E=1 npx vitest run tests/e2e`, the full suite, `npx tsc --noEmit` and `npm run build`. Expected: all pass; the paid tests are skipped.
- [ ] **Step 3:** Commit `feat: Phase 4b cost docs and e2e`.

## Not in this phase

- **Phase 5:**
  - the scoreboard, which will read `history.jsonl` and `usage.json`
  - Retro, which uses its 5% share
  - waste-finding lessons
  - `anton bench` and its cost preview
  - measuring Caveman and Ponytail
- **Batch API for Retro:** Phase 5.
