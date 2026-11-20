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

## Where things live

- Projects: `~/anton/projects/<name>/` (override the root with `ANTON_HOME`), each a git repo with one commit per plan task.
- Job files: `<repo>/.anton/jobs/<id>/` holding `state.json`, `spec.md`, `plan.json`, `logs/`, `evidence/results.json` (plus one `results-verify-<n>.json` copy per verify) and `REPORT.md`.

## Budgets

Each job has a spend cap of $10 by default (`--budget` on `new`/`resume`). A warning is raised at 80%; hitting the cap pauses the job.

## Tests

```sh
npm test                                   # unit tests, no Docker or API needed
ANTON_E2E=1 npm run test:e2e               # also runs Docker-only e2e tests
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/new-project.e2e.test.ts
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/change-job.e2e.test.ts   # adopts a tiny repo, runs a change
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/web-job.e2e.test.ts      # builds a static web page, checks Kit: web and a screenshot in REPORT.md
```

The last one builds a real project end to end with the API and costs up to about $3, and checks that REPORT.md has the `## Code review` and `## Security` sections. It runs only when BOTH `ANTON_E2E=1` and `ANTHROPIC_API_KEY` are set; with `ANTON_E2E=1` alone (no key), only the Docker-only e2e tests run and it is skipped.

## Limits

Two kits (fallback and web), CLI only, no Slack yet. See the [roadmap](docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md).
