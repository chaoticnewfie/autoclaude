---
name: plan
description: Write, review or extend this project's AutoClaude plan with the owner - an interview in rounds of questions that asks and never assumes (the run's scope, security, run settings and hand-back included), the checks, dev server, guard and permission rules proven to run, a stall review of an existing plan, a plan that passes lint, and a committed project that passes the run preflight. Use when the user types /autoclaude:plan, asks to plan work for AutoClaude, or has just added AutoClaude to a project.
---

# Plan for an unattended run

Nobody answers questions while AutoClaude builds. Everything with more than one reasonable answer
is decided here, by the owner, and written down. The run then does the bulk of the build, all of
what the plan allows, work outside this folder included, the way a session the owner watched
would; the owner fine-tunes afterwards in ordinary sessions. A plan is ready when a stranger could
build every step from the plan alone, every Accept line can be checked on this machine without a
person, and `autoclaude run --check` passes.

Below, `autoclaude` means the CLI. If `autoclaude version` fails, use
`node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js"` instead, and suggest `autoclaude install-cli`.
The templates are in `${CLAUDE_PLUGIN_ROOT}/project-template/`. Copy the plan's structure and its
"When something is unclear" defaults from `${CLAUDE_PLUGIN_ROOT}/project-template/PLAN.md`
always, even when the project keeps a PLAN.md of its own.

## How this interview works: ask, never assume

A wrong assumption costs a whole night of building; a question costs a minute. So:

- **Every open decision goes to the owner**, asked with AskUserQuestion. What the code, the docs
  or the owner's notes suggest becomes the recommended option, never an answer you apply
  silently: put it first, add "(Recommended)" to its label, and say in the question where it
  comes from ("package.json already uses vitest", "your notes say VM 120"). Each question has 2
  to 4 options; the owner can always type another answer.
- **Rounds of up to 4 questions, grouped by topic.** Before the first round, name the topics
  coming and about how many rounds to expect (usually 10 to 14 for a new project; an existing
  project adds the review rounds of section 1). There is no cap: 25 questions or more is normal
  and wanted. Every topic of section 2 is asked, even when the answer looks obvious.
- **Decide alone only where the owner says "you decide"**, for one question, a topic, or
  everything left. Then decide, say what you chose and why, and record it with
  `- By: Claude (the owner said "you decide")`.
- **A question asked only in prose stays open until the owner answers it.** Silence, or a reply
  about something else, is not an answer. Before writing the plan, list every open question and
  ask it again.
- **If AskUserQuestion is not available** (a headless session), ask the same rounds as numbered
  text questions with the options and your recommendation, and wait for the answers.
- **Ask before installing, pulling or starting anything** in this session: a package install, a
  Docker pull, a container, a service, the dev server that `autoclaude checks` and
  `autoclaude run --check` start. Say what and why, grouped into one question where you can.
- **`docs/DECISIONS.md` records only options the owner actually saw.** Its `Rejected:` line names
  the options that were shown, not alternatives you considered on your own.
- **Polish is not the plan's job.** Settle what a run cannot guess; the owner fine-tunes later.

## What a run does with the plan

Write the plan for this, not for a person:
- The builder is a Claude session that sees the current step's text, the project's `CLAUDE.md`,
  `CONTINUE_HERE.md` and whatever it reads. A fresh builder session starts every feature (phase).
  It runs only the tests for what it changed; the gate runs the full checks.
- With `gate.verifyAt: "phase"` (the default), `autoclaude ready <step>` on a step inside a phase
  commits it as built (`[~]`) with no checks. The phase's last step verifies the whole feature:
  - every command in `checks`, in order (through `cmd.exe` on Windows, `/bin/sh` elsewhere),
    judged only by exit codes;
  - the browser tester over every Accept line of the phase's steps not tagged `no-ui`. It is a
    separate Claude with a headless browser plus Read, Glob and Grep. It sees only the phase's
    step text, never the rest of the plan. It cannot run commands or read the database, and it
    starts from a freshly started dev server. Its budget is `tester.maxTurns` (default 40) tool
    calls per 5 Accept lines, up to 4 times that;
  - the bug bash, which tries to break the feature (when the phase has a step that is not
    `no-ui`), and the security review of the whole feature's diff against the plan's
    "Constraints & decisions" section.
