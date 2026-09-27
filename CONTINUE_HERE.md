# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 1 is complete. CHECKPOINT 1 is waiting on Scott's go for Phase 2.** Phase 0 is fully verified.

| Step | State |
|---|---|
| P1.1 marketplace and installable plugin | Done. Installed on the Code VM from `C:\AutoClaude` (loads in place). |
| P1.2 `lib/plan.js` | Done. |
| P1.3 `lib/state.js`, `lib/config.js`, `lib/fsatomic.js` | Done. |
| P1.4 CLI: status, pause, note, resume, lint-plan, usage, install-cli | Done. `install-cli` ran for real; `autoclaude` is on Scott's user PATH. |
| P1.5 `lib/notify.js`, userConfig, `notify-setup` | Done. Two Discord messages reached Scott (userConfig path and per-machine file path, D32). |
| P1.6 `lib/proc.js`, `lib/paths.js` | Done. tmux and background launch paths untested (no Linux machine yet). |

`node scripts/check.js`: syntax clean, all unit tests pass (see `docs/SESSION_LOG.md` for the count).
Remote `chaoticnewfie/autoclaude`, branch `main`.

Configured on this machine (outside the repo): the Discord webhook in the plugin's secure
userConfig store and in `~/.claude/autoclaude/notify.json`; `notify_channel=discord` in
`~/.claude/settings.json` pluginConfigs.

## The exact next step

**Phase 2** (`PLAN.md`), on Scott's go:

1. P2.5 `project-template/` first, because P2.1 copies from it: `CLAUDE.md` (conventions plus the
   R17 "planning for an unattended run" section), `PLAN.md` skeleton with the requested-features
   table, `CONTINUE_HERE.md`, `PROGRESS.md`, `docs/{DECISIONS,SESSION_LOG,DEFERRED,BLOCKERS,
   SECURITY-FINDINGS,REVIEW_NOTES}.md`, `.gitattributes`, `.editorconfig`, `.gitignore`.
2. P2.1 `autoclaude init` and the `/autoclaude:init` skill: detect `package.json` scripts, write
   `autoclaude.config.json`, copy missing template files only, `.autoclaude/` into `.gitignore`,
   Playwright offer, MCP config per OS, `node` and native `claude` checks, plan-review
   recommendation for existing projects. Idempotent.
3. P2.2 statusline bridge: `~/.claude/autoclaude/statusline.js` registered in user settings,
   chaining any existing statusLine, writing `usage.json`. Registering it edits
   `~/.claude/settings.json`; do it through the CLI with a clear message and a backup.
4. P2.3 context injection: `hooks/hooks.json` (exec form) with a SessionStart hook that exits at
   once when no run is active; while running it injects `prompts/context.md`, the current step,
   the last 10 `PROGRESS.md` lines and pending review notes. Also mirrors notify userConfig into
   `notify.json` (D32).
5. P2.4 machine registry: `init` registers the project; `status --all` lists them.

CHECKPOINT 2: `init` on a fixture app, the statusline, and injected context after `/compact`.

## Notes for whoever continues

- The CLI runs the plugin in place: `%LOCALAPPDATA%\autoclaude\bin\autoclaude.cmd` calls
  `C:\AutoClaude\plugins\autoclaude\bin\autoclaude.js`. Edits apply immediately.
- VS Code's integrated terminal keeps the PATH VS Code started with; after `install-cli` or the
  native Claude install, `claude` and `autoclaude` are "not recognized" there until VS Code is
  fully closed and reopened. A Start-menu PowerShell sees them at once. `install-cli` says so.
- `hooks/hooks.json` does not exist yet on purpose: the installed plugin stays inert in every
  session until the hooks exit early when no run is active.
- `cachedUsageUtilization` in `~/.claude.json` comes and goes (D27 amended); the statusline bridge
  (P2.2) is what the usage gate will rely on.
- Never call `process.exit()` right after a `fetch` in the CLI; set `process.exitCode`.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).
