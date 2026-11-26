# Agents in calls: design

Status: approved 2026-11-27 and revised the same day so calls start and are run from Slack. Saved for later. This is spec 3 of 3. It depends on spec 1 (`2026-11-27-slack-plain-english-design.md`) for plain-English intents and confirm cards, and on spec 2 (`2026-11-27-cost-and-model-control-design.md`) for the spend log, caps and dashboard. Research behind it: `docs/research/2026-11-26-agents-in-video-calls.md`.

## 1. Intent

The Owner wants to bring a chosen few of anton's role agents (for example PM, Tech Lead and QA) into a real Zoom or Google Meet call, where they talk like normal teammates. **Each agent joins as its own participant, with its own tile and name,** speaks in its own voice, and answers from what it actually knows about the project. The call can be a standup or an ad-hoc call, and other real people may be on it too.

Slack already lets the Owner ask a role a question in writing. A call adds talking things through out loud, in a meeting where real teammates can hear the agents too.

## 2. Goals, non-goals, anti-goals

**Goals**
- **Started from Slack in plain English (decided):** for example, "bring PM, QA and tech lead into https://meet.google.com/abc-defg-hij for a standup on todo-app". No commands and no terminal during a call. The Owner pastes the link; reading a calendar is a later spec.
- **One tile per agent (decided).** Each agent appears as its own participant, for example "QA (Anton AI)", and its tile lights up when it speaks.
- Each invited agent has a distinct voice and speaks as its role.
- Agents answer from the project's real records (job state, spec, plan, evidence), with the same rules as Slack Q&A.
- **Respond mode (decided):** an agent speaks when someone addresses it by name, or when it is its turn in a standup. After an answer, at most one other invited agent may add one short follow-up. Agents never start a discussion among themselves.
- **Standup mode:** `--standup` makes the PM open the call and ask each invited agent in turn for a short update. After that the floor is open.
- Anyone talking interrupts an agent at once.
- There is a per-call spending cap and a monthly pool. When either is reached, the agents say so once and leave.

**Non-goals (this version)**
- Agents debating each other (a "discussion mode"). This is a later version, after respond mode feels natural.
- Owner actions by voice (approve, reject, resume, and so on). Agents in a call cannot change a Job, the same as in Slack.
- Avatars, or video beyond a simple name card. Screen share is also out.
- Zoom meetings hosted outside the Owner's own Zoom account. Those need Zoom's OBF tokens.
- Finding meetings from a calendar, or joining recurring meetings by schedule. These are a later spec.
- Microsoft Teams, Slack huddles (there is no API), and more than one call at a time.
- The local-Chrome route (approach A2 in section 4). It stays the fallback if Recall doesn't work out.

**Anti-goals (a failure even if it technically works)**
- Agents talking over people, or chattering when nobody asked them.
- Agents inventing project facts that are not in the records.
- A forgotten call running up a bill, or bots left sitting in a call.
- Anything on the Mac reachable from the internet outside a call, or reachable without that call's token.
- People on the call not knowing the agents are AI, or that their speech goes to outside services.

## 3. Constraints

- **Where it runs:** on the Owner's Mac (macOS). The agents' bots run in Recall.ai's cloud.
- **Network:** the only way in from the internet is a tunnel that exists only for the length of a call (section 5.2). Everything else connects *out* from the Mac.
- **Same rules as the rest of anton** (CLAUDE.md):
  - every external effect is injectable through `deps`, and unit tests never touch Recall, the tunnel or any API;
  - secret values pass through `redact()`;
  - system prompts hold only stable text.
- **API keys:**
  - **Anthropic:** read the way `anton serve` reads it (environment, then Keychain item `anthropic-api-key`).
  - **Recall, Deepgram and ElevenLabs:** read from new Keychain items `recall-api-key`, `deepgram-api-key` and `elevenlabs-api-key` (account = the macOS user).
  - **Adding keys:** the Owner adds them with `security add-generic-password -a "$USER" -s <service> -w`, which prompts with hidden input.
  - **Never stored:** keys are never written to files, logs or config, and never put in a page that a bot loads.
