# Son of Anton

Son of Anton is a CLI (`anton`) that turns a one-line description into working software. You answer a few questions and approve a spec. An AI agent pipeline then plans, builds and verifies the project inside a Docker container, and hands you a report to approve or reject. The name nods to the rogue AI in HBO's *Silicon Valley*, minus the part where it deletes everything.

## Prerequisites

- Docker Desktop, running
- Node.js >= 22
- `ANTHROPIC_API_KEY` set in your environment

## Setup

```sh
npm install
npm run build
npm run build:image   # builds the Docker image the agents run in
npm link              # puts `anton` on your PATH
```

## Commands

- `anton new "<description>" [--budget <usd>]` creates a project and writes its spec with you interactively. Afterwards, review and edit the acceptance checks in `spec.md`, then run `anton approve <name>`.
- `anton adopt <path> [--name <name>]` registers an existing git repo (its root) as a project. It changes nothing in the repo except ignoring `.anton/`.
- `anton change <project> "<what to change>" [--budget <usd>]` starts a change job on an adopted project (see Changing existing code).
- `anton secrets edit <project>` creates and opens the project's secrets file (see Secrets and redaction).
- `anton approve <project>` approves the spec (starts the background build) or the final delivery.
- `anton reject <project> --notes "<text>"` sends the delivery back to build with your notes.
- `anton resume <project> [--budget <usd>] [--accept-as-is]` continues a paused job; `--budget` raises the cap, `--accept-as-is` delivers despite failing checks.
- `anton accept-risk <project> <findingId> --reason "<text>"` records a security finding as an accepted risk (see Reviewers and security). Works while the job is paused or awaiting final review.
- `anton stop <project>` stops a running job (graceful, forced after 10s).
- `anton abandon <project>` gives up on the job and stops its container. For a change job it also switches the repo back to the branch you started from, if the repo is clean; if not, it prints the `git switch` command to run. The `anton/<jobId>` branch is kept.
- `anton status [project]` shows stage, round, spend and pause reason.
- `anton logs [-f] <project>` shows the current stage's log; `-f` follows it.

## How a job flows

spec -> you approve -> plan -> build <-> verify (checks, then code and security review; at most 3 rounds) -> report -> you approve or reject.

Rejecting returns the job to build with your notes. If a job pauses (round cap, budget cap, no progress, error), use `anton resume`.

Jobs started before Phase 2 (a `plan.json` whose tasks have no `area`) can't continue: run `anton abandon <project>` and start the job again.

## The team

Each agent role is a separate agent session with its own model and effort. QA is code-only in Phase 2: it runs no agent (the model listed is reserved for later). Coach is reserved and not used yet.

| Role | Does | Model | Effort |
|---|---|---|---|
| PM | Interviews you and writes the spec | claude-opus-5-5 | high |
| Tech lead | Plans the work into tasks, each tagged with an area, and writes the contract between areas | claude-opus-5-5 | medium |
| Infra developer | Builds the infra tasks | claude-sonnet-5-5 | medium |
| Backend developer | Builds the backend tasks | claude-sonnet-5-5 | medium |
| Frontend developer | Builds the frontend tasks | claude-sonnet-5-5 | medium |
| QA | Attributes failing checks to areas (code only in Phase 2, no agent) | claude-sonnet-5-5 (reserved) | medium |
| Code reviewer | Reviews the diff for correctness and design | claude-sonnet-5-5 | medium |
| Security reviewer | Reviews the diff and the scanner output | claude-sonnet-5-5 | high |
| Coach | Reserved, not used yet | claude-haiku-5-5 | low |

## Build order

Developers build one area at a time, in this order: infra, then backend, then frontend. A fix round sends each area only the failures attributed to it, in the same order. If a plan spans two or more areas it must carry a contract that the areas build against.

## When the reviewers run

Verify first runs the acceptance checks and the smoke run. If any of them fail, QA attributes the failures to areas and the reviewers are skipped: there is no point reviewing code that does not pass. When everything passes, the code reviewer and then the security reviewer examine the diff since the last reviewed commit. Their findings go to `evidence/results.json`, and the delivery report (`REPORT.md`) has a `## Code review` and a `## Security` section.

