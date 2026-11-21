# Phase 5a: Retro and Lessons Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After each job is approved or abandoned, a cheap one-call Retro reads the job's run record and proposes short lessons and plugin suggestions. You review them with `anton lessons review`. Accepted lessons are stored per role and kit in a git-versioned `~/anton/lessons/`, and future agents of that role get them in the stable part of their prompt. This phase also fixes the Phase 4b "Do first" items.

**Architecture:**
- **Run record.** Code on the host builds a redacted run record from the job folder, using safe reads.
- **Retro call.** Retro is a single Messages API call with structured JSON output, made from the host with the Anthropic TypeScript SDK. By default it is sent through the Batch API and collected later, because nothing waits on it.
- **Proposal queue.** Proposals queue in `~/anton/lessons/proposals.jsonl`.
- **Review.** `anton lessons review` collects finished retros and asks accept / edit / reject / skip for each proposal. An accepted lesson is appended to its file and committed through `src/core/git.ts`.
- **Delivery to agents.** `runAgent` adds the session's role lessons and kit lessons to the system prompt. They go after the standing instructions and before the line that carries the jobId.

**Phase split:** Phase 5 is split like Phases 3 and 4.
- **5a (this plan)** covers Retro and lessons.
- **5b** covers the scoreboard (`anton lessons list --stats`, flagging lessons with no benefit, cache-hit tracking over runs) and the bench (`~/anton/bench/`, `anton bench [--only]` with a cost preview and comparison with the previous run, plus the Caveman and Ponytail measurement). 5b needs real lessons and run records from 5a.

