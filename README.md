# AutoClaude

**New here? Start with [INSTRUCTIONS.md](INSTRUCTIONS.md)**: plain step-by-step instructions for
setting up and using every part of AutoClaude.

AutoClaude lets Claude Code build a project from its plan while you are away. You write the plan
with Claude first: phases, small steps, and for every step the "Accept" lines that say how to tell
it is done. Then you start a run and leave it. Claude builds the whole project the plan
describes, one feature (phase) at a time, including the infrastructure you allowed while
planning. When a feature is built, a separate check verifies all of it before the run moves on:
the project's own tests, a real headless browser for anything with a web page, a bug bash and a
security review. Each verified feature is committed and pushed, and you get a message on your
phone when a feature is done or something needs you.

It is a Claude Code plugin plus a small command-line tool, `autoclaude`. It runs on Windows 11 and
Windows Server without WSL. Linux and macOS use the same code but have not been tested live yet.

## How a run works

1. `/autoclaude:plan` interviews you in rounds of questions and writes the plan: what to build,
   what the run may touch (servers, containers, repositories) and what is off limits. Every
   decision with more than one reasonable answer is made now, because nobody answers questions
   during the run.
2. `autoclaude run` opens a window named `ac-<project>`. A supervisor there starts one Claude Code
   session, the builder, on the first unfinished step.
3. Each finished step is committed as built. When the last step of a feature is done, a gate
   verifies the whole feature: your test and lint commands, a browser tester that works through
   every Accept line, a bug bash and a security review. A pass is committed, tagged and pushed,
   and the next feature starts in a fresh session. A failure goes back to the builder with a
   report naming what failed, up to 3 attempts.
4. Questions the builder cannot settle from the plan go to a "decider" helper. Its answers are
   logged in `docs/DECISIONS.md` and the run keeps going. Only a question that truly needs you
   pauses the run and messages you.
5. The supervisor restarts a crashed, stalled or idle session, waits out usage limits, and pauses
   before your weekly limit runs out. An optional scheduled watchdog brings the supervisor back if
   its window dies.
6. At the end the run writes `HANDOFF.md`: what was done, what is left for you (with the
   commands), the decisions it made, and what it left on the machine. You review the branch and
   merge it yourself.

Answering a question or resuming a paused run needs a terminal on the machine, in person or over
remote desktop. The run waits until you get there.

## Security and optimize sweeps

For an existing project, `/autoclaude:security` runs a full security sweep: a review of the whole
codebase, secrets in the files and the git history, known-vulnerable packages, config and
infrastructure, and live attacks on the app with a headless browser, against only the targets
you allow (the local dev server by default). `/autoclaude:optimize` sweeps for unused code and
packages, duplicates, slow paths, poorly built features and slow or flaky tests, measuring before
and after. Both ask their questions first, run unattended in their own window, check every
finding with independent sessions, and write a report that is never committed. They can stop at
the report, write a fix plan for you to review, or fix everything right away through a normal,
verified run on its own branch. [docs/USAGE.md](docs/USAGE.md) section 17 has the details.

## Requirements

- Claude Code, the native install (`claude --version` in a terminal), signed in with a Claude
  subscription. The run uses the same usage limits as your other Claude Code work; Max is the
  comfortable plan for long runs.
- Node.js 24 or newer, and git. On Windows, Git for Windows.
- For projects with a web UI: a dev server command, and Chromium for Playwright.

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
sees the new `autoclaude` command. Open the settings page to set up alerts (your own Discord
webhook or ntfy topic), send a test alert, and look over the other settings:

```
autoclaude config
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
the next committed step; `autoclaude pause --now` stops it at once. Everything else is in
[docs/USAGE.md](docs/USAGE.md).

## For Claude: adding AutoClaude to a project

If a user gave you this repository's address and asked you to add AutoClaude to their project,
follow [docs/USAGE.md](docs/USAGE.md) section 2, "Adding AutoClaude to a project". It is written
as a checklist for you. The repository is public, so you can read the raw file directly:

```
https://raw.githubusercontent.com/chaoticnewfie/autoclaude/main/docs/USAGE.md
```

Or clone it into a temporary folder outside the user's project (never inside it, because that
leaves the project's working tree dirty), read it, and delete the clone afterwards.

## What is in this repository

| Path | What it is |
|---|---|
| `plugins/autoclaude/` | The plugin: hooks, skills, the CLI (`bin/autoclaude.js`), prompts, templates, and the project template `init` copies |
| `.claude-plugin/marketplace.json` | The marketplace entry that `claude plugin marketplace add` reads |
| `CHANGELOG.md` | What changed in each version |
| `docs/USAGE.md` | The full guide: install, plan, run, pause, alerts, settings, recovery, uninstall, troubleshooting |
| `PLAN.md`, `docs/DECISIONS.md`, `docs/SESSION_LOG.md` | How AutoClaude itself was built, and why it works the way it does |
| `test/` | `node scripts/check.js` runs every test |

The repository is public. AutoClaude has no open-source license yet: ask the author before you
reuse its code elsewhere.
