# Son of Anton

Local software factory: `anton` CLI runs AI agents in Docker. Design: docs/specs/. Roadmap, per-phase plans and follow-ups: docs/superpowers/plans/.

## Commands
- Test all: `npm test` · one file: `npx vitest run tests/<path>.test.ts`
- Type check: `npx tsc --noEmit` · build: `npm run build`
- Kit images: `npm run build:image` builds both the fallback and web images (required after changing src/agent/* or either kit's Dockerfile)
- Docker e2e: `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`
- Paid API e2e (~$3): same with ANTHROPIC_API_KEY set, `npm run test:e2e`
- Cheapest real end-to-end check is `anton bench --only cli-wordcount`.

## Rules
- Every external effect (agent calls, docker, git, notify, spawn) is injectable via a `deps` param; unit tests never touch real Docker or the API.
- State and evidence writes go through `writeFileAtomic` (src/core/atomic.ts).
- Host git only through src/core/git.ts (it blocks repo hooks and config).
- Agent structured output: zod schema is the source of truth; JSON Schema must have an object root.
- Reviewer sessions stay read-only: `tools` list plus MCP/settings isolation in src/agent/entry.ts. Don't loosen it.
- Plugins load only through `pluginsForSession` (src/plugins/session.ts); read-only sessions never load them.
- Secret values are redacted via `redact()` in src/core/secrets.ts; new save points must use it.
- System prompts hold only stable text; changing values go in the user prompt (the prompt-stability test enforces this).
- Prompts live in src/stages/prompts/ and load via package-root URLs so they work from src/ and dist/.
- Lessons reach agents only through `lessonsBlock` in the stable system prompt; Retro output is untrusted until you accept it.

## Gotchas
- A stale kit image fails closed ("run npm run build:image"); that's intended.
- Public repo: test fixtures must not contain real-looking secrets.
- Jobs started before Phase 2 (plan.json without `area`) must be abandoned and restarted.
