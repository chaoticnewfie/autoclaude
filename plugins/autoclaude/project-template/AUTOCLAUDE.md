# AutoClaude: instructions

How to set up AutoClaude and use every part of it. This file is for people. Claude gets its own
instructions from the plugin, so you never need to paste any of this into a chat.

These instructions live in the AutoClaude repository as INSTRUCTIONS.md, and /autoclaude:init
puts a copy into every project it sets up, as AUTOCLAUDE.md. The full reference, with more
detail on every point, is docs/USAGE.md in the AutoClaude repository:
https://github.com/chaoticnewfie/autoclaude


## 1. What AutoClaude does

You plan a project with Claude once, answering its questions until nothing is left to guess. The
plan is split into features (a page, an API, a new server) and each feature into small steps,
each with a few "Accept" lines that say how to tell it is done. Then you start a run and leave.

Claude builds the steps of a feature one after another, testing what it changes as it goes.
When a feature is finished, it is checked as a whole: all your tests, a real headless browser
working through every Accept line, a bug hunt and a security review. A feature that passes is
committed, tagged and pushed to GitHub, and you get a short message. Then a fresh Claude session
starts the next feature.

The run does the whole plan, the way a session you were watching would: including work outside
the project folder that the plan gives it, such as creating a VM or a Docker container. You
decide during planning what it may touch and what it must never touch.

At the end you get HANDOFF.md: what was built, anything left for you (with the exact commands),
secrets it created, and decisions worth a look.


## 2. What you need

- Claude Code, the normal install (not only the copy inside VS Code). In PowerShell:
  irm https://claude.ai/install.ps1 | iex
  Then run "claude" once, log in with your Claude subscription, pick a theme, and type /exit.
- Node.js 24 or newer:  winget install OpenJS.NodeJS
- Git for Windows:      winget install Git.Git
- GitHub CLI:           winget install GitHub.cli
  Then: gh auth login   and then   gh auth setup-git
  (You also need an invitation to this private repository.)
- For web apps: Chromium for the browser checker:  npx.cmd playwright install chromium

Open a new terminal after installing anything, so it can find the new program.

A long run uses a lot of your Claude usage, and it shares the same limits as everything else you
do in Claude that day.


## 3. One-time setup on each computer

In any terminal:

    claude plugin marketplace add chaoticnewfie/autoclaude
    claude plugin install autoclaude@autoclaude

That installs the plugin. It is the only install on this computer: every project uses it, and
AutoClaude itself is never copied into a project. A project only gets its own settings, plan and
docs. You can clone the repository somewhere to read it, but install from these two commands,
not from the clone, so updates only happen when you ask for them.

The "autoclaude" command itself gets installed the first time you run /autoclaude:init in a
project (step 4), so do the rest after that. Then open the settings page:

    autoclaude config

It opens in your browser. Under Alerts, paste a Discord webhook (channel settings,
Integrations, Webhooks, New Webhook, Copy URL) or an ntfy topic, and click "Send a test alert".
Under Computer tasks, install the watchdog (it reopens a run if its window dies). Anything you
set under "This computer's defaults" applies to all your projects.


## 4. Starting in a project (new or existing)

1. The project must be a git repository with at least one commit and nothing uncommitted.
   Brand new project: create the folder, then  git init  and make a first commit.

2. Open a terminal in the project folder and start Claude Code:
       cd path\to\your\project
       claude
   If it asks whether you trust the folder, say yes. (A run cannot answer that question for you,
   so this first time has to be you, in a terminal.)

3. In Claude, type:
       /autoclaude:init
   It asks two quick questions and adds AutoClaude's files to the project, including a copy of
   these instructions (AUTOCLAUDE.md). It never overwrites a file you already have.

