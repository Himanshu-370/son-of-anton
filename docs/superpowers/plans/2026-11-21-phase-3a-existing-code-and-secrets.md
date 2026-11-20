# Son of Anton: Phase 3a, Existing Code and Secrets

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Son of Anton can now work on code that already exists, using real secrets safely:
- adopt a repo you started by hand
- run change jobs on their own branch, with a repo map and a regression baseline
- check outside services against stand-ins, or against the real service when you provide secrets
- strip those secret values from everything it records

It also closes the Phase 2 security follow-ups.

**Architecture:**
- A job gains a `kind` (`new` or `change`) and a branch.
- Change jobs add a `baseline` stage between plan and build. It records which tests pass and which scanner findings already exist, so verify can tell real regressions from inherited problems.
- Secrets live in `~/anton/secrets/<project>.env`. They reach the container only through `docker run --env-file`, and a single `redact()` is applied at every point where text gets saved.

**Tech Stack:** Same as Phases 1–2: TypeScript/Node ≥22, zod, execa, vitest, Docker, and the Claude Agent SDK in the container.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md`: §6.0, §6.4.1 (baseline pass), §7.1 (repo map), §9.1. Also the security list at the top of `docs/superpowers/plans/2026-11-20-phase-2-followups.md`.

**Scope note (my call):** the roadmap's Phase 3 is split in two. This plan, 3a, is self-contained and testable without a browser. **3b** follows it and adds the web kit: Playwright, browser-driven QA and screenshots.

## Global Constraints

- Every rule in `CLAUDE.md` holds:
  - every external effect is injectable through a `deps` parameter
  - state and evidence writes go through `writeFileAtomic`
  - host git runs only through `src/core/git.ts`
  - agent output schemas are zod-first, with an object root
  - reviewer and mapper sessions are read-only (`tools: ['Read','Grep','Glob']`)
- Change jobs work on the branch `anton/<n>-<slug>` and never touch the user's current branch. Son of Anton never merges or pushes. The first job of a new project stays on `main`.
- Refuse to start a job (`change`), with nothing created, if the repo has uncommitted changes or a job is still active. "Active" means its stage isn't `done` or `abandoned`.
- `.anton/` stays out of git through `.git/info/exclude`, as `commitAll` already does.
- The secrets file is `~/anton/secrets/<project>.env` with mode `0600`. Its values reach the container as environment variables through `--env-file`, never as a mounted file, and never into the repo.
- Values shorter than 8 characters are not redacted; masking them would garble ordinary text. Every other secret value is replaced with `[REDACTED:<VAR>]` everywhere Son of Anton saves text.
- Stand-ins by default. Tests that hit a real service carry `[real]` in their name, and skip themselves unless that service's env vars are set.
- Model for the new `mapper` role: `claude-sonnet-5-5`, effort `low`, read-only (my call; it's an exploration-only job).

## Review Focus

1. **`anton change` on a repo with uncommitted changes** is refused with the message `Commit or stash your changes first`, and no job folder or branch is created. Test in Task 4.
2. **A secret value inside an agent's log line or `REPORT.md`** shows up as `[REDACTED:VAR]` on disk. A 5-character value isn't touched. Tests in Task 9.
3. **A test that already failed at baseline** is not a regression. A test that passed at baseline and is now missing or failing is one. Tests in Task 7.
4. **A scanner finding that already existed at baseline** doesn't block and is listed as `pre-existing`. A new one in the same file does block. Test in Task 7.
5. **`anton adopt` on a folder that isn't a git repo, or a name that's already taken,** gives a clear error and registers nothing. Test in Task 3.

---

## File structure

```
src/security/scanners.ts     + occurrence key (gitleaks Fingerprint, semgrep matched-code hash)
src/security/review.ts       scannerRef uses key; scanner severity floor
src/stages/verify.ts         skip corrupt copies; regressions; pre-existing findings
src/core/state.ts            + kind, branch, baseline stage + edges
src/core/git.ts              + isClean, createBranch
src/core/job.ts              + createChangeJob
src/cli/commands/adopt.ts, change.ts, secrets.ts
src/cli/spec-session.ts      shared interactive spec loop (moved out of new.ts)
src/stages/repo-map.ts       ensureRepoMap
src/stages/baseline.ts       runBaseline
src/kits/types.ts + fallback  + baseline()
src/core/secrets.ts          secretsPath, loadSecrets, redact
src/stages/spec.ts / prompts change-mode prompt, services in SpecDoc
src/stages/deliver.ts        branch, regressions, pre-existing, real/stand-in labels
```

---

### Task 1: Close the Phase 2 security follow-ups

**Files:**
- Modify: `src/security/scanners.ts`, `src/security/review.ts`, `src/stages/verify.ts`
- Test: `tests/security/scanners.test.ts`, `tests/security/review.test.ts`, `tests/stages/verify.test.ts`

**Interfaces:**
- Produces:
  - `ScannerFinding` gains `key: string`:
    - gitleaks: its `Fingerprint` field
    - semgrep: `sha8(extra.lines)`, a hash of the matched code text
    - osv-scanner: the vulnerability id
  - `scannerRef(f)` becomes `SCN-<sha8(tool \n ruleId \n file \n key)>`.
  - A finding derived from a scanner ref can't come out less severe than the scanner rated it: its severity is `max(model severity, scanner severity)`.
  - `previousSecurity` skips any `results-verify-*.json` that fails to parse. It never throws.

- [ ] **Step 1: Write failing tests:**
  - `'two gitleaks hits of the same rule in the same file get different refs'`
  - `'the same semgrep match on a shifted line keeps its ref'`
  - `'model cannot downgrade a high scanner finding to medium'` (the returned severity is `high`, and the finding still blocks)
  - `'a corrupt results-verify copy is skipped, not fatal'`
- [ ] **Step 2:** Run `npx vitest run tests/security tests/stages/verify.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Regenerate any fixture whose JSON lacks the new field by editing it; don't re-run the scanners.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then run the full suite and `npx tsc --noEmit`.
- [ ] **Step 5:** Commit `fix(security): occurrence-keyed scanner refs, severity floor, tolerate corrupt copies`.

