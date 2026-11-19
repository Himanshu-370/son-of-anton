# Son of Anton — Design

Date: 2026-11-19
Status: Approved 2026-11-19

## 1. Intent

A personal "software factory": you describe a project in a sentence or two, and a pipeline of AI agents takes it from idea to a working, verified project in its own git repo, with you stepping in only twice. It runs locally on your Mac, builds your own projects, and should handle any kind of project (web apps, APIs, CLIs, libraries, scripts, data pipelines). Over time it learns from its own runs and gets better, with you approving what it learns.

### Why

Building projects by hand-driving an agent chat is slow and inconsistent: you re-explain how you like things done, and nothing carries over from one project to the next. The factory makes the process repeatable (same stages, same quality bar every time), mostly hands-off, and self-improving.

### Name
**Son of Anton**, after Gilfoyle's autonomous coding AI in *Silicon Valley*. Asked to fix bugs, it deleted the whole codebase; asked to find a burger deal, it ordered a huge amount of meat. This factory is that idea **with the guardrails**: it works on branches, has hard budgets, and can't call itself done without evidence and your approval.
- **Command:** `anton` (e.g. `anton new "habit tracker"`, `/anton approve` in Slack). Per-project folder: `.anton/`. Home folder: `~/anton/`. Slack workspace: "Son of Anton", with a `#anton` channel. In this doc, "the factory" means Son of Anton.
- **Easter eggs (optional, kept out of normal messages):** `anton stop --gilfoyle` as an alias for the emergency stop, and a burger reference in the budget-cap alert. All other messages stay plain.
- **Note:** the name references HBO's show. That's fine for a personal tool, but it would need a trademark check before any public release.

## 2. Goals, non-goals, anti-goals

**Goals**
- One command turns a description into a working project with evidence that it works.
- Works on existing code too: follow-up changes to projects it built, and changes to repos you started by hand (§6.0).
- Projects that need outside services work safely: stand-ins by default, real secrets only when you provide them, and the report says which was used (§9.1).
- Generic: any project type works at a basic level; specialised "kits" make specific types work well.
- Exactly two human checkpoints: approve the spec, review the final result.
- Feels like working with a dev team: named roles that post updates in Slack, answer your questions, and take your approvals there or in the CLI (§11).
- Resumable: any project can be paused and resumed later without losing state.
- Contained: all agent activity runs in Docker, never directly on the Mac.
- Reuses marketplace Claude Code plugins/skills instead of maintaining custom ones.
- Learns from each run through human-approved lessons, and can measure whether it's improving.

**Non-goals (v1)**
- Mobile apps (iOS/Android). Out entirely.
- Hosting the factory for other people; multi-user anything.
- Deploying projects to production, pushing to GitHub, or merging branches. Output is a local repo or branch; shipping and merging are yours.
- Running multiple projects concurrently (one active project at a time; others may be paused).
- A web dashboard. The front ends are the CLI and Slack (§11).

**Anti-goals (would make it a failure even if it "works")**
- Claims something works without evidence (passing tests, screenshots, command output tied to each acceptance check).
- Burns money in loops: unbounded retries or spend.
- Wastes tokens on work code could do, or on context a stage doesn't need (§7.1).
- Stalls silently waiting for a human in an unattended stage.
- Behaviour changes without you knowing (unpinned plugin updates, auto-applied lessons).
- Agents able to touch anything on the Mac outside the project.

## 3. Constraints

- Built on the **Claude Agent SDK** (Claude Code as a library), **TypeScript on Node**.
- Requires Docker on the Mac.
- Uses the user's Anthropic API key; it is passed into project containers.
- Marketplace plugins can contain third-party scripts, hooks and MCP servers; they run only inside containers.

## 4. Approaches considered

| Approach | Summary | Trade-off |
|---|---|---|
| A. Inside Claude Code | Skills + subagents, started via `/anton` | Fastest to build; but prompt-driven control drifts, skips stages, resumes poorly, weak cost control |
| **B. Standalone program on the Agent SDK (chosen)** | Code drives the stage machine; each stage starts an agent | More upfront work; reliable, resumable, cost caps, retries, extensible kits |
| C. Script calling `claude -p` headless | Runner shells out per stage | Two systems glued by shell output; brittle state passing and error handling |