- A feature gets `retries.maxAttemptsPerStep` attempts (default 3); then the run pauses.
  Non-blocking findings get a fix-up pass: each is fixed or left for the owner with a reason.
  On a pass the gate ticks the phase's boxes, commits with `git add -A` on the run branch (by
  default `autoclaude/<the plan's H1 without "plan">`), tags it and, with `git.push` true (the
  default), pushes the branch and the tag. With `"step"` every step is verified on its own.
- Mid-run questions: the builder settles them from the plan, then asks the decider
  (`autoclaude decide`). Work the plan allows is routine; a choice that accepts a security risk
  is logged with "Owner review: yes"; only what the plan does not cover and only the owner can
  decide stops the run.
- At the end the run writes `HANDOFF.md`: what was built, what is left for the owner (the plan's
  "After the run" list plus what the run left), secrets it created, open findings, owner-review
  decisions, the push state and the machine footprint (Docker things it created; the unused ones
  are removed).

## 0. Where you are

1. Run `autoclaude status`.
   - "not initialized in this project": run `/autoclaude:init` first, then come back.
   - `running`: stop. The plan cannot change during a run. The owner runs `autoclaude pause --now`
     first, or waits for the run to finish.
   - `paused`, `idle` or `complete`: go on. Steps marked `[x]` are verified work and `[~]` built
     work. Never change or renumber them; new work gets new steps with new IDs after them.
2. Read `autoclaude.config.json` (the `plan` key names the plan file), `CLAUDE.md`, any other
   agent rules file (`AGENTS.md`, `.cursorrules`, `CONTRIBUTING.md`), the plan file,
   `docs/DECISIONS.md`, `git status --short` and `git remote -v`. Reading is free; asking comes
   next.
3. Decide which case this is:
   - **New project**: no real code yet, and the plan file is still the template. Sections 2 to 6.
   - **Existing project**: code, history, or a plan or roadmap written before AutoClaude was added.
     Section 1 first, then 2 to 6.
   - **Extending a plan**: the plan is already in the step format and verified work exists.
     Section 2 for the new work only, but the scope (2.6), run settings (2.9) and hand-back
     (2.10) rounds are always asked again, with the current values as the recommendations. Then
     a quick pass through section 3, then 4 to 6.
4. If this session is in plan mode, do the reading and the interview now. Write files only after
   the owner approves the plan and plan mode ends.

## 1. Review an existing project

Tell the owner you are reviewing the project against the rules for an unattended run. Each item
ends in a question to the owner and a decision you record.

**a. Where the AutoClaude plan lives.** Ask, with your recommendation:
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
- needs a secret, an account or a paid service this machine cannot provide
- cannot be checked on this machine (a tool is missing, a service is not running here)
- bigger than about 90 minutes of work, or depends on work that is not in the plan

Work that reaches outside this folder (other machines, deploys, other repositories) is not a
stall: list it separately for the scope round (2.6), where the owner decides who does it.

Then ask about each item, in rounds, with your proposed fix as the recommended option. Fixes:
rewrite with Accept lines; the owner decides it now; split; move it to "Before the run" or
"After the run"; move it to `docs/DEFERRED.md`.

**c. Rules that conflict with a run.** During a run the gate commits every step and pushes each
verified feature (when `git.push` is true), nobody else commits or pushes, nobody answers
questions, and the builder never edits the plan or `autoclaude.config.json`. Find rules in the
rules files that say otherwise: "commit and push after every change", "update PLAN.md at the end
of every prompt", "ask before adding a dependency", "use plan mode first", "deploy after
merging", "never work on a branch". Each one gets a line in the run section (3f) saying what
happens instead during a run; show the list and confirm it with the owner. Read the owner's
user-level `~/.claude/CLAUDE.md` too: the builder loads it as well. The run rules already say
they override it; name its conflicting rules in the run section anyway, so nobody is surprised.

**d. Docs files that existed before init.** The run writes to the files named under `docs` in
`autoclaude.config.json`. Init never overwrites, so a file it listed as "kept as they were" (or
one git already tracked, since init commits nothing) keeps the project's own content:

| Key | What the run writes there |
|---|---|
| `continueHere` | the builder rewrites the whole file before every `ready` |
| `progress` | the gate appends one line per verified step |
| `decisions` | `D-###` and `N-###` entries from the builder and from `autoclaude answer` |
| `blockers`, `security` | table rows appended by the gate; the fix-up pass changes their status |
| `reviewNotes` | dated notes appended by `autoclaude note` |
| `sessionLog` | an entry per feature, when the project's `CLAUDE.md` asks for one |

