# Son of Anton: Phase 2, The Team and Reviewers

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the single Phase 1 build agent into a role-split team (product manager, tech lead, frontend/backend/infra developers, QA) and add a code reviewer and a security reviewer. Each reviewer runs only when the kit's checks pass. A blocking finding sends the work back to the developer responsible for that area.

**Architecture:**
- Roles are configuration: a `Role` → model/effort table, plus one prompt file per role.
- The tech lead tags each plan task with an area and writes the contract between the pieces.
- Build groups tasks by area (infra → backend → frontend) and passes handoff notes forward.
- Verify does three things:
  1. Runs the kit.
  2. Attributes each failure to an area in code (QA).
  3. When all checks pass, runs the code reviewer and then the security reviewer (container scanners first, then a read-only agent).
- Failures are persisted as structured items, so fix rounds go only to the areas that failed.

**Tech Stack:** Same as Phase 1: TypeScript/Node ≥22, zod, execa, vitest, and the Claude Agent SDK in the container. Scanners added to the fallback image: gitleaks, osv-scanner, Semgrep.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` (§6.3, §6.4, §6.4.1, the §7.1 model table, §11.1). Also see the roadmap `docs/superpowers/plans/2026-11-19-son-of-anton-roadmap.md` and Phase 1's `docs/superpowers/plans/2026-11-19-phase-1-followups.md`.

## Global Constraints

- **All Phase 1 constraints still hold:**
  - $10 default job budget; warn once at 80%; at most 3 build⇄verify rounds.
  - Atomic writes for state and evidence.
  - Code does the mechanical work.
  - Every stage starts a fresh agent session with a minimal context.
  - Never push, merge or deploy.
  - Agents act only inside the container.
- **Role → model/effort (§7.1), exactly:**

  | Role | Model | Effort |
  |---|---|---|
  | `pm` | `claude-opus-5-5` | high |
  | `tech_lead` | `claude-opus-5-5` | medium |
  | `frontend`, `backend`, `infra` | `claude-sonnet-5-5` | medium |
  | `qa` | `claude-sonnet-5-5` | medium |
  | `code_reviewer` | `claude-sonnet-5-5` | medium |
  | `security_reviewer` | `claude-sonnet-5-5` | high |
  | `coach` | `claude-haiku-5-5` | low |

- **Build order is infra → backend → frontend.** Developers work one at a time, never in parallel. Only areas that have tasks take part.
- **The infra developer never deploys.** It works on local setup only: Docker, CI config, migrations, env/config, `.env.example`.
- **Security severity:** `critical` and `high` block, unless the risk has been accepted. `medium` and `low` are listed and don't block.
- **Reviewers are read-only.** Their agent sessions get only the `Read`, `Grep` and `Glob` tools, never Edit, Write or Bash.
- **QA is code-only in Phase 2 (my call).** It attributes each failure to an area from the plan's task↔check mapping. The `qa` model entry is reserved for agent-driven QA with the web kit in Phase 3, so no tokens are spent on what code can decide.
- **Reviewers run only when every acceptance check passes and the smoke run is OK.** Broken code is fixed first, so no tokens are spent reviewing it.
- **Out of scope for Phase 2:**
  - the security baseline pass for adopted repos (Phase 3, together with `adopt`)
  - plugin-update security review (Phase 4)
  - Slack posting by role (Phase 6)
  - the coach and retro (Phase 5)

## Review Focus

1. **A reviewer must not change code.** Its request carries `tools: ['Read','Grep','Glob']` and the entry enforces that list. Tests in Task 4.
2. **A huge round diff must not blow the budget.** The diff given to a reviewer is trimmed, and the prompt says the full diff is in the repo. Test in Task 4.
3. **A scanner that is missing, crashes or emits invalid JSON must not crash verify or block the job.** The result records `unavailable: <tool>` and shows it in the report. Test in Task 5.
4. **The same blocking finding returning every round must end in `no_progress`, not burn all rounds.** Finding IDs feed the failure signature. Test in Task 7.
5. **An accepted risk must stay accepted across rounds.** Security finding IDs are stable: they hash the tool/rule, file and title, never the line number. Accepted IDs never block. Tests in Tasks 6 and 7.

---

## File structure

```
src/core/config.ts             + Role, ROLE_MODELS (DEFAULTS.models removed)
src/stages/plan.ts             + area per task, contract; validation
src/stages/prompts/            plan.md (tech lead), spec.md (+ security checks),
                               role-frontend.md, role-backend.md, role-infra.md,
                               code-review.md, security-review.md
