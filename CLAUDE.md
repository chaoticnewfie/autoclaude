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

1.1.0 released (2026-10-04): security and optimize sweeps, phases that fit their verification,
flaky-check reruns (Phase 10, D58 to D62), proven live on practice apps. The repository is public
(D56). Next: P9.1's written review, then P9.2 to P9.4. The DB project may be read for reviews,
never edited.

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
4. **Every new feature or setting reaches the owner's view.** The settings page
   (`lib/configpage.js` FIELDS), `INSTRUCTIONS.md` (and its template copy `AUTOCLAUDE.md`),
   `docs/USAGE.md` (configuration and command references) and `CHANGELOG.md` are updated in the
   same change. `test/unit/docs-coverage.test.js` fails when a setting or a command is missing
   from them (Scott, 2026-10-04: "Make sure the config page and instructions are updated
   whenever new features are added everytime if they need to be").
5. **Requests are captured.** Anything Scott asks for that is not being built now goes into the
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
    stop or cancel agents the moment they are no longer needed. Models: the newest Opus is the
    main model, the newest Sonnet the floor for trivial work, never Haiku, in spikes and live
    checks as much as in the product (D44).
11. **Line endings.** `.gitattributes` forces LF; `.ps1`, `.bat` and `.cmd` keep CRLF.
    `.editorconfig`: 2-space indent, utf-8, LF, final newline.
12. **Shell hygiene on Windows.** Use the Bash tool for git commits with multi-line messages.
    Heredocs mangle non-ASCII, and a quoted heredoc still failed on an apostrophe here, so write
    prose files with the Write tool and keep heredoc content plain ASCII.
13. **Stop at every CHECKPOINT in `PLAN.md`** and show Scott the demo it describes before starting
    the next phase. A Phase 0 finding that contradicts the plan updates the plan and gets a
    `docs/DECISIONS.md` entry.
14. **Bump the plugin version with every plugin change.** Claude Code caches a marketplace
    install by the version in `plugins/autoclaude/.claude-plugin/plugin.json`; a pushed change
    under the same version never reaches installed copies. Raise it (and
    `plugins/autoclaude/package.json`) in any commit that changes `plugins/autoclaude/`.

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
| `INSTRUCTIONS.md` | Plain instructions for people using AutoClaude; keep in step with `docs/USAGE.md`. `init` copies it into projects as `AUTOCLAUDE.md` from `plugins/autoclaude/project-template/AUTOCLAUDE.md`, which a test keeps identical: copy the file over after every edit |
| `CLAUDE.md` | This file |
| `CHANGELOG.md` | What changed in each version, for people using AutoClaude; add a line with every version bump |
| `docs/DECISIONS.md` | Dated decision log (D17 onward; D1 to D16 are in the plan) |
| `docs/SESSION_LOG.md` | One entry per working session |
| `docs/DEFERRED.md` | Deliberately not built yet, with triggers |
| `docs/CONVENTIONS_SURVEY.md` | Where these rules came from: Scott's other repos |
| `plugins/autoclaude/` | The plugin (from Phase 1) |
| `plugins/autoclaude/project-template/` | The doc set `autoclaude init` writes into a project (inside the plugin since D42) |
| `test/` | `node --test` unit and scenario tests (from Phase 1) |
| `spikes/` | Phase 0 throwaway experiments; results go in `VERIFY.md` |

## Facts worth not re-deriving

- On Scott's dev VM, Node is at `C:\Program Files\nodejs\` and the GitHub CLI at
  `C:\Program Files\GitHub CLI\gh.exe`. Shells opened before those installs do not have them on
  PATH. Call by full path or prepend for the session.
- A run window inherits the PATH of the shell that ran `autoclaude run`, and so do the session,
  the hooks and the gate. The VS Code tool shells here lack node, and the PowerShell one lacks git
  too. Start live runs from a fresh terminal, or prepend both; a run started with node but no git
  could not commit.
- A directory marketplace (a clone added by path) loads the plugin from the clone, but
  `installed_plugins.json` still lists a cache copy made at install time, which goes stale. A
  GitHub marketplace runs from `plugins/cache/<marketplace>/autoclaude/<version>/`, and only a
  version bump makes `claude plugin update` fetch new code (rule 14).
- Only an interactive `claude` in a folder records workspace trust; `claude -p` and SDK sessions
  never do, so a headless onboarding always ends at `FAIL trust`.
- `test/live/gh-install.live.mjs` installs from GitHub into a throwaway config (path with a space
  and a tilde) and checks the installed copy end to end, without touching the real config.
- The only `claude` binary on that VM is the VS Code extension's bundled one under
  `.vscode\extensions\anthropic.claude-code-*\resources\native-binary\claude.exe`. The unattended
  runner needs the native install: `irm https://claude.ai/install.ps1 | iex`.
- `~/.claude/settings.json` on that VM already carries Stop, PermissionRequest and PreToolUse hooks
  from the `ai-agent-sound-notification` VS Code extension. They call `node` by bare name.
- GitHub `chaoticnewfie/autoclaude` is public from 2026-10-02, with no license yet (D56). SSH to
  github.com is already trusted there. This clone commits as the GitHub no-reply address
  (local `user.email`); the first 55 commits carry Scott's Gmail address and stay as they are.
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
- Git Bash also rewrites a leading-slash argument: `"/compact"` reaches a Windows program as
  `C:/Program Files/Git/compact`. `autoclaude nudge` undoes this; anything else that takes a slash
  command should be run from PowerShell.
- The Bash tool collapses a doubled backslash into one, which silently changes escapes in code
  written through it. For a slash in a regex use a character class such as `[/]`.
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
- Workspace trust covers subfolders of a trusted repo, but a nested git repository needs its own
  trust: a scratch copy of the fixture with its own `.git` stopped an interactive session on the
  trust dialog. Scratch projects under `spikes/out/` must not be git repositories.
- `~/.claude/settings.json` may be written by the CLI (the statusline bridge install did it with a
  backup); `~/.claude.json` may not (classifier-denied, and D28 forbids it anyway).
- A long-lived child (the dev server) started from a hook must be spawned `detached` on Windows,
  or it dies with the hook: non-detached children sit in libuv's kill-on-close job object. A
  detached `cmd.exe` has no console and Windows gives its child a fresh one, which replaces an
  inherited log handle, so `lib/devserver.js` spawns a detached console-less `node` wrapper that
  runs `cmd /c <command>` non-detached with the log file as stdio. Verified in Phase 3.
- `node --test <directory>` fails on Node 24 on Windows ("Cannot find module ...\test"); pass a
  glob such as `node --test test/*.test.js`. The fixture app had this bug until Phase 4.
- Playwright MCP writes page snapshots and console logs to `--output-dir`, but a screenshot saved
  with a file name goes to the claude process's working directory. The checkers therefore run
  with their report folder as the working directory, and `sweepStrays` moves anything new in the
  project into the report (D35).
- A `git push` over SSH to github.com once timed out on port 22 and succeeded on a plain retry.
  If it keeps failing, `git push https://github.com/chaoticnewfie/autoclaude.git main` works
  through the GitHub CLI credential helper.
- The PreToolUse, PostToolUse and Stop hooks of this plugin run in every session on the machine,
  including this one. They must stay silent and instant when no run is active, and the Stop hook
  imports its libraries lazily so a half-written library can never break someone's session.
- A scratch project under this repo (spikes/out/...) also loads this repo's CLAUDE.md in every
  session. `claudeMdExcludes` in the scratch project's `.claude/settings.json` (absolute paths or
  globs, picomatch) keeps it out; `spikes/lib/prep-practice.mjs` writes it. Checked with a
  headless session listing its loaded memory files: only `~/.claude/CLAUDE.md` remained.