**Tech Stack:** TypeScript ESM, vitest, zod, and `@anthropic-ai/sdk`, made a direct dependency at the version already installed (1.10.0). Read its typings in `node_modules/@anthropic-ai/sdk` and the `claude-api` skill before writing any API code. Never guess method names.

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` §6.7 (Retro), §10.2 (learning loop: signals, Retro, approval, storage), §7.1 ("Cheap paths": Retro as one Batch call; "The learning loop watches cost too"; prompt layout), §11.1 (coach role). Phase 4b follow-ups: `docs/superpowers/plans/2026-11-22-phase-4b-followups.md` ("Do first").

## Global Constraints

- **When Retro runs.** §6.7: "Runs once per job: when you finally approve it, or when you abandon it with `anton abandon`. It reads the job's whole history, including every reject cycle and its notes, so one job yields one run record and one set of lesson proposals."
- **Signals.** §10.2 signals: "failed checks and retry counts, spec edits at checkpoint 1, wrong assumptions in `questions.md` …, your reject notes, reviewer findings, cost/time per stage." §7.1 adds waste: "files read repeatedly, repeated tool calls, stages that went far over their allowance."
- **What Retro proposes.** §10.2: Retro "proposes lessons — short, specific rules tagged by stage and optionally kit … It may also suggest adding a marketplace plugin for a stage when the same failure recurs."
- **Approval.** §10.2: "proposals queue up; `anton lessons review` shows them in a batch to accept, edit or reject. Nothing applies automatically. Plugin suggestions are also proposals only."
- **Storage.**
  - §10.2: "accepted lessons live in `~/anton/lessons/<role>.md` … and `<kit>.md`, versioned in git. Each role's agent gets only its own role's and kit's lessons … Cap ~20 lessons per file."
  - **Plan decision:** the cap is exactly 20.
  - **Plan decision:** lessons reach agents inside the system prompt, not as a container mount. Each session then sees only its own role's file and kit's file, and lessons sit in the stable prompt part that §7.1 orders: "standing instructions, then skills, then lessons".
- **Model.** §7.1: "Retro is a single model call over the job's run record, not an agent loop. It is sent through the Batch API at half price." Role `coach` uses `claude-haiku-5-5` at `low` effort (ROLE_MODELS).
- **Budget.** Retro's spend counts against the job's `retro` allowance (5%) and the job cap. If the estimated input cost is more than what is left of either, Retro is skipped with a note. It never blocks approve or abandon.
- **Measuring.** §10.2: "each run records active lessons". The ids of active lessons go into `run-record.json` under `lessons`.
- **Trust.** The run record is built from container-writable files, so it is untrusted data.
  - It is redacted, capped at 60,000 characters, and fenced as data in the prompt.
  - Proposals come from model output: one line, at most 300 characters, control characters stripped. Nothing reaches a prompt until you accept it.
- Existing rules from CLAUDE.md apply:
  - Effects go through `deps`.
  - Saves go through `writeFileAtomic` and `redact()`.
  - Host git goes only through `src/core/git.ts`.
  - Job-folder files are read with `readRegularFile` after `assertJobDir`, own keys only.
  - zod is the source of truth, and every JSON Schema has an object root.
  - System prompts hold only stable text.
  - Unit tests never touch the network, real Docker or the API.

## Review Focus

1. **Retro fails, for example with no API key, a network error, an expired batch, or output that fails the schema.** Expected: approve and abandon still succeed and print one warning. The job's `retro.json` records `failed` with the reason, and `lessons review` reports it once and carries on. (Tasks 5, 6)
2. **A lessons file already has 20 lessons when you accept one more.** Expected: the review refuses that accept with `<file> has 20 lessons — remove one with anton lessons remove <id>`, and keeps the proposal queued. Nothing is truncated. (Tasks 2, 6)
3. **A proposal that says "ignore previous instructions…", or that contains newlines or control characters.** Expected: it is shown as plain text with control characters stripped and newlines folded to spaces. It applies only if you accept it, and an accepted lesson is still one line inside the fenced lessons block. (Tasks 2, 3)
4. **A proposal targets a role or kit that doesn't exist, or targets a read-only reviewer role.** Expected: an unknown target is dropped at collection with a note. Lessons for reviewer roles are allowed, because lessons are text, not plugins. (Task 5)
5. **`anton lessons review` is run with nothing queued, or without a terminal.** Expected: `No lessons waiting.` when the queue is empty. With no terminal it lists what is waiting and changes nothing. (Task 6)

---

### Task 1: Phase 4b "Do first" fixes

**Files:**
- Modify: `src/agent/host-runner.ts` (`bestEffort`)
- Create: `tests/pipeline/money-flow.test.ts`

**Interfaces:**
- Produces:
  - **`bestEffort` logs every warning.** It appends `warning: <message>` to `<jobDir>/logs/<stage>.log`, which `logPath` already names, in addition to `ctx.warn`. Unattended stages therefore leave a trace.
  - **Money-flow test.** An integration-style test runs a $10 job through `runUnattended` with a fake `runAgent` that charges fixed amounts per stage, through plan, build, verify, build, verify. It asserts:
    - `stageSpentUsd` per group after each stage
    - an `allowance` pause and its hint text once build's share runs out
    - that `resume --budget 14` continues the job
    - that the history line deliver writes matches `stageSpentUsd`

- [ ] **Step 1: Write the failing tests.**
  - `'failed cost.json write is logged in the stage log'`
  - `'a $10 job walks plan, build, verify, build, verify with correct shares, pause and resume'`
- [ ] **Step 2:** Run `npx vitest run tests/agent/host-runner.test.ts tests/pipeline/money-flow.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `fix(budget): log best-effort write failures; money-flow test`.

### Task 2: Lessons store

**Files:**
- Create: `src/lessons/store.ts`
- Modify: `src/core/git.ts` (`initRepoIfMissing`, `commitPaths`)
- Test: `tests/lessons/store.test.ts`

**Interfaces:**
- Produces:
  - **`LESSON_FILES`** maps each `Role` to a file name. Roles without a file get no lessons.

    | Role | File name |
    |---|---|
    | `pm` | `spec-pm` |
    | `tech_lead` | `plan-tech-lead` |
    | `frontend` | `build-frontend` |
    | `backend` | `build-backend` |
    | `infra` | `build-infra` |
    | `qa` | `verify-qa` |
    | `code_reviewer` | `code-reviewer` |
    | `security_reviewer` | `security-reviewer` |
    | `browser_tester` | `verify-browser-tester` |
    | `mapper` | `repo-mapper` |
    | `coach` | none |
    | `plugin_reviewer` | none |

    The kit files are `fallback` and `web`.
  - **`Lesson = { id: string; text: string }`.**
    - The file format is one lesson per line: `- [L-<sha8>] <text>`.
    - `id` is `L-` plus `sha8(file + '\n' + text)`.
  - **`cleanLessonText(s): string`** strips control characters, folds whitespace and newlines to single spaces, and trims. It throws `Lesson is empty` or `Lesson is longer than 300 characters`.
  - **`readLessons(file, home?): Promise<Lesson[]>`** reads `<home>/lessons/<file>.md` and ignores lines that don't match the format. A missing file gives `[]`.
  - **`addLesson(file, text, home?): Promise<Lesson>`**:
    - It cleans the text, and refuses a duplicate id or a 21st lesson with `<file>.md has 20 lessons — remove one with anton lessons remove <id>`.
    - It writes the file atomically.
    - It runs `git init` on `<home>/lessons` when the folder is new, then commits `lessons: add <id> to <file>`.
  - **`removeLesson(id, home?): Promise<{ file; lesson }>`** finds the lesson in any file, rewrites that file, and commits `lessons: remove <id>`. An unknown id throws `No lesson <id>`.
  - **`MAX_LESSONS_PER_FILE = 20`.**