4. Then type:
       /autoclaude:plan
   This is the important part, and it takes a while on purpose. Claude asks you everything the
   run would otherwise have to guess, in rounds of up to four multiple-choice questions, each
   with its recommendation first. A new project usually takes 10 to 14 rounds. It never fills in
   an answer from your notes without asking; if you want it to choose, say "you decide".

   It always asks about scope: for each thing outside the project folder (a VM, a server, a
   deploy), whether the run does it, writes it for you to run, or leaves it out; what the run
   must never touch; and whether to snapshot an existing machine before changing it. It asks
   before installing or downloading anything.

   It then sets up your test commands, the dev server and the permissions the run needs, writes
   the plan, checks it and commits everything. It ends with a "Before the run" list of things
   only you can do.

5. Exit Claude (/exit). Do everything on the "Before the run" list.

6. Open a NEW terminal in the project (so it sees the autoclaude command) and check that
   everything is ready:
       autoclaude run --check
   Every line should say ok or warn. Fix any FAIL line (see section 13).

7. Start the run:
       autoclaude run
   A window named "ac-<project name>" opens and the building happens there.


## 5. While it runs

Leaving the computer:
- Disconnecting from remote desktop, or locking the screen, is fine.
- Signing out, restarting or letting the computer sleep ends the run. Turn sleep off first:
      powercfg /change standby-timeout-ac 0
- Pause Windows Update restarts for the day.

Watching:
- You get a message each time a feature is finished and verified.
- autoclaude status          shows where it is, from any terminal in the project
- autoclaude status --all    shows every project on this computer
- The ac-<project> window shows Claude working.
- PROGRESS.md gets a line per step; the plan shows [~] for a step that is built and waiting for
  its feature's check, and [x] once the feature is verified.
- The run branch (autoclaude/<plan name>) is pushed to GitHub after every verified feature.

Please don't:
- Edit files, commit, or switch branches in the project folder while it runs. The run works on
  its own branch in that folder. Use a separate copy for other work.
- Close the run window to stop it. Use pause instead (next section).

You can safely open your own Claude session in the project to look around. The run ignores it.


## 6. Pausing, notes, resuming, stopping

    autoclaude pause                      stop after the current step is finished and committed
    autoclaude pause --now                stop right away (unfinished work stays, not committed)
    autoclaude note "your note here"      leave Claude a note; it acts on it first
    autoclaude resume                     carry on after a pause

While paused you can look at the code, try the app, leave notes, or edit the plan. Commit your
own edits before you resume.

To pause automatically after every feature, set "Pause for review" to "phase-end" on the
settings page (autoclaude config).

| You want to                       | Do this                                                   |
|-----------------------------------|-----------------------------------------------------------|
| Stop for the day                  | autoclaude pause (or --now), then close the window        |
| Carry on the next day             | autoclaude resume (if the window is gone: autoclaude run first) |
| Abandon a run                     | autoclaude pause --now, close the window                  |
| Carry on after a reboot           | Sign in. The watchdog reopens it, or run: autoclaude run  |
| Send Claude a one-off instruction | autoclaude nudge "/compact"  (or any prompt)              |


## 7. When you get a message

| Message says                          | What to do                                                    |
|---------------------------------------|---------------------------------------------------------------|
| Phase N verified                      | Nothing: a feature is done and pushed. The message says what is next |
| Blocked on a question                 | Answer it (section 8)                                         |
| A feature failed 3 times              | Read the newest report in .autoclaude/reports/ (it names the failing Accept lines), fix the code or rewrite the steps, then autoclaude resume |
| Stuck                                 | Look at the run window and .autoclaude/logs/, then autoclaude resume |
| Could not run (tester, bug bash, security) | A tool is broken (Playwright or Claude). Fix it, then autoclaude resume |
| Passed but was not committed          | git is broken or missing. Fix it, then autoclaude resume (it commits first) |
| Push failed                           | The work is safe locally; fix GitHub access. The next feature's push retries |
| Weekly usage limit                    | Wait for your weekly reset, then autoclaude resume            |
| Paused for review                     | Look around, leave notes, autoclaude resume                   |
| Waiting for a person / many denials   | Look at the run window; something needs a decision            |
| Plan complete                         | Read HANDOFF.md, review and merge (section 10)                |

