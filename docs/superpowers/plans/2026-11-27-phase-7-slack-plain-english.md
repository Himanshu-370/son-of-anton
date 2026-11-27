# Plain-English Slack Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Complete and review each task before starting the next.

**Goal:** Let the Owner run Anton from ordinary Slack messages, with explicit confirmation for every change.

**Architecture:** Extend the existing Slack dispatcher with an intent registry, a bounded classifier and persisted conversation context. Use the existing owner actions and revision checks to execute confirmed operations.

**Tech stack:** TypeScript, Zod, Vitest, Slack Bolt and the existing Anthropic SDK.

**Spec:** [Plain-English Slack](../../specs/2026-11-27-slack-plain-english-design.md).

## Build order and release gates

1. **Phase 7, v0.11.0.** Integrate the specs into main via PR before cutting `phase-7-slack-plain-english` from updated main. Complete the tasks below and record the Owner's live Slack pass.
2. **Phase 8, v0.12.0.** Write the detailed plan against shipped Phase 7. Build a host-side spend ledger and cross-process cap enforcement first, then the model resolver and settings history, then insights, suggestions, trials and the dashboard. Test concurrent reservations from separate processes and failure recovery. Reconcile imported totals before enabling the cap and make the cap-raising control reachable through the free fallback. Verify the PM Home tab after setup applies its manifest change.
3. **Phase 9, v0.13.0.** Update the held call plan against shipped Phases 7 and 8. Recheck Tasks 0–12 against the shared router and spend contracts. Rewrite Tasks 13–15 for Slack controls, admission polling and crash recovery. Run the two-bot Meet and Zoom transport gate before committing to the transport. Verify budget enforcement during streaming, cleanup after restart, and the full Slack-controlled call.

## Global constraints

- Keep slash commands and existing job-thread spec replies compatible. Preserve non-owner Q&A and its membership checks. No Slack manifest changes in Phase 7.
- Confirmations carry a server-stored operation, bound to the workspace, Owner, channel, message and applicable job, stage and revision. Cards expire after 30 minutes.
- The router receives bounded project facts and fenced Slack text only. Use Haiku 5.5, low effort, no thinking, up to 600 output tokens, 6,000 bytes of message input and 4,000 bytes of project facts. Use stable prompts and redact before persisting or sending text.
- Inject external effects. Use the existing atomic writes and locks. Unit tests use fake Slack, model and process adapters.

## Review focus

- Duplicate deliveries must not create duplicate reservations or execute an action twice.
- Fallback parsing must still lead to confirmation for a changing message.
- A job moving between preview and confirmation must fail the existing stale checks.
- Clarification must stay bound to its original Owner and thread and stop after one retry.
- A stop targeting a job that moved on must refuse before signaling its runner.

### Task 1 — Shared stop and intent registry

**Files:** `src/core/job-actions.ts`, `src/cli/commands/stop.ts`, `src/slack/actions.ts`, new `src/slack/intents.ts`, `tests/core/job-actions.test.ts`, new `tests/slack/intents.test.ts`.

- [ ] Add failing tests for stage checks, missing action fields, ambiguous projects and a stale stop that sends no signal.
- [ ] Extract the CLI stop sequence behind a shared core entry point with injected process and container effects. Check the captured target before signaling and recheck under the decision lock before recording the pause.
- [ ] Define the intent registry and derive its prompt descriptions and object-root Zod schema. Resolve projects from validated names, channel context or an unambiguous singleton. Convert valid changing intents to existing operations, including stop. Keep read-only and clarification results distinct. Require missing notes or risk details before conversion.
- [ ] Run the focused core and Slack tests and commit.

### Task 2 — Bounded and metered intent classification

**Files:** new `src/slack/intent-router.ts`, new `src/stages/prompts/slack-intent.md`, `src/slack/chat-budget.ts` as needed, new `tests/slack/intent-router.test.ts`.

- [ ] Add failing tests for invalid JSON, unknown intents, oversized input, duplicate events, empty budget, missing key and provider error.
- [ ] Implement an injected classifier that returns a validated intent, clarification or an unavailable reason. Use the existing chat reservation and settlement helpers with a distinct request ID derived from the event key. Keep the conservative reservation when the provider outcome is unknown.
- [ ] Give the caller the unavailable reason so it can use the exact parser and explain the fallback. Run focused tests and type check, then commit.

### Task 3 — Confirm cards and execution

**Files:** `src/slack/actions.ts`, `src/slack/inbound.ts`, `src/slack/views.ts`, `tests/slack/actions.test.ts`, `tests/slack/workflow.test.ts`.

- [ ] Add failing tests for accepted, cancelled, edited, expired, moved and replayed cards, including a new-project card without a job target.
- [ ] Extend persisted card bindings compatibly with a validated payload and expiration. Show the exact operation and money effect. Reuse the notes and budget modals and invalidate the superseded preview after editing.
- [ ] On Confirm, resolve the stored operation through the existing claim flow and owner action. Cancel consumes the card. Check expiry at the point of execution and preserve compatibility with previously issued cards.
- [ ] Run focused Slack tests and type check, then commit.

### Task 4 — Message routing and clarification

**Files:** `src/slack/actions.ts`, `src/slack/inbound.ts`, new `src/slack/intent-threads.ts`, `tests/slack/actions.test.ts`, `tests/slack/workflow.test.ts`.

- [ ] Add failing workflow tests for top-level DM, channel mention, non-owner input, job-thread replies, fallback, clarification expiry and duplicate delivery.
- [ ] Route eligible Owner messages through classification before generic Q&A. Use the exact parser on classification failure and send its changing results through the same confirmation path. Serve read-only intents immediately. Keep existing slash commands on their current path.
- [ ] Persist separate thread context using atomic writes. Allow one clarification retry within 10 minutes, then return help. Expire thread registry entries after 24 hours. Keep responses scoped to the resolved project and existing audience checks.
- [ ] Run focused Slack tests and type check, then commit.

### Task 5 — End-to-end verification and release

**Files:** `README.md`, `tests/e2e/slack-workflow.e2e.test.ts`, phase follow-ups in `docs/superpowers/plans/`.

- [ ] Exercise the full fake flow through inbound handling, preview and dispatch. Cover confirm, cancel, stale cards, clarification and fallback. Update the README with plain-English examples.
- [ ] Run `npm test`, `npx tsc --noEmit` and the fake Slack workflow test. Complete the whole-branch review and recheck any fixes.
- [ ] Record the Owner's live pass in a DM and project channel. Scan the branch for secrets before pushing, open a PR with results and remaining verification, and merge only with authorization. Tag and push `v0.11.0` after merge.
