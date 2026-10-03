---
name: security
description: Run a security sweep of this project with the owner's choices - a review of the whole codebase by read-only sessions, secrets in the files and the whole git history, package advisories, configuration and infrastructure, and live attacks on the running app through an allow-list - with every finding checked by independent sessions, a report with suggested fixes, and then report only, a fix plan to review, or a fix run right away. Asks first, in rounds of questions, and sets up the checks and dev server when they are missing. Use when the user types /autoclaude:security or asks for a security sweep, audit or pen test of an existing project.
---

# Security sweep

A sweep looks over the whole project, not one feature's changes. It runs unattended in its own
window like any AutoClaude run, sends an alert when it finishes, and writes its report to the
gitignored `.autoclaude/sweeps/<id>/` folder (`report.md` and `findings.json`). What it does:

- **Code review**: one session maps the app (entry points, routes, roles, data stores, trust
  boundaries), then sessions review it area by area: login and sessions, access control
  (database roles and row-level security included), input handling and injection, output
  encoding, secrets and data exposure, crypto. Sessions are read-only (Read, Glob, Grep; no
  shell), and they respect the plan's "Constraints & decisions".
- **Secrets**: the working tree and the whole git history, with values masked; tracked sensitive
  files and `.gitignore` coverage.
- **Packages**: `npm audit`, and the OSV database for other lockfiles, behind the advisories
  switch. A tool that is missing or switched off is reported as "not checked", never as clean.
- **Configuration and infrastructure**: Dockerfiles, compose files, CI, web server config, `.env`
  handling, open ports.
- **Live attacks**: direct HTTP probes (security headers, cookie flags, CORS, exposed `/.git`,
  `/.env` and source maps, verbose errors, routes that answer without a login, rate limiting)
  and a headless browser. On a target in full mode with writes allowed, the browser signs in as
  two test users (one user reaching the other's data, XSS, CSRF, open redirects, session
  handling). Every other target is read-only: GET and HEAD requests only, and the browser gets a
  read-only browse with no login (script injection through URL parameters, open redirects). A
  read-only https target gets the HTTP probes only: the allow-list cannot hold a browser to GET
  and HEAD inside an https tunnel. Every request goes through an allow-list of the chosen
  targets; a request to any other host, or a write to a read-only target, is refused and logged
  in `proxy.log`.
- **Verification**: with depth "thorough" every candidate is checked by 3 independent sessions
  that try to disprove it, and kept only on a majority. Disproved ones go to an appendix;
  uncertain ones are never fixed automatically.