src/stages/build.ts            area ordering, per-role sessions, handoffs, area-routed fixes
src/stages/handoffs.ts         read/collect handoff notes
src/agent/protocol.ts, entry.ts + tools?: string[] (read-only sessions)
src/core/git.ts                + diffSince(repo, sha)
src/review/code-review.ts      code reviewer agent → ReviewFinding[]
src/security/scanners.ts       run + parse gitleaks / osv-scanner / semgrep in the container
src/security/review.ts         security reviewer agent → SecurityFinding[]; stable ids
src/security/risks.ts          accepted-risks store
src/stages/qa.ts               area attribution of failures (code-only QA)
src/stages/verify.ts           kit → QA → reviewers; failures.json; signature; reviewedSha
src/stages/deliver.ts          + Code review and Security sections
src/cli/commands/accept-risk.ts  `anton accept-risk`
src/kits/fallback/Dockerfile   + pinned scanners
```

---

### Task 1: Role model table

**Files:**
- Modify: `src/core/config.ts`, `src/stages/spec.ts`, `src/stages/plan.ts`, `src/stages/build.ts`
- Test: `tests/core/config.test.ts`, plus the existing stage tests (update their model assertions)

**Interfaces:**
- Produces:
  - `type Role = 'pm'|'tech_lead'|'frontend'|'backend'|'infra'|'qa'|'code_reviewer'|'security_reviewer'|'coach'`
  - `ROLE_MODELS: Record<Role, ModelConfig>`
  - `type Area = 'frontend'|'backend'|'infra'`
  - `AREA_ORDER: Area[] = ['infra','backend','frontend']`
  - `DEFAULTS.models` is removed. Spec uses `ROLE_MODELS.pm`, plan uses `ROLE_MODELS.tech_lead`, and build uses `ROLE_MODELS[area]`.
  - The `role` field of each AgentRequest is the role name, e.g. `'pm'`, `'tech_lead'` or `'backend'`.

- [ ] **Step 1: Write failing tests.**
  - `config.test.ts`: `ROLE_MODELS` deep-equals the Global Constraints table, all 9 roles.
  - `AREA_ORDER` equals `['infra','backend','frontend']`.
  - Update `spec.test.ts` and `plan.test.ts` to assert `role: 'pm'` and `role: 'tech_lead'`, each with the table's model and effort.
- [ ] **Step 2:** `npx vitest run tests/core/config.test.ts tests/stages` → FAIL.
- [ ] **Step 3:** Implement the table and switch the callers over. Keep the `ModelConfig` and `Effort` exports.
- [ ] **Step 4:** `npx vitest run` and `npx tsc --noEmit` → PASS.
- [ ] **Step 5:** Commit `feat(config): role model table`.

### Task 2: Tech lead plans by area with a contract

**Files:**
- Modify: `src/stages/plan.ts`, `src/stages/prompts/plan.md`
- Test: `tests/stages/plan.test.ts`

**Interfaces:**
- Consumes: `Area` (Task 1).
- Produces:
  - `PlanSchema` tasks gain `area: z.enum(['frontend','backend','infra'])`.
  - The plan gains `contract: z.string().optional()`.
  - `validatePlanAreas(plan)` throws `PlanInvalid('plan spans <n> areas but has no contract')` when tasks cover two or more areas and `contract` is missing or blank.
  - `runPlan` calls `validatePlanAreas` after `validatePlanCoverage`.
  - `plan.md` shows a `## Contract` section when one is present, and each task's heading line shows `[area]`.

