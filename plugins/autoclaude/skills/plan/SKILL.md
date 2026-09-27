---
name: plan
description: Write, review or extend this project's AutoClaude plan with the owner - interview, settle every decision up front, review an existing plan and rules for anything that would stall an unattended run, set checks and guard rules, and write a plan that passes lint. Use when the user types /autoclaude:plan, asks to plan work for AutoClaude, or has just added AutoClaude to a project.
---

# Plan for an unattended run

Nobody answers questions while AutoClaude builds. Everything with more than one reasonable answer
is decided here, with the owner, and written down. A plan is ready when a stranger could build it
from the plan alone, and every Accept line can be checked on this machine without a person.

Below, `autoclaude` means the CLI. If `autoclaude version` fails, use
`node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js"` instead, and suggest `autoclaude install-cli`.

## 0. Where you are

1. Run `autoclaude status`.
   - "not an AutoClaude project": run the init skill (`/autoclaude:init`) first, then come back.
   - `running`: stop. The plan cannot change during a run. The owner runs `autoclaude pause --now`
     first, or waits for the run to finish.
   - `paused`, `idle` or `complete`: go on. Steps marked `[x]` are verified work. Never change or
     renumber them; new work gets new steps after them.
2. Read `autoclaude.config.json` (the `plan` key names the plan file), `CLAUDE.md`, any other
   agent rules file (`AGENTS.md`, `.cursorrules`, `CONTRIBUTING.md`), the plan file, and
   `docs/DECISIONS.md` if present.
3. Decide which case this is:
   - **New project**: no real code yet, and the plan file is still the template. Go to step 2.
   - **Existing project**: code, history, or a plan or roadmap written before AutoClaude was added.
     Do step 1 first.
   - **Extending a plan**: the plan is already in the step format and verified work exists. Do
     step 2 for the new work only, then steps 3 to 5.
4. If this session is in plan mode, do the reading and the interview now. Write files only after
   the owner approves the plan and plan mode ends.

## 1. Review an existing project (before any new planning)

Tell the owner you are reviewing the project against the rules for an unattended run, then work
through these. Each one ends in a decision you record.

**a. Where the AutoClaude plan lives.** If the project already has a plan or roadmap:
- If it can be rewritten into the step format, rewrite it in place.
- If it must stay as it is (other people or tools use it, or it is a narrative document), write
  the AutoClaude plan to a separate file such as `AUTOCLAUDE-PLAN.md` and set `"plan"` in
  `autoclaude.config.json` to it. The original stays the source of intent; link it from the new
  plan's Goal section.
Ask the owner which, with your recommendation.

**b. Stall review of the existing plan.** List every item that would stop or derail an
unattended run, in a table: item, problem, proposed fix. Problems to look for:
- no testable Accept line ("works well", "clean up", "improve")
- an open decision (a library, a name, a data shape, "decide later", "TBD")
- needs a person: hardware, a phone, an approval, a manual test, a design review
- needs a secret, an account, a paid service or network access the run does not have
- touches anything outside this project: other repositories, servers, SSH, cloud consoles,
  production data, system configuration, other machines on the network
- cannot be checked on this machine (a tool is missing, a service is not running here)
- bigger than about 90 minutes of work, or depends on work that is not in the plan

Fixes, in order of preference: rewrite with Accept lines; decide now and record it; split; turn
"do it to the real system" into "produce the script, migration or config, with a test that
proves it against a local stand-in", leaving the real run to the owner afterwards; move to an
owner prerequisite before the run (section 4); move to `docs/DEFERRED.md`.

**c. Rules that conflict with a run.** During a run the gate commits after each verified step,
the builder does not commit, pushing is off unless `git.push` is true, nobody answers questions,
and the builder never edits the plan or `autoclaude.config.json`. Find rules in `CLAUDE.md` and
the other rules files that say otherwise, for example "commit and push after every change",
"ask before adding a dependency", "use plan mode first", "deploy after merging", "never work on
a branch". Propose a short section for the project's `CLAUDE.md`, and add it once the owner
agrees:

```markdown
## During an AutoClaude run

These override the rules above while `autoclaude status` says running:
- The gate commits after each verified step; do not commit or push yourself.
- Nobody answers questions. Decide from PLAN.md and docs/DECISIONS.md, ask the decider, and
  stop with `autoclaude blocked` only for a critical question.
- (one line per conflicting rule found, saying what happens instead)
```

**d. What the run must never touch.** Built in already: no pushing (unless `git.push` is true), no
force push, no `git reset --hard`, no commits by the builder, no recursive deletes outside the
project, no edits to the plan, the config or `.autoclaude/`. Add the rest as `guard.deny` rules
in `autoclaude.config.json`, each `{ "pattern": "<case-insensitive regular expression matched
against the Bash command>", "reason": "<what to do instead>" }`. Look in the repo for what it
could reach: deploy scripts, `ssh`/`scp`/`rsync` targets, `kubectl`, `terraform apply`,
`docker push`, database clients pointed at non-local hosts, cloud CLIs, production `.env` files,
package publishing. Ask the owner what else is off limits. Example:

```json
"guard": { "deny": [
  { "pattern": "\\b(ssh|scp|rsync)\\b", "reason": "No remote machines during a run; write the script and leave running it to the owner." },
  { "pattern": "\\bnpm\\s+publish\\b", "reason": "Publishing is the owner's job after review." }
] }
```