### Task 2: Job kinds, branch and the baseline stage

**Files:**
- Modify: `src/core/state.ts`, `src/core/git.ts`, `src/core/job.ts`
- Test: `tests/core/state.test.ts`, `tests/core/git.test.ts`, `tests/core/job.test.ts`

**Interfaces:**
- Produces:
  - `JobState` gains `kind: z.enum(['new','change']).default('new')` and `branch: z.string().optional()`.
  - `Stage` gains `'baseline'`, with the edges `plan→baseline`, `baseline→build`, `baseline→paused` and `baseline→abandoned`. `paused` returns to `baseline`.
  - `isClean(repo): Promise<boolean>` is true when `git status --porcelain` is empty. `.anton/` doesn't count, because it's excluded.
  - `createBranch(repo, name): Promise<void>` runs `git switch -c <name>` through the safe wrapper.
  - `createChangeJob(project: string, description: string, opts?: {budgetUsd?: number}): Promise<NewProject & {branch: string}>`:
    - The new job's number is the highest existing job number plus 1, so its id is `<n>-<slugify(description)>`.
    - It creates the branch `anton/<jobId>`.
    - It saves the initial state with `kind: 'change'`, `branch`, `stage: 'spec'` and the default budget.
    - It throws `DirtyRepo('Commit or stash your changes first')` when the repo isn't clean.
    - It throws `JobActive('<project> already has an active job (<jobId>, stage <stage>)')` when the latest job is active.
    - Both checks run before anything is created.

- [ ] **Step 1: Write failing tests, using a real git repo in a temp dir:**
  - `'change job ids increment: 1-init then 2-add-auth'`
  - `'branch anton/2-add-auth exists and is checked out'`
  - `'dirty repo → DirtyRepo, no job dir, no branch'`
  - `'active job → JobActive, nothing created'`
  - `'old state.json without kind loads as kind new'`
  - `'plan→baseline→build allowed; plan→build still allowed for new jobs'`
- [ ] **Step 2:** Run `npx vitest run tests/core`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS. Then run the full suite.
- [ ] **Step 5:** Commit `feat(core): change jobs on their own branch; baseline stage`.

### Task 3: `anton adopt`

**Files:**
- Create: `src/cli/commands/adopt.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/cli.test.ts`

**Interfaces:**
- Produces `anton adopt <path> [--name <name>]`:
  - Resolve `<path>` to an absolute path.
  - Require `git -C <path> rev-parse --show-toplevel` to equal the path. Otherwise exit 1 with `<path> is not the root of a git repository`.
  - The name defaults to `slugify(basename(path))`. An explicit `--name` that's already registered exits 1 with `A project named <name> already exists`. A default name gets made unique.
  - Add `.anton/` to `.git/info/exclude` with `ensureAntonIgnored`, then register the project. It prints `Adopted <name> (<path>). Start a change with: anton change <name> "<what to change>"`.
  - No job is created.

