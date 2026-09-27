# AutoClaude usage guide

This guide is for anyone setting up AutoClaude on their own machine, and for Claude when a user
asks it to add AutoClaude to a project. Nothing here assumes you have seen this repository before.

Contents:

1. [Install, once per machine](#1-install-once-per-machine)
2. [Adding AutoClaude to a project](#2-adding-autoclaude-to-a-project)
3. [The plan](#3-the-plan)
4. [Running](#4-running)
5. [Pausing, notes and resuming](#5-pausing-notes-and-resuming)
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

## 1. Install, once per machine

### Requirements

| What | Why | Check |
|---|---|---|
| Claude Code, native install | The run is an interactive Claude Code session. The copy bundled inside an editor extension is not enough | `claude --version` in a terminal |
| A Claude subscription, signed in | The run uses your usage; usage limits and percentages come from it | `claude` starts without asking you to log in |
| Node.js 24 or newer | The plugin and the CLI are plain Node, with no packages to install | `node --version` |
| git | The gate commits every verified step | `git --version` |
| Git for Windows (Windows only) | Claude Code's shell on Windows is Git Bash | `bash --version` |
| Chromium for Playwright (web UI projects) | The browser tester and the bug bash drive a headless browser | `npx playwright install chromium` |
| Read access to this repository | It is private; you need an invitation | see below |

### Access to the private repository

Accept the GitHub invitation, then make sure git can read the repository from the command line,
by either of:

- the GitHub CLI: `gh auth login`, then `gh auth setup-git`
- an SSH key added to your GitHub account (`ssh -T git@github.com` greets you by name)

Test it with `git ls-remote https://github.com/chaoticnewfie/autoclaude.git` or
`git ls-remote git@github.com:chaoticnewfie/autoclaude.git`.

### Install the plugin

```
claude plugin marketplace add chaoticnewfie/autoclaude
claude plugin install autoclaude@autoclaude
```

The first command clones the repository into Claude Code's plugin folder. If it cannot, add it by
full address instead, using whichever form your credentials work with:
`claude plugin marketplace add https://github.com/chaoticnewfie/autoclaude.git` or
`claude plugin marketplace add git@github.com:chaoticnewfie/autoclaude.git`.

The install may say that 4 userConfig options are not set. You can ignore that: they are an
optional second place for the alert settings (section 6).

### Install the `autoclaude` command

`/autoclaude:init` does this for you the first time (section 2). To do it by hand, run the CLI
from the plugin folder once. Claude Code records that folder in
`~/.claude/plugins/installed_plugins.json` under `autoclaude@autoclaude`, as `installPath`:

```
node "<installPath>/bin/autoclaude.js" install-cli
```

This writes a small launcher and two shims (`autoclaude` for Git Bash and other sh shells,
`autoclaude.cmd` for PowerShell and cmd) into a per-user folder and adds that folder to your
user PATH. Terminals that were already open, and every terminal inside an editor that was
already running, keep the old PATH: open a new one, or restart the editor. The launcher finds
the current plugin version each time, so plugin updates never break the command.

Where the folder is: `%LOCALAPPDATA%\autoclaude\bin` on Windows, `~/.local/bin` on Linux and
macOS.

### Alerts

```
autoclaude notify-setup --discord <webhook url>
autoclaude notify-setup --ntfy <topic url> [--ntfy-token <token>]
autoclaude notify-test
```

Details in section 6. The setting is per machine and lives outside every repository.

### The watchdog (optional, recommended for long runs)

```
autoclaude watchdog --install
```

A scheduled task (Windows Task Scheduler, or a systemd user timer on Linux) runs every 5 minutes
and reopens the run window of any project whose run is marked running but whose supervisor is
gone. `autoclaude watchdog --status` shows it; `--uninstall` removes it.

## 2. Adding AutoClaude to a project

This section is a checklist. If you are Claude doing this for a user, work through it in order,
tell the user what you are doing at each step, and ask them only what the checklist says to ask.

1. **Install check.** `claude plugin list` shows `autoclaude@autoclaude`. If not, do section 1
   first. Plugins load when a session starts, so after installing, the user starts a new Claude
   Code session in the project for the `/autoclaude:...` commands to exist.
2. **Git.** The project must be a git repository with at least one commit, and the working tree
   must be clean before a run. For a brand new project: `git init`, then a first commit.
3. **Trust.** Claude Code must have been opened once in the project folder, with its folder-trust
   question answered. An unattended session cannot answer it. Opening `claude` there once does it.
4. **Init.** In a Claude Code session in the project: `/autoclaude:init`. It writes what is
   missing and never overwrites a file that exists:
   - `autoclaude.config.json`, with the check commands and dev server it detected
   - the doc set: `CLAUDE.md`, `PLAN.md`, `CONTINUE_HERE.md`, `PROGRESS.md`, and `docs/` with
     `DECISIONS.md`, `BLOCKERS.md`, `DEFERRED.md`, `REVIEW_NOTES.md`, `SECURITY-FINDINGS.md`,
     `SESSION_LOG.md`
   - `.gitignore`, `.gitattributes` and `.editorconfig` entries, and `.autoclaude/` for run state
   - the project's entry in the machine registry (used by the watchdog and `status --all`)
   - the status line bridge (asks first; see section 11, "Usage data")
   - the `autoclaude` command, if it is not installed yet

   The same thing from a terminal: `autoclaude init [--playwright] [--no-statusline]
   [--dev-url <url>]`.
5. **Review the config.** Open `autoclaude.config.json`. `checks` must list commands that exit
   non-zero on failure (tests, lint, type check). `devServer` must start the app and name its URL
   if the project has a web UI. Section 11 has every setting.
6. **Plan.** `/autoclaude:plan`. For a project that already has code, a plan or rules, it first
   reviews them:
   - where the AutoClaude plan should live, if the existing plan file must stay as it is
   - every existing item that would stall an unattended run, with a proposed fix
   - project rules that conflict with a run (for example "commit and push after every change"),
     and a short "During an AutoClaude run" section for the project's `CLAUDE.md`
   - what the run must never touch outside the project, written as `guard.deny` rules
   - whether every check command really runs on this machine, and what to install if not

   Then it interviews the user, settles every open decision, writes the plan, lints it, and
   shows the user a summary to approve. Prerequisites the user must handle before the run go in
   the plan's "Before the run" section.
7. **Commit.** The plan, the config and the doc changes are committed. A run refuses a dirty
   working tree.
8. **Alerts.** `autoclaude notify-test` reaches the user's phone or channel (section 6).
9. **Start.** The user does every "Before the run" item, opens a new terminal in the project and
   runs `autoclaude run`. If you are Claude, give the user that command instead of running it in
   your own session: the run opens its own window and must outlive your session.

## 3. The plan

`PLAN.md` (or the file named by `plan` in the config) is ordinary Markdown. AutoClaude reads the
phase headings and step lines; everything else is context for Claude.

```markdown
## Phase 2: Lists
- [ ] **S2.1** Rename a list
  - Accept: each list on /lists has a "Rename" button that turns its name into a text field
  - Accept: pressing Enter saves the new name and it survives a reload
  - Accept: PATCH /api/lists/:id with an empty name returns 400 and changes nothing
  - Test: test/lists.test.js
  - Tags: ui
```

- Phases are `## Phase N: title`. Step IDs are `S<phase>.<n>`, unique.
- Markers: `[ ]` to do, `[x]` verified (only the gate writes it), `[!]` failed three times,
  `[?]` blocked on a question.
- `Accept:` lines are required and must be observable: something in the browser, an HTTP
  response, a passing test, a command's output.
- `Tags:` `ui` (checked in the browser), `no-ui` (nothing to see; the browser tester skips it, so
  the checks alone verify it and it should name its tests), `security` (the security review also
  runs on this step), `db`.
- `Test:` names the test files the step creates or extends.
- A step is 20 to 90 minutes of work. The plan is as long as the work needs.
- The plan also carries "Constraints & decisions" (stack, data, out of scope, and "When something
  is unclear": the default answers the run applies without asking), and "Before the run".

`autoclaude lint-plan` checks the format; a run will not start on a plan that fails it.

**Changing the plan.** Only while the run is paused or finished, never while it runs. Resume
accepts your changes: a box you ticked counts as done, a box you unticked is done again, and a
failed or blocked step starts over with fresh attempts. To add work after a finished run, add
steps (new IDs after the old ones) and run `autoclaude run` again.

## 4. Running

```
autoclaude run
```

Run it from a normal terminal opened in the project. It runs a preflight first (git, a clean
working tree, the plan, the config, the check commands, the dev server, Playwright, usage, the
alert channel, Claude Code's first-run and folder-trust settings, node and git on PATH) and
refuses with a list of FAIL lines if something is wrong. Then it opens a new window named
`ac-<project>`, and the build happens there. The window inherits the PATH of the terminal you
started it from, so start it from a terminal that has node, git and your project's tools.

The run works on a branch named `autoclaude/<plan name>`, one commit per verified step, tagged
`ac-phase-<n>` at each phase end. It does not push unless you allow it (section 11).

**Watching.**

- `autoclaude status` in the project: state, current step, attempts, usage, last progress.
  `autoclaude status --all` lists every project on the machine.
- The `ac-<project>` window shows the Claude Code session doing the work. Leave it open. Closing
  it does not stop the run: with the watchdog installed, a new window opens within 5 minutes. To
  stop, use `autoclaude pause`.
- Files in the project, updated as it goes:

| File | What is in it |
|---|---|
| `PROGRESS.md` | One line per verified step |
| `CONTINUE_HERE.md` | Where the builder is, rewritten before every step is handed in |
| `docs/DECISIONS.md` | Every decision taken during the run (`D-###`) and how review notes were handled (`N-###`) |
| `docs/BLOCKERS.md` | Follow-ups: medium and low bugs the testers found that did not fail a step |
| `docs/SECURITY-FINDINGS.md` | Security findings below the blocking level |
| `.autoclaude/reports/` | A report for every verification, pass or fail, with the testers' evidence and screenshots |
| `.autoclaude/logs/` | `gate.log`, `supervisor.log`, `hooks.log`, `devserver.log`, `notify.log`, `denials.log` |

**Sending a one-off prompt.** `autoclaude nudge "<prompt>"` restarts the session with that prompt
on the supervisor's next pass, for example `autoclaude nudge "/compact"`. It never interrupts a
verification, and when the prompt finishes the run carries on with the plan.

## 5. Pausing, notes and resuming

```
autoclaude pause           pause after the next verified commit
autoclaude pause --now     pause right away (the current step keeps its attempt count)
autoclaude note "text"     leave a note for Claude; it is read at the next resume or session start
autoclaude resume          carry on
```

A pause stops the dev server and sends a message. While paused you can read the code, run the
app, edit the plan or leave notes. Claude handles each note first after the resume, and records
what it did as `N-###` in `docs/DECISIONS.md`.

To pause on a schedule, set `review.pauseAt` in the config: `phase-end` pauses after the last
step of each phase, `every-step` after every step, `never` (the default) only when asked.

`autoclaude resume` refuses if the plan fails lint after your edits. If the run window is gone,
`autoclaude run` brings it back.

## 6. Alerts

Two channels, set once per machine:

- **Discord**: create a webhook in a channel you watch (channel settings, Integrations, Webhooks)
  and run `autoclaude notify-setup --discord <webhook url>`.
- **ntfy**: pick a hard-to-guess topic, subscribe to it in the ntfy phone app, and run
  `autoclaude notify-setup --ntfy https://ntfy.sh/<topic>` (add `--ntfy-token <token>` for a
  protected topic).

`autoclaude notify-setup --show` shows the setting (secrets masked), `--clear` removes it, and
`autoclaude notify-test` sends a test. The setting lives in `~/.claude/autoclaude/notify.json`,
never in a repository. You can also enter the same values in Claude Code's plugin settings
(`/plugin`, AutoClaude, configure); those take precedence for sessions started by Claude Code.

What sends a message:

| Event | Priority |
|---|---|
| A step failed 3 times, and the run paused | High |
| Claude stopped on a critical question (section 7) | High |
| The session is waiting at a permission or input prompt nobody can answer | High |
| The supervisor could not recover the session (two relaunches without progress) | High |
| A checker (browser tester, bug bash, security review) could not run twice in a row | High |
| A verified step could not be committed | High |
| Many denied actions in the last hour (the run may be stuck on a forbidden approach) | High |
| The weekly usage threshold was reached | Default |
| Paused for review | Default |
| Plan complete, with a summary | Default |
| Morning summary (only if `notify.morningSummaryAt` is set) | Low |

Everything else goes only to the logs: routine decisions, retries that later pass, waits for the
5-hour limit to reset, and successful restarts.

## 7. Answering a blocked question

When Claude needs a decision only you can make (a secret, a paid service, something destructive,
a security trade-off, a contradiction in the plan), it marks the step `[?]`, pauses the run and
sends the question with its options. Answer from any terminal in the project:

```
autoclaude answer "b, and keep the old endpoint for a month"
```

The answer is recorded as the next `D-###` in `docs/DECISIONS.md`, the step goes back to `[ ]`,
and the run resumes with your answer in front of Claude. Typing the answer into the run window
works too.

## 8. Recovery: what happens on its own

The supervisor checks the session every minute:

| Situation | What it does |
|---|---|
| The session exited or crashed | Restarts it with `claude --continue`, which resumes the same conversation |
| The session sits idle at its prompt | Restarts it after 15 minutes |
| No activity for 45 minutes (90 if the session still reports busy) | Restarts it |
| A verification is running (it can take 20 minutes or more) | Waits; that counts as activity |
| An API error ended the turn | Restarts it after a minute |
| The 5-hour usage limit was hit | Waits for the reset, then continues |
| The weekly usage limit is reached | Pauses (section 9) |
| Two restarts in a row without progress | Pauses as stuck and messages you |

After a restart, Claude gets the run rules, the current step and the recent progress again, and
checks the working tree before carrying on. The watchdog, if installed, reopens the whole window
when the supervisor itself is gone. After a reboot, log in and run `autoclaude run` in the
project (or let the watchdog do it).

## 9. Pause reasons and what to do

`autoclaude status` shows why a run is paused.

| Reason | What happened | What to do |
|---|---|---|
| `review` | You asked for it, or `review.pauseAt` | Look, leave notes, `autoclaude resume` |
| `blocked` | Claude needs your decision | `autoclaude answer "..."` (section 7) |
| `step-failed` | A step failed 3 attempts; it is marked `[!]` | Read the latest report in `.autoclaude/reports/`, fix the code or rewrite the step, `autoclaude resume` |
| `security` | A security finding at or above `security.blockOn` survived 3 attempts | Read the report and `docs/SECURITY-FINDINGS.md`, decide, `autoclaude resume` |
| `stuck` | The session stopped making progress | Look at the run window and `.autoclaude/logs/supervisor.log`, then `autoclaude resume` |
| `infra` | A checker could not run twice (Playwright, the dev server, or the claude CLI) | Fix the named tool, `autoclaude resume` |
| `commit-failed` | A step passed but git could not commit it; the work is safe in the working tree | Fix git (often: git not on the PATH the run started with), then `autoclaude resume`, which commits it first |
| `weekly-limit` | Weekly usage reached `usage.weeklyPauseAtPct` | Wait for the reset and `autoclaude resume`, or set `usage.autoResumeAfterWeeklyReset` |

## 10. After the run

The plan-complete message summarises the run. Then:

1. Read the commits on the run branch (`git log`), `docs/DECISIONS.md` for choices Claude made,
   `docs/BLOCKERS.md` for follow-ups, and `docs/SECURITY-FINDINGS.md`.
2. Try the result yourself.
3. Merge the branch the way your project merges, and push.

The run window stays open with the session idle, so you can ask it about the run. Closing it
ends the supervisor.

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
  "retries": { "maxAttemptsPerStep": 3, "maxNoProgressStops": 3 },
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
| `branch` | The run branch; `{planSlug}` comes from the plan's title |
| `devServer` | How to start the app for the browser checks: `command`, the `url` it serves, the path that answers when it is up, and how long to wait |
| `checks` | Commands the gate runs on every step, in order: `{ "name", "command", "timeoutSec", "needsDevServer" }`. Each must exit non-zero on failure |
| `tester` | The browser tester: model, turn budget, time limit. The bug bash gets one and a half times the turns |
| `security` | When the security review runs (`phase-end`, `tag:security`, `every-step`, `never`), and the lowest severity that fails a step (`high`, `medium`, `low`, `none`) |
| `bugBash.atPhaseEnd` | Run the bug bash on the last step of each phase that has anything in the browser |
| `retries` | Attempts per step before pausing, and how many stops without any progress count as stuck |
| `usage` | The weekly pause threshold, whether to resume by itself after the weekly reset, and how old usage data may be before it is ignored |
| `git` | Commit each verified step, tag phase ends, and whether Claude may push during the run (the gate itself never pushes) |
| `gate.timeoutSec` | The longest a verification may take |
| `notify.morningSummaryAt` | `"HH:MM"` local time for a daily summary, or `null` |
| `review.pauseAt` | `never`, `phase-end` or `every-step` |
| `supervisor` | Poll interval and the recovery timings in section 8, in minutes |
| `guard.deny` | Extra commands the run may never execute: `{ "pattern": "<regular expression>", "reason": "<what to do instead>" }`, matched case-insensitively against each shell command |
| `docs` | Where the run's documents live |

`retries.maxMinutesPerStep` is accepted but not enforced yet.

**Usage data.** The weekly pause and `autoclaude usage` need Claude Code's usage percentages. The
status line bridge that `init` installs records them from Claude Code's status line (it keeps
any status line you already had). Without it, AutoClaude falls back to a value Claude Code caches,
which is sometimes missing; the preflight warns when it has no fresh data, and a run with no
usage data never pauses for the weekly limit.

## 12. What a run may and may not do

The session runs in Claude Code's `auto` permission mode: it acts without asking you, and Claude
Code's own safety checks still block risky actions. On top of that, AutoClaude:

- denies questions to you (the builder decides, asks the decider, or stops with `blocked`)
- denies edits to the plan, `autoclaude.config.json` and `.autoclaude/`, commits by the builder
  (the gate commits), pushing (unless `git.push` is true), force pushes, `git reset --hard`, and
  recursive deletes outside the project
- denies every command matching a `guard.deny` rule
- auto-denies any permission prompt, with guidance, so the session never sits waiting

Keep secrets out of the plan and the repository: a step that needs one is a question for you. If
the machine can reach things that matter (servers, production databases, other repositories),
list them in `guard.deny`.

## 13. Windows notes

- **Disconnecting is fine; logging off is not.** An RDP disconnect or a locked screen keeps the
  run window alive. Signing out, restarting or sleeping ends it. Use disconnect, not sign out.
- **Sleep.** Turn sleep off while a run is going, for example `powercfg /change standby-timeout-ac 0`
  (and `standby-timeout-dc 0` on a laptop on battery). Windows Server does not sleep by default.
- **A standard user account.** Consider running AutoClaude under a Windows account without
  administrator rights. Then even a command that slips past every check cannot change the
  system.
- **Fresh terminals.** After `install-cli`, open a new terminal. Editors keep the PATH they
  started with, so an integrated terminal may not see `autoclaude`, node or git until the editor
  is restarted. Start `autoclaude run` from a terminal where `node --version` and
  `git --version` both work.
- **The watchdog task** runs only while you are signed in, because the run window lives on your
  desktop. It starts a hidden script, so nothing flashes on screen every 5 minutes.
- **PowerShell and Git Bash** both work for the CLI. Git Bash rewrites arguments that start with
  `/` into file paths; `autoclaude nudge "/compact"` corrects that itself, but for other
  commands prefer PowerShell when an argument starts with `/`.

## 14. Linux and macOS notes

- `autoclaude run` starts the supervisor in a detached tmux session named `ac-<project>` when
  tmux is installed (`tmux attach -t ac-<project>` to watch). Without tmux it runs in the
  background and logs to `.autoclaude/logs/supervisor.log`.
- `autoclaude watchdog --install` sets up a systemd user timer. For it to run while you are logged
  out, enable lingering: `loginctl enable-linger $USER`. Without systemd it prints a crontab line
  to add with `crontab -e`.
- On macOS, keep the machine awake during a run, for example with `caffeinate -i` in another
  terminal.
- `install-cli` writes the shim to `~/.local/bin` and prints the line to add to your shell
  profile if that folder is not on your PATH.

## 15. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `autoclaude: command not found` | Open a new terminal after `install-cli`, or restart the editor. Or run the CLI by path (section 1) |
| Preflight: `FAIL trust` | Open `claude` once in the project, answer the folder-trust question (and the theme picker on a first run), exit, and try again |
| Preflight: `FAIL git` about uncommitted changes | Commit or stash; a run needs a clean tree |
| Preflight: `FAIL git-cli` or `FAIL node` | That tool is not on this terminal's PATH. Use a terminal where it is |
| Preflight: `FAIL plan` | `autoclaude lint-plan` lists the problems |
| Preflight: `FAIL checks` | A check command does not exist here (the tool is missing or the script name is wrong) |
| Preflight: `FAIL playwright` | `npx playwright install chromium` |
| The window opens and sits on a theme picker or a trust question | Same as `FAIL trust` |
| Every step fails on the same check from the start | The checks fail on the current code. Fix that before the run, or make it the plan's first step |
| Browser checks skipped | `devServer.command` and `devServer.url` are not set. UI steps are then verified by the checks alone |
| "Dev server reused" in a report | Something else already answers at `devServer.url`, possibly an old copy of the app. Stop it |
| No alerts arrive | `autoclaude notify-test`; then `.autoclaude/logs/notify.log` in the project and `~/.claude/autoclaude/logs/notify.log` |
| Paused as `commit-failed` | git was missing or broken for the run; section 9 |
| Usage shows unknown | Start any Claude Code session so the status line bridge records usage; `autoclaude usage` |
| The session keeps getting denied | `.autoclaude/logs/denials.log` shows what it tried; a `guard.deny` rule or a plan step may need changing |

Logs: the project's `.autoclaude/logs/` for a run; `~/.claude/autoclaude/logs/` for the watchdog
and machine-level alerts.

## 16. Updating and uninstalling

**Update.**

```
claude plugin marketplace update autoclaude
claude plugin update autoclaude@autoclaude
```

Restart Claude Code sessions afterwards, and pause a running run before updating. The
`autoclaude` command and the watchdog follow the new version by themselves.

**Uninstall.**

```
autoclaude uninstall            the watchdog, the status line bridge, the shims and their PATH entry
autoclaude uninstall --purge    also the machine settings: alert channel, project registry, logs
claude plugin uninstall autoclaude@autoclaude
claude plugin marketplace remove autoclaude
```

Project files (`autoclaude.config.json`, `.autoclaude/`, the docs `init` wrote) stay in each
project; delete them by hand if you no longer want them.