- **After**: report only; a fix plan (`SECURITY_PLAN.md`, left in the sweep's folder) to review;
  or fix right away: the plan is committed on a new branch and a normal run fixes every confirmed
  finding, each fix verified by the gate (checks, browser tester, bug bash, security review), and
  ends with `HANDOFF-SECURITY.md`. The project's own plan and its run state are kept aside while
  that run goes and come back when it completes. Anything that needs the owner is listed under
  "After the run".

Nothing secret reaches the report, a commit or an alert: values are masked, the fix plan words
every fix neutrally and points at finding ids in the gitignored report, and the alert carries
counts and the report's path only.

Below, `autoclaude` means the CLI. If `autoclaude version` fails, use
`node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js"` instead, and suggest `autoclaude install-cli`.

## How the questions work: ask, never assume

Nobody answers questions while the sweep runs. Everything with more than one reasonable answer is
decided here, by the owner.

- **Every choice goes to the owner** with AskUserQuestion. What the project suggests becomes the
  recommended option, never an answer you apply silently: put it first, add "(Recommended)" to
  its label, and say where it comes from ("autoclaude.config.json has the dev server at
  http://127.0.0.1:3000"). Each question has 2 to 4 options; the owner can always type another
  answer.
- **Rounds of up to 4 questions, grouped by topic.** Before the first round, name the topics and
  about how many rounds to expect (usually 5 to 7).
- **Decide alone only where the owner says "you decide"**, then say what you chose and why.
- **If AskUserQuestion is not available** (a headless session), ask the same rounds as numbered
  text questions with the options and your recommendation, and wait for the answers.
- **Ask before installing, pulling or starting anything** in this session, the dev server that
  `autoclaude checks` starts included.

## 0. Where you are

1. Run `autoclaude status`.
   - "not initialized in this project": run `/autoclaude:init` first (it asks its own questions),
     then come back.
   - A run is `running` or `paused`: a sweep may still run beside it. It writes only into its own
     gitignored folder, never into the project's files, but it shares the 5-hour and weekly usage
     with the run. "Fix right away" is refused while that run is running or paused (the fix plan
     is left in the sweep's folder instead), and so is `autoclaude run --plan` until the run is
     finished or idle. Say so when you ask about it in round 5.
   - A security sweep is already going (`autoclaude sweep-status` lists them): show its status.
     One whose window is gone (closed, or the computer restarted) shows as "stopped (window
     gone)" with the command that carries it on; it carries on by itself only when the watchdog
     is installed. Offer `autoclaude sweep-run <id>`, which picks it up where it stopped. A sweep
     whose window is still open: stop; the owner waits for it (a second one of the same kind is
     refused).
2. Read, without asking: `autoclaude.config.json` (the `plan`, `checks`, `devServer` and
   `docs.security` keys), `CLAUDE.md`, the plan's "Constraints & decisions" section,
   `.gitignore`, `git status --short`, the package manifests and lockfiles, Dockerfiles, compose
   files and CI config, how the app signs users in (a sign-up page? a dev-only login?), any seed
   or reset script for the database, `autoclaude.accepted.json` if it exists, and earlier sweeps
   under `.autoclaude/sweeps/`.

## 1. The questions

Tell the owner the topics: what to check, targets, live test kinds, data and test logins, depth
and exclusions, what happens after, and the findings file when that applies. Then ask:

**Round 1: what to check.** All on by default.
- A multi-select of the code modules: "Code review of the whole codebase", "Secrets in the files
  and the git history", "Package vulnerabilities", "Configuration and infrastructure" (all four
  recommended).
- "Live attacks on the running app": "Yes (Recommended)" or "No". Recommend no only when the
  project has no server or web UI at all, and say why.
- When package vulnerabilities are on, the advisories switch: "Look up advisories (Recommended):
  package names and versions are sent to npm's audit service and the OSV database" or "Offline:
  nothing leaves this computer, and the report says packages were not checked". The current
  value of `sweep.advisories` is the recommendation.

**Round 2: targets** (only with live attacks).
- The local dev server, from `devServer.url`: "Yes (Recommended)". With no dev server set, say
  that one is set up in section 2 before the sweep starts, or the live part is skipped.
- Staging: "None (Recommended)" or "Add staging URLs" (the owner types them).
- Production: "Off (Recommended)", "Read-only checks" (GET and HEAD requests only: headers,
  cookies, CORS, exposed files, routes that answer without a login; nothing is submitted, and
  over https only the HTTP probes run, no browser), or
  "Full attacks". Before accepting "Full attacks", ask once more with this warning in the
  question: full attacks submit forms, create and change data, try repeated logins and may lock
  accounts, send real emails, trip rate limits or a firewall, and alarm the people who watch
  that server; they write to production data only if writes are allowed in round 4. Options:
  "Use read-only checks instead (Recommended)" or "Full attacks: I accept the risk".
- For every URL that is not on this computer, one question: "I own it, or I have written
  permission to test it" or "Leave it out". A target the owner cannot confirm is left out.

**Round 3: live test kinds** (only with live attacks), all on by default, as three multi-select
questions:
- Passive: security headers, cookie flags, CORS, exposed files, verbose error pages (`headers`,
  `cookies`, `cors`, `exposedFiles`, `verboseErrors`).
- Access: routes that answer without a login, one user reaching another's data, rate limiting on
  the login (`authBypass`, `idor`, `rateLimit`; rate limiting runs only when writes are allowed
  on a full-mode target).
- Browser: script injection, cross-site request forgery, open redirects (`xss`, `csrf`,
  `redirects`).

**Round 4: data and test logins** (only with live attacks).
- "Is the data behind the full-mode targets throwaway?" Tests that write (sign-ups, form
  submissions, CSRF, rate limiting) run only on a yes. Options: "No: read-only checks only
  (Recommended unless the project clearly uses a local test database)", "Yes, and it can be
  reset with a command", "Yes, no reset needed". Recommend a yes only from evidence (a seed
  script, a database file the dev server creates, a test container), and name it. On "reset with
  a command", ask for the command; prefer one the project already has.
- With writes not allowed, every target, the local dev server included, is read-only: the HTTP
  probes plus a read-only browse with no login (script injection through URL parameters, open
  redirects; none over https). The two-user checks (`idor`, session handling) and `csrf` are then
  reported as not run, and test logins are not asked for: `testUsers` is `null`.
