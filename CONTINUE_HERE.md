# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 1 is built and tested; one acceptance line waits on Scott.** Phase 0 is fully verified.

| Step | State |
|---|---|
| P1.1 marketplace and installable plugin | Done. Installed on the Code VM from `C:\AutoClaude` (loads in place). |
| P1.2 `lib/plan.js` | Done, 7 tests. |
| P1.3 `lib/state.js`, `lib/config.js`, `lib/fsatomic.js` | Done, 14 tests. |
| P1.4 CLI: status, pause, note, resume, lint-plan, usage, install-cli | Done, 8 tests. `install-cli` ran for real on this VM. |
| P1.5 `lib/notify.js` and userConfig | Code and 4 tests done. **Waiting:** a real ntfy topic or Discord webhook from Scott to prove delivery to his phone. |
| P1.6 `lib/proc.js`, `lib/paths.js` | Done, 6 tests. tmux and background launch paths untested (no Linux machine yet). |

`node scripts/check.js` (or `npm run check` in a terminal with Node on PATH): syntax 19/19, 44 tests pass.
Remote `chaoticnewfie/autoclaude`, branch `main`.

## The exact next step

1. **Ask Scott for a notification channel.** Either an ntfy topic URL (install the ntfy app, subscribe
   to a hard-to-guess topic, e.g. `https://ntfy.sh/autoclaude-<random>`) or a Discord webhook URL.
   Configure it without putting the secret in the repo:
   `claude plugin install autoclaude@autoclaude-local --config ntfy_url=https://ntfy.sh/<topic>`
   (or `/plugin configure autoclaude@autoclaude-local` inside Claude Code), then
   `autoclaude notify-test` from a new terminal. That closes P1.5.
2. **CHECKPOINT 1 demo:** `claude plugin list` shows the plugin; `autoclaude status` in
   `C:\AutoClaude` (not initialized) and in a scratch project with a config and a plan; the test
   notification arriving on his phone; `node scripts/check.js` green.
3. Then Phase 2: `init` (P2.1), the statusline bridge (P2.2), context injection (P2.3), the
   machine registry (P2.4) and `project-template/` (P2.5, including the R17 "planning for an
   unattended run" section).

## Notes for whoever continues

- The CLI runs the plugin in place: `%LOCALAPPDATA%\autoclaude\bin\autoclaude.cmd` calls
  `C:\AutoClaude\plugins\autoclaude\bin\autoclaude.js`. Edits apply immediately.
- `hooks/hooks.json` does not exist yet on purpose: the installed plugin must stay inert in every
  session until the Stop gate (Phase 3) is ready and exits early when no run is active.
- `cachedUsageUtilization` in `~/.claude.json` comes and goes (D27 amended); the statusline bridge
  (P2.2) is what the usage gate will rely on.
- The 20-minute RDP spike window from 00:45 UTC ends on its own; its log is under
  `spikes/p08-supervisor/out/` (gitignored).

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
