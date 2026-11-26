# Can the anton role agents join a Zoom or Google Meet call and talk?

Research date: 2026-11-26. This is a research note only; nothing has been built or tested. Claims marked **[unverified]** could not be confirmed from a primary source.

## Bottom line

- **It is feasible, but not through Zoom's or Google's own APIs.** Neither platform currently offers an official, generally available way for a bot to *speak* into a meeting. Google is shutting down its Meet Media API (receive-only anyway) on 2027-01-15. Zoom's realtime API (RTMS) is receive-only, and Zoom's Meeting SDK docs say it "does not support bots or AI notetakers".
- **The practical route is a meeting-bot vendor, mainly Recall.ai.** One Recall bot joins Zoom or Meet, hears the call, and plays audio from a webpage you control. That one bot can voice all nine personas, each with its own TTS voice. Recall lists LiveKit and Pipecat as direct integrations.
- **The voice pipeline is standard:** streaming speech-to-text (for example Deepgram Flux), then Claude (Haiku 5.5 for most turns), then streaming text-to-speech (for example ElevenLabs Flash or Deepgram Aura-2). Anthropic has no speech or realtime API: current Claude models take text and images and return text only.
- **Rough cost:** about **$0.50 to $1.20 for a 15-minute standup** through Recall (about $0.04 to $0.08 a minute). TTS and the bot fee are the biggest items; Claude Haiku tokens cost cents.
- **Better value first:** a **browser "standup room"** served by `anton serve` (you talk to the personas in a local web page) gives about 80% of the experience for about half the cost, with no platform-policy risk. A cheaper step still is an **async audio standup**: an MP3 posted to Slack each morning, for roughly $0.10 to $0.20.
- **Slack huddles are not an option.** No Slack API lets an app join a huddle or carry huddle audio.
- **Biggest risks:** (1) platform rules: Zoom is pushing bots toward RTMS and since 2026-03-02 requires OBF/ZAK authorization for apps joining meetings outside their own account; Google's terms leave headless-browser joiners in a grey area. (2) Turn-taking: no vendor documents a pattern for several AI speakers in one call, so you would design it yourself. (3) Network shape: Recall's bot loads a public webpage and sends to public endpoints, but anton runs on a Mac behind NAT, so it needs a tunnel or a small hosted relay.

## Options compared

| Approach | Can listen | Can speak | Multiple personas | Setup effort | Cost (15-min standup) | Platform-policy risk | Maturity |
|---|---|---|---|---|---|---|---|
| Google Meet Media API | Yes (audio/video) | No | n/a | High (preview enrollment for every participant) | Free | **Being shut down 2027-01-15** | Dead end |
| Google Meet add-on | Not documented | Not documented | n/a | Medium | Free | Low | GA, but the wrong tool (side-panel UI) |
| Zoom RTMS | Yes (audio, video, transcript) | **No** (receive-only) | n/a | Medium | Credits **[pricing unverified]** | Low (sanctioned path) | GA |
| Zoom Meeting SDK (Linux) bot, self-built | Yes (raw audio) | Yes, technically | Yes | Very high (C++, Linux, OBF tokens) | Server costs | **High**: docs say "does not support bots" | Works, but against current docs |
| Headless-Chrome Meet bot, self-built (e.g. Attendee, Vexa) | Yes | Yes (Attendee docs claim bot audio output) **[unverified for Zoom]** | Yes | High | Server costs | Medium (grey area under Google ToS) | Community / open source |
| **Recall.ai bot + Output Media page** | Yes | **Yes** (Zoom, Meet, Teams, Webex) | Yes (one bot, many voices) | Medium | ~$0.50 to $1.20 | Medium (vendor carries the platform integration) | Production vendor |
| **Browser standup room (local WebRTC)** | Yes | Yes | Yes | Low to medium | ~$0.35 to $1.00 | None | You build it |
| **Async MP3 standup to Slack** | No (one-way) | Yes (recording) | Yes | Low | ~$0.10 to $0.20 | None | Easy |
| Slack huddle bot | No | No | n/a | n/a | n/a | Not possible: no API | n/a |