- Test logins, only after a yes above: two ordinary (not admin) accounts for the two-user checks,
  used only on full-mode targets. Options, by what the app allows:
  - "The sweep signs up two users itself": only when the app has open sign-up and writes are
    allowed (a sign-up writes data).
  - "I give two accounts": they are written to `secrets/sweep-users.json`, which must be
    gitignored. Recommend that the owner types the passwords into that file themselves, so they
    never appear in this conversation; you write the file with the user names and placeholder
    passwords. The report and the sessions' output never contain a password.
  - "No logins": only what an anonymous visitor reaches is checked, and the report says the
    two-user checks were not run.

**Round 5: depth, exclusions and what happens after.**
- Depth: "thorough (Recommended)": smaller areas and every finding checked by 3 independent
  sessions; "standard": one check each; "quick": no second check, more false alarms. The
  project's `sweep.depth` is the recommendation unless it is quick.
- Exclusions: folders or files the sweep skips, as globs. Offer what you found (vendored code,
  generated files, build output, test fixtures with fake secrets) and "Nothing to exclude".
  Excluded paths are listed in the report as not examined.
- After the sweep: "Fix right away (Recommended)": a normal run fixes every confirmed finding on
  a new branch, each fix verified by the gate; "Report and a fix plan to review": the plan is
  written to the sweep's folder (`.autoclaude/sweeps/<id>/SECURITY_PLAN.md`, gitignored) and the
  sweep stops, and `autoclaude run --plan .autoclaude/sweeps/<id>/SECURITY_PLAN.md` starts it
  later; "Report only". Fix right away needs the checks to pass on the starting commit, a clean
  working tree and no run running or paused; when that cannot be true, recommend the plan
  instead and say why. When fixing, a critical finding is handled as a high one, the gate's
  highest level.

**Round 6: the findings file**, only when the file named by `docs.security` (by default
`docs/SECURITY-FINDINGS.md` in older projects) is tracked by git (`git ls-files -- <file>`).
Normal runs append security findings to it, and a tracked file is pushed with every feature.
Options: "Move it to docs/private/ (Recommended)" or "Keep it where it is". A move (not
`git mv`, which keeps the file tracked): add `docs/private/` to `.gitignore`, run
`git rm --cached -- <file>`, move the file on disk to `docs/private/SECURITY-FINDINGS.md`, and set
`"docs": { "security": "docs/private/SECURITY-FINDINGS.md" }` in `autoclaude.config.json`. Tell
the owner that the old content stays in the git history; only rewriting the history removes it,
and that is their call.

## 2. Set up what the choices need

- **Live attacks on the local dev server, or fix right away** need `devServer` and `checks` in
  `autoclaude.config.json`, proven to run. When they are missing or unproven, set them up as
  `/autoclaude:plan` does in its section 3b (read `${CLAUDE_PLUGIN_ROOT}/skills/plan/SKILL.md`):
  find the commands, confirm them with the owner, then, with the owner's OK because it starts the
  dev server, run `autoclaude checks`. A check that fails on the current code: fix the baseline
  with the owner's OK, or choose "a fix plan to review" instead of fixing right away.
