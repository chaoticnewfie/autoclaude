# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 0 is complete. CHECKPOINT 0 is waiting on Scott's review. No plugin code exists yet.**

- Every Phase 0 step is ticked in `PLAN.md`; the evidence is in `VERIFY.md`, one row per step.
- The only unverified line is the RDP disconnect and reconnect (P0.8), which needs Scott at the
  console: open a spike window, disconnect, reconnect, confirm the window and its log are alive.
- Decisions D17 to D31 are in `docs/DECISIONS.md`. The design after Phase 0: interactive `claude`
  under our console-window supervisor (D18); Claude Code's background sessions rejected because
  Stop hooks do not run there (D26); exec-form plugin hooks (D29); nested runs with
  `--settings '{"disableAllHooks":true}'` (D30); onboarding and trust checked read-only (D28).
- Installed on this VM: Claude Code native 2.1.283 on the user PATH, Playwright Chromium.
- Remote `chaoticnewfie/autoclaude`, branch `main`, in sync with `C:\AutoClaude` after the last commit.

## The exact next step

1. **CHECKPOINT 0 with Scott:** walk through `VERIFY.md` (the summary table first, then the
   "Changes made to the plan" list at the bottom) and `docs/DECISIONS.md` D26 to D31. He decides
   whether anything in the revised design is wrong before code is written.
2. On his go-ahead, **Phase 1** (`PLAN.md`): P1.1 repo layout, local marketplace and an installable
   empty plugin; P1.2 `lib/plan.js`; P1.3 state, config, fsatomic (retry EPERM and EBUSY on rename);
   P1.4 CLI skeleton with the Windows shim; P1.5 notify; P1.6 `lib/proc.js` and `lib/paths.js`
   (the `cmd start` launcher from `spikes/lib/open-window.mjs` moves here). `node --test` from the
   first file.
3. During P1.1, check whether `CLAUDE_PLUGIN_OPTION_<KEY>` is exported after a marketplace install
   (it was not under `--plugin-dir`, VERIFY.md P0.10).

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).

## Spike helpers worth reusing in Phase 1

`spikes/lib/open-window.mjs` (detached console window through `cmd start`, quoted title),
`spikes/lib/claude-clean.mjs` (run the native CLI from inside a Claude session),
`spikes/lib/summarize.js` and `spikes/lib/transcript-texts.js` (read `-p` results and transcripts),
`spikes/p08-supervisor/supervise.mjs` (spawn, hold, `taskkill /T`, relaunch with `--continue`),
`spikes/p08-supervisor/permission-deny.js` and `pretool-deny.js` (the exact hook output shapes
that work in 2.1.283), `spikes/p04-nested/nested-hook.js` (nested `claude -p` with a schema),
`spikes/p05-browser/mcp.playwright.cmd.json` (the Windows MCP config).
