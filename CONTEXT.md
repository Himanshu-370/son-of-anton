# Son of Anton

A local software factory: an owner describes a project, and a team of AI roles specs, plans, builds, verifies and delivers it as a Job.

## Language

**Owner**:
The person who runs anton and decides what happens to each Job, from the CLI or from Slack.
_Avoid_: user, operator

**Owner action**:
A decision the Owner makes on a Job: approve, reject, resume, abandon, accept a risk, request spec changes, or stop. It is made against the Job and Checkpoint the Owner saw, and only one is decided at a time per project.
_Avoid_: job action, decision, command

**Checkpoint**:
A point where a Job waits for the Owner: spec approval, a pause, or final review. Each occurrence has its own revision, so an Owner action aimed at an earlier one is stale.
_Avoid_: gate, review point

**Stale**:
An Owner action whose Job, stage or Checkpoint revision has moved on since the Owner saw it. A stale Owner action changes nothing.
_Avoid_: outdated, expired

**Intent**:
What the Owner means by a plain-English Slack message, as worked out by the router: for example, approve, start a change, raise a budget, or start a call. An Intent that changes something becomes a Confirm card, never an action by itself.
_Avoid_: command, verb

**Confirm card**:
A Slack card that says exactly what an Intent will do and waits for the Owner's tap. It is bound to the Job and Checkpoint (or the call) it was built from, so it goes Stale like any other Owner action.
_Avoid_: prompt, approval

**Spend log**:
The host-written record of every paid call (builds, Slack answers, the router, calls), attributed to project, job, stage, role and model. It is the source for insights and for the overall monthly cap.
_Avoid_: usage, billing

**Preset**:
A named choice of model and effort for every role at once: economy, balanced or best. Per-role overrides sit on top of it.
_Avoid_: profile, tier

**Trial**:
A temporary model setting for one role that reverts by itself after a set number of finished jobs, so the Owner can compare cost and quality.
_Avoid_: experiment, test

**Call**:
A Zoom or Meet meeting that the Owner brings chosen role agents into. Each agent appears as its own participant and answers from the project's records.
_Avoid_: meeting bot, huddle
