# Son of Anton

Local software factory: `anton` CLI runs AI agents in Docker. Design: docs/specs/. Roadmap, per-phase plans and follow-ups: docs/superpowers/plans/.

## Commands
- Test all: `npm test` · one file: `npx vitest run tests/<path>.test.ts`
- Type check: `npx tsc --noEmit` · build: `npm run build`
- Kit image: `npm run build:image` (required after changing src/agent/* or src/kits/fallback/Dockerfile)
- Docker e2e: `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`
- Paid API e2e (~$3): same with ANTHROPIC_API_KEY set, `npm run test:e2e`

## Rules
- Every external effect (agent calls, docker, git, notify, spawn) is injectable via a `deps` param; unit tests never touch real Docker or the API.
- State and evidence writes go through `writeFileAtomic` (src/core/atomic.ts).
- Host git only through src/core/git.ts (it blocks repo hooks and config).
- Agent structured output: zod schema is the source of truth; JSON Schema must have an object root.
- Reviewer sessions stay read-only: `tools` list plus MCP/settings isolation in src/agent/entry.ts. Don't loosen it.
- Prompts live in src/stages/prompts/ and load via package-root URLs so they work from src/ and dist/.

## Gotchas
- A stale kit image fails closed ("run npm run build:image"); that's intended.
- Public repo: test fixtures must not contain real-looking secrets.
- Jobs started before Phase 2 (plan.json without `area`) must be abandoned and restarted.
