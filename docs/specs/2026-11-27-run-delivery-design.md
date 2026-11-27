# Run a delivery from Slack: design

Status: draft for Owner approval. Builds on Phase 7 (`2026-11-27-slack-plain-english-design.md`). Branch: `feat/run-delivery`, cut from `phase-7-slack-plain-english`.

## 1. Intent

When a delivery is ready for final review, the Owner wants to see and try the project before approving it, straight from Slack, with no commands to type. They asked for anton to run the application and open it locally itself.

## 2. Goals, non-goals, anti-goals

**Goals**
- **Folder:** the delivery card shows where the project is.
- **▶ Run it:** runs the delivered project in a Docker sandbox and opens it on the Owner's Mac.
  - **A web project** opens in the default browser.
  - **A CLI project** opens a Terminal window with a shell inside the sandbox, where the project's run command is shown.
- **■ Stop** ends a run. A run also stops by itself after 30 minutes.
- **Open in VS Code** opens the project folder on the Mac, so the Owner can read the code without running it.

**Non-goals**
- Desktop GUI apps, mobile simulators, and anything that cannot run in the kit's Linux container. For those the card shows only Open in VS Code.
- Deploying, pushing, or running after approval from a plain-English request. A request like "run hello cli" can come later.
- More than one run per project at a time.

**Anti-goals**
- AI-written code running directly on the Mac, outside Docker.
- A run container holding the Anthropic API key or anton's own data.
- A web app reachable from anywhere but the Mac itself.
- A forgotten run left going forever.

## 3. Constraints

- **Owner only:** only the Owner may press Run, Stop or Open. The buttons are ordinary card tokens, bound to the job and its delivery revision. They go stale like any other card, and the existing card rules apply.
- **Run commands are untrusted:** they come from the job's `plan.json`, which an agent wrote. They only ever run inside the container (`docker exec … sh -lc`) and are never put into a host shell.
- **The sandbox container is `anton-preview-<slug>`:** it is separate from the build container `anton-<slug>`.
  - **Image and mount:** it uses the project's kit image, with the repo mounted at `/workspace`.
  - **No anton data:** there is no plugins mount and no `ANTHROPIC_API_KEY`.
  - **Project secrets** are passed with `--env-file`, as builds already do, because the app may need them to run.
  - **Web projects:** one port is published, on `127.0.0.1` only.
- **Opening things on the Mac** uses fixed programs with arguments, never a shell:
  - `open <url>` for the browser;
  - `open -a "Visual Studio Code" <folder>` for VS Code;
  - `osascript` with a fixed script for Terminal, where the container name is the only variable and it is checked against `^anton-preview-[a-z0-9-]+$`.
- All of this runs inside `anton serve`, so the Mac must be awake and the Slack service running.
- Every external effect is injectable through `deps`. Tests never start Docker, a browser, Terminal or VS Code.

## 4. Approaches considered

| Approach | Trade-off | Decision |
|---|---|---|
| **Run in a dedicated Docker sandbox, then open it on the Mac** | Safe, and matches how anton already builds and tests. Web projects need one published port. | **Picked by the Owner.** |
| Run directly on the Mac | The simplest option and the fastest start. But AI-written code would run with full access to the Owner's files and Keychain. | Rejected. |
| Open automatically when a delivery is ready | No click is needed, but windows would pop up while the Owner is away or on their phone. | Rejected. A button instead. |

## 5. Design

### 5.1 The card

The delivery-ready card (`composeSlackMessage`, `delivery-ready`) gains a line and three buttons:

```
Delivery 1 is ready for final review
Folder: ~/Documents/Code_Playground/projects/anton/projects/hello-cli
[ ▶ Run it ]  [ ■ Stop ]  [ Open in VS Code ]  [ Approve delivery ]  [ Reject… ]
```

- **Folder:** the project's registered path, with the home folder shown as `~`.
- **Run it:** is left out when the plan has neither `commands.run` nor `commands.serve`.
- **New card kinds:** `preview-run`, `preview-stop` and `open-folder`, bound to the same delivery target as Approve.
- **The click result:** Run and Open answer privately and keep the card open, because the Owner may press them again. That is the card-closing rule from the Phase 7 card fix: only finished decisions close a card.

### 5.2 ▶ Run it

1. **Check the target is current:** the job must be at `awaiting_final_review` for that delivery, and the folder must be the registered path.
2. **Replace any earlier run** of this project: `docker rm -f anton-preview-<slug>`.
3. **Start the sandbox container** (detached, `sleep infinity`):
   - `--name anton-preview-<slug> -v <repo>:/workspace -w /workspace [--env-file <project secrets>]`;
   - for a web project, also `-p 127.0.0.1:<hostPort>:<appPort>`. `<appPort>` comes from `commands.url`. `<hostPort>` is the same number when it is free on the Mac, otherwise a free port the OS picks.
4. **Install:** `commands.install` runs inside the container, with a 5-minute limit. If it fails, the Owner gets a private reply with the last 20 lines of output, after redaction, and the container is removed.
5. **Open it:**
   - **Web project:** run `commands.serve` in the background inside the container. Poll `http://127.0.0.1:<hostPort>` for up to 60 seconds, then run `open http://localhost:<hostPort><path>`. Reply: "Running at http://localhost:<hostPort>. It stops in 30 minutes, or press Stop."
   - **CLI project:** open Terminal with `docker exec -it anton-preview-<slug> sh -l`, printing first "You are inside the sandbox in the project folder. Try: <commands.run or commands.test>". Reply: "A Terminal window opened inside the sandbox."
6. **Remember the run** in `~/anton/previews.json`, with the project, container, started time and port, written atomically. *(Planning change: the **■ Stop** button sits on the delivery card itself instead of a separate card in the thread, which is simpler and always in the same place.)*

### 5.3 Stopping

- **The Stop button** on the delivery card runs `docker rm -f anton-preview-<slug>` and replies privately "Stopped." The card stays open.
- **Automatically:** `anton serve` checks `previews.json` every minute and removes any run older than 30 minutes, then posts "The sandbox run of <project> stopped after 30 minutes."
- **On service start and stop:** when `anton serve` starts, it removes any `anton-preview-*` container left in `previews.json` from before. When the service stops, it removes the runs it started.
- **When a job moves on** (approved, rejected or abandoned), its run is removed. The same minute check removes any run whose job is no longer at `awaiting_final_review` for that delivery.

### 5.4 Open in VS Code

- **When VS Code is found:** `open -a "Visual Studio Code" <repoPath>`.
- **When it isn't:** the reply says so, and `open <repoPath>` shows the folder in Finder instead.
- **It runs nothing in the project.**

## 6. What's left to the builder

- Finding a free host port, and the readiness poll.
- The exact Terminal AppleScript, with the container name as the only variable after validation.
- The kit image: use the same tag the runner resolves for the project's kit.
- The reply copy.
- **Tests,** with every Docker and `open` call faked:
  - argument lists: no API key, no plugins mount, port published on `127.0.0.1` only;
  - the container name is validated;
  - the install fails cleanly;
  - the 30-minute expiry;
  - cleanup when the service starts;
  - stale card refusal;
  - Owner only;
  - the card leaves out Run when there is no run or serve command.
- **Live check by the Owner:** one web and one CLI delivery.

## 7. Risks

- **A web app may bind 127.0.0.1 inside the container.** Then the published port can't reach it. The reply says the app didn't answer within 60 seconds and suggests the Terminal path.
- **Install speed:** a large install takes a while, and the reply says it is working.
- **Generated code runs with the project's own secrets**, the same as a real run would. It is still inside Docker, without anton's key or data.
