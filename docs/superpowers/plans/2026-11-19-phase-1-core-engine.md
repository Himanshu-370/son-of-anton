# Son of Anton — Phase 1: Core Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `anton new "<description>"` takes a description through Spec → checkpoint 1 → Plan → Build ⇄ Verify → Deliver → checkpoint 2 with the fallback kit, inside Docker, under a budget cap. Runs can be paused and resumed.

**Architecture:** The host CLI (TypeScript) owns all state and decisions; state lives in JSON files under each project's `.anton/jobs/<id>/`. Agents run inside a per-project Docker container via a small runner script (`/opt/anton/entry.js`) that wraps the Claude Agent SDK and streams JSONL events back to the host over `docker exec`. Verification is plain code: it parses JUnit XML and maps test names to acceptance-check IDs.

**Tech Stack:** Node ≥22, TypeScript (strict, ESM), commander, zod, execa, yaml, fast-xml-parser, vitest; `@anthropic-ai/claude-agent-sdk`, used only inside the container.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` · **Roadmap:** `docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md`

## Global Constraints

- The command is `anton`; the package is `son-of-anton`. Per-project folder: `.anton/`. Home: `~/anton/`, overridable with the `ANTON_HOME` env var.
- Default job budget **$10**. Warn once at **80%**. Max build⇄verify rounds: **3**.
- Models: Spec `claude-opus-5-5`, effort `high`. Plan `claude-opus-5-5`, effort `medium`. Build `claude-sonnet-5-5`, effort `medium`.
- Code does the mechanical work: running tests, parsing results, git, Docker, reports. Only Spec, Plan and Build call an agent in Phase 1.
- Every stage starts a fresh agent session with only the spec, the plan, the current task, and a trimmed failure report if there is one. Earlier transcripts are never passed on.
- Never push, merge or deploy. New projects work on `main`.
- One active run at a time per project (lock file).
- All agent commands run inside the container. Only the project repo is mounted read-write, at `/workspace`. Network is on.
- State is written before the next stage starts. Every write is atomic (write a temp file, then rename).
- Stop before any agent call, with no spend, if Docker isn't running or `ANTHROPIC_API_KEY` is missing.

## Review Focus

1. **Docker missing or stopped.** `anton new` must exit with a clear message ("Docker isn't running…") and spend nothing. Test in Task 8.
2. **Crash or kill mid-stage.** `resume` continues from the last completed step or task, and a half-written `state.json` never exists. Tests in Task 2 (atomic write) and Task 13 (resume skips completed tasks).
3. **Budget cap reached mid-call.** The run is killed, then paused with `budget_cap`, and cost already spent is recorded even when the agent errors. Test in Task 9.
4. **The agent says "done" but no test maps to an acceptance check.** Verify reports that check as failed with reason `no_test`; it never passes it. Test in Task 11.
5. **A second run while one is active, or a stale lock left by a dead process.** The second run is refused; the stale lock is cleared. Test in Task 4.

---

## File structure

```
son-of-anton/
  package.json, tsconfig.json, vitest.config.ts
  src/cli/index.ts                 commander wiring (all commands)
  src/cli/commands/*.ts            new, approve, reject, resume, stop, status, logs, _run
  src/core/paths.ts                home / project / job paths
  src/core/config.ts               defaults (budget, rounds, models)
  src/core/state.ts                JobState schema, atomic load/save, transitions
  src/core/registry.ts             project registry + slugs
  src/core/job.ts                  create project + job folders
  src/core/lock.ts                 pid lock
  src/core/notify.ts               macOS notifications
  src/core/budget.ts               cost ledger + cap/warn
  src/core/trim.ts                 output trimming
  src/core/git.ts                  init/commit/tag
  src/docker/container.ts          preflight, image, start/exec/stop
  src/agent/protocol.ts            AgentRequest / event schemas (shared)
  src/agent/host-runner.ts         docker exec → events → result, cost, kill on cap
  src/agent/entry.ts               runs INSIDE container: Agent SDK wrapper
  src/kits/types.ts                Kit interface
  src/kits/fallback/index.ts       detect / scaffold / verify
  src/kits/fallback/Dockerfile     base image incl. /opt/anton/entry.js
  src/verify/junit.ts              JUnit parse + AC mapping
  src/stages/spec.ts, plan.ts, build.ts, verify.ts, deliver.ts
  src/stages/prompts/{spec,plan,build}.md   standing instructions
  src/pipeline/runner.ts           stage machine driver
  tests/**                         mirrors src/
```

---

### Task 1: Project scaffold, paths and defaults

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `src/core/paths.ts`, `src/core/config.ts`
- Test: `tests/core/paths.test.ts`, `tests/core/config.test.ts`

**Interfaces:**
- Produces:
  - `antonHome(): string`
  - `projectDir(slug: string): string`, which returns `<home>/projects/<slug>`
  - `jobDir(repo: string, jobId: string): string`, which returns `<repo>/.anton/jobs/<jobId>`
  - `DEFAULTS: { budgetUsd: 10; warnAt: 0.8; maxRounds: 3; models: Record<'spec'|'plan'|'build', {model: string; effort: 'low'|'medium'|'high'}> }`

- [ ] **Step 1:** In `son-of-anton/`, run `git init`. Add `package.json` with `"name": "son-of-anton"`, `"type": "module"`, `"bin": {"anton": "dist/cli/index.js"}`, `"engines": {"node": ">=22"}`, the deps from the Tech Stack line, and the scripts `build` (tsc), `test` (vitest run) and `test:e2e` (`ANTON_E2E=1 vitest run tests/e2e`). Add a strict `tsconfig.json` and a `.gitignore` (`node_modules`, `dist`).
- [ ] **Step 2: Write failing tests.**
  - `paths.test.ts`:
    - with `ANTON_HOME=/tmp/x`, `antonHome() === '/tmp/x'`
    - unset, it equals `~/anton`
    - `projectDir('a')` ends with `/projects/a`
    - `jobDir('/r','1-init') === '/r/.anton/jobs/1-init'`
  - `config.test.ts`:
    - `DEFAULTS.budgetUsd === 10`
    - `DEFAULTS.warnAt === 0.8`
    - `DEFAULTS.maxRounds === 3`
    - `DEFAULTS.models.spec` deep-equals `{model:'claude-opus-5-5', effort:'high'}`
    - `DEFAULTS.models.plan` deep-equals `{model:'claude-opus-5-5', effort:'medium'}`
    - `DEFAULTS.models.build` deep-equals `{model:'claude-sonnet-5-5', effort:'medium'}`
- [ ] **Step 3:** Run `npm i && npx vitest run tests/core`. Expected: FAIL (modules not found).
- [ ] **Step 4:** Implement `paths.ts` and `config.ts` per the Interfaces block.
- [ ] **Step 5:** Run `npx vitest run tests/core`. Expected: PASS.
- [ ] **Step 6:** Commit, including the existing `docs/`: `git add -A && git commit -m "chore: scaffold son-of-anton with paths and defaults"`.

### Task 2: Job state store and transitions

**Files:**
- Create: `src/core/state.ts`
- Test: `tests/core/state.test.ts`

**Interfaces:**
- Produces:
  - `type Stage = 'spec'|'awaiting_spec_approval'|'plan'|'build'|'verify'|'deliver'|'awaiting_final_review'|'paused'|'done'|'abandoned'`
  - `type PauseReason = 'round_cap'|'budget_cap'|'no_progress'|'error'|'interrupted'`
  - `JobStateSchema` (zod) and `type JobState = { jobId; project; stage: Stage; pausedFrom?: Stage; pauseReason?: PauseReason; round: number; maxRounds: number; budgetUsd: number; spentUsd: number; warned80: boolean; completedTasks: string[]; lastFailureSignature?: string; updatedAt: string }`
  - `loadState(jobDir): Promise<JobState>`
  - `saveState(jobDir, s): Promise<void>`: atomic (write `state.json.tmp`, then rename)
  - `transition(s, to: Stage, extra?: Partial<JobState>): JobState`: throws `InvalidTransition` on an edge that isn't allowed
  - `pause(s, reason): JobState`: sets `stage:'paused'`, `pausedFrom`, `pauseReason`
  - `unpause(s): JobState`: returns to `pausedFrom`
  - `paused → deliver` is also allowed, when `pausedFrom` is `verify` or `build`. That's the accept-as-is path.

- [ ] **Step 1: Write failing tests:**
  - `'paused (from verify) → deliver is allowed; paused (from plan) → deliver throws'`
  - `'allows spec→awaiting_spec_approval→plan→build→verify→deliver→awaiting_final_review→done'`
  - `'allows verify→build (retry) and awaiting_final_review→build (reject)'`
  - `'rejects plan→deliver with InvalidTransition'`
  - `'pause then unpause returns to pausedFrom'`
  - `'any non-terminal stage → abandoned is allowed; done → anything throws'`
  - `'saveState is atomic'`: spy on `fs.rename`, and assert `state.json.tmp` is written first, then renamed
  - `'loadState rejects a file failing the schema'`
- [ ] **Step 2:** Run `npx vitest run tests/core/state.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement with an explicit allowed-edges map: `Record<Stage, Stage[]>`. `paused` is reachable from any running stage (`plan`, `build`, `verify`, `deliver`).
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): job state store with atomic writes and transitions`.

### Task 3: Registry, slugs and job creation

**Files:**
- Create: `src/core/registry.ts`, `src/core/job.ts`
- Test: `tests/core/registry.test.ts`, `tests/core/job.test.ts`

**Interfaces:**
- Consumes: `antonHome`, `projectDir`, `jobDir` (Task 1); `saveState`, `JobState` (Task 2)
- Produces:
  - `slugify(text: string): string`: lowercase ASCII, `[a-z0-9-]`, max 40 chars, no leading or trailing `-`, never empty (falls back to `project`)
  - `registerProject(name: string, repoPath: string): Promise<void>`
  - `getProject(name): Promise<{name; repoPath}>`, which throws `UnknownProject`
  - `listProjects(): Promise<{name; repoPath}[]>`
  - `uniqueName(base): Promise<string>`, which appends `-2`, `-3` and so on when the name is taken
  - `createNewProject(description: string, opts?: {budgetUsd?: number}): Promise<{name; repoPath; jobId: string; jobDir: string}>`. It creates the repo folder, runs `git init`, adds `.anton/jobs/1-init/` with `description.txt`, and saves the initial `JobState` (`stage:'spec'`, `round:0`, budget from `opts` or `DEFAULTS`).

- [ ] **Step 1: Write failing tests** (use a temp `ANTON_HOME`):
  - `slugify('A CLI that "cleans" my Downloads!!') === 'a-cli-that-cleans-my-downloads'`
  - `slugify('!!!') === 'project'`
  - `slugify('x'.repeat(100)).length <= 40`
  - `uniqueName` returns `'foo-2'` when `foo` is registered
  - `createNewProject` makes `<home>/projects/<slug>/.git`, the job folder and `state.json` with `stage:'spec'` and `budgetUsd:10`
  - `registry.json` lists the project
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Registry writes are atomic, the same as in Task 2.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): project registry and job creation`.

### Task 4: Run lock and notifications

**Files:**
- Create: `src/core/lock.ts`, `src/core/notify.ts`
- Test: `tests/core/lock.test.ts`, `tests/core/notify.test.ts`

**Interfaces:**
- Produces:
  - `acquireLock(repo: string): Promise<() => Promise<void>>`. It writes `<repo>/.anton/run.lock` containing `{pid, startedAt}` and returns a release function. It throws `AlreadyRunning` if the lock's pid is alive. If the pid is dead, it removes the stale lock and acquires.
  - `isRunning(repo): Promise<{running: boolean; pid?: number}>`
  - `notify(title: string, message: string, exec?: ExecFn): Promise<void>`. On darwin it runs `osascript -e 'display notification "<msg>" with title "<title>"'` with quotes escaped. It's a no-op elsewhere, and it never throws.
  - `type ExecFn = (cmd: string, args: string[]) => Promise<{exitCode: number; stdout: string; stderr: string}>`. Every module that runs commands takes one, so tests can fake it.

- [ ] **Step 1: Write failing tests:**
  - `'second acquire throws AlreadyRunning while first holds it'`
  - `'stale lock with dead pid (e.g. 999999) is replaced'`
  - `'release removes the lock file'`
  - `'notify escapes double quotes'`: a fake `ExecFn` receives the args, and they contain `\"`
  - `'notify swallows exec failure'`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Check whether a pid is alive with `process.kill(pid, 0)` inside a try/catch.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): run lock and macOS notifications`.

### Task 5: Budget ledger

**Files:**
- Create: `src/core/budget.ts`
- Test: `tests/core/budget.test.ts`

**Interfaces:**
- Consumes: `JobState`, `saveState` (Task 2); `notify` (Task 4)
- Produces:
  - `remainingUsd(s: JobState): number`
  - `recordCost(s: JobState, stage: string, usd: number): {state: JobState; crossedWarn: boolean; overCap: boolean}`. It adds to `spentUsd`, and to `cost.json` per stage through `appendStageCost`. `crossedWarn` is true only the first time spend reaches `warnAt × budget` (it sets `warned80`).
  - `appendStageCost(jobDir, stage, usd): Promise<void>`, which accumulates in `cost.json` as `{[stage]: usd}`

- [ ] **Step 1: Write failing tests:**
  - budget 10, spent 7.9, record 0.2: `crossedWarn:true`, `overCap:false`
  - the same again: `crossedWarn:false`
  - spent 9.9, record 0.2: `overCap:true`
  - `remainingUsd` is never negative
  - `cost.json` accumulates `{plan: 0.3}` across two writes of 0.1 and 0.2 (compare with a float tolerance)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): budget ledger with 80% warning and cap`.

### Task 6: Output trimming

**Files:**
- Create: `src/core/trim.ts`
- Test: `tests/core/trim.test.ts`

**Interfaces:**
- Produces: `trimOutput(text: string, opts?: {headLines?: number; tailLines?: number}): string`. Defaults are 40 head lines and 80 tail lines. If the text is longer, the middle is replaced with `… [N lines trimmed; full output at <path>] …`, where the path comes from `opts.fullPath` if given.

- [ ] **Step 1: Write failing tests:**
  - short text is returned unchanged
  - 500 lines → result has exactly 40 + 80 + 1 lines
  - the marker contains `380 lines trimmed`
  - with `fullPath:'/x/log.txt'`, the marker contains `/x/log.txt`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): output trimming`.

### Task 7: Git helper

**Files:**
- Create: `src/core/git.ts`
- Test: `tests/core/git.test.ts` (uses real git in a temp dir)

**Interfaces:**
- Produces:
  - `commitAll(repo, message): Promise<string | null>`: runs `git add -A`, then commits. It returns the sha, or `null` when there's nothing to commit. The author is `Son of Anton <anton@localhost>`, set per command with `-c user.name/-c user.email`. The repo's own config is never changed.
  - `tag(repo, name): Promise<void>`
  - `headSha(repo): Promise<string>`
  - `ensureAntonIgnored(repo): Promise<void>`: makes sure `.anton/` is listed in the repo's `.gitignore` (for new projects)

- [ ] **Step 1: Write failing tests:**
  - commit in a fresh repo returns a 40-char sha
  - a second commit with no changes returns `null`
  - `tag` makes `git tag -l` include the name
  - the author of HEAD is `Son of Anton`
  - after `ensureAntonIgnored`, a file in `.anton/` is not in `git status --porcelain`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement with execa.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(core): git helper`.

### Task 8: Docker container manager with preflight

**Files:**
- Create: `src/docker/container.ts`
- Test: `tests/docker/container.test.ts` (fake `ExecFn`), plus `tests/e2e/docker.e2e.test.ts` (real Docker, runs only when `ANTON_E2E=1`)

**Interfaces:**
- Consumes: `ExecFn` (Task 4)
- Produces:
  - `preflight(exec?): Promise<void>`. It throws `PreflightError` with the message `Docker isn't running. Start Docker Desktop and try again.` when `docker info` fails, and `ANTHROPIC_API_KEY is not set.` when that env var is missing.
  - `ensureImage(kit: {name: string; dockerfile: string}, exec?): Promise<string>`: builds `anton/kit-<name>:<pkgVersion>` from the kit's Dockerfile if it's missing, and returns the tag
  - `startContainer(slug, repoPath, image, exec?): Promise<string>`: `docker run -d --name anton-<slug> -v <repo>:/workspace -w /workspace -e ANTHROPIC_API_KEY <image> sleep infinity`. If a container named `anton-<slug>` already exists, it's removed first. Returns the name.
  - `execIn(name, cmd: string[], opts?: {timeoutMs?: number}): ExecaChildProcess`: a streaming handle for `docker exec`
  - `runIn(name, shellCmd: string, exec?): Promise<{exitCode; stdout; stderr}>`: runs `docker exec <name> sh -lc <cmd>`
  - `stopContainer(name, exec?): Promise<void>`: `docker rm -f`, with errors ignored

- [ ] **Step 1: Write failing tests:**
  - `'preflight throws Docker message when docker info exits 1'`
  - `'preflight throws API key message when env missing'`
  - `'startContainer passes exactly one -v mount: <repo>:/workspace'`
  - `'startContainer passes the API key by name only'`: args contain `-e ANTHROPIC_API_KEY`, and the value never appears in the args
  - `'stopContainer swallows errors'`
  - E2E: `'starts container, runIn echo returns "hi", stop removes it'`
- [ ] **Step 2:** Run `npx vitest run tests/docker`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/docker`. Expected: PASS. Then run `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`. Expected: PASS when Docker is running.
- [ ] **Step 5:** Commit: `feat(docker): container manager with preflight`.

### Task 9: Agent protocol and host runner

**Files:**
- Create: `src/agent/protocol.ts`, `src/agent/host-runner.ts`
- Test: `tests/agent/host-runner.test.ts` (fake process emitting JSONL)

**Interfaces:**
- Consumes: `execIn` (Task 8); `recordCost`, `appendStageCost` (Task 5); `saveState` (Task 2); `notify` (Task 4)
- Produces (protocol, shared with Task 10):
  - `AgentRequestSchema`: `{ role: string; model: string; effort: 'low'|'medium'|'high'; systemPrompt: string; prompt: string; outputSchema?: object /* JSON Schema */; resumeSessionId?: string; maxTurns: number; budgetUsd: number }`
  - `AgentEventSchema`, a union of:
    - `{type:'log'; text}`
    - `{type:'cost'; totalUsd: number}` (cumulative for this call)
    - `{type:'result'; ok: true; output: unknown; sessionId: string; totalUsd: number}`
    - `{type:'error'; message: string; totalUsd: number}`
- Produces (runner):
  - `type StageCtx = {project: string; repo: string; container: string; jobDir: string; state: JobState; stage: string}`. Every stage function in Tasks 12–13 takes it as `ctx`.
  - `runAgent(ctx: StageCtx, req: AgentRequest): Promise<{output: unknown; sessionId: string; state: JobState}>`
  - It writes the request to `<jobDir>/requests/<stage>-<n>.json` (inside the mount) and starts `node /opt/anton/entry.js /workspace/.anton/jobs/<id>/requests/<file>`.
  - Each JSONL line is parsed and logged to `<jobDir>/logs/<stage>.log`.
  - On each `cost` event, the call's increment is applied with `recordCost`. When `crossedWarn` comes back, it sends `notify('Son of Anton', '<project>: 80% of budget used')`.
  - When `overCap` comes back, it kills the process and throws `BudgetExceeded`, with the state already saved.
  - On `error`, it records cost and throws `AgentError`.
  - Lines that aren't valid JSON are logged and otherwise ignored.

- [ ] **Step 1: Write failing tests:**
  - `'returns output and sessionId from result event'`
  - `'records cumulative cost as increments'`: events 0.5, 1.2, then a result of 1.5 → `spentUsd` grows by exactly 1.5
  - `'kills process and throws BudgetExceeded when cap crossed'`: budget 1, cost events 0.6, then 1.1 → the fake process's `kill` was called, the error is `BudgetExceeded`, and the saved state has `spentUsd` ≥ 1.1
  - `'on error event, cost is still recorded and AgentError thrown'`
  - `'non-JSON lines are logged, not fatal'`
  - `'notifies once at 80%'`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Validate each event with `AgentEventSchema.safeParse`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(agent): JSONL protocol and host runner with budget kill`.

