# Phase 4a: rulings and deferred follow-ups

This file lists the decisions made while building Phase 4a (marketplace plugins) and the minor findings left for later phases.

## Do first

- **Prove that real plugin loading works.**
  - The paid e2e (`npm run test:e2e`, about $3) has never run. It checks that a builder session loads a plugin skill and follows it, now that every session has `settingSources: []`.
  - Run it once with `ANTHROPIC_API_KEY` set.
  - Also do one manual `anton plugins update` against a real marketplace. The review container and its structured output have not been checked in Docker against the API.
- **`cost.json` is read through `readOptional`, which follows symlinks** (`src/stages/deliver.ts`).
  - The job folder itself is now checked, but files inside it are not.
  - Fix: use `readRegularFile` here as well.
- **`writeRunRecord` throws a raw `TypeError` when `run-record.json` holds a non-object.** The job still pauses. Give a clear message instead.

## Rulings

- **P4a-R1:** `STAGE_GROUP` also maps `deliver` to `verify`. Any other stage string throws. Cost if wrong: none.
- **P4a-R2:** `installPlugin` takes `{ lock: false, destRoot }`, so `plugins update` can stage a new version without touching the lock. Cost if wrong: a small signature change.
- **P4a-R3:** the changed-files note drops a path only when two things hold: the path is absent from both snapshots, and it is ignored after the restore. The note then caps the list at 20 paths. Cost if wrong: none.
- **P4a-R4:** the evidence-folder check runs again after the container kill and before the first host write. This applies to fallback verify, baseline and `baseline.json`. The plan put the check before the tests. The sandbox boundary outranks that ordering. Cost if wrong: one extra `lstat` pass per stage.
- **P4a-R5:** `plugins update` with no terminal refuses before staging or review, so it spends nothing. Cost if wrong: none.
- **P4a-R6:** every session gets `settingSources: []`, builders included. A repo's `.claude/settings.json` can therefore never turn on unlisted plugins.
  - Instead, the build prompt tells builders to read the repo's CLAUDE.md and AGENTS.md.
  - The SDK's `managedSettings` lockdown was not used, because it couldn't be proven without a paid run.
  - Cost if wrong: builders no longer get the repo's CLAUDE.md loaded automatically.
- **P4a-R7:** the SDK loads plugins whole. So a `plugin:skill` entry still runs that plugin's hooks, agents and commands, and the README says so. `plugins list` shows `hooks: yes/no`, and a missing skill throws. Cost if wrong: none.

## Deferred minor findings

- Task 1:
  - The CRLF trim on the `Kit:` line is a no-op, because the old regex already stopped at `\r`, so its test can't fail.
  - The fallback kit's kill string duplicates the web kit's `KILL_ALL`.
  - A `git check-ignore` failure pauses the job rather than degrading.
  - The note is empty when every changed path is ignored.
  - The kit guard is skipped when `ctx.stage` or `ctx.repo` is missing. Production always sets both.
  - The fallback kit imports `stages/verify`.
  - The post-scanner re-check in baseline is untested.
- Task 2:
  - `STAGE_GROUP` should use `Object.hasOwn`.
  - The `roles` schema isn't tied to `Role` at the type level.
  - Read-only, kit and unknown-key tests are thin.
  - `READ_ONLY_ROLES` is mutable.
- Task 3:
  - `marketplace.json` isn't `lstat`ed before it is read.
  - A source that names a file gives a raw `ENOTDIR`.
  - Tests don't clean up their env and temp dirs.
  - Two concurrent `plugins add` runs can lose a lock entry.
  - A source's `ref` and `sha` fields are ignored.
- Task 4:
  - `pluginsForJob` doesn't run `verifyInstalled`, so an edited plugin is caught only when its stage starts.
  - The mcpServers path check is string-based.
  - A custom `skills` path in `plugin.json` is ignored.
  - With nothing listed, `skills: []` also hides the repo's own skills.
  - Skill names are built as `<lockName>:<dir>`. They might not match what the SDK expects.
- Task 5:
  - `unattended.md` line 1 (spec-verbatim `.anton/questions.md`) and line 2 (the real per-job path) could read as two files.
  - A host-runner test mutates the shared `ctx.stage`.
- Task 6:
  - The `old/` copy isn't checked against the pinned sha256.
  - The review container name is fixed, so two runs can collide.
  - Some tests are missing: a same-hash destination, and `clean` on file lists.
  - `.reviews` folders are never pruned.
  - Authentication errors are detected only from git's English messages.
- Task 7: the paid e2e leaves a temp repo folder. The free e2e doesn't cover the "ignored" and "NOT INSTALLED" paths.
- `run-record.json` records what config can load at job start. An update during a running job isn't reflected.

## Not verified

- Real SDK plugin loading and the real `plugins update` review. Neither has run against the API, because no `ANTHROPIC_API_KEY` is set.
