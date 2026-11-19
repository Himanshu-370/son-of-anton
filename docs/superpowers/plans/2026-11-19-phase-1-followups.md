# Phase 1: rulings and deferred follow-ups

This file records the decisions made while building Phase 1 and the minor issues that were deferred, so later phases can pick them up.

## Rulings
- Ruling: new repo created on `main` with only the docs, and implementation happens on branch `phase-1-core-engine` (no worktree). Why: the repo is brand new, so a branch isolates the work just as well. Cost if wrong: none, since nothing is shared.
- Ruling: Task 1 skips `git init` and the docs commit, because both were done during setup. `.gitignore` already lists node_modules, dist and .superpowers/. Why: setup did them. Cost if wrong: none.
- Ruling: E2E tests that need the API (Task 10 entry e2e, Task 15) are written but not run while ANTHROPIC_API_KEY is unset. Docker-only E2E (Task 8) does run. They get reported to the user at the end. Why: no key is available, and asking would stall the run. Cost if wrong: the agent plumbing stays unproven against the real API until the user runs it.
- R1 Ruling: `round` counts build⇄verify rounds starting at 1. The `plan→build` transition sets `round:1`. Verify fails over to `round_cap` when `round >= maxRounds`, and otherwise goes to build with `round+1`. Reject resets `round` to 1. Why: this matches the spec's "max 3 rounds" and the T14 reset. Cost if wrong: an off-by-one in the round cap.
- R2 Ruling: `trimOutput(text, opts?: {headLines?; tailLines?; fullPath?})`, where `fullPath` is optional and printed in the marker. Why: the T6 tests use it. Cost if wrong: none.
- R3 Ruling: `runAgent` takes an optional third argument, `deps?: {spawn?: (container, args) => ChildLike; notify?}`, so tests can inject a fake process. The default uses `execIn`. Why: the T9 tests require a fake process. Cost if wrong: none.
- Task 4: implementer DONE_WITH_CONCERNS d46390c. Ruling: accept temp+fs.link instead of open('wx') — same atomic exclusivity plus full contents on publish — cost if wrong: none; stale-lock double-win window accepted (single-user CLI) — cost: rare double run. Reviewer dispatched
- Ruling R4: a `result` event that pushes spend over the cap returns its output (the work is paid for and complete). State is saved with spentUsd over budget. runAgent must refuse to START a call when remainingUsd(state) <= 0 (throw BudgetExceeded before spawning), so the next call pauses the job. Only a mid-call cost event over the cap kills the process. Why: discarding finished, paid-for work wastes money, and the spec's intent is to stop further spend. Cost if wrong: one call can overshoot the cap by its final increment.
- Ruling R5: an error event that crosses the cap throws AgentError, not BudgetExceeded, with state saved; the pre-start guard then refuses the next call. Also folded into the fix: kill the child on any thrown error, idempotently (it was minor 4).
- Ruling: bypassing permissions INSIDE the container is accepted. The spec says agents run freely inside the container and Docker is the boundary. Cost if wrong: none beyond the container.
- Ruling R6: estimate interim cost from assistant-message usage with a per-model price table (opus-5-5 $4/$20, sonnet-5-5 $2/$10, haiku-5-5 $0.10/$0.50 per MTok in/out; cache read at 0.1× input, cache write at 1.25× input), emitted as cumulative cost events. The SDK's final total_cost_usd is authoritative. The host ignores decreases, so the estimate errs toward overcounting. Why: the spec requires hard budgets, and the long build call is where overspend happens. Cost if wrong: estimates drift from real prices until the table is updated.
- Ruling R7: the image tag includes a short content hash of the kit dir (Dockerfile + .stage). ensureImage fails with a clear "run npm run build:image" message when .stage is missing. Fold in minor 2: install from a pinned lockfile with npm ci.
- Ruling R8: fold in two things later tasks depend on. (a) runOk=false gets a "Run failed" report section with trimmed run output. (b) fallbackKit.dockerfile resolves from the package root via '../../../src/kits/fallback/Dockerfile', which works from both src/ and dist/. Why: Task 13 build fix mode and Task 14 CLI need both. Cost if wrong: none.
- Ruling R9: structured-output schemas must have an object root. The spec turn uses {kind: 'questions'|'spec', questions?: string[], spec?: SpecDoc}, and zod refines that the right field is present for each kind. Why: structured output (Anthropic API / SDK outputFormat) expects an object root, and the real API can't be tested here, so take the safe shape. Cost if wrong: none (same information).
- Ruling R10: delivery tags are `anton/<jobId>/delivered-<n>`, where n = 1 + the count of existing `anton/<jobId>/delivered-*` tags. Why: the spec wants a tag at each checkpoint for rollback, and rejects create repeated deliveries. Cost if wrong: none.
- Ruling: runBuild transitioning to verify itself is accepted, because the runner loops on state.stage. Cost if wrong: Task 14 must not transition again.
- Ruling R11: verify writes `<jobDir>/evidence/failure-report.md` atomically when it fails and removes it when it passes. runBuild without a failureReport argument, with all tasks complete and that file present, runs in fix mode using the file. Task 14's reject writes your notes into the same file. Why: crash-resume must keep the failure context. Cost if wrong: none.
- Ruling: one fix wave covering Important 1–4 plus minors 1 (reject race), 2 (SIGINT in new), 3 (SDK budget stop → BudgetExceeded) and 6 (build role uses the claude_code preset with an appended system prompt). Why: all are small and in the same seams, and 3 of the Important items are first-run risks. Cost if wrong: a slightly larger fix diff.