- **Public repo:** docs and fixtures hold no real keys, voice IDs or tunnel URLs.

## 4. Approaches considered

**How the agents get into the call**

| Approach | Trade-off | Decision |
|---|---|---|
| A1. One local Chrome window, one tile, virtual microphone | Nothing exposed and no bot fee. But all agents share one tile. | Rejected: the Owner needs separate tiles. |
| A2. One local Chrome window per agent, a Chrome extension feeding each window's microphone | Separate tiles, no fee, nothing exposed. But about 300–500 MB of RAM per window, the extension approach is unverified on Meet and Zoom, and overriding the page's microphone is a grey area. | Fallback. |
| **B. One Recall.ai bot per agent**, each loading a page we serve | The most reliable joining. Each bot is a real participant with its own name and tile. Costs about $0.60 an hour per agent, and the bots need a way back to the Mac. | **Picked by the Owner.** |
| C. Self-built bots (Zoom Linux SDK, headless Chrome) | Very high effort. Zoom's docs say its SDK "does not support bots". | Rejected. |

**How Recall's bots reach the Mac** *(my call)*

| Approach | Trade-off | Decision |
|---|---|---|
| **Per-call Cloudflare quick tunnel** (`cloudflared`, no account) | The Mac connects *out* to Cloudflare. A random public URL exists only during the call and is protected by that call's token. Cloudflare positions quick tunnels for testing, with no uptime promise. | **Picked.** It has the smallest setup and nothing stays open between calls. |
| A small hosted relay | The Mac never accepts inbound traffic at all. But it needs a hosting account and is one more service to run and secure. | Later, if the quick tunnel proves unreliable. |
| A named Cloudflare tunnel | A stable and reliable URL. But it needs a Cloudflare account and a domain. | Later, with the relay. |

## 5. Design

### 5.1 The shape

```
Zoom/Meet call
  ├─ Recall bot "PM (Anton AI)"   loads https://<random>.trycloudflare.com/bot/pm?t=<token>
  ├─ Recall bot "QA (Anton AI)"   loads …/bot/qa?t=<token>
  └─ one bot per invited agent
        Each page plays only its own role's voice, so the right tile lights up.
        One page (the "listener") also sends the call's audio up.
                       ⇅ WebSocket, through the per-call tunnel
anton call (Mac, 127.0.0.1 only)
  call audio → STT (Deepgram Flux, end-of-turn events) → floor manager
  → persona answer (Claude) → TTS (ElevenLabs, voice per role) → that role's bot page
```

The call runs inside `anton serve`, the Slack service already running on the Mac, with one call at a time. Slack is the whole interface (section 5.6). The service log gets one line per turn: who spoke, which agent answered, and the running cost. It never records what was said.

### 5.2 Joining and the tunnel

- **Setup, from Slack:** the Owner says "set up calls". The PM checks the prerequisites and replies with a checklist, giving the exact step for anything missing:
  - `cloudflared` is installed (`brew install cloudflared`) and on the service's PATH, which `slack service install` writes;
  - the Recall, Deepgram and ElevenLabs keys are in the Keychain;
  - a Recall region is set in config.

  It ends with a self-test: anton opens the tunnel, fetches its own page through it, and closes it again.

  Adding the keys stays a one-time Terminal step, with the exact `security add-generic-password -a "$USER" -s <service> -w` line given in the checklist. Keys are never typed into Slack. A pop-up dialog on the Mac is not used either, because passing a value to `security` as an argument would expose it in the process list. *(My call.)*
- **The local server** binds to 127.0.0.1 only. It serves exactly two things: the bot page at `/bot/<role>` and its WebSocket.
  - **Token:** every request must carry the call's token, which is 32 random bytes, new for each call and compared in constant time. Anything else gets a 404.
  - **One connection per role:** only one WebSocket is accepted for each invited role. A second connection for the same role is refused.
  - **Lifetime:** the server and the tunnel start when `anton call` starts and stop when it ends.
  - **The token in the URL:** the token travels in the page URL, which Recall stores with each bot. That is acceptable only because the token dies with the call.