For each one that existed, ask the owner whether the run may write there in AutoClaude's format,
or point that key at a separate file (for example `"decisions": "docs/AUTOCLAUDE-DECISIONS.md"`)
created from the matching template file.

## 2. Interview

Every topic below is asked, in this order, one or more rounds each. In an existing project the
recommended options come from what is there; the owner still confirms them.

**2.1 Goal.** What the project is for, who uses it, what "done" looks like for this plan, and
which features this plan covers.

**2.2 Stack.** Language and runtime with versions, framework, database, test runner, lint,
package manager. In an existing project, offer what is there as the recommendation.

**2.3 Data.** The model, where it is stored, what is never stored, how migrations run and how a
test database is created on this machine.

**2.4 Interface and the tester's access.** Is there a web UI? The dev server command, its URL
and a health path that answers once the app is up (`devServer.url` plus `devServer.healthPath`).
How the browser tester gets in (a dev-only login?) and how test data comes to exist (a seed the
server runs at start, or created through the UI). Visual rules, or "reuse the existing
components".

**2.5 Security.** Authentication, who can do what, input that must be validated, where the app
listens (localhost, the LAN, the internet behind a proxy), and where secrets come from. Then the
security-acceptance policy, as its own question: when a choice during the run would accept a
security risk, the run decides, logs it with "Owner review: yes" and keeps going (recommended),
or stops and asks. And which severity fails a feature (`security.blockOn`: `high`, the default,
`medium` or `low`). Each answer goes into the plan's Security section, including deliberate
absences such as "no login: listens on 127.0.0.1 only". The security reviewer reads that
section; an unrecorded choice looks like a missing defence to it.

**2.6 Scope: always asked, never inferred.** This round decides what the run does outside this
folder. It is asked even when the owner's notes seem to answer it; those notes supply the
recommended options.
1. List everything the work reaches outside this folder: machines to create or change (VMs,
   containers on other hosts), servers to deploy to, other repositories, cloud services, DNS,
   the system configuration of this machine, databases on other hosts. Look in the owner's
   notes, the existing plan, deploy scripts, `ssh`/`scp`/`rsync` targets, `kubectl`, `terraform`,
   `docker push`, database clients pointed at other hosts, cloud CLIs and `.env` files. Then ask
   an open question too: anything else the run should do outside this folder?
2. For each item, one question with three options: **"The run does it"** (Recommended), **"Write
   it for me"** (the run writes the script or config and a test against a local stand-in; the
   owner runs it, and it is listed under "After the run"), or **"Leave it out"** (Out of scope).
   For each "the run does it", ask what it needs: the host name and address, how the run signs in
   (a key already on this machine; never a password in the plan), the IDs and specs to use, and
   what it may change there. With the owner's OK, prove the access now with a harmless read-only
   command (for example `ssh <host> hostname`); if it fails, the fix is a "Before the run" item.
3. For each existing machine the run will change: "Take a snapshot of it before the run changes
   it?", "Yes" (Recommended) or "No". A yes becomes the first work on that machine: the step that
   first changes it takes the snapshot, and an Accept line proves it exists.
4. What the run must never touch, with options drawn from what you found (other machines on the
   same host, production data, the owner's own roadmap, deploy scripts for other systems) plus
   the owner's own words. Files in this project the run must not edit go into the `CLAUDE.md`
   run section.
5. The proposed `guard.deny` rules, as their own approval question: the rules in plain words and
   their patterns, "Approve" (Recommended), "Change them" or "No deny rules". Deny rules come
   only from the never-touch answers, and never block work the plan gives to the run (3d).
6. Installing tools and packages, using Docker and creating GitHub repositories are allowed
   unless the owner says otherwise: confirm it with one question, "Allowed" (Recommended) or
   "Limit it".
7. Secrets. Name each secret the plan needs. The ones this machine can generate (database
   passwords, signing keys, tokens for services the run sets up) the run generates into the
   gitignored `secrets/` folder: confirm it. The ones it cannot (a third-party API key, an
   account) become "Before the run" items saying where the owner puts them, or the feature is
   left out.
8. The permission rules and trusted-infrastructure lines that follow from the answers (3e), as
   their own approval question.

The answers become the plan's Scope section, `guard.deny` (3d), `permissions` (3e) and the
"After the run" list.

**2.7 Out of scope.** What this plan deliberately does not do. Requests that wait go to the
Requested features intake table and, once decided, to `docs/DEFERRED.md`.

**2.8 When something is unclear.** Show the template's defaults and ask which to keep (a
multi-select question), then ask for the project's own: naming, error messages, logging, time
zones, whatever this project will hit.