You choose the informational messages on the settings page, under Alerts: a feature verified
(on by default), each step, a morning summary at a set time, and confirmations when you start,
resume or pause a run. The important ones above cannot be switched off.

Everything else (small decisions, retries that later pass, waiting for the 5-hour usage limit to
reset, automatic restarts) is handled quietly and only goes into the logs.


## 8. Answering a question

When Claude needs a decision only you can make (something the plan does not cover, or a secret
it cannot create itself, such as a third-party account), it pauses and sends you the question
with options. Answer from a terminal in the project:

    autoclaude answer "b, and keep the old page for now"

The run carries on by itself. Your answer is saved in docs/DECISIONS.md.
You need to be at the computer (or connected to it remotely) to answer. The run waits until then.

Smaller choices the plan did not settle are decided and logged so the run keeps going. Anything
that accepts a security risk is marked "Owner review: yes" and listed first in HANDOFF.md.


## 9. What it handles by itself

- Each feature starts in a fresh Claude session, with the plan and the progress so far.
- Claude crashes or closes: it is restarted and picks up where it was.
- Claude sits idle or goes quiet for a long time: it is restarted.
- The 5-hour usage limit: it waits for the reset, then continues.
- Near your weekly limit (85% by default): it pauses and tells you.
- The run window dies: the watchdog reopens it within 5 minutes.
- The dev server dies: it is restarted for the next check.
- Small bugs and security notes found in a feature are fixed before the feature closes, or left
  for you with a reason.
- Secrets it needs (a database password, a key) are generated into the project's secrets/
  folder, which git ignores. They are never committed or shown in logs.
- Docker containers, volumes and networks it created and no longer uses are removed at the end;
  anything else it created is listed in HANDOFF.md.


## 10. After the run

1. Read HANDOFF.md in the project: what was built, what is left for you (with the exact
   commands), secrets it created (by file name), decisions to review, open findings, and what it
   left on this computer.
2. Try the result yourself, and fine-tune it in normal Claude sessions.
3. Merge the autoclaude/<plan name> branch the way you normally do.

The run window stays open afterwards, so you can ask Claude about the run. Close it when done.

What ends up in your project's git: the code, one commit per step named autoclaude(<step>) with
a description of what was checked, HANDOFF.md, autoclaude.config.json, PROGRESS.md, the plan,
CLAUDE.md, CONTINUE_HERE.md and the docs/ files. Kept out: the .autoclaude/ folder (logs,
reports, screenshots, run state) and secrets/. The run pushes only its own branch and phase
tags, and only while "push" is on (the default).

Adding more work later: run /autoclaude:plan again (or add new steps to the plan), commit, then
autoclaude run. It starts a fresh run on the new steps.


## 11. Settings

Everything is on one page:

    autoclaude config          (or /autoclaude:config inside Claude)

It opens in your browser, served only from this computer. Each setting shows what it does, its
default, and where its current value comes from. There are three layers: AutoClaude's built-in
defaults, then this computer's defaults (yours, for all projects), then the project's own
settings. A project follows your computer defaults unless it sets its own, so another person
using the same project gets their own preferences.

During a run, settings that do not change how steps are built or checked apply at once (alerts,
usage limits, pause timing, pushing). The rest are locked until you pause the run.

The settings you are most likely to change:

| Setting                         | What it does                                                |
|---------------------------------|-------------------------------------------------------------|
| Verify at                       | "phase" checks once per feature (default); "step" checks every step |
| Pause for review                | never, after each feature, or after each step               |
| Weekly usage pause              | stop when weekly usage reaches this percent (default 85)    |
| Resume after the weekly reset   | carry on by itself after the reset                          |
| Push                            | push the run branch and tags after each feature (default on) |
| Models                          | Opus (the newest) everywhere by default; Sonnet is the lowest allowed |
| Builder effort                  | unset = your own Claude Code default                        |
| Alerts                          | the channel, and which informational messages you get       |
| Checks, dev server              | your test commands, and how to start the app for the browser checks |
| Deny rules, permissions         | what the run must never run, and what it may do outside the project |