- **Bots:** for each invited role, anton creates a Recall bot with:
  - the meeting link;
  - the name "<Role label> (Anton AI)";
  - the page URL as its output media (camera and audio), using the 4-core web variant that Recall recommends;
  - no recording and no Recall transcription, with data retention set to none;
  - automatic-leave timeouts as a backstop. If the Mac crashes, the bots leave by themselves within a few minutes.
- **Admission:** the host admits each bot (Meet lets the host admit several at once). Zoom meetings must be on the Owner's own account, because Recall reads Zoom's OBF rule as not applying there.
- **Supported links:** only `https://meet.google.com/…` and `https://*.zoom.us/j/…`. Any other link is refused before any bot is created.
- **The page** is a small static page with the role baked in.
  - **Camera:** it shows a name card with the role label, plus a "speaking" ring while that role's audio plays.
  - **Audio:** it plays the audio chunks anton sends to that role. It also sends the meeting audio it receives up the socket.
  - **Listener:** anton forwards one page's audio to STT, as section 5.3 "Not hearing themselves" describes.
  - **No secrets:** the page holds no keys and does no model or speech calls itself.
- **Introduction:**
  - **Trigger:** anton polls each bot's status at Recall every 3 seconds. When every bot is in the call (admitted, past the waiting room), the PM introduces the team. Speech is not used as the trigger, because someone could talk before the agents can be heard. *(My call.)*
  - **Partial admission:** if some bots are still waiting after 2 minutes, the Slack card says which ones. The intro waits until every bot is in, or until the Owner says "start anyway", which removes the bots still waiting.
  - **The PM's bot** joins even if the PM wasn't invited, for this line only, and then leaves. Copy: "Hi, this is the Anton team: <invited roles>. We're AI agents. What's said here goes to outside speech services so we can follow along. Address us by name."

### 5.3 The brain

**Floor manager.** A pure state machine with no I/O, tested with scripted events. It decides who may speak. Its inputs are STT turn events, TTS done and barge-in events, and the clock.

The rules:
1. **Addressed by name.** A human turn that names an invited role ("QA, …", "hey Tech Lead") gives the floor to that role. Matching uses the role labels and simple aliases ("tech lead", "PM", "security", "reviewer" for Code Reviewer).
2. **Addressed to the group.** A human turn addressed to "team", "anyone" or "Anton" goes to one invited role, picked by a cheap Haiku routing call that returns a role or "none".
3. **Everything else is not for the agents.** Agents stay silent, including when people talk to each other.
4. **One follow-up.** After an agent finishes, the manager may offer one other invited role a follow-up. That role answers "pass" or gives one or two sentences. There is at most one follow-up per human turn, and a follow-up never gets its own follow-up.
5. **Barge-in.** Any human speech while an agent is talking stops that role's playback at once and drops the rest of the answer. The floor returns to the humans.
6. **Standup order.** With `--standup`, the order is PM, Tech Lead, Frontend, Backend, Infra, QA, Code Reviewer, Security Reviewer, Coach, keeping only the invited roles. Each update is held to about 30 seconds (an output token cap). A human interrupting pauses the order, and "go on" or "next" resumes it.
7. **Leaving.** These end the call:
   - "Anton, that's all" or "agents, drop off";
   - "end the call" in Slack, or the End call button;
   - 10 minutes with no human speech;
   - hitting a cap;
   - the Slack service stopping.

   On any exit, anton tells Recall to remove every bot, then closes the tunnel. Recall's automatic leave is the backstop when anton can't clean up.

**Persona answer.** One bounded Claude call per agent turn, with no tools. It reuses how Slack Q&A reads the asked project's redacted, bounded records (`src/slack/chat.ts`). Like Slack, the records and the transcript are untrusted data in fenced blocks.