**Chosen: B.** "Handle anything" depends on control (resume, retry, budgets, kits), which belongs in code, not prompts.

## 5. Architecture overview

```
Your Mac
├── anton CLI (TypeScript, Agent SDK)      ← drives stages, saves state, enforces budgets
├── anton serve (background service)       ← Slack connection (Socket Mode), answers questions,
│                                               relays approvals; runs jobs like the CLI does
├── ~/anton/config.yaml                    ← per-stage and per-role plugin/skill selection, defaults
├── ~/anton/plugins.lock                   ← exact pinned plugin versions
├── ~/anton/plugins/                       ← cached plugin installs (pinned)
├── ~/anton/lessons/                       ← learned lessons (git-versioned)
├── ~/anton/kits/<kit>/                    ← kits (fallback, web)
├── ~/anton/bench/                         ← practice projects
├── ~/anton/secrets/<project>.env          ← optional per-project secrets (outside every repo)
├── ~/anton/registry.json                  ← project name → repo path (new or adopted)
└── <project repo>                           ← ~/anton/projects/<name>/ for new ones,
      │                                         or wherever an adopted repo already lives
      ├── (project code)
      └── .anton/  project.json, jobs/<n>-<slug>/{spec.md, plan.md, state.json,
                     questions.md, logs/, cost.json, evidence/, REPORT.md, run-record.json}

Docker container (one per project, from the kit's image)
├── role agent (Agent SDK): one agent session per role and stage
├── security scanners: gitleaks, osv-scanner, Semgrep
├── /workspace   ← project folder, read-write
├── /skills      ← pinned plugins/skills for this stage, read-only
└── /lessons     ← this role's + kit's lessons, read-only
```

The CLI on the host decides *what happens next*; the agents inside the container *do the work*. Every command an agent runs executes inside the container.

## 6. The pipeline

Stages, in order: **Spec → [Checkpoint 1] → Plan → Build ⇄ Verify → Deliver → [Checkpoint 2] → Retro**.

### 6.0 Projects and jobs (new and existing code)
- A **project** is one repo. A **job** is one pass through the pipeline: creating the project, or one change to it. All of a job's files live in `.anton/jobs/<n>-<slug>/`. Budgets, round counts, reports and retros are per job. (When the stages below mention files under `.anton/`, they mean the current job's folder.)
- **Ways to start a job:**
  - `anton new "<description>"`: a new project in `~/anton/projects/<name>/`. Its first job includes scaffolding.
  - `anton adopt <path> [--name <name>]`: registers an existing repo you started by hand. No job starts. The repo stays where it is, and the factory records its location in `registry.json`.
  - `anton change <project> "<description>"`: a change job on any registered project, new or adopted.
- **Spec on existing code:** the spec agent first reads the codebase, including its structure, its tests and how it runs, then writes a spec for the *change*: what changes, what must keep working, and acceptance checks for the new behaviour. Kit `detect` inspects the repo's files, and `scaffold` is skipped.
- **Regression baseline:** before Build starts, Verify runs the project's existing tests and kit checks and records which pass. During the job, anything that passed in the baseline and now fails counts as a failure. If the repo has few or no tests, the spec proposes a small set of checks that capture current behaviour, and you approve them at checkpoint 1 like any other check.
- **Branches (my call):** change jobs work on a branch named `anton/<n>-<slug>` and never touch your current branch. Approving at checkpoint 2 leaves the branch ready for you to merge; the factory never merges or pushes. The first job of a new project works on `main`. If an adopted repo has uncommitted changes, the factory refuses to start a job until you commit or stash them.
- **Keeping adopted repos clean (my call):** for adopted repos, `.anton/` is listed in `.git/info/exclude`. That keeps it out of git on your machine without changing the repo's committed `.gitignore`.
- **Mounting:** only that project's repo folder is mounted read-write into the container. Its parent folders and other repos aren't.

