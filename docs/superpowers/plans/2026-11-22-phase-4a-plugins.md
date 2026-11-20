# Phase 4a: Marketplace Plugins Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let each stage, kit and role load pinned marketplace plugins (skills, hooks, MCP servers) safely. This covers `anton plugins add|list|update`, `plugins.lock`, the unattended-stage rule with its ask-the-user guard, MCP servers only in the stages that list them, and a security review of plugin updates. The phase also fixes the Phase 3b "Do first" items.

**Architecture:**
- **Install and pin.** `anton plugins add` clones a marketplace repo (through `src/core/git.ts`) and copies one plugin into an immutable folder, `~/anton/plugins/<marketplace>/<plugin>/<commit12>/`. It pins the result in `~/anton/plugins.lock` with a content hash.
- **Mount.** The job container mounts `~/anton/plugins` read-only at `/opt/anton/plugins`.
- **Resolve.** `runAgent` resolves which plugins a session gets from `~/anton/config.yaml` (stage + kit + role) and checks each hash. It sends container paths, skill names and host-built MCP server definitions in the request.
- **Load.** The entry passes them to the SDK as `plugins` (with `skipMcpDiscovery`), `skills` and `mcpServers`, with `strictMcpConfig` always on.
- **Read-only sessions.** Sessions with a `tools` restriction never get plugins.

**Phase split:** Phase 4 is split like Phase 3. **4a (this plan)** covers plugins. **4b** covers cost controls: the prompt-caching layout and cache tracking, stage allowances, the cost estimate at checkpoint 1 and task budgets. 4b is planned after 4a ships, because the caching layout depends on how skills load.

