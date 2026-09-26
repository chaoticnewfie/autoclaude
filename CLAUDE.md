# CLAUDE.md - the rules for this repo

AutoClaude is a Claude Code plugin plus a small CLI that runs a project's `PLAN.md` step by step,
unattended, and verifies every step (tests, then a real headless browser) before it moves on.
Built for Windows first; the same code runs on Linux and macOS. Meant to be cloned by other people.

**This file is rules, constraints and standing decisions only.** What is being built next and in
what order lives in [PLAN.md](PLAN.md). Where things are right now lives in
[CONTINUE_HERE.md](CONTINUE_HERE.md). If this file and either of those disagree, this file wins.

- Repo: `git@github.com:chaoticnewfie/autoclaude.git`, branch `main`. Scott's clone is `C:\AutoClaude`.
- Session start: read `CONTINUE_HERE.md`, then this file, then the current phase of `PLAN.md`.
  Trust them. Spot-check one claim before a risky change; do not re-survey the repo.

## Status, in one line

Phase 0 nearly done (2026-09-26): five spikes pass, three wait for Scott's one-time interactive
`claude` run in this folder (`VERIFY.md`). No plugin code exists. Next: rerun `spikes/p08-supervisor`, then CHECKPOINT 0.

## Definition of done: every prompt, no exceptions

1. **It works.** `node --test` is green and `node --check` passes on every script. State the test
   count in the reply. A `PLAN.md` box is ticked only when its Accept lines are demonstrably true,
   with the evidence shown.
2. **Docs updated in the same pass.** `PLAN.md` (tick, correct what the work proved wrong, re-point
   the next step), `CONTINUE_HERE.md` (rewritten, not appended), `docs/SESSION_LOG.md` (one entry
   appended), `docs/DECISIONS.md` (every choice between real alternatives), `docs/DEFERRED.md`
   (anything deliberately not built), and this file only when a rule changed.
3. **Committed and pushed.** One commit per coherent unit, conventional message (`feat(gate):`,
   `fix(cli):`, `docs:`, `chore:`, `test:`), and `git push origin main` after every commit. Never
   leave work uncommitted at the end of a prompt.
4. **Requests are captured.** Anything Scott asks for that is not being built now goes into the
   "Requested since the draft" table in `PLAN.md` with the date and his words. Nothing is dropped,
   and nothing is built early unless he says so.

## Rules

1. **Everything lives in this folder and in git.** No `~/.claude/plans`, no machine-local notes.
2. **Node 24 built-ins only** in the plugin scripts, the CLI and the supervisor. No npm
   dependencies, no bash, no jq, no PowerShell needed at runtime. Paths through `path.join`, every
   spawn argument quoted, process trees ended with `taskkill /T` on Windows.
3. **Windows is first-class.** Windows Server 2025 and Windows 11 without WSL are the primary
   targets. Linux and macOS keep working through the same code. tmux is an optional nicety there,
   never a requirement.
4. **Built to be shared.** Nothing personal in plugin code, templates, `README.md` or
   `docs/USAGE.md`: no homelab IPs, no user-profile paths, no Scott-specific facts. Per-machine
   values go in plugin userConfig; per-project values go in `autoclaude.config.json`. Build-history
   docs (this file, `docs/CONVENTIONS_SURVEY.md`, `docs/SESSION_LOG.md`) may mention his setup.
5. **No secrets in committed files.** ntfy tokens and Discord webhooks live in plugin userConfig
   (marked sensitive) or environment variables. Placeholders only, everywhere else.
6. **Decision log.** `docs/DECISIONS.md` is dated and append-only: the choice, the why, what was
   rejected. A reversal is a new entry that supersedes the old one. The draft's D1 to D16 live in
   `PLAN.md` section 3 and are edited in place there, with the change logged.
7. **Facts worth not re-deriving** go in the section below the moment something costs more than
   five minutes to work out.
8. **Deferred work** goes in `docs/DEFERRED.md`: what, why it waits, the trigger, the path, and why
   adding it later costs no rework.
9. **Automate everything.** If a command can be run, run it, then say what to look at. Hand Scott
   only what needs a browser, a phone, a physical device, or a decision only he can make. Locate
   binaries by full path instead of asking him to fix PATH. Start long-running things in the
   background.
10. **Agents: reasonable, and stopped when done.** Subagents and workflows are welcome when they
    add value one context cannot. Not 70 of them. The failure to avoid is burning a 5-hour usage
    window in 10 minutes by mistake, so keep fan-out proportional to the value and the risk, and
    stop or cancel agents the moment they are no longer needed.
11. **Line endings.** `.gitattributes` forces LF; `.ps1`, `.bat` and `.cmd` keep CRLF.
    `.editorconfig`: 2-space indent, utf-8, LF, final newline.
