# DEFERRED

Things deliberately not built yet. Each entry says what, why it waits, the trigger that means it
is time, the concrete path, and why adding it later costs no rework. If something seems missing
it should be here; if it is not, it is an open decision in `DECISIONS.md` or an oversight.

---

## 1. Pause from the phone

**What.** A button in the ntfy notification that pauses the run.
**Why it waits.** ntfy action buttons need an HTTP endpoint to hit, and v1 has no server.
**Trigger.** Scott wants to stop a run while away from a keyboard more than once.
**Path.** A tiny HTTP listener in the supervisor reachable on the LAN or through a tunnel, or a
file the supervisor polls on a share.
**No rework.** The pause is already a state flag the gate reads; only the way of setting it changes.

## 2. tmux attach on Linux and macOS

**What.** `autoclaude run` puts the supervisor in a tmux session when tmux exists, so `tmux attach`
works there.
**Status (2026-09-27).** Built in Phase 6, and since D43 tmux is required on Linux and macOS:
the background fallback gave the interactive builder no terminal. The Linux and macOS paths are
unit-tested only; the first run on either is the trigger to verify them live.

## 3. A real pseudo-terminal (node-pty)

**What.** Driving `claude` through a pty so the supervisor can read the screen and type into it.
**Why it waits.** Native dependency; restart-with-prompt covers every recovery case identified.
**Trigger.** A recovery case appears that a restart cannot handle.
**Path.** Optional dependency loaded only if present.

## 4. `Depends:` with park-and-skip for failed steps

From the draft (P8.3). Failed steps park and independent steps continue. Off by default when it
arrives. Trigger: a run pausing on a step that nothing else needs.

## 5. Parallel steps in worktrees

From the draft (non-goal for v1). Trigger: plans with clearly independent phases and spare quota.

## 6. Run windows (nights only)

Trigger: Scott wants daytime quota protected by a schedule rather than by the weekly threshold.
Path: the supervisor already polls on a timer; a window is a check before each restart or nudge.

## 7. Progress dashboard page

Trigger: `autoclaude status` and notifications stop being enough. Path: a static page reading
`.autoclaude/state.json` and `PROGRESS.md`.

## 8. Second-opinion reviewer through another provider

Trigger: a class of bug the security reviewer keeps missing. Path: a second `claude -p`-shaped
runner behind the same verdict schema.

## 9. Answering blockers through Remote Control

Trigger: `autoclaude answer` from a shell proves inconvenient from the phone.

## 10. Windows toast notifications as a local channel

Trigger: someone without ntfy or Discord wants alerts on the same machine. Path: a PowerShell
one-liner behind the same notify interface, opt-in.

## 12. Stale dev-server pid after a reboot

**What.** `.autoclaude/devserver.json` records the pid of a dev server the gate started. After a
reboot the pid can belong to an unrelated process, and `stopDevServer` would end it.
**Why it waits.** The window is small: the run itself does not survive a reboot, and `start`
can clear the file. Not yet done.
**Trigger.** The first time a wrong process gets killed, or before the rollout to other people.
**Path.** Record the command line and start time next to the pid and compare them with the live
process (`wmic`/`Get-CimInstance` on Windows, `/proc` elsewhere) before killing; clear the file
in `autoclaude start`.

## 13. The watchdog on a laptop running on battery

**What.** Tasks created with `schtasks /Create` default to "do not start on batteries", so the
backstop watchdog does not run on a laptop that is unplugged.
**Why it waits.** The Code VM and the desktop have no battery; the laptop is not a run machine yet.
**Trigger.** Running AutoClaude unattended on a laptop.
**Path.** Create the task from an XML definition (`schtasks /Create /XML`) with
`DisallowStartIfOnBatteries` and `StopIfGoingOnBatteries` set to false.

## 14. A reused process id makes a dead supervisor look alive

**What.** The watchdog and `autoclaude run` treat the recorded supervisor pid as alive if any
process has that pid, so after a reboot an unrelated process can hide a dead supervisor.
**Why it waits.** Rare, and the owner can always run `autoclaude run` after a reboot.
**Trigger.** One occurrence, or before the rollout to other people.
**Path.** Record the supervisor's start time with its pid and compare it with the live process
(`Get-CimInstance Win32_Process` on Windows, `/proc/<pid>/stat` elsewhere), as DEFERRED 12
proposes for the dev server.

## 11. Claude Code background sessions as the runner