**Tech Stack:** TypeScript ESM, vitest, zod, `yaml` (already a dependency), execa, Docker, Claude Agent SDK 0.3.328 (`plugins`, `skills`, `disallowedTools`, `strictMcpConfig`, `mcpServers` options).

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md`: §10.1 (marketplace plugins per stage), §6.4.1 (plugin updates), §7.1 ("Load only what each stage needs"), §7 (CLI `plugins add|update|list`). Phase 3b follow-ups: `docs/superpowers/plans/2026-11-21-phase-3b-followups.md` ("Do first").

## Global Constraints

- §10.1: "`~/anton/config.yaml` lists which plugins/skills each stage (and each kit) loads." Entries are `plugin` (the whole plugin) or `plugin:skill` (one skill).
- §10.1: "Only listed plugins ever load."
- §10.1: "Pinned: `plugins.lock` records exact versions. `anton plugins update` upgrades and shows what changed. No silent updates."
- §10.1 unattended rule (exact standing instruction): *no human is present; where a skill says to ask the user, write the question to `.anton/questions.md`, make the most reasonable assumption, record it, and continue.* The questions file is per job: `/workspace/.anton/jobs/<jobId>/questions.md`.
- §10.1: "A tool guard also blocks any ask-the-user tool in these stages so a run can never stall." Every session gets `disallowedTools: ['AskUserQuestion']`. The spec session asks you through its own question rounds, because an SDK session has no chat UI.
- §10.1: "Each run records the exact plugin versions used in `run-record.json`" (in the job folder).
- §7.1: MCP servers "load only in the stages that use them". A plugin's MCP servers load only where that plugin is listed. A repo's own `.mcp.json` never loads: `strictMcpConfig: true` applies to every session.
- §6.4.1: "`anton plugins update` has the security reviewer read what changed in the new versions' scripts, hooks and MCP servers before you accept the update."
- Read-only sessions (any request with `tools`) keep the P2-R2 isolation in `src/agent/entry.ts`, and they never load plugins. The host refuses a request that has both.
- Existing rules from CLAUDE.md apply:
  - Effects go through `deps`.
  - Saves go through `writeFileAtomic` and `redact()`.
  - Host git goes only through `src/core/git.ts`.
  - zod is the source of truth, and every JSON Schema has an object root.
  - A stale image fails closed.
  - Fixtures are obviously fake.
- Caveman and Ponytail are options in the docs only, never on by default. Measuring them is Phase 5 (bench).

## Review Focus

1. **A listed plugin is not installed, or its files changed on disk after install.** Expected: the job refuses to start a session and pauses with `error`, naming the plugin and the fix (`anton plugins add` / `update`). Nothing loads partially. (Task 4)
2. **Config lists plugins for a read-only role, such as `security_reviewer` or `browser_tester`.** Expected: those sessions get no plugins and keep full isolation. `anton plugins list` shows that the entry is ignored for read-only roles. (Tasks 2, 4)
3. **A marketplace plugin whose `source` points outside the cloned repo, uses an unsupported source type, or contains a symlink.** Expected: `plugins add` refuses with a clear message and writes nothing to the lock. (Task 3)
4. **The update review raises concerns, you answer no, or stdin is not a TTY.** Expected: the lock is unchanged, jobs keep using the old version, and the new folder is removed. (Task 6)
5. **A container started before Phase 4a (no plugins mount) is reused.** Expected: the runner replaces it, like a container on the wrong image. (Task 4)

---

### Task 1: Phase 3b "Do first" fixes

**Files:**
- Modify: `src/kits/web/index.ts`, `src/kits/web/browser.ts`, `src/kits/fallback/index.ts`, `src/stages/baseline.ts`, `src/stages/verify.ts` (export `assertEvidenceDir`), `src/stages/spec.ts`
- Test: `tests/kits/web.test.ts`, `tests/kits/fallback.test.ts`, `tests/stages/baseline.test.ts`, `tests/stages/spec.test.ts`

**Interfaces:**
- Produces:
  - **Unsettled restore.** When the restore leaves `unsettled` paths, `webKit.verify` throws `Error('Browser session left project files changing: <paths>. Check them, then run anton resume.')`. The runner then pauses the job with `error`, so `commitAll` never runs on them.
  - **Baseline guard.** The baseline stage calls `assertEvidenceDir(repo, jobDir)` before any write to evidence.
  - **No concurrent writers.** The fallback kit's `verify` and `baseline` run `kill -s KILL -- -1 2>/dev/null; true` in the container after their last command and before any host write to evidence. With nothing running in the container, nothing can swap in a symlink after the guard has checked.
  - **Short changed-files note.**
    - Leave out paths that are absent from both the before snapshot and the final status.
    - Show at most 20 paths, then `and <N> more`.
  - **CRLF `Kit:` line.** `readApprovedSpec` trims the captured `Kit:` value, so `web\r` reads as `web`.

- [ ] **Step 1: Write the failing tests.**
  - `'unsettled restore throws so the job pauses'`
  - `'baseline refuses a symlinked evidence dir'`
  - `'fallback verify kills container processes before host evidence writes'`: assert that the kill call comes after the test command and before the JUnit read
  - `'changed-files note lists at most 20 paths'`
  - `'note leaves out paths absent from both snapshots'`
  - `'Kit line with CRLF reads as web'`
- [ ] **Step 2:** Run `npx vitest run tests/kits tests/stages/baseline.test.ts tests/stages/spec.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite, then `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`. Expected: PASS.
- [ ] **Step 5:** Commit `fix(verify): close Phase 3b follow-ups`.

### Task 2: Config file and plugin resolution

**Files:**
- Create: `src/core/anton-config.ts`
- Test: `tests/core/anton-config.test.ts`