## Recommended approach

Build in three steps. Each step is useful on its own, and each reuses the one before.

1. **Async audio standup (days).** At standup time, `anton serve` asks each role (Haiku 5.5, within the existing chat budget) for a 2 to 3 sentence update from job state, renders each line with that role's voice, joins the clips into one MP3, and uploads it to the Slack channel. No realtime work is needed.
2. **Browser standup room (a week or two).** `anton serve` serves `http://localhost:<port>/standup`. The page sends your microphone over a WebSocket to the host, which streams STT, runs a turn manager, calls Claude, and streams TTS audio back. Everything stays on the Mac and nothing is exposed publicly.
3. **Zoom/Meet via Recall.ai (optional, later).** Swap the browser page for a Recall Output Media page. The same host-side brain is reused, and only the audio transport changes.

```
                 +-------------------- anton serve (LaunchAgent, host Node) -------------------+
 mic / meeting   |  audio-in  ->  STT stream (Deepgram Flux: end-of-turn events)               |
 audio --------->|                 |                                                           |
                 |                 v                                                           |
                 |  Turn manager ("floor"): who speaks next? owner addressed a role by name?   |
                 |    - one speaker at a time; queue of raised hands; owner always wins         |
                 |    - barge-in: owner speech -> stop TTS, drop queued lines                   |
                 |                 |                                                           |
                 |                 v                                                           |
                 |  Persona brain: existing role prompts + job state (src/slack/chat.ts style)  |
                 |    Haiku 5.5 for updates/replies, Sonnet 5.5 only for "show evidence" asks   |
                 |    chat-budget.ts caps per standup                                          |
                 |                 |                                                           |
                 |                 v                                                           |
                 |  TTS stream (voice_id per role) -> audio-out                                 |
                 +-------------------------------------|---------------------------------------+
                                                       v
         Step 2: local browser page (WebSocket)   or   Step 3: Recall Output Media page
                                                       (needs tunnel / small relay: bot is in Recall's cloud)
         Step 1 (async): same brain + TTS -> MP3 -> Slack upload
```

