# Phase 4b: rulings and deferred follow-ups

This file lists the decisions made while building Phase 4b (cost controls) and the minor findings left for later phases.

## Do first

- **Prove the SDK options live.** The paid e2e (`npm run test:e2e`, about $3) has never run. It is the only check that the SDK accepts `snapshot` and `excludeDynamicSections`, and accepts `taskBudget` (its beta header and its 20k minimum). It is also the only check that cache hits are real.
- **Failed report-only writes are silent in unattended stages.** In plan through deliver, `ctx.warn` is unset, so a failed `cost.json` or `usage.json` write leaves no trace. `state.json`, the caps and the pauses stay correct. Fix: also append the warning to `logs/<stage>.log`.
- **Add an integration-style test that walks a $10 job through the runner.** The path is plan, then build, verify, build, verify. Assert `stageSpentUsd`, the pause reason, the hint, then `resume --budget`, then the history line. Each link is unit-tested on its own today, so bugs between links are not caught.

## Rulings

- **Plan decisions** (in the plan, reviewed by you before building):
  - The spec allowance only warns.
  - "Similar" means same kit and kind, with an acceptance-check count within ±50%, and at least 3 jobs. The range is p25 to p75.
  - The task budget is the session's dollar cap divided by the model's input price, capped at 5M.
- **P4b-R1:** allowances apply only to job stages listed in `STAGE_GROUP`, looked up with `Object.hasOwn`. Other sessions, such as the plugin-update review, are limited by their own cap only. Cost if wrong: none.
- **P4b-R2:** spec overspend counts against the job cap only. For later stages, spec's spend counts at most up to its own share. Without this, a spec that went past 20% would pause plan the moment you approved. Cost if wrong: later stages may spend that overspend before pausing, but the job cap still holds.
- **P4b-R3:** `history.jsonl` is written with O_APPEND, not `writeFileAtomic`. It is one small line, and a read-modify-write would race between concurrent jobs. A leading newline guards against a line half-written by a crash. Cost if wrong: one bad line, which the reader skips.
- **Final review:** one fix wave covered the following. Cost if wrong: a slightly larger fix diff.
  - history deduped by project and job
  - `cost.json` written atomically, without following links
  - no task budget under 20k tokens
  - state saved before the report-only writes
  - usage counted once on resumed sessions
  - history cost taken from job state
  - `defaultUsd` must be positive
  - `cost.json` cleaned in deliver
  - allowance messages name the cumulative share
  - README notes: the 95% pause and the task-budget wording

## Deferred minor findings

- Task 1:
  - A config error hides "project not found" in `createChangeJob`.
  - The "all five stages" test asserts only the message prefix.
  - There is no `createChangeJob` defaultUsd test.
  - Two `budgetUsd: budgetUsd` shorthands remain.
- Task 2:
  - The `allowanceBound` tie uses `<`, not `<=`.
  - `resume --budget` doesn't check that the new cap actually helps.
  - The unmapped `pausedFrom` case is unreachable.
  - `loadAntonConfig` isn't injected through deps.
  - Hint numbers come from the current config.
- Task 3:
  - No test checks that a stale-protocol event writes no usage.
  - REPORT rows come only from `cost.json` keys.
  - Status shows the word cache twice: `CACHE` / `cache 62%`.
- Task 4:
  - The config is loaded in every session, so a broken config also fails `plugins update`.
  - The false-case test passes even before the change.
  - One `describe` is nested.
  - One import is duplicated.
- Task 5:
  - The estimate shown with the auto-selected kit and checks goes stale if you edit them at approval.
  - The `CostEstimate` type is duplicated.
  - Imports are out of order.
  - There is no checks=0 test and no CLI estimate test.
- Fix wave:
  - An empty `cost.json` shows the "refused" note.
  - `appendStageCost` and `appendStageUsage` rely on their callers to call `assertJobDir`.

## Not verified

- Live caching, `snapshot`, `excludeDynamicSections` and `taskBudget` behaviour, because no `ANTHROPIC_API_KEY` is set.