### Task 10: In-container entry and fallback kit image

**Files:**
- Create: `src/agent/entry.ts`, `src/kits/fallback/Dockerfile`
- Test: `tests/agent/entry.test.ts` (the SDK `query` is injected and faked), plus `tests/e2e/entry.e2e.test.ts` (`ANTON_E2E=1`: one real tiny call)

**Interfaces:**
- Consumes: `AgentRequestSchema`, `AgentEventSchema` (Task 9)
- Produces:
  - `main(requestPath: string, deps?: {query?: typeof import('@anthropic-ai/claude-agent-sdk').query; write?: (line: string) => void}): Promise<void>`. It emits only protocol events on stdout, one JSON object per line.
  - The image `anton/kit-fallback` is built `FROM node:22-bookworm`. It adds `python3`, `python3-pip`, `python3-venv` and `git`, and installs the SDK with the bundled entry into `/opt/anton`.

- [ ] **Step 1: Check the SDK API before coding.** Read the current Claude Agent SDK TypeScript docs (code.claude.com/docs/en/agent-sdk) and confirm:
  - the name and shape of `query()` and its options for model, effort or thinking, system prompt, `cwd`, max turns, structured output and resume
  - the result message's cost field
  - whether a built-in budget option exists

  Record what you found in a comment at the top of `entry.ts`. If a budget option exists, pass `req.budgetUsd` to it too, in addition to the host-side kill from Task 9.
