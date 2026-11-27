# Run a Delivery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The delivery-ready Slack card can run the delivered project in a Docker sandbox and open it on the Owner's Mac, stop that run, or open the folder in VS Code.

**Architecture:**
- **Sandbox lifecycle:** a new `src/preview/sandbox.ts` owns it, recording each run in `~/anton/previews.json`, and opening the app on the Mac with fixed `open` and `osascript` calls.
- **Cards:** three new card kinds go through the existing card router in `src/slack/actions.ts`, with a `preview` dependency.
- **Service:** `anton serve` wires the real effects in and removes runs that have expired or gone out of date.

**Tech Stack:** TypeScript (Node 26, ESM), vitest, zod, Docker CLI, macOS `open` and `osascript`.

**Spec:** `docs/specs/2026-11-27-run-delivery-design.md`

## Global Constraints

- **Container name:** `anton-preview-<slug>`, checked against `/^anton-preview-[a-z0-9-]+$/` before any use.
- **The run container has no anton data:** no `ANTHROPIC_API_KEY` and no plugins mount. Project secrets go only through `--env-file` from `secretsEnvFile(slug)`.
- **The web port is published on 127.0.0.1 only:** `-p 127.0.0.1:<hostPort>:<appPort>`.
- **Plan commands are untrusted:** they run only inside the container, through `docker exec <name> sh -lc <cmd>`, and never in a host shell.
- **Limits:**
  - install: 5 minutes;
  - web readiness poll: 60 seconds;
  - run lifetime: 30 minutes;
  - expiry check: each `anton serve` drain tick, at most once a minute.
- **Opening on the Mac uses fixed programs with arguments:**
  - `open <url>`;
  - `open -a "Visual Studio Code" <repoPath>`, falling back to `open <repoPath>`;
  - `osascript -e <fixed script>`, where the container name is the only variable.
- **Owner only.** Cards are bound to the job and its delivery revision. A run, stop or open on a job no longer at that delivery replies "That is out of date. Nothing was changed."
- **Copy:**
  - Web: `Running at http://localhost:<hostPort><path>. It stops in 30 minutes, or press Stop.`
  - CLI: `A Terminal window opened inside the sandbox.`
  - Stop: `Stopped.`
  - Nothing running: `Nothing is running for <project>.`
  - Install failed: `Install failed. Last lines:` followed by up to 20 redacted lines.
  - Not ready: `The app did not answer within 60 seconds. It may only listen inside the container; try the Terminal path from Open in VS Code.`
- Every external effect is injected through `PreviewDeps`. Tests never call Docker, `open` or `osascript`.
- **Commits** use Conventional Commits, each ending with the trailer `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A second Run while one is running.** The old container is removed first, and only one entry stays in `previews.json`. Test: Task 1 `run replaces an earlier run`.
2. **An app port already taken on the Mac.** The run falls back to a free port, and the reply shows that port. Test: Task 1 `uses a free port when the app port is busy`.
3. **A plan with neither run nor serve.** The card has no Run button, and a forged run click is refused. Tests: Task 3 `card leaves out Run without commands`, Task 2 `run without commands refuses`.
4. **A container name or path with odd characters.** It is refused before any call. Test: Task 1 `refuses an invalid container name`.
5. **The service restarting while a run is on.** The leftover container is removed at start. Test: Task 1 `cleanupAll removes recorded runs`.

---

### Task 1: Sandbox lifecycle

**Files:**
- Create: `src/preview/sandbox.ts`
- Test: `tests/preview/sandbox.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type PreviewCommands = { install: string; run?: string; serve?: string; url?: string; test?: string };
  export type PreviewDeps = {
    exec: ExecFn;                                   // docker, open, osascript (from src/core/exec.ts)
    image: (kit: KitName) => Promise<string>;       // ensureImage(kitByName(kit))
    envFile: (slug: string) => Promise<string | undefined>;  // secretsEnvFile
    portFree: (port: number) => Promise<boolean>;
    freePort: () => Promise<number>;
    reachable: (url: string) => Promise<boolean>;
    now: () => number;
    sleep: (ms: number) => Promise<void>;
    home: string;
  };
  export type PreviewRecord = { project: string; container: string; jobId: string; revision: string; startedAt: number; url?: string };
  export const PREVIEW_LIFETIME_MS = 30 * 60_000;
  export function previewName(slug: string): string;   // throws on an invalid name
  export async function runPreview(input: { project: string; jobId: string; revision: string; repoPath: string; kit: KitName; commands: PreviewCommands }, deps: PreviewDeps): Promise<{ ok: boolean; lines: string[] }>;
  export async function stopPreview(project: string, deps: PreviewDeps): Promise<boolean>;  // false when nothing was running
  export async function expirePreviews(stillCurrent: (r: PreviewRecord) => Promise<boolean>, deps: PreviewDeps): Promise<PreviewRecord[]>;  // returns what it removed
  export async function cleanupAll(deps: PreviewDeps): Promise<void>;
  export async function openFolder(repoPath: string, deps: Pick<PreviewDeps, 'exec'>): Promise<'vscode' | 'finder'>;
  ```

- [ ] **Step 1: Write the failing tests,** with a fake `exec` that records each call as `[cmd, ...args]`:
  - **`web run starts a sandbox and opens the browser`:** the docker run args contain `-p`, `127.0.0.1:3000:3000`, `--env-file`, `-v <repo>:/workspace`, `--name anton-preview-hello`. They contain neither `ANTHROPIC_API_KEY` nor `plugins`. Install and serve go through `docker exec … sh -lc`. The last call is `['open', 'http://localhost:3000/']`. The reply equals the web copy above. `previews.json` has one record.
  - **`cli run opens Terminal inside the sandbox`:** `osascript -e <script>` is called, the script contains `docker exec -it anton-preview-hello sh -l`, and the reply is the CLI copy.
  - **`run replaces an earlier run`:** `docker rm -f anton-preview-hello` comes before `docker run`, and `previews.json` holds one record.
  - **`uses a free port when the app port is busy`:** with `portFree` false and `freePort` 49152, the args contain `127.0.0.1:49152:3000` and the reply says `http://localhost:49152/`.
  - **`install failure removes the container`:** the install exec exits 1 with 30 lines of output. The reply starts with the install-failed copy, shows the last 20 lines, and `docker rm -f` was called.
  - **`refuses an invalid container name`:** `previewName('Bad Name!')` throws.
  - **`expire removes old and out-of-date runs`:**
    - a run older than 30 minutes is removed;
    - a run whose `stillCurrent` is false is removed;
    - a fresh, current run stays.
  - **`cleanupAll removes recorded runs`.**
  - **`openFolder falls back to Finder`:** when `open -a` exits 1, `open <repo>` is called and the result is `'finder'`.
