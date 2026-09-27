# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 6 is complete; CHECKPOINT 6 is waiting on Scott's go for Phase 7.** Phases 0 to 5 done.

An unattended run now has everything up to recovery: the Stop gate (checks, browser tester,
phase-end bug bash, security reviewer), the guard rules, the decider and `answer`, `pause` /
`note` / `resume`, the weekly usage pause, `autoclaude run` (preflight, then the `ac-<slug>`
window running the supervisor), the supervisor's relaunch rules, `autoclaude nudge`, the Task
Scheduler watchdog (installed on this VM), and plan-complete and morning summaries on Discord.

`node scripts/check.js`: 204 tests pass. Remote in sync. The chaos run's evidence is in
`spikes/out/chaos-events.log` and `spikes/out/todo-live/.autoclaude/logs/` (the run is complete;
its window `ac-todo-live` may still be open with an idle session, which is fine to close).

## Blind rehearsal rule (D37)

**Do not open or inspect Scott's DB project, and do not tailor AutoClaude to it.** In Phase 7 Scott
gives a Claude session in that project only the autoclaude repo URL; that Claude works everything
out from `README.md` and `docs/USAGE.md`. The only preparation here: remove the local-directory
plugin install first so the plugin comes from GitHub.

## The exact next step

**Phase 7, planner, docs and the rehearsal** (`PLAN.md` P7.1 to P7.4), after Scott's go:

1. P7.1 `/autoclaude:plan` skill: interview, settle every decision up front (R17), write
   `PLAN.md` from the template, lint it; for an existing project, review its plan and rules
   first (plan location, conflicting rules, `guard.deny`, check commands that really run).
2. P7.2 `README.md` and `docs/USAGE.md` for someone who has never seen this repo. Include what the
   chaos run taught: start `autoclaude run` from a fresh terminal (the window inherits PATH, and
   needs node and git), `nudge` for a one-off prompt, what each pause reason means and how to
   resume, RDP disconnect versus log-off.
3. P7.3 the blind overnight rehearsal on the DB repo (uninstall the local plugin first).
4. P7.4 release: version 1.0.0, tag, CHANGELOG, LICENSE if Scott picks one.

## Notes for whoever continues

- The CLI runs the plugin in place; edits apply immediately. Do not edit `lib/gate.js`, the hook
  scripts or the prompts while a live run is in progress on this machine.
- The VS Code tool shells lack node on PATH (PowerShell lacks git too). Prepend
  `C:\Program Files\nodejs` for commands, and never start a live run from them without git.
- The Bash tool collapses doubled backslashes: write code with escapes through the Edit tool.
- `spikes/out/todo-live` is the trusted scratch project for live runs (`spikes/lib/prep-chaos.mjs`
  and `test/fixtures/prepare.js` rebuild it). The registry still lists `todo-demo`; its run was
  cleared and the watchdog ignores it.
- The watchdog task "AutoClaude watchdog" runs every 5 minutes on this VM; it only acts on
  registered projects whose state is running.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