- [ ] **Step 2: Write failing tests** (with a fake `query` yielding scripted messages):
  - `'emits cost events as usage arrives and a final result with output'`
  - `'passes model, cwd=/workspace, maxTurns and systemPrompt through'`
  - `'when outputSchema is set and the final text is not valid against it, emits error'`
  - `'uncaught SDK exception becomes an error event with totalUsd so far'`
  - every emitted line parses with `AgentEventSchema`
- [ ] **Step 3:** Run the tests. Expected: FAIL.
- [ ] **Step 4:** Implement `entry.ts`, and the Dockerfile that copies the compiled entry plus its `node_modules` to `/opt/anton`. Add an npm script `build:image` that runs `ensureImage`.
- [ ] **Step 5:** Run the tests. Expected: PASS. Then run `ANTON_E2E=1 npx vitest run tests/e2e/entry.e2e.test.ts`. Expected: PASS. This makes a one-sentence request on `claude-haiku-5-5` (allowed here because the test only checks plumbing) and checks that a `result` event arrives with `totalUsd > 0`.
- [ ] **Step 6:** Commit: `feat(agent): container entry wrapping the Agent SDK; fallback kit image`.

### Task 11: Kit interface, JUnit mapping and fallback verify

**Files:**
- Create: `src/kits/types.ts`, `src/verify/junit.ts`, `src/kits/fallback/index.ts`
- Test: `tests/verify/junit.test.ts`, `tests/kits/fallback.test.ts`

