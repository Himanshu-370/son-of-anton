# Phase 2: rulings and deferred follow-ups

Decisions made while building Phase 2, and minor issues deferred for later phases.

## Security follow-ups (do first in Phase 3)
- A scanner finding's id has no line number, so accepting one gitleaks or semgrep finding also accepts a later hit of the same rule in the same file, including a newly added secret. Add the line or a fingerprint for gitleaks.
- The security reviewer can lower a scanner finding's severity. Make the scanner's own severity a floor.
- A corrupt `results-verify-*.json` makes later verifies throw. Skip copies that fail to parse.
- Repo-local `.git/config` filter drivers still apply to host git (Phase 1 residual). Run git inside the container.

## Rulings
- Ruling: implementation runs on the feature branch, not a worktree. Why: same as Phase 1, a single local user. Cost if wrong: none.
- P2-R1 Ruling: when evidence/failures.json is missing but the persisted failure-report.md exists (a legacy or crash path), fix mode routes the markdown text to every area in the plan, in AREA_ORDER. Why: it keeps the R11 crash safety without structured items. Cost if wrong: an extra fix session.
- Task 1: implementer DONE dbca62b; reviewer dispatched. Ruling: commit trailers name the model that authored the commit (taken from each agent's own system reminder). Cost if wrong: cosmetic.
- Ruling P2-R2: when req.tools is set, the entry also sets strictMcpConfig:true, mcpServers:{} and settingSources:[]. Builder sessions are unchanged in Phase 2; plugin loading is Phase 4's concern. Why: reviewers must not gain tools from repo-controlled config. Cost if wrong: none for reviewers.
- Ruling P2-R3: the fake AWS-style key must never be in the pushed history. Redact the fixture (Match/Secret → "REDACTED") and fold the change into commit a8d9506 with a fixup commit plus a non-interactive autosquash rebase (GIT_SEQUENCE_EDITOR=:). The branch is unpushed, so rewriting it is safe. Why: the repo is public, and secret scanners (GitHub's and Anton's own) would flag it. Cost if wrong: the commit ids after a8d9506 change. Only the review package bases shift, which the ledger tracks.
- Ruling: accept the signature-format change. Phase 1 jobs in flight lose at most one no_progress match. Cost if wrong: one extra round.
- Ruling P2-R4 (for Task 8): route a FailureItem to its stated area even when the plan has no tasks there; the role prompt exists. Each area's fix prompt holds only that area's items, plus a pointer to the full report at /workspace/.anton/jobs/<id>/evidence/failure-report.md, readable with the agent's tools. Why: it avoids duplicating the shared check details in every area's prompt, which saves tokens. Cost if wrong: the agent may need to read the file.
- Ruling: fold two Task 9 minors into Task 10. (a) The Code review section says "Code review did not run for this delivery." when there is no review section. (b) accept-risk at awaiting_final_review prints a note that REPORT.md still shows the earlier state until the next delivery. Why: both are user-facing and cheap. Cost if wrong: none.
- Ruling: one fix wave (opus) covering Important 1–6, Minor 1–3 (gitleaks history note), plus watchlist items maxTurns 60 for reviewers and safe.directory in the Dockerfile. Why: all small, and several are first-run risks. Cost if wrong: a larger fix diff.

## Deferred minor findings
- Task 1: minor (deferred): AREA_ORDER mutable; entry.ts comment says "build role" (fix in Task 4 when entry is touched)
- Task 2: minor (deferred): area literals duplicated in PlanSchema rather than derived from config; weak substring check on the schema
- Task 3: minor (deferred): no warning when an expected handoff file is missing; the container handoff path is built separately from handoffPath (risk of drift)
- Task 4: minor (deferred): area enum duplicated in code-review.ts
- Task 5: minor (deferred): malformed scanner entries yield empty fields; e2e doesn't run a real scan
- Task 6: minor (deferred, flag for the final wave since they are security-relevant): no spoof-regression test; prompt doesn't mark scanner/diff text as untrusted; scanner messages untrimmed (gitleaks messages may carry the secret to the model, and the prompt could get large); dedupe keeps first rather than highest severity on an id collision; loadAcceptedRisks unvalidated
- Task 7: minor (deferred): run output is duplicated in the item text and Check details; files are removed before headSha on pass; no test for no_progress on a repeated security id or for BudgetExceeded mid-verify; reworded CR summaries escape no_progress (Task 4 id design)
- Task 8: minor (deferred): a corrupt failures.json causes an error pause rather than falling back to markdown
- Task 9: minor (deferred): fixed-list negative tests; escaping of where/area; spec.md example wording
- Task 10: minor (deferred, fix in the final wave): orphaned README paragraph; README says "each role is a separate agent session" though QA is code-only; job-flow line omits the review step; the pause hint mentions accept-risk even when other blockers remain

## Not yet verified
- The real-API path has never run because ANTHROPIC_API_KEY is unset. Watch for: the `tools` allowlist together with structured output (`outputFormat`), reviewer turn limits, semgrep needing network for `p/default`, and the JSON-schema bounds being accepted. Run `ANTON_E2E=1 npm run test:e2e` with the key set.