Design choice: use **one bot (one audio stream) that voices all personas**, not nine bots. One bot means one meeting tile, one Recall fee, and natural floor control, because only one voice can play at a time. Distinct voices come from passing a different `voice_id` per role to the TTS call ([ElevenLabs API](https://elevenlabs.io/docs/api-reference/text-to-speech/stream)). The cost is that participants see a single "Anton team" tile rather than nine. Showing the current speaker's name and avatar on the bot's camera is supported through Recall's webpage video output ([Recall Meeting Agents](https://docs.recall.ai/docs/meeting-agents-overview.md)).

## Detailed findings

### 1. Google Meet

- **Meet REST API (GA):** It manages meeting spaces, members, artifacts (recordings, transcripts, smart notes) and events. It cannot join or send audio. Since 2026-04-16 the `phoneAccess` (dial-in numbers and PIN) and `gatewaySipAccess` (SIP URI for third-party video hardware) fields are GA ([release notes](https://developers.google.com/workspace/meet/release-notes?hl=en), [spaces reference](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces)). In principle, a bot could therefore dial in by phone or SIP and speak as a phone participant. **[unverified: not tested; whether SIP gateway access needs a Google interop partner was not checked]**
- **Meet Media API:** This is the only official way to receive live Meet audio and video. It was Developer Preview only, and the Cloud project, the OAuth principal *and all participants* had to be enrolled ([overview](https://developers.google.com/meet/media-api/guides/overview)). The docs describe consuming streams only, with no sending. On 2026-10-28 Google announced it will "permanently turn down its endpoints on January 15, 2027". The REST API and add-ons SDK are unaffected ([release notes](https://developers.google.com/workspace/meet/release-notes?hl=en)).
- **Meet add-ons SDK (GA):** Add-ons provide side-panel and main-stage web UI and co-doing. The overview says nothing about access to meeting audio ([add-ons overview](https://developers.google.com/workspace/meet/add-ons/guides/overview)).
- **Automated participants:** Google's only bot API, "Bots on Demand", is limited to allowlisted vendors and runs bots that "play looping video" for performance testing ([Bots on Demand](https://developers.google.com/bots-on-demand)).
- **What people do instead:** They run headless Chrome joiners. Attendee's Meet bots drive Chrome with Selenium and join as guests ([Attendee Meet docs](https://mintlify.com/attendee-labs/attendee/platforms/google-meet)). Recall's bots join anonymously or signed in, must be admitted unless invited, and can be blocked by host or admin settings ([Recall Meet FAQ](https://docs.recall.ai/docs/google-meet-faq)).
- **Terms:** Google's Terms of Service forbid abusing or disrupting services, "bypassing our systems or protective measures", and "using automated means to access content … in violation of the machine-readable instructions" ([Google ToS](https://policies.google.com/terms?hl=en-US)). No Google text explicitly permits or bans browser bots in meetings you host. **[unverified: Workspace-specific acceptable-use terms not reviewed]**

### 2. Zoom

- **Meeting SDK:** The SDK offers raw audio and video access on native platforms ([Meeting SDK](https://developers.zoom.us/docs/meeting-sdk/)). However, the Linux SDK page now states it "is designed for human use cases and does not support bots or AI notetakers" and points to RTMS instead ([Linux SDK](https://developers.zoom.us/docs/meeting-sdk/linux/)). It also says QEMU/Rosetta emulation is unsupported, so a Linux bot would not run reliably in Docker on an Apple Silicon Mac. Beginning 2026-03-02, apps joining meetings outside their own account must use OBF or ZAK tokens, or RTMS (announcement quoted in [Zoom dev forum](https://devforum.zoom.us/t/question-on-linux-sdk-usage-policy/141545); auth page lists "Joining external meetings as a bot (OBF)" ([Zoom auth](https://developers.zoom.us/docs/meeting-sdk/auth/))). Meetings on the owner's *own* account appear exempt from OBF, per Recall's reading ([Recall blog](https://www.recall.ai/blog/zoom-obf)).
- **RTMS:** RTMS gives "live audio, video, and transcript data from Zoom meetings" over WebSockets and needs account credits ([RTMS](https://developers.zoom.us/docs/rtms/)). It is **receive-only**: Zoom staff say sending media "is not supported at the moment", and suggest the Linux Meeting SDK for playback ([Zoom forum](https://devforum.zoom.us/t/extract-meeting-audio-from-zoom-meeting-and-play-processed-audio-back-into-the-meeting/137943)). **[RTMS credit prices and plan needs: Zoom's pricing page could not be fetched, so these are unverified]**
- **Zoom Apps:** Not researched in depth. These are in-client web apps and do not carry audio output. **[unverified]**
- **Publishing:** Whether an unpublished, account-internal app can do all of this without Marketplace review was **[unverified]**. Internal-account meetings avoid the OBF rule.

### 3. Meeting-bot platforms

- **Recall.ai:** Bots can speak in Zoom, Meet, Teams and Webex. There are two ways to do it:
  - Short MP3 clips through `output_audio` ([Recall output audio](https://docs.recall.ai/docs/output-audio-in-meetings)).
  - For conversations, a webpage you host that receives meeting audio via `getUserMedia()` and plays responses. Recall says the bot adds latency "in the tens of milliseconds", and `web_4_core` is the recommended variant ([Meeting Agents](https://docs.recall.ai/docs/meeting-agents-overview.md), [Meeting Agents FAQ](https://docs.recall.ai/docs/meeting-agents-faq)).
  - Per-speaker raw audio is available over WebSocket.
  - Pricing: $0.50/hr pay-as-you-go, billed to the second; +$0.10/hr for 4-core; transcription $0.15/hr; 5 free hours ([Recall pricing](https://www.recall.ai/pricing)).
  - Data: retention can be timed, forever, or zero (`null`); data is encrypted at rest and in transit and stays in region ([Recall storage](https://docs.recall.ai/docs/storage-and-playback.md)).
  - Recall is also an official Zoom RTMS reseller ([Zoom blog](https://developers.zoom.us/blog/zoom-recall-ai-partnership/)).
  - Bots per meeting: **not documented** (Meet signed-in accounts handle "roughly 50" concurrent bots each).
- **Attendee (open source, self-host):** It is a Docker/Django meeting-bot API ([GitHub](https://github.com/attendee-labs/attendee)). Its docs describe bidirectional realtime audio over WebSocket (`realtime_audio.bot_output`), but that page has since gone (HTTP 410), and the README lists audio output as roadmap. **[unverified]**
- **Vexa, Meeting BaaS:** These are other bot APIs. No primary source confirms that their bots can speak. **[unverified]**

### 4. Realtime voice stack with Claude

- **No Anthropic speech API.** "All current models support text and image input, text output" ([models overview](https://platform.claude.com/docs/en/about-claude/models/overview)). Claude's voice mode is a consumer app feature, not an API. The pipeline is therefore STT, then Claude, then TTS.
- **Claude prices** ([pricing](https://platform.claude.com/docs/en/about-claude/pricing)):
  - Haiku 5.5: $0.10 in / $0.50 out per MTok (prompts up to 100k tokens).
  - Sonnet 5.5: $2 / $10, with cache hits at $0.10.
  - Claude 4.7+ tokenizer: produces about 30% more tokens for the same text.
- **STT:**
  - Deepgram Flux streaming: $0.0065/min. It has built-in end-of-turn detection (~260 ms) and barge-in handling ([pricing](https://deepgram.com/pricing), [Flux](https://developers.deepgram.com/docs/flux/quickstart)).
  - Deepgram Nova-3: $0.0048/min.
  - ElevenLabs Scribe Realtime: $0.22/hr, ~150 ms ([ElevenLabs API pricing](https://elevenlabs.io/pricing/api)).
  - Cartesia Ink: ~$0.39/hr ([Cartesia](https://cartesia.ai/pricing)).
- **TTS:**
  - ElevenLabs Flash v2.5: $0.04 per 1k characters, "~75ms". v3: $0.08.
  - Deepgram Aura-2: $0.030 per 1k characters.
  - Cartesia Sonic: 1 credit per character; plans from $5/mo.
  - All three choose the voice per request, so nine distinct voices cost nothing extra (ElevenLabs `voice_id` in the path).
- **Frameworks:**
  - Pipecat lists Anthropic, Deepgram, ElevenLabs and Cartesia as services, and Daily, LiveKit, WebRTC, WebSocket and SIP as transports. It has no Zoom or Meet transport ([Pipecat services](https://docs.pipecat.ai/server/services/supported-services)).
  - LiveKit Agents: Apache 2.0, with **Node.js** and Python SDKs, turn detection, interruptions, and SIP telephony ([LiveKit Agents](https://docs.livekit.io/agents/)).
  - Recall integrates with both directly ([Meeting Agents](https://docs.recall.ai/docs/meeting-agents-overview.md)).
  - Pipecat's server is Python, so LiveKit's Node SDK fits anton's TypeScript better. A hand-rolled WebSocket pipeline is also small enough for step 2.

### 5. Multi-agent turn-taking

There is no primary-source pattern for *several AI speakers sharing one call*. The closest documented material:

- **LiveKit "handoffs":** One agent at a time controls the session, and a tool call transfers control to another agent with its own models ([handoffs](https://docs.livekit.io/agents/logic/agents-handoffs/), [workflows](https://docs.livekit.io/agents/logic/workflows/)). This maps naturally to "one bot, many personas".
- **Pipecat multi-agent:** Agents coordinate on a shared message bus and hand off control ([Pipecat subagents](https://docs.pipecat.ai/overview/subagents.md)).
- **Telnyx multi-participant calls:** These add a "Skip Turn" tool so an assistant stays silent when humans talk to each other ([Telnyx](https://developers.telnyx.com/docs/inference/ai-assistants/multi-participant-calls.md)).
- **Barge-in:** Deepgram Flux and LiveKit provide it for one human and one agent.

For anton, design it yourself:

- A single floor-holder.
- A standup script order (PM, tech lead, devs, QA, reviewers).
- Name-addressing ("QA, why did that fail?") routed by a cheap Haiku classifier.
- Owner speech always interrupts.
- Personas never respond to each other unprompted.

### 6. Cost estimate (15-minute standup)

**Assumptions:**

- 15 minutes of call audio transcribed.
- Personas speak about 8 minutes in total, roughly 1,200 words or about 7,000 characters.
- About 40 Claude turns, each with about 6k input tokens (persona, job state, recent transcript) and 150 output tokens.

| Item | Basis | Cost |
|---|---|---|
| STT, Deepgram Flux | 15 min × $0.0065 | $0.10 |
| TTS, ElevenLabs Flash (or Aura-2) | 7k chars × $0.04/1k (or $0.03) | $0.28 ($0.21) |
| Claude Haiku 5.5 | 240k in × $0.10/M + 6k out × $0.50/M | ~$0.03 |
| Claude Sonnet 5.5, if used for all turns | uncached ~$0.54; mostly cached ~$0.20 | $0.20 to $0.54 |
| Recall bot + 4-core | 0.25 h × $0.60 | $0.15 |
| **Total via Recall** | Haiku-only to Sonnet-heavy | **~$0.55 to $1.10** |
| **Browser room (no Recall)** | same minus bot | **~$0.40 to $0.95** |
| **Async MP3** | ~3 min script, about 2.7k chars + Haiku | **~$0.10 to $0.15** |

A weekday standup through Recall comes to roughly $12 to $25 a month. Prices come from the pricing pages linked above, checked 2026-11-26. Claude Haiku 5.5 prompts over 100k tokens cost 5× more, so keep context small.

### 7. Cheaper alternatives

- **Browser standup room:** Uses the same brain and avoids all platform policy questions. It is reachable only on the Mac (or over your LAN), which suits a single owner.
- **Async MP3 / "podcast" standup:** One-way only, but very cheap and simple. It fits the existing Slack outbox. You hear it when you like, then reply in Slack as you do today.
- **Slack huddles:** Not possible. The Slack Calls API only lets third-party call apps *display* their calls in Slack ("Slack doesn't make the call") and has nothing for huddles ([Calls API](https://docs.slack.dev/apis/web-api/using-the-calls-api)). Huddle events appear only in the Audit Logs API, which is Enterprise and records activity rather than audio ([Audit Logs actions](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference/)).
- **Phone dial-in:** A LiveKit SIP agent could dial a Meet or Zoom meeting's phone number and speak as a phone participant. This uses only official dial-in features, but depends on the meeting plan including dial-in. **[unverified; worth a spike]**

## Open questions / things to verify by spike

1. **Recall plus a Mac behind NAT.** Recall's bot loads a webpage and pushes audio to your WebSocket. Do we host the page publicly and tunnel back to `anton serve` (cloudflared/ngrok), or run a small relay? What are the security implications for a public repo (auth token on the page URL)?
2. End-to-end latency in practice: owner stops talking, then a persona starts speaking. Target under 1.5 s with Flux, Haiku and Flash.
3. Turn-manager quality: does name-addressing plus the standup order feel natural? Does barge-in cut TTS cleanly?
4. Zoom: does Recall's Zoom bot work on the owner's own-account meetings without OBF? What RTMS credit prices and plan requirements apply (unverified)?
5. Meet: will a signed-in Recall bot be admitted to the owner's personal Gmail or Workspace meetings without manual admit?
6. Phone/SIP dial-in path (Meet `phoneAccess`, Zoom dial-in) as a policy-clean speaking route.
7. Attendee's audio output status for self-hosting (docs page gone, README says roadmap).
8. Budget wiring: add a per-standup cap to `chat-budget.ts` covering STT/TTS minutes, not just tokens.

## Sources

- Google: [Meet release notes](https://developers.google.com/workspace/meet/release-notes?hl=en) · [Meet Media API overview](https://developers.google.com/meet/media-api/guides/overview) · [Meet REST spaces](https://developers.google.com/workspace/meet/api/reference/rest/v2/spaces) · [Meet add-ons overview](https://developers.google.com/workspace/meet/add-ons/guides/overview) · [Bots on Demand](https://developers.google.com/bots-on-demand) · [Google Terms of Service](https://policies.google.com/terms?hl=en-US)
- Zoom: [Meeting SDK](https://developers.zoom.us/docs/meeting-sdk/) · [Meeting SDK for Linux](https://developers.zoom.us/docs/meeting-sdk/linux/) · [Meeting SDK auth](https://developers.zoom.us/docs/meeting-sdk/auth/) · [RTMS](https://developers.zoom.us/docs/rtms/) · [Zoom–Recall partnership](https://developers.zoom.us/blog/zoom-recall-ai-partnership/) · [Forum: Linux SDK policy / OBF date](https://devforum.zoom.us/t/question-on-linux-sdk-usage-policy/141545) · [Forum: RTMS send not supported](https://devforum.zoom.us/t/extract-meeting-audio-from-zoom-meeting-and-play-processed-audio-back-into-the-meeting/137943)
- Recall.ai: [Pricing](https://www.recall.ai/pricing) · [Output audio](https://docs.recall.ai/docs/output-audio-in-meetings) · [Meeting Agents](https://docs.recall.ai/docs/meeting-agents-overview.md) · [Meeting Agents FAQ](https://docs.recall.ai/docs/meeting-agents-faq) · [Google Meet FAQ](https://docs.recall.ai/docs/google-meet-faq) · [Storage and retention](https://docs.recall.ai/docs/storage-and-playback.md) · [Zoom OBF blog](https://www.recall.ai/blog/zoom-obf)
- Open source bots: [Attendee](https://github.com/attendee-labs/attendee) · [Attendee Google Meet](https://mintlify.com/attendee-labs/attendee/platforms/google-meet)
- Anthropic: [Pricing](https://platform.claude.com/docs/en/about-claude/pricing) · [Models overview](https://platform.claude.com/docs/en/about-claude/models/overview)
- Voice: [Deepgram pricing](https://deepgram.com/pricing) · [Deepgram Flux](https://developers.deepgram.com/docs/flux/quickstart) · [ElevenLabs API pricing](https://elevenlabs.io/pricing/api) · [ElevenLabs TTS stream](https://elevenlabs.io/docs/api-reference/text-to-speech/stream) · [Cartesia pricing](https://cartesia.ai/pricing)
- Frameworks and turn-taking: [Pipecat services](https://docs.pipecat.ai/server/services/supported-services) · [Pipecat multi-agent](https://docs.pipecat.ai/overview/subagents.md) · [LiveKit Agents](https://docs.livekit.io/agents/) · [LiveKit handoffs](https://docs.livekit.io/agents/logic/agents-handoffs/) · [LiveKit workflows](https://docs.livekit.io/agents/logic/workflows/) · [Telnyx multi-participant calls](https://developers.telnyx.com/docs/inference/ai-assistants/multi-participant-calls.md)
- Slack: [Calls API](https://docs.slack.dev/apis/web-api/using-the-calls-api) · [Audit Logs actions](https://docs.slack.dev/reference/audit-logs-api/methods-actions-reference/)