- [ ] **Step 1: Write failing tests:**
  - `'adopt registers and excludes .anton'`
  - `'not a repo → exit 1, nothing registered'`
  - `'subfolder of a repo → exit 1'`
  - `'explicit taken name → exit 1'`
  - `'default name collision gets a suffix'`
- [ ] **Step 2:** Run `npx vitest run tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the same command. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cli): anton adopt`.

### Task 4: `anton change`, with a spec for existing code

**Files:**
- Create: `src/cli/spec-session.ts`, `src/cli/commands/change.ts`
- Modify: `src/cli/commands/new.ts`, `src/stages/spec.ts`, `src/stages/prompts/spec.md`, `src/cli/index.ts`
- Test: `tests/cli/cli.test.ts`, `tests/stages/spec.test.ts`

**Interfaces:**
- Consumes: `createChangeJob` (Task 2); `ensureRepoMap` (Task 5), injected through deps. Until Task 5 lands, it's a no-op default.
- Produces:
  - `runSpecSession(d: Resolved, p: {name, repoPath, jobDir}, mode: 'new'|'change'): Promise<number>`. This is the spec loop and approval hint currently in `new.ts`, moved without changes: container start, the Ctrl-C handler, the failure hint and stopping the container.
  - `runSpec` gains `mode`. In `change` mode the prompt adds that the spec covers the *change*: read `.anton/repo-map.md` and the code first; list what must keep working; if the repo has few or no tests, propose characterization acceptance checks that pin current behaviour.
  - `anton change <project> "<desc>" [--budget <usd>]`:
    1. preflight
    2. `createChangeJob`, which maps `DirtyRepo` and `JobActive` to exit 1 with their messages
    3. `ensureRepoMap`
    4. `runSpecSession(..., 'change')`
  - The printed hint names the branch.

- [ ] **Step 1: Write failing tests:**
  - `'change runs spec in change mode on branch anton/2-x'`
  - `'change on dirty repo → exit 1 "Commit or stash your changes first", runSpec not called'`
  - `'change mode prompt mentions repo-map.md and characterization checks'`
  - `'new still behaves exactly as before'` (the existing new tests stay green)
- [ ] **Step 2:** Run `npx vitest run tests/cli tests/stages/spec.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. The move out of `new.ts` must keep every existing `new` test passing.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(cli): anton change with a spec for existing code`.

### Task 5: Repo map

**Files:**
- Create: `src/stages/repo-map.ts`, `src/stages/prompts/repo-map.md`
- Modify: `src/core/config.ts` (add `mapper` to `Role` and `ROLE_MODELS`)
- Test: `tests/stages/repo-map.test.ts`, `tests/core/config.test.ts`

**Interfaces:**
- Produces `ensureRepoMap(ctx: StageCtx, deps?: {runAgent?, diffSince?, headSha?}): Promise<JobState>`:
  - If `.anton/repo-map.md` is missing, a read-only `mapper` session writes the full map: structure, main modules, how to run and test, and conventions, in at most 150 lines.
  - If the map exists, it reads the `mapSha` stored in `.anton/repo-map.json`. When HEAD equals `mapSha`, there's no agent call. Otherwise one session gets the old map plus a trimmed `git diff mapSha..HEAD`, and returns an updated map.
  - The map comes back as structured output `{markdown}`. The host writes `repo-map.md` and `{mapSha: HEAD}` atomically.
  - The mapper's tools are `['Read','Grep','Glob']`, `maxTurns` is 40, and the budget is `remainingUsd(state)`.

- [ ] **Step 1: Write failing tests:**
  - `'first run writes repo-map.md and mapSha'`
  - `'unchanged HEAD → no agent call'`
  - `'changed HEAD → one call whose prompt has the old map and the diff'`
  - `'mapper request is read-only, sonnet-5-5/low'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/repo-map.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement, and wire it into `change.ts`, replacing the no-op.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(stages): repo map for existing code`.

### Task 6: Baseline stage

**Files:**
- Create: `src/stages/baseline.ts`
- Modify: `src/kits/types.ts`, `src/kits/fallback/index.ts`, `src/pipeline/runner.ts`, `src/stages/prompts/plan.md`
- Test: `tests/stages/baseline.test.ts`, `tests/kits/fallback.test.ts`, `tests/pipeline/runner.test.ts`

