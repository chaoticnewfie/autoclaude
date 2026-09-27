# CLAUDE.md - the rules for {{PROJECT_NAME}}

**This file is rules, constraints and standing decisions only.** What is being built and in what
order lives in [PLAN.md](PLAN.md). Where things are right now lives in
[CONTINUE_HERE.md](CONTINUE_HERE.md). If this file and either of those disagree, this file wins.

- Session start: read `CONTINUE_HERE.md`, then this file, then the current phase of `PLAN.md`.
  Trust them. Spot-check one claim before a risky change; do not re-survey the repo.
- The person this project belongs to is "the owner" below.

## Status, in one line

{{DATE}}: doc set created by `autoclaude init`. The plan has no steps yet and nothing is built.

## Definition of done: every prompt, no exceptions

1. **It works.** The check command in the Commands section is green. State the counts in the
   reply (tests passed, lint and typecheck clean). Boxes in `PLAN.md` belong to the gate: during
   a run only the gate ticks them, and outside a run a box is ticked only when every Accept line
   is demonstrably true, with the evidence shown.
2. **Docs updated in the same pass.** `PLAN.md` (correct what the work proved wrong, re-point the
   next step), `CONTINUE_HERE.md` (rewritten, not appended), `docs/SESSION_LOG.md` (one entry
   appended), `docs/DECISIONS.md` (every choice between real alternatives), `docs/DEFERRED.md`
   (anything deliberately not built), and this file only when a rule changed.
3. **Committed and pushed.** One commit per coherent unit, a conventional message, and a push
   after every commit. Never leave work uncommitted at the end of a prompt. During an AutoClaude
   run the gate makes the commit; the builder never commits.
4. **Requests are captured.** Anything the owner asks for that is not being built now goes into
   the "Requested features intake" table in `PLAN.md` with the date and the owner's words.
   Nothing is dropped, and nothing is built early unless the owner says so.

## Rules

1. **Everything lives in this folder and in git.** No `~/.claude/plans`, no machine-local notes.
   Memory notes, ideas and plans are tracked files.
2. **Commit and push after every change.** The remote is never behind the working tree or the
   deployed server. Conventional prefixes: `feat(x):`, `fix(x):`, `docs:`, `chore:`, `test:`.
3. **Decision log.** `docs/DECISIONS.md` is dated and append-only: the choice, the why, what was
   rejected. A reversal is a new entry that supersedes the old one, never an edit.
4. **Session log.** `docs/SESSION_LOG.md` gets one append-only entry per session: date, machine,
   what was done, commits, deployed SHA.
5. **Facts worth not re-deriving** go in the section below the moment something costs more than
   five minutes to work out, with the fix.
6. **Deferred work** goes in `docs/DEFERRED.md`: what, why it waits, the trigger, the concrete
   path, and why adding it later costs no rework.
7. **No secrets in committed files.** Placeholders in `.env.example`; real values in the
   gitignored `.env` or `secrets/`, or in environment variables.
8. **Line endings and editor settings.** `.gitattributes` forces LF; `.ps1`, `.bat` and `.cmd`
   keep CRLF; binaries are marked. `.editorconfig`: 2-space indent, utf-8, LF, final newline.
9. **Automate everything: run it, do not ask.** If a command can be run, run it, then say what to
   look at. Hand the owner only what needs a browser, a phone, a physical device, or a decision
   only the owner can make. Locate binaries by full path instead of asking for a PATH fix. Start
   long-running things in the background.
10. **Agents: reasonable, and stopped when done.** Subagents and workflows are welcome when they
    add value one context cannot. Not 70 of them. The failure to avoid is burning a usage window
    in minutes by mistake, so keep fan-out proportional to the value and the risk, and stop or
    cancel agents the moment they are no longer needed.
11. **Verification gate and CI.** The check command (lint, typecheck and test in one) runs before
    every commit. CI, where the project has it, runs the same command plus a production-only
    dependency audit, and fails any change that touches code without touching `PLAN.md`,
    `CONTINUE_HERE.md` or `docs/`.
12. **Backup before any deploy that carries a migration**, and report the backup filename in the
    reply.
    - TODO: the backup command for this project, or "no database" if there is none.