**2.9 Run settings.** Recommend the value in effect now: the built-in default, unless this
computer's defaults file (`autoclaude/defaults.json` in the Claude config folder, `~/.claude`
unless `CLAUDE_CONFIG_DIR` names another) sets one. Write an answer into the project's
`autoclaude.config.json` only when it differs from what the project inherits, so the project
keeps following this computer's defaults. An answer meant for every project on this computer is
set on the config page (`autoclaude config`) instead. Two rounds:
- `gate.verifyAt`: `"phase"`, verify once per feature (Recommended, the faster default), or
  `"step"`, every step on its own.
- `review.pauseAt`: `never` (Recommended for an all-day run), `phase-end` (the run waits after
  every feature until `autoclaude resume`) or `every-step`.
- `git.push`: the gate pushes the run branch and the phase tag after each verified feature
  (Recommended, the default) or nothing leaves this machine. Pushing needs a remote this machine
  can push to: with no remote, offer to create a private GitHub repository now, or no push.
- Alerts, a multi-select of `notify.events`: feature verified (on by default), step verified,
  run started, run resumed, paused by the owner; and `notify.morningSummaryAt` (a time like
  `07:30`, or none). Alerts that need the owner (blocked, failed, stuck, paused by a limit, a
  failed push) and the completion alert always go out. `autoclaude notify-test` shows whether a
  channel is set up; `autoclaude notify-setup` or the config page sets one.
- The weekly usage pause (`usage.weeklyPauseAtPct`, default 85) and whether the run resumes by
  itself after the weekly reset (`usage.autoResumeAfterWeeklyReset`, default false). Show the
  estimate (section 4) next to it.