**Interfaces:**
- Consumes: `runIn` (Task 8), `trimOutput` (Task 6)
- Produces:
  - `type AcceptanceCheck = {id: string /* 'AC-1' */; text: string}`
  - `type Commands = {install: string; test: string; run?: string}`. `test` must write JUnit XML to `$ANTON_JUNIT`.
  - `type CheckResult = {id: string; status: 'pass'|'fail'; reason?: 'no_test'|'failing'|'run_failed'; tests: string[]; error?: string}`
  - `interface Kit { name: string; dockerfile: string; detect(description: string): number /* 0..1 */; verify(ctx: {container: string; jobDir: string; checks: AcceptanceCheck[]; commands: Commands}): Promise<{results: CheckResult[]; runOk: boolean; failureReport: string}> }`
  - `mapJUnit(xml: string, checks: AcceptanceCheck[]): CheckResult[]`. A testcase belongs to an acceptance check when its name or classname contains the check's ID as a whole word (`AC-1` doesn't match `AC-10`). A check passes only if it has at least one test and every one of its tests passes. A check with no tests fails with `no_test`.
  - `fallbackKit: Kit`. `detect` always returns 0.1. `verify` does the following:
    1. Runs `commands.install`.
    2. Runs `commands.test` with `ANTON_JUNIT=/workspace/.anton/jobs/<id>/evidence/junit.xml`.
    3. Maps the results.
    4. If `commands.run` is set, runs it with a 10-second timeout. Exit code 0, or still running at the timeout, counts as `runOk`.
    5. Builds `failureReport` as markdown: each failing check, its reason, the test names and the first error, all passed through `trimOutput`.