**What.** Host the builder session in `claude --bg` under Claude Code's own supervisor daemon
instead of our console-window supervisor (D18, D26).
**Why it waits.** Stop hooks do not run in background sessions, usage limits are not
auto-continued there, and edits are isolated into a worktree by default. The gate is a Stop hook.
**Trigger.** A Claude Code release whose agent-view docs list Stop hooks as running in background
sessions and auto-continue as applying to them.
**Path.** `autoclaude run --bg` as an alternative runner: dispatch with `--bg`, poll
`claude agents --json`, set `worktree.bgIsolation: "none"` in the project settings, and relaunch
with `claude --resume <id> --bg "<prompt>"`.
**No rework.** The gate, the CLI and the state files do not know which supervisor is running.

## 15. A time limit per step (`retries.maxMinutesPerStep`)

**What.** Pause, or nudge the session to wrap up or block, when one step has run longer than
`retries.maxMinutesPerStep` (default 120) without being handed in.
**Why it waits.** The key is accepted by the config but nothing enforces it (found while writing
docs/USAGE.md, 2026-09-27). The supervisor's stall rules, the no-progress counter and the
three-attempt limit already stop a session that is stuck. A session that keeps working busily on
one step for hours without calling `ready` is not caught, and has not been seen yet.
**Trigger.** A run where one step takes more than two hours with steady heartbeats.
**Path.** The supervisor compares `state.stepStartedAt` with the limit; first a nudge asking the
builder to hand in or block, then a pause with a high alert.
**No rework.** The state already records `stepStartedAt`, and the supervisor's `decide` gains one
rule.

## 16. Protected paths (`guard.protect`)