## Severity rules and `accept-risk`

- Code review: a `blocking` finding sends the job back to build. `non_blocking` findings are only listed in the report.
- Security: `critical` and `high` findings block. `medium` and `low` are only listed.
- `anton accept-risk <project> <findingId> --reason "<text>"` marks a security finding (an id like `SEC-1a2b3c4d`) as an accepted risk, with your reason. Accepted findings no longer block and the report shows them as accepted with the reason. Use it when a job pauses at the round cap or with no progress because of a security finding you decide to live with. The normal next step is `anton resume <project>`: it re-runs verify, the reviewers run again, and the accepted finding no longer blocks. `anton resume <project> --accept-as-is` instead delivers right away and ships any other blockers (failing checks, blocking code-review findings, other security findings) along with it. If you accept a risk after the report was written, it shows up after the next delivery.
- Scanner finding ids are computed from the scanner, rule and file, so they stay the same between rounds and an accepted scanner finding stays accepted. Ids of findings the security reviewer raises itself come from the file and the finding's title; the reviewer is shown the previous titles and told to reuse them, but if it rewords a title the finding gets a new id and has to be accepted again.
- gitleaks scans the whole git history, so a secret that was committed keeps being reported after the code is fixed. The fix is to rotate the secret, then accept the finding with `accept-risk`.
- Accepted risks recorded on scanner findings before v0.3.0 no longer match. Re-accept them with `anton accept-risk`.

## Security scanners

The scanners (gitleaks, osv-scanner and semgrep) are installed in the Docker image. A scanner that fails to run is listed in the report under "Scanners unavailable".

The image also holds the agent code itself (the in-container entry the reviewers and builders run through). After pulling an update, re-run `npm run build:image`: a stale image means old agent code, not just missing scanners, and old agent code would ignore the reviewers' read-only tool restriction. Anton fails closed on this: it refuses to start with `Kit image files are out of date — run: npm run build:image` when the staged files differ from `dist/agent/`, and stops an agent call with `agent entry is out of date (protocol …)` when the image's entry does not speak the current protocol.

## Web apps (the web kit)

Anton has two kits: `fallback` (any project, no browser) and `web` (adds Chromium and Playwright so an agent can open your app and look at it). During the spec session Anton detects which one fits and writes a `Kit:` line in `spec.md`. You can change it to `fallback` or `web` while you review the spec, before `anton approve` (checkpoint 1).

A web plan sets two extra commands: `serve` (starts the app, for example `python3 -m http.server 8080`) and `url` (where it listens, always `localhost` or `127.0.0.1` with a port). Anton starts `serve` in the container, waits for `url` to answer, then runs the browser checks.

Browser checks run only when all tests pass. The browser agent must not change project files: if it does, Anton reverts them and the round fails. Each check gets a `Browser` result in `REPORT.md` (`pass`, `fail`, `n/a`, or `-` when the browser step was never reached).

Screenshots are saved at `evidence/screens/<AC-id>.png` in the job folder and listed under `## Screenshots` in `REPORT.md`. They are not redacted: a page that shows a secret will have it in the picture, so look before you share them.

## Changing existing code

`anton change` needs a clean repo with at least one commit and no active job. It creates the branch `anton/<jobId>` and works only there; your original branch is never touched, and merging is up to you. `REPORT.md` says `Branch to merge: anton/<jobId>` and has a `## Regressions` section.

Don't edit files or switch branches in the repo while a change job runs: the working tree is shared. `approve`, `resume` and the runner refuse to act unless the repo is on the job branch, and the baseline refuses a tree with uncommitted changes. Accepting a change job switches the repo back to the branch you started from when it is clean.

Before the first build, the baseline stage runs the repo's tests and the scanners on the untouched code and saves what passed to `evidence/baseline.json`. Later, a baseline test that no longer passes is a regression and blocks the job like a failing check. Scanner findings that were already in the baseline are shown separately as `Pre-existing` in the report and do not block.