- [ ] **Step 2:** Run `npx vitest run tests/preview/sandbox.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - **The records file:** `previews.json` is read with `readRegularFile` and written with `writeFileAtomic`. Its shape is `{ version: 1, runs: PreviewRecord[] }`, checked with zod.
  - **The app's port and path** come from `new URL(commands.url)`.
  - **Serve runs detached:** `docker exec -d <name> sh -lc <serve>`.
  - **The fixed Terminal script:** `tell application "Terminal" to do script "docker exec -it <name> sh -l"`, then `activate`.
- [ ] **Step 4:** Run the tests. Expected: PASS.
- [ ] **Step 5:** Commit with `feat: run a delivery in a sandbox container`.

### Task 2: Card kinds and dispatch

**Files:**
- Modify: `src/slack/actions.ts` (`CARD_KINDS`, `DispatchDeps`, the card branch, and `closing`, which leaves these kinds open)
- Test: `tests/slack/actions.test.ts`

**Interfaces:**
- Consumes: Task 1.
- Produces: the card kinds `'preview-run' | 'preview-stop' | 'open-folder'`, and `DispatchDeps.preview?: PreviewDeps`.
- **Dispatch rules:**
  - **Bound to the delivery:** each kind is bound to `{ project, jobId, stage: 'awaiting_final_review', revision }`. The router checks `isCurrent(target)` from `src/core/job-actions.ts`. When that fails, the result is `stale`.
  - **`preview-run`:** loads `plan.json` from the job folder (`PlanSchema`) and the kit from `spec.approved.json`, then calls `runPreview`. With no `run` and no `serve`, it refuses with "Nothing to run for this project."
  - **`preview-stop`:** calls `stopPreview`.
  - **`open-folder`:** calls `openFolder(repoPath)` and replies "Opened in VS Code." or "Opened in Finder."
  - **Never closing:** `closing()` keeps these cards open, the same as lesson cards.
  - **No preview deps** (outside `anton serve`): `unsupported` with "Running a delivery is available in anton serve."
- [ ] **Step 1: Write the failing tests,** with a fake `preview` dep that records calls:
  - **`run card runs the current delivery`:** the result is `done` and `runPreview` received the plan commands.
  - **`run card on a moved job is stale`:** the result is `stale`, and `runPreview` was not called.
  - **`run without commands refuses`.**
  - **`stop and open cards stay open`:** neither result has `close`.
  - **`non-owner is denied`.**
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npx vitest run tests/slack` and `npx tsc --noEmit`. Expected: PASS and clean.
- [ ] **Step 5:** Commit with `feat: run, stop and open delivery cards`.

### Task 3: Delivery card and service wiring

**Files:**
- Modify: `src/slack/spec-session.ts` (the delivery-ready card), `src/cli/commands/serve.ts`
- Test: `tests/slack/workflow.test.ts` (card), `tests/cli/serve.test.ts` or the nearest serve test

**Interfaces:**
- Consumes: Tasks 1 and 2.
- **The card:**
  - adds the line `Folder: <repoPath with the home folder shown as ~>`;
  - its buttons, in order, are `▶ Run it` (left out when the plan has no `run` and no `serve`), `■ Stop`, `Open in VS Code`, `Approve delivery`, `Reject…`.
- **The service:**
  - `serve` builds the real `PreviewDeps` and passes them as `dispatchDeps.preview`;
  - it calls `cleanupAll` before the Slack workers start and again on stop;
  - in `drain`, once a minute, it calls `expirePreviews` with `stillCurrent = isCurrent({ project, jobId, stage: 'awaiting_final_review', revision })`.
- [ ] **Step 1: Write the failing tests:**
  - **`delivery card shows folder and run buttons`:** the text contains `Folder: ~/` and the button labels are in the order above.
  - **`card leaves out Run without commands`.**
- [ ] **Step 2:** Run the tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm test` and `npx tsc --noEmit`. Expected: all pass and clean.
- [ ] **Step 5:** Commit with `feat: delivery card runs the project in a sandbox`. Push `feat/run-delivery`.

### Task 4: Live check (the Owner)

- [ ] Rebuild (`npm run build`) and restart `anton serve` from this branch.
- [ ] **CLI check:** for a CLI delivery, press Run. A Terminal window opens inside the sandbox; the run command works; then press Stop.
- [ ] **Web check:** for a web delivery, press Run. The browser opens the app; Stop removes it.
- [ ] Press Open in VS Code.
- [ ] Record the results in `docs/superpowers/plans/2026-11-27-phase-7-followups.md`.
