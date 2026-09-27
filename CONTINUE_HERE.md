# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 4 is complete; CHECKPOINT 4 is waiting on Scott's go for Phase 5.** Phases 0 to 3 done.

What a verification does now, in order: restart the dev server the gate started; run the
configured checks; for a step not tagged `no-ui`, run the browser tester (headless `claude -p`,
Sonnet, Playwright MCP) against the step's Accept lines; at a phase's last step, run the bug bash
over every feature of the phase. Real failures count as attempts; a checker that cannot run never
does (pause on the second time); medium and low findings go to `docs/BLOCKERS.md`.

Evidence: `test/live/ui-bug.live.mjs` (run with `npm run test:live`, uses real quota, about five
minutes). Last live run: `spikes/out/ui-bug-live`, reports and screenshots under its
`.autoclaude/reports/`. `node scripts/check.js`: 131 tests pass. Remote in sync.

## The exact next step

**Phase 5, guardrails for unattended runs** (`PLAN.md` P5.1 to P5.6):

1. P5.1 questions: `agents/decider.md` returning `{recommendation, reasoning, classification}`;
   the AskUserQuestion deny already exists in `scripts/tool-guard.js`.
2. P5.2 blocker round trip: `autoclaude answer "<text>"` and `/autoclaude:answer` record the answer
   in `docs/DECISIONS.md`, resume, and the answer reaches Claude through the context injection.
   The gate already pauses on `blocked` and stores `lastBlockedQuestion` in state.
3. P5.3 PermissionRequest auto-deny hook (removes the prompt Scott accepted in CHECKPOINT 3; the
   exact output shape is in `spikes/p08-supervisor/permission-deny.js`), denial rate notification,
   and the new per-project `guard.deny` list (config key, validation, tool-guard check, tests with
   the DB rehearsal's Proxmox rules; D36).
4. P5.4 security reviewer: reuse `lib/headless.js` with read-only tools and no MCP, over
   `git diff <last ac tag>..HEAD` plus the uncommitted step diff; high fails, others to
   `docs/SECURITY-FINDINGS.md`; a fixture step with an obvious flaw.
5. P5.5 usage gate tests with a fake `usage.json` (the pause itself is already in `lib/gate.js`).
6. P5.6 pause for review: `pause`, `note`, `resume` exist; add the scenario tests and the D33
   re-baseline on resume after an owner unticks a step.

## Changed 2026-09-27: the Phase 7 rehearsal runs on Scott's DB project (D36)

Onboarded from the repo link in a session in `C:\Database`, local work only, sized by the work.
Before it, with Scott: install WSL2 and Docker Engine on this VM, and remove the local-directory
plugin install so it comes from GitHub. Details in `PLAN.md` P7.3 and `docs/DECISIONS.md` D36.

## Notes for whoever continues

- The CLI runs the plugin in place; edits apply immediately. Do not edit `lib/gate.js`,
  `lib/tester.js` or the hook scripts while a live run is in progress on this machine.
- Restart VS Code fully after installs; its integrated terminal keeps a stale PATH.
- A scratch project that is its own git repository needs its own workspace trust (D28); the live
  tester scenario does not need trust because it drives the gate directly, not a session.
- Scratch folders under `spikes/out/` (`todo-demo`, `todo-live`, `ui-bug-live`) are disposable.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
