# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 2 is complete. CHECKPOINT 2 is waiting on Scott's look.** Phases 0 and 1 are done.

| Step | State |
|---|---|
| P2.1 `autoclaude init` and the init skill | Done, live on a fixture copy. |
| P2.2 statusline bridge | Done, installed on the Code VM; live `AC S1.1 > running | 5h 44% | 7d 11%`. |
| P2.3 context injection (SessionStart hook) | Done; scenario tests plus a live headless and a live interactive check. `/compact` re-injection is what Scott looks at. |
| P2.4 machine registry | Done. |
| P2.5 `project-template/` | Done (13 files, drafted by a background agent, reviewed). |

`node scripts/check.js`: syntax 31/31, 61 tests pass. Remote `chaoticnewfie/autoclaude`, branch `main`.

Live state on this machine: the plugin is installed and enabled; the statusline bridge is
registered in `~/.claude/settings.json` (backup next to it); the Discord webhook is in the
plugin's secure config and in `~/.claude/autoclaude/notify.json`; the registry lists one project,
the scratch copy `C:\AutoClaude\spikes\out\todo-demo` (gitignored), which is in state `running`
on `S1.1` of the happy plan with no supervisor or gate behind it. Set it back to idle before
Phase 3 live runs: delete its `.autoclaude/state.json`.

## CHECKPOINT 2 demo for Scott

In a Start-menu PowerShell (or VS Code after a full restart):

```
cd C:\AutoClaude\spikes\out\todo-demo
autoclaude status
claude
```

The status line at the bottom reads `AC S1.1 > running | 5h N% | 7d N%`. Ask "which step are we
on and what are its Accept lines?" (the answer comes from the injected context). Then `/compact`,
ask again: the same context is re-injected after compaction. `/exit`. Note: the injected rules
tell Claude to work on the step, so it may offer to start; it is a scratch copy, nothing matters.

## The exact next step

**Phase 3, the Stop gate** (`PLAN.md`): P3.1 fixture app and plans (the app and the three plans
exist; `broken.md` still needs `test/impossible.test.js` in the fixture, and `ui-bug.md` needs the
`id="txt"` bug applied to a copy), P3.2 ready/blocked protocol and the gate skeleton (Stop hook in
`hooks/hooks.json`, `scripts/stop-gate.js`), P3.3 `lib/devserver.js`, P3.4 `lib/checks.js` and
`lib/report.js`, P3.5 pass path (tick, PROGRESS.md, commit, tag, next step), P3.6 fail path,
P3.7 integrity check, P3.8 scenario tests. Then CHECKPOINT 3: the first live run on the fixture.

Design reminders for the gate: exit at once unless `state.status === "running"` and
`AUTOCLAUDE_ROLE` is unset; keep the block reason under 4,000 characters and name the report
path; `taskkill /T` for the dev server; D33 re-baseline on resume; the `review.pauseAt` and
`pauseRequested` checks after the commit (section 4.10).

## Notes for whoever continues

- The CLI runs the plugin in place; edits apply immediately. `install-cli` has been run on this VM.
- VS Code's integrated terminal keeps the PATH VS Code started with; restart VS Code fully after
  installs. Sessions started from a stale VS Code cannot resolve `node` for exec-form hooks.
- A scratch project must not be its own git repository (workspace trust), see `CLAUDE.md` facts.
- `cachedUsageUtilization` in `~/.claude.json` comes and goes; the statusline bridge is primary.
- Never call `process.exit()` right after a `fetch` in the CLI; set `process.exitCode`.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