13. **Shell hygiene on Windows.** Use the Bash tool for git commits with multi-line messages.
    Heredocs mangle non-ASCII and can fail on an apostrophe, so write prose files with the Write
    tool and keep heredoc content plain ASCII.
14. **Fixed stack.** The Tech stack section below is the whole list. Nothing is added or swapped
    without being asked.

## Planning for an unattended run

Nobody answers questions while AutoClaude builds, so the plan carries the decisions.

1. **Decisions are made in the plan, not during the run.** Stack, naming, scope, data model,
   folder layout and anything else with more than one reasonable answer is settled in `PLAN.md`
   under "Constraints & decisions" before the run starts.
2. **Every step has Accept lines a test or a browser can check.** "Works well" is not an Accept
   line; "GET /health returns 200 with `{"ok":true}`" is.
3. **"When something is unclear" is a real section** in `PLAN.md`: the default answers the run
   applies without asking. Anything it does not cover becomes a decider question.
4. **Steps are 20 to 90 minutes of work.** Anything bigger is split before the run.
5. **Only the gate ticks a box.** The plan is edited between runs or while paused, never by the
   builder during a run.
6. **A plan written before AutoClaude was added is reviewed against these rules** before its
   first run. `/autoclaude:plan` performs that review, lists every step that would stall an
   unattended run, and rewrites the plan into the step format.

## How an AutoClaude run works here

- The run reads `PLAN.md` step by step. The current step's full text is injected at the start of
  every session, after `/clear` and after `/compact`.
- When every Accept line of the current step holds, Claude runs `autoclaude ready <id>`. The gate
  then runs the checks, the browser tester (unless the step is tagged `no-ui`), and at a phase end
  the security review and the bug bash. On a pass it commits, ticks the box and appends a line to
  `PROGRESS.md`. On a failure it reports what broke and the step continues.
- Questions: first look in `PLAN.md` and `docs/DECISIONS.md`. If the answer is not there, ask the
  decider. A routine answer is applied and logged as `D-###` in `docs/DECISIONS.md`. A critical
  one (secret, paid service, destructive action, security trade-off, contradiction with the plan)
  stops the run with `autoclaude blocked <id> "<question with options>"`.
- `CONTINUE_HERE.md` is rewritten before every `ready`.
- `PLAN.md`, `.autoclaude/` and `autoclaude.config.json` are not edited while a run is active,
  and the builder does not commit; the gate commits after each verified step.
- Owner notes left during a pause arrive in `docs/REVIEW_NOTES.md` and are acted on first after
  a resume, with an `N-###` entry in `docs/DECISIONS.md` for each.

## Tech stack (fixed, do not deviate without being asked)

- TODO: language and runtime, with the version (for example "Node 24 LTS, ES modules").
- TODO: framework and the libraries that are locked in.
- TODO: database or storage, if any.
- TODO: test runner, lint tool and type checker.
- TODO: how it is deployed and where it runs.

## Commands

These must match `autoclaude.config.json`; the gate runs the same commands.

- TODO: lint command
- TODO: typecheck command
- TODO: test command
- TODO: one check command that runs lint, typecheck and test together
- TODO: dev server command, and the URL it serves

## Facts worth not re-deriving

Anything that cost more than five minutes to work out goes here, with the fix. Empty on day one.

- (none yet)

## Documentation index

| Doc | Read it when |
|---|---|
| `CONTINUE_HERE.md` | Starting a session. Always |
| `PLAN.md` | Starting a phase, or checking an Accept line |
| `PROGRESS.md` | You want to know which steps the gate has verified |
| `docs/DECISIONS.md` | About to change a choice that was already made |
| `docs/DEFERRED.md` | Something seems to be missing |
| `docs/SESSION_LOG.md` | You want to know what happened when |
| `docs/BLOCKERS.md` | A step is stuck, or you are picking up follow-ups |
| `docs/SECURITY-FINDINGS.md` | Touching auth, input handling or anything a row there names |
| `docs/REVIEW_NOTES.md` | Resuming after a pause |
| `autoclaude.config.json` | The gate ran a command you did not expect |