- [ ] **Step 1: Write failing tests:**
  - `'plan with backend+frontend tasks and no contract is rejected naming 2 areas'`
  - `'single-area plan without contract is valid'`
  - `'task without area fails schema'`
  - `'plan.md shows contract and [area] tags'`
  - `'tech lead prompt states the build order infra → backend → frontend and asks for an API/interface contract when more than one area is involved'` (asserts substrings in the loaded prompt).
- [ ] **Step 2:** Run `npx vitest run tests/stages/plan.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the change. In `plan.md`, add the tech-lead rules: tag each task with one area; developers work in the order infra → backend → frontend; write the contract (API shapes, shared types, env var names) that frontend and backend both build against.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plan): area tags and contract`.

### Task 3: Build by area with role prompts and handoffs

**Files:**
- Create:
  - `src/stages/handoffs.ts`
  - `src/stages/prompts/role-frontend.md`, `role-backend.md`, `role-infra.md`
- Modify: `src/stages/build.ts`
- Test: `tests/stages/build.test.ts`, `tests/stages/handoffs.test.ts`

**Interfaces:**
- Consumes: `Plan` with `area` and `contract` (Task 2); `ROLE_MODELS`, `AREA_ORDER` (Task 1).
- Produces:
  - `orderTasks(plan): Plan['tasks']`. Tasks are stable-sorted by `AREA_ORDER`, keeping plan order within each area.
  - `handoffPath(jobDir, area)` returns `<jobDir>/handoffs/<area>.md`. The container path is `/workspace/.anton/jobs/<jobId>/handoffs/<area>.md`.
  - `readHandoffs(jobDir): Promise<{area: Area; text: string}[]>`. It returns handoffs in `AREA_ORDER` and skips missing files.
- Behavior:
  - Each task session uses `role: task.area` and `ROLE_MODELS[task.area]`.
  - Its system prompt is `build.md` followed by `role-<area>.md`, with `systemPromptMode: 'append'`.
  - Its prompt includes the plan's contract, if any, and the trimmed text of every existing handoff.
  - For the last task of each area, the prompt adds: "Before finishing, write a short handoff note for the next developer to `<container handoff path>`: what you built, where, and how to use it."
  - Commits stay `T<n>: <title>` and crash-resume stays per task, as in Phase 1. `role-infra.md` states the no-deploy rule.

- [ ] **Step 1: Write failing tests:**
  - `'orderTasks puts infra, then backend, then frontend, keeping plan order within an area'`
  - `'each session uses the task area as role and ROLE_MODELS[area]'`
  - `'system prompt is build.md + role-<area>.md'`
  - `'last task of an area asks for a handoff at the container path; other tasks do not'`
  - `'a frontend task prompt contains the backend handoff text and the contract'` (write the backend handoff file in the test)
  - `'role-infra prompt forbids deploying'`
  - `readHandoffs` returns handoffs in area order and skips missing files
- [ ] **Step 2:** Run `npx vitest run tests/stages/build.test.ts tests/stages/handoffs.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the change. Fix mode is left as is in this task (Task 8 replaces it).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(build): role-split developers with handoffs`.

### Task 4: Read-only sessions, round diff and the code reviewer

**Files:**
- Modify: `src/agent/protocol.ts`, `src/agent/entry.ts`, `src/core/git.ts`
- Create: `src/review/code-review.ts`, `src/stages/prompts/code-review.md`
- Test: `tests/agent/entry.test.ts`, `tests/core/git.test.ts`, `tests/review/code-review.test.ts`

