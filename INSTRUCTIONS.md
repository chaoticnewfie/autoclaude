# AutoClaude: instructions

How to set up AutoClaude and use every part of it. This file is for people. Claude gets its own
instructions from the plugin, so you never need to paste any of this into a chat.

The full reference, with more detail on every point, is docs/USAGE.md in this repository.


## 1. What AutoClaude does

You plan a project with Claude once: phases, small steps, and for every step a few "Accept" lines
that say how to tell it is done. Then you start a run and leave. Claude builds one step at a time.
After each step a checker runs your tests and opens the app in a real headless browser to confirm
every Accept line. A step that passes is committed; a step that fails goes back to Claude with the
evidence. At the end of each phase it also runs a bug hunt and a security review.

You only hear from it (Discord or ntfy) when something needs you: a question only you can answer,
a step that failed three times, or the plan being finished.


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

That installs the plugin. The "autoclaude" command itself gets installed the first time you run
/autoclaude:init in a project (step 4), so do the next two things after that.

Alerts to your phone (once per computer). Make a Discord webhook (channel settings, Integrations,
Webhooks, New Webhook, Copy URL), then:

    autoclaude notify-setup --discord "https://discord.com/api/webhooks/..."
    autoclaude notify-test

Or use ntfy instead: subscribe to a hard-to-guess topic in the ntfy app, then
    autoclaude notify-setup --ntfy "https://ntfy.sh/your-topic"

The watchdog (recommended): a scheduled task that reopens a run if its window dies.

    autoclaude watchdog --install


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
   It asks two quick questions and adds AutoClaude's files to the project. It never overwrites a
   file you already have.

4. Then type:
       /autoclaude:plan
   This is the important part. Claude reviews what is already there, interviews you, and settles
   every decision now, because nobody can answer questions during the run. It sets up your test
   commands and the dev server, asks what the run must never touch (servers, other computers,
   deploy scripts), writes the plan, checks it, and commits everything. It ends with a
   "Before the run" list of things only you can do.

   Tip: when it asks what the run must never touch, name everything this computer can reach.

5. Exit Claude (/exit). Do everything on the "Before the run" list.

6. Open a NEW terminal in the project (so it sees the autoclaude command) and check that
   everything is ready:
       autoclaude run --check
   Every line should say ok or warn. Fix any FAIL line (see section 12).

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
- autoclaude status          shows where it is, from any terminal in the project
- autoclaude status --all    shows every project on this computer
- The ac-<project> window shows Claude working.
- PROGRESS.md in the project gets one line per finished step.

Please don't:
- Edit files, commit, or switch branches in the project folder while it runs. The run works on
  its own branch (autoclaude/<plan name>) in that folder. Use a separate copy for other work.
- Close the run window to stop it. Use pause instead (next section).

You can safely open your own Claude session in the project to look around. The run ignores it.


## 6. Pausing, notes, resuming, stopping

    autoclaude pause                      stop after the current step is finished and committed
    autoclaude pause --now                stop right away (unfinished work stays, not committed)
    autoclaude note "your note here"      leave Claude a note; it acts on it first
    autoclaude resume                     carry on after a pause

While paused you can look at the code, try the app, leave notes, or edit the plan. Commit your
own edits before you resume.

To pause automatically at the end of every phase, set this in autoclaude.config.json:
    "review": { "pauseAt": "phase-end" }

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
| Blocked on a question                 | Answer it (section 8)                                         |
| A step failed 3 times                 | Read the newest report in .autoclaude/reports/, fix the code or rewrite the step, then autoclaude resume |
| Stuck                                 | Look at the run window and .autoclaude/logs/, then autoclaude resume |
| Could not run (tester, bug bash, security) | A tool is broken (Playwright or Claude). Fix it, then autoclaude resume |
| Passed but was not committed          | git is broken or missing. Fix it, then autoclaude resume (it commits first) |
| Weekly usage limit                    | Wait for your weekly reset, then autoclaude resume            |
| Paused for review                     | Look around, leave notes, autoclaude resume                   |
| Waiting for a person / many denials   | Look at the run window; something needs a decision            |
| Plan complete                         | Review and merge (section 10)                                 |

Everything else (small decisions, retries that later pass, waiting for the 5-hour usage limit to
reset, automatic restarts) is handled quietly and only goes into the logs.


## 8. Answering a question