## Outside services: real or stand-in

Each acceptance check shows what it was proven against. A service is `real` only when a passing test labelled `[real]` names it; otherwise `REPORT.md` says `stand-in only`, meaning it was only tested against a fake.

## Secrets and redaction

`anton secrets edit <project>` opens a private file (`~/anton/secrets/<project>.env`, mode 0600) of `KEY=value` lines, for example `STRIPE_SECRET_KEY=your-key-here`. Values follow Docker env-file rules: `KEY=value`, no quotes, no spaces around `=`, no `export`. The values reach the job container as environment variables only. Every file anton writes (logs, evidence, `REPORT.md`) has those values replaced with a placeholder before it is saved.

## Plugins

Plugins (marketplace skills and tools) let agents use extra skills, for example a test-driven-development skill in build. Nothing loads unless you list it.

- `anton plugins add <plugin>@<owner>/<repo>` (or `<plugin>@<https git url>`) installs a plugin from its marketplace repo and pins it. Only relative-path, `github` and `url` plugin sources are supported; symlinks, sources that escape the repo, and silent re-pins are refused.
- `anton plugins list` shows what is pinned and what each stage, kit and role loads. It marks `NOT INSTALLED` entries and roles whose list is ignored, and shows `hooks: yes` or `hooks: no` for each installed plugin.
- `anton plugins update [name]` fetches the new version into a staging area. A read-only reviewer agent (budget $1) reads the diff of the files that can run code or steer the agent (hooks, scripts, executables, commands, agents, MCP/LSP and plugin manifests), and its findings are printed. The pin moves only if you type `y` or `yes` in a terminal; anything else keeps the old version.

Pins live in `~/anton/plugins.lock` (name, marketplace, version, commit, sha256). Each pinned version sits in its own folder, `~/anton/plugins/<marketplace>/<plugin>/<commit>/`, and is mounted read-only in the container at `/opt/anton/plugins`. If a plugin is missing or was edited, the job pauses with an error. Each job's `run-record.json` lists the plugin versions it used.

### Choosing what loads: `~/anton/config.yaml`

```yaml
stages:
  spec:   [superpowers:brainstorming]
  plan:   [superpowers:writing-plans]
  build:  [superpowers:test-driven-development, superpowers:systematic-debugging]
  verify: [superpowers:verification-before-completion, code-review]
kits:
  web:    [frontend-design, webapp-testing]
roles:
  frontend: [some-plugin]
```

An entry is `plugin` (the whole plugin) or `plugin:skill` (one skill). A `plugin:skill` entry hides the plugin's other skills, but that plugin's hooks, agents and commands still run in that session; only its MCP servers are left out. A `plugin:skill` entry naming a skill the plugin does not have stops the job with an error. `kits` apply in plan, build and verify. Each session gets only the plugins and skills it resolves to. Read-only roles (code reviewer, security reviewer, browser tester, mapper, plugin reviewer) never load plugins, whatever the config says. MCP servers come only from plugins listed for that stage, kit or role. A repo's own `.claude/settings.json`, `.claude/skills` and `.mcp.json` never load in any session; builders are told to read the repo's `CLAUDE.md` and `AGENTS.md` themselves.

### Unattended stages

Only spec talks to you. In every other stage no human is present, so the agent may not ask questions (the ask-the-user tool is blocked). It writes questions and the assumptions it made to `.anton/jobs/<jobId>/questions.md` and carries on. `REPORT.md` lists them under `## Questions and assumptions`: read them before you approve.

### Trust

Plugin code runs inside the job container with the same access as the builder agent: your repo and any project secrets. Only add plugins you trust, and read the review on every update.

### Caveman and Ponytail (optional, off by default)

Two community plugins aim to cut tokens: Caveman (`caveman@JuliusBrussee/caveman`) and Ponytail (`ponytail@DietrichGebert/ponytail`). If you want to try them, add them with `anton plugins add` and list them under the builder roles only:

```yaml
roles:
  frontend: [caveman, ponytail]
  backend:  [caveman, ponytail]
  infra:    [caveman, ponytail]
```

