# Phase 5a: rulings and deferred follow-ups

Decisions made while building Phase 5a (Retro and lessons), and the minor findings left for later.

## Do first

- **Prove the live API path.** The paid Retro e2e test has never run, because `ANTHROPIC_API_KEY` is not set. Run `ANTON_E2E=1 npx vitest run tests/e2e/retro.e2e.test.ts` with a key. Then add one batch round-trip (submit, poll, collect). These are all unproven against `claude-haiku-5-5`:
  - `batches.create`, `retrieve` and `results`
  - `output_config.effort`
  - the structured-output format
- **Strip C1 control characters in `cleanLessonText`** (U+0080–U+009F), and pass the `Saving:` line in `lessons review` through `safe()`. Some terminals act on a C1 CSI byte (U+009B).
- **Redact the unknown-target note.** The "dropped lesson for unknown target" note prints the model's raw `target`. Pass it through `redact`.
- **Commit a leftover `.gitignore`.** If the first lesson write fails after `.gitignore` is written, the file stays untracked. Include `.gitignore` in the commit paths whenever git does not track it yet.

## Rulings

- **Plan decisions:**
  - The cap is exactly 20 lessons per file.
  - Lessons reach agents in the stable system prompt, not through a mount.
  - Retro is one call through the Batch API (direct mode if `retro.batch: false`), using `claude-haiku-5-5` at `low` effort.
  - At most 5 lessons and 2 plugin suggestions per job.
- **P5a-R1:** `retro.json` is read with `readRegularFile` after `assertJobDir`. An invalid file counts as failed and is never resubmitted. Cost if wrong: none.
- **P5a-R2:** the Retro budget check borrows unspent earlier shares, per §7.1, and also respects the job cap. Cost if wrong: none, since Retro costs cents.
- **P5a-R3:**
  - Direct mode prints its notes.
  - The final `retro.json` status is written before the cost is recorded, so a failed write never double-counts.

  Cost if wrong: none.
- **P5a-R4:** `lessons review` without a terminal still collects finished Retros: it updates their status and cost and fills the queue. It accepts and rejects nothing. Cost if wrong: none.
- **Final review:** one fix wave covered the following. Cost if wrong: a slightly larger fix diff.
  - tool use counted from the JSON log events
  - Unicode format characters stripped
  - `ANTHROPIC_API_KEY` redacted from the run record and proposals
  - switch back before Retro
  - a non-creating evidence check
  - `safe()` on all printed text
  - a "Retro(s) still running" line
  - the API error text kept for an errored batch
  - a duplicate accept drops the proposal
  - `.gitignore` for `proposals.jsonl`

## Deferred minor findings

- Task 1: in the money-flow test:
  - it relies on the default allowances
  - it uses `toMatchObject` rather than `toEqual`
  - the $9.80 post-resume limit appears only in a comment
  - the log test does not recheck `ctx.warn`
- Task 2:
  - If the write succeeds but the commit fails, the change stays uncommitted.
  - The lesson files and the queue are read-modify-write with no lock.
  - `--no-verify` is redundant.
  - Stripping `\p{Cf}` also removes ZWJ and ZWNJ. That is acceptable for English lessons.
- Task 3:
  - A corrupt lessons file blocks every session (fails closed). The error should name the file.
  - A lesson accepted mid-job loads but is not in `run-record`. The 5b scoreboard should note this.
  - Spec and plugin-review sessions get role lessons only.
- Task 4:
  - A free-text `## ` line can forge a heading. The fence is the defence.
  - Tool counts span all rounds.
  - A large `questions.md` gets the waste sections cut first.
  - Spec key names are not capped.
  - The unreadable-cost branch is untested.
- Task 5:
  - A container could plant `retro.json` to suppress Retro, or point it at another batch. The output is still validated and needs your accept. Document this in the threat notes.
  - A batch whose results expired (about 29 days) stays `submitted`. Mark it failed after 29 days.
  - Two concurrent reviews could record one batch's cost twice.
- Task 6:
  - Prompt numbering shows `1. [a]ccept`.
  - A failed edit does not let you retype.
- Task 7:
  - The README plugin bullet omits the config.yaml line.
  - The e2e test does not check `stop_reason`, has no `state.json` fixture, and bypasses `submitRetro`.
- `RETRO_JSON_SCHEMA` is used only by a test.
- `removeLesson` does not run `initRepoIfMissing`.

## Not verified

- Live Retro, both batch and direct, because no `ANTHROPIC_API_KEY` is set.
- A real `anton lessons review` session in a terminal.