**e. Do the checks run here?** For every command in `checks` in `autoclaude.config.json`, run it
now with the Bash tool. Each must exist, finish within its `timeoutSec`, and exit non-zero on
failure. Then:
- A missing tool (a runtime, a database, a CLI) is an owner prerequisite, named exactly.
- If the checks fail on the current code, the first step of the plan makes them pass, or the
  owner fixes it before the run. A run cannot start from a red baseline: every step would fail.
- If there is a web UI, confirm `devServer.command` and `devServer.url` start the app and answer.
  Without them the browser tester and bug bash are skipped, and only the checks verify steps.

## 2. Interview

Ask what the code and docs do not already answer. Use AskUserQuestion when there are clear
options, a few related questions at a time, with your recommendation first. When the owner says
"you decide", decide, say what you chose and why, and record it. Cover:

1. **Goal**: what the project is for, who uses it, what "done" looks like for this plan.
2. **Stack**: language and runtime with versions, framework, database, test runner, lint,
   package manager. In an existing project, confirm what is there instead of asking.
3. **Data**: the model, where it is stored, what is never stored, how migrations run and how a
   test database is created on this machine.
4. **Interface**: is there a web UI? Its dev server command and URL. Visual rules, or "reuse the
   existing components".
5. **Security**: authentication, who can do what, input that must be validated, secrets (they
   come from environment variables the owner sets; the run never creates or asks for one).
6. **Out of scope** for this plan.
7. **When something is unclear**: go through the default answers in the plan template and add
   the project's own (naming, error messages, logging, time zones, whatever this project will hit).
8. **Run settings**: `review.pauseAt` (never, phase-end or every-step), the weekly usage pause
   (`usage.weeklyPauseAtPct`, default 85), whether the run may push (`git.push`, default off),
   and whether notifications work (`autoclaude notify-test`; set one up with
   `autoclaude notify-setup`).

## 3. Write the plan

Use the template's structure (`PLAN.md` as `init` wrote it): Goal, Constraints & decisions
(Stack, Data, Out of scope, When something is unclear), Requested features intake, then the
phases. Fill every section from the interview and review; no placeholders left.

**Phases.** Each phase ends with something that works end to end. The bug bash and the security
review run on a phase's last step, so a phase is usually 3 to 8 steps. The plan is as long as the
work: no fixed number of steps.

**Steps.** One checkbox line with a bold ID, then indented fields:

```markdown
## Phase 2: Lists
- [ ] **S2.1** Rename a list
  - Accept: each list on /lists has a "Rename" button that turns its name into a text field
  - Accept: pressing Enter saves the new name and it survives a reload
  - Accept: PATCH /api/lists/:id with an empty name returns 400 and changes nothing
  - Test: test/lists.test.js
  - Tags: ui
```

- IDs are `S<phase>.<n>`, unique, numbered in order. New steps after verified ones continue the
  numbering; never reuse an ID.
- 20 to 90 minutes of work each. Split anything bigger.
- Accept lines are observable: something seen in a browser, an HTTP response, a test that passes,
  a command's exit code or output, a file's content. Include the failure cases that matter.
- Every Accept line can be checked on this machine by the checks or the browser tester, with no
  person and no outside system.
- `Tags`: `ui` when there is something to check in the browser; `no-ui` when there is not (the
  browser tester skips it, so the checks alone verify it and the step must name its tests in
  `Test:`); `security` for authentication, permissions, input handling, secrets, file or database
  access (the security review then runs on that step too, not only at the phase end); `db` for
  schema and migrations.
- `Test:` names the test files the step creates or extends. The checks must run them.
- Order steps so each builds only on earlier ones.

**Owner prerequisites.** Anything the owner must do before the run goes in a section named
`## Before the run` above the phases, as plain bullets (not checkboxes): tools to install,
environment variables to set, a local test database to create, accounts to sign in to.

**Estimate.** Tell the owner the rough length: the number of steps times about 45 minutes, plus
the phase-end checks. A plan that is too long for the time they have can end at a phase boundary.

## 4. Check it

1. `autoclaude lint-plan` (or `autoclaude lint-plan <file>` for a separate plan file). Fix every
   problem and run it again until it prints ok.
2. Re-read each step as the builder would, knowing only the plan: could it be built and verified
   without asking anything? Fix any step that fails this.
3. Record every decision made in this session in `docs/DECISIONS.md` (dated, what was chosen,
   why, what was rejected), and every request that is not in this plan in the plan's Requested
   features intake table.

## 5. Hand over

Show the owner:
- the phases and steps as a short table (ID, title, tags), and the estimate
- the decisions recorded, the `autoclaude.config.json` changes, and any `CLAUDE.md` section added
- the owner prerequisites
- anything from the review that was moved to `docs/DEFERRED.md` or left out

Ask for approval. Once approved, commit the plan, config and doc changes (a run needs a clean
working tree), following the project's own commit rules. Then say how to start:

```
autoclaude run
```

run from a terminal opened in the project after every prerequisite is done. It opens a window
named `ac-<project>` and the build starts there. `autoclaude status` shows progress from any
terminal; `autoclaude pause` stops it after the next verified step.