**Interfaces:**
- Produces:
  - `AntonConfigSchema` (zod, `.strict()` on every object):
    - `stages?: { spec?, plan?, build?, verify?: string[] }`
    - `kits?: { fallback?, web?: string[] }`
    - `roles?: Partial<Record<Role, string[]>>`
    - Entry format: `/^[a-z0-9][a-z0-9-]*(:[a-z0-9][a-z0-9-]*)?$/`.
    - Phase 4b adds its keys to this same schema.
  - `loadAntonConfig(home = antonHome()): Promise<AntonConfig>` reads `<home>/config.yaml`. A missing file gives `{}`. Bad YAML or schema errors throw `Invalid ~/anton/config.yaml: <zod message>`.
  - `STAGE_GROUP: Record<string, 'spec'|'plan'|'build'|'verify'>` maps the runner stage to its config key:
    - `spec` maps to `spec`
    - `plan` and `baseline` map to `plan`
    - `build` maps to `build`
    - `verify` maps to `verify`
  - `READ_ONLY_ROLES: Role[] = ['code_reviewer', 'security_reviewer', 'browser_tester', 'mapper']`
  - `resolveEntries(cfg, { stage, role, kit }): string[]` returns the deduplicated union of:
    - `stages[STAGE_GROUP[stage]]`
    - `kits[kit]` (only when the group is `plan`, `build` or `verify`)
    - `roles[role]`

    It returns `[]` for read-only roles. The order is stable: stage entries, then kit, then role.

- [ ] **Step 1: Write the failing tests.**
  - `'missing config gives empty'`
  - `'unknown key is rejected'`
  - `'bad entry name is rejected'`
  - `'build frontend web: stage + kit + role entries, deduped, stable order'`
  - `'kit entries are not applied in spec'`
  - `'read-only roles resolve to nothing'`
  - `'baseline uses the plan entries'`
- [ ] **Step 2:** Run `npx vitest run tests/core/anton-config.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(config): ~/anton/config.yaml with per-stage, kit and role plugins`.

### Task 3: Plugin store, `plugins add` and `plugins list`

**Files:**
- Create: `src/plugins/store.ts`, `src/plugins/marketplace.ts`, `src/cli/commands/plugins.ts`
- Modify: `src/core/git.ts` (`cloneShallow`), `src/cli/index.ts` (register the commands)
- Test: `tests/plugins/store.test.ts`, `tests/cli/plugins.test.ts`

**Interfaces:**
- Consumes: `antonHome()`, `writeFileAtomic`, `resolveEntries`, `READ_ONLY_ROLES`.
- Produces:
  - **`git.ts`.** `cloneShallow(url: string, dest: string): Promise<string>` clones with depth 1, under the same hook and config blocking as every other git call, and returns the HEAD sha.
  - **`marketplace.ts`.**
    - `parseSpecifier(s): { plugin: string; marketplace: string; url: string }`. It accepts `<plugin>@<owner>/<repo>`, which becomes `https://github.com/<owner>/<repo>.git`, and `<plugin>@<https git url>`. Anything else throws `Use <plugin>@<owner>/<repo> or <plugin>@<git url>`.
    - `resolvePluginDir(cloneDir, plugin): Promise<string>` reads `.claude-plugin/marketplace.json` and finds the entry by name. A string `source` is a relative path, whose realpath must stay inside `cloneDir`. Object sources `{source:'github', repo}` and `{source:'url', url}` are cloned in turn. Any other source throws `Unsupported plugin source "<type>" for <plugin>`.
  - **`store.ts`.**
    - `LockEntry = { name, marketplace, url, version, commit, sha256, dir }`. `dir` is relative to `<home>/plugins`, and `version` comes from `.claude-plugin/plugin.json` or is `'unversioned'`.
    - `readLock()` and `writeLock(entries)` use `<home>/plugins.lock` (JSON, written atomically).
    - `treeHash(dir): Promise<string>` is the sha256 over the sorted lines `<relpath>\0<x|->\0<sha256(content)>`. It skips `.git` and throws on any symlink: `Plugin contains a symlink: <relpath>`.
    - `installPlugin(spec, deps): Promise<LockEntry>`:
      1. Clone the marketplace into a temp dir.
      2. Resolve the plugin.
      3. Copy it (without `.git`) to `plugins/<marketplace-slug>/<plugin>/<commit12>/`.
      4. Hash it.
      5. Lock it.

      A name already locked from a different marketplace throws.
    - `verifyInstalled(entry): Promise<void>` throws `Plugin <name> changed on disk since install — run: anton plugins update <name>` when the hash differs.
  - **CLI.**
    - `anton plugins add <specifier>` prints the locked entry and a `config.yaml` snippet.
    - `anton plugins list` prints the lock, then per stage, kit and role what loads. Read-only roles show `(ignored: read-only role)`. Listed entries that aren't installed show `NOT INSTALLED`.