**What.** A list of project files the run may not edit (an owner's own roadmap, deploy scripts),
enforced by the tool guard for Edit, Write and shell writes, like the plan and the config are.
**Why it waits.** The plan skill now writes such files into the project's CLAUDE.md run section
and the plan's Out of scope, and the builder follows those rules. No run has edited one yet.
**Trigger.** A run edits a file the owner listed as off limits.
**Path.** `guard.protect: ["ROADMAP.md", "scripts/deploy.sh"]` in the config; the guard's
`isProtected` and `writesTo` checks already exist for the plan and config and take a list.
**No rework.** The guard already has the mechanism; the config gains one key.

## 17. Pin the Playwright MCP version

**What.** Pin `@playwright/mcp` in the MCP config `init` writes (today `@latest`), and check the
pinned version in the preflight.
**Why it waits.** Every live run so far worked with `@latest`, and a pin needs a policy for
updating it. Noted by the onboarding rehearsal (2026-09-27): the tester fetches the latest
package at run time, so the version can change between steps and the run needs network.
**Trigger.** A checker fails because a new `@playwright/mcp` release changed its behaviour.
**Path.** A version constant in `lib/init.js` (`playwrightMcpConfig`), written into
`.autoclaude/mcp.playwright.json`; `init` rewrites it on upgrade.
**No rework.** The config file is per project and already regenerated by `init`.

## 18. Faster runs

**Status (2026-09-28).** Measured at CHECKPOINT 7 and scheduled: options 0 to 4 are PLAN.md P8.2 to
P8.4 (D49). Option 6, parallel steps, stays deferred until the effect of those is measured.

**What.** Cut the time per step without cutting the verification. Candidates, cheapest first:
0. **Verify per feature, not per step** (Scott's own picture, 2026-09-27). A `gate.verifyAt`
   setting, `step` (today) or `phase`: with `phase`, `ready` on a mid-phase step only records it
   (the builder keeps running its own quick tests), and the last step of the phase triggers the
   full verification over every Accept line of the phase: all checks, the browser tester, the
   bug bash and the security review. Attempts and the failure report are per phase, naming the
   failing Accept lines and so their steps. The plan skill then sizes a phase as one feature. A
   middle setting runs fast checks per step and the slow ones at phase ends (option 4).
1. **Builder effort.** AutoClaude never sets it, so the builder inherits the owner's default
   (xhigh in the rehearsal). A `builder.effort` setting passed as `--effort` (for example
   `high`), next to `builder.model`.
2. **Checks run twice.** The builder runs the full checks itself before `ready` (about 4 minutes
   in the rehearsal, Docker-based), then the gate runs the same checks again. The gate could reuse
   a pass that `autoclaude checks` recorded for the identical tree (same HEAD and diff hash).
3. **Per-step paperwork.** The run rules tell the builder to do the project's "every prompt" doc
   duties before each `ready` (session log, decisions, gotchas, CONTINUE_HERE). A lighter rule for
   runs: CONTINUE_HERE and decisions per step, the rest per phase.
4. **Slow checks every step.** A per-check `when` (`every-step` or `phase-end`), so heavy suites
   (Docker, end-to-end) run at phase ends and fast unit tests after every step.
5. **Step size.** Every step pays the same verification cost; the plan skill could merge small
   steps (aim for 45 to 90 minutes each).
6. **Parallel steps** in worktrees (entry 5), the biggest change.
**Why it waits.** Scott, 2026-09-27, during the rehearsal: "it's so so so so so much slower than
just using claude code extension in vs code... Will it be possible to make it work at a more
normal speed once I'm able to work on this again? I don't want to just burn tokens for no reason".
The run was healthy (6 steps in 2 h 42 min, about 27 minutes each, 2 points of the weekly limit),
and changing the plugin mid-run is out.
**Trigger.** CHECKPOINT 7: measure first. The run's `gate.log` gives verification time per step,
the heartbeat gaps give build time; pick the levers that the numbers say matter.
**No rework.** Each lever is a config key or a prompt line on top of what exists.

## 19. Full-scope runs (D47)

**Status (2026-09-28).** Scheduled as PLAN.md P8.1 (D49).

**What.** Make a run work on the whole project the way a watched session would.
1. Plan skill: the stall review stops treating "touches other machines" as a stall. For each such
   item it asks "should the run do this itself?", with yes as the default, and records the
   permission and the details (hosts, credentials already on the machine, specs) in the plan's
   Constraints & decisions. Only what the owner marks off limits goes into `guard.deny`. Offer a
   snapshot or backup step before changes to existing machines.
2. Decider and run rules (`agents/decider.md`, `prompts/context.md`): work the plan allows is
   routine, not critical. Critical stays for what the plan did not cover and only the owner can
   decide, or a secret the machine does not have.
3. Template "When something is unclear": replace "never touch files outside the project" with
   "stay within what the plan allows".
4. Claude Code's own auto-mode checks may still refuse some actions on other hosts. Check how
   explicit permission allow rules interact with auto mode, and have the plan skill write allow
   rules for what the plan permits.
5. Docs (INSTRUCTIONS, USAGE section 12) and the onboarding advice: stop telling owners to name
   every reachable host as off limits.
6. **The scope question is always asked, never inferred** (bug found in the rehearsal: Scott was
   never asked what was off limits). Today the interview says "ask what the code and docs do not
   already answer", 3d says to look in the repo and add deny rules, and 1b turns work on other
   machines into scripts, so a session that finds hosts in the owner's notes decides the scope
   itself. Fix: one mandatory question, asked with AskUserQuestion even when the docs suggest an
   answer: what the run may do outside this folder (create or use which machines) and what it
   must never touch. Every item that reaches outside the project gets its own "run does it /
   write it for me / leave it out" choice. Proposed deny rules are shown and approved before
   they are written, and the hand-over summary lists the scope in plain words.
7. **Ask, never assume** (D48). The interview asks about every open decision instead of filling
   it in from the code, the docs or the owner's notes: what those suggest becomes the
   recommended option of a question, confirmed by the owner, not an answer. There is no cap on
   the number of questions (AskUserQuestion takes up to 4 at a time, so it asks in rounds, grouped
   by topic). The session decides on its own only where the owner says "you decide". The run's
   job is the bulk of the build; the owner fine-tunes afterwards in normal sessions, so the plan
   does not need to settle polish.
**Why it waits.** The DB rehearsal is running on 0.9.4; changes land after it, reviewed at
CHECKPOINT 7 together with the speed options (entry 18).
**Trigger.** CHECKPOINT 7.
**No rework.** The guard, the deny list and the decider already exist; this changes their
defaults and the planning questions.

## 20. Docker images in the run's footprint

**What.** Record the Docker images present at run start, and at completion report (or remove)
images the run pulled or built that nothing uses. Also: anonymous volumes of test containers
that are created and removed inside one check run (the rehearsal's 33 volumes were of this
kind) can be tied to the project only through Docker's short event log, so they are usually
reported, not removed; a `docker events` stream held open while the checks run would tie them.
**Why it waits.** The footprint (P8.5) covers containers, volumes and networks, which is what the
rehearsal leaked (33 volumes). Images are large but shared and cached on purpose; removing one a
later project needs costs a slow pull, and telling "pulled by this run" from "pulled by the owner
meanwhile" needs more than a before/after list.
**Trigger.** A HANDOFF.md or a full disk that shows images piling up after runs.
**Path.** Add an `images` kind to `lib/footprint.js` (`docker image ls --format`), report new
dangling or unused images in HANDOFF.md, and remove only with a `footprint.images: true` switch.
**No rework.** The footprint already records kinds separately and never compares a kind it did
not list at start.

## 21. Tool guard blind spots

**What.** Gaps the Phase 8 verification found in the tool guard and deliberately left, each to
close only if a run hits it (the rest were fixed in 0.10.1 and 0.10.2):
- a shell script fed to a container's shell through stdin (heredoc, pipe, `<`), and Perl's
  `system qw(...)` or `system @list`;
- recursive deletes inside inline code (`node -e` with rmSync, Python's shutil.rmtree, Perl)
  are checked only against the protected files, not against the project and temp boundary;
- wrappers the guard does not know (busybox, stdbuf, flock, setsid, ionice, doas, winpty,
  chroot) hide the command after them;
- a variable set by a form the guard does not read (`+=`, arrays, `read`, `printf -v`, `eval`,
  `Set-Variable`, `foreach`) keeps its old value; targets handed to `rm` at run time (`"$@"`,
  `xargs sh -c`, `find -exec sh -c`); `cd -`, `popd`, `Pop-Location`;
- links and junctions inside the project are judged by name, not by where they lead (only
  temp-folder paths are resolved);
- path-building forms around `defaults.json` and `notify.json`; push settings set outside
  `git config` and `-c` (for example in a config file the builder writes);
  `git config --rename-section` into `alias.*` or `remote.*`;
- PowerShell `-EncodedCommand`; make targets; secrets written outside `secrets/`, such as a
  root `.env` (not tracked by the footprint);
- a false positive: `git tag --sort -v:refname` with a space (`--sort=-v:refname` passes).

**Why it waits.** The guard is best-effort by design (docs/USAGE.md section 12). The account the
run uses and Claude Code's auto mode are the real boundary, and planning pre-approves exactly
what the plan allows. None of these was seen in the rehearsal, while its 13 false positives were
real and cost time; every extra rule risks new ones.
**Trigger.** A denial log or review that shows one of them happening.
**Path.** Per gap, in `scripts/tool-guard.js`: extend `ruleTexts` and the recursive-delete target
resolution; decode base64 UTF-16LE after `-EncodedCommand`; resolve `make <target>` like
`npm run`; add `.env*` to the footprint's secret scan.
**No rework.** The parser already records per-command words, quoting, groups and nested code, and
`ruleTexts` builds the list of texts a rule is tested against.

## 22. Small things the practice run showed

**What.**
- The fix-up passes took 16.5 of the practice run's 64 minutes (7 and 9.5 min) for 11
  non-blocking findings, 2 of which were handed to the owner anyway. A setting could limit the
  pass to findings of a given severity, or turn it off (findings then go straight to the owner).
- The settings page rewrites the project's `autoclaude.config.json` with its own formatting, so
  a one-key change shows as a 43-line diff; and a change saved during a run is committed with the
  run's next step commit (the file is tracked).
- The footprint's notes between start and end give each Docker call 20 s; on this machine
  `docker ps -a` took 48 s, so every note was skipped (the end cleanup still worked from compose
  labels).
- The completion alert's "Attempts: 10 for 7 steps (4 passed first time)" counts built steps and
  fix-up passes as attempts; per feature ("Phase 1 in 2 attempts, Phase 2 first time") reads
  better in phase mode.
**Why it waits.** None of them is wrong or unsafe; each is a tuning choice for Scott at
CHECKPOINT 8 or after the DB project's next part (P9.1), where the fix-up cost can be measured
on real work.
**Trigger.** CHECKPOINT 8, or P9.1's review.
**Path.** A `fixup.minSeverity` setting (`low` default, `medium`, `high`, `off`); keep the
file's own formatting by patching only the changed keys; notes get `min(60 s, what the gate can
spare)`; the summary counts attempts per feature when `gate.verifyAt` is "phase".
**No rework.** Each is local to one module (gate.js, configpage.js, footprint.js, summary.js).

## 23. Sweep follow-ups found in review

**What.** (1) Owner-wide Read allow rules (for example `Read(//c/**)` in the user settings) could
still let a sweep browser session read files; absolute-path Read deny rules on Windows are
unverified. (2) Passwords a sweep invents in sign-up mode, and Playwright's own snapshot files in
the browser output folder, are only pattern-masked. (3) No command to give up a paused or
unfinished fix run and go back to the project's own plan (today: finish it, or a plain
`autoclaude run` drops an override with no run behind it). (4) Closing the sweep window or Ctrl+C
counts as a dead window the watchdog reopens; `autoclaude sweep-stop` is the way to stop.
**Why it waits.** Each is narrow, and the review judged the defaults safe: sessions run with
`--disallowedTools` for writes and shells, and everything the sweep saves is masked.
**Trigger.** A sweep that shows one of them, or Scott asking.
**Path.** (1) a verified Read deny syntax for Windows paths; (2) mask the sign-up passwords the
session reports back, and run the browser output folder through the masker; (3) an
`autoclaude run --drop-plan`; (4) mark a sweep stopped on SIGINT/SIGBREAK in sweep-run.
**No rework.** All four are local to sweep.js, cli.js or tester.js.
