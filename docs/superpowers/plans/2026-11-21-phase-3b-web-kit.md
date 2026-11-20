# Phase 3b: Web Kit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the second kit, `web`. It does everything the fallback kit does. It also starts the app in the container and has an agent exercise each acceptance check in headless Chromium through Playwright, saving screenshots as evidence. The phase also fixes the "Do first" items from Phase 3a.

**Architecture:**
- Kits live in a registry (`src/kits/index.ts`). During the spec session, code (not the PM agent) picks the kit with `detect`. The choice is written into `spec.md`, where you can change it at checkpoint 1. The runner then uses the approved kit.
- The web image is built `FROM` the fallback image and adds Playwright and Chromium.
- Web verify runs the fallback verify first. Only when every check passes does it start the app (`commands.serve`), wait for `commands.url`, and run a `browser_tester` agent session. The browser results then merge into the check results.

**Tech Stack:** TypeScript ESM, vitest, zod, execa, Docker, Playwright 1.50.1 (Chromium only), Claude Agent SDK in the container.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md`: §8 (kits, web kit), §6.4 (verify), §9 (sandbox). Phase 3a follow-ups: `docs/superpowers/plans/2026-11-21-phase-3a-followups.md` ("Do first").

## Global Constraints

- Kit interface per §8: `detect(description, folder)` → confidence 0..1; the highest confidence wins, with fallback when no kit is confident. The confidence threshold is 0.5.
- Web kit (§8): "everything fallback does, plus starts the app in the container and has an agent exercise each acceptance check in a headless browser (Playwright), with screenshots as evidence. Image includes Node + Playwright."
- §8 trust: the kit module runs on the host, and everything it executes (starting the app, the browser) runs inside the project's container. `detect` reads only the description and file listings, never file contents.
- The kit choice appears in `spec.md` and can be changed at checkpoint 1.
- Playwright is pinned to `1.50.1` with Chromium only. Browsers go in `/ms-playwright` (`PLAYWRIGHT_BROWSERS_PATH`).
- The browser agent runs only when every fallback check passes and `runOk` is true. That costs nothing extra on failing rounds, following the same rule the reviewers use.
- The browser agent role is `browser_tester`, using `claude-sonnet-5-5` at `medium` effort with `maxTurns: 60`. Its tools are `['Bash', 'Read', 'Glob', 'Grep']`, and setting `tools` triggers the MCP and settings isolation already in `src/agent/entry.ts`.
- Screenshots go to `<jobDir>/evidence/screens/<AC-id>.png`, which is under `.anton/` and therefore never committed.
- Existing rules from CLAUDE.md apply:
  - Effects go through `deps`.
  - Saves go through `writeFileAtomic` and `redact()`.
  - Host git goes only through `src/core/git.ts`.
  - zod is the source of truth, and every JSON Schema has an object root.
  - Fixtures are obviously fake.

## Review Focus

1. **The browser agent edits project files.** It has Bash, so it can. Expected: any repo change it makes is reverted and reported as a browser failure. It must never be committed by the next build round. (Task 6)
2. **The app never becomes ready, or `serve` exits at once.** Expected: every check fails with `run_failed` and a tail of `app.log`. No browser agent is started, and no app process is left running. (Task 6)
3. **The kit was changed at checkpoint 1 while a fallback container is already running.** Expected: the runner restarts the container on the web image instead of running browser checks in an image with no Chromium. (Task 4)
4. **An older job with no `kit` field in spec.json, or with `kit: "fallback"`, is resumed.** Expected: it loads as `fallback` and runs exactly as before. (Task 4)
5. **An acceptance check with no UI part on a web project, such as an API-only check.** Expected: the agent may mark it `n/a`, which neither passes nor fails it. Only `fail` turns a passing check into a failure. (Task 6)

---

### Task 1: Secret guard on added lines, stable gitleaks keys

**Files:**
- Modify: `src/core/git.ts` (the staged-diff secret guard), `src/security/scanners.ts:75`
- Test: `tests/core/git.test.ts`, `tests/security/scanners.test.ts` (create it if missing; scanner tests may live in `tests/security/review.test.ts`)

**Interfaces:**
- Produces: the guard inspects only added lines (`+` lines, excluding the `+++` header) of `git diff --cached`. `SecretInDiff` still names keys only.
- Produces: the gitleaks `key` becomes `sha8(file + '\n' + ruleId + '\n' + sha256(Secret))` when `Secret` is a non-empty string. Otherwise the existing fallback applies. The secret value is never stored, only its hash.

- [ ] **Step 1: Write the failing tests.**
  - `'staged removal of a line holding a secret value is allowed'`
  - `'secret in unchanged context lines does not block'`
  - `'added line with the secret still blocks, naming the key only'`
  - `'gitleaks key is stable when the finding moves to another line'`: two reports of the same Secret at StartLine 3 and at 9 give an equal `key`
  - `'gitleaks key never contains the secret'`
- [ ] **Step 2:** Run `npx vitest run tests/core/git.test.ts tests/security/scanners.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Add a `shortcut:` comment on the guard noting that binary files are not inspected.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `fix(secrets): guard only added lines; stable gitleaks keys`.