- [ ] **Step 1: Write the failing tests.** Use a local bare git repo fixture as the marketplace, with no network.
  - `'add pins name, version, commit and hash'`
  - `'relative source escaping the clone is refused'`
  - `'unsupported source type is refused'`
  - `'symlink inside the plugin is refused'`
  - `'same name from another marketplace is refused'`
  - `'verifyInstalled detects an edited file'`
  - `'list marks read-only roles and missing plugins'`
- [ ] **Step 2:** Run `npx vitest run tests/plugins tests/cli/plugins.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugins): pinned plugin store with add and list`.

### Task 4: Load plugins into sessions

**Files:**
- Modify:
  - `src/agent/protocol.ts`: `PROTOCOL_VERSION = 3`; the request gains `plugins?: string[]`, `skills?: string[]` and `mcpServers?: Record<string, unknown>`.
  - `src/agent/entry.ts`
  - `src/agent/host-runner.ts`: `StageCtx.kit?: 'fallback'|'web'` and the plugin resolution
  - `src/docker/container.ts`: the mount and label
  - `src/pipeline/runner.ts`: reuse check, `kit` on ctx, `run-record.json`
  - `src/cli/spec-session.ts`
- Create: `src/plugins/session.ts`
- Test: `tests/agent/entry.test.ts`, `tests/agent/host-runner.test.ts`, `tests/plugins/session.test.ts`, `tests/pipeline/runner.test.ts`, `tests/docker/container.test.ts`

**Interfaces:**
- Consumes: `loadAntonConfig`, `resolveEntries`, `readLock`, `verifyInstalled`.
- Produces:
  - **`session.ts`.** `pluginsForSession(ctx, role, deps): Promise<{ plugins: string[]; skills: string[]; mcpServers: Record<string, unknown>; used: LockEntry[] }>`
    - Container paths are `/opt/anton/plugins/<entry.dir>`.
    - `skills`: a `plugin:skill` entry gives that name. A whole-plugin entry expands to `plugin:<dir>` for every `skills/<dir>/SKILL.md`.
    - `mcpServers` come from the plugin's `.mcp.json` or the `mcpServers` field of `plugin.json`, with `${CLAUDE_PLUGIN_ROOT}` replaced by the container path. A server name that appears in two plugins throws.
    - A listed entry with no lock entry throws `Plugin <name> is listed in config.yaml but not installed — run: anton plugins add <name>@<marketplace>`.
    - Every used entry goes through `verifyInstalled`.
  - **`runAgent`.**
    - When `req.tools` is unset, it calls `pluginsForSession` (injectable through `RunAgentDeps.plugins`) and sets the three fields.
    - When `req.tools` is set and the request has `plugins`, it throws `AgentError('read-only sessions cannot load plugins')`.
  - **`buildOptions`.** All of these apply to every session:
    - `disallowedTools: ['AskUserQuestion']`
    - `strictMcpConfig: true`
    - `mcpServers: req.mcpServers ?? {}`
    - `plugins: req.plugins.map(path => ({ type: 'local', path, skipMcpDiscovery: true }))`
    - `skills: req.skills ?? []`

    Sessions without `tools` get `settingSources: ['project']`, which keeps the repo's CLAUDE.md. Read-only sessions keep `settingSources: []`.
  - **Container.**
    - `startContainer` adds `-v <home>/plugins:/opt/anton/plugins:ro` and `--label anton.mounts=2`. It creates `<home>/plugins` first.
    - The runner's reuse check also requires `docker inspect -f '{{index .Config.Labels "anton.mounts"}}'` to return `2`.
    - The spec session's container gets the same mount.
  - **Run record.** Every job-start and resume path merges `{ plugins: [{name, version, commit, sha256}] }` (all entries the config can load for this job) into `<jobDir>/run-record.json`.

