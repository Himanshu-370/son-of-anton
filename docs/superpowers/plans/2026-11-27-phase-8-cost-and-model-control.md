# Cost and Model Control Implementation Plan

> Implement each task with focused tests, then run the suite and type check before shipping.

**Goal:** Give the Owner spending insights and controls through Slack.

**Architecture:** Centralize host-side spend accounting and reserve budget before paid work. Keep the existing job and Slack caps alongside the overall cap.

**Tech stack:** TypeScript, Zod, Vitest, Slack Bolt.

## Implementation order

1. Add `src/core/spend-log.ts` with typed, idempotent writes to `spend.jsonl` under the host lock. Test simultaneous writers, duplicate IDs, validation, and corrupt-line reporting.
2. Reserve overall budget under the same lock and settle by request ID. Test process races, unknown outcomes, UTC month boundaries, and imported totals. Gate paid paths only after all callers reserve or stop conservatively. Wire build, Retro, chat and router spend before enabling the cap.
3. Add the shared model resolver and snapshot its result at run start. Add validated settings writes, owner confirmation, history, and undo. Test preset precedence and conflict detection after hand edits.
4. Build insights from the ledger and job records. Test forecasts, rework, sample thresholds, recommendations, and trial expiry. Keep the numeric calculations in code.
5. After Phase 7 lands, wire the Slack intents, confirmation cards and PM Home tab. Confirm that the Owner can raise a cap when paid routing is disabled. Check setup and the Home tab in a dedicated workspace.

## Spend reservation handoff

The host ledger now exposes `reserveSpend`, `settleSpend`, and `readMonthlySpend`. A capped reservation reads settled costs and open holds under the same host lock. Settlements retain the month of the original reservation. Settle with zero only when the provider confirms the request was unbilled. Leave unknown outcomes reserved for that month. A corrupt ledger blocks capped reservations, and skipped lines remain visible in reporting.

The overall cap stays disabled until every paid path is wired and prior month-to-date charges are reconciled. The cap check must read the current locked snapshot because jobs can run in processes separate from the Slack service.

Phase 9 consumes the spend and reservation APIs for calls. The design spec is on `feat/slack-hub-specs` until that documentation lands.