- **Shared core, not a copy** *(my call)*: the builder moves the record reading, redaction, fencing and the single bounded Claude call out of `chat.ts` into a transport-free module that both Slack and calls use. Slack keeps its exact behaviour, and its existing tests must pass unchanged.
- **Each role sees its own slice of the records** *(my call)*, so updates don't sound the same:

  | Role | What it reads first |
  |---|---|
  | PM | spec, stage, budget, open Checkpoint |
  | Tech Lead | plan, build progress, round count |
  | Frontend, Backend, Infra | their own tasks in the plan and their handoffs |
  | QA | verify evidence and failure report |
  | Code Reviewer, Security Reviewer | their latest review findings |
  | Coach | lessons and the latest Retro |

  A role can still read the shared status for context. Where a role has nothing in its slice, its update is one sentence ("Nothing from QA yet; verify hasn't run").
- **What's asked:** in a standup, the question is "Give your standup update: what moved since the last checkpoint, what's next, anything blocked". Otherwise it's the human turn that addressed the role.
- **No current job:** when the project has none, or its job is done, the agents speak from the last job's delivery and Retro. They say plainly that nothing is in flight.
- **Prompt:** a new stable system prompt, `src/stages/prompts/call-persona.md`, holds the same rules as `slack-chat.md` adapted for speech: short spoken sentences, no lists or code, and a single sentence when the records don't say.
- **Varying context:** the role, the recent transcript (the last 2 minutes or about 1.5k tokens) and the records go in the user prompt.
- **Models:** Haiku 5.5 by default. Sonnet 5.5 only when the turn is an evidence question, using the same classifier as Slack (`classifyQuestion`).
- **Status questions:** answered from the free status rows, spoken as a sentence, with no model call.
- **Streaming:** the answer streams sentence by sentence into TTS and on to that role's bot, so speech starts before the answer is complete.

**Voices.** Each role maps to a voice ID in config. Defaults are chosen at build time from the TTS provider's stock voices.

**Who is speaking.** The listener page hears mixed call audio, so anton treats every human the same and labels human turns "Participant". Agents cannot take actions, so they don't need to know who is talking.

**Not hearing themselves** *(correction made while planning)*:
- **Every page streams up.** Every bot page sends the call audio it hears. anton forwards only one page's audio to STT: the page of the agent that is speaking right now, or the first connected page when nobody is.
- **Why that works:** a meeting does not play a participant's own voice back to them, and only one agent speaks at a time. The audio STT gets therefore never holds an agent's voice, yet human speech during an agent's answer is still heard, so barge-in works.
- **Spike check:** the spike must confirm that a Recall bot does not hear its own output.

### 5.4 Money

The defaults live in `~/anton/config.yaml` under a new `call` key:

```yaml
call:
  perCallUsd: 3        # the call ends here
  perTurnUsd: 0.10     # the most one agent turn may cost
  monthlyUsd: 30       # separate from build budgets and the Slack chat pool
  recallRegion: us-west-2
  voices: { pm: <voice id>, qa: <voice id> }   # optional overrides
```

- **What's counted:**
  - Recall by bot-seconds, at $0.50 an hour plus $0.10 for the 4-core variant, for each bot;
  - STT by the minute;
  - TTS by the characters sent;
  - Claude by reported usage. Like Slack chat, each Claude call reserves its upper bound before it is sent.
- **Where the prices live:** in code beside the existing `PRICES`, as a "checked on" constant.
- **Per turn** *(my call)*: each Claude turn is capped by `call.perTurnUsd`.
  - If a Sonnet evidence turn can't fit under what's left, it drops to Haiku.
  - If even Haiku can't fit, the agent gives the free status sentence, or stays quiet.
  - The Haiku routing call counts against the same meter.
- **The monthly pool:** it uses a ledger like `chat-budget.ts`, stored at `~/anton/call-budget.json`. A call reserves `perCallUsd` when it starts and settles to the real figure when it ends. A crash keeps the full reservation, the same rule as chat.
- **A low pool** *(my call)*: if the pool has less than `perCallUsd` left but at least $0.50, the call starts with a lower cap and the terminal says so. Below $0.50 it refuses to start, with the amount left and the config key to change.
- **Hitting a cap:** the PM says once that the team is leaving to stay within budget. Then every bot is removed and the process ends.
- **Expected spend:** the bot fee grows with the number of agents and the length of the call.

  | Call | Estimate |
  |---|---|
  | 15-minute standup, 3 agents | about $0.85–$1.00 |
  | 15-minute standup, 5 agents | about $1.15–$1.30 |
  | 30-minute ad-hoc call, 3 agents | about $1.40–$1.70 |
  | A standup every weekday with 3 agents, plus two ad-hoc calls a week | about $30–$35 a month |

  The monthly default of $30 sits at the low end of that last row, so the Owner may want to raise it. Recall gives 5 free bot-hours for testing.