**Interfaces:**
- Produces:
  - `AgentRequestSchema` gains `tools: z.array(z.string()).optional()`.
  - The entry passes `tools` to the SDK as the session's allowed tool set. Check the exact option in the installed `sdk.d.ts` (`tools` vs `allowedTools`) and record the choice in the entry header comment. When `tools` is set, no other built-in tool may be usable.
  - `diffSince(repo, sha): Promise<string>`: `git diff <sha>..HEAD`, using the existing SAFE flags and env.
  - `type ReviewFinding = {id: string; severity: 'blocking'|'non_blocking'; area: Area; file: string; line?: number; summary: string}`. The id is `CR-<first 8 hex of sha256(file + '\n' + summary)>`.
  - `runCodeReview(ctx: StageCtx, spec: SpecDoc, plan: Plan, baseSha: string, deps?: {runAgent?, diffSince?}): Promise<{findings: ReviewFinding[]; state: JobState}>`
  - The code-review session request:
    - `role: 'code_reviewer'` with `ROLE_MODELS.code_reviewer`
    - `tools: ['Read','Grep','Glob']`
    - `maxTurns: 30`
    - `budgetUsd = remainingUsd(state)`
    - `outputSchema`: an object-root `{findings: [...]}`, without `id`; the host computes the ids
    - The prompt holds the spec, the plan's contract and task list, and the round diff trimmed with `trimOutput(diff, {headLines: 400, tailLines: 400})`, with a note that the full code is readable in `/workspace`.

- [ ] **Step 1: Write failing tests:**
  - entry: `'tools restricts the session to exactly the listed tools'` (the option is passed through)
  - entry: `'no tools field leaves defaults unchanged'`
  - git (real git): `diffSince` returns only the changes after the given sha, and ignores repo hooks (reuse the existing hook-marker pattern)
  - code-review:
    - `'request is read-only: tools exactly [Read, Grep, Glob], role code_reviewer, sonnet-5-5/medium'`
    - `'a 5000-line diff is trimmed in the prompt (contains the trimmed marker)'`
    - `'ids are stable for the same file+summary regardless of line'`
    - `'object-root output schema'`
- [ ] **Step 2:** Run `npx vitest run tests/agent/entry.test.ts tests/core/git.test.ts tests/review`. Expected: FAIL.
- [ ] **Step 3:** Implement. Rebuild the image staging (`npm run build:image`) because the entry changed.
- [ ] **Step 4:** Run the tests, `npx tsc --noEmit` and `npm run build:image`. Expected: PASS, and the image builds.
- [ ] **Step 5:** Commit `feat(review): read-only code reviewer`.

### Task 5: Security scanners in the image

**Files:**
- Modify: `src/kits/fallback/Dockerfile`
- Create: `src/security/scanners.ts`
- Test: `tests/security/scanners.test.ts`, plus `tests/e2e/docker.e2e.test.ts` (scanner `--version` checks, gated by `ANTON_E2E`)

**Interfaces:**
- Consumes: `runIn` (Phase 1).
- Produces:
  - `type ScannerFinding = {tool: 'gitleaks'|'osv-scanner'|'semgrep'; ruleId: string; severity: 'critical'|'high'|'medium'|'low'; file: string; line?: number; message: string}`
  - `runScanners(container: string, deps?: {runIn?}): Promise<{findings: ScannerFinding[]; unavailable: string[]}>`
  - Each scanner runs from `/workspace` with JSON output:
    - `gitleaks detect --no-banner --report-format json --report-path /tmp/gitleaks.json` (scans git history)
    - `osv-scanner scan source -r --format json .`
    - `semgrep scan --config p/default --json --metrics=off .`
  - Severity mapping:
    - gitleaks → `high`
    - osv: CVSS ≥ 9 → `critical`, ≥ 7 → `high`, ≥ 4 → `medium`, otherwise `low`. With no CVSS score, use `medium`.
    - semgrep: `ERROR` → `high`, `WARNING` → `medium`, `INFO` → `low`
  - A scanner that exits with "command not found" (127), times out (5 min each), or emits unparseable output is added to `unavailable` and never throws.
  - The paths `/workspace/.anton/**` and `node_modules/**` are excluded from results.
- Dockerfile:
  - Install pinned versions of all three scanners. Pick the latest stable release of each, and record the version and SHA-256 checksum in the Dockerfile.
  - gitleaks and osv-scanner: release binaries chosen per architecture via `TARGETARCH`, verified with `sha256sum -c`.
  - semgrep: `pip install semgrep==<ver>` into a venv on `PATH`.

