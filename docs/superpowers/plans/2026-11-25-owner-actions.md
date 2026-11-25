# Owner Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every Owner action (approve, reject, resume, abandon, accept risk, request spec changes, stop) is decided by one shared step in `src/core/job-actions.ts`, so the stale check, the decision lock, the re-check, the busy rule and the spawn claim live in one place.

**Architecture:** A private `decide()` in `job-actions.ts` runs a fixed sequence for an `OwnerAction` declaration. The exported functions (`approveJob`, `rejectJob`, …) keep their names and signatures and become short declarations, so CLI and Slack callers do not change. `stop` keeps its process-killing in the CLI and hands the pause to a new `interruptJob`. Slack's crash recovery calls a new exported `isCurrent`. The read-only status table moves to its own module.

**Tech Stack:** TypeScript ESM, Node (via nvm: run `. ~/.nvm/nvm.sh` first in every shell), vitest, zod, execa (git in tests).

**Spec:** The design decisions were settled in conversation (architecture review candidate #2, questions Q1–Q10). They are copied into **Decisions** below; that section is the spec. Domain terms: `CONTEXT.md` (Owner, Owner action, Checkpoint, Stale).

## Decisions

- **D1 (scope):** The six actions in `job-actions.ts` plus `stop` go behind `decide()`. `claimSpecRound` in `src/core/spec-continuation.ts` is out of scope (it belongs to a later spec-conversation refactor).
- **D2 (callers):** Exported names and signatures stay: `approveJob(target, d)`, `rejectJob(target, notes, d)`, `resumeJob(target, opts, d)`, `abandonJob(target, d)`, `acceptJobRisk(target, findingId, reason, d)`, `reopenSpec(target, d, claim)`, `withDecisionLock(project, body, lockWaitMs?)`, `loadJob`, `targetOf`, `checkpointRevision`, `reviewTarget`, `spawnClaimed`, `preflightOr2`, `refuseIfRunning`, `switchBackFromJob`. CLI and Slack callers change only where a task says so.
- **D3 (tests):** New tests call the action functions directly against real files and real git in a temp `ANTON_HOME`. Docker preflight, `spawnRun`, `stopContainer` and Retro stay faked via `JobActionDeps`. Git, state and registry are **not** made injectable.
- **D4 (drift):** All actions follow the same rules. User-visible messages stay word for word except where this plan says otherwise. `acceptJobRisk` gains the pre-lock stale check and reports a wrong stage or unknown finding by printing to `d.err` and returning `refused` (code 1) instead of throwing `ActionRefused`. The `as JobActionDeps` casts go away.
- **D5 (status):** `jobStatusRows`, `STATUS_HEADER`, `StatusRow` and the cache cell move to `src/core/job-status.ts`, with one shared table formatter used by `anton status` and Slack.
- **D6 (stop):** `stop` kills the run, clears the run lock and stops the container **before** the decision lock, exactly as today. Then, under the lock, it pauses the job as `interrupted` only if the job is still the same job (jobId) in an active stage. It does not check stage equality against the target. The Slack `paused` milestone is published after release.
- **D7 (Slack recovery):** Export `isCurrent(target, listTags?)`. `stillPending` in `src/slack/actions.ts` uses it for job operations instead of its own job/stage/revision comparison.
- **D8 (busy rule):** Any action that starts a background run (approve at spec approval, reject, resume) refuses when a live run holds the project's run lock **or** a spawn claim is live. The rule runs before and under the lock. Each action keeps its own wording.
- **D9:** `CONTEXT.md` (already written) is committed on this branch.
- **D10 (delivery):** Branch `feat/owner-actions` from an up-to-date `main`; one PR.

## Global Constraints

- House rules from `CLAUDE.md` apply: state and evidence writes via `writeFileAtomic`; host git only through `src/core/git.ts`; unit tests never touch real Docker or the API.
- Conventional Commits, subject under 72 characters, one logical change per commit, tests passing at each commit. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Never `--no-verify`, never force-push. Test fixtures contain no real-looking secrets.
- Every task ends with `npx tsc --noEmit` clean and `npm test` green.
- Use the words from `CONTEXT.md` in new comments and names: "Owner action", "Checkpoint", "stale". Avoid "job action" and "decision" for the concept (the existing `decision.lock` file name stays).

## Review Focus

1. **Stop races a Slack approve:** the job is replaced (new jobId) while `stop` is killing the run. Expected: no pause is written to the new job. Test in Task 3.
2. **Approve at spec approval while a spawn claim is live** (a second click a moment after the first). Expected: refused, no second `spawnRun`. Test in Task 2.
3. **Accept risk from Slack on a moved job:** wrong stage, stale revision or unknown finding. Expected: `refused`/`stale` outcome with the existing message text, never a thrown error. Test in Task 2.
4. **Another Owner action holds the decision lock:** every action (including stop's pause) fails with `Another decision on <project> is in progress. Try again in a moment.` and changes nothing. Test in Task 2 (approve) and Task 3 (stop).
5. **Existing CLI and Slack wording:** messages printed by the CLI and Slack keep their exact text. Guarded by the existing `tests/cli/cli.test.ts`, `tests/cli/action-concurrency.test.ts` and `tests/slack/*.test.ts` passing unchanged (only the accept-risk assertions may change, per D4).

---

### Task 0: Branch

- [ ] **Step 1:** `git switch main && git pull && git switch -c feat/owner-actions`
- [ ] **Step 2:** Commit `CONTEXT.md` alone: `docs: add CONTEXT.md glossary for Owner actions`.

### Task 1: Move the status table to `core/job-status.ts`

**Files:**
- Create: `src/core/job-status.ts`
- Modify: `src/core/job-actions.ts` (remove `StatusRow`, `STATUS_HEADER`, `cacheCell`, `statusRow`, `jobStatusRows`, and imports only they used), `src/cli/commands/status.ts`, `src/slack/chat.ts` (`statusLines`, ~line 113)
- Test: `tests/core/job-status.test.ts`

**Interfaces:**
- Produces: `src/core/job-status.ts` exports `StatusRow`, `STATUS_HEADER`, `jobStatusRows(project?: string): Promise<StatusRow[]>` (moved unchanged) and `formatStatusTable(rows: StatusRow[]): string[]`, which prepends `STATUS_HEADER` and pads every column except the last to its widest cell, joined by two spaces.

- [ ] **Step 1: Write the failing test**

```ts
it('formatStatusTable pads all but the last column and adds the header', () => {
  const lines = formatStatusTable([['p', 'plan', '0', '$0.00 / $10.00', '-', 'cache 5%']]);
  expect(lines).toHaveLength(2);
  expect(lines[0]!.startsWith('PROJECT  STAGE')).toBe(true);
  expect(lines[1]).toBe('p        plan   0      $0.00 / $10.00  -             cache 5%');
  expect(lines.every((l) => !l.endsWith(' '))).toBe(true);
});
```

- [ ] **Step 2:** `npx vitest run tests/core/job-status.test.ts`. Expected: FAIL (module not found).
- [ ] **Step 3:** Create the module and move the code. `status.ts` prints `formatStatusTable(await jobStatusRows(project))`. `statusLines` keeps its `['No projects yet.']` early return, then returns `formatStatusTable(rows)`.
- [ ] **Step 4:** The new test, `tests/cli/cli.test.ts` and `tests/slack/chat.test.ts` pass; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `refactor: move the status table out of job actions`.

### Task 2: One `decide()` for the six Owner actions

**Files:**
- Modify: `src/core/job-actions.ts`
- Delete: `src/cli/commands/shared.ts`; point `src/cli/commands/{new,change,bench}.ts` at `../../core/job-actions.js`
- Test: `tests/core/job-actions.test.ts` (new)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces (exported, used by Tasks 3 and 4):
  - `isCurrent(target: ActionTarget, listTags?: (repo: string, pattern: string) => Promise<string[]>): Promise<boolean>`: loads the job and returns true when jobId and stage match and, if `target.revision` is set, `checkpointRevision` equals it.
  - `underDecisionLock` takes `lockWaitMs?: number` instead of a whole `JobActionDeps`. `withDecisionLock` and `reopenSpec` drop their casts.
- Internal (not exported), the shape `decide()` runs:

```ts
type OwnerAction<R> = {
  /** Prefix for "<nothing> (stage: x)" refusals and stale messages, e.g. 'Nothing to approve'. */
  nothing: string;
  allowBench?: boolean;
  /** Compare stage with the target (default true). */
  matchStage?: boolean;
  /** D8 busy rule + Docker preflight before the lock + spawn claim with the state write. */
  startsRun?: { busyMessage?: (pid: number | undefined) => string };
  /** Runs before the lock and again under it. Prints its own refusal via d.err; returns false to refuse. */
  check?: (job: LoadedJob) => Promise<boolean>;
  /** Under the lock, after the re-check: local writes only. Returns the new state (saved by decide) and a result, or undefined to refuse. */
  apply: (job: LoadedJob) => Promise<{ state?: JobState; result: R } | undefined>;
  /** After release: spawn, stop container, Retro, messages. Optional (reopenSpec has none). */
  after?: (job: LoadedJob, result: R) => Promise<void>;
};
async function decide<R>(target: ActionTarget, action: OwnerAction<R>, d: JobActionDeps): Promise<ActionOutcome>;
```

  `decide()` order: load → stale check (print `staleMessage`, return `stale`) → `check` → if `startsRun`: busy rule, then `preflightOr2` (code 2 → `refused(2)`) → decision lock → stale check → `check` → busy rule → `apply` → if `startsRun` write spawn claim → `saveState` if `state` returned → release → `after` → `done`.
- Mapping (keep each action's existing messages):
  - `approveJob`: pick a declaration by `target.stage`. Spec approval: `startsRun` (default busy message), `check` = `assertOnJobBranch`, `apply` = spec read + commit + tag + `transition(…, 'plan')`, `after` = `spawnRun` + the two messages. Final review: `apply` = `transition(…, 'done')`, `after` = message + `switchBackFromJob` + Retro (keep the `try/finally`). Any other stage: the stale check runs first; then refuse with `Nothing to approve (stage: x)`.
  - `rejectJob`: `check` = stage is `awaiting_final_review`; `startsRun` with the existing "previous run … still finishing" message.
  - `resumeJob`: `startsRun` (default message; spawn-claim message stays `… is starting in the background. Check it with: anton status <p>`); `apply` calls the existing `planResume`. Drop the run-lock and spawn-claim checks from `planResume`, because the busy rule now owns them.
  - `abandonJob`: `check` = `refuseIfRunning`; `after` = `stopContainer`, message, `switchBackFromJob`, Retro.
  - `acceptJobRisk`: `allowBench: true`, `matchStage: false`; `check` = stage is `paused` or `awaiting_final_review`, else print the existing "Can't accept a risk now …" text; revision compared only when `target.revision` is set (as today); `apply` prints `Unknown security finding <id>` and refuses when not found. Delete `ActionRefused`.
  - `reopenSpec`: keeps its exported signature; built on `decide()` with `check` = stage is `awaiting_spec_approval` and `apply` = branch assert + `claim(job)` + `transition(…, 'spec')`. Return `{ outcome, claimed, job }` as today.

- [ ] **Step 1: Write the failing tests** in `tests/core/job-actions.test.ts`. Use a temp `ANTON_HOME`, `registerProject`, a job dir with `saveState`, and `git init` in the repo where approve needs it, as in the `project()` helper at the top of `tests/cli/cli.test.ts`. Use a deps fake recording `out`, `err` and `spawnRun` calls. Tests:
  - `stale jobId changes nothing`: target jobId `'0-old'` → `{ code: 1, status: 'stale' }`; err contains `is no longer the current job`; state file unchanged.
  - `stale revision`: paused job, target revision `'paused-0'` while state `pauses: 1` → `stale`; err contains `this review is out of date`.
  - `approve at spec approval refuses while a spawn claim is live` (Review Focus 2): write `.anton/spawn-claim.json` `{ jobId, pid: process.pid, at: Date.now() }` → `refused`, `spawnRun` not called, stage still `awaiting_spec_approval`.
  - `approve at spec approval refuses while a run holds the lock`: take the run lock with `acquireLock(repo)` from `src/core/lock.ts` → `refused`, err contains `is already running`.
  - `accept risk at the wrong stage is refused, not thrown` (Review Focus 3): stage `plan` → resolves `{ code: 1, status: 'refused' }`; err contains `Can't accept a risk now (stage: plan)`.
  - `accept risk with an unknown finding is refused`: paused, no results.json → `refused`; err contains `Unknown security finding SEC-0000`.
  - `a held decision lock fails with the in-progress message` (Review Focus 4): hold `.anton/decision.lock` with `waitForLockFile`, call `approveJob` with `lockWaitMs: 50` → rejects with `Another decision on p is in progress. Try again in a moment.`
  - `isCurrent`: true for the matching target; false after the stage changes; false for a wrong revision.
- [ ] **Step 2:** `npx vitest run tests/core/job-actions.test.ts`. Expected: FAIL on the spawn-claim, accept-risk and `isCurrent` tests (the stale and lock tests may already pass; they pin existing behaviour).
- [ ] **Step 3:** Implement `decide()` and convert the six actions as mapped above; delete `shared.ts` and `ActionRefused`.
- [ ] **Step 4:** New tests pass. Full `npm test` passes. Only the accept-risk assertions in `tests/cli/cli.test.ts` (~line 700) may need updating, and only if they asserted a throw. `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `refactor: decide every Owner action through one shared step`.

### Task 3: `stop` pauses through the shared step

**Files:**
- Modify: `src/core/job-actions.ts`, `src/cli/commands/stop.ts`
- Test: `tests/core/job-actions.test.ts`, existing `tests/cli/cli.test.ts` "anton stop" blocks (~lines 357–450) must pass unchanged

**Interfaces:**
- Consumes: `decide()`, `OwnerAction` from Task 2.
- Produces: `interruptJob(target: ActionTarget, d: Pick<JobActionDeps, 'out' | 'err' | 'lockWaitMs'>): Promise<ActionOutcome>`, an `OwnerAction` with `matchStage: false` and no `allowBench` (stop already refuses bench jobs via `resolveManualJob`). Under the lock: active stage → save `pause(state, 'interrupted')`; otherwise no write. `after`: when paused, `publishJobMilestone(paused, { kind: 'paused', occurrence: \`paused-${paused.pauses ?? 0}\`, reason: 'interrupted' })` and print `<p>: paused (interrupted) at <stage>. Continue with: anton resume <p>`; otherwise print `<p>: stopped (stage: <stage>).`

- [ ] **Step 1: Write the failing tests:**
  - `interruptJob pauses an active job`: stage `build` → `done`; state stage `paused`, `pauseReason: 'interrupted'`, `pauses` incremented.
  - `interruptJob leaves a replaced job alone` (Review Focus 1): target jobId `'1-init'`, but a newer job dir `2-next` is current → `stale`; `2-next` state unchanged.
  - `interruptJob on a finished job only reports`: stage `done` → `done`; out contains `stopped (stage: done)`; state unchanged.
  - `interruptJob with the decision lock held` (Review Focus 4): rejects with the in-progress message; state unchanged.
- [ ] **Step 2:** Run them. Expected: FAIL (`interruptJob` not exported).
- [ ] **Step 3:** Implement `interruptJob`. In `stopCommand`, keep everything up to and including `stopContainer` as is, then `return (await interruptJob({ project, jobId: job.jobId, stage: job.state.stage }, d)).code`. That gives exit 1 for `stale`, and 0 for paused and stopped as today.
- [ ] **Step 4:** New tests and all `anton stop` tests in `tests/cli/cli.test.ts` pass; `npm test` green; `npx tsc --noEmit` clean.
- [ ] **Step 5:** Commit `fix(stop): pause the job under the decision lock`.

### Task 4: Slack recovery uses `isCurrent`

**Files:**
- Modify: `src/slack/actions.ts` (`stillPending`, ~line 552; drop `checkpointRevision`/`loadJob` imports if unused)
- Test: `tests/slack/actions.test.ts` (or wherever `stillPending` behaviour is covered; find it with `grep -rn "previous" tests/slack`)

**Interfaces:**
- Consumes: `isCurrent(target, listTags?)` from Task 2.

- [ ] **Step 1:** Confirm an existing test covers a crashed claim being re-run when the job is still at its stage and dropped when it moved. If none exists, add `a crashed approve claim is re-run only while its target is current` covering both cases.
- [ ] **Step 2:** Replace the job/stage/revision lines in `stillPending` with `return await isCurrent(op.target, deps.jobs.listTags);`. Keep the `lesson`, `accept-risk`, `start`, `spec-retry`, `spec-answer` branches and the `catch` unchanged.
- [ ] **Step 3:** `npx vitest run tests/slack` green; `npm test` green; `npx tsc --noEmit` clean.
- [ ] **Step 4:** Commit `refactor(slack): reuse isCurrent for crashed claim recovery`.

### Task 5: Finish

- [ ] **Step 1:** `npm test` and `npx tsc --noEmit` on the branch tip; record counts.
- [ ] **Step 2:** In `docs/superpowers/plans/2026-11-24-phase-6b-followups.md`, under "Code health", note that the status-table duplication is resolved. Under "Locks", note that `stop` now pauses under the decision lock (`removeLockIfHeldBy` without the mutex is still open; it belongs to the Holder refactor). Commit `docs: note Owner action follow-ups resolved`.
- [ ] **Step 3:** Run the secret scan (gitleaks, with `set -o pipefail`) before pushing. Push only when the user asks.
