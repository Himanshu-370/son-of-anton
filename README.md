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
- `anton approve <project>` approves the spec (starts the background build) or the final delivery.
- `anton reject <project> --notes "<text>"` sends the delivery back to build with your notes.
- `anton resume <project> [--budget <usd>] [--accept-as-is]` continues a paused job; `--budget` raises the cap, `--accept-as-is` delivers despite failing checks.
- `anton accept-risk <project> <findingId> --reason "<text>"` records a security finding as an accepted risk (see Reviewers and security). Works while the job is paused or awaiting final review.
- `anton stop <project>` stops a running job (graceful, forced after 10s).
- `anton abandon <project>` gives up on the job and stops its container.
- `anton status [project]` shows stage, round, spend and pause reason.
- `anton logs [-f] <project>` shows the current stage's log; `-f` follows it.

## How a job flows

spec -> you approve -> plan -> build <-> verify (at most 3 rounds) -> report -> you approve or reject.

## The team

Each role is a separate agent session with its own model and effort.

| Role | Does | Model | Effort |
|---|---|---|---|
| PM | Interviews you and writes the spec | claude-opus-5-5 | high |
| Tech lead | Plans the work into tasks, each tagged with an area, and writes the contract between areas | claude-opus-5-5 | medium |
| Infra developer | Builds the infra tasks | claude-sonnet-5-5 | medium |
| Backend developer | Builds the backend tasks | claude-sonnet-5-5 | medium |
| Frontend developer | Builds the frontend tasks | claude-sonnet-5-5 | medium |
| QA | Attributes failing checks to areas | claude-sonnet-5-5 | medium |
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
- `anton accept-risk <project> <findingId> --reason "<text>"` marks a security finding (an id like `SEC-1a2b3c4d`) as an accepted risk, with your reason. Accepted findings no longer block and the report shows them as accepted with the reason. Use it when a job pauses at the round cap or with no progress because of a security finding you decide to live with, then `anton resume <project> --accept-as-is`. If you accept a risk after the report was written, it shows up after the next delivery.
- Finding ids are stable between rounds, so a risk you accept stays accepted.

## Security scanners

The scanners (gitleaks, osv-scanner and semgrep) are installed in the Docker image. A scanner that fails to run is listed in the report under "Scanners unavailable".

The image also holds the agent code itself (the in-container entry the reviewers and builders run through). After pulling an update, re-run `npm run build:image`: a stale image means old agent code, not just missing scanners, and old agent code would ignore the reviewers' read-only tool restriction. Anton fails closed on this: it refuses to start with `Kit image files are out of date — run: npm run build:image` when the staged files differ from `dist/agent/`, and stops an agent call with `agent entry is out of date (protocol …)` when the image's entry does not speak the current protocol.

Rejecting returns the job to build with your notes. If a job pauses (round cap, budget cap, no progress, error), use `anton resume`.

## Where things live

- Projects: `~/anton/projects/<name>/` (override the root with `ANTON_HOME`), each a git repo with one commit per plan task.
- Job files: `<repo>/.anton/jobs/<id>/` holding `state.json`, `spec.md`, `plan.json`, `logs/`, `evidence/results.json` and `REPORT.md`.

## Budgets

Each job has a spend cap of $10 by default (`--budget` on `new`/`resume`). A warning is raised at 80%; hitting the cap pauses the job.

## Tests

```sh
npm test                                   # unit tests, no Docker or API needed
ANTON_E2E=1 npm run test:e2e               # also runs Docker-only e2e tests
ANTON_E2E=1 ANTHROPIC_API_KEY=... npx vitest run tests/e2e/new-project.e2e.test.ts
```

The last one builds a real project end to end with the API and costs up to about $3, and checks that REPORT.md has the `## Code review` and `## Security` sections. It runs only when BOTH `ANTON_E2E=1` and `ANTHROPIC_API_KEY` are set; with `ANTON_E2E=1` alone (no key), only the Docker-only e2e tests run and it is skipped.

## Phase 1 limits

Fallback kit only, CLI only, new projects only, no Slack yet. See the [roadmap](docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md).
