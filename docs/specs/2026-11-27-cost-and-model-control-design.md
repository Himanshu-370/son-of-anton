# Cost and model control in Slack: design

Status: approved in conversation 2026-11-27, saved for later. This is spec 2 of 3. It depends on spec 1 (`2026-11-27-slack-plain-english-design.md`) for plain-English intents and confirm cards.

## 1. Intent

The Owner wants to control what anton spends and which models it uses, from Slack, backed by proper insight. Every decision should come with the numbers that justify it.

Today:
- each Job has a budget split into stage allowances;
- Slack answers have a monthly pool;
- the model for each role is fixed in code (`ROLE_MODELS` in `src/core/config.ts`);
- spend is recorded per job and per stage (`cost.json`, `usage.json`), but not which role or model spent it.

## 2. Goals, non-goals, anti-goals

**Goals**
- **Spend log:** one trusted spend log covering builds, Slack answers and calls, attributed to project, job, stage, role and model.
- **Insights:**
  - where the money goes;
  - waste (abandoned jobs, rework);
  - a month-end forecast;
  - unusual burn;
  - model results per role (cost and quality signals);
  - cache savings.
- **A dashboard** on the PM's Home tab, always current.
- **Plain-English questions** about spend, answered with numbers computed in code.
- **Plain-English control,** each change behind a confirm card:
  - job budget defaults and a single job's budget;
  - stage allowances;
  - the Slack chat pool;
  - the calls pool and caps;
  - a new overall monthly cap;
  - each role's model and effort;
  - presets.
- **Change history** with undo.
- **Suggestions (decided):** anton suggests money-saving or quality-improving changes when the data supports them. It never changes anything on its own.
- **A weekly summary** in #anton.

**Non-goals**
- Rebuilding history for jobs that finished before this ships. Their per-stage totals still show, but without role or model detail.
- Billing data from Anthropic, Recall, Deepgram or ElevenLabs accounts. anton counts what it spent itself.
- Charts as images. The dashboard uses Slack text blocks.
- Changing a run already in flight.

**Anti-goals**
- A figure in Slack that the model made up.
- A suggestion based on too little data and presented as solid.
- A settings change that breaks `config.yaml`, or that a hand edit then silently overwrites.
- The overall cap stopping work without telling the Owner why and how to raise it.

## 3. Constraints

- **Writes:** state and log writes go through `writeFileAtomic`. Job folders are container-writable and untrusted, so the spend log lives in `~/anton`, and only the host writes it.
- **Config:** `~/anton/config.yaml` stays the single source of truth. Slack edits must keep the Owner's comments and formatting (the `yaml` document API), pass `AntonConfigSchema` validation before writing, and take a lock.
- **Selectable models:** only models with a verified price in `PRICES` (`src/agent/pricing.ts`), with efforts `low`, `medium` and `high`. Changing a read-only role's model must not change its tool or plugin isolation.
- **Changes apply from the next run.** An in-flight run keeps its settings.
- **Owner only,** with every change behind a confirm card (spec 1).
- **One Slack manifest change, overriding P6b-R3:** the PM's Home tab is enabled (`home_tab_enabled: true`, event `app_home_opened`). It's unavoidable for a dashboard. The Owner rerunning `anton slack setup` once applies it, and setup already compares manifests. *(My call.)*

## 4. Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **Home tab dashboard plus plain-English questions and controls** | Always visible and native, but needs one manifest update. | **Picked.** |
| A dashboard message in #anton, edited in place | No manifest change, but it scrolls away and clutters the channel. | Rejected. |
| A local web dashboard (`anton serve` on localhost) | Rich charts, but it's outside Slack, which goes against "Slack is the hub". | Rejected. |

Spend log store:

| Approach | Trade-off | Decision |
|---|---|---|
| **An append-only JSON Lines file, `~/anton/spend.jsonl`** | Simple, can be hand-inspected, and easy to append to atomically. It is read whole, which is fine at anton's scale. | **Picked.** |
| SQLite | Fast queries, but a new native dependency. | Later, if the file passes about 50 MB. |

## 5. Design

### 5.1 Spend log

Each paid call appends one line, written by the host:

```json
{ "at": "2026-11-27T10:00:00.000Z", "source": "build|chat|router|call", "project": "todo-app", "jobId": "3", "stage": "build", "role": "backend", "model": "claude-sonnet-5-5", "effort": "medium", "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, "usd": 0.42, "vendor": "anthropic" }
```

- **Field rules:**
  - `source` is `call` with `vendor` set to `recall`, `deepgram` or `elevenlabs` for non-Claude call costs;
  - `tokens` is optional for those vendors;
  - `jobId` and `stage` are optional for chat, router and call lines.
- **Who writes it:**
  - **Builds:** the host runner, where it already appends `cost.json` and `usage.json` (`src/agent/host-runner.ts`). It knows the role and model for the session.
  - **Chat, the router and calls:** their settle step, which already knows the actual cost.