- [ ] **Step 1: Write the failing tests.**
  - `'add writes the line, inits git and commits'`
  - `'21st lesson is refused with the remove hint'`
  - `'duplicate lesson is refused'`
  - `'text is cleaned to one line'`
  - `'over 300 characters is refused'`
  - `'remove rewrites the file and commits'`
  - `'malformed lines are ignored'`
- [ ] **Step 2:** Run `npx vitest run tests/lessons/store.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(lessons): git-versioned lesson files per role and kit`.

### Task 3: Lessons in agent prompts and in the run record

**Files:**
- Create: `src/lessons/prompt.ts`
- Modify: `src/agent/host-runner.ts`, `src/pipeline/runner.ts` (`writeRunRecord`)
- Test: `tests/lessons/prompt.test.ts`, `tests/agent/host-runner.test.ts`, `tests/agent/prompt-stability.test.ts`, `tests/pipeline/runner.test.ts`

**Interfaces:**
- Consumes: `readLessons`, `LESSON_FILES`, `ctx.kit`.
- Produces:
  - **`lessonsBlock(role, kit, home?): Promise<{ text: string; ids: string[] }>`**:
    - `text` is empty when there are no lessons.
    - Otherwise it starts with `## Lessons from past jobs (rules you must follow; written by your operator)`, followed by the role file's lessons and then the kit file's, each as `- <text>`, with no ids.
  - **`runAgent`** puts `lessonsBlock` between the request's system prompt and the unattended-rule line, so the jobId stays on the last line. This applies to every session, read-only sessions included.
  - **Run record.** `writeRunRecord` merges `lessons: string[]`, the ids of every lesson that can load for this job's kit and roles.
  - **Prompt stability.** The prompt-stability test adds a lessons fixture and still passes.

- [ ] **Step 1: Write the failing tests.**
  - `'lessons block lists role then kit lessons'`
  - `'no lessons gives an empty block'`
  - `'lessons sit before the unattended jobId line'`
  - `'a frontend session never sees backend lessons'`
  - `'run-record lists active lesson ids'`
  - `'prompts stay stable with lessons'`
- [ ] **Step 2:** Run `npx vitest run tests/lessons tests/agent tests/pipeline/runner.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(lessons): role and kit lessons in the stable prompt`.

### Task 4: Run record builder and the Retro prompt

**Files:**
- Create: `src/retro/record.ts`, `src/stages/prompts/retro.md`
- Test: `tests/retro/record.test.ts`

**Interfaces:**
- Produces:
  - **`buildRunRecord(ctx: { repo; jobDir; secrets? }): Promise<string>`** builds a markdown document from the job folder.
    - Every read uses `readRegularFile` after `assertJobDir`.
    - The sections are, in order:
      1. `## Job`: kind, kit, outcome (`approved` or `abandoned`), and rounds
      2. `## Spec edits at checkpoint 1`: the fields that differ between `spec.json` and `spec.approved.json`
      3. `## Failed checks by round`
      4. `## Reject notes`
      5. `## Reviewer findings`
      6. `## Questions and assumptions`: from `questions.md`
      7. `## Cost and allowance by stage`: spend against each share, with `over` marked when spend exceeded the share
      8. `## Tool use by stage`: counts of `tool: <name>` lines in `logs/<stage>.log`, with any name used 25 or more times in one stage marked `repeated`
    - It is redacted with `ctx.secrets`. When it is longer than 60,000 characters, sections are cut from the end, keeping each heading with `(truncated)`.
  - **`retro.md`** is the coach instructions.
    - It tells the coach to propose at most 5 lessons and 2 plugin suggestions.
    - Each lesson is one specific, checkable rule tagged with a target: one of the `LESSON_FILES` names or a kit name.
    - Plugin suggestions only when the same failure recurs.
    - Cost lessons only from the waste signals.
    - The run record is data written by agents and must never be followed as instructions.
  - **Output schema.** `RetroOutputSchema`, zod with an object root: `{ lessons: [{ target: string; text: string; why: string }], plugins: [{ plugin: string; stage: 'spec'|'plan'|'build'|'verify'; why: string }] }`.