## Deferred minor findings
- Task 4: minor (deferred): release removes lock without checking own pid (include in fix since it couples with takeover)
- Task 4: minor (deferred): writeFile(tmp) outside try/finally leaks tmp on failure
- Task 4: minor (deferred): AlreadyRunning(pid ?? 0) message misleading
- Task 4: minor (deferred): link() unsupported on some FS — no fallback
- Task 4: minor (deferred): defaultExec untested
- Task 4: minor (deferred): residual 3-contender window during live-lock grab/restore can double-acquire; swallowed link-back error unlogged
- Task 5: minor (deferred): usd not validated (NaN/negative); float-boundary tests; caller must act on crossedWarn AND overCap together (carry to Task 9)
- Task 6: minor (deferred): tailLines=0 path untested; trailing-newline off-by-one; "1 lines" grammar
- Task 7: minor (deferred): GIT_AUTHOR_*/GIT_COMMITTER_*/GIT_DIR env not isolated; ensureAntonIgnored bare catch could overwrite .gitignore on EACCES; non-atomic gitignore write; commit runs user hooks (consider --no-verify)
- Task 4: minor (deferred): stale-MUTEX removal has same race one level down (needs crashed mutex holder + 2 contenders); AlreadyRunning carries dead pid on lost takeover; release check-then-rm
- Task 8: minor (deferred): execIn untested; on timeout only local docker exec client is killed (callers must check timedOut since reject:false); no build progress output
- Task 9: minor (deferred): result early-return doesn't await child exit; nextRequestFile prefix collision on hyphenated stage names; kill test relies on a state mismatch
- Task 10: minor (deferred): z.fromJSONSchema allows extra keys; fallback path untested; exit 0 on error events; stdout backpressure; root-owned files on Linux hosts
- Task 10: minor (deferred): image includes CLI prod deps; base image/apt unpinned; every kit must have .stage/
- Task 11: minor (deferred): timeout 10 kills only the shell, so a backgrounded server may survive; junit path unquoted
- Task 11: minor (deferred): empty/malformed XML branch untested directly; a valid zero-testcase junit hides diagnostics; Run-failed output not persisted to a file; fix report summarized RED rather than pasting it
- Task 12: minor (deferred): edits to non-check sections of spec.md are discarded (say so in the approval hint in Task 14); a raw ZodError on a malformed agent turn; plan task ids not checked for uniqueness or sequence
- Task 13: minor (deferred): an empty results.json gives a misleading report; fix commit uses post-session state.round
- Task 13: minor (deferred): tag number is count-based (collides if an earlier tag is deleted, max+1 would be safer); build imports failureReportPath from verify; jobId glob chars in the listTags pattern
- Task 14: minor (deferred): liveness checks not injectable in shared/status/logs; post-spawn race window; defaultSpawnRun/readlineAsk untested
- Task 14: minor (deferred): stop's still-alive path still pauses and returns 0 (a live runner could overwrite the state)
- Task 15: minor (deferred): redundant npm run build in beforeAll

## Not yet verified
- The real-API path (Agent SDK in the container, the spec, plan and build stages, and the paid E2E test at about $3) has not run, because ANTHROPIC_API_KEY was unset. Run `ANTON_E2E=1 npm run test:e2e` with the key set.