Use the bench below to measure each plugin's effect on quality and cost.

## Lessons

After a job ends, anton looks back at it and suggests small lessons for future jobs. Nothing is applied until you accept it.

- **When Retro runs:** once per job, on the final `anton approve` or on `anton abandon`. It makes one call to `claude-haiku-5-5` with a redacted record of the job (spec edits, failed checks, reject notes, reviewer findings, questions and assumptions, cost and tool use per stage; at most 60,000 characters). It costs cents.
- **How it is paid:** by default it goes through the Message Batches API at half price, and the results are collected later. Set `retro: { batch: false }` in `~/anton/config.yaml` to send it directly instead. The cost comes out of the retro share (5%, which may borrow what earlier stages left unspent) and the job cap. Without `ANTHROPIC_API_KEY`, or without enough budget, Retro is skipped with a reason. It never blocks approve or abandon.
- **`retro.json`:** in the job folder; its status is `submitted`, `done`, `failed` or `skipped` (with a reason).
- **What it proposes:** at most 5 lessons and 2 plugin suggestions per job.
- **`anton lessons review`:** collects finished Retros, then shows each proposal (target, text, why, source project and job) and asks accept, edit, reject or skip. With no terminal it only lists them. It ends with `Accepted N, rejected M, kept K.`
- **Plugin suggestions:** accepting one only prints the `anton plugins add` command. Nothing is installed and your config is not edited.
- **`anton lessons list`** shows each lesson file with its count out of 20 and the lesson ids. **`anton lessons remove <id>`** deletes one.
- **Where lessons live:** `~/anton/lessons/<file>.md`, for example `build-frontend.md` or `security-reviewer.md`. The folder is a git repo: each accept or remove is a commit. Each file holds at most 20 lessons, one line each, up to 300 characters.
- **Who sees what:** each agent gets only the file for its own role and the file for its kit, in the stable part of its system prompt. A job's `run-record.json` lists the lesson ids that were active.
- **Trust:** the job record is treated as data, and Retro's output is untrusted until you accept it.

## Scoreboard and bench

`anton lessons list --stats` shows the last 10 runs and compares averages with and without each lesson. It tracks the share of acceptance checks that passed on the first try, build and verify rounds, cost, and rejects at final review. The recent runs also show cache hit rates and identify bench jobs.

A lesson is flagged for possible removal after at least five runs with it and three without it if it shows no improvement in average first-try pass rate, rounds, or cost. Kit lessons are compared only within their kit. Results are noisy with few runs, so use the flag to decide whether to run `anton lessons remove <id>`.

The cache trend compares the average of the five latest recorded cache hit rates with the five before them. A drop of more than 15 percentage points triggers a warning.

- `anton bench --init` copies the bundled practice samples to `~/anton/bench/` and preserves local edits.
- `anton bench` runs all four samples one at a time with pre-approved specs. `--only cli-wordcount,change-greeting` runs just those samples.
- `--label <text>` names the run in the comparison. The comparison uses the most recent earlier run by default. Use `--compare <runId>` to choose one.
- Each run previews the estimated cost for each sample and the total before asking for confirmation. Enter `y` or `yes` to start. `--yes` skips the prompt and is required to start a run without a terminal.

The comparison prints in the terminal and is saved to `~/anton/bench/results/<runId>.md`. The raw results are in `<runId>.json` in the same directory. Bench jobs use disposable workspaces under `~/anton/bench/runs/<runId>/`, separate from your projects. Project cost estimates use regular job history only.

To measure Caveman or Ponytail, initialize the bench and install the plugin. Test one plugin at a time.

1. Run `anton bench --label baseline` with the plugin disabled.
2. Add the plugin under `roles:` for the `infra`, `backend` and `frontend` builders in `~/anton/config.yaml`.
3. Run `anton bench --label caveman-on` (or `anton bench --label ponytail-on`).
4. Read the comparison for changes in delivery, checks passing, first-try pass rate, rounds, cost and cache hit rate.
5. Keep the plugin or remove it from those roles based on the comparison.

## Slack team