### Task 2: Branch-guard rough edges

**Files:**
- Modify: `src/pipeline/runner.ts` (the `assertOnJobBranch` call), `src/cli/commands/resume.ts`, `src/cli/commands/approve.ts`, `README.md`
- Test: `tests/pipeline/runner.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `assertOnJobBranch(job)` from `src/core/job.ts`.
- Produces:
  - The runner's wrong-branch refusal moves inside the runner's inner try, before any container start. The job pauses with `error`, `error.log` is written, and a notification is sent, as for any other stage error.
  - `resume` checks "Nothing to resume" (stage `done` / `abandoned`) before checking the branch.
  - The final accept (at `awaiting_final_review`) skips `assertOnJobBranch`, because it makes no commit. Spec approval keeps the check.
  - README gets a single line: accepted risks recorded on scanner findings before v0.3.0 no longer match. Re-accept them with `anton accept-risk`.

- [ ] **Step 1: Write the failing tests.**
  - `'runner on wrong branch pauses with error and notifies'`: state is `paused`, `pausedFrom` is the stage, `error.log` exists, and the notify fake is called
  - `'resume of a done change job says nothing to resume even off-branch'`
  - `'final accept works after the user switched to main'`
  - `'spec approval off-branch still refuses'`
- [ ] **Step 2:** Run `npx vitest run tests/pipeline/runner.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `fix(cli): branch guard pauses visibly; accept and resume edge cases`.

### Task 3: Web kit image

**Files:**
- Create: `src/kits/web/Dockerfile`, `src/kits/web/index.ts` (skeleton: `verify` and `baseline` delegate to the fallback kit for now)
- Modify: `src/kits/types.ts`, `src/docker/container.ts:83-104` (`ensureImage`), `scripts/build-image.mjs`
- Test: `tests/docker/container.test.ts`, `tests/e2e/docker.e2e.test.ts`

**Interfaces:**
- Produces:
  - `Kit` gains `base?: Kit`. `webKit` has `name: 'web'` and `base: fallbackKit`.
  - `ensureImage(kit, exec)`: when `kit.base` is set, it first ensures the base image. It then builds with `--build-arg BASE=<baseTag>`. The tag hash covers the kit's Dockerfile plus the base tag, so a new fallback image produces a new web tag.
  - `src/kits/web/Dockerfile`:
    - `ARG BASE`, `FROM ${BASE}`
    - `ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright NODE_PATH=/usr/local/lib/node_modules`
    - `RUN npm i -g playwright@1.50.1 && npx playwright install --with-deps chromium`
    - nothing else
  - `scripts/build-image.mjs` builds fallback and then web, printing both tags.

- [ ] **Step 1: Write the failing tests.**
  - `'ensureImage builds the base first and passes BASE build-arg'`
  - `'web tag changes when the base tag changes'`
  - Docker e2e, under `ANTON_E2E`: `'web image can launch chromium'`. Run `node -e "require('playwright').chromium.launch().then(b=>b.close())"` in a web container. Expect exit 0.
- [ ] **Step 2:** Run `npx vitest run tests/docker`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run build:image`, then `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`, then the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kits): web kit image with Playwright`.

### Task 4: Kit registry, selection and the runner's kit

**Files:**
- Create: `src/kits/index.ts`
- Modify:
  - `src/kits/types.ts` (`detect` signature), `src/kits/fallback/index.ts`, `src/kits/web/index.ts`
  - `src/stages/spec.ts` (schema and `renderSpec` / `readApprovedSpec`)
  - `src/cli/spec-session.ts`
  - `src/pipeline/runner.ts` (`startOrReuseContainer`, kit choice), `src/cli/deps.ts:108`
- Test: `tests/kits/registry.test.ts`, `tests/stages/spec.test.ts`, `tests/pipeline/runner.test.ts`

