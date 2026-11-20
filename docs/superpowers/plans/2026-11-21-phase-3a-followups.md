# Phase 3a: rulings and deferred follow-ups

This file lists the decisions made while building Phase 3a (existing code and secrets), the findings parked at the final review, and the minor issues deferred to later phases.

## Do first (parked at the final review)

- **The secret guard can stall a job on a repo that already has a committed secret.** The guard checks the whole staged diff, including unchanged context lines and removed lines. A secret value that sits next to an edit, or a hard-coded secret the agent deletes, blocks the commit. The job then pauses on every resume.
  - Fix: check only the added (`+`) lines.
  - Also known: binary files in the diff are not checked.
- **A wrong-branch refusal in the runner doesn't notify you.** The refusal throws outside the runner's inner catch, so it goes only to `runner.log`. There is no notification and no `error.log`. Move the check inside the inner try, before `startContainer`, so the job pauses with `error` and you get notified.
- **`resume` on a finished change job asks you to switch branches instead of saying "Nothing to resume".** The branch check runs first. Swap the two checks.
- **Final accept is refused after you switch to `main`.** Final accept makes no commit, so it can safely skip the branch check.
- **Old accepted risks stop matching.** `scannerRef` now includes the finding's `key`. Accepted risks recorded on scanner findings in an in-flight Phase 2 job no longer match, so they block again. Add a README note.
- **Edited-around findings come back as new.** In `--no-git` mode the gitleaks fingerprint includes the line number. A finding that existed at baseline turns "new", and blocks, when the builder edits lines above it.

## Rulings

- **P3-R1:** `StageCtx.secrets` is optional, and `redact` treats undefined as `{}`. The runner and the spec session always set it. Cost if wrong: an unset ctx skips redaction.
- **Task 1:** semgrep keys use an ordinal per (rule, file, base). Cost if wrong: none.
- **Task 2 → 3:** rollback of a half-created change job is best effort. It removes the job dir first, swallows branch-drop errors, rethrows the original error, and switches back by name. Cost if wrong: none.
- **Task 3 → 4/8:** project names must be slug-safe, so a project name can never traverse the secrets path. Cost if wrong: none.
- **Task 4 → 11:** abandon restores your original branch, recorded in `fromBranch`. Cost if wrong: none.
- **Task 5 → 6/9:** the repo map is fenced and treated as untrusted data. Its write goes through `redact`.
- **Task 6:** passing-test labels are `classname::name`, so same-named tests in different classes stay separate. Cost if wrong: one small test change.
- **Task 8:** the secrets file follows Docker's `--env-file` rules exactly: no quotes, no spaces around `=`, no `export`, no bare names. This overrides the plan, which said to strip quotes. Cost if wrong: you must write unquoted values, which Docker requires anyway.
- **Task 8:** `anton secrets edit` warns when it tightens a loose file. Editors with arguments (for example `code --wait`) work. Cost if wrong: small.
- **Task 8:** project names are checked with a character-set regex, so 42-character `uniqueName` results stay valid. Cost if wrong: none.
- **Task 9:** JSON- and XML-escaped forms of a secret are redacted before the raw form. JUnit rewrites use `writeFileAtomic`. Cost if wrong: small.
- **Task 10:** skipped `[real]` tests are ignored when grading a check. Other skipped tests still fail. Cost if wrong: a check with only a skipped `[real]` test reads `no_test`.
- **Task 10:** a service counts as `real` only when its whole name appears, case-insensitive, as a word in a passing `[real]` test name. Cost if wrong: it under-claims `real`, which is the honest direction.
- **Task 10:** `envVars` entries must look like names (`/^[A-Z_][A-Z0-9_]*$/`).
- **Task 11:** the README gives the secrets path and the env-file rule. `switchBranch` uses `checkout -q <name> --`. Cost if wrong: none.
- **Final review:** one fix wave covered the following. Cost if wrong: a slightly larger fix diff.
  - the branch guard (`approve`, `resume`, runner)
  - the dirty-tree refusal before the baseline reset
  - a single `REG-norun` item when no tests ran
  - switch-back on accept
  - the secret-in-diff commit guard
  - secrets checked before a change job is created

## Deferred minor findings

- Task 2: no lock around concurrent `change` calls. `isClean` writes `.git/info/exclude` on a refused job.
- Task 3: the same repo can be adopted twice under two names. `JobActive` still catches overlapping jobs.
- Task 4: `change` runs preflight before the dirty and active checks, so it exits 2 instead of 1 when Docker is down.
- Task 5: no hard 150-line cap on the repo map.
- Task 6: the crash-resume test is partly synthetic. The `plan.md` wording ("Task 1 is normally infra scaffolding") contradicts change jobs. The plan prompt isn't told the map is data; it doesn't read the map today. `baseline.test.ts` shares a module-level array.
- Task 7: `SecurityFinding.preexisting` is typed `boolean`, but old records lack it. That is safe: such findings block. No verify-level test of baseline refs blocking.
- Task 8: an existing `secrets/` directory's mode isn't enforced. A symlinked env file is followed. Check-then-use race between the stat and Docker reading the file. CR or trailing whitespace in values isn't checked. Secrets are validated even when a running container is reused.
- Task 9: redaction matches the exact value only, so base64, URL-encoded or split values aren't caught. Mixed XML escaping can leave a fragment. Files you type yourself aren't redacted.
- Task 10: one redundant check and one dead `?? []` fallback. A service shows `real` even when its check fails. A PM output that breaks the `envVars` regex stops the spec stage with a raw `ZodError`. Skipped `[real]` tests are hidden from a check's test list.
- Task 11: `abandon` prints the same hint for a missing branch and a dirty tree.

## Not verified

- The paid real-API e2e tests (`new-project`, `change-job`) have never run, because no `ANTHROPIC_API_KEY` is set.