The nine Anton roles each have their own Slack bot. Every job posts progress to one thread in a private project channel, whether you started it from the CLI or from Slack. Workspace updates go to private `#anton`. The CLI keeps working the whole time, and you can switch between the two at any checkpoint.

1. Use a dedicated Slack test workspace for the first setup. Copy its workspace ID and your member ID. In [Slack app settings](https://api.slack.com/apps), generate a configuration access token for that workspace.
2. Run `anton slack setup` in a terminal. It creates the nine apps and guides you through installing each app and creating an app-level token with the `connections:write` scope. Enter tokens at the hidden prompts. You can rerun setup to resume an interrupted installation. Setup shows any app or channel ID it needs you to confirm. Rerun setup to renew a role’s credentials or rebind the workspace channel, then restart the service.
3. Start `anton serve` in the foreground and run a small CLI job. Check that the PM and other roles post under their own names in the project thread. The service connects outward, and your job can keep running while the service is stopped.
4. On macOS, run `anton slack service install` to start the service at login. Run `anton slack service status` to check it, or `anton slack service uninstall` to remove it. Service logs live under `~/anton/slack/logs/`.

#### The LaunchAgent, Docker and the API key

A LaunchAgent starts with almost no environment, so install and `anton serve` set up what job controls need:

- **PATH.** `install` finds `docker` on your PATH (or in `/usr/local/bin`, `/opt/homebrew/bin` or Docker Desktop's app folder) and writes its folder, the folder of the `node` running Anton, and `/usr/bin:/bin:/usr/sbin:/sbin` into the agent's PATH. If it cannot find `docker`, install stops and says so. If you move Docker or Node later, run install again.
- **API key.** `anton serve` uses `ANTHROPIC_API_KEY` from its environment. If that is not set, as under the LaunchAgent, it reads the macOS Keychain item `anthropic-api-key` for your user and keeps the key in memory only. Job runs and spec turns started by the service get it from there. The key is never written to the plist, a file or a log. Store it once with:

  ```sh
  security add-generic-password -a "$USER" -s anthropic-api-key -w
  ```

  (`-w` with no value prompts for the key, so it doesn't land in your shell history.)
- **Runs outlive the service.** The agent sets `AbandonProcessGroup`, so a job run started from Slack keeps going if the service stops or restarts.
- `anton slack service status` reports whether `docker` was found on the service PATH and whether the Keychain item exists. It never prints the key.

#### Upgrading

- After upgrading Anton, restart `anton serve`. If you use the LaunchAgent, reinstall it so it gets the new PATH and settings: `anton slack service uninstall`, then `anton slack service install`.
- Existing Slack apps from the first Slack release need no new setup.
- Install now needs `docker` on your PATH (see above).
- A spec or delivery that was already waiting before the upgrade has no card. Its thread says to approve it on the Mac with `anton approve <project>`; do that there.

Credentials live in owner-only files under `~/anton/slack/`. Pending updates stay on disk through a restart. Use `anton slack outbox` to see delivery counts and updates that need attention. If Slack restricts a channel invitation, add the owner and role apps to the private channel in Slack. When Slack cannot confirm an operation, Anton records it for review and holds later updates to that channel. Use `anton slack resolve recheck <id>` to look for the existing post again, or `anton slack resolve retry <id>` for a confirmed delivery failure. A private project channel can be verified by explicit ID with `bind-channel`. For an uncertain parent post, `confirm-thread` takes the Slack message timestamp and verifies the sender and delivery marker.

Slack receives milestone summaries and a sanitized copy of the generated spec. To share a QA screenshot, open it locally first, then run `anton slack share-screenshot <project> <check-id>`. Anton queues only the validated image you select. The repo and raw logs stay on your Mac.

### Running jobs from Slack

Only the owner set during `anton slack setup` can change a job. Everyone else gets "Only the Anton owner can do that here."

- `/anton new <description>` in `#anton` starts a project. `/anton change <description>` in a project channel starts a change job.
- The PM asks its spec questions in the job thread. Reply in the thread (number your answers when there are several). A reply that mentions another role or person (for example `@Anton QA what does AC-2 mean?`) is a question for them, not your answer. The spec waits as long as you need, with one reminder after 24 hours. If the service stops in the middle of a PM turn, the thread gets one notice; rerun the turn with `/anton spec retry` or `anton spec <project> --retry`. You can also answer in the terminal with `anton spec <project>`.
- The spec card has **Approve spec** and **Request changes…**. The delivery card has **Approve delivery**, **Reject…** and **Accept risk…** for each open security finding. A paused job gets **Resume…** and **Abandon**, whatever paused it (budget, an error, no progress, the round limit or `anton stop`). Lesson proposals from the Coach in `#anton` get **Accept**, **Edit…** and **Reject**.
- A card acts once. A card for an older spec, delivery or pause says it is out of date and changes nothing. A decision made in the CLI makes the matching card out of date too.
- `/anton status`, `/anton resume [budget <usd>] [accept-as-is]`, `/anton abandon <job id>` and `/anton spec retry` work in the project channel. `/anton help` lists them.

### Asking the team

Mention a role bot in a project channel to ask about that project, for example `@Anton QA why is AC-2 failing?`. The bot you mention answers, privately to you, in the channel or thread.

- **Status** questions ("what's the status?", "how much has it spent?") are answered from the job records. They are free.
- **Explanations** ("how does the streak counter work?") go to Claude Haiku 5.5 with short excerpts of the spec, plan and failure report.
- **Evidence** questions (about logs, errors, failing tests) go to Claude Sonnet 5.5 with the ends of the job logs and the failure report.

Each answer is one model call with a hard output limit and no tools. The bots cannot change anything, and the excerpts come only from that project. Secret values and tokens are removed before the call and again before the answer is posted. Mentions and links are removed from both the question and the answer.

Who can ask: members of the project's private channel, checked by Slack user ID on every question. Members can also run `/anton status` there. Shared (Slack Connect) channels get no answers. A question in `#anton` or in a DM gets a pointer to the right project channel, and only if you are a member of it. A question that names more than one project gets no project data.

Paid answers have their own budget, separate from job budgets. Before each call, Anton reserves the most that call could cost. When the call returns, it books the reported cost instead. If the API definitely rejected the call (status 400, 401, 403, 404 or 422), nothing is booked and the service log says why. If the outcome is unknown (a crash, a network error, a rate limit or a server error), the full reservation stays booked and the call is not retried. When the month's budget cannot cover an answer, or `anton serve` has no API key (from its environment or the Keychain), you get the free status instead. Defaults, in `~/anton/config.yaml`:

```yaml
chat:
  monthlyUsd: 5        # per UTC calendar month; 0 turns paid answers off
  perAnswerUsd: 0.10   # an answer whose worst case is above this gets the status instead
```

The ledger is `~/anton/slack/chat-budget.json`.

### Testing Slack

Use `ANTON_HOME` with a separate local data directory when testing a different workspace. After setup, you can verify all nine identities with the opt-in Slack smoke test below. It creates one private channel and posts synthetic messages. You can archive the channel after checking the thread.

```sh
ANTON_SLACK_E2E=1 ANTON_SLACK_TEST_HOME=/path/to/test-home ANTON_SLACK_TEST_TEAM_ID=your-test-workspace-id \
  npx vitest run tests/e2e/slack-service.e2e.test.ts
```

The workflow test covers both front ends with fake agents. With `ANTON_E2E=1` alone it runs against a fake workspace, for free: a Slack-started spec approved in the CLI, a CLI job approved from its Slack card, role questions, permissions, replayed deliveries and a reconnect. With the same Slack variables as above it also runs in the test workspace: the nine bots connect, membership is checked live, a card thread is posted and the service reconnects. Slack cannot send a person's clicks for a test, so those inputs are made up from the workspace's real IDs. Click a card yourself once to check the real button path. A separate opt-in makes one real paid answer (about $0.01):

```sh
ANTON_E2E=1 npx vitest run tests/e2e/slack-workflow.e2e.test.ts
ANTON_CHAT_PAID_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/slack-workflow.e2e.test.ts
```

## Where things live

- Projects: `~/anton/projects/<name>/` (override the root with `ANTON_HOME`), each a git repo with one commit per plan task.
- Job files: `<repo>/.anton/jobs/<id>/` holding `state.json`, `spec.md`, `plan.json`, `logs/`, `evidence/results.json` (plus one `results-verify-<n>.json` copy per verify) and `REPORT.md`.

## Budgets

Each job has a spend cap of $10 by default (`--budget` on `new`/`resume`). A warning is raised at 80%; hitting the cap pauses the job.

### Allowances per stage

The job cap is split across stages: spec 10%, plan 10%, build 50%, verify 25%, retro 5%. A stage may spend its own share plus whatever earlier stages left unused (order: spec, plan, build, verify, retro; baseline counts as plan, deliver as verify). Example: on a $10 job, if spec spent $0.40 and plan $0.30, build can spend up to $7.00 - $0.70 = $6.30. Verify's spending never counts against build.

Retro's 5% can't be used until Retro exists (Phase 5), so a job pauses at 95% of its cap, in verify.

When a stage's share runs out, the job pauses with reason `allowance` and a notification. The message names the cumulative share, for example `build share used: $7.00 of $7.00 (spec through build)`. `anton resume <project> --budget <usd>` raises the cap, and so every share; plain `resume` refuses and tells you this. The spec stage only warns, because you are at the keyboard; spec overspend counts against the job cap but never against later shares. The 80% warning still applies.

### Config keys

In `~/anton/config.yaml`:

```yaml
budget:
  defaultUsd: 10          # default job cap, must be above 0
  allowances: { spec: 10, plan: 10, build: 50, verify: 25, retro: 5 }   # all five, whole percentages summing to 100
  taskBudgets: true       # set false to turn task budgets off
```

### Task budgets

Each agent session is also told a token budget: the smaller of 5,000,000 and the session's remaining dollar budget divided by the model's input price per token. This lets the agent pace itself. Below the API minimum of 20,000 tokens no task budget is sent; the dollar cap still applies. Set `budget.taskBudgets: false` to turn it off.

### Cache hit rate

Prompts are kept stable so the API can reuse them cheaply. `anton status` shows a CACHE column (for example `cache 62%`), and the cost table in `REPORT.md` has a `Cache hit` column. The raw numbers are in the job folder's `usage.json`. Hit rate = cache reads / (input + cache reads + cache writes).

### Cost estimate

When the spec is written, `spec.md` shows `Expected cost: $a–$b (from N similar past jobs)`, or `Expected cost: no history yet`. Similar means the same kit and kind, with an acceptance-check count within 50% of this one, and at least 3 such jobs; the range is the middle half (25th to 75th percentile). It is computed once, so editing the Kit or the checks before you approve does not update it.

### Job history

`~/anton/history.jsonl` gets one line per finished job (the last delivery wins): job id, project name, kind, kit, number of checks, total and per-stage cost, cache hit rate and date. It never stores the description, the spec text or secrets.

## Tests

```sh
npm test                                   # unit tests, no Docker or API needed
ANTON_E2E=1 npm run test:e2e               # also runs Docker-only e2e tests
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/new-project.e2e.test.ts
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/change-job.e2e.test.ts   # adopts a tiny repo, runs a change
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/plugins.e2e.test.ts      # a builder session loads a fixture plugin
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/web-job.e2e.test.ts      # builds a static web page, checks Kit: web and a screenshot in REPORT.md
```

The last one builds a real project end to end with the API and costs up to about $3, and checks that REPORT.md has the `## Code review` and `## Security` sections. It runs only when BOTH `ANTON_E2E=1` and `ANTHROPIC_API_KEY` are set; with `ANTON_E2E=1` alone (no key), only the Docker-only e2e tests run and it is skipped.

## Limits

Two kits (fallback and web), job controls from the CLI and from Slack, and role Q&A in Slack. See the [roadmap](docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md).

## License

MIT. See [LICENSE](LICENSE).