- [ ] **Step 1: Write failing tests:**
  - `mapJUnit`: two tests tagged AC-1 that both pass → pass
  - one tagged AC-2 failing → `failing`, with `error` holding the failure message
  - AC-3 with no tests → `no_test`
  - a test named `AC-10 foo` does not count for AC-1
  - malformed XML → every check fails with `no_test`, and no exception is thrown
  - `fallbackKit.verify` with a fake `runIn`: when the run command exits 1, `runOk` is false
  - the failure report lists the IDs of the failing checks only
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement with `fast-xml-parser`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(kits): kit interface, JUnit→acceptance-check mapping, fallback kit`.

### Task 12: Spec and Plan stages

**Files:**
- Create: `src/stages/spec.ts`, `src/stages/plan.ts`, `src/stages/prompts/spec.md`, `src/stages/prompts/plan.md`
- Test: `tests/stages/spec.test.ts`, `tests/stages/plan.test.ts` (fake `runAgent`)

**Interfaces:**
- Consumes: `runAgent` (Task 9); `AcceptanceCheck`, `Commands` (Task 11); `DEFAULTS.models` (Task 1)
- Produces:
  - `SpecDocSchema = {title; summary; outOfScope: string[]; kit: 'fallback'; tech: string[]; acceptanceChecks: AcceptanceCheck[] /* ≥1, ids AC-1..n sequential */}`
  - `runSpec(ctx, description: string, ask: (questions: string[]) => Promise<string[]>): Promise<SpecDoc>`. This is the question loop. The output schema is `{kind:'questions'; questions: string[]} | {kind:'spec'; spec: SpecDoc}`. There are at most 5 question rounds; on the 6th call the prompt says "write the spec now", and only `kind:'spec'` is accepted. Each round resumes the same session through `resumeSessionId`.
  - `writeSpec(jobDir, spec): Promise<void>`: writes `spec.json` and renders `spec.md`, with a heading per section and the acceptance checks as `- **AC-1**: …`.
  - `readApprovedSpec(jobDir): Promise<SpecDoc>`. It reads `spec.md` back, so your edits count: it parses the `**AC-n**` lines and the title. It keeps `spec.generated.md` as the original and saves the result as `spec.approved.json`.
  - `PlanSchema = {commands: Commands; tasks: {id: string /* T1.. */; title: string; acceptanceChecks: string[]; instructions: string}[]}`. Every acceptance check must appear in at least one task; otherwise it fails validation with the missing IDs named.
  - `runPlan(ctx, spec): Promise<Plan>`: writes `plan.json` and `plan.md`
- Prompts:
  - `spec.md`: ask only questions whose answers change what gets built. Acceptance checks must be concrete and testable.
  - `plan.md`: choose a test framework and a JUnit reporter that writes to `$ANTON_JUNIT`. Tests must put the acceptance check ID in their name. Tasks should be small and ordered.

- [ ] **Step 1: Write failing tests:**
  - spec loop: the fake agent returns questions twice, then a spec → `ask` is called twice, and the second call carries `resumeSessionId`
  - the fake always returns questions → on the 6th call the request prompt includes "write the spec now", and a questions reply then throws `SpecNotProduced`
  - `writeSpec`, then `readApprovedSpec` on a `spec.md` edited to change the AC-2 text and add an AC-3 → three checks, with the edited text
  - plan validation: a plan missing AC-2 is rejected with a message containing `AC-2`
  - spec uses `claude-opus-5-5`/`high`, and plan uses `claude-opus-5-5`/`medium`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(stages): spec question loop and plan stage`.

