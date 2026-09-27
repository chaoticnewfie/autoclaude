# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 5 is complete; CHECKPOINT 5 is waiting on Scott's go for Phase 6.** Phases 0 to 4 done.

What an unattended run has now: the Stop gate (checks, browser tester, phase-end bug bash,
security reviewer), permission prompts auto-denied with guidance, the built-in and per-project
(`guard.deny`) deny rules, questions settled by the decider or escalated with `autoclaude blocked`,
`autoclaude answer` (or an answer typed into the run window), `pause` / `note` / `resume` with
`review.pauseAt`, the weekly usage pause, and Discord messages for the events in PLAN.md 4.6.

`node scripts/check.js`: 161 tests pass. Remote in sync. Live evidence of the last runs is in
`spikes/out/todo-live` (paused after S1.2 of the happy plan) and `spikes/out/security-live`.

## Blind rehearsal rule (D37)

**Do not open or inspect Scott's DB project, and do not tailor AutoClaude to it.** In Phase 7 Scott
gives a Claude session in that project only the autoclaude repo URL; that Claude works everything
out from `README.md` and `docs/USAGE.md`. The only preparation here: remove the local-directory
plugin install first so the plugin comes from GitHub.

## The exact next step

**Phase 6, recovery, supervisor and notifications** (`PLAN.md` P6.1 to P6.6):

1. P6.1 `Notification` hook: while running, `idle_prompt`, `permission_prompt`, `agent_needs_input`
   send one high-priority message per 30 minutes and touch `.autoclaude/idle` for the supervisor.
2. P6.2 `StopFailure` hook: `rate_limit` only logged; other errors to `.autoclaude/failure.json`.
3. P6.3 `autoclaude run`: open the `ac-<slug>` window (`lib/proc.js` `openConsoleWindow`, proven in
   P0.8 and all live runs so far via `spikes/p08-supervisor/supervise.mjs`) running
   `autoclaude supervise`, which spawns `claude --permission-mode auto "/autoclaude:start"`;
   `/autoclaude:start` runs the preflight (clean tree, config, lint, checks runnable, dev server,
   Playwright, usage, notify channel, onboarding and trust read-only per D28, native claude, node).
4. P6.4 the supervisor loop (heartbeat, idle marker, failure.json, `claude agents --json`, usage
   reset times; relaunch `claude --continue --permission-mode auto "/autoclaude:resume"`; 2
   relaunches with no progress pause as stuck) and `autoclaude watchdog --install` (Task Scheduler
   entry every 5 minutes that relaunches a dead supervisor). The supervisor also has to relaunch
   the builder after `answer` or `resume` while the window sits idle; today I did that by hand.
5. P6.5 summaries (plan complete, optional morning summary).
6. P6.6 chaos tests, live on the fixture: kill claude, kill the supervisor, forced `/compact`,
   a stalled hook, a crashed dev server, an RDP disconnect.

## Notes for whoever continues

- The CLI runs the plugin in place; edits apply immediately. Do not edit `lib/gate.js`, the hook
  scripts or the prompts while a live run is in progress on this machine.
- Restart VS Code fully after installs; its integrated terminal keeps a stale PATH.
- A scratch project that is its own git repository needs its own workspace trust (D28);
  `spikes/out/todo-live` is trusted, so reuse that path for live runs (`test/fixtures/prepare.js`).
- Live runs so far used the interim launcher: `spikes/lib/open-window.mjs` +
  `spikes/p08-supervisor/supervise.mjs` with `AC_SPIKE_CWD`. Phase 6 replaces it.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