- [ ] **Step 1: Write failing tests** with a fake `runIn` that returns recorded JSON fixtures for each tool. Put the fixtures in `tests/security/fixtures/`, as minimal real-shaped outputs:
  - `'maps gitleaks leak to high'`
  - `'maps osv CVSS 9.8 to critical, 5.0 to medium'`
  - `'maps semgrep ERROR/WARNING/INFO to high/medium/low'`
  - `'missing tool (exit 127) → unavailable, no throw'`
  - `'invalid JSON → unavailable'`
  - `'findings under .anton/ and node_modules/ are dropped'`
- [ ] **Step 2:** Run `npx vitest run tests/security/scanners.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement the Dockerfile and `scanners.ts`.
- [ ] **Step 4:** Run the tests. Then run `npm run build:image` and `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`. Expected: PASS, with each scanner's `--version` succeeding in the built image.
- [ ] **Step 5:** Commit `feat(security): pinned scanners in the kit image`.

### Task 6: Security reviewer and accepted risks

**Files:**
- Create: `src/security/review.ts`, `src/security/risks.ts`, `src/stages/prompts/security-review.md`
- Test: `tests/security/review.test.ts`, `tests/security/risks.test.ts`

**Interfaces:**
- Consumes:
  - `runScanners` (Task 5)
  - `diffSince`, the `tools` request field, and the trimming approach (Task 4)
  - `Area` (Task 1)
- Produces:
  - `type SecurityFinding = {id: string; severity: 'critical'|'high'|'medium'|'low'; area: Area; file: string; line?: number; title: string; detail: string; source: 'scanner'|'review'; tool?: string}`
  - Finding ids are `SEC-<first 8 hex of sha256(source + '\n' + (tool ?? '') + '\n' + file + '\n' + title)>`. The line number is never part of the id.
  - `runSecurityReview(ctx, spec, plan, baseSha, deps?: {runAgent?, runScanners?, diffSince?}): Promise<{findings: SecurityFinding[]; unavailable: string[]; state: JobState}>`
    1. Runs the scanners.
    2. Runs a read-only agent with `role: 'security_reviewer'` and `ROLE_MODELS.security_reviewer` (sonnet-5-5/high), `tools: ['Read','Grep','Glob']` and `maxTurns: 30`.
    3. The agent's input is the scanner findings plus the trimmed round diff.
    4. The agent returns `{findings: [...]}`. It keeps true scanner findings (with an area, and severity adjusted only with a stated reason), drops false positives, and adds review findings for: authentication and access control, injection, unsafe input handling, data leaking through errors or logs, and misuse of secrets.
  - `blocking(findings, accepted: Set<string>): SecurityFinding[]` returns the `critical` and `high` findings whose id isn't in `accepted`.
  - `risks.ts`:
    - `loadAcceptedRisks(jobDir): Promise<{id: string; reason: string; acceptedAt: string}[]>`, stored in `<jobDir>/evidence/accepted-risks.json`
    - `acceptRisk(jobDir, id, reason): Promise<void>`. It writes atomically and is idempotent per id; re-accepting an id updates the reason.

- [ ] **Step 1: Write failing tests:**
  - `'request is read-only, role security_reviewer, sonnet-5-5/high'`
  - `'scanner findings are passed into the prompt'`
  - `'id ignores line: same finding on a different line keeps its id'`
  - `'blocking returns only critical/high not in accepted'`
  - `'acceptRisk then loadAcceptedRisks round-trips; re-accept updates reason'`
  - `'unavailable scanners are returned unchanged'`
- [ ] **Step 2:** Run `npx vitest run tests/security`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(security): security reviewer and accepted risks`.

### Task 7: Verify with QA attribution and reviewers

**Files:**
- Create: `src/stages/qa.ts`
- Modify: `src/stages/verify.ts`, `src/core/state.ts`
- Test: `tests/stages/qa.test.ts`, `tests/stages/verify.test.ts`, `tests/core/state.test.ts`

