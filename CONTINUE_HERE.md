# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 3 is complete and CHECKPOINT 3 is met; waiting on Scott's go for Phase 4.** Phases 0 to 2 done.

Two live runs on `spikes/out/todo-live` (details and commit ids in `docs/SESSION_LOG.md`):

| Run | Result |
|---|---|
| `plans/happy.md` | 3/3 steps verified, one commit each, phase tag, clean tree, Discord summary, 6.5 minutes, no input except one auto-mode permission prompt Scott accepted |
| `plans/broken.md` | paused after 3 failed attempts, step `[!]`, three reports, high-priority Discord message |

`node scripts/check.js`: syntax 49/49, 108 tests pass. Remote `chaoticnewfie/autoclaude`, branch `main`.

Live state on this machine: plugin installed with all four hooks; both CLI shims on the user PATH;
statusline bridge registered; Discord channel configured; `spikes/out/todo-live` is paused on the
broken plan (its own git repo, trusted); `spikes/out/todo-demo` is still `running` from the
CHECKPOINT 2 demo. Both are scratch: delete their `.autoclaude/state.json` (or the folders)
before the next live run, and re-prepare with `test/fixtures/prepare.js`.

## The exact next step

**Phase 4, the browser tester** (`PLAN.md` P4.1 to P4.5):

1. P4.1 `prompts/tester.md`: reads and browses only, checks every Accept line with evidence,
   smoke-checks neighbouring features, collects console errors, flags weakened or deleted tests.
2. P4.2 `lib/tester.js`: spawn `claude -p` with `--model <config.tester.model>`,
   `--max-turns`, `--strict-mcp-config --mcp-config .autoclaude/mcp.playwright.json`,
   `--permission-mode dontAsk`, `--allowedTools mcp__playwright` plus read-only file tools,
   `--settings '{"disableAllHooks":true}'`, `--output-format json --json-schema <verdict>` and
   `AUTOCLAUDE_ROLE=tester` in the env (VERIFY.md P0.4 and P0.5 have the working flags). A
   timeout or unparseable output is an infrastructure failure: retry once, then report without
   consuming an attempt. Save the verdict and screenshots under `.autoclaude/reports/`.
3. P4.3 wire it through the `deps.tester` seam in `lib/gate.js` (called after the checks pass,
   skipped for `no-ui` steps); the gate must start the dev server for the tester even when no
   check needs it (today `needsServer` only looks at checks).
4. P4.4 phase-end bug bash with `prompts/bugbash.md`; high bugs fail the gate, others go to
   `docs/BLOCKERS.md`.
5. P4.5 the `ui-bug.md` scenario: unit tests pass, the tester catches the broken form, the
   builder fixes it on attempt 2. The fixture copy needs `@playwright/test` installed for its own
   e2e spec; the tester itself needs only Playwright MCP (Chromium is installed on this VM).

Phase 5 after that adds the PermissionRequest auto-deny, which removes the one prompt Scott had
to accept during the happy run.

## Notes for whoever continues

- The CLI runs the plugin in place; edits apply immediately. Do not edit `lib/gate.js` or the
  hook scripts while a live run is in progress on this machine.
- Restart VS Code fully after installs; its integrated terminal keeps a stale PATH.
- A scratch project that is its own git repository needs its own workspace trust (D28).
- The spike supervisor (`spikes/p08-supervisor/supervise.mjs` with `AC_SPIKE_CWD`) is the interim
  runner until Phase 6 delivers `autoclaude run`; close its window with `taskkill /T` on the
  supervisor pid from `out/supervisor.log`.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