- `builder.effort`: unset (Recommended; the builder uses the owner's own Claude Code default) or
  one of `low`, `medium`, `high`, `xhigh`, `max`, `ultracode` (which runs at `xhigh`: a run never
  uses ultracode's multi-agent workflows).

**2.10 Hand-back.** What the owner gets at the end:
- Docker cleanup (`footprint.docker`): remove the stopped containers, unused volumes and unused
  networks the run created and report the rest (Recommended), or keep everything and report it.
- The "After the run" list: show it ("write it for me" items with the exact command, anything
  only a person can do, what to review before merging) and ask what to add.
- Merging the run branch stays the owner's, after review of `HANDOFF.md`, the commits and the
  owner-review decisions.

**2.11 Features.** Propose the phases, one feature each (section 4), as a short list with the
steps in each, and ask the owner to approve the list and its order before you write the steps.

## 3. Set the project up for the run (every case)

**a. The skeleton (new project).** The checks must pass on the commit the run starts from.
Recommend creating the minimal skeleton now, in this session, and ask before installing
anything: the manifest with the check scripts (for example `package.json` with `lint` and
`test`), the dev tools installed locally, one trivial passing test, and for a web UI a server
entry that answers `devServer.url` plus `devServer.healthPath`. Use check commands that can run
before feature code exists: `tsc` with no input files and a linter pointed at an empty folder both
fail. If the owner prefers, the first phase is the scaffolding instead, every step tagged
`no-ui`: preflight then only warns that the dev server is not running yet, the checks must still
pass on the near-empty project, and no check may set `needsDevServer` until the server exists.

**b. Checks and dev server.** In every case set `checks` (each `{ name, command, timeoutSec }`,
plus `"needsDevServer": true` for one that needs the running app) and `devServer` (`command`,
`url`, `healthPath`, `startTimeoutSec`; command and url both set or both null) in
`autoclaude.config.json`. A check that needs a tool or service can name a prerequisite command
in `requires` (for example `"requires": "docker version"`): the preflight runs it before the run
and fails, naming the check, when it does not pass. Each check must exit non-zero on failure.
The gate sees only exit codes, so prefer a test runner that fails when it finds no tests
(`vitest run`, `jest` and `pytest` do; `node --test` passes with zero tests). Then, with the
owner's OK (it may start the dev server), run them the way the gate does:

```
autoclaude checks
```

It runs in the gate's environment, starts the dev server first when a check needs it and stops
it after, prints one line per check, and exits 0 only if all pass. Do not judge a check by
running it with the Bash tool: the gate uses a different shell. Then:
- A missing tool (a runtime, a database, a CLI) is an owner prerequisite, named exactly, or,
  when the owner allows installs, something the first step installs.
- A check that downloads on every run (`npx` fetching a package, a runner installing browsers)
  is replaced by a locally installed dev dependency, or its download becomes a prerequisite.
- Checks that fail on the current code: fix the baseline now, or make the plan's first step
  "make the checks pass". Every feature's verification runs all the checks, so nothing can pass
  while they are red.
- `git status --short` must show nothing the checks or the dev server left behind.

**c. Runtime output and secrets.** Everything the app, the dev server or the tests write inside
the project (a local database file, uploads, logs, coverage, test reports, build output) is in
`.gitignore` before the run, or the gate commits it with `git add -A`. So is `secrets/`, where
the run generates the secrets it needs.

**d. Deny rules (`guard.deny`).** Built in already, while a run is active: no push while
`git.push` is false (when it is true the gate pushes, and the run rules tell the builder not
to), no force push, no `git reset --hard`, no commit or tag by the builder, no recursive delete
outside the project (the OS temp folder excepted), no edits to the plan, the config or
`.autoclaude/`. Add only what the owner approved in 2.6 as `guard.deny` rules in
`autoclaude.config.json`, each `{ "pattern": "<case-insensitive regular expression>", "reason":
"<what to do instead>" }`. Know their limits:
- A pattern is matched against each command a Bash or PowerShell line runs (quotes removed), not
  against heredoc bodies, printed text or commit messages. A command that only reads the files
  it names (`cat deploy-prod.sh`, `grep`, `Get-Content`, a linter) passes. What runs is
  matched: a script run through a shell, `./x`, `source`, `powershell -File`, and the
  package.json script that `npm run x` maps to. The Read and Grep tools are never blocked.
- The guard cannot see inside a script, a Makefile target or a program that calls another one.
  So name every script that reaches what must not be touched (`deploy-prod\.sh`), every command
  that runs it, and the hosts and tools it uses.
- The guard does not stop edits to other files. Files the run must not edit (the owner's own
  roadmap, deploy scripts) go in the run section of `CLAUDE.md` and in the plan's Scope.
- A deny rule must never block work the plan gives to the run: a rule on `ssh` in general would
  stop the VM the owner asked for. Name the forbidden host, not the tool.

Example:

```json
"guard": { "deny": [
  { "pattern": "\\bdeploy-prod\\.sh\\b|\\bnpm\\s+run\\s+deploy:prod\\b", "reason": "production deploys are the owner's job after review; read deploy-prod.sh with the Read tool if you need to" },
  { "pattern": "\\bprod-db(\\.example\\.com)?\\b", "reason": "the production database host is off limits in this plan" },
  { "pattern": "\\bnpm\\s+publish\\b", "reason": "publishing is the owner's job after review" }
] }
```

Write the rules with the Edit or Write tool, not a shell one-liner: a shell collapses `\\` and
turns `\b` into a backspace, and the rule then silently matches nothing. Test every rule against
the commands it must block, and the commands of the allowed work that it must let through:

```
autoclaude guard-test "bash ./deploy-prod.sh"
autoclaude guard-test "ssh vmhost qm list"
```

It prints `allowed` or `denied: <reason>` for the Bash tool and for the PowerShell tool.

**e. Permissions for the allowed work (`permissions`).** Claude Code's auto mode checks each
action with a classifier, and by default it blocks remote shells to hosts it does not know as
trusted. So for the work the owner gave to the run outside this folder, write into
`autoclaude.config.json` (project only):
- `permissions.allow`: Claude Code permission rules for the commands that work uses, for example
  `Bash(ssh vmhost *)` or `PowerShell(Get-VM *)`. An allow rule runs the command without a prompt
  and skips the classifier (writes to protected paths and deletes of critical paths still ask),
  and deny rules still win. `*` matches any text, spaces included; a compound command
  (`a && b`) is split and every part must match a rule of its own; PowerShell rules are
  case-insensitive and aliases are resolved. Keep each rule as narrow as the work: one host, one
  tool, never `Bash(*)` and never `Bash(ssh *)` when one host is meant.
- `permissions.environment`: plain-language lines naming the trusted infrastructure for the
  classifier, for example "The virtualization host vmhost (192.0.2.10) belongs to the owner; the
  run may create and configure VM 120 there and must not change any other VM." Claude Code reads
  these only from user settings, managed settings or `--settings`, never from a project's files,
  which is why they live here.

```json
"permissions": {
  "allow": ["Bash(ssh vmhost *)", "Bash(scp * vmhost:*)"],
  "environment": ["The virtualization host vmhost (192.0.2.10) belongs to the owner; the run may create and configure VM 120 there and must not change any other VM."]
}
```

The supervisor passes both to every builder session it launches, through `--settings`; the
owner's own settings files are not changed, and nothing outside a run gets these permissions.
Leave both empty when the plan does nothing outside this folder.

**f. `CLAUDE.md`.** In every case the project's `CLAUDE.md` has the section "During an AutoClaude
run". Init's template already has it; an older `CLAUDE.md` gets it copied from
`${CLAUDE_PLUGIN_ROOT}/project-template/CLAUDE.md` once the owner agrees. It says: the gate
commits, tags and pushes; the builder runs only the tests for what it changed; `CONTINUE_HERE.md`
every step and the other paperwork once per feature; nobody answers, so the builder uses
`autoclaude decide` and, rarely, `autoclaude blocked`; the run stays within what the plan allows;
no edits to the plan. If the project's `CLAUDE.md` has no Definition of done, spell those duties
out in the section (for example: rewrite CONTINUE_HERE.md, add decisions to docs/DECISIONS.md,
one session log entry per feature). Add the project's own lines: one per conflicting rule from
1c, the files the run must not edit, the names `guard.deny` blocks, and the plan's real file name
if it is not `PLAN.md`. For a new project also fill the TODO lines: Tech stack, Commands
(matching `checks` and `devServer`) and the backup rule. The stack lives in `CLAUDE.md`; the
plan's Stack section holds only plan-specific pins.

## 4. Write the plan

Follow the template's order: the H1 (`# <Project name> plan`; it names the run branch), Goal,
Constraints & decisions (Stack, Data, Security, Scope, Out of scope, When something is unclear),
Requested features intake, Before the run, After the run, then the phases. Replace every
placeholder and remove the template's `## Phase 1: TODO` heading.

**Phases are features.** Each phase is one feature the owner would recognise and ends with
something that works end to end. It is verified as a whole at its last step, so a failure costs a
verification round over all of it: usually 3 to 8 steps, and at most about 20 browser-checkable
Accept lines across its UI steps (the tester's budget grows with the lines up to that point). The
plan is as long as the work: no fixed number of phases or steps.

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
  each builds only on earlier ones. Every step's Accept lines must still hold when the feature is
  verified: a later step that changes an earlier one's behaviour restates the lines it changes.
- **Tags.** An untagged step is a UI step: the browser tester checks it. `no-ui` skips the
  browser. `security` is for steps whose main work is authentication, permissions or secrets;
  with `"step"` verification the security review then runs on that step too. `ui` and `db` are
  labels only.
- **UI steps** (every step not tagged `no-ui`): every Accept line must be observable from the
  browser: what the page shows, the URL, a fetch from the page (status and body), or a file the
  tester can Read. A line only a test, a command or a database query can prove goes in a separate
  `no-ui` step. About five browser-checkable Accept lines per UI step, including the failure
  cases that matter.
- **Notes.** Anything the tester (or the builder) needs goes in an indented `- Note:` line: a
  dev-only login, how to create test data, where a feature lives. The parser keeps every
  indented line in the step's text, and the tester sees nothing else of the plan. The dev server
  is restarted before the tester runs, so data that lived only in the running server is gone.
- **`no-ui` steps** are only as strong as the tests the builder writes: the gate runs the checks
  and reads their exit codes, nothing more. Each needs a `Test:` line (lint requires one), the
  checks must run those files, and each Accept line says what a test proves. Work on another
  machine is usually a `no-ui` step whose test checks the result (the VM answers, the service
  responds).
- `Test:` names the test files the step creates or extends; the checks must run them.

**Before the run.** Plain bullets (not checkboxes) for what the owner does first. Always include
the ones that apply:
- Open `claude` once in the project folder, accept the trust dialog, then `/exit`.
- `npx playwright install chromium`, when the plan has UI steps and `devServer` is set.
- Stop any copy of the app on the dev server's port: the gate reuses whatever answers at the URL,
  which may be running old code.
- Turn off sleep for a long run: a sleeping machine or a log-off stops the run.
Then the project's own: tools to install, environment variables, a local test database, sign-ins,
secrets this machine cannot generate and where they go, access to the hosts in Scope.

**After the run.** Plain bullets for what the owner does once the run is complete, each with the
exact command or place: the "write it for me" items, anything only a person can do, what to
review before merging. When nothing is left, write "Nothing: the run does all of this plan."

**Estimate.** Measured on a real run (28 steps on Opus, a Docker-heavy project, one verification
per step, before the verify-per-feature and targeted-test changes): about 39 minutes and 0.36
points of the 7-day usage limit per step. Show steps times those rates as an upper bound, with
that basis; verification once per feature should bring it down, and the practice runs will give
a newer rate. Compare the usage with the weekly pause threshold and the week's current usage
(`autoclaude status`); a run that would cross it pauses there. With `review.pauseAt` set to
`phase-end` the run also waits at every feature's end until the owner resumes it
(`every-step`: after every step). A plan too long for the time available can end at a phase
boundary.

## 5. Check it

1. `autoclaude lint-plan` (or `autoclaude lint-plan <file>`). It checks the structure (phases,
   IDs, their order, no duplicate or empty phases), the markers, the tags, a `Test:` line on
   every `no-ui` step, and leftover template placeholders. Fix every problem and run it again
   until it prints ok.
2. Lint cannot judge whether an Accept line is observable; this read-through is the real stall
   check. Read each step as the builder (could it be built from the plan alone without asking
   anything?) and each feature as the tester (with only the phase's text, a browser and Read,
   could every Accept line be checked in a few actions?). Fix any step that fails, asking the
   owner where the fix changes what gets built.
3. Record every decision made in this session in `docs/DECISIONS.md` (the `docs.decisions` file)
   in the entry format at its top, with `planning` as the step, `- By: owner` (or
   `- By: Claude (the owner said "you decide")`), only the options the owner saw under
   `- Rejected:`, and `- Owner review: yes` on any the owner accepted that carries a security
   risk. Every request that is not in this plan goes in the Requested features intake table.

## 6. Hand over

1. Show the owner, and ask for approval:
   - the features and steps as a short table (phase, ID, title, tags), and the estimate with
     its basis
   - the scope in plain words: what the run does outside this folder, what it writes for the
     owner, what it never touches, the snapshots, the deny rules and the permissions
   - the run settings that differ from the inherited values
   - the decisions recorded, the `autoclaude.config.json` changes, the `CLAUDE.md` changes
   - the Before the run and After the run lists
   - anything moved to `docs/DEFERRED.md` or left out
2. Once approved, rewrite `CONTINUE_HERE.md` (the `docs.continueHere` file): the plan is ready,
   the first step, the Before the run list, and how to start: `autoclaude run` from a new
   terminal opened in the project.
3. Commit everything init and this session created or changed, in the project's commit style.
   `git status --short` must print nothing: a run needs a clean working tree. Push only if the
   project has a remote, its rules call for a push and the owner agrees.
4. With the owner's OK (it starts and stops the dev server), run `autoclaude run --check` (the
   preflight alone; it opens no window) and show the result. Each FAIL line is fixed now or
   becomes a Before the run item. Check `git status --short` once more afterwards.
5. Tell the owner how to start: after the Before the run list, `autoclaude run` from a new
   terminal in the project. It opens a window named `ac-<project>` where the build runs.
   `autoclaude status` shows progress from any terminal; `autoclaude pause` stops after the next
   commit, `autoclaude pause --now` at once; `autoclaude config` opens the settings page. At the
   end the run writes `HANDOFF.md` and sends the completion alert.

When the run is `paused` rather than new or complete, commit only what this session changed (the
builder's unfinished work stays in the working tree for it), and the owner continues with
`autoclaude resume`, after `autoclaude run` if the run's `ac-<project>` window is gone.