### 6.1 Spec (attended)
- `anton new` or `anton change` sets up the job, picks a kit (see §8), starts the container, and runs the spec agent interactively in the terminal: it asks clarifying questions, then writes `.anton/spec.md`.
- `spec.md` contains: what will be built, out of scope, chosen kit, tech choices, **outside services** and how each is handled (§9.1), and **acceptance checks** — concrete, testable statements (e.g. "adding a habit shows it in today's list"). Acceptance checks are the contract every later stage is held to.
- **Checkpoint 1:** you may edit `spec.md` directly, then run `anton approve <project>`. The factory saves both the generated and approved versions (the diff is a learning signal).

### 6.2 Plan (unattended)
- Breaks the spec into small, ordered, testable tasks in `.anton/plan.md`, each mapped to the acceptance checks it serves.

### 6.3 Build (unattended)
- Three developer roles share the build: **frontend**, **backend** and **infra** (see §11). The tech lead tags every plan task with one of them, and only roles with tasks take part.
- **Order:** infra, then backend, then frontend, following dependencies. They work one at a time, not in parallel; parallel developers are left for later because of cost and merge conflicts. The plan includes the **contract between the pieces**, such as the API shape, so frontend and backend build against the same thing. Each developer leaves a short handoff note for the next.
- **The infra developer never deploys.** It works on local setup only: Docker, CI config, migrations, environment and config, `.env.example`.
- Each developer works through its tasks test-first, and each completed task is a git commit. During Build, each task runs only its own tests.
- The kit's `scaffold` runs first, but only in the first job of a new project.

### 6.4 Verify (unattended)
- Runs the kit's `verify`: produces pass/fail **per acceptance check** with evidence saved to `.anton/evidence/`. Each result is labelled **real** or **stand-in**, depending on whether it touched real outside services (§9.1).
- On change jobs, it also re-checks the regression baseline (§6.0).
- The **QA** role runs the kit's verify and judges the results.
- A **code reviewer** (fresh context, code-review skill) reviews the round's changes. Blocking findings count as failures.
- A **security reviewer** (fresh context) checks the round's changes. See §6.4.1.
- **On failure:** the failure report names the area each failure belongs to (frontend, backend or infra) and goes back to that developer in Build; then Verify re-runs. Max **3** build⇄verify rounds (configurable). After that the factory pauses and asks you (resume after you intervene, or accept as-is at checkpoint 2).

### 6.4.1 Security review
- **Scanners run first, as plain code in the container, at no token cost:** secret scanning (gitleaks), dependency vulnerabilities (osv-scanner, plus npm audit or pip-audit depending on the stack), and static analysis (Semgrep).
- **Then the security reviewer agent:** sorts the scanner findings and discards false positives, then reviews the round's changes for what scanners miss. That covers authentication and access control, injection, unsafe input handling, data leaking through errors or logs, and secret misuse.
- **When it runs:** every verify round, on that round's changes. It also does one **full-repo baseline pass** on a project's first job and whenever a repo is adopted. Problems that were already there are reported but don't block the job.
- **Severity:**
  - **Critical or high** blocks the job and goes back to the responsible developer, like a failed check.
  - **Medium or low** is listed in the report and doesn't block.
  - At checkpoint 2 you can **accept a specific risk** with a reason. It's recorded in the report and the run record, never silently dropped.
- **Security in the spec:** for projects with logins, user data, payments or anything exposed to the network, the product manager adds security acceptance checks, such as "a logged-out user can't reach /admin". They're verified like any other check.
- **It guards the factory too:** `anton plugins update` has the security reviewer read what changed in the new versions' scripts, hooks and MCP servers before you accept the update.
- `REPORT.md` gets a **Security** section listing findings, fixes and any risks you accepted.

### 6.5 Deliver
- Writes `REPORT.md`: each acceptance check with its status, evidence links and real/stand-in label; regression results for change jobs; the branch to merge; how to run the project; cost and time per stage; all assumptions logged in `questions.md`; anything it gave up on.

### 6.6 Checkpoint 2
- `anton approve <project>` accepts it, or `anton reject <project> --notes "..."` sends it back to Build with your notes (starts a new build⇄verify round; retry counter resets).

### 6.7 Retro
Runs **once per job**: when you finally approve it, or when you abandon it with `anton abandon` (my call). It reads the job's whole history, including every reject cycle and its notes, so one job yields one run record and one set of lesson proposals. See §10.

## 7. Core runtime

