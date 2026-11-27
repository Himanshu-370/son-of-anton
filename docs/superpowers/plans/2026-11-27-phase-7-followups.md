# Phase 7 verification and release

The fake Slack workflow covers a clarification reply, cancelling a preview, and starting work only after confirming an exact-command fallback. The Slack unit tests cover stale and replayed cards, expired clarifications, and project access.

On 2026-11-27, all nine bots connected to the existing Slack workspace with the Phase 7 build, and the Owner reported seeing the expected status and confirmation flow in the smoke check. Actual job creation, the clarification round trip and a stale Checkpoint click remain unverified in live Slack. In a DM and a project channel, ask the PM for status and request a change in ordinary language. Try Confirm and Cancel, answer a clarification in its thread, and check that a card from a previous Checkpoint refuses to act.

Phase 8 needs the Phase 7 intent and confirmation interfaces. Phase 9 also needs Phase 8 spend controls and the separate live Meet and Zoom transport check.

The opt-in Slack workflow also posts a Phase 7 confirmation in a dedicated test workspace and exercises Cancel with a synthetic event. It uses a fake classifier. With `ANTON_SLACK_TEST_HOME` and `ANTON_SLACK_TEST_TEAM_ID` configured, run:

```sh
ANTON_SLACK_E2E=1 npx vitest run tests/e2e/slack-workflow.e2e.test.ts
```

The manual pass still covers real Owner messages, real button clicks, and paid intent classification.