From a terminal:
    autoclaude checks                   run the project's checks exactly the way the run does
    autoclaude guard-test "command"     would the run be allowed to run this command?


## 12. Safety: what the run will and will not do

The run does what the plan gives it, outside the project folder too: the machines, services and
deploys the plan names, plus installing tools, using Docker and creating GitHub repositories
unless the plan says otherwise. Planning writes the exact permissions for that, so Claude Code's
own safety checks do not stop it half way.

AutoClaude blocks: asking you questions, editing the plan or its settings, Claude committing or
pushing by itself (the run commits and pushes for it), force pushing, resetting git history,
deleting things outside the project, and every command on the project's deny list. The deny list
looks at the commands being run; reading or mentioning a blocked file is fine.

These checks look at what Claude runs, so they are a strong safety net, not a wall. Before a run
changes an existing machine, it takes the snapshot you agreed to during planning.


## 13. Troubleshooting

| Problem                                        | Fix                                                  |
|------------------------------------------------|------------------------------------------------------|
| "autoclaude" is not recognized                  | Open a new terminal (or restart VS Code)             |
| run --check says FAIL trust                     | Run "claude" once in the project folder, say yes, /exit |
| FAIL git (uncommitted changes)                  | Commit or stash your changes                         |
| FAIL git-cli / FAIL node                        | Use a terminal where git and node work               |
| FAIL plan                                       | autoclaude lint-plan shows what is wrong             |
| FAIL checks: a requirement failed               | Start or install what it names (for example Docker Desktop) |
| FAIL playwright                                 | npx.cmd playwright install chromium                  |
| FAIL dev server                                 | Start your app by hand and check the address on the settings page |
| FAIL usage                                      | Your weekly usage is too high; wait for the reset    |
| No alerts arrive                                | Settings page, Alerts, "Send a test alert"           |
| Every feature fails the same check from the start | Your tests already fail; fix them before the run   |
| The window sits on a trust or theme question    | Same as FAIL trust                                   |

Logs are in the project's .autoclaude/logs/ folder. Reports on verifications are in
.autoclaude/reports/.

Every command explains itself:  autoclaude <command> --help


## 14. Updating and uninstalling

Update (pause any run first):

    claude plugin marketplace update autoclaude
    claude plugin update autoclaude@autoclaude

Then close the run window, start it again with autoclaude run, and autoclaude resume.

To refresh a project's copy of these instructions after an update, delete its AUTOCLAUDE.md and
run  autoclaude init  in the project. Init only adds files that are missing, so nothing else
changes.

Uninstall:

    autoclaude uninstall
    claude plugin uninstall autoclaude@autoclaude
    claude plugin marketplace remove autoclaude

Add --purge to "autoclaude uninstall" to also delete your alert settings, computer defaults and
logs. The files AutoClaude added to your projects stay; delete them by hand if you want.


## 15. Command list

    Setting up
      /autoclaude:init             (in Claude) add AutoClaude to the project
      /autoclaude:plan             (in Claude) plan with you, question by question
      autoclaude config            the settings page (also /autoclaude:config)
      autoclaude run --check       check everything is ready, without starting
      autoclaude run               start (or bring back) the run

    During a run
      autoclaude status [--all]    where things are
      autoclaude pause [--now]     pause after this step, or right away
      autoclaude note "..."        leave Claude a note
      autoclaude resume            carry on
      autoclaude answer "..."      answer a question Claude is blocked on
      autoclaude nudge "..."       restart Claude with a one-off prompt

    Checking
      autoclaude lint-plan         check the plan's format
      autoclaude checks            run the project's checks like the run does
      autoclaude guard-test "..."  would the run be allowed to run this command?
      autoclaude usage             your 5-hour and weekly Claude usage

    This computer
      autoclaude notify-setup      set up alerts from a terminal (the settings page does the same)
      autoclaude notify-test       send a test alert
      autoclaude watchdog --install | --status | --uninstall
      autoclaude install-cli       reinstall the autoclaude command
      autoclaude uninstall         remove AutoClaude from this computer
      autoclaude help              the full list; add --help to any command for its details