- [ ] **Step 1: Write the failing tests.**
  - `'builder session gets plugin paths, expanded skills and host MCP servers'`
  - `'plugin:skill entry passes only that skill'`
  - `'listed but not installed plugin throws with the add hint'`
  - `'edited plugin fails closed'`
  - `'read-only request with plugins is refused'`
  - `'entry sets strictMcpConfig, AskUserQuestion block and skills for every session'`
  - `'builder keeps project settings; reviewer keeps none'`
  - `'container without the plugins mount label is replaced'`
  - `'run-record lists the plugin versions'`
- [ ] **Step 2:** Run `npx vitest run tests/agent tests/plugins tests/pipeline tests/docker`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `npm run build:image`, `ANTON_E2E=1 npx vitest run tests/e2e/docker.e2e.test.ts`, then the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugins): load pinned plugins per stage, kit and role`.

### Task 5: Unattended-stage rule and questions in the report

**Files:**
- Create: `src/stages/prompts/unattended.md`
- Modify: `src/agent/host-runner.ts`, `src/stages/deliver.ts`
- Test: `tests/agent/host-runner.test.ts`, `tests/stages/deliver.test.ts`

**Interfaces:**
- Produces:
  - `unattended.md` holds the §10.1 instruction verbatim, plus the exact file path: `Write questions to /workspace/.anton/jobs/{jobId}/questions.md as "- Q: … / Assumed: …" lines.`
  - **`runAgent`.** For every stage except `spec`, it appends the rendered `unattended.md` to `req.systemPrompt`, separated by a blank line. `{jobId}` is the one changing value, and it goes in a final line so the rest of the prompt stays byte-stable.
  - **`deliver`.** When `<jobDir>/questions.md` exists and isn't empty, `REPORT.md` gets a `## Questions and assumptions` section with its redacted content, placed before `## Security`.

- [ ] **Step 1: Write the failing tests.**
  - `'unattended instruction appended outside spec'`
  - `'spec session has no unattended instruction'`
  - `'report includes questions and assumptions'`
  - `'no questions file: no section'`
- [ ] **Step 2:** Run `npx vitest run tests/agent/host-runner.test.ts tests/stages/deliver.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugins): unattended-stage rule and questions in the report`.

### Task 6: `anton plugins update` with a security review

**Files:**
- Create: `src/plugins/update.ts`, `src/stages/prompts/plugin-review.md`
- Modify: `src/cli/commands/plugins.ts`, `src/core/config.ts` (role `plugin_reviewer`: `claude-sonnet-5-5`, `high`)
- Test: `tests/plugins/update.test.ts`, `tests/cli/plugins.test.ts`

