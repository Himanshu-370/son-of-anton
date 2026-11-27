# Son of Anton: Build Roadmap

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` (approved 2026-11-19)

The spec covers six subsystems. Each phase below gets its own plan and leaves working, tested software behind. Phases run in order, because each builds on the interfaces of the one before.

| Phase | Delivers | Spec sections | After this phase you can… |
|---|---|---|---|
| **1. Core engine** | CLI, job/state store, Docker runner, agent runner, Spec → Plan → Build → Verify → Deliver with the fallback kit, both checkpoints, budget cap, resume, background runs, notifications | §5, §6.1–6.6, §7, §7.1 (code does mechanical work, fresh contexts, output trimming, early stop, budget cap + 80% warning), §8 (interface + fallback), §9 | `anton new "a CLI that…"` and get a verified repo plus `REPORT.md` |
| **2. The team and reviewers** | Role agents (PM, tech lead, frontend/backend/infra devs, QA), task tagging and the contract between pieces, handoff notes, code reviewer, security reviewer with scanners, accept-risk, per-role model/effort table | §6.3, §6.4, §6.4.1, §7.1 model table, §11.1 | Get reviewed, security-scanned builds from a role-split team |
| **3. Kits and existing code** | Web kit (Playwright, screenshots), `adopt`/`change`, jobs folder per change, regression baseline, branches, repo map, outside services with stand-ins, secrets with redaction | §6.0, §8 (web kit), §9.1, §7.1 repo map | Build web apps; change existing repos safely; use real secrets |
| **4. Plugins and cost controls** | Marketplace plugins per stage and role, `plugins.lock`, the unattended-stage rule and ask-the-user guard, MCP servers only in the stages that use them, prompt caching layout and cache tracking, stage allowances, cost estimate at checkpoint 1, task budgets, security review of plugin updates | §10.1, §7.1 (caching, allowances, estimates), §6.4.1 (plugin updates) | Use marketplace skills safely at a predictable cost |
| **5. Learning loop** | Retro (batch), lesson proposals and `lessons review`, per-role lessons mounted per stage, scoreboard, bench (including a change job) | §6.7, §10.2 | Watch the factory improve, with your approval |
| **6. Slack** | `anton serve` (launchd, Socket Mode), `anton slack setup` (9 apps from manifests, channels), job threads, milestone posts, approval buttons and boxes, @mention Q&A, chat budget, owner-only orders, redaction | §11.2–11.5 | Run your dev team from Slack |

Each phase's plan is written when the previous phase is done, so it builds on the real interfaces, not guessed ones.

## Next phases: Slack as the hub (specced 2026-11-27, not yet built)

The Owner wants Slack to be the single place to run anton, in plain English, with no commands to remember. That work is split into three specs, which **must be built in this order**, because each one builds on the one before.

| Phase | Spec | Delivers | Depends on | Tag when shipped |
|---|---|---|---|---|
| **7. Plain-English Slack** | `docs/specs/2026-11-27-slack-plain-english-design.md` | A Haiku intent router over DMs and @PM mentions, and an intent registry. Every change gets a confirm card bound to its Job and Checkpoint. Also clarify threads, a fallback to the exact `/anton` parser, help, and a Slack `stop` that really stops the run. | Phase 6 and Owner actions (`decide()`) | `v0.11.0` |
| **8. Cost and model control** | `docs/specs/2026-11-27-cost-and-model-control-design.md` | The host-side spend log (`~/anton/spend.jsonl`), insights, the PM Home tab dashboard, an overall monthly cap (`monthly-cap` pause), per-role models and presets via one resolver, suggestions and trials, settings history with undo, and a weekly summary. | Phase 7 (intents and confirm cards) | `v0.12.0` |
| **9. Agents in calls** | `docs/specs/2026-11-27-agents-in-calls-design.md` | One Recall.ai bot per chosen agent in a Zoom or Meet call, started and controlled from Slack. A per-call quick tunnel, the floor manager, persona answers and voices, the call budget and crash recovery. | Phases 7 and 8 | `v0.13.0` |

Background research for phase 9: `docs/research/2026-11-26-agents-in-video-calls.md`.

### Handoff: how an agent implements a phase

1. **Read first:**
   - `CLAUDE.md` (repo rules);
   - `CONTEXT.md` (domain terms);
   - the phase's spec in full, including its "Builder-check answers". Those are settled decisions; don't reopen them;
   - for phase 9, also the research note.
2. **Write the plan** with the `superpowers:writing-plans` skill, saved to `docs/superpowers/plans/<date>-phase-<N>-<topic>.md`.
   - **Phase 9 already has a plan,** on hold: `docs/superpowers/plans/2026-11-27-agents-in-calls.md`. Its Tasks 0–12 still apply. Rewrite Tasks 13–15 for the Slack flow in the spec's sections 5.6 and 5.7: call intents, the live card, Recall status polling instead of "press Enter", `~/anton/call.json` crash recovery, and the start-card warning. Drop the CLI `anton call` command.
   - **The Owner reviews and approves the plan** before any code is written.
3. **Build** on a branch `phase-<N>-<topic>` cut from an up-to-date `main`. Execution is subagent-driven: a fresh implementer per task, a review per task, and a whole-branch review at the end, as in earlier phases.
4. **Done means:**
   - `npm test` and `npx tsc --noEmit` pass;
   - the new gated e2e tests pass when the Owner runs them;
   - the Owner's manual Slack pass is recorded in that phase's follow-ups doc (`docs/superpowers/plans/<date>-phase-<N>-followups.md`).

   State plainly what wasn't verified.
5. **Ship:** open a PR. The Owner merges (`gh pr merge --merge --delete-branch`). Tag the merge commit with the version in the table and push the tag.

### Steps only the Owner can do

- **Phase 7:** a live Slack pass in a DM and a channel. Try loose phrasing, confirm and cancel, an out-of-date card, and a clarify thread.
- **Phase 8:** rerun `anton slack setup` once, to apply the Home tab manifest change, then check the dashboard against real spend.
- **Phase 9:**
  - create a Recall.ai account;
  - add the Keychain items `recall-api-key`, `deepgram-api-key` and `elevenlabs-api-key` with `security add-generic-password -a "$USER" -s <service> -w`. Keys are never typed into Slack or chat;
  - `brew install cloudflared`, then rerun `anton slack service install`;
  - run the gated live transport check (plan Task 7) on Meet and on your own Zoom account. It is a go/no-go gate;
  - then run a real call.

### Global rules for these phases

These come from the specs:
- **Owner only:** only the Owner may trigger anything that changes a job, a setting or a call.
- **Confirm cards:** every change shows a confirm card first. The one exception is ending a call.
- **Numbers:** numbers shown in Slack are computed in code. Models only phrase them.
- **Untrusted text:** Slack text, job records and call transcripts are untrusted, and are fenced as data in prompts.
- **Secrets** are redacted with `redact()`. Keys are never written to files, logs, config or bot pages.
- **Settings** apply from the next run, never to a run in flight.
