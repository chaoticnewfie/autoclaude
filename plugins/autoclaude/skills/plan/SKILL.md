---
name: plan
description: Write, review or extend this project's AutoClaude plan with the owner - interview, settle every decision up front, set the checks, dev server and guard rules and prove they run, review an existing plan and rules for anything that would stall an unattended run, write a plan that passes lint, and hand over a committed project that passes the run preflight. Use when the user types /autoclaude:plan, asks to plan work for AutoClaude, or has just added AutoClaude to a project.
---

# Plan for an unattended run

Nobody answers questions while AutoClaude builds. Everything with more than one reasonable answer
is decided here, with the owner, and written down. A plan is ready when a stranger could build
every step from the plan alone, every Accept line can be checked on this machine without a
person, and `autoclaude run --check` passes.

Below, `autoclaude` means the CLI. If `autoclaude version` fails, use
`node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js"` instead, and suggest `autoclaude install-cli`.
The templates are in `${CLAUDE_PLUGIN_ROOT}/project-template/`. Copy the plan's structure and its
"When something is unclear" defaults from `${CLAUDE_PLUGIN_ROOT}/project-template/PLAN.md`
always, even when the project keeps a PLAN.md of its own.

## What a run does with the plan

Write the plan for this, not for a person:
- The builder is a Claude session that sees the current step's text, the project's `CLAUDE.md`
  and whatever it reads. When it runs `autoclaude ready <step>`, the gate verifies the step.
- The gate runs every command in `checks` in order (through `cmd.exe` on Windows, `/bin/sh`
  elsewhere) and reads only the exit codes.
- Unless the step is tagged `no-ui`, the browser tester then checks every Accept line of the
  step. It is a separate Claude with a headless browser plus Read, Glob and Grep. It sees only
  the step's own text and that of the earlier steps it smoke-checks, never the rest of the plan.
  It cannot run commands or read the database, and it starts from a freshly started dev server.
  It has `tester.maxTurns` tool calls (default 40), shared with smoke-checking up to six steps
  verified earlier in the phase.
- On a phase's last step the bug bash tries to break the phase's features (when the phase has a
  step that is not `no-ui`), and the security reviewer reads the diff, the step and the plan's
  "Constraints & decisions" section (by default at phase ends and on steps tagged `security`).
- On a pass the gate ticks the box and commits with `git add -A` on the run branch (by default
  `autoclaude/<the plan's H1 without "plan">`). It never pushes. A step that fails
  `retries.maxAttemptsPerStep` times (default 3) pauses the run.

## 0. Where you are

1. Run `autoclaude status`.
   - "not initialized in this project": run `/autoclaude:init` first, then come back.
   - `running`: stop. The plan cannot change during a run. The owner runs `autoclaude pause --now`
     first, or waits for the run to finish.
   - `paused`, `idle` or `complete`: go on. Steps marked `[x]` are verified work. Never change or
     renumber them; new work gets new steps with new IDs after them.
2. Read `autoclaude.config.json` (the `plan` key names the plan file), `CLAUDE.md`, any other
   agent rules file (`AGENTS.md`, `.cursorrules`, `CONTRIBUTING.md`), the plan file,
   `docs/DECISIONS.md`, `git status --short` and `git remote -v`.
3. Decide which case this is:
   - **New project**: no real code yet, and the plan file is still the template. Sections 2 to 6.
   - **Existing project**: code, history, or a plan or roadmap written before AutoClaude was added.
     Section 1 first, then 2 to 6.
   - **Extending a plan**: the plan is already in the step format and verified work exists.
     Section 2 for the new work only, a quick pass through section 3, then 4 to 6.
4. If this session is in plan mode, do the reading and the interview now. Write files only after
   the owner approves the plan and plan mode ends.

## 1. Review an existing project

Tell the owner you are reviewing the project against the rules for an unattended run. Each item
ends in a decision you record.

**a. Where the AutoClaude plan lives.** Ask the owner, with your recommendation:
- The project's own plan can be rewritten into the step format: rewrite it in place.
- It must stay as it is (other people or tools use it, or it is a narrative document) and it is
  not called `PLAN.md`: write the AutoClaude plan into the `PLAN.md` init created (no config
  change), unless the owner wants another name.