**Interfaces:**
- Produces:
  - `detect(description: string, files: string[]): number`. `files` holds repo-relative paths from `git ls-files`, capped at 2000. It is `[]` for a new project.
  - Fallback `detect` returns `0.1`.
  - Web `detect`:
    - returns `0.9` when `files` contains any of `next.config.*`, `vite.config.*`, `svelte.config.*`, `nuxt.config.*`, `angular.json`, `*.tsx`, `*.jsx`, `*.vue`, `*.svelte`, `index.html`
    - otherwise returns `0.8` when the description matches `/\b(web ?app|website|web page|frontend|front-end|react|next\.js|vue|svelte|dashboard|landing page|browser)\b/i`
    - otherwise returns `0`
  - `KITS = [webKit, fallbackKit]`.
  - `selectKit(description, files): Kit` returns the highest-scoring kit, or fallback when the top score is below 0.5.
  - `kitByName(name: 'fallback' | 'web'): Kit`.
  - `SpecDoc.kit` becomes `z.enum(['fallback', 'web']).default('fallback')`.
  - The spec session sets `kit` from `selectKit` after the PM agent returns, so the agent no longer chooses it.
  - The spec prompt line about `kit` is removed.
  - `renderSpec` adds a `Kit: web` line under the title. `readApprovedSpec` reads that line, and an edited value wins. An unknown value throws `Unknown kit "<x>" in spec.md (use fallback or web)`.
  - Runner:
    - The kit is `kitByName(spec.kit)` from the approved spec. `deps.kit` still overrides it in tests.
    - `startOrReuseContainer(slug, repo, kit, exec)` reuses a running container only when `docker inspect -f {{.Config.Image}}` equals the kit's image tag. Otherwise it stops that container and starts a fresh one.
  - The spec session still starts its container on the fallback image, since the spec stage needs no browser.

- [ ] **Step 1: Write the failing tests.**
  - `'files with next.config.js select web'`
  - `'web-ish description with no files selects web'`
  - `'CLI description selects fallback'`
  - `'spec.md Kit line round-trips; edited value wins'`
  - `'unknown kit in spec.md throws'`
  - `'old spec.json without kit loads as fallback'`
  - `'running container on another image is replaced'`
  - `'running container on the kit image is reused'`
- [ ] **Step 2:** Run `npx vitest run tests/kits tests/stages/spec.test.ts tests/pipeline`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kits): kit registry, detection and per-job kit`.

### Task 5: Serve command and URL in the plan

**Files:**
- Modify: `src/kits/types.ts` (`Commands`), `src/stages/plan.ts` (`CommandsSchema`, render), `src/stages/prompts/plan.md`, `src/stages/prompts/build.md`, `src/stages/prompts/role-frontend.md`
- Test: `tests/stages/plan.test.ts`

**Interfaces:**
- Produces:
  - `Commands` gains `serve?: string` and `url?: string`. The zod schema requires `url` to match `/^http:\/\/(localhost|127\.0\.0\.1):\d+(\/.*)?$/`, and requires both `serve` and `url` together when either is set.
  - When the job's kit is `web`, the plan prompt says that `serve` and `url` are required. `serve` must run the app in the foreground on a fixed port and bind to `0.0.0.0` or `localhost`. Plan reads the kit from `spec.kit`; `runPlan` already receives the spec.
  - `runPlan` rejects a web-kit plan that lacks `serve` with `Web kit plans must set commands.serve and commands.url`.
  - The frontend prompt says acceptance checks with a UI part are also exercised in a browser, so keep visible text and labels stable.
- [ ] **Step 1: Write the failing tests.**
  - `'web plan without serve is rejected'`
  - `'non-localhost url is rejected'`
  - `'fallback plan without serve is fine'`
  - `'plan.md renders serve and url'`
  - `'plan prompt mentions serve only for web kit'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plan): serve command and url for web projects`.

### Task 6: Web verify with browser checks and screenshots

**Files:**
- Create: `src/kits/web/browser.ts`, `src/stages/prompts/browser-tester.md`
- Modify:
  - `src/kits/web/index.ts` (`verify`)
  - `src/kits/types.ts` (`CheckResult`, `VerifyContext`)
  - `src/core/config.ts` (role `browser_tester`)
  - `src/core/git.ts` (snapshot and restore helpers)
  - `src/stages/verify.ts` (pass `StageCtx` to the kit)
- Test: `tests/kits/web.test.ts`

**Interfaces:**
- Consumes: `runAgent(ctx, req)` from `src/agent/host-runner.ts`, `fallbackKit.verify`, `Commands.serve` and `Commands.url`.
- Produces:
  - `VerifyContext` gains `stage?: StageCtx`, which the web kit needs to run an agent. `runVerify` passes `ctx`.
  - `CheckResult` gains `browser?: { status: 'pass' | 'fail' | 'n/a'; note: string; screenshot?: string }`.
  - `webKit.verify(ctx, deps)` runs `fallbackKit.verify` first. If any check fails or `runOk` is false, it returns that result unchanged. Otherwise it runs the steps below.
  - **Start the app.** Run `setsid sh -c '<serve>' > <evidence>/app.log 2>&1 & echo $! > /tmp/anton-app.pid` in the container. Then poll `curl -fsS -o /dev/null <url>` every 1 s, for up to 60 s.
  - **If the app is not ready:** every check becomes `fail` / `run_failed` with `error` set to the last 40 lines of the redacted `app.log`. `runOk` becomes false, and the failure report gets `### App did not start`.
  - **Browser session.** Snapshot `git status --porcelain` (ignoring `.anton/`). Then run one `runAgent` call:
    - `role: 'browser_tester'`, `tools: ['Bash','Read','Glob','Grep']`, `maxTurns: 60`
    - prompt from `browser-tester.md`, given the url, the checks and the screens path
    - output schema `{ checks: [{ id, status: 'pass'|'fail'|'n/a', note }] }`
  - **The agent's job:** write throwaway scripts only under `/tmp`, use `require('playwright')`, and save `/workspace/.anton/jobs/<id>/evidence/screens/<AC-id>.png` for every check it marks `pass` or `fail`.
  - **Always, in `finally`:** kill the process group (`kill -- -$(cat /tmp/anton-app.pid)`) and compare a new porcelain snapshot with the old one. For any path that is new or changed, restore it: tracked paths with `git checkout -- <path>`, new untracked paths with removal. Use a new `restorePaths(repo, paths)` in git.ts. When anything was restored, every check gets `browser.status = 'fail'` with the note `Browser agent changed project files: <paths>`.
  - **Merge.** A check passes only if its tests pass and `browser.status` is not `fail`. A check missing from the agent's output counts as `fail` with the note `not exercised`. `screenshot` is set when the file exists. Browser failures appear in the failure report as `### <id>: browser` with the note.
  - The prompt and the agent's notes are already redacted by `runAgent`. Screenshots are not redacted; see the follow-ups.

