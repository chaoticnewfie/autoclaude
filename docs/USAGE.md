# AutoClaude usage guide

This guide is for anyone setting up AutoClaude on their own machine, and for Claude when a user
asks it to add AutoClaude to a project. It assumes nothing about this repository.

Contents:

0. [How a run works, and the words used here](#0-how-a-run-works-and-the-words-used-here)
1. [Install, once per machine](#1-install-once-per-machine)
2. [Adding AutoClaude to a project](#2-adding-autoclaude-to-a-project)
3. [The plan](#3-the-plan)
4. [Running](#4-running)
5. [Pausing, notes, resuming and stopping](#5-pausing-notes-resuming-and-stopping)
6. [Alerts](#6-alerts)
7. [Answering a blocked question](#7-answering-a-blocked-question)
8. [Recovery: what happens on its own](#8-recovery-what-happens-on-its-own)
9. [Pause reasons and what to do](#9-pause-reasons-and-what-to-do)
10. [After the run](#10-after-the-run)
11. [Configuration reference](#11-configuration-reference)
12. [What a run may and may not do](#12-what-a-run-may-and-may-not-do)
13. [Windows notes](#13-windows-notes)
14. [Linux and macOS notes](#14-linux-and-macos-notes)
15. [Troubleshooting](#15-troubleshooting)
16. [Updating and uninstalling](#16-updating-and-uninstalling)
17. [Command reference](#17-command-reference)

## 0. How a run works, and the words used here

- **The plan** is a Markdown file (`PLAN.md` by default) with phases and small **steps**. Each step
  has **Accept lines**: observable facts that are true when it is done.
- **`autoclaude run`** opens the **run window** (`ac-<project>`). In it the **supervisor** starts
  and watches one Claude Code session, the **builder**, which works on the current step.
- When the builder runs `autoclaude ready <step>`, the **gate** verifies the step. It runs the
  project's **checks** (test, lint and similar commands), then the **browser tester** (a separate
  Claude session with a headless browser that checks every Accept line). At the end of a phase it
  also runs the **bug bash** (a browser session that tries to break the phase's features) and the
  **security reviewer**. A pass is committed and ticked; a failure goes back to the builder with
  a report, up to 3 attempts.
- The builder settles questions from the plan, and asks the **decider** (a helper agent) when the
  plan does not say. A critical question **blocks** the run until you answer.
- The **watchdog** is an optional scheduled task that reopens the run window if it dies.
- **Alerts** go to Discord or ntfy, only when something needs you.

## 1. Install, once per machine

### Requirements

| What | Install (Windows) | Install (macOS / Linux) | Check |
|---|---|---|---|
| Claude Code, native install | `irm https://claude.ai/install.ps1 \| iex` in PowerShell | `curl -fsSL https://claude.ai/install.sh \| bash` | `claude --version` |
| Node.js 24 or newer | `winget install OpenJS.NodeJS` | your package manager, or nodejs.org | `node --version` |
| git | `winget install Git.Git` (Git for Windows, which Claude Code also needs) | your package manager | `git --version` |
| GitHub CLI (one way to reach the private repo) | `winget install GitHub.cli` | `brew install gh`, or your package manager | `gh --version` |
| tmux (Linux and macOS only) | not needed | `brew install tmux` / `apt install tmux` | `tmux -V` |
| Chromium for Playwright (web UI projects) | `npx.cmd playwright install chromium` | `npx playwright install chromium` | `autoclaude run --check` reports it |

Open a new terminal after each install so it sees the new program. The copy of Claude Code that
comes inside an editor extension is not enough: the run starts `claude` from a terminal.

A run needs network access the whole time: Claude itself, and the browser tester, which fetches
the Playwright MCP server (`npx -y @playwright/mcp@latest`) each time it starts.

Sign in once: run `claude` in a terminal, log in with your Claude subscription, pick a theme if
asked, then `/exit`. The run uses the same 5-hour and weekly usage limits as the rest of your
Claude Code work; on a Pro plan, expect long waits for the 5-hour reset during a long run.

On Windows, check Git Bash with `Test-Path "$env:ProgramFiles\Git\bin\bash.exe"` (it prints
True). In PowerShell, `npx` may fail with "running scripts is disabled on this system"; use
`npx.cmd` as shown, or run `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once.

### Access to the private repository

Accept the GitHub invitation, then give git a way to read the repository from the command line:

- the GitHub CLI: `gh auth login`, then `gh auth setup-git` (without the second command, git
  itself still has no credentials), or
- an SSH key on your GitHub account (`ssh -T git@github.com` greets you by name).

Test it before going on; either command must list branches, not ask for a password:

```
git ls-remote https://github.com/chaoticnewfie/autoclaude.git
git ls-remote git@github.com:chaoticnewfie/autoclaude.git
```

### Install the plugin

```
claude plugin marketplace add chaoticnewfie/autoclaude
claude plugin install autoclaude@autoclaude
```

You should see "Successfully added marketplace: autoclaude" and "Successfully installed plugin:
autoclaude@autoclaude". The install may add that 4 userConfig options are not set; that is fine
(section 6 explains them). If the first command fails with an authentication or "repository not
found" error, or a sign-in window appears, fix access first, then retry with the address form
that worked in `git ls-remote`:

```
claude plugin marketplace add https://github.com/chaoticnewfie/autoclaude.git
```

`claude plugin list` then shows `autoclaude@autoclaude` with its version, scope user, and status
enabled.

The plugin's hooks now load into every Claude Code session on this machine. They do nothing
unless a run is active in that session's project, and even then they leave alone any session
other than the run's own builder.

### The `autoclaude` command

`/autoclaude:init` (section 2) installs it the first time. To do it by hand, run the CLI from the
plugin folder once. Claude Code records that folder in `~/.claude/plugins/installed_plugins.json`
under `autoclaude@autoclaude`, as `installPath`:

```
node "<installPath>/bin/autoclaude.js" install-cli
```

This writes a small launcher and a shim into a per-user folder. On Windows that is
`%LOCALAPPDATA%\autoclaude\bin`, with two shims (`autoclaude` for Git Bash, `autoclaude.cmd` for
PowerShell and cmd), and the folder is added to your user PATH. On Linux and macOS it is
`~/.local/bin`, with one shim, and the command prints the line to add to your shell profile if
that folder is not on your PATH.

Terminals that were already open, including every terminal inside an editor that was already
running and the shell of the Claude Code session that ran the install, keep the old PATH. Open a
new terminal, or call the shim by its full path, for example
`& "$env:LOCALAPPDATA\autoclaude\bin\autoclaude.cmd" status` in PowerShell.

The launcher finds the current plugin version every time, so plugin updates never break the
command. The shims record the Node program that ran `install-cli`: if you move or reinstall Node,
run `install-cli` again.

The alert setup and the watchdog below use this command, so do them after `/autoclaude:init`.

### Alerts

```
autoclaude notify-setup --discord "https://discord.com/api/webhooks/..."
autoclaude notify-test
```

Section 6 has the details and the ntfy form. The setting is per machine and lives outside every
repository.

### The watchdog (recommended for long runs)

```
autoclaude watchdog --install
```

On Windows this is a Task Scheduler task; on Linux a systemd user timer. It runs every 5 minutes
and reopens the run window of any project whose run is marked running but whose supervisor is
gone, if that run was active within the last 24 hours. A paused run is never reopened. Without
systemd (macOS, minimal Linux) the command prints a crontab line to add with `crontab -e`.
`autoclaude watchdog --status` shows it; `--uninstall` removes it.

## 2. Adding AutoClaude to a project

This section is a checklist. If you are Claude doing this for a user, work through it in order and
tell the user what you are doing at each step. These are the questions you may ask the user; ask
nothing else the checklist does not need:

- which prerequisites from section 1 are missing, and whether they will install them
- what to do with uncommitted work of theirs (commit or stash; never discard it)
- whether the status line bridge may be installed (step 4)
- the alert channel and its address (step 8)
- the planning interview, which `/autoclaude:plan` runs (step 6)

1. **Requirements.** Check every row of section 1's table, whether or not the plugin is already
   installed. Then `claude plugin list` must show `autoclaude@autoclaude`; if not, install it
   (section 1).
2. **A session that has the plugin.** Plugins load when a session starts. If the plugin was just
   installed from inside a running Claude Code session, that session cannot use
   `/autoclaude:init` or `/autoclaude:plan`. Tell the user to exit, run `claude` in the project,
   and type `/autoclaude:init` there; the new session continues this checklist from step 3. The
   user types the slash commands; a session that has the plugin may also run them itself as
   skills when the user asks it to.
3. **Git.** The project must be a git repository with at least one commit, and the working tree
   must be clean before a run. For a brand new project: `git init`, then a first commit. If the
   tree is dirty with the user's own work, ask whether to commit or stash it.
4. **Trust and first run.** Claude Code must have been opened once in the project folder from a
   terminal, with its theme picker (first run only) and folder-trust question answered. Only a
   person can answer them: a session started with `claude -p` or the Agent SDK never records
   trust, so if you are such a session, tell the user now that this item is theirs. The
   preflight's `trust` line (step 9) confirms it. If it fails, ask the user to run `claude` in
   the project once, answer both, and `/exit`.
5. **Init.** `/autoclaude:init` asks two questions (a Playwright test scaffold, only for a web
   project without end-to-end tests; and whether to install the status line bridge, which records
   usage data for the weekly pause by editing the user-level Claude Code status line once, with a
   backup, keeping any status line already there). Then it writes what is missing and never
   overwrites an existing file:
   - `autoclaude.config.json`, with check commands and a dev server guessed from `package.json`
     (for a dev script that runs a Node file, the port and a `/health` route are read from that
     file); the project's name, used in the plan title and the run branch, comes from
     `package.json` or else the folder's name
   - `CLAUDE.md`, `PLAN.md`, `CONTINUE_HERE.md`, `PROGRESS.md`, and `docs/` with `DECISIONS.md`,
     `BLOCKERS.md`, `DEFERRED.md`, `REVIEW_NOTES.md`, `SECURITY-FINDINGS.md`, `SESSION_LOG.md`
   - `.gitattributes` and `.editorconfig` only if the project has none; entries added to
     `.gitignore`; `.autoclaude/` for run state
   - the project's entry in the machine registry (used by the watchdog and `status --all`)
   - the `autoclaude` command, if it is not installed yet

   From a terminal, `autoclaude init [<folder>] [--playwright] [--no-statusline] [--dev-url <url>]`
   does the file part without asking: it installs the status line bridge unless you pass
   `--no-statusline`, and it does not install the `autoclaude` command. `--dev-url` sets the dev
   server's URL (and `npm run dev` as its command if none was found); `--playwright` adds
   `playwright.config.js` and `e2e/smoke.spec.js`.
6. **Plan.** `/autoclaude:plan`. It reviews an existing project first (where the plan should live,
   every item that would stall an unattended run, rules that conflict with a run, files the run
   may write to, what the run must never touch), then interviews the user and settles every open
   decision. It sets the check commands and the dev server and runs them with `autoclaude checks`.
   It writes `guard.deny` rules and tests them with `autoclaude guard-test`, adds a "During an
   AutoClaude run" section to the project's `CLAUDE.md`, and writes and lints the plan. For a new
   project it also commits a minimal skeleton so the checks pass before the first step. It shows a
   summary to approve, then rewrites `CONTINUE_HERE.md` and commits everything init and planning
   created, on the current branch, so `git status --short` prints nothing. It pushes only if the
   project has a remote and its rules call for it. Things only the user can do go in the plan's
   "Before the run" section.
7. **Existing docs.** If the project already had its own `CONTINUE_HERE.md`, `DECISIONS.md`,
   `SESSION_LOG.md` or similar files, the run will write to them in its own format (it rewrites
   `CONTINUE_HERE.md` before every step and appends to `DECISIONS.md`). `/autoclaude:plan` asks
   the user; the alternative is pointing the matching `docs` key in `autoclaude.config.json` at a
   separate file (section 11).
8. **Alerts.** Run `autoclaude notify-setup --show`. If no channel is set, ask the user whether
   they want Discord or ntfy (section 6). The webhook or topic address is a secret. Suggest they
   run `autoclaude notify-setup` themselves in their own terminal, so it never enters the chat.
   If they paste it and agree, run it for them. Then run `autoclaude notify-test` and ask them to
   confirm the message arrived; you cannot see their phone.
9. **Check.** `autoclaude run --check` runs the preflight without starting anything (section 4).
   Every line must be ok or warn.
10. **Before walking away** (tell the user): do every "Before the run" item in the plan; turn off
    sleep; disconnect instead of signing out; pause or postpone Windows Update restarts; install
    the watchdog; set up remote access (remote desktop over a VPN) if they want to answer
    questions from elsewhere. Section 13 has the details.
11. **Start.** The user opens a new terminal in the project and runs `autoclaude run`. If you are
    Claude, give the user that command instead of running it in your own session: the run opens
    its own window and must outlive your session. In your own session the `autoclaude` command
    may not be on PATH yet; call it by path (section 1) for the steps above.

## 3. The plan

The plan file is ordinary Markdown. AutoClaude reads the phase headings and step lines; everything
else is context for the builder and the decider.

```markdown
# Kitchen todos plan

## Phase 2: Lists
- [ ] **S2.1** Rename a list
  - Accept: each list on /lists has a "Rename" button that turns its name into a text field
  - Accept: pressing Enter saves the new name and it survives a reload
  - Accept: an empty name shows "Name cannot be empty" and keeps the old name
  - Note: sign in as dev@example.test / dev-only-password (dev mode only)
  - Tags: ui
- [ ] **S2.2** Rename checks on the server
  - Accept: PATCH /api/lists/:id with an empty name returns 400 and changes nothing
  - Test: test/lists.test.js
  - Tags: no-ui
```

- The `#` title names the run branch: `autoclaude/<title without "plan">`.
- Phases are `## Phase N: title`, in ascending order. Step IDs are `S<phase>.<n>`, unique and
  ascending within their phase.
- Markers: `[ ]` to do, `[x]` verified, `[!]` failed three times, `[?]` blocked on a question.
  During a run only the gate ticks a box. Between runs you may tick a step (it counts as done)
  or untick one (it is built again), and resume accepts that.
- `Accept:` lines are required. In a step the browser tester checks (every step not tagged
  `no-ui`), each line must be observable from the browser: page content, the URL, or a request
  made from the page. The tester cannot run commands or look in the database, and sees only the
  step's own text. Lines only a test can prove belong in a separate `no-ui` step.
- `Tags:` an untagged step counts as a UI step. `no-ui` skips the browser, so the checks alone
  verify it, and it must name its tests in `Test:`. `security` makes the security reviewer also
  run on that step. `ui` and `db` are labels only.
- `Test:` names the test files the step creates or extends. The gate runs your checks and reads
  their exit codes; it does not check that these files exist, so a `no-ui` step is only as strong
  as the tests the builder writes.
- `- Note:` lines (any indented line that is not a field) stay in the step's text for the builder
  and the tester, for things like a dev-only login or how to create test data.
- `Depends:` is reserved: lint checks that the IDs it names exist, and nothing else uses it yet.
- A step is 20 to 90 minutes of work. The plan is as long as the work needs.
- Also in the plan: "Constraints & decisions" (stack pins, data, security, out of scope, and
  "When something is unclear", the default answers the run applies without asking; the security
  reviewer reads this section too) and "Before the run".

`autoclaude lint-plan` checks the structure: phases and IDs in order, at least one Accept line,
known tags, a `Test:` line on `no-ui` steps, no leftover template placeholders, and no TBD or
TODO in a step. It cannot tell whether an Accept line is observable or a step too big; that is
what `/autoclaude:plan`'s read-through is for. A run will not start on a plan that fails lint.

**Changing the plan.** Only while the run is paused or finished. Commit your edits on the run
branch before resuming, so the next step's commit holds only its own work.

**Adding work after a finished run.** Add new steps (new IDs after the old ones), commit them, and
run `autoclaude run`. It starts a fresh run on the new steps.

## 4. Running

```
autoclaude run
```

Run it from a terminal opened in the project. It runs a preflight first and refuses with FAIL
lines if something is wrong (every item is listed in section 15). `autoclaude run --check` runs
the same preflight without starting anything. When a run was already under way (after a reboot,
or a closed window), `run` checks only the tools and the folder's trust, because mid-step the
working tree is legitimately dirty.

Then it opens a window named `ac-<project>` and the build happens there. You should see the
preflight, then "starting the run in a new window, ac-<project>", and within a few seconds a
Claude Code session in that window starting on the first step.

- **The folder belongs to the run.** The run switches this folder to the branch
  `autoclaude/<plan title>`, commits one step at a time and tags each phase end `ac-phase-<n>`.
  While it runs, do not edit files, commit, switch branches or start the app on the dev server's
  port in this folder; use a separate clone for other work. Opening your own Claude Code session
  here to look around is safe: the run's hooks leave it alone.
- **PATH.** The run window inherits the PATH of the terminal that ran `autoclaude run`, and the
  builder, the checks and the gate inherit it from there. Start it from a terminal where
  `node --version`, `git --version` and your project's own tools all work. A window reopened by the
  watchdog gets your saved user environment instead, so put those tools on your user PATH
  permanently.
- **Watching.** `autoclaude status` shows the state, current step, attempts, usage, the supervisor
  and the last progress; `autoclaude status --all` lists every project registered on this machine
  (by `init` or `run`). The window shows the builder at work. Closing the window stops the run
  until `autoclaude run`, or the watchdog, brings it back.
- **Files the run keeps up to date:**

| File | What is in it |
|---|---|
| `PROGRESS.md` | One line per verified step |
| `CONTINUE_HERE.md` | Where the builder is, rewritten before every step is handed in |
| `docs/DECISIONS.md` | Decisions taken during the run (`D-###`) and how review notes were handled (`N-###`) |
| `docs/BLOCKERS.md` | Follow-ups: medium and low bugs the testers found that did not fail a step |
| `docs/SECURITY-FINDINGS.md` | Security findings below the blocking level, from steps that passed |
| `.autoclaude/reports/` | A report for every failed verification, and each checker's verdict and screenshots |
| `.autoclaude/logs/` | `gate.log`, `supervisor.log`, `hooks.log`, `devserver.log`, `notify.log`, `denials.log`, `stopfailure.log` |

**A one-off prompt.** `autoclaude nudge "<prompt>"` restarts the builder with that prompt on the
supervisor's next check, for example `autoclaude nudge "/compact"`. It never interrupts a
verification, and when the prompt finishes the builder carries on with the plan.

## 5. Pausing, notes, resuming and stopping

```
autoclaude pause
autoclaude pause --now
autoclaude note "use the existing date helper for due dates"
autoclaude resume
```

- `pause` pauses after the next verified commit. The gate stops the dev server and sends a
  message.
- `pause --now` pauses at once. It stops the dev server, and the supervisor ends the builder
  session on its next check, within a minute (even in the middle of a verification). Unfinished
  work stays in the working tree, uncommitted. On resume the current step starts again with
  fresh attempts.
- `note` leaves a note for the builder. It arrives in the gate's next message, at the next resume
  or at the next session start, whichever comes first. The builder handles each note first and
  records what it did as `N-###` in `docs/DECISIONS.md`.
- `resume` carries on. Resume from a terminal. `/autoclaude:resume` typed into your own Claude
  Code session only runs the same command there; the builder in the run window does the work.
  `resume` refuses if the plan fails lint after your edits. If the run window is gone,
  `autoclaude run` brings it back first.

To pause on a schedule, set `review.pauseAt` in the config: `phase-end` pauses after the last step
of each phase, `every-step` after every step, `never` (the default) only when asked.

| You want to | Do |
|---|---|
| Stop for the day | `autoclaude pause` (or `--now`), wait for the window to go quiet, close it if you like |
| Carry on the next day | `autoclaude resume`; if the window is gone, `autoclaude run` first |
| Abandon a run | `autoclaude pause --now`, close the window; the branch stays for you to keep or delete |
| Carry on after a reboot, run was running | Sign in; the watchdog reopens it within 5 minutes, or run `autoclaude run` |
| Carry on after a reboot, run was paused | `autoclaude run`, then `autoclaude resume` |

## 6. Alerts

Two channels, set once per machine:

- **Discord.** In a channel you watch, open the channel settings, Integrations, Webhooks, create a
  webhook and copy its URL. Then `autoclaude notify-setup --discord "<webhook url>"`.
- **ntfy.** Pick a hard-to-guess topic name, subscribe to it in the ntfy phone app, then
  `autoclaude notify-setup --ntfy "https://ntfy.sh/<topic>"`. For a protected topic add
  `--ntfy-token <token>`.

Setting one address also selects that channel; the last one you set wins, and
`--channel discord|ntfy|stdout` selects one explicitly. `autoclaude notify-setup --show` shows the
setting with the secrets masked, `--clear` removes it, and `autoclaude notify-test` sends a test:
it prints "sent through discord (HTTP 204)" or similar, and the message "AutoClaude test" should
arrive within seconds.

The setting lives in `<Claude config folder>/autoclaude/notify.json` (`~/.claude` unless
`CLAUDE_CONFIG_DIR` is set), never in a repository. Claude Code's plugin settings for AutoClaude
(`/plugin`, AutoClaude, configure) offer the same values; at the start of each session they fill
in only what `notify.json` does not have yet. Use one place: `notify-setup`.

What sends a message:

| Event | Priority |
|---|---|
| A step failed 3 times, and the run paused | High |
| The builder stopped on a critical question (section 7) | High |
| The builder stopped 3 times in a row without doing anything (stuck) | High |
| The supervisor could not recover the session (two restarts without progress) | High |
| A checker (browser tester, bug bash, security reviewer) could not run twice in a row | High |
| A verified step could not be committed | High |
| The session is waiting at a permission or input prompt nobody can answer | High, at most one per 30 minutes |
| More than 10 denied actions in an hour (the builder may be stuck on a forbidden approach) | High, at most one per hour |
| The weekly usage threshold was reached | Default |
| Resumed by itself after the weekly reset (only with `autoResumeAfterWeeklyReset`) | Default |
| Paused for review (`pause`, or `review.pauseAt`) | Default |
| Plan complete, with a summary | Default |
| Morning summary (only if `notify.morningSummaryAt` is set) | Low |

Everything else goes only to the logs: routine decisions, retries that later pass, waits for the
5-hour limit to reset, successful restarts, and `pause --now` (you asked for it).

## 7. Answering a blocked question

When the builder needs a decision only you can make (a secret, a paid service, something
destructive, a security trade-off, a contradiction in the plan), it marks the step `[?]`, pauses
the run and sends the question with its options. Answer from any terminal in the project:

```
autoclaude answer "b, and keep the old endpoint for a month"
```

The answer is recorded as the next `D-###` in `docs/DECISIONS.md`, the step goes back to `[ ]`,
and the run resumes with your answer in front of the builder. If you type the answer into the run
window instead, the builder records it with `autoclaude answer` itself; check that
`autoclaude status` says running afterwards.

This needs a terminal on the machine: in person, or over remote desktop. The run waits until then.

## 8. Recovery: what happens on its own

The supervisor checks the builder every minute:

| Situation | What it does |
|---|---|
| The session exited or crashed | Restarts it by its session ID (`claude --resume <id>`), which continues the same conversation |
| That restart dies at once (no saved conversation) | Opens a fresh session under a new ID; the run context is injected again |
| The session sits idle at its prompt | Restarts it after 15 minutes |
| No activity for 45 minutes and the session reports idle | Restarts it |
| No activity for 90 minutes, busy or status unknown | Restarts it |
| A verification is running (it can take 20 minutes or more) | Waits; that counts as activity |
| An API error ended the turn | Restarts it after a minute |
| You resumed, but the session did not pick it up | Restarts it after 2 minutes |
| The 5-hour usage limit was hit | Waits for the reset plus 10 minutes, then continues |
| A usage-limit stop with weekly usage at 99% or more | Pauses as `weekly-limit` |
| A nudged prompt finished | Continues with the plan at once |
| Two restarts in a row without progress | Pauses as stuck and messages you |

After any restart the builder gets the run rules, the current step and the recent progress again,
and looks at `git status` and the diff before carrying on. The watchdog, if installed, reopens the
whole window when the supervisor itself is gone (section 1 has its limits). After a reboot, sign
in and run `autoclaude run` in the project, or let the watchdog do it.

## 9. Pause reasons and what to do

`autoclaude status` shows why a run is paused.

| Reason | What happened | What to do |
|---|---|---|
| `review` | You asked for it, or `review.pauseAt` | Look, leave notes, `autoclaude resume` |
| `blocked` | The builder needs your decision | `autoclaude answer "..."` (section 7) |
| `step-failed` | A step failed its last attempt and is marked `[!]`. A dev server that will not start counts as a failed attempt too | Read the latest report in `.autoclaude/reports/`, fix the code or rewrite the step, `autoclaude resume` |
| `security` | The last attempt failed on a security finding at or above `security.blockOn`; the step is marked `[!]` | Read the findings in the latest report (`SECURITY-FINDINGS.md` holds only non-blocking ones), decide, `autoclaude resume` |
| `stuck` | The builder stopped making progress | Look at the run window, `.autoclaude/logs/supervisor.log` and `.autoclaude/logs/gate.log`, then `autoclaude resume` |
| `infra` | The browser tester, the bug bash or the security reviewer could not run twice (usually Playwright or the `claude` command) | Fix the named tool, `autoclaude resume` |
| `commit-failed` | A step passed but git could not commit it; the work is safe in the working tree | Fix git (often: git not on the PATH the run started with), then `autoclaude resume`, which commits it first |
| `weekly-limit` | Weekly usage reached `usage.weeklyPauseAtPct` (between steps), or 99% when a usage limit stopped the builder | Wait for the reset and `autoclaude resume`, or set `usage.autoResumeAfterWeeklyReset` |

## 10. After the run

The plan-complete message summarises the run. Then:

1. Read the commits on the run branch (`git log`), `docs/DECISIONS.md` for choices the builder
   made, `docs/BLOCKERS.md` for follow-ups, and `docs/SECURITY-FINDINGS.md`.
2. Try the result yourself.
3. Merge the branch the way your project merges, and push.

The run window stays open with the builder idle, so you can ask it about the run. Closing it ends
the supervisor.

## 11. Configuration reference

`autoclaude.config.json` in the project root. Every key is optional; these are the defaults.

```json
{
  "version": 1,
  "plan": "PLAN.md",
  "branch": "autoclaude/{planSlug}",
  "devServer": { "command": null, "url": null, "healthPath": "/", "startTimeoutSec": 90 },
  "checks": [],
  "tester": { "enabled": true, "model": "sonnet", "maxTurns": 40, "timeoutSec": 900 },
  "security": { "when": ["phase-end", "tag:security"], "blockOn": "high", "model": "opus", "timeoutSec": 900 },
  "bugBash": { "atPhaseEnd": true },
  "retries": { "maxAttemptsPerStep": 3, "maxNoProgressStops": 3, "maxMinutesPerStep": 120 },
  "usage": { "weeklyPauseAtPct": 85, "autoResumeAfterWeeklyReset": false, "staleAfterMin": 30 },
  "git": { "commitEachStep": true, "tagPhaseEnds": true, "push": false },
  "gate": { "timeoutSec": 1800 },
  "notify": { "morningSummaryAt": null },
  "review": { "pauseAt": "never" },
  "supervisor": { "pollSec": 60, "idleRelaunchMin": 15, "stallMin": 45, "resumeGraceMin": 2, "rateLimitGraceMin": 10, "maxRecoveries": 2 },
  "guard": { "deny": [] },
  "docs": {
    "progress": "PROGRESS.md", "continueHere": "CONTINUE_HERE.md", "decisions": "docs/DECISIONS.md",
    "blockers": "docs/BLOCKERS.md", "security": "docs/SECURITY-FINDINGS.md",
    "reviewNotes": "docs/REVIEW_NOTES.md", "sessionLog": "docs/SESSION_LOG.md"
  }
}
```

| Key | Meaning |
|---|---|
| `plan` | The plan file, if it is not `PLAN.md` |
| `branch` | The run branch; `{planSlug}` comes from the plan's `#` title |
| `devServer` | How to start the app for the browser checks: `command`, the `url` it serves, the `healthPath` that answers when it is up, and how long to wait. A wrong URL fails every UI step; an empty one skips the browser checks |
| `checks` | Commands the gate runs on every step, in order, stopping at the first failure: `{ "name", "command", "timeoutSec", "needsDevServer" }`. `name` and `command` are required; `timeoutSec` defaults to 900; `needsDevServer: true` starts the dev server first and needs `devServer` set. Each must exit non-zero on failure. They run in `cmd.exe` on Windows and `/bin/sh` elsewhere; `autoclaude checks` runs them the same way |
| `tester` | The browser tester: model, turn budget (`maxTurns` tool calls; the bug bash gets one and a half times that), time limit |
| `security` | When the security reviewer runs (`phase-end`, `tag:security`, `every-step`, `never`), and the lowest severity that fails a step (`high`, `medium`, `low`, `none`) |
| `bugBash.atPhaseEnd` | Run the bug bash on the last step of each phase that has a UI step |
| `retries` | `maxAttemptsPerStep`: attempts before a step pauses the run. `maxNoProgressStops`: stops in a row with no tool use and no new commit before the gate pauses as stuck. `maxMinutesPerStep` is accepted but not enforced yet |
| `usage` | The weekly pause threshold between steps, whether to resume by itself after the weekly reset, and how old usage data may be before it is ignored |
| `git` | Commit each verified step, tag phase ends, and whether the builder may push during the run (the gate itself never pushes) |
| `gate.timeoutSec` | The time budget for the browser tester, bug bash and security reviewer within one verification; at most 1800, which is Claude Code's limit for the hook that runs the gate. Each check has its own `timeoutSec` |
| `notify.morningSummaryAt` | `"HH:MM"` local time for a daily summary, or `null` |
| `review.pauseAt` | `never`, `phase-end` or `every-step` |
| `supervisor` | `pollSec` (seconds between checks), `idleRelaunchMin`, `stallMin`, `resumeGraceMin`, `rateLimitGraceMin` (minutes; section 8), and `maxRecoveries` (restarts without progress before a stuck pause) |
| `guard.deny` | Extra commands the run may never execute (section 12): `{ "pattern": "<regular expression>", "reason": "<what to do instead>" }` |
| `docs` | Where the run writes its documents. `sessionLog` is informational; the project's `CLAUDE.md` decides whether a session log is kept |

**Usage data.** The weekly pause and `autoclaude usage` need Claude Code's usage percentages. The
status line bridge that `init` installs records them from Claude Code's status line. Without it,
AutoClaude falls back to a value Claude Code caches, which is sometimes missing. The preflight
warns when it has no fresh data, and a run with no usage data never pauses between steps for the
weekly limit.

## 12. What a run may and may not do

The builder runs in Claude Code's `auto` permission mode: it acts without asking you, and Claude
Code's own safety checks still block risky actions. On top of that, while a run is active,
AutoClaude:

- denies questions to you (the builder decides, asks the decider, or stops with `blocked`)
- denies edits to the plan, `autoclaude.config.json` and `.autoclaude/`; commits by the builder
  (the gate commits); pushing unless `git.push` is true; force pushes; `git reset --hard`; and
  recursive deletes outside the project folder
- denies every command matching a `guard.deny` rule
- auto-denies any permission prompt, with guidance, so the session never sits waiting

These shell rules cover the Bash and PowerShell tools and match the text of the typed command.
They are best-effort: a script that does something forbidden inside it (for example a deploy
script run by an npm script) is not caught unless its own name is in `guard.deny`. Name every
script, host and tool that reaches outside the project; `autoclaude guard-test "<command>"` shows
what a rule blocks. A harmless read that mentions a blocked name is denied too, and counts
towards the "more than 10 denials" alert.

Keep secrets out of the plan and the repository: a step that needs one is a question for you.
The real boundary is the account the run uses: on a machine that can reach things that matter
(servers, production databases, other repositories), run AutoClaude under an account that cannot
(section 13).

These rules apply only to the builder. Your own Claude Code sessions in the project are left alone
while the supervisor runs.

## 13. Windows notes

- **Disconnecting is fine; signing out is not.** An RDP disconnect or a locked screen keeps the
  run window alive. Signing out, restarting or sleeping ends it. On Windows Server, check that no
  disconnected-session time limit is set (Group Policy: Remote Desktop Session Host, Session Time
  Limits), or a disconnect turns into a sign-out after that time.
- **Sleep.** Turn sleep off while a run is going:
  `powercfg /change standby-timeout-ac 0` (and `standby-timeout-dc 0` on a laptop on battery).
- **Windows Update.** Pause updates or set active hours to cover the run, so an update restart
  does not end it.
- **A standard user account.** Consider running AutoClaude under a Windows account without
  administrator rights. Then even a command that slips past every check cannot change the system.
- **Fresh terminals.** After an install, open a new terminal. Editors keep the PATH they started
  with, so an integrated terminal may not see `autoclaude`, node or git until the editor is
  restarted.
- **The watchdog task** runs only while you are signed in, because the run window lives on your
  desktop. It starts a hidden script, so nothing flashes on screen every 5 minutes.
- **PowerShell and Git Bash** both work for the CLI. Git Bash rewrites arguments that start with
  `/` into file paths; `autoclaude nudge "/compact"` corrects that itself, but for other commands
  prefer PowerShell when an argument starts with `/`.

## 14. Linux and macOS notes

These paths are covered by tests but have not been tried on a real machine yet.

- tmux is required. `autoclaude run` starts the supervisor in a detached tmux session named
  `ac-<project>`; watch it with `tmux attach -t ac-<project>`.
- `autoclaude watchdog --install` sets up a systemd user timer. For it to run while you are
  logged out, enable lingering: `loginctl enable-linger $USER`. Without systemd it prints a
  crontab line to add with `crontab -e`.
- On macOS, keep the machine awake during a run, for example with `caffeinate -i` in another
  terminal.
- `install-cli` writes the shim to `~/.local/bin` and prints the line to add to your shell profile
  if that folder is not on your PATH.

## 15. Troubleshooting

**Preflight lines** (`autoclaude run --check` prints them all). Any FAIL stops the run; warn lines
do not.

| Line | Means | Fix |
|---|---|---|
| `FAIL plan` | The plan file is missing, fails lint, or every step is already verified | `autoclaude lint-plan`; or add steps |
| `FAIL git` | git is missing, the folder is not a repository, or there are uncommitted changes | Commit or stash; `git init` for a new project |
| `FAIL git-cli`, `FAIL node` | That tool is not on this terminal's PATH | Use a terminal where it is |
| `FAIL claude` | No native Claude Code install | Section 1 |
| `FAIL tmux` | Linux or macOS without tmux | Install tmux |
| `FAIL trust` | Claude Code was never opened in this folder, or its first-run questions are unanswered | Run `claude` in the project once, answer, `/exit` |
| `warn checks` | No checks configured; only the browser tester and the reviewers verify steps | Add checks (section 11) |
| `FAIL checks` | A check's program is missing, its npm script does not exist, or it needs a dev server that is not configured | Fix the command or the tool |
| `FAIL playwright` | UI steps and a dev server are configured, but Chromium is not installed | `npx playwright install chromium` (`npx.cmd` in PowerShell) |
| `FAIL dev server` | The dev server did not start or answer at `devServer.url` | Run `devServer.command` by hand; check the URL, `healthPath` and `startTimeoutSec` |
| `warn dev server` | Not running yet, but the next step is `no-ui`; or no dev server is configured, so UI steps are not checked in a browser | Nothing, if that is expected |
| `FAIL usage` | Weekly usage is at or over `usage.weeklyPauseAtPct` | Wait for the reset, or raise the threshold |
| `warn usage` | No fresh usage data | Start any Claude Code session once |
| `warn notify` | No alert channel | Section 6 |

**Other problems.**

| Symptom | Cause and fix |
|---|---|
| `autoclaude: command not found` | Open a new terminal after `install-cli`, or restart the editor, or call the shim by full path (section 1) |
| The run window sits on a theme picker or a trust question | Same as `FAIL trust` |
| Every step fails on the same check from the start | The checks fail on the current code. Fix that before the run, or make it the plan's first step |
| "Browser checks skipped" in a report | `devServer` is not set; UI steps are then verified by the checks alone |
| "Dev server reused" in a report | Something else already answers at `devServer.url`, possibly an old copy of the app. Stop it |
| A check says "NOT RUN" | It needs the dev server, which is not configured or did not start |
| No alerts arrive | `autoclaude notify-test`; then `.autoclaude/logs/notify.log` in the project and `~/.claude/autoclaude/logs/notify.log` |
| Paused as `commit-failed` | git was missing or broken for the run; section 9 |
| Usage shows unknown | Start any Claude Code session so the status line bridge records usage; `autoclaude usage` |
| The builder keeps getting denied | `.autoclaude/logs/denials.log` shows what it tried; a `guard.deny` rule or a plan step may need changing |

Logs: the project's `.autoclaude/logs/` for a run; `~/.claude/autoclaude/logs/` for the watchdog
and machine-level alerts.

## 16. Updating and uninstalling

**Update.** Pause a running run first (`autoclaude pause --now`), then:

```
claude plugin marketplace update autoclaude
claude plugin update autoclaude@autoclaude
```

Then close the run window and start it again with `autoclaude run` (a running supervisor keeps the
old code until then), start new Claude Code sessions, and `autoclaude resume`. The `autoclaude`
command and the watchdog follow the new version by themselves. `claude plugin list` shows the
installed version.

**Uninstall.**

```
autoclaude uninstall
claude plugin uninstall autoclaude@autoclaude
claude plugin marketplace remove autoclaude
```

`autoclaude uninstall` removes the watchdog, the status line bridge (your previous status line
comes back) and the command's files. On Windows it also removes its folder and PATH entry; on
Linux and macOS it leaves `~/.local/bin` and your PATH alone, because other tools use them. Add
`--purge` to also delete the machine settings: the alert channel, the project registry and the
logs. Project files (`autoclaude.config.json`, `.autoclaude/`, the docs `init` wrote) stay in each
project; delete them by hand if you no longer want them.

## 17. Command reference

`autoclaude help` prints the same list.

| Command | What it does |
|---|---|
| `init [<folder>] [--playwright] [--no-statusline] [--dev-url <url>]` | Set a project up (section 2) |
| `run [--check]` | Preflight, then open the run window; `--check` runs only the preflight |
| `status [--all]` | The run's state; `--all` for every registered project |
| `pause [--now]` | Pause after the next verified commit, or at once |
| `note "<text>"` | Leave a note for the builder |
| `resume` | Carry on after a pause |
| `answer "<text>"` | Answer a blocked question |
| `nudge "<prompt>"` | Restart the builder with a one-off prompt |
| `lint-plan [file]` | Check the plan's structure |
| `checks` | Run the configured checks exactly as the gate does |
| `guard-test "<command>"` | Show whether the guard would deny a command, for the Bash and PowerShell tools |
| `usage` | The 5-hour and weekly usage Claude Code last reported |
| `install-cli [--no-path]` | Install the `autoclaude` command |
| `notify-setup [--discord <url>] [--ntfy <url>] [--ntfy-token <token>] [--channel <name>] [--show] [--clear]` | Set the alert channel for this machine |
| `notify-test [message]` | Send a test alert |
| `watchdog [--install \| --uninstall \| --status]` | The scheduled watchdog |
| `uninstall [--purge]` | Remove AutoClaude's machine-level pieces |
| `start`, `supervise`, `ready`, `blocked` | Used by the run itself; you do not need them |