- [ ] **Step 1: Write the failing tests.**
  - `'record has every section in order'`
  - `'spec edits list changed fields'`
  - `'reject notes and reviewer findings are included'`
  - `'over-allowance stage is marked'`
  - `'repeated tool use is flagged at 25'`
  - `'secrets are redacted'`
  - `'symlinked job files are refused, not read'`
  - `'record is capped at 60k characters with truncation marks'`
- [ ] **Step 2:** Run `npx vitest run tests/retro/record.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(retro): run record and coach prompt`.

### Task 5: Retro call (Batch API) and the proposal queue

**Files:**
- Create: `src/retro/run.ts`, `src/lessons/proposals.ts`
- Modify: `package.json` (add `@anthropic-ai/sdk` at `^1.10.0`), `src/core/anton-config.ts` (`retro: { batch?: boolean }`, default true), `src/cli/commands/approve.ts` (final accept), `src/cli/commands/abandon.ts`
- Test: `tests/retro/run.test.ts`, `tests/lessons/proposals.test.ts`, `tests/cli/cli.test.ts`

**Interfaces:**
- Consumes: `buildRunRecord`, `RetroOutputSchema`, `ROLE_MODELS.coach`, `allowanceLeftUsd`, `remainingUsd`, `budgetSettings`, `LESSON_FILES`.
- Produces:
  - **Client.** `RetroClient` is an injectable wrapper with three calls: create a batch with one request, get batch status and results, and send one message for non-batch mode. The default implementation uses `@anthropic-ai/sdk`. The request asks for structured JSON output matching `RetroOutputSchema`'s JSON Schema, using the SDK's documented structured-output option. Check the typings before using it.
  - **Submitting.** `submitRetro(job, outcome: 'approved'|'abandoned', deps): Promise<void>`:
    - It builds the record.
    - It estimates the input cost with `pricing.ts`, halved for batch.
    - It skips with the note `retro skipped: <reason>` when there is no `ANTHROPIC_API_KEY` or the retro share or job cap is too small.
    - Otherwise it submits, or calls directly when `retro.batch` is false.
    - It writes `<jobDir>/retro.json` = `{ status: 'submitted'|'done'|'failed'|'skipped', batchId?, reason?, submittedAt }`.
    - It never throws to its caller. On any error it writes `failed` and returns.
    - It runs at most once per job: when `retro.json` already exists it does nothing.
  - **Collecting.** `collectRetros(deps): Promise<{ collected: number; failed: string[] }>`:
    - It goes through every registered project and job whose `retro.json` is `submitted`, and fetches finished batch results.
    - It validates them against `RetroOutputSchema`.
    - It drops any proposal whose `target` is not a `LESSON_FILES` value or a kit name. A dropped proposal adds a note.
    - It cleans lesson text with `cleanLessonText`, and drops what fails.
    - It records the cost (batch price) in the job's `cost.json` under `retro`, and in `stageSpentUsd.retro`, best effort.
    - It sets `done` and appends the proposals to the queue.
    - An expired or errored batch becomes `failed`.
  - **Queue.**
    - `Proposal = { id; project; jobId; kind: 'lesson'|'plugin'; target?; text?; plugin?; stage?; why; at }` is stored one per line in `~/anton/lessons/proposals.jsonl`.
    - `readProposals()` skips bad lines.
    - `removeProposal(id)` rewrites the file atomically.
  - **Hooks.**
    - The final accept (`awaiting_final_review` to `done`) calls `submitRetro(..., 'approved')` after the state is saved.
    - `abandon` calls `submitRetro(..., 'abandoned')`.
    - Both print `Retro submitted; review lessons later with: anton lessons review`, or the skip or failure reason.

