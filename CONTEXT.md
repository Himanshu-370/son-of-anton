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