**Interfaces:**
- Produces:
  - `Kit.baseline(ctx: {container, jobDir, commands}): Promise<{passingTests: string[]; ran: boolean}>`. The fallback kit runs install and test exactly as verify does, then collects the names of every passing testcase from the JUnit output. It returns `ran: false` if install fails or there's no valid JUnit.
  - `runBaseline(ctx, kit, plan, deps?: {runScanners?}): Promise<JobState>`:
    1. Writes `evidence/baseline.json` atomically with `{passingTests, ran, scannerRefs: string[]}`, the refs of every scanner finding at baseline.
    2. Transitions to `build`.
  - The runner: for `kind: 'change'` jobs, plan transitions to `baseline`, and a `case 'baseline'` calls `runBaseline`. For `new` jobs, plan still goes straight to `build`.
  - The tech-lead prompt for change jobs says: reuse the repo's existing test runner, and add a JUnit reporter through command-line flags in `commands.test`, writing to `$ANTON_JUNIT`, without editing config files.

- [ ] **Step 1: Write failing tests:**
  - `'baseline records passing test names and scanner refs'`
  - `'install failure → ran false, still transitions to build'`
  - `'runner routes change jobs plan→baseline→build; new jobs plan→build'`
  - `'crash during baseline resumes at baseline without re-running plan'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/baseline.test.ts tests/kits tests/pipeline`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(stages): regression and security baseline for change jobs`.

### Task 7: Regressions and pre-existing findings in verify

**Files:**
- Modify: `src/stages/verify.ts`, `src/stages/qa.ts`, `src/security/review.ts`
- Test: `tests/stages/verify.test.ts`, `tests/stages/qa.test.ts`

**Interfaces:**
- Consumes: `evidence/baseline.json` (Task 6), the JUnit testcase list from the kit run.
- Produces:
  - `FailureItem.kind` gains `'regression'`. When `baseline.ran` is true, each name in `passingTests` that's missing or not passing now becomes one item, with id `REG-<sha8(name)>` and its area set by the run-failure rule (infra if present, otherwise backend, otherwise the first area).
  - This needs the kit's verify to expose all testcase results: extend `VerifyOutcome` with `tests: {name: string; passed: boolean}[]`.
  - `SecurityFinding` gains `preexisting: boolean`. It's true when the finding's scanner ref is in `baseline.scannerRefs`.
  - `blocking()` ignores findings marked `preexisting`.

- [ ] **Step 1: Write failing tests:**
  - `'baseline-passing test now failing → regression item'`
  - `'baseline-passing test missing → regression item'`
  - `'test already failing at baseline → no item'`
  - `'pre-existing scanner finding does not block and is marked preexisting'`
  - `'new finding in same file blocks'`
  - `'no baseline.json (new job) → no regression logic'`
- [ ] **Step 2:** Run `npx vitest run tests/stages tests/security`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(verify): regressions and pre-existing findings`.

### Task 8: Secrets store and container env

**Files:**
- Create: `src/core/secrets.ts`, `src/cli/commands/secrets.ts`
- Modify: `src/docker/container.ts`, `src/pipeline/runner.ts`, `src/cli/index.ts`, `src/cli/spec-session.ts`
- Test: `tests/core/secrets.test.ts`, `tests/docker/container.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Produces:
  - `secretsPath(project): string` returns `<antonHome()>/secrets/<project>.env`.
  - `loadSecrets(project): Promise<Record<string,string>>` parses `KEY=value` lines. It ignores `#` comments and blank lines, strips matching surrounding quotes, and returns `{}` when the file is missing. If the file mode isn't `0600`, it throws `Secrets file must be private: chmod 600 <path>`.
  - `anton secrets edit <project>` creates the folder (`0700`) and the file (`0600`) if they're missing, with a comment header, then opens it through injectable `openEditor(path)`: `$EDITOR`, or `open -t` on macOS.
  - `startContainer(slug, repo, image, exec, opts?: {envFile?: string})` adds `--env-file <path>` when an env file is given. The runner and the spec session pass `secretsPath(project)` only if the file exists.
  - At the spec checkpoint, the session prints `Secrets this job will receive: A, B` (names only), or `none`.

- [ ] **Step 1: Write failing tests:**
  - `'loadSecrets parses, strips quotes, ignores comments'`
  - `'world-readable file → throws chmod message'`
  - `'missing file → {}'`
  - `'startContainer adds --env-file only when given; values never appear in argv'`
  - `'secrets edit creates 0600 file and calls openEditor'`
  - `'spec session prints secret names, never values'`