- **Bad lines:** a malformed line is skipped when reading and counted in a "skipped lines" note on the dashboard.
- **When lines are written** *(builder-check answers, my calls)*:
  - **Builds:** one line per cost increment that `applyTotal` books, so resumed sessions follow the existing `baseUsd` offset. Role and model come from the session's request.
  - **Retro on the Batch API:** one line when the batch result settles, with `at` set to the settle time.
  - **Calls:** one Claude line per turn, plus one line per vendor (Recall, Deepgram, ElevenLabs) when the call ends.
- **The first month** *(my call)*: on the first start after this ships, anton writes one `source: "import"` line per job with spend this month (from `state.json` `spentUsd`) and one for this month's chat ledger total. Caps and forecasts are right from day one. Imported lines have no role or model, so they show as "before tracking".
- **Two ledgers, two jobs:** `chat-budget.ts` stays the authority that reserves and enforces `chat.monthlyUsd`, and the call ledger does the same for calls. `spend.jsonl` is the reporting log and the authority for the overall cap. Chat and calls write to both.
- **Months:** all money periods are UTC calendar months, the same as the chat pool. Only the weekly summary uses local time, covering Monday to Sunday.
- **Running total:** read once at service start, kept in memory per month, and updated on each append. The overall cap check never rereads the file.

### 5.2 Insights (pure functions over the log plus job states)

- **Totals:** this month, last month, and this month by project, stage, role, model and source.
- **Waste:** spend on abandoned jobs. Rework is spend in verify rounds after the first, plus build stages re-run after a failed verify.
- **Forecast:** this month's spend so far ÷ days elapsed × days in the month, compared with the overall cap.
- **Unusual burn:** a running job whose spend in its current stage passes 2× the median spend for that stage over the last 10 finished jobs (with at least 5 such jobs). It produces one Slack alert per job and stage.
- **Model results:** for each role and model pair over finished jobs, the average cost per job, the average verify rounds, the average review findings count, and the share of jobs that paused for budget.
  - Each figure shows its sample size `n`.
  - Below `n = 3`, it is marked "too few jobs to judge".
- **Cache savings:** cache-read tokens × (the input price − the cache-read price), in dollars.

### 5.3 Suggestions

- **The rule:** a suggestion appears only when all of these hold:
  - each compared role and model pair has `n ≥ 3`;
  - the cheaper pair's quality signals are no worse than the current one's, within one verify round and the same pause share;
  - the projected monthly saving is at least $5.
- **The wording** shows the numbers and the sample, for example: "QA on Haiku: $0.80/job vs $2.10 on Sonnet, verify rounds 1.3 vs 1.2 (n = 4 vs 9). It would have saved about $14 this month. Switch QA to Haiku?" A confirm card follows.
- **Getting data for a model never tried:** anton may propose a **trial** ("try QA on Haiku for the next 3 jobs, then compare"). The trial is a confirmed setting with an end condition, and it reverts by itself after the 3 jobs unless the Owner keeps it.
- **Trial rules** *(my calls)*:
  - **What counts:** a job counts toward `jobsLeft` when it finishes (delivered or abandoned) after that role ran at least once on the trial model. It's global across projects. Concurrent jobs each count.
  - **Jobs already running:** they pick up the trial model from their next run, because settings apply per run.
  - **Reverting:** it restores `revertTo` exactly. That is whatever was in effect when the trial started, including an override.
  - **One trial at a time.**
- **No nagging:** at most one new suggestion a week, shown on the dashboard and in the weekly summary. Each can be dismissed ("not now", for 30 days) or applied.

### 5.4 Controls and settings

