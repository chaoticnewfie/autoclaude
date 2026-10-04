---
name: optimize
description: Run an optimize sweep of this project with the owner's choices - unused code and packages, duplicates and leftovers, performance measured before and after, poorly built features rebuilt behind tests that pin today's behaviour, and the test suite's speed and flakiness - with every finding checked by independent sessions, a report with suggested fixes, and then report only, a fix plan to review, or a fix run right away. Asks first, in rounds of questions, and sets up the checks and dev server when they are missing. Use when the user types /autoclaude:optimize or asks to clean up, speed up or find dead code in an existing project.
---

# Optimize sweep

A sweep looks over the whole project. It runs unattended in its own window like any AutoClaude
run, sends an alert when it finishes, and writes its report to the gitignored
`.autoclaude/sweeps/<id>/` folder (`report.md` and `findings.json`). What it does:

- **Baseline first**, before any finding is acted on: each check's and each test file's time,
  flaky tests found by rerunning, build time, bundle size (gzip), package count, the dev
  server's start time, and per page the load time and request count in a headless browser.
- **Unused code and packages**: found with tools fetched on the fly at pinned versions (for
  example knip, jscpd, `npm outdated`), plus git churn hotspots. Something counts as unused only
  when a tool flags it, a search of the whole repository (scripts, CI, manifests, config, docs)
  finds no reference, and it matches no entry-point convention of the stack. A file or package a
  review session thinks unused, but no tool flagged, is report only: it is never deleted
  automatically.
- **Duplicates and leftovers**: copied code, dead branches, stale files.
- **Performance**: slow paths, measured before and after; an improvement is claimed only above
  the noise.
- **Poorly built features**: judged against a written rubric, and rebuilt in two steps: first
  tests that pin today's behaviour (they pass on the unchanged code), then the change, with the
  pinned tests unedited and the browser showing the same pages.
- **The test suite**: speed and flakiness, never weakening a test.
- **Verification**: with depth "thorough" every candidate is checked by 3 independent sessions
  that try to disprove it, and kept only on a majority. Disproved ones go to an appendix;
  uncertain ones are never changed automatically.
