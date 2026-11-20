# Phase 3b: rulings and deferred follow-ups

Decisions made while building Phase 3b (web kit), and the minor findings left for later phases.

## Do first

- **A restore that never settles doesn't block the next commit.** When the browser step's restore doesn't settle within 3 rounds, every check fails. The next build round's `commitAll` (`git add -A`) can still commit those files. This only matters if `KILL_ALL` misses a writer. Fix: block the commit, or re-run the restore before the build round.
- **Baseline evidence writes are not protected by the evidence-folder symlink guard.** `assertEvidenceDir` runs in `runVerify` only, and `fallbackKit.baseline` writes to `evidence/` too. Call the guard at the start of the baseline stage.
- **The guard has a check-then-use gap (TOCTOU).** The container could swap in a symlink after `assertEvidenceDir` and before a later host write. A full fix opens files relative to a verified directory handle, or does the writes inside the container.
- **The changed-files note gets very long after a `.gitignore` rewrite.** It lists every formerly ignored file it looked at, for example all of `node_modules`. Drop paths that are absent from both snapshots, or cap the list. The restore also runs one `git cat-file` per path, so a large exposed tree is slow.
- **A `Kit:` line with CRLF endings is rejected.** A `spec.md` saved with Windows line endings gives `Unknown kit "web\r"`. Trim the captured value.

## Rulings

- **P3b-R1:** Task 3 shipped `webKit.detect` as a stub that returned 0, and Task 4 replaced it. Cost if wrong: none.
- **P3b-R2:** the web Dockerfile calls the globally installed `playwright install --with-deps chromium` instead of `npx`, so the 1.50.1 pin holds. Cost if wrong: none.
- **P3b-R3:** `ensureImage` runs before a running container is reused. A stale image now fails closed even when a container is up. Cost if wrong: you run `npm run build:image` once.
- **P3b-R4:** the browser step's repo guard also catches further edits to files that were already dirty, using content hashes. Those files are reset to HEAD and named in the failure. Cost if wrong: a builder edit that was not yet committed is lost, and the next round redoes it.
- **Task 6:** `VerifyOutcome.state` was added so the browser agent's cost lands in the job's state. Restores use `git checkout HEAD -- <path>`. The snapshot is taken after the app is ready.
- **Final review:** one fix wave covered the following. Cost if wrong: a slightly larger fix diff.
  - the `.gitignore`-proof restore loop (never deletes ignored files; fails closed after 3 rounds)
  - killing every container process except PID 1 before the after-snapshot
  - the evidence-folder symlink guard
  - the changed-files note wording
  - zombie-aware fast failure when `serve` exits
  - the `++` secret-guard fix
  - reading the `Kit:` line from the header only

## Deferred minor findings

- Task 1: the "key never contains the secret" test is weak, and the gitleaks key test isn't pinned to an exact hash. The no-`Secret` fallback key uses the raw `File`, not `normalizePath`. An added line whose content starts with `++ b/` or `++ /dev/null` still looks like a diff header and is not scanned.
- Task 2: the runner's wrong-branch tests overlap. The spec-approval refusal test only guards against regressions.
- Task 3: `ensureImage`'s base parameter type has no nested `base`. The base-change test doesn't assert the new `BASE` argument.
- Task 5: `plan-web.md` relies on a leading blank line to join with `plan.md`. The url port isn't checked against `serve`; a mismatch fails as "App did not start".
- Task 6:
  - A cleanup error can mask the agent's own error.
  - Duplicate check ids prefer `fail`, which is undocumented.
  - Directories are hashed by mode only.
  - An empty `app.log` gives an empty tail.
  - Files the app writes at startup land in the before-snapshot and are not reverted.
- Task 7: README wording "the last one" in the Tests section is ambiguous. The README doesn't say `.anton/` is never committed. The deliver test's `not.toContain('Browser')` is brittle.
- Preflight checks only the fallback image. The first web job builds the web image (a Chromium download) during the unattended run.
- Screenshots are not redacted. This is accepted and documented in the README.

## Not verified

- The paid real-API e2e tests (`new-project`, `change-job`, `web-job`) have never run, because no `ANTHROPIC_API_KEY` is set.