**Spend and settings (spec 2):**
- **Spend log:** every call cost (Recall, Deepgram, ElevenLabs and Claude) is written to spec 2's spend log with `source: call`. The dashboard and spend questions include calls.
- **Caps:** the `call` caps can be changed in plain English, like any other cap.
- **Overall cap:** when spec 2's overall monthly cap is reached, calls refuse to start.

### 5.5 Privacy and what is kept

- **Notice:** each bot's name ends in "(Anton AI)", and the PM's introduction tells people they are talking with AI and that their speech goes to outside services.
- **What leaves the Mac:**
  - Recall's bots see and hear the meeting, the way any participant does.
  - Call audio goes through the tunnel to the Mac, then to Deepgram.
  - Agent text goes to ElevenLabs and Anthropic.
- **What is kept:** anton keeps no audio and no transcript after the call. Recall bots are created with no recording and retention set to none. anton writes one summary line per call to `~/anton/calls.log`: date, project, invited roles, minutes, turns and cost.
- **Retention:** the README links each provider's retention settings. Enabling zero-retention options at Deepgram and ElevenLabs is left to the Owner, because some need a paid plan.

### 5.6 The Slack experience

```
You:  bring PM, QA and tech lead into https://meet.google.com/abc-defg-hij for a standup on todo-app
PM:   Start a call? PM, QA, Tech Lead · todo-app · standup · Meet abc-defg-hij · cap $3
      [ Start call ]  [ Cancel ]
      ↳ Joining. 3 agents are waiting to be let in. Admit them from the meeting.
      ↳ Everyone's in. Starting the standup.
      ↳ (card, updated live) 6 min · $0.38 · QA is speaking · [ End call ]
You (in the thread):  add the security reviewer
PM:   Add Security Reviewer to the call? [ Add ] [ Cancel ]
You (in the thread):  end the call
PM:   Call ended · 14 min · $0.91 · 23 turns
```

- **Intents added to spec 1's registry:**
  - `start_call` (link, project, roles, standup);
  - `add_to_call` (role);
  - `remove_from_call` (role);
  - `end_call`;
  - `call_setup`.

  Starting a call, adding an agent and removing one each show a confirm card. Ending a call acts at once, without a card, because it only stops spending. This is the one exception to "confirm every change". *(My call.)*
- **Who may do what:** only the Owner may start or change a call. Anyone in the channel can see the card.
- **Missing details** are asked back: "Which project?", "Which agents should join?", "Paste the meeting link".
- **The live card** is updated at most every 15 seconds (Slack rate limits). It shows the elapsed time, the cost so far, who is speaking, and who is still waiting to be admitted.
- **A second call** while one is running is refused, with a link to the running call's card.

### 5.7 Builder-check answers (my calls)

- **Call intents and the registry:**
  - a registry entry may return a call operation instead of a job `Operation`, and a small call controller in `anton serve` carries it out;
  - a call card is bound to the call's ID and state. Confirming after that call has ended replies "That call has ended. Nothing was changed.";
  - replies in the call card's thread go to the router with the call's context, through spec 1's thread registry.
- **Restarts and crashes:**
  - the active call is saved to `~/anton/call.json` (bot IDs, card timestamp, start time, spend so far), written atomically and updated every minute;
  - when the service stops, anton removes the bots and closes the tunnel, within the existing settle time;
  - when the service starts and finds a leftover `call.json`, it removes any orphan bots, settles the budget with the last saved spend, writes the vendor lines to the spend log, and updates the card to "Call ended (the Slack service restarted)". Recall's automatic leave stays the last backstop.