- **CLI commands:** `new`, `adopt`, `change`, `status`, `logs`, `approve`, `reject`, `resume`, `stop`, `abandon`, `secrets edit`, `plugins add|update|list`, `lessons review|list`, `bench`.
- **State:** each job's `state.json` records the current stage, round count, budget used, and per-stage status. Every stage transition is written before the next stage starts, so `resume` continues from the last completed step. Folder is self-contained.
- **Budgets:** per-job spend cap, default **$10** (configurable per project and per job). Cost is tracked per stage from SDK usage. On reaching the cap, the factory pauses and waits for you (`resume --budget <n>` to continue).
- **Models:** per stage, see §7.1. Each stage's model and effort are configurable.
- **Git as safety net:** one commit per completed task; tags at each checkpoint so any stage can be rolled back.
- **Logs:** each stage's full agent transcript saved under `.anton/logs/`.
- **Process model (my call):** Spec runs in the foreground (it's interactive). After `anton approve`, the unattended stages run as a **detached background process**, so closing the terminal doesn't stop the run. A lock file with the process ID prevents two runs on one project. `anton logs -f <project>` follows progress live. `anton stop` asks the agent to stop gracefully (a hard stop after a timeout) and stops the container. If the process dies (crash, Mac restart), `status` shows the project as interrupted, and `resume` continues from the last completed step in `state.json`. On every pause (round cap, budget cap, checkpoint 2 ready, crash) the factory sends a **macOS notification**, so it never waits silently.

### 7.1 Cost and token efficiency
Guiding rule: **the quality bar is fixed and cost is minimised within it.** Acceptance checks still have to pass with evidence; savings never come from skipping verification.

**Code does the mechanical work, agents do the judgement**
- Running tests, linters and builds, parsing their results, git operations, starting the app and collecting screenshots are all plain code in the CLI and kits. An agent is called only when judgement is needed: writing the spec, planning, writing code, fixing failures, reviewing.
- Fail fast in code before spending tokens. If installing dependencies, starting the container or scaffolding fails, the job stops with the error, and no agent is started to "investigate".

**Each stage starts with a small, fresh context**
- Every stage gets a new agent session that receives only what it needs: the approved spec, the plan, the current task and the relevant files. Earlier stages' transcripts are never passed on.
- Tool output is trimmed by code before an agent sees it. A failed test run passes on only the failing tests and their errors, not the full log. Long command output is cut to its head and tail, and the full version is kept on disk if the agent asks for it.
- On a Verify failure, Build receives a short failure report: which checks failed, the error, and the related files. It does not get the whole verify transcript.

**A repo map is built once and reused (existing code)**
- The first job on a project writes `.anton/repo-map.md`: structure, main modules, how to run and test it, and conventions. Later jobs refresh only the parts touched by changes since the last map (taken from `git diff`), so the agent doesn't re-explore the whole codebase on every job.

**The right model and effort for each stage**

| Role (stage) | Model | Effort |
|---|---|---|
| Product manager (Spec) | Opus (`claude-opus-5-5`) | high |
| Tech lead (Plan) | Opus | medium |
| Frontend, backend and infra developers (Build) | Sonnet (`claude-sonnet-5-5`) | medium |
| QA, code reviewer (Verify) | Sonnet | medium |
| Security reviewer (Verify) | Sonnet | high |
| Coach (Retro), kit `detect` fallback, log summaries, simple Slack answers | Haiku (`claude-haiku-5-5`) | low |
| Slack answers that need digging into code or logs | Sonnet | medium |

All of these are configurable. The scoreboard (§10.2) records cost and quality per stage, so you can see whether a cheaper setting holds up before switching it.

**Prompt caching**
- Each stage's prompt is laid out with stable content first and changing content last. The stable part is the standing instructions, then skills, then lessons. The changing part is the task and files. Nothing changing, like timestamps or run IDs, goes into the stable part. This way repeated calls within a stage reuse the cache.
- The scoreboard tracks the cache hit rate, so a change that silently breaks caching shows up.

**Load only what each stage needs**
- Skills and plugins are already per stage (§10.1).
- MCP servers add their tool definitions to every request, so they load only in the stages that use them. For example, Playwright loads only in Verify, never in Spec or Plan.

**Retries that stop early**
- The cap is still 3 rounds of build and verify. The factory also stops early, and asks you, if the **same check fails the same way two rounds in a row**, because another round is unlikely to help.
- During Build, each task runs only its own tests. The full verify runs once per round, not after every task.
- The reviewer reads only the round's diff, once per round, not after every commit.

**Budgets with visibility**
- The job cap (default $10) is split into stage allowances: Spec 10%, Plan 10%, Build 50%, Verify 25%, Retro 5%. An allowance can borrow what's left of earlier allowances. When a stage runs out of its share, the factory pauses before the whole cap is gone.
- **Estimate at checkpoint 1:** the spec shows an expected cost range for the job, based on past jobs of similar size and kit from the scoreboard. It shows "no history yet" until enough jobs have run.
- You get a warning at 80% of the cap. Cost so far is visible at any time in `anton status`.
- Agent loops are given a token budget so they pace themselves instead of being cut off mid-task.

**Cheap paths for non-urgent work (my call)**
- Retro is a single model call over the job's run record, not an agent loop. It is sent through the Batch API at half price, since nothing waits on it.
- `anton bench` can run a subset of practice projects (`--only <name>`), and it shows the estimated cost before it starts.

**The learning loop watches cost too**
- Retro also looks for waste: files read repeatedly, repeated tool calls, stages that went far over their allowance. It can propose cost lessons like any other, for example "fallback kit, build: run only the affected test file". You approve them the same way.

## 8. Kits (project-type plugins)

A kit makes one kind of project work well. Interface (TypeScript module):

| Part | Purpose |
|---|---|
| `detect(description, folder)` | Confidence this kit fits |
| `image` | Docker image (toolchain for this project type) |
| `scaffold` | Set up a new project of this type |
| `verify` | Prove it works; returns pass/fail per acceptance check + evidence + a failure report Build can act on |
| `skills` (optional) | Extra marketplace skills/plugins this kit adds to stages |
| `mcp` (optional) | MCP servers this kit needs inside the container |

Selection: during Spec, every kit's `detect` runs; highest confidence wins, fallback if none is confident. The choice appears in `spec.md`; you can change it at checkpoint 1.

**v1 ships two kits:**
- **Fallback** (any project): chooses an appropriate test framework, ensures tests cover the acceptance checks (not just that tests exist), runs them, and confirms the project starts/runs. General-purpose image.
- **Web**: everything fallback does, plus starts the app in the container and has an agent exercise each acceptance check in a headless browser (Playwright), with screenshots as evidence. Image includes Node + Playwright.

Adding a kit later = adding a folder under `~/anton/kits/`; core unchanged.

**Trust (my call):** kits are your own trusted code, not third-party downloads; third-party kits aren't supported in v1. The kit module runs in the host CLI, but everything it *executes* (scaffold commands, test runs, starting the app, the browser) is sent into the project's container. `detect` reads only the description and file listings, so it needs no container.

## 9. Sandbox (Docker)

- One container per project, built from the kit's image. Only the project folder is mounted read-write; skills and lessons are mounted read-only. Nothing else from the Mac is visible.
- Agents run inside the container; the host CLI starts each stage's agent there. The API key is passed in as an environment variable.
- Network on by default (package installs); a kit or project config can turn it off.
- Container stops when a project pauses or finishes; `resume` starts a new container on the same folder.

### 9.1 Outside services and secrets (decided: stand-ins plus optional real secrets)
- **The spec lists outside services.** For each service the project needs (a third-party API, a hosted database, a sign-in provider, a paid service), `spec.md` records how it will be checked: **stand-in** or **real**.
- **Stand-ins by default.** Without secrets, the project is built and checked against stand-ins: mocks, recorded responses, or local substitutes running in the container, such as a local Postgres in place of a hosted database. Checks against stand-ins are labelled **stand-in** in the report. They are never presented as proof the real service works.
- **Real secrets are optional and per project.** `anton secrets edit <project>` opens `~/anton/secrets/<project>.env`. The file is stored outside every repo with owner-only file permissions. Its values are passed into that project's container as environment variables only; it's never mounted as a file and never written into the repo.
- **When a secret is present,** Verify also runs that service's checks against the real service and labels them **real**. The stand-in checks still run, so the project's own tests don't depend on the secret.
- **Keeping secrets out of the record:** agents are told never to write secret values into code, files, commits or logs. The factory also strips any known secret value from transcripts, logs, evidence and `REPORT.md` before saving them. Code reads secrets from environment variables, and the build creates a `.env.example` listing the variable names with no values.
- **Know the risk:** anything running in the container can read these secrets, and that includes the marketplace plugins. Use test or limited-scope keys where the service offers them. The spec checkpoint shows which secrets a job will receive.

## 10. Skills, plugins and the learning loop

### 10.1 Marketplace plugins per stage
- `~/anton/config.yaml` lists which plugins/skills each stage (and each kit) loads, e.g.:
  ```yaml
  stages:
    spec:   [superpowers:brainstorming]
    plan:   [superpowers:writing-plans]
    build:  [superpowers:test-driven-development, superpowers:systematic-debugging]
    verify: [superpowers:verification-before-completion, code-review]
  kits:
    web:    [frontend-design, webapp-testing]
  ```
- `anton plugins add <name>` installs from the marketplace. Only listed plugins ever load.
- **Pinned:** `plugins.lock` records exact versions. `anton plugins update` upgrades and shows what changed. No silent updates.
- **Unattended-stage rule:** many skills assume a human in the chat. In Plan, Build, Verify and Retro, the factory adds a standing instruction: *no human is present; where a skill says to ask the user, write the question to `.anton/questions.md`, make the most reasonable assumption, record it, and continue.* A tool guard also blocks any ask-the-user tool in these stages so a run can never stall. Spec is attended, so interactive skills behave normally there.
- Each run records the exact plugin versions used in `run-record.json`.

### 10.2 Learning loop
- **Signals** (already in `.anton/`): failed checks and retry counts, spec edits at checkpoint 1, wrong assumptions in `questions.md` (flagged by you or by later failures), your reject notes, reviewer findings, cost/time per stage.
- **Retro stage:** a retro agent reads the run record and proposes **lessons** — short, specific rules tagged by stage and optionally kit (e.g. "web kit / build: add a health-check endpoint before verify starts the app"). It may also suggest adding a marketplace plugin for a stage when the same failure recurs.
- **Approval (decided: human approves):** proposals queue up; `anton lessons review` shows them in a batch to accept, edit or reject. Nothing applies automatically. Plugin suggestions are also proposals only.
- **Storage & loading:** accepted lessons live in `~/anton/lessons/<role>.md` (e.g. `build-frontend.md`, `security-reviewer.md`) and `<kit>.md`, versioned in git. Each role's agent gets only its own role's and kit's lessons, mounted read-only. Cap ~20 lessons per file.
- **Measuring:** each run records active lessons. A scoreboard (`anton lessons list --stats`) tracks per run: acceptance checks passing first try, build⇄verify rounds, cost, rejects at checkpoint 2. Lessons with no measurable benefit after enough runs are flagged for removal (you decide). With few projects these numbers are noisy — they inform your review, they don't decide.
- **Practice projects:** `~/anton/bench/` holds 3–5 small fixed sample projects with pre-approved specs. At least one is a change job on a small existing sample repo, so adopting a repo and the regression baseline get tested too. `anton bench` runs them unattended (skipping checkpoint 1) and compares the scoreboard to the previous bench run — the factory's own regression test after accepting lessons or updating plugins. Costs a few dollars per run; only runs when you invoke it.

## 11. The team and Slack

### 11.1 The team
Each role is a separate agent with its own instructions, skills (from `config.yaml`, keyed by role) and lessons file (`lessons/<role>.md`).

| Role | Stage | Job |
|---|---|---|
| Product manager | Spec | Asks you questions; writes the spec, acceptance checks (including security checks) and outside-service plan |
| Tech lead | Plan | Breaks the spec into tagged tasks and writes the contract between the pieces |
| Frontend developer | Build | UI, pages, components, client logic |
| Backend developer | Build | APIs, logic, data models, CLIs, libraries |
| Infra developer | Build | Docker, CI config, migrations, env/config (no deploying) |
| QA | Verify | Runs kit checks against the acceptance checks; writes failure reports by area |
| Code reviewer | Verify | Reviews each round's changes |
| Security reviewer | Verify | Scanners + review, per §6.4.1 |
| Coach | Retro | Proposes lessons, including cost lessons |

### 11.2 Slack and CLI: two front ends to the same factory (decided)
- **Everything can be done from either one.** You can start jobs, answer the spec questions, approve or reject, accept a risk, review lessons and check status in Slack or in the CLI. All state lives in the `.anton/` files, and both are just front ends to it. What you start in one shows up in the other.
- **Always-on service:** `anton serve` runs as a background service on your Mac, started at login by launchd. It connects to Slack outward over Socket Mode, so there's no public server and no open ports. Jobs keep running if Slack disconnects. Messages queue up and are sent when the connection comes back, and in the meantime a macOS notification is the fallback.

### 11.3 Workspace layout
- **Each role is its own Slack app** (my call), so every team member is a real member of the workspace. You can @mention them, DM them, and see them in the sidebar. The alternative, one app posting under different names, is simpler to set up but doesn't feel like a team, and you can't @mention the individual members.
- **Setup:** you create the Slack workspace yourself; the factory can't create accounts. `anton slack setup` walks you through the rest:
  1. You create a Slack configuration token.
  2. The factory creates all nine apps from bundled app manifests.
  3. You click install on each app (Slack requires this).
  4. The factory creates the channels and invites the team.
- **Channels:**
  - `#anton`: work that spans projects, such as budget warnings, lessons waiting for review, bench results and plugin updates waiting for approval.
  - `#proj-<name>`: one channel per project, with **one thread per job**.

### 11.4 How you work with the team in Slack
- **Start a job:**
  - `/anton new "<description>"`, or
  - `/anton change <project> "<description>"`, or
  - a message to the product manager.
- **Spec:** the product manager asks its questions in the job thread, and you answer there. It then posts the spec (summary plus file) with **Approve** and **Request changes** buttons. Request changes opens a box for your edits or notes.
  - While a spec is waiting on you, the product manager sends a reminder after 24 hours. Nothing times out.
- **Progress:** each role posts at milestones in the thread, such as "Infra dev: container and migrations ready, handing to backend". It doesn't post on every tool call. QA posts check results; screenshots can be attached as evidence.
- **Checkpoint 2:** QA posts the report summary with **Approve**, **Reject** (opens a box for notes) and **Accept risk** (for a security finding, with a reason) buttons.
- **Lessons:** the coach posts proposed lessons in `#anton`, each with **Accept**, **Edit** and **Reject** buttons.
- **Questions:** @mention any member, anywhere, for example "@QA why did check 4 fail?" or "@Tech lead what's left?". The member answers from that job's real records.
  - Status questions are answered by code from the state files, at no cost.
  - Other questions use Haiku, or Sonnet when the answer needs digging into code or logs.
  - Answering is read-only. Asking a question never changes a job.

### 11.5 Safety and cost in Slack
- **Only you can give orders.** The factory acts only on your Slack user ID. Anyone else in the workspace can read and ask questions, but can't start, approve, reject or accept anything.
- The same secret stripping as logs and reports (§9.1) applies to every Slack message and file. Messages carry code snippets, never whole files.
- Questions answered by a model count against a monthly **chat budget**, $5 by default. Each answer has a small cap of its own. When the chat budget is used up, members answer status questions only, until you raise it.
- Text arriving from Slack is treated as your instruction only when it comes from your user ID. Anything else, including text inside forwarded or pasted content, is treated as data.

## 12. What's left to the builder

- Internal code structure, module layout, and test strategy for the factory itself.
- Exact Agent SDK options for loading skills/plugins and running inside Docker (verify against current SDK docs).
- Base Docker image contents beyond what's stated; image caching strategy.
- Exact schemas for `state.json`, `run-record.json`, kit interface types.
- Prompt wording for each stage's standing instructions and the retro agent.
- Which sample projects go in the bench (should cover both kits).
- How `detect` confidence is computed.
- How the spec agent explores a large existing codebase within budget.
- Which stand-in tools to use for common services (mock servers, local databases, recorded responses).