- With another name (always when the project's own plan is `PLAN.md` and must stay): set `"plan"`
  in `autoclaude.config.json`, delete the `PLAN.md` init created if it is still the untouched
  template, and use the real name everywhere you write one (the `CLAUDE.md` run section,
  `CONTINUE_HERE.md`).
An original that stays is still the source of intent: link it from the Goal section.

**b. Stall review of the existing plan.** List every item that would stop or derail an
unattended run, in a table: item, problem, proposed fix. Look for:
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
proves it against a local stand-in", leaving the real run to the owner; move it to "Before the
run"; move it to `docs/DEFERRED.md`.

**c. Rules that conflict with a run.** During a run the gate commits, nobody else commits or
pushes (unless `git.push` is true), nobody answers questions, and the builder never edits the plan
or `autoclaude.config.json`. Find rules in the rules files that say otherwise: "commit and push
after every change", "update PLAN.md at the end of every prompt", "ask before adding a
dependency", "use plan mode first", "deploy after merging", "never work on a branch". Each one
gets a line in the run section (3e) saying what happens instead during a run.

**d. Docs files that existed before init.** The run writes to the files named under `docs` in
`autoclaude.config.json`. Init never overwrites, so a file it listed as "kept as they were" (or
one git already tracked, since init commits nothing) keeps the project's own content:

| Key | What the run writes there |
|---|---|
| `continueHere` | the builder rewrites the whole file before every `ready` |
| `progress` | the gate appends one line per verified step |
| `decisions` | `D-###` and `N-###` entries from the builder and from `autoclaude answer` |
| `blockers`, `security` | table rows appended by the gate |
| `reviewNotes` | dated notes appended by `autoclaude note` |
| `sessionLog` | an entry per step, when the project's `CLAUDE.md` asks for one |

For each one that existed, ask the owner whether the run may write there in AutoClaude's format,
or point that key at a separate file (for example `"decisions": "docs/AUTOCLAUDE-DECISIONS.md"`)
created from the matching template file.

## 2. Interview

Ask what the code and docs do not already answer. Use AskUserQuestion when there are clear
options, a few related questions at a time, with your recommendation first. When the owner says
"you decide", decide, say what you chose and why, and record it. Cover:

1. **Goal**: what the project is for, who uses it, what "done" looks like for this plan.
2. **Stack**: language and runtime with versions, framework, database, test runner, lint,
   package manager. In an existing project, confirm what is there instead of asking.
3. **Data**: the model, where it is stored, what is never stored, how migrations run and how a
   test database is created on this machine.
4. **Interface**: is there a web UI? The dev server command, its URL and a health path that
   answers once the app is up (`devServer.url` plus `devServer.healthPath`). How the browser
   tester gets in (a dev-only login?) and how test data comes to exist (a seed the server runs
   at start, or created through the UI). Visual rules, or "reuse the existing components".
5. **Security**: authentication, who can do what, input that must be validated, secrets (they
   come from environment variables the owner sets; the run never creates or asks for one). Each
   answer goes into the plan's Security section, including deliberate absences such as "no
   login: listens on 127.0.0.1 only". The security reviewer reads that section; an unrecorded
   choice looks like a missing defence to it.
6. **Never touch**: what the run must never reach or change: other machines, deploy scripts,
   production data, other repositories, files the owner maintains by hand (their own roadmap).
7. **Out of scope** for this plan.
8. **When something is unclear**: go through the template's defaults and add the project's own
   (naming, error messages, logging, time zones, whatever this project will hit).
9. **Run settings**: `review.pauseAt` (never, phase-end or every-step), the weekly usage pause
   (`usage.weeklyPauseAtPct`, default 85), `git.push` (default false; true lets the builder push,
   the gate itself never pushes), and notifications (`autoclaude notify-test`; set one up with
   `autoclaude notify-setup`).

## 3. Set the project up for the run (every case)

**a. The skeleton (new project).** The checks must pass on the commit the run starts from.
Recommend creating the minimal skeleton now, in this session: the manifest with the check
scripts (for example `package.json` with `lint` and `test`), the dev tools installed locally,
one trivial passing test, and for a web UI a server entry that answers `devServer.url` plus
`devServer.healthPath`. Use check commands that can run before feature code exists: `tsc` with
no input files and a linter pointed at an empty folder both fail. If the owner prefers, the
first phase is the scaffolding instead, every step tagged `no-ui`: preflight then only warns that
the dev server is not running yet, the checks must still pass on the near-empty project, and no
check may set `needsDevServer` until the server exists.

**b. Checks and dev server.** In every case set `checks` (each `{ name, command, timeoutSec }`,
plus `"needsDevServer": true` for one that needs the running app) and `devServer` (`command`,
`url`, `healthPath`, `startTimeoutSec`; command and url both set or both null) in
`autoclaude.config.json`. Each check must exit non-zero on failure. The gate sees only exit
codes, so prefer a test runner that fails when it finds no tests (`vitest run`, `jest` and
`pytest` do; `node --test` passes with zero tests). Then run them the way the gate does:

```
autoclaude checks
```

It starts the dev server first when a check needs it and stops it after, prints one line per
check, and exits 0 only if all pass. Do not judge a check by running it with the Bash tool: the
gate uses a different shell. Then:
- A missing tool (a runtime, a database, a CLI) is an owner prerequisite, named exactly.
- A check that downloads on every run (`npx` fetching a package, a runner installing browsers)
  is replaced by a locally installed dev dependency, or its download becomes a prerequisite.
- Checks that fail on the current code: fix the baseline now, or make the plan's first step
  "make the checks pass". Every verification runs all the checks, so no other step can pass
  while they are red.
- `git status --short` must show nothing the checks or the dev server left behind.

**c. Runtime output.** Everything the app, the dev server or the tests write inside the project
(a local database file, uploads, logs, coverage, test reports, build output) is in `.gitignore`
before the run, or the gate commits it with `git add -A`.

**d. What the run must never touch.** Built in already, while a run is active: no push unless
`git.push` is true, no force push, no `git reset --hard`, no commit or tag by the builder, no
recursive delete outside the project, no edits to the plan, the config or `.autoclaude/`. Add the
rest as `guard.deny` rules in `autoclaude.config.json`, each `{ "pattern": "<case-insensitive
regular expression>", "reason": "<what to do instead>" }`. Know their limits:
- A pattern is matched against the typed command text only, in the Bash and PowerShell tools.
  An indirect run cannot be caught: `npm run deploy` does not contain the name of the script it
  calls. So name every script that reaches outside the project itself (`deploy\.sh`), every
  command that runs it, and the hosts and tools it uses.
- A harmless read that mentions a blocked name (`cat deploy.sh`) is denied too, and every
  denial counts toward the owner's "may be stuck" alert. The run section tells the builder to
  read those files with the Read and Grep tools.
- The guard does not stop edits to other files. Files the run must not edit (the owner's own
  roadmap, deploy scripts) go in the run section of `CLAUDE.md` and in the plan's Out of scope.

Look in the repo for what it could reach: deploy scripts, `ssh`/`scp`/`rsync` targets,
`kubectl`, `terraform apply`, `docker push`, database clients pointed at other hosts, cloud CLIs,
production `.env` files, package publishing. Example:

```json
"guard": { "deny": [
  { "pattern": "\\bdeploy\\.sh\\b|\\bnpm\\s+run\\s+deploy\\b", "reason": "deploying is the owner's job after review; read deploy.sh with the Read tool if you need to" },
  { "pattern": "\\b(ssh|scp|rsync)\\b|prod\\.example\\.com", "reason": "no remote machines during a run; write the script and leave running it to the owner" },
  { "pattern": "\\bnpm\\s+publish\\b", "reason": "publishing is the owner's job after review" }
] }
```

Test every rule against the commands it must block and one it must allow:

```
autoclaude guard-test "bash ./deploy.sh"
autoclaude guard-test "npm test"
```

It prints `allowed` or `denied: <reason>` for the Bash tool and for the PowerShell tool.

**e. `CLAUDE.md`.** In every case the project's `CLAUDE.md` has the section "During an AutoClaude
run". Init's template already has it; an older `CLAUDE.md` gets it copied from
`${CLAUDE_PLUGIN_ROOT}/project-template/CLAUDE.md` once the owner agrees. It says: the gate
commits; no pushing unless `git.push` is true; no edits to the plan; nobody answers, so the
builder uses the decider and `autoclaude blocked`; the per-prompt doc rules happen before each
`autoclaude ready`. Add the project's own lines: one per conflicting rule from 1c, the files the
run must not edit, the names `guard.deny` blocks (read those with Read and Grep), and the plan's
real file name if it is not `PLAN.md`. For a new project also fill the TODO lines: Tech stack,
Commands (matching `checks` and `devServer`) and the backup rule. The stack lives in `CLAUDE.md`;
the plan's Stack section holds only plan-specific pins.

## 4. Write the plan

Follow the template's order: the H1 (`# <Project name> plan`; it names the run branch), Goal,
Constraints & decisions (Stack, Data, Security, Out of scope, When something is unclear),
Requested features intake, Before the run, then the phases. Replace every placeholder and remove
the template's `## Phase 1: TODO` heading.

**Phases.** Each phase ends with something that works end to end. The bug bash and the security
review run on a phase's last step, so a phase is usually 3 to 8 steps. The plan is as long as the
work: no fixed number of steps.

**Steps.** One checkbox line with a bold ID, then indented fields:

```markdown
## Phase 2: Lists
- [ ] **S2.1** Rename a list
  - Accept: each list on /lists has a "Rename" button that turns its name into a text field
  - Accept: pressing Enter saves the new name and it is still there after a reload
  - Accept: submitting an empty name shows "Name is required" and keeps the old name
  - Test: e2e/lists.spec.ts
  - Note: log in at /dev-login (development builds only); "New list" creates a list to rename
- [ ] **S2.2** The lists API rejects bad names
  - Accept: test/lists-api.test.js shows PATCH /api/lists/:id with an empty or 201-character name returns 400 and changes nothing
  - Test: test/lists-api.test.js
  - Tags: no-ui
```

- IDs are `S<phase>.<n>`, unique and in order. After verified steps, continue the numbering;
  never reuse an ID. 20 to 90 minutes of work per step; split anything bigger. Order steps so
  each builds only on earlier ones.
- **Tags.** An untagged step is a UI step: the browser tester checks it. `no-ui` skips the
  browser. `security` is for steps whose main work is authentication, permissions or secrets;
  the security review then runs on that step too. `ui` and `db` are labels only.
- **UI steps** (every step not tagged `no-ui`): every Accept line must be observable from the
  browser: what the page shows, the URL, a fetch from the page (status and body), or a file the
  tester can Read. A line only a test, a command or a database query can prove goes in a separate
  `no-ui` step. About five browser-checkable Accept lines per UI step, including the failure
  cases that matter; the smoke checks of earlier steps share the same turn budget.
- **Notes.** Anything the tester (or the builder) needs goes in an indented `- Note:` line: a
  dev-only login, how to create test data, where a feature lives. The parser keeps every
  indented line in the step's text, and the tester sees nothing else of the plan. The dev server
  is restarted before the tester runs, so data that lived only in the running server is gone.
- **`no-ui` steps** are only as strong as the tests the builder writes: the gate runs the checks
  and reads their exit codes, nothing more. Each needs a `Test:` line (lint requires one), the
  checks must run those files, and each Accept line says what a test proves.
- `Test:` names the test files the step creates or extends; the checks must run them.

**Before the run.** Plain bullets (not checkboxes) for what the owner does first. Always include
the ones that apply:
- Open `claude` once in the project folder, accept the trust dialog, then `/exit`.
- `npx playwright install chromium`, when the plan has UI steps and `devServer` is set.
- Stop any copy of the app on the dev server's port: the gate reuses whatever answers at the URL,
  which may be running old code.
- Turn off sleep for a long run: a sleeping machine or a log-off stops the run.
Then the project's own: tools to install, environment variables, a local test database, sign-ins.

**Estimate.** Steps times about 45 minutes, plus the phase-end bug bash and security review.
With `review.pauseAt` set to `phase-end` the run also waits at every phase end until the owner
resumes it (`every-step`: after every step). A plan too long for the time available can end at a
phase boundary.

## 5. Check it

1. `autoclaude lint-plan` (or `autoclaude lint-plan <file>`). It checks the structure (phases,
   IDs, their order, no duplicate or empty phases), the tags, a `Test:` line on every `no-ui`
   step, and leftover template placeholders. Fix every problem and run it again until it prints
   ok.
2. Lint cannot judge whether an Accept line is observable; this read-through is the real stall
   check. Read each step as the builder (could it be built from the plan alone without asking
   anything?) and each UI step as the tester (with only this step's text, a browser and Read,
   could every Accept line be checked in a few actions?). Fix any step that fails.
3. Record every decision made in this session in `docs/DECISIONS.md` (the `docs.decisions` file)
   in the entry format at its top, with `planning` as the step, and every request that is not in
   this plan in the Requested features intake table.

## 6. Hand over

1. Show the owner, and ask for approval:
   - the phases and steps as a short table (ID, title, tags), and the estimate
   - the decisions recorded, the `autoclaude.config.json` changes, the `CLAUDE.md` changes
   - the Before the run list
   - anything moved to `docs/DEFERRED.md` or left out
2. Once approved, rewrite `CONTINUE_HERE.md` (the `docs.continueHere` file): the plan is ready,
   the first step, the Before the run list, and how to start: `autoclaude run` from a new
   terminal opened in the project.
3. Commit everything init and this session created or changed, in the project's commit style.
   `git status --short` must print nothing: a run needs a clean working tree. Push only if the
   project has a remote and its rules call for a push.
4. Run `autoclaude run --check` (the preflight alone; it opens no window) and show the result.
   Each FAIL line is fixed now or becomes a Before the run item. It starts and stops the dev
   server, so check `git status --short` once more.
5. Tell the owner how to start: after the Before the run list, `autoclaude run` from a new
   terminal in the project. It opens a window named `ac-<project>` where the build runs.
   `autoclaude status` shows progress from any terminal; `autoclaude pause` stops after the next
   verified step, `autoclaude pause --now` at once.

When the run is `paused` rather than new or complete, commit only what this session changed (the
builder's unfinished work stays in the working tree for it), and the owner continues with
`autoclaude resume`, after `autoclaude run` if the run's `ac-<project>` window is gone.