- Workflow agents that run the full suite in parallel make PowerShell start slowly enough (over
  60 s) that the file-lock test cannot take its lock; it reports a skip then. Run one full suite
  at a time.
- git 2.55 fails `git add -A -- . ":(exclude)<dir>"` (exit 1) when <dir> exists and .gitignore
  ignores it, though it staged everything else. Stage with a plain `add -A -- .` and then
  `git reset -q -- <dir>` (git.js stageForCommit, 1.0.1).
- A `node --test` started from inside a `node --test` run (NODE_TEST_CONTEXT in its environment)
  reports to its parent and prints no TAP of its own: drop that variable before running a
  project's tests from a test.
- GitHub push protection (on since the repo went public) rejects a push whose commits contain a
  key-shaped literal, fake ones in tests included (a Stripe-style sk_live_ key was refused).
  Build fake keys at runtime, for example `["sk", "live", "..."].join("_")`.

## Documentation index

| Doc | Read it when |
|---|---|
| `CONTINUE_HERE.md` | Starting a session. Always |
| `PLAN.md` | Starting a phase, or checking an Accept line |
| `docs/DECISIONS.md` | About to change an architectural choice |
| `docs/DEFERRED.md` | Something seems to be missing |
| `docs/SESSION_LOG.md` | You want to know what happened when |
| `docs/CONVENTIONS_SURVEY.md` | You want to know why a rule above exists |
