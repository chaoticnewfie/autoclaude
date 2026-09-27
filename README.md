# AutoClaude

AutoClaude lets Claude Code build a project from its plan while you are away. You write the plan
with Claude first: phases, small steps, and for every step the "Accept" lines that say how to tell
it is done. Then you start a run and walk away. Claude builds one step at a time, and a separate
check verifies each step before it is committed: the project's own tests, then a real headless
browser for anything with a user interface, plus a bug bash and a security review at the end of
each phase. You get a message on your phone only when something needs you.

It is a Claude Code plugin plus a small command-line tool, `autoclaude`. It runs on Windows 11 and
Windows Server without WSL, and on Linux and macOS.

## How a run works

1. `/autoclaude:plan` interviews you and writes `PLAN.md`. Every decision with more than one
   reasonable answer is made now, because nobody answers questions during the run.
2. `autoclaude run` opens a window named `ac-<project>`. A supervisor there starts Claude Code on
   the first unfinished step.
3. When Claude says a step is done, a gate checks it: your test and lint commands, then a browser
   tester that works through the step's Accept lines. It commits a pass and ticks the box in the
   plan. It sends a failure back to Claude with a report, up to 3 attempts.
4. Questions Claude cannot settle from the plan go to a "decider" helper. Routine answers are
   logged in `docs/DECISIONS.md`. A critical question pauses the run and messages you.
5. The supervisor restarts a crashed, stalled or idle session. It waits out usage limits, and
   pauses before your weekly limit runs out. A scheduled watchdog brings the supervisor back if
   its window dies.
6. At the end you review the run branch (one commit per step) and merge it yourself.

## Requirements

- Claude Code, the native install (`claude --version` works in a terminal), signed in with a Claude
  subscription. Long runs use a lot of usage; Max is the comfortable plan for them.
- Node.js 24 or newer, and git. On Windows, Git for Windows (Claude Code needs its Git Bash).
- For projects with a web UI: a dev server command, and Chromium for Playwright
  (`npx playwright install chromium`).
- Read access to this repository. It is private: you need an invitation, plus git credentials
  that can read it (the GitHub CLI signed in with `gh auth login`, or an SSH key on your account).

## Quickstart

Once per machine, in any terminal:

```
claude plugin marketplace add chaoticnewfie/autoclaude
claude plugin install autoclaude@autoclaude
```

Then, in the project you want to build (new or existing, it must be a git repository):

```
cd path/to/your/project
claude
```

In that Claude Code session:

```
/autoclaude:init      sets the project up and installs the `autoclaude` command
/autoclaude:plan      the interview; writes and checks PLAN.md, then commits it
```

Exit Claude Code and open a new terminal in the project, so it sees the new `autoclaude` command.
Set up alerts once per machine, then start the run:

```
autoclaude notify-setup --discord <webhook url>     (or --ntfy <topic url>)
autoclaude notify-test
autoclaude run
autoclaude watchdog --install      optional, once per machine: brings a run back if its window dies
```

Watch with `autoclaude status` or in the `ac-<project>` window. Stop after the current step with
`autoclaude pause`. Everything else is in [docs/USAGE.md](docs/USAGE.md).

## For Claude: adding AutoClaude to a project

If a user gave you this repository's address and asked you to add AutoClaude to their project,
follow [docs/USAGE.md](docs/USAGE.md) section 2, "Adding AutoClaude to a project". It is written
as a checklist for you. Before that, read the private repository with the user's git or GitHub
CLI credentials, for example `gh repo clone chaoticnewfie/autoclaude <temp folder>`. A plain web
fetch cannot see it.

## What is in this repository

| Path | What it is |
|---|---|
| `plugins/autoclaude/` | The plugin: hooks, skills, the CLI (`bin/autoclaude.js`), prompts, templates, and the project template `init` copies |
| `.claude-plugin/marketplace.json` | The marketplace entry that `claude plugin marketplace add` reads |
| `docs/USAGE.md` | The full guide: install, plan, run, pause, alerts, recovery, uninstall, troubleshooting |
| `PLAN.md`, `docs/DECISIONS.md`, `docs/SESSION_LOG.md` | How AutoClaude itself was built, and why it works the way it does |
| `test/` | `node scripts/check.js` runs every test |

AutoClaude is private and shared by invitation. It has no open-source license.