### Task 13: Build, Verify and Deliver stages

**Files:**
- Create: `src/stages/build.ts`, `src/stages/verify.ts`, `src/stages/deliver.ts`, `src/stages/prompts/build.md`
- Test: `tests/stages/build.test.ts`, `tests/stages/verify.test.ts`, `tests/stages/deliver.test.ts`

**Interfaces:**
- Consumes: `runAgent` (Task 9), `commitAll`/`tag` (Task 7), `Kit.verify` (Task 11), `Plan`/`SpecDoc` (Task 12), `transition`/`pause`/`saveState` (Task 2)
- Produces:
  - `runBuild(ctx, spec, plan, failureReport?: string): Promise<JobState>`
    - With no failure report: for each task whose ID isn't in `state.completedTasks`, start a fresh agent session. Its prompt holds the spec, the plan, that task, and the instruction to run that task's tests. After the session, run `commitAll(repo, "<T-id>: <title>")`, push the ID onto `completedTasks`, and save the state, in that order.
    - With a failure report: run a single fix session whose prompt holds the spec, the plan and the trimmed failure report, then commit `fix: round <n>`.
  - `failureSignature(results: CheckResult[]): string`: the sorted `id:reason` pairs of the failing checks, joined with `|`
  - `runVerify(ctx, kit, spec, plan): Promise<{state: JobState; passed: boolean; results; runOk; failureReport}>`. It writes `evidence/results.json`. It passes only if every check passes and `runOk` is true. When it fails:
    - `round + 1 > maxRounds`: pause with `round_cap`.
    - The signature equals `lastFailureSignature`: pause with `no_progress`.
    - Otherwise: transition to `build` with `round + 1` and save the signature.

    When it passes, it transitions to `deliver`.
  - `runDeliver(ctx, spec, plan, verifyResult): Promise<void>`. It writes `REPORT.md` with these sections, in this order:
    1. Title and summary
    2. Acceptance checks, as a table of ID, check, status, tests and evidence path
    3. How to run, from `commands`
    4. Cost and time by stage, from `cost.json` and the log timestamps
    5. Assumptions, from `questions.md` if present
    6. Not done, listing the failing checks if delivering after accept-as-is

    Then it runs `tag(repo, "anton/<jobId>/delivered")` and transitions to `awaiting_final_review`.