When Claude needs a decision only you can make (a password or account, something that costs
money, something it can't undo, or a conflict in the plan), it pauses and sends you the question
with options. Answer from a terminal in the project:

    autoclaude answer "b, and keep the old page for now"

The run carries on by itself. Your answer is saved in docs/DECISIONS.md.
You need to be at the computer (or connected to it remotely) to answer. The run waits until then.


## 9. What it handles by itself

- Claude crashes or closes: it is restarted and picks up where it was.
- Claude sits idle or goes quiet for a long time: it is restarted.
- The 5-hour usage limit: it waits for the reset, then continues.
- Near your weekly limit (85% by default): it pauses and tells you.
- The run window dies: the watchdog reopens it within 5 minutes.
- The dev server dies: it is restarted for the next check.


## 10. After the run

1. Read what was done: the commits (git log), docs/DECISIONS.md (choices Claude made),
   docs/BLOCKERS.md (small bugs it noticed but did not fix), docs/SECURITY-FINDINGS.md.
2. Try the app yourself.
3. Merge the autoclaude/<plan name> branch the way you normally do, and push.

The run window stays open afterwards, so you can ask Claude about the run. Close it when done.

Adding more work later: add new steps to the plan (or run /autoclaude:plan again), commit them,
then  autoclaude run. It starts a fresh run on the new steps.


## 11. Settings you might change

All in autoclaude.config.json in the project. Change them only while no run is going.

| Setting                                 | What it does                                          |
|-----------------------------------------|-------------------------------------------------------|
| "review": { "pauseAt": "phase-end" }    | pause after each phase ("every-step" or "never" too)  |
| "usage": { "weeklyPauseAtPct": 85 }     | pause when weekly usage reaches this percent          |
| "usage": { "autoResumeAfterWeeklyReset": true } | carry on by itself after the weekly reset     |
| "git": { "push": false }                | whether Claude may push during a run                  |
| "notify": { "morningSummaryAt": "07:30" } | a daily progress message                            |
| "builder" / "tester" / "security": { "model": "opus" } | which Claude model each part uses. Opus (the newest) is the default everywhere; "sonnet" is the lowest allowed; Haiku is refused |
| "checks": [ ... ]                       | the test and lint commands run after every step       |
| "devServer": { ... }                    | how to start your app for the browser checks          |
| "guard": { "deny": [ ... ] }            | extra commands the run must never execute             |

Test a deny rule with:   autoclaude guard-test "the command"
Run your checks the way the run does:   autoclaude checks


## 12. Safety: what the run will not do

While a run is going, AutoClaude blocks Claude from: asking you questions, editing the plan or
its settings, committing (it commits for Claude), pushing (unless you allowed it), force pushing,
resetting git history, deleting things outside the project, and any command in your deny list.

These checks look at the commands Claude types, so they are a strong safety net but not a wall.
The best protection is making sure the account running AutoClaude cannot reach anything that
matters, and naming every server, host and deploy script in the deny list during
/autoclaude:plan.


## 13. Troubleshooting

| Problem                                        | Fix                                                  |
|------------------------------------------------|------------------------------------------------------|
| "autoclaude" is not recognized                  | Open a new terminal (or restart VS Code)             |
| run --check says FAIL trust                     | Run "claude" once in the project folder, say yes, /exit |
| FAIL git (uncommitted changes)                  | Commit or stash your changes                         |
| FAIL git-cli / FAIL node                        | Use a terminal where git and node work               |
| FAIL plan                                       | autoclaude lint-plan shows what is wrong             |
| FAIL playwright                                 | npx.cmd playwright install chromium                  |
| FAIL dev server                                 | Start your app by hand and check the address in autoclaude.config.json |
| FAIL usage                                      | Your weekly usage is too high; wait for the reset    |
| No alerts arrive                                | autoclaude notify-test                               |
| Every step fails the same check from the start  | Your tests already fail; fix them before the run     |
| The window sits on a trust or theme question    | Same as FAIL trust                                   |

Logs are in the project's .autoclaude/logs/ folder. Reports on failed steps are in
.autoclaude/reports/.


## 14. Updating and uninstalling

Update (pause any run first):

    claude plugin marketplace update autoclaude
    claude plugin update autoclaude@autoclaude

Then close the run window, start it again with autoclaude run, and autoclaude resume.

Uninstall:

    autoclaude uninstall
    claude plugin uninstall autoclaude@autoclaude
    claude plugin marketplace remove autoclaude

Add --purge to "autoclaude uninstall" to also delete your alert settings and logs. The files
AutoClaude added to your projects stay; delete them by hand if you want.


## 15. Command list

    Setting up
      /autoclaude:init             (in Claude) add AutoClaude to the project
      /autoclaude:plan             (in Claude) write or review the plan
      autoclaude run --check       check everything is ready, without starting
      autoclaude run               start (or bring back) the run

    During a run
      autoclaude status [--all]    where things are
      autoclaude pause [--now]     pause after this step, or right away
      autoclaude note "..."        leave Claude a note
      autoclaude resume            carry on
      autoclaude answer "..."      answer a question Claude is blocked on
      autoclaude nudge "..."       restart Claude with a one-off prompt

    Checking and settings
      autoclaude lint-plan         check the plan's format
      autoclaude checks            run the project's checks like the run does
      autoclaude guard-test "..."  would the run be allowed to run this command?
      autoclaude usage             your 5-hour and weekly Claude usage

    This computer
      autoclaude notify-setup      set up Discord or ntfy alerts (--show, --clear)
      autoclaude notify-test       send a test alert
      autoclaude watchdog --install | --status | --uninstall
      autoclaude install-cli       reinstall the autoclaude command
      autoclaude uninstall         remove AutoClaude from this computer
      autoclaude help              the full list
