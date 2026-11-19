# Son of Anton: Build Roadmap

**Spec:** `docs/specs/2026-11-19-son-of-anton-design.md` (approved 2026-11-19)

The spec covers six subsystems. Each phase below gets its own plan and leaves working, tested software behind. Phases run in order, because each builds on the interfaces of the one before.

| Phase | Delivers | Spec sections | After this phase you can… |
|---|---|---|---|
| **1. Core engine** | CLI, job/state store, Docker runner, agent runner, Spec → Plan → Build → Verify → Deliver with the fallback kit, both checkpoints, budget cap, resume, background runs, notifications | §5, §6.1–6.6, §7, §7.1 (code does mechanical work, fresh contexts, output trimming, early stop, budget cap + 80% warning), §8 (interface + fallback), §9 | `anton new "a CLI that…"` and get a verified repo plus `REPORT.md` |
| **2. The team and reviewers** | Role agents (PM, tech lead, frontend/backend/infra devs, QA), task tagging and the contract between pieces, handoff notes, code reviewer, security reviewer with scanners, accept-risk, per-role model/effort table | §6.3, §6.4, §6.4.1, §7.1 model table, §11.1 | Get reviewed, security-scanned builds from a role-split team |
| **3. Kits and existing code** | Web kit (Playwright, screenshots), `adopt`/`change`, jobs folder per change, regression baseline, branches, repo map, outside services with stand-ins, secrets with redaction | §6.0, §8 (web kit), §9.1, §7.1 repo map | Build web apps; change existing repos safely; use real secrets |
| **4. Plugins and cost controls** | Marketplace plugins per stage and role, `plugins.lock`, the unattended-stage rule and ask-the-user guard, MCP servers only in the stages that use them, prompt caching layout and cache tracking, stage allowances, cost estimate at checkpoint 1, task budgets, security review of plugin updates | §10.1, §7.1 (caching, allowances, estimates), §6.4.1 (plugin updates) | Use marketplace skills safely at a predictable cost |
| **5. Learning loop** | Retro (batch), lesson proposals and `lessons review`, per-role lessons mounted per stage, scoreboard, bench (including a change job) | §6.7, §10.2 | Watch the factory improve, with your approval |
| **6. Slack** | `anton serve` (launchd, Socket Mode), `anton slack setup` (9 apps from manifests, channels), job threads, milestone posts, approval buttons and boxes, @mention Q&A, chat budget, owner-only orders, redaction | §11.2–11.5 | Run your dev team from Slack |

Each phase's plan is written when the previous phase is done, so it builds on the real interfaces, not guessed ones.