- **The uninvited PM bot:**
  - it counts toward "everyone's in" and the admission message;
  - its fee is metered;
  - the start card says "PM joins briefly to introduce the team".
- **Agents added mid-call** say one line on joining: "Hi, I'm <label> from the Anton team, an AI agent." People who join later see "(Anton AI)" in every bot's name.
- **Keychain under the service:** the new items are read the same way as the Anthropic key already is (`/usr/bin/security`, as the same user). "set up calls" test-reads each one. It says so if `cloudflared` is missing from the service's PATH, with the one-time fix: rerun `anton slack service install`.
- **Money:**
  - the call pool's up-front reservation is separate from spec 2's overall cap;
  - a call starts only if the overall cap has at least $0.50 left, and its cap is the smaller of the call cap and what's left overall;
  - router calls always bill to the chat pool;
  - vendor spend reaches the spend log when the call ends, or on crash recovery from the last minute saved.
- **A project is required.** It defaults to the channel's project, or to the only project if there is just one. Otherwise the PM asks.
- **Who hears project records (Owner's decision, 2026-11-27):** a call is not gated by channel membership. Everyone on the call hears what the agents say. Instead, the start card always carries this warning: "The agents will discuss <project>'s records (status, spec, test results) out loud to everyone on this call." The Owner decides by who they invite. Secrets are still redacted from everything the agents read.

## 6. What's left to the builder

- **The Recall API:** creating a bot with webpage output media, the automatic-leave settings, removing a bot, and region URLs.
- **Page and socket:** the page's audio format both ways (sample rate and chunking), and the WebSocket message shapes.
- **Provider protocols:** the Deepgram Flux and ElevenLabs streaming protocols, and reconnecting after a dropped socket. Speech must stop cleanly rather than garble.
- **The tunnel:** starting `cloudflared` and reading its URL. If the tunnel drops mid-call, anton ends the call and removes the bots. A quick tunnel can't come back at the same URL, so a restart can't help. *(Correction made while planning.)*
- **Name matching:** the exact aliases, how much fuzziness is allowed (STT will mishear "QA"), and the exact copy for the cap and leaving lines.
- **Routing call:** the prompt and thresholds for the Haiku call that handles turns addressed to the group.
- **Default voices:** one distinct stock voice per role.
- **Module layout:** a suggestion is `src/call/` with recall, tunnel, server, page, stt, tts, floor, persona and budget modules, plus the call intents and live card under `src/slack/`. There is no CLI command for calls.
- **Tests:**
  - floor-manager unit tests from scripted transcripts, covering addressing, group routing, the follow-up cap, barge-in, ignoring the agents' own voices, standup order and leaving;
  - server tests: a wrong or missing token gets 404, a second socket for a role is refused, and the server binds to 127.0.0.1 only;
  - budget ledger tests;
  - a gated live test (`ANTON_E2E_CALL=1`) that creates two real bots in a test meeting, has each say one line, and removes them. It costs cents;
  - a manual test call on Meet and on Zoom before shipping.

## 7. Risks and open questions

- **Spike first:** before the full build, a throwaway test should put 2 Recall bots, each playing its own voice from our page through a quick tunnel, into one Meet call and one Zoom call. It answers the first four risks below.
- **Latency:** the aim is under 1.5 s from someone finishing to an agent starting to speak. Recall and the tunnel add hops, and none of this is measured yet.
- **Bots per meeting:** Recall doesn't document a limit. Several bots from one account in one meeting is unverified.
- **Quick tunnel reliability:** Cloudflare offers quick tunnels for testing, with no uptime promise. The named tunnel or the relay is the upgrade.
- **Zoom's own-account exemption** from OBF is Recall's reading, not verified with Zoom.
- **Admission:** each bot needs admitting, and Meet on a personal Gmail account may never let them in automatically. This is unverified.
- **Mishearing names:** STT may miss role names. This affects how often agents answer when they shouldn't, or stay quiet when they should.
- **Vendor and platform risk:** Recall's prices or Zoom's and Google's bot rules could change. Approach A2 is the fallback.