New and changed config (everything optional, with today's behaviour as the default):

```yaml
budget:
  defaultUsd: 10          # existing
  allowances: { ... }     # existing
  monthlyUsd: 150         # new overall cap across builds, chat, router and calls; unset = no overall cap
models:                   # new; unset = today's ROLE_MODELS
  preset: balanced        # economy | balanced | best
  roles:                  # per-role overrides on top of the preset
    qa: { model: claude-haiku-5-5, effort: medium }
  trial: { role: qa, model: claude-haiku-5-5, effort: medium, jobsLeft: 3, revertTo: { model: claude-sonnet-5-5, effort: medium } }
chat: { ... }             # existing
call: { ... }             # spec 3
```

**Presets** *(my call)*. Balanced is today's `ROLE_MODELS`.

| Role | economy | balanced | best |
|---|---|---|---|
| pm, tech_lead | sonnet | opus | opus |
| developers, qa, browser_tester | sonnet | sonnet | sonnet |
| code_reviewer, plugin_reviewer, mapper | sonnet | sonnet | opus |
| security_reviewer | sonnet | sonnet | opus |
| coach | haiku | haiku | sonnet |

Effort stays as in `ROLE_MODELS`, unless a per-role override sets it.

- **Single source:** `ROLE_MODELS` becomes the balanced preset. Every place that picks a role's model reads it through one resolver: trial, then override, then preset.
- **Allowed values** *(my calls)*:
  - a job budget from $0.50 to $500;
  - any cap from $0 to $5,000. $0 turns that area off, and its card says so;
  - allowances must still add up to 100;
  - `models.roles` keys are the 12 `Role` names. Group words such as "developers" expand to frontend, backend and infra, and the card lists them.
- **Overall cap:**
  - **How it behaves:** the same way as a stage allowance. It uses the existing `killOnCap` path in `applyTotal`, which can stop mid-call, then pauses with reason `monthly-cap`. A `resume` while the cap is still reached is refused: "The monthly cap ($150) is reached. Raise it first, for example 'raise the monthly cap to $200'."
  - **At 80%:** the PM posts one warning in #anton.
  - **At 100%:**
    - running jobs pause at their next budget check, with a new pause reason `monthly-cap`. Its Slack wording says the cap and how to raise it ("raise the monthly cap to $200");
    - Slack answers and the router fall back to free status and the exact parser;
    - calls refuse to start.
- **Plain-English intents** added to spec 1's registry, each changing one behind a confirm card that shows before → after and its expected effect:
  - `spend_query`;
  - `set_budget` (default or one job);
  - `set_allowances`;
  - `set_cap` (overall, chat or call);
  - `set_model` (role, model, effort);
  - `set_preset`;
  - `start_trial`;
  - `undo_setting`;
  - `settings_history`;
  - `dismiss_suggestion`.
- **Expected effect on the card:**
  - the projected monthly change at recent usage;
  - for model changes, a short note from a fixed table, for example "Haiku: much cheaper, less careful on long or tricky work". The table is not model-written.

### 5.5 Change history and undo

- **History:** every applied change appends to `~/anton/settings-history.jsonl` with the time, the intent, the config path, the before and after values, and the source (Slack or a detected hand edit).
- **Undo:** "undo that" reverts the latest change, behind a confirm card. It is refused if that config value has changed since (by a hand edit or another change), with the reason.
- **Hand edits:** when `config.yaml` changes outside Slack, the dashboard shows "edited by hand at <time>" and the change is logged with source `file`.

### 5.6 Dashboard (PM Home tab)

It is rebuilt when the tab opens, and at most once a minute while it's open.

```
November   $84.20 of $150 overall cap   ▓▓▓▓▓▓░░░░   on pace for $131
By project todo-app $52.10 · blog $24.60 · calls $5.30 · Slack $2.20
By role    PM (Opus) $28.40 · Developers (Sonnet) $31.00 · QA (Sonnet) $11.20 · …
Waste      abandoned $6.10 · rework $9.40
Watch      todo-app job 4: build is burning 2.3× its usual rate
Models     preset balanced · overrides: QA → Haiku (trial, 2 jobs left)
Suggestion Tech Lead on Sonnet would save about $11 a month (n = 4 vs 6). [Review]
Cache      saved $7.80 this month (61% hit rate)
[ Change a limit ] [ Change models ] [ Settings history ]
```

The buttons open small modals that produce the same confirm cards as the plain-English intents.

**Who sees it:** the Owner only. Anyone else opening the PM's Home tab sees "This dashboard is for the anton owner." and no figures. *(My call.)*

### 5.7 Questions and the weekly summary

- **`spend_query`:** the router extracts the filters (project, period, role, model, source). Code computes the answer. The model only phrases the computed numbers, and the reply includes the figures themselves.
- **Weekly summary:** posted Monday at 09:00 local time in #anton. It gives last week's total and its change, the top project and role, waste, the forecast, and any open suggestion.

## 6. What's left to the builder

- The exact resolver location, and threading it through every place a role's model is picked today.
- The spend log line schema in zod, and appending it atomically under a lock.
- Detecting hand edits: a content hash stored with each Slack change.
- Block Kit layout and copy for the dashboard, cards and modals.
- The fixed "expected effect" table for model changes.
- **Tests:**
  - insights maths on fixture logs (forecast, waste, unusual burn with the `n ≥ 5` gate, model results with the `n < 3` marking);
  - the suggestion rules (all three conditions, and the one-a-week limit);
  - the trial lifecycle and auto-revert;
  - config edits that keep comments and refuse invalid values;
  - undo refused after a hand edit;
  - the overall cap pausing a job with `monthly-cap`;
  - the 80% warning sent once;
  - the resolver order (trial, then override, then preset);
  - a model change leaving read-only isolation unchanged.

## 7. Risks

- **Quality signals are rough.** Verify rounds and review findings depend on the task as much as the model. Sample sizes are always shown, and suggestions need `n ≥ 3` and a $5 saving. Trials are the honest way to compare.
- **The manifest update:** existing installs must rerun setup once for the Home tab. Until they do, the dashboard isn't available, but plain-English questions and controls still work.
- **The spend log grows by about 1 line per paid call.** That's small at anton's scale, and SQLite is the upgrade path.