**Interfaces:**
- Consumes: `installPlugin` (into a staging folder, not locked), `treeHash`, `runAgent`, `startContainer`, `ensureImage(fallbackKit)`, `CliDeps.ask`.
- Produces:
  - `pluginDiff(oldDir, newDir): { added: string[]; removed: string[]; changed: string[]; patch: string }`.
    - `patch` is a unified diff, made with `git diff --no-index` through `git.ts`, of these paths only:
      - `hooks/**`
      - `*.sh`, `*.js`, `*.mjs`, `*.cjs`, `*.ts`, `*.py`
      - `.mcp.json`
      - `.claude-plugin/plugin.json`
      - `bin/**`
    - Other changed files are listed by name only.
  - `updatePlugin(name, deps): Promise<'up_to_date' | 'updated' | 'declined'>`:
    1. If the new commit equals the locked one, return `up_to_date`.
    2. Otherwise stage the new copy and compute the diff.
    3. Run one review session:
       - folder `<home>/plugins/.reviews/<name>-<commit12>/`, holding `old/`, `new/` and `diff.patch`, with a job folder under its `.anton/jobs/review`
       - a throwaway fallback container named `anton-plugin-review`
       - role `plugin_reviewer`, tools `['Read','Grep','Glob']`, maxTurns 40, budget $1
       - output `{ verdict: 'ok'|'concerns', findings: [{ file, severity: 'critical'|'high'|'medium'|'low', note }] }`
    4. Print the diff summary and the findings.
    5. Ask `Accept the update to <name> <old> → <new>? [y/N]` through `CliDeps.ask`. If stdin is not a TTY, return `declined` without asking.
    6. On yes, write the lock. Otherwise delete the staged folder.
    7. Always remove the container.
  - `anton plugins update [name]` updates the named plugin, or every locked plugin, one at a time.

- [ ] **Step 1: Write the failing tests.** Use fake `runAgent`, a fake exec and the local marketplace fixture.
  - `'same commit is up to date and runs no review'`
  - `'diff patch covers hooks, scripts and MCP files only'`
  - `'yes updates the lock to the new commit and hash'`
  - `'no keeps the lock and removes the staged copy'`
  - `'non-TTY declines without asking'`
  - `'review container is removed even when the review throws'`
  - `'review findings are printed before the question'`
- [ ] **Step 2:** Run `npx vitest run tests/plugins/update.test.ts tests/cli/plugins.test.ts`. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full suite. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugins): reviewed plugin updates`.

### Task 7: Docs and end-to-end checks

**Files:**
- Modify: `README.md`, `CLAUDE.md`
- Create: `tests/e2e/plugins.e2e.test.ts` (free part under `ANTON_E2E`; paid part also needs `ANTHROPIC_API_KEY`)
- Test: `tests/e2e/docker.e2e.test.ts`

**Interfaces:**
- Produces:
  - The README "Plugins" section covers:
    - `config.yaml`, with the §10.1 example
    - `add`, `list` and `update`, including the review step
    - the lock file
    - read-only roles never loading plugins
    - MCP servers only in listed stages
    - the unattended rule and `questions.md`
    - that plugin code runs inside the job container with the same access as the builder agent
    - Caveman and Ponytail as opt-in `roles:` entries for builder roles, off by default, with measurement planned for the Phase 5 bench
  - CLAUDE.md gets one Rules line: plugins load only through `pluginsForSession`, and read-only sessions never load them.
  - Free e2e:
    - A container has `/opt/anton/plugins` mounted read-only (a write fails).
    - `plugins add` from a local fixture marketplace, then `plugins list`, show the entry.
  - Paid e2e: a builder session loads a fixture plugin whose skill tells the agent to create `PLUGIN_OK.txt`. The test asserts the file exists. It is written but not run without a key.

- [ ] **Step 1: Write the e2e tests.**
- [ ] **Step 2:** Run `npm run build:image`, `ANTON_E2E=1 npx vitest run tests/e2e`, the full suite, `npx tsc --noEmit` and `npm run build`. Expected: all pass; the paid tests are skipped.
- [ ] **Step 3:** Commit `feat: Phase 4a plugin docs and e2e`.

## Not in this phase (4b and later)

- **4b:**
  - the prompt-caching layout and cache-hit tracking
  - stage allowances (10/10/50/25/5 with borrowing)
  - the cost estimate at checkpoint 1
  - task budgets
- **Phase 5:**
  - the scoreboard
  - bench measurement of Caveman and Ponytail
  - Retro and its plugins (`stages.retro`)
- **Not supported:**
  - plugin sources other than relative path, `github` and `url`
  - `plugins remove`
