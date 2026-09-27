# AutoClaude

**New here? Start with [INSTRUCTIONS.md](INSTRUCTIONS.md)**: plain step-by-step instructions for
setting up and using every part of AutoClaude.

AutoClaude lets Claude Code build a project from its plan while you are away. You write the plan
with Claude first: phases, small steps, and for every step the "Accept" lines that say how to tell
it is done. Then you start a run and leave it. Claude builds one step at a time, and a separate
check verifies each step before it is committed: the project's own tests, then a real headless
browser for anything with a web page, plus a bug bash and a security review at the end of each
phase. You get a message on your phone when something needs you.

It is a Claude Code plugin plus a small command-line tool, `autoclaude`. It runs on Windows 11 and
Windows Server without WSL. Linux and macOS use the same code but have not been tested live yet.

## How a run works

1. `/autoclaude:plan` interviews you and writes the plan. Every decision with more than one
   reasonable answer is made now, because nobody answers questions during the run.
2. `autoclaude run` opens a window named `ac-<project>`. A supervisor there starts one Claude Code
   session, the builder, on the first unfinished step.
3. When the builder says a step is done, a gate checks it: your test and lint commands, then a
   browser tester that works through the step's Accept lines. It commits a pass and ticks the box
   in the plan. It sends a failure back to the builder with a report, up to 3 attempts.
4. Questions the builder cannot settle from the plan go to a "decider" helper. Routine answers are
   logged in `docs/DECISIONS.md`. A critical question pauses the run and messages you.
5. The supervisor restarts a crashed, stalled or idle session, waits out usage limits, and pauses
   before your weekly limit runs out. An optional scheduled watchdog brings the supervisor back if
   its window dies.
6. At the end you review the run branch (one commit per step) and merge it yourself.

Answering a question or resuming a paused run needs a terminal on the machine, in person or over
remote desktop. The run waits until you get there.

## Requirements

- Claude Code, the native install (`claude --version` in a terminal), signed in with a Claude
  subscription. The run uses the same usage limits as your other Claude Code work; Max is the
  comfortable plan for long runs.
- Node.js 24 or newer, and git. On Windows, Git for Windows.
- For projects with a web UI: a dev server command, and Chromium for Playwright.
- Read access to this repository. It is private: accept your invitation, then sign in the GitHub
  CLI (`gh auth login`, then `gh auth setup-git`) or add an SSH key to your GitHub account.

[docs/USAGE.md](docs/USAGE.md) section 1 has install commands for each of these.

Installing the plugin loads its hooks into every Claude Code session on the machine. They do
nothing unless a run is active in that session's project.

## Quickstart

Once per machine, in any terminal:

```
claude plugin marketplace add chaoticnewfie/autoclaude
claude plugin install autoclaude@autoclaude
```

Then open a new Claude Code session in your project. The project must be a git repository with
at least one commit and nothing uncommitted.

```
cd path/to/your/project
claude
```

In that session, type:

```
/autoclaude:init
/autoclaude:plan
```

`/autoclaude:init` sets the project up, installs the `autoclaude` command, and puts a copy of
[INSTRUCTIONS.md](INSTRUCTIONS.md) into the project as `AUTOCLAUDE.md`. `/autoclaude:plan`
reviews the project, interviews you, writes and checks the plan, sets up the test commands and
the dev server, and commits it all. It ends with a list of things for you to do before the run.

Then exit Claude Code, do everything on that list, and open a new terminal in the project, so it
sees the new `autoclaude` command. Set up alerts once per machine; use your own webhook address:

```
autoclaude notify-setup --discord "https://discord.com/api/webhooks/..."
autoclaude notify-test
```

Before you leave it running for hours, turn off sleep and plan to disconnect instead of signing
out (USAGE section 13). Install the watchdog once per machine, and check that everything is
ready:

```
autoclaude watchdog --install
autoclaude run --check
```

Start the run:

```
autoclaude run
```

Watch with `autoclaude status` or in the `ac-<project>` window. `autoclaude pause` stops it after
the next verified step; `autoclaude pause --now` stops it at once. Everything else is in
[docs/USAGE.md](docs/USAGE.md).

## For Claude: adding AutoClaude to a project

If a user gave you this repository's address and asked you to add AutoClaude to their project,
follow [docs/USAGE.md](docs/USAGE.md) section 2, "Adding AutoClaude to a project". It is written
as a checklist for you. The repository is private, so a plain web fetch cannot read it. Use the
user's GitHub CLI or git credentials instead:

```
gh api repos/chaoticnewfie/autoclaude/contents/docs/USAGE.md -H "Accept: application/vnd.github.raw"
```

Or clone it into a temporary folder outside the user's project (never inside it, because that
leaves the project's working tree dirty), read it, and delete the clone afterwards.

## What is in this repository

| Path | What it is |
|---|---|
| `plugins/autoclaude/` | The plugin: hooks, skills, the CLI (`bin/autoclaude.js`), prompts, templates, and the project template `init` copies |
| `.claude-plugin/marketplace.json` | The marketplace entry that `claude plugin marketplace add` reads |
| `docs/USAGE.md` | The full guide: install, plan, run, pause, alerts, recovery, uninstall, troubleshooting |
| `PLAN.md`, `docs/DECISIONS.md`, `docs/SESSION_LOG.md` | How AutoClaude itself was built, and why it works the way it does |
| `test/` | `node scripts/check.js` runs every test |

AutoClaude is private and shared by invitation. It has no open-source license.