- [ ] **Step 1: Write the failing tests.** Use a fake `RetroClient`.
  - `'final accept submits one retro and records submitted'`
  - `'abandon submits a retro with outcome abandoned'`
  - `'second approve or abandon does not resubmit'`
  - `'no API key: skipped with reason, approve still succeeds'`
  - `'client throws: failed with reason, approve still succeeds'`
  - `'retro share too small: skipped'`
  - `'batch:false calls the direct path'`
  - `'collect validates output and queues proposals'`
  - `'unknown target is dropped with a note'`
  - `'expired batch becomes failed'`
  - `'retro cost is recorded under retro'`
  - `'bad queue lines are skipped'`
- [ ] **Step 2:** Run `npx vitest run tests/retro tests/lessons/proposals.test.ts tests/cli/cli.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite, `npx tsc --noEmit` and `npm run build`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(retro): one batch call per job, proposals queued`.

### Task 6: `anton lessons review | list | remove`

**Files:**
- Create: `src/cli/commands/lessons.ts`
- Modify: `src/cli/index.ts`
- Test: `tests/cli/lessons.test.ts`

**Interfaces:**
- Consumes: `collectRetros`, `readProposals`, `removeProposal`, `addLesson`, `removeLesson`, `readLessons`, `CliDeps.ask`, `CliDeps.isTTY` (injectable).
- Produces:
  - **`anton lessons review`**:
    1. Runs `collectRetros` and prints its notes and failures.
    2. If the queue is empty, prints `No lessons waiting.`
    3. Without a terminal, lists the waiting proposals and exits 0 with no changes.
    4. Otherwise shows each proposal: its target, text, why, and source project and job. It asks `[a]ccept  [e]dit  [r]eject  [s]kip`.
       - **Accept:** `addLesson`. If the file is full, prints the refusal and keeps the proposal.
       - **Edit:** asks for the replacement text, then accepts it.
       - **Reject:** removes the proposal.
       - **Skip:** keeps it.
    5. A plugin proposal is never installed, and config.yaml is never edited. Accept prints `To add it: anton plugins add <plugin>`, then `and list it under stages.<stage> in ~/anton/config.yaml`, then removes the proposal.
    6. Ends with `Accepted N, rejected M, kept K.`
  - **`anton lessons list`** prints each lessons file with its count out of 20, and each lesson's id and text.
  - **`anton lessons remove <id>`** calls `removeLesson`.

- [ ] **Step 1: Write the failing tests.**
  - `'review accepts a lesson into its file and drops the proposal'`
  - `'edit replaces the text before accepting'`
  - `'reject drops it; skip keeps it'`
  - `'full file refuses and keeps the proposal'`
  - `'plugin proposal prints the add command and never installs'`
  - `'empty queue prints No lessons waiting.'`
  - `'no TTY lists and changes nothing'`
  - `'list shows counts and ids'`
  - `'remove deletes by id'`
- [ ] **Step 2:** Run `npx vitest run tests/cli/lessons.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(lessons): review, list and remove commands`.

### Task 7: Docs and end-to-end check

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `tests/e2e/retro.e2e.test.ts` (paid; gated on `ANTON_E2E` + `ANTHROPIC_API_KEY`)

**Interfaces:**
- Produces:
  - The README "Lessons" section covers:
    - when Retro runs, and that it costs cents, through the Batch API and the retro share
    - `retro.json`
    - `anton lessons review`, `list` and `remove`
    - where lessons live (git-versioned) and the 20-per-file cap
    - which agents see which file
    - that nothing applies without your accept
    - that plugin suggestions only print the add command
    - `retro.batch: false`
  - CLAUDE.md gets one Rules line: lessons reach agents only through `lessonsBlock` in the stable prompt; Retro output is untrusted until accepted.
  - Paid e2e: build a run record from a fixture job folder, run Retro with `batch: false`, and assert that the output parses with `RetroOutputSchema`. It is written but not run without a key.
- [ ] **Step 1:** Write the e2e test and the docs.
- [ ] **Step 2:** Run `ANTON_E2E=1 npx vitest run tests/e2e`, the full suite, `npx tsc --noEmit` and `npm run build`. Expected: all pass; the paid tests are skipped.
- [ ] **Step 3:** Commit `feat: Phase 5a lessons docs and e2e`.

## Not in this phase (5b)

- The scoreboard (`anton lessons list --stats`): checks passing on the first try, build⇄verify rounds, cost, rejects at checkpoint 2, per lesson. It also flags lessons with no benefit.
- The bench (`~/anton/bench/`, `anton bench [--only <name>]`), with a cost preview and a comparison with the previous run. It must include one change job on a sample repo.
- Measuring Caveman and Ponytail on the bench.
