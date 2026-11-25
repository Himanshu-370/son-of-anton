# Phase 6b: rulings and deferred follow-ups

Decisions made while building Phase 6b (Slack job controls, spec threads and role Q&A), and the minor findings left for later.

## Do first

- **Prove the live paths.** Fakes stand in for all of these in the tests; none has run for real:
  - the LaunchAgent with its new PATH;
  - the API key read from the Keychain;
  - Slack cards, modals and threads;
  - a paid role answer (about $0.01).

  Run `ANTON_E2E=1 ANTON_E2E_SLACK=1 npx vitest run tests/e2e/slack-workflow.e2e.test.ts` and do a manual pass: `/anton new`, then approve the spec from its card, then resume a pause.
- **Give the `anton new` conflict a next step (M1).** When Slack holds a live spec claim on the same job, `anton new` stops without telling the owner what to do. A reused pid could also trigger this falsely, though that is unlikely.
- **Fix the Slack setup prompt wording.** Setup asks for the bot token (`xoxb-`) first and the app token (`xapp-`) second, but its text names them in the reverse order.

## Rulings

- **P6b-R1:** chat answers use `claude-haiku-5-5` for explanations and `claude-sonnet-5-5` for evidence, through the host-side `@anthropic-ai/sdk`. Cost if wrong: one model ID change.
- **P6b-R2:** no live Slack or paid runs without the owner. Those e2e tests stay gated.
- **P6b-R3:** no Slack manifest changes unless unavoidable. Existing 6a apps need no re-setup.
- **P6b-R4:** a Retro triggered by approve or abandon in Slack runs inside `anton serve`.
- **P6b-R5:** the DM command `change <project>` matches the registry key exactly.
- **P6b-R6:** `anton serve` takes `ANTHROPIC_API_KEY` from its environment. If it's missing, serve reads it from the Keychain item with service `anthropic-api-key` and account = current user, via `/usr/bin/security`, and holds it in memory only. `slack service install` writes an absolute PATH that includes the docker and node dirs, and refuses if docker can't be found. Cost if wrong: a different key source later.
- **P6b-R7:** when one spec question is waiting, a thread reply counts as the answer only if it mentions no user or bot other than the PM. Cost if wrong: the owner may need to mention the PM.
- **I9 conflict accepted:** `anton new` still stops when Slack holds a live claim on the same job, because going on would pay twice for the same round. New project names never reuse a registered one, so this happens only in a race.
- **Final review:** one fix wave covered C1, I2–I10 and F1–F4. A scoped re-review approved it.

## Deferred minors

- **M2:** a `budget-paused` event queued before the upgrade shows budget-limit wording for an allowance pause.
- **M3:** after a Ctrl-C mid-turn in the CLI, Slack posts a "stopped, retry" notice while the CLI says to abandon. Nothing is charged.
- **Cards and modals:**
  - Pruning cards at 90 days gives a misleading DENIED. Exempt current targets, or say "card expired".
  - A card for risk without a revision is not bound to its stage.
  - Card tokens are orphaned while a role is offline.
  - At spec approval the busy refusal reuses "already running… Stop it first", where "still finishing" would read better.
  - The modal closes before validation.
  - The lesson Edit modal strips links from the initial value.
- **Spec turns:**
  - A compose failure is reported as an artifact failure and never posted.
  - A failed transition after `claimSpecRound` leaves the claim "in-progress".
  - `anton spec` asks its question before checking for a live holder.
  - A hung collect is abandoned, not cancelled, after settle(5s) on stop.
- **Chat Q&A:**
  - Common-word project slugs cause false "other project" refusals.
  - A project with no current job loses the status fallback.
  - A settle failure after a paid call loses the answer.
  - Status replies are not deduped.
  - README wording on the reservation for API errors.
- **Locks:**
  - `removeLockIfHeldBy` (`anton stop`) removes a dead lock without the takeover mutex. Still open (belongs to a Holder refactor). Since the Owner actions refactor, `stop` does pause the job under the decision lock.
  - The `takeMutex` stale check can double-remove after a crash mid-takeover.
  - Claimed records can carry a reused pid.
  - `stop` vs a concurrent resume: between `stop` clearing the run lock and taking the decision lock, a resume can spawn a new runner that `stop` then marks paused. Fix: under the lock, skip the pause when another pid holds the run lock or a newer spawn claim exists.
- **Code health:**
  - `pidAlive`, the interactive roles and the ts regex are duplicated. (The status table is resolved: one formatter in `src/core/job-status.ts`.)
  - The job-ID check is duplicated.
  - `decide()` checks at runtime that an action which starts a run has `preflight`; make it a type-level requirement.
- **Test gaps:**
  - spec revision stale;
  - Retro retry;
  - the busy path;
  - block ack.
- **Flaky test:** one full-suite failure happened once and was never identified. It is likely the 10 s lock wait under load.
- **Offered:** an `anton forget <project>` command.