**Interfaces:**
- Consumes: `runCodeReview` (Task 4), `runSecurityReview`, `blocking` and `loadAcceptedRisks` (Task 6), and `Plan` with areas (Task 2).
- Produces:
  - `JobState` gains `reviewedSha: z.string().optional()`.
  - `type FailureItem = {area: Area; kind: 'check'|'run'|'review'|'security'; id: string; text: string}`
  - `attributeFailures(results, runOk, plan, runFailureText): FailureItem[]` is the code-only QA step:
    - A failing check maps to the areas of the tasks covering it, one item per area.
    - A failed smoke run maps to `infra` if the plan has infra tasks, otherwise to `backend` if it has backend tasks, otherwise to the first area present.
  - `failuresPath(jobDir)` returns `<jobDir>/evidence/failures.json`.
  - `runVerify(ctx, kit, spec, plan, deps?: {runCodeReview?, runSecurityReview?, headSha?})`:
    1. Run the kit.
    2. If any check fails or the smoke run fails: attribute the failures; skip both reviewers.
    3. Otherwise run the code reviewer, then the security reviewer, both with `baseSha = state.reviewedSha ?? <sha of tag anton/<jobId>/spec-approved>`. Blocking review findings and non-accepted critical/high security findings become `FailureItem`s with `kind` `review` or `security`.
    4. Write `results.json`, adding `review: {findings}` and `security: {findings, unavailable}` when the reviewers ran. Write `failures.json` and the markdown failure report (grouped `### <area>` sections). All writes are atomic.
    5. On pass, set `reviewedSha = HEAD` and remove `failures.json` together with the failure report.
  - `failureSignature` now takes `FailureItem[]`: the sorted `kind:id` entries, joined with `|`. Review and security finding ids are included, so a repeated finding leads to `no_progress`.
  - The R1 order is unchanged: `round_cap` is checked before `no_progress`.

- [ ] **Step 1: Write failing tests:**
  - qa: `'failing AC covered by backend+frontend tasks yields two items'`
  - qa: `'run failure goes to infra when infra tasks exist, else backend'`
  - verify: `'checks failing → reviewers not called'`
  - verify: `'all pass → code then security reviewer called with baseSha = spec-approved sha on first round and reviewedSha afterwards'`
  - verify: `'blocking code finding → transitions to build with a review FailureItem'`
  - verify: `'high security finding blocks; same id accepted → passes'`
  - verify: `'medium/low and non_blocking findings never block'`
  - verify: `'same blocking finding two rounds running → paused no_progress'`
  - verify: `'pass sets reviewedSha to HEAD and removes failures.json'`
  - verify: `'results.json carries review/security sections incl. unavailable scanners'`
  - state: `'reviewedSha optional round-trips'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/qa.test.ts tests/stages/verify.test.ts tests/core/state.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement. Read the spec-approved sha with `git rev-parse` through the safe git wrapper (add `revParse(repo, ref)` to `git.ts` if it doesn't exist yet).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(verify): QA attribution and reviewers`.

### Task 8: Area-routed fix rounds