- [ ] **Step 2:** Run `npx vitest run tests/core/secrets.test.ts tests/docker tests/cli`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(secrets): per-project secrets passed as env only`.

### Task 9: Redaction everywhere text is saved

**Files:**
- Modify: `src/core/secrets.ts`, `src/agent/host-runner.ts`, `src/stages/verify.ts`, `src/stages/deliver.ts`, `src/kits/fallback/index.ts`
- Test: `tests/core/secrets.test.ts`, `tests/agent/host-runner.test.ts`, `tests/stages/deliver.test.ts`, `tests/kits/fallback.test.ts`

**Interfaces:**
- Produces:
  - `redact(text: string, secrets: Record<string,string>): string` replaces every value of length ≥ 8 with `[REDACTED:<KEY>]`. The longest values are replaced first, so one secret that contains another is still fully hidden.
  - `StageCtx` gains `secrets: Record<string,string>`, loaded once by the runner.
  - Redaction is applied before every save:
    - the host-runner log lines and request files
    - the kit's `test-output.txt`
    - verify's `results*.json`, `failures.json` and failure report
    - deliver's `REPORT.md`
  - The redacted failure report is what the build prompts read.

- [ ] **Step 1: Write failing tests:**
  - `'redact replaces ≥8-char values, leaves short ones'`
  - `'longest first: overlapping values fully hidden'`
  - `'agent log line containing the secret is saved redacted'`
  - `'REPORT.md never contains the raw value'`
  - `'test-output.txt is redacted'`
- [ ] **Step 2:** Run `npx vitest run tests/core/secrets.test.ts tests/agent tests/stages tests/kits`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(secrets): redact secret values everywhere text is saved`.

### Task 10: Outside services and real/stand-in labels

**Files:**
- Modify: `src/stages/spec.ts`, `src/stages/prompts/spec.md`, `src/stages/prompts/build.md`, `src/stages/prompts/role-infra.md`, `src/kits/types.ts`, `src/stages/deliver.ts`
- Test: `tests/stages/spec.test.ts`, `tests/stages/deliver.test.ts`

**Interfaces:**
- Produces:
  - `SpecDoc` gains `services: {name: string; envVars: string[]}[]`, defaulting to `[]`, and rendered as `## Outside services` in `spec.md`.
  - The PM prompt tells the agent to list every outside service and the env var names it needs, and to make the stand-in the default.
  - The build prompt says:
    - stand-in tests always run
    - tests against the real service put `[real]` in their name and skip unless all of that service's env vars are set
    - code reads secrets from env vars only
  - The infra prompt says to create `.env.example` with the variable names and no values.
  - `CheckResult` gains `evidence?: 'real'|'stand-in'`. It's `real` when at least one passing test for the check has `[real]` in its name. It's `stand-in` when the check has tests but none of them is a passing `[real]` test.
  - `REPORT.md` shows the label in the acceptance table, and lists services with `real` or `stand-in only`.

- [ ] **Step 1: Write failing tests:**
  - `'spec.md renders Outside services'`
  - `'PM prompt requires services and stand-in default'`
  - `'check with a passing [real] test → evidence real; otherwise stand-in'`
  - `'REPORT shows labels and services'`
- [ ] **Step 2:** Run `npx vitest run tests/stages`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat: outside services with real/stand-in evidence`.

### Task 11: Deliver for change jobs, docs and the end-to-end check

**Files:**
- Modify: `src/stages/deliver.ts`, `README.md`, `CLAUDE.md`, `tests/e2e/new-project.e2e.test.ts`
- Create: `tests/e2e/change-job.e2e.test.ts` (gated on `ANTON_E2E` + `ANTHROPIC_API_KEY`)
- Test: `tests/stages/deliver.test.ts`

**Interfaces:**
- Produces:
  - For change jobs, `REPORT.md` adds a line `Branch to merge: anton/<jobId>` (merging is up to you) and a `## Regressions` section listing any remaining regressions, or "None."
  - The Security section shows `pre-existing` findings in their own group.
  - The README documents `adopt`, `change`, `secrets edit`, branches, the baseline, stand-in vs real, and redaction. The project `CLAUDE.md` gains one line: "Secret values are redacted via `redact()` in src/core/secrets.ts; new save points must use it."
  - The change-job E2E test adopts a tiny fixture repo, runs `change`, approves, and waits for review. It asserts:
    - the branch exists
    - `main` is unchanged
    - `REPORT.md` has the `Branch to merge` line
  - Like every paid test, it's written but not run without a key.

- [ ] **Step 1: Write failing tests:**
  - `'change job report names the branch and regressions'`
  - `'pre-existing findings grouped'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/deliver.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Then run `npm run build:image`.
- [ ] **Step 4:** Run the full `npx vitest run`, `npx tsc --noEmit`, `npm run build`, and `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`. Expected: all pass, and the paid E2E tests are skipped.
- [ ] **Step 5:** Commit `feat: deliver change jobs; docs for Phase 3a`.
