# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 3 is built and scenario-tested. CHECKPOINT 3, the first live run, is next.** Phases 0 to 2 done.

| Step | State |
|---|---|
| P3.1 fixture app and plans | Done. `test/fixtures/prepare.js` builds a scratch project from them. |
| P3.2 ready/blocked protocol and gate skeleton | Done. |
| P3.3 `lib/devserver.js` | Done (agent-written, 7 tests, Windows detached-wrapper design). |
| P3.4 `lib/checks.js`, `lib/report.js` | Done (agent-written, 13 tests). |
| P3.5 to P3.7 pass path, fail path, integrity | Done. |
| P3.8 scenario tests | Done: 12 scenarios in `test/scenarios/stop-gate.test.js`. |

`node scripts/check.js`: syntax 49/49, 107 tests pass. Remote `chaoticnewfie/autoclaude`, branch `main`.

Hooks now registered in the installed plugin: SessionStart, Stop (the gate, timeout 1800 s),
PostToolUse (heartbeat, async), PreToolUse (tool guard). They run in every session on this
machine and are silent unless the session's project has `status: running`.

## CHECKPOINT 3: the first live run

Scratch project: `C:\AutoClaude\spikes\out\todo-live` (the fixture app + `plans/happy.md`, its
own git repo with one commit, config: checks lint + unit, dev server `node server.js` at
http://127.0.0.1:4173 but no check needs it yet; the browser tester arrives in Phase 4).

1. It is a nested git repository, so Scott trusts it once: `cd C:\AutoClaude\spikes\out\todo-live`,
   `claude`, accept the trust dialog, `/exit` without typing anything.
2. Then, from any shell: `autoclaude start` in that folder (creates branch `autoclaude/todo-fixture`,
   state running on S1.1).
3. Launch the builder session in its own window with the spike supervisor and a long hold:
   `set AC_SPIKE_CWD=C:\AutoClaude\spikes\out\todo-live` then
   `node C:\AutoClaude\spikes\lib\open-window.mjs ac-live C:\AutoClaude\spikes\out\todo-live "C:\Program Files\nodejs\node.exe" C:\AutoClaude\spikes\p08-supervisor\supervise.mjs 3600000 --permission-mode auto "Begin the current step as the injected AutoClaude context says."`
   (Phase 6 replaces this with `autoclaude run`.)
4. Watch: `autoclaude status` in the folder, `.autoclaude/logs/gate.log`, `git log --oneline`
   on the run branch, `PROGRESS.md`. Expected: three commits `autoclaude(S1.x): ...`, state
   `complete`, a Discord summary. `plans/broken.md` variant afterwards: pauses after 3 attempts
   with a high-priority notification.

## The exact next step after CHECKPOINT 3

Phase 4, the browser tester: `prompts/tester.md`, `lib/tester.js` (headless `claude -p` with the
Playwright MCP config that `init` writes, `--settings '{"disableAllHooks":true}'`, sonnet,
`--json-schema` verdict, `AUTOCLAUDE_ROLE=tester`; infrastructure failures retried once without
consuming an attempt), wired into `lib/gate.js` through the `deps.tester` seam that already
exists (it is called after the deterministic checks pass, skipped for `no-ui` steps), the
phase-end bug bash, and the `ui-bug.md` scenario.

## Notes for whoever continues

- The CLI runs the plugin in place; edits apply immediately. `install-cli` has been run on this VM.
- VS Code's integrated terminal keeps the PATH VS Code started with; restart VS Code fully after
  installs. Sessions started from a stale VS Code cannot resolve `node` for exec-form hooks.
- A scratch project that is its own git repository needs its own workspace trust (D28).
- `cachedUsageUtilization` in `~/.claude.json` comes and goes; the statusline bridge is primary.
- Never call `process.exit()` right after a `fetch` in the CLI; set `process.exitCode`.
- `spikes/out/todo-demo` is still in state running from the CHECKPOINT 2 demo; delete its
  `.autoclaude/state.json` when it is no longer needed.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