- **Given test accounts**: write `secrets/sweep-users.json` in this shape, and confirm it is
  ignored with `git check-ignore -q secrets/sweep-users.json` (add `secrets/` to `.gitignore`
  if not, with the owner's OK):

  ```json
  {
    "loginUrl": "/login",
    "users": [
      { "label": "user A", "username": "sweep-a@example.test", "password": "type it here" },
      { "label": "user B", "username": "sweep-b@example.test", "password": "type it here" }
    ]
  }
  ```

- **Fix right away** starts from a clean working tree: commit the setup changes from this
  session (the config, `.gitignore`, a moved findings file) in the project's commit style, after
  showing the owner what changes. `secrets/` and `.autoclaude/` stay uncommitted.

## 3. Start

1. Write the answers to `.autoclaude/sweep-options-security.json` (gitignored). Every field:

   ```json
   {
     "kind": "security",
     "modules": ["code", "secrets", "deps", "config", "live"],
     "depth": "thorough",
     "targets": [{ "url": "http://127.0.0.1:3000", "mode": "readonly" }],
     "tests": { "headers": true, "cookies": true, "cors": true, "exposedFiles": true, "verboseErrors": true, "authBypass": true, "idor": true, "xss": true, "csrf": true, "redirects": true, "rateLimit": true },
     "writesAllowed": false,
     "resetCommand": null,
     "testUsers": null,
     "exclude": [],
     "after": "fix",
     "advisories": true
   }
   ```

   The local dev server comes first in `targets`. A target's `mode` is `"full"` only when the
   owner chose full attacks for it and writes are allowed, otherwise `"readonly"`.
   `writesAllowed` is true only on a yes in round 4. `testUsers` is
   `{ "file": "secrets/sweep-users.json", "signUp": true }` when the sweep signs users up,
   `{ "file": "secrets/sweep-users.json" }` for given accounts, and `null` for no logins and
   whenever writes are not allowed (as in this example).
   No password, token or secret ever goes in this file.
2. Show the estimate: `autoclaude security --options .autoclaude/sweep-options-security.json --estimate`
   prints the areas, the sessions and a rough time without starting anything. Show it next to
   the 5-hour and weekly usage from `autoclaude status`: the sweep waits for the 5-hour reset
   when the window reaches `sweep.waitAt5hPct`, and pauses at the weekly limit
   (`usage.weeklyPauseAtPct`). After the weekly reset it carries on by itself only when
   `usage.autoResumeAfterWeeklyReset` is on and the watchdog is installed
   (`autoclaude watchdog --install`); otherwise `autoclaude sweep-run <id>` carries it on.
3. Show a short summary of the choices (modules, targets and their modes, test kinds, writes,
   logins, depth, exclusions, after) and ask: "Start the sweep (Recommended)", "Change
   something", or "Not now". Say that analysis tools may be fetched on the fly (with npx, or as a
   Docker image when Docker is running) and are never added to the project.
4. On start, run in the foreground with the Bash tool:

   ```
   autoclaude security --options .autoclaude/sweep-options-security.json
   ```

   It prints the sweep's id and the estimate and opens a window named `ac-sweep-<project>`
   where the sweep runs. If it refuses, show the output verbatim and fix what it names with the
   owner.
5. Tell the owner how to follow it: the `ac-sweep-<project>` window, `autoclaude status` or
   `autoclaude sweep-status` from any terminal, and the "sweep finished" alert, which always goes out and carries only counts and
   the report's path. The report is `.autoclaude/sweeps/<id>/report.md`. A closed window, an RDP
   disconnect or a restart does not lose finished work: `autoclaude sweep-run <id>` in the
   project carries on where it stopped, without rerunning finished sessions, and the watchdog,
   when installed, opens the window again by itself. Then, by what happens after:
   - **Fix right away**: the fix run starts in the same window on a new branch made from the
     commit the sweep looked at, with `SECURITY_PLAN.md` committed there, and ends with
     `HANDOFF-SECURITY.md`, like any run; the owner reviews and merges that branch.
   - **A fix plan to review** (or fix right away refused): the plan stays in the sweep's folder,
     `.autoclaude/sweeps/<id>/SECURITY_PLAN.md`, and nothing in the project changes. Tell the
     owner that path and the command that runs it once they have read it (and edited it, if they
     like): `autoclaude run --plan .autoclaude/sweeps/<id>/SECURITY_PLAN.md`. That makes a new
     branch from the current commit, commits the plan there as `SECURITY_PLAN.md` and starts the
     run; `autoclaude run --plan .autoclaude/sweeps/<id>/SECURITY_PLAN.md --check` shows first
     whether it would start, changing nothing.
   - Either way, the project's own plan and its run state are kept aside while the fix run goes
     and come back when it completes.

## Accepted risks and false alarms

A finding the owner accepts as a risk, or knows to be a false alarm, is recorded in
`autoclaude.accepted.json` at the project root, which is committed. Later sweeps list it as
accepted instead of reporting it again. Each entry holds the finding's fingerprint (from
`findings.json` in the sweep's folder) and a short reason, never the finding's details. A
finding merged from several sources has more than one; the report's Fingerprint row then reads
like `abc (also def)`, and any of them works:

```json
[
  { "fingerprint": "<the finding's fingerprint>", "kind": "security", "reason": "accepted risk: internal tool, LAN only", "by": "owner", "date": "2026-10-02" }
]
```

When the owner asks (for example "mark SEC-004 as a false alarm"), read the sweep's
`findings.json`, find the id, add the entry with the owner's reason (start it with "accepted
risk:" or "false alarm:", and keep exploit details, file contents and secret values out: the
repository may be public), and commit it with the owner's OK. A run's builder can never change
this file.