12. **Shell hygiene on Windows.** Use the Bash tool for git commits with multi-line messages.
    Heredocs mangle non-ASCII, and a quoted heredoc still failed on an apostrophe here, so write
    prose files with the Write tool and keep heredoc content plain ASCII.
13. **Stop at every CHECKPOINT in `PLAN.md`** and show Scott the demo it describes before starting
    the next phase. A Phase 0 finding that contradicts the plan updates the plan and gets a
    `docs/DECISIONS.md` entry.

## Tech stack (fixed, do not deviate without being asked)

- Node 24 LTS, ES modules, built-ins only. `node --test` for tests.
- Claude Code plugin layout: `.claude-plugin/plugin.json`, `hooks/hooks.json`, `skills/`,
  `agents/`, with a local-directory marketplace at the repo root.
- Playwright MCP (`@playwright/mcp`, headless Chromium) for the browser tester, run through `npx`
  inside the target project. Never a dependency of the plugin.
- ntfy or a Discord webhook for notifications, through the global `fetch`.
- Target projects use whatever they use. The gate runs the commands in their `autoclaude.config.json`.

## Repo map

| Path | What it is |
|---|---|
| `PLAN.md` | The approved plan: phases, steps, Accept lines, checkpoints |
| `CONTINUE_HERE.md` | Resume point. Read first |
| `CLAUDE.md` | This file |
| `docs/DECISIONS.md` | Dated decision log (D17 onward; D1 to D16 are in the plan) |
| `docs/SESSION_LOG.md` | One entry per working session |
| `docs/DEFERRED.md` | Deliberately not built yet, with triggers |
| `docs/CONVENTIONS_SURVEY.md` | Where these rules came from: Scott's other repos |
| `plugins/autoclaude/` | The plugin (from Phase 1) |
| `project-template/` | The doc set `autoclaude init` writes into a project (from Phase 2) |
| `test/` | `node --test` unit and scenario tests (from Phase 1) |
| `spikes/` | Phase 0 throwaway experiments; results go in `VERIFY.md` |

## Facts worth not re-deriving

- On Scott's dev VM, Node is at `C:\Program Files\nodejs\` and the GitHub CLI at
  `C:\Program Files\GitHub CLI\gh.exe`. Shells opened before those installs do not have them on
  PATH. Call by full path or prepend for the session.
- The only `claude` binary on that VM is the VS Code extension's bundled one under
  `.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe`. The unattended
  runner needs the native install: `irm https://claude.ai/install.ps1 | iex`.
- `~/.claude/settings.json` on that VM already carries Stop, PermissionRequest and PreToolUse hooks
  from the `ai-agent-sound-notification` VS Code extension. They call `node` by bare name.
- GitHub `chaoticnewfie/autoclaude` is private. SSH to github.com is already trusted there.
- An RDP disconnect keeps a console window alive on Windows; a log-off or a sleeping machine kills
  it. That is the difference between "walk away" and "lose the run".
- The native CLI's first interactive run shows a theme picker, then a workspace-trust dialog. Until
  Scott has done that once in `C:\AutoClaude`, an unattended interactive `claude` there sits on the
  picker forever. Editing `~/.claude.json` to skip it is denied by the auto-mode classifier
  (self-modification); the tool never does it either (D28).
- The Bash tool is Git Bash: it rewrites `/D`-style switches into paths (`/D` became `D:/`). Launch
  Windows commands from Node, and use `//c` for a cmd switch when bash is unavoidable. `start` needs
  a quoted title or it treats the first word as the program; both mistakes leave a `cmd` hung on an
  error dialog.
- `claude config` is not a subcommand in 2.1.283: `claude config list` sends "config list" as a
  prompt and burns a turn.
- `--bare` skips credential reads and fails auth under a subscription login; nested runs use
  `--settings '{"disableAllHooks":true}'` (D30).
- `claude agents --json --all` lists interactive sessions with `pid`, `sessionId` and `status`
  even when no background session exists (D31).
- `~/.claude.json` -> `cachedUsageUtilization` carries `five_hour` and `seven_day` utilization
  with `resets_at`, refreshed by any session. Read it; never write that file (D27, D28).
- Bash-tool commands are wrapped in a way that breaks on an apostrophe even inside a quoted
  heredoc. Write scripts with the Write tool and call them by path.

## Documentation index

| Doc | Read it when |
|---|---|
| `CONTINUE_HERE.md` | Starting a session. Always |
| `PLAN.md` | Starting a phase, or checking an Accept line |
| `docs/DECISIONS.md` | About to change an architectural choice |
| `docs/DEFERRED.md` | Something seems to be missing |
| `docs/SESSION_LOG.md` | You want to know what happened when |
| `docs/CONVENTIONS_SURVEY.md` | You want to know why a rule above exists |