- [ ] **Step 1: Write the failing tests.** Use fake `runIn` and `runAgent`; no Docker or API.
  - `'failing tests skip the app and the browser agent'`
  - `'app never ready → run_failed with app.log tail, no agent call, app killed'`
  - `'browser fail turns a passing check into fail with note'`
  - `'n/a leaves the check passing'`
  - `'check missing from agent output fails as not exercised'`
  - `'agent changing a repo file is restored and fails all checks'` (real temp repo for the git part)
  - `'app process is killed even when the agent throws'`
  - `'screenshot path recorded only when the file exists'`
- [ ] **Step 2:** Run `npx vitest run tests/kits/web.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(kits): web verify exercises checks in a headless browser`.

### Task 7: Report, docs and end-to-end check

**Files:**
- Modify: `src/stages/deliver.ts`, `README.md`, `CLAUDE.md`
- Create: `tests/e2e/web-job.e2e.test.ts` (gated on `ANTON_E2E` + `ANTHROPIC_API_KEY`)
- Test: `tests/stages/deliver.test.ts`, `tests/e2e/docker.e2e.test.ts`

**Interfaces:**
- Produces:
  - `REPORT.md` shows `Kit: web` and adds a "Browser" column to the acceptance table (`pass` / `fail` / `n/a` / `-`). It also adds a `## Screenshots` section listing `evidence/screens/<id>.png` paths.
  - The README documents:
    - how the kit is chosen and changed at checkpoint 1
    - `serve` and `url`
    - that browser checks run only when tests pass
    - where screenshots live
    - that screenshots are not redacted
  - CLAUDE.md gets one Commands line: `npm run build:image` builds both fallback and web images.
  - Free Docker e2e, under `ANTON_E2E`:
    - start a web container on a tiny static fixture (`python3 -m http.server 8080` serving `index.html`)
    - run a Playwright script that saves a screenshot
    - assert the PNG exists and is not empty
  - The paid e2e test runs `anton new "a static web page that shows Hello"` through review and asserts that `Kit: web` and a screenshot path appear in `REPORT.md`. It is written but not run without a key.
- [ ] **Step 1: Write the failing tests.**
  - `'report shows kit, browser column and screenshots'`
  - `'fallback report has no browser column'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/deliver.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run build:image`, `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`, the full suite, `npx tsc --noEmit` and `npm run build`. Expected: all pass; the paid tests are skipped.
- [ ] **Step 5:** Commit `feat: web kit report and docs for Phase 3b`.

## Not in this phase

- **`scaffold`** stays with the infra role, as in Phase 1. It is not a kit function.
- **Kit `skills` / `mcp`:** Phase 4.
- **Kits under `~/anton/kits/`:** v1 ships two built-in kits.