- **After**: report only; a fix plan (`OPTIMIZE_PLAN.md`, left in the sweep's folder) to review;
  or fix right away: the plan is committed on a new branch and a normal run makes every
  confirmed change, each verified by the gate (checks, browser tester, bug bash, security
  review), and ends with `HANDOFF-OPTIMIZE.md`. The project's own plan and its run state are
  kept aside while that run goes and come back when it completes. Anything that needs the owner
  is listed under "After the run".

Rules every fix run follows: a real bug found on the way is fixed with a test and listed in
`HANDOFF-OPTIMIZE.md` as a behaviour change; minor and patch upgrades are made, major upgrades are
report-only; changes to a database that other apps share are report-only.

Sessions are read-only (Read, Glob, Grep; no shell). Tools are fetched on the fly (with npx, or as
a Docker image when Docker is running) and never added to the project. A tool that is missing
is reported as "not checked", never as clean.

Below, `autoclaude` means the CLI. If `autoclaude version` fails, use
`node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js"` instead, and suggest `autoclaude install-cli`.

## How the questions work: ask, never assume

Nobody answers questions while the sweep runs. Everything with more than one reasonable answer is
decided here, by the owner.

- **Every choice goes to the owner** with AskUserQuestion. What the project suggests becomes the
  recommended option, never an answer you apply silently: put it first, add "(Recommended)" to
  its label, and say where it comes from. Each question has 2 to 4 options; the owner can always
  type another answer.
- **Rounds of up to 4 questions, grouped by topic.** Before the first round, name the topics and
  about how many rounds to expect (usually 3 to 4).
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
     with the run, and the baseline's timings are less reliable while a run uses the machine.
     "Fix right away" is refused while that run is running or paused (the fix plan is left in the
     sweep's folder instead), and so is `autoclaude run --plan` until the run is finished or
     idle. Say so in round 3.
   - An optimize sweep is already going (`autoclaude sweep-status` lists them): show its status.
     One whose window is gone (closed, or the computer restarted) shows as "stopped (window
     gone)" with the command that carries it on; it carries on by itself only when the watchdog
     is installed. A paused one carries on the same way. Offer `autoclaude sweep-run <id>`, which
     picks it up where it stopped. If the owner does not want it any more,
     `autoclaude sweep-stop <id>` gives it up for good (its finished work stays in its folder, and
     the watchdog leaves it alone); only then can a new optimize sweep start. A sweep whose window
     is still open: stop; the owner waits for it, or stops it with `autoclaude sweep-stop <id>`.
     A second sweep of the same kind is refused while one is running, waiting, paused or gone
     with its window.
2. Read, without asking: `autoclaude.config.json` (`plan`, `checks`, `devServer`), `CLAUDE.md`,
   the plan's "Constraints & decisions" section, `.gitignore`, `git status --short`, the package
   manifests and lockfiles, the build and test scripts, CI config, whether the app shares a
   database with other apps, `autoclaude.accepted.json` if it exists, and earlier sweeps under
   `.autoclaude/sweeps/`.

## 1. The questions

Tell the owner the topics: what to look at, the rules a fix run follows, depth and exclusions, and
what happens after. Then ask:

**Round 1: what to look at.** All on by default.
- A multi-select: "Unused code and packages", "Duplicates and leftovers", "Performance",
  "Test suite speed and flakiness" (all four recommended).
- Rebuilds of poorly built features: "Allowed, with tests that pin today's behaviour written
  first (Recommended)" or "Leave rebuilds out" (the report still names them).
- Package lookups: "On (Recommended): package names and versions are sent to the npm registry, to
  find newer minor and patch versions" or "Offline: the report says package versions were not
  checked". The current `sweep.advisories` is the recommendation.

**Round 2: the rules a fix run follows**, one question that shows them: a real bug found is fixed
with a test and listed as a behaviour change; minor and patch upgrades are made and majors are
report-only; changes to a database shared with other apps are report-only. Options: "Keep these
rules (Recommended)" or "Change them". These rules are fixed; to narrow what changes, the owner
can switch a module off, exclude paths, or choose the fix plan to review and drop steps before
running it. When the project shares a database with other apps, name it here.

**Round 3: depth, exclusions and what happens after.**
- Depth: "thorough (Recommended)": smaller areas and every finding checked by 3 independent
  sessions; "standard": one check each; "quick": no second check, more false alarms. The
  project's `sweep.depth` is the recommendation unless it is quick.
- Exclusions: folders or files the sweep skips, as globs. Offer what you found (vendored code,
  generated files, build output, fixtures, migrations that must never change) and "Nothing to
  exclude". Excluded paths are listed in the report as not examined.
- After the sweep: "Fix right away (Recommended)": a normal run makes every confirmed change on a
  new branch, each verified by the gate; "Report and a fix plan to review": the plan is written
  to the sweep's folder (`.autoclaude/sweeps/<id>/OPTIMIZE_PLAN.md`, gitignored) and the sweep
  stops, and `autoclaude run --plan .autoclaude/sweeps/<id>/OPTIMIZE_PLAN.md` starts it later;
  "Report only". Fix right away needs the checks to pass on the starting commit, a clean working
  tree and no run running or paused; when that cannot be true, recommend the plan instead and
  say why.

## 2. Set up what the choices need

- **The baseline and fix right away** need `checks` in `autoclaude.config.json`, proven to run,
  and page timings need `devServer`. When they are missing or unproven, set them up as
  `/autoclaude:plan` does in its section 3b (read `${CLAUDE_PLUGIN_ROOT}/skills/plan/SKILL.md`):
  find the commands, confirm them with the owner, then, with the owner's OK because it starts the
  dev server, run `autoclaude checks`. A check that fails on the current code: fix the baseline
  with the owner's OK, or choose "a fix plan to review" instead. With no web UI, the browser
  timings are skipped and the report says so.
- **Fix right away** starts from a clean working tree: commit the setup changes from this session
  in the project's commit style, after showing the owner what changes. `.autoclaude/` stays
  uncommitted.

## 3. Start

1. Write the answers to `.autoclaude/sweep-options-optimize.json` (gitignored):

   ```json
   {
     "kind": "optimize",
     "modules": ["unused", "duplicates", "performance", "rebuild", "tests"],
     "depth": "thorough",
     "targets": [{ "url": "http://127.0.0.1:3000", "mode": "readonly" }],
     "tests": {},
     "writesAllowed": false,
     "resetCommand": null,
     "testUsers": null,
     "exclude": [],
     "after": "fix",
     "advisories": true
   }
   ```

   `modules` drops "rebuild" when rebuilds are left out. `targets` is the local dev server only,
   read-only (page loads, nothing submitted, no login), or empty with no dev server. A dev
   server on https gets no page walk (the allow-list cannot hold a browser to GET and HEAD
   inside an https tunnel), and the report says the page timings were not measured.
2. Show the estimate: `autoclaude optimize --options .autoclaude/sweep-options-optimize.json --estimate`
   prints the areas, the sessions and a rough time without starting anything. The baseline adds
   the time of running the checks a few times over. Show it next to the 5-hour and weekly usage
   from `autoclaude status`: the sweep waits for the 5-hour reset when the window reaches
   `sweep.waitAt5hPct`, and pauses at the weekly limit (`usage.weeklyPauseAtPct`). After the
   weekly reset it carries on by itself only when `usage.autoResumeAfterWeeklyReset` is on and
   the watchdog is installed (`autoclaude watchdog --install`); otherwise
   `autoclaude sweep-run <id>` carries it on.
3. Show a short summary of the choices and ask: "Start the sweep (Recommended)", "Change
   something", or "Not now". Say that analysis tools may be fetched on the fly and are never
   added to the project.
4. On start, run in the foreground with the Bash tool:

   ```
   autoclaude optimize --options .autoclaude/sweep-options-optimize.json
   ```

   It prints the sweep's id and the estimate and opens a window named `ac-sweep-<project>`
   where the sweep runs. If it refuses, show the output verbatim and fix what it names with the
   owner.
5. Tell the owner how to follow it: the `ac-sweep-<project>` window, `autoclaude status` or
   `autoclaude sweep-status` from any terminal, and the "sweep finished" alert, which always goes out and carries only counts and
   the report's path. The report is `.autoclaude/sweeps/<id>/report.md`, with the baseline. A
   closed window, an RDP disconnect or a restart does not lose finished work:
   `autoclaude sweep-run <id>` in the project carries on where it stopped, without rerunning
   finished sessions, and the watchdog, when installed, opens the window again by itself. So
   closing the window does not stop a sweep; `autoclaude sweep-stop` does (the sweep running or
   waiting; `autoclaude sweep-stop <id>` names one). It ends the window and the sessions it runs,
   keeps the finished work, and the watchdog leaves a stopped sweep alone;
   `autoclaude sweep-run <id>` resumes it on purpose. Then, by what happens after:
   - **Fix right away**: the fix run starts in the same window on a new branch made from the
     commit the sweep looked at, with `OPTIMIZE_PLAN.md` committed there, and ends with
     `HANDOFF-OPTIMIZE.md`, like any run; the owner reviews and merges that branch.
   - **A fix plan to review** (or fix right away refused): the plan stays in the sweep's folder,
     `.autoclaude/sweeps/<id>/OPTIMIZE_PLAN.md`, and nothing in the project changes. Tell the
     owner that path and the command that runs it once they have read it (and edited it, if they
     like): `autoclaude run --plan .autoclaude/sweeps/<id>/OPTIMIZE_PLAN.md`. That makes a new
     branch from the current commit, commits the plan there as `OPTIMIZE_PLAN.md` and starts the
     run; `autoclaude run --plan .autoclaude/sweeps/<id>/OPTIMIZE_PLAN.md --check` shows first
     whether it would start, changing nothing.
   - Either way, the project's own plan and its run state are kept aside while the fix run goes
     and come back when it completes.

## Accepted findings and false alarms

A finding the owner wants kept as it is (code that looks unused but is loaded by name, a
duplicate kept on purpose), or knows to be a false alarm, is recorded in
`autoclaude.accepted.json` at the project root, which is committed. Later sweeps list it as
accepted instead of reporting it again. Each entry holds the finding's fingerprint (from
`findings.json` in the sweep's folder) and a short reason, never the finding's details. A
finding merged from several sources has more than one; the report's Fingerprint row then reads
like `abc (also def)`. Record one entry for each of them, so the finding stays accepted whichever
source finds it next time:

```json
[
  { "fingerprint": "<the finding's fingerprint>", "kind": "optimize", "reason": "accepted: loaded by name from the plugin registry", "by": "owner", "date": "2026-10-02" }
]
```

When the owner asks (for example "keep OPT-007, it is used by the deploy script"), read the
sweep's `findings.json`, find the id, add the entry with the owner's reason (start it with
"accepted:" or "false alarm:"), and commit it with the owner's OK. A run's builder can never
change this file.
