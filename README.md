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
- `anton stop <project>` stops a running job (graceful, forced after 10s).
- `anton abandon <project>` gives up on the job and stops its container.
- `anton status [project]` shows stage, round, spend and pause reason.
- `anton logs [-f] <project>` shows the current stage's log; `-f` follows it.

## How a job flows

spec -> you approve -> plan -> build <-> verify (at most 3 rounds) -> report -> you approve or reject.

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

The last one builds a real project end to end with the API and costs up to about $3. It runs only when BOTH `ANTON_E2E=1` and `ANTHROPIC_API_KEY` are set; with `ANTON_E2E=1` alone (no key), only the Docker-only e2e tests run and it is skipped.

## Phase 1 limits

Fallback kit only, CLI only, new projects only, no Slack yet. See the [roadmap](docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md).
