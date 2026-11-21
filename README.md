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

Their effect on quality and cost has not been measured yet; that comes with the Phase 5 bench.

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

Two kits (fallback and web), CLI only, no Slack yet. See the [roadmap](docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md).

## License

MIT. See [LICENSE](LICENSE).