- [ ] **Step 1: Write failing tests:**
  - `'build resumes after crash: with completedTasks [T1], only T2 and T3 start agent sessions'`
  - `'build commits once per task with message "T2: <title>"'`
  - `'build in fix mode starts exactly one session whose prompt contains the trimmed failure report'`
  - `'verify: all pass + runOk → passed, transitions to deliver'`
  - `'verify: second identical failure signature → paused/no_progress'`
  - `'verify: failure in round 3 of 3 → paused/round_cap'`
  - `'deliver: REPORT.md contains the acceptance table with every AC id and the How to run section'`
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Build uses `DEFAULTS.models.build`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit: `feat(stages): build, verify with early stop, deliver report`.

### Task 14: Pipeline runner and CLI

**Files:**
- Create: `src/pipeline/runner.ts`, `src/cli/index.ts`, `src/cli/commands/{new,approve,reject,resume,stop,status,logs,run}.ts`
- Test: `tests/pipeline/runner.test.ts` (fake stages), `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: everything above
- Produces:
  - `runUnattended(project: string): Promise<void>`. It acquires the lock and starts or reuses the container. It then loops on `state.stage` through `plan`, `build`, `verify` and `deliver` until it reaches a waiting or paused stage. It releases the lock and stops the container in a `finally`.
    - On `BudgetExceeded`, it pauses with `budget_cap`. On any other error, it pauses with `error` and writes the message to `logs/error.log`.
    - Every pause, and reaching `awaiting_final_review`, sends a `notify`.
  - CLI commands, all of which resolve the project's current job:
    - `anton new "<desc>" [--budget <usd>]`: runs `preflight`, `createNewProject`, `ensureAntonIgnored`, starts the container and runs `runSpec` with a readline `ask` in the foreground, then `writeSpec`. It transitions to `awaiting_spec_approval`, then prints the path to `spec.md` and `Edit it if you like, then run: anton approve <name>`.
    - `anton approve <project>`:
      - At `awaiting_spec_approval`: runs `readApprovedSpec`, tags `anton/<jobId>/spec-approved`, transitions to `plan`, and spawns the background run.
      - At `awaiting_final_review`: transitions to `done`.
      - At any other stage: exits 1 with `Nothing to approve (stage: <stage>)`.
    - `anton reject <project> --notes "<text>"`: only at `awaiting_final_review`. It writes `notes-round-<n>.md`, sets the failure report to your notes, resets `round` to 1, transitions to `build`, and spawns the background run.
    - `anton resume <project> [--budget <usd>] [--accept-as-is]`: if the stage is `paused`, it unpauses; with `budget_cap`, `--budget` is required and raises `budgetUsd`. `--accept-as-is` transitions `paused → deliver`, and the report lists the failing checks under "Not done". Then it spawns the background run.
    - `anton abandon <project>`: transitions to `abandoned` and stops the container. Retro arrives in Phase 5.
    - `anton stop <project>`: sends SIGTERM to the lock's pid, waits 10 seconds, then sends SIGKILL. It removes the container and pauses with `interrupted`.
    - `anton status [project]`: prints a table of project, stage, round, spent / budget and pause reason. If the lock's pid is dead while the stage isn't waiting or paused, it shows `interrupted`.
    - `anton logs -f <project>`: tails the current stage's log file.
    - `anton _run <project>`: hidden; calls `runUnattended`.
    - The background run is `spawn(process.execPath, [cliPath, '_run', name], {detached: true, stdio: ['ignore', logFd, logFd]}).unref()`.

- [ ] **Step 1: Write failing tests:**
  - runner with fake stages: plan → build → verify (fail) → build → verify (pass) → deliver → `awaiting_final_review` → notify called once; the lock is released and the container stopped even when a stage throws
  - `BudgetExceeded` from build → `paused`/`budget_cap`
  - CLI `approve` at stage `plan` → exit code 1 and message `Nothing to approve (stage: plan)`
  - `resume` on `budget_cap` without `--budget` → exit 1, and the message mentions `--budget`
  - `resume --accept-as-is` on `round_cap` → the stage becomes `deliver`, and the background run is spawned
  - `status` shows `interrupted` for a dead pid while at `build`
  - `new` with Docker down → exit 2 with the preflight message, and no project folder is created (preflight runs first)
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement. Inject fakes through a `deps` parameter on `runUnattended` and on each command's handler.
- [ ] **Step 4:** Run `npm test`. Expected: all PASS.
- [ ] **Step 5:** Commit: `feat(cli): pipeline runner and anton commands`.

### Task 15: End-to-end smoke test

**Files:**
- Create: `tests/e2e/new-project.e2e.test.ts`, `README.md`

**Interfaces:**
- Consumes: the CLI as built (`dist/cli/index.js`)

- [ ] **Step 1:** Write `'anton builds a tiny python CLI end-to-end'`. It runs only when `ANTON_E2E=1`, with a temp `ANTON_HOME` and a $3 budget.
  - The description is: `"a python CLI that prints the sum of numbers given as arguments"`.
  - Inject an `ask` that always answers "use your judgement".
  - Run `new` → `approve`, then wait for `awaiting_final_review` by polling `state.json`, for up to 20 minutes.
  - Assert:
    - `REPORT.md` exists and every acceptance check in `evidence/results.json` has status `pass`
    - `git log` shows one commit per plan task
    - `spentUsd` ≤ 3
- [ ] **Step 2:** Run `npm run build && ANTON_E2E=1 npx vitest run tests/e2e/new-project.e2e.test.ts`. Expected: PASS. This costs real API money, roughly up to $3.
- [ ] **Step 3:** Write `README.md`: what it is, prerequisites (Docker Desktop, Node 22, `ANTHROPIC_API_KEY`), `npm run build:image`, the command list, and the Phase 1 limits (fallback kit only, CLI only, new projects only).
- [ ] **Step 4:** Commit: `test(e2e): end-to-end smoke; README`.