**Files:**
- Modify: `src/stages/build.ts`, `src/cli/commands/reject.ts`
- Test: `tests/stages/build.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `failuresPath` and `FailureItem` (Task 7); the role prompts (Task 3).
- Produces fix mode, which runs when `failures.json` exists, or (as in R11) when all tasks are done and the persisted report exists:
  - Group the items by area. For each area, in `AREA_ORDER`, start one session with `role: area`, `ROLE_MODELS[area]` and that role's prompt.
  - Each session's prompt holds only that area's failure items, plus the contract and the handoffs.
  - After each area's session, commit `fix: round <n> (<area>)`.
  - Crash safety: record finished areas in `state.completedFixAreas` (a new optional `string[]`, reset when a new round starts). Resume skips the areas already done.
  - Reject notes from `anton reject` are written to `failures.json` as one `FailureItem` per area present in the plan, with `kind: 'review'`, `id: 'NOTES-<round>'` and the notes as text. They are also still written to `notes-round-<n>.md`.

- [ ] **Step 1: Write failing tests:**
  - `'fix round runs backend then frontend sessions only, each with only its items'`
  - `'commit message per area'`
  - `'crash after backend fix: resume runs only frontend'`
  - `'reject notes fan out to every plan area'`
  - `'no failures.json and no persisted report → normal mode'` (regression)
- [ ] **Step 2:** Run `npx vitest run tests/stages/build.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement (the `JobState` field and transitions are in `state.ts`).
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(build): fixes routed to the failing area`.

### Task 9: Security in the spec, `accept-risk`, and the report

**Files:**
- Modify: `src/stages/prompts/spec.md`, `src/stages/deliver.ts`, `src/cli/index.ts`
- Create: `src/cli/commands/accept-risk.ts`
- Test: `tests/stages/spec.test.ts`, `tests/stages/deliver.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `acceptRisk` and `loadAcceptedRisks` (Task 6); the review and security sections of `results.json` (Task 7).
- Produces:
  - **PM prompt (`spec.md`):** for projects with logins, user data, payments or anything exposed to the network, add security acceptance checks, e.g. "a logged-out user can't reach /admin".
  - **`anton accept-risk <project> <findingId> --reason "<text>"`:**
    - Allowed only when the job is `paused` or at `awaiting_final_review`.
    - The id must match `SEC-` and exist in the latest `results.json`. Otherwise it exits 1 with the message `Unknown security finding <id>`.
    - `--reason` is required and must not be blank.
    - It prints the finding title and `accepted`.
  - **`REPORT.md`** gains two sections after Acceptance checks:
    - `## Code review`: every finding with its id, severity, area, file and summary, or "No findings."
    - `## Security`: findings grouped by severity, with accepted risks and their reasons marked `accepted`. It lists security findings from earlier rounds that are no longer present as `fixed`, read from earlier `results.json` copies. Verify must therefore also keep `evidence/results-round-<n>.json`; add that write in this task. It notes any unavailable scanners.

- [ ] **Step 1: Write failing tests:**
  - spec: `'PM prompt requires security acceptance checks for logins/user data/payments/network exposure'`
  - cli: `'accept-risk records reason; rejects unknown id; rejects blank reason; refuses at stage build'`
  - deliver: `'Security section lists accepted risk with reason'`
  - deliver: `'finding present in round 1, absent in round 2 is listed as fixed'`
  - deliver: `'unavailable scanner noted'`
  - deliver: `'Code review section lists findings or No findings.'`
- [ ] **Step 2:** Run `npx vitest run tests/stages/spec.test.ts tests/stages/deliver.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat: accept-risk and security/code-review report sections`.

### Task 10: Wiring, README and the end-to-end check

**Files:**
- Modify: `src/pipeline/runner.ts` (pass the new verify deps through), `README.md`, `tests/e2e/new-project.e2e.test.ts`, `tests/pipeline/runner.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces:
  - The runner keeps `runVerify`'s new deps injectable.
  - The `round_cap` and `no_progress` pause messages mention `anton accept-risk` when the latest `failures.json` contains security items.
  - The README describes:
    - the team (a role table)
    - the build order
    - when the reviewers run
    - severity rules and `accept-risk`
    - that scanners are part of the image, so `npm run build:image` must be re-run
  - The E2E test additionally asserts that REPORT.md contains `## Code review` and `## Security`. It stays gated on `ANTON_E2E` and the API key.

- [ ] **Step 1: Write failing tests:**
  - runner: `'round_cap pause with security failures mentions accept-risk'`
  - runner: `'verify deps are forwarded'`
- [ ] **Step 2:** Run `npx vitest run tests/pipeline`. Expected: FAIL.
- [ ] **Step 3:** Implement. Then run `npm run build:image`.
- [ ] **Step 4:** Run the full `npx vitest run`, `npx tsc --noEmit`, `npm run build`, then `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`. Expected: everything passes. The paid E2E is skipped without a key.
- [ ] **Step 5:** Commit `feat: wire Phase 2 team and reviewers; README`.
