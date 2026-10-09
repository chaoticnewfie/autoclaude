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

## 8. A second provider: Gemini through the Antigravity CLI

**What.** Scott (2026-10-09) has a Google AI Pro plan and asked for an optional way to use
Gemini or Antigravity alongside Claude, to spread the usage and to use Gemini where it is good.
Opt-in per project; nothing changes for anyone who does not turn it on. This entry replaces the
earlier one-line "second-opinion reviewer through another provider". Its priority, in his words
the same day: "It's not critical, just brainstorming since I pay for it already, use the tokens
if we got them". So Gemini is spare capacity to use when it is there, never something a run
depends on.

**The tool (read from Google's docs on 2026-10-09, not yet run here).** Gemini CLI stopped
serving individual AI Pro and Ultra plans on 2026-06-18; its replacement is the Antigravity CLI,
`agy`. Its print mode has nearly the shape of `claude -p`:
- `agy -p` (aliases `--print`, `--prompt`); `--output-format json` returns one envelope with
  `conversation_id`, `status` (SUCCESS, ERROR, CANCELED, ...), `response`, `error`,
  `num_turns`, `usage` and, with a schema, `structured_output`. `stream-json` also exists.
- `--json-schema` takes a schema string or a `.json` path; `--model` takes a slug from
  `agy models` (an unknown slug exits 1, no silent fallback); `--effort low|medium|high`;
  `--continue` / `--conversation <id>`; `--print-timeout` (default 5m); `--sandbox`.
- Permissions: reads and writes inside the workspace are auto-allowed; shell commands are
  soft-denied (the run carries on and exits 0); `permissions.allow` rules live in
  `~/.gemini/antigravity-cli/settings.json`; `--dangerously-skip-permissions` allows everything.
- Auth: a one-time interactive `agy` sign-in; a headless run without cached credentials exits
  with "authentication required" instead of hanging. MCP servers, hooks and skills are supported
  (their pages not read yet). `/usage` shows model quotas; AI Pro's actual limits are not known.

**The blocker: terms of service (checked by hand 2026-10-09).** Antigravity's terms, section 6:
"Using third party software, tools, or services to access the Service (e.g. using OpenClaw with
Antigravity OAuth) is a breach of this Agreement. Such actions may be grounds for suspension or
termination of your Antigravity and/or Gemini CLI accounts" (https://antigravity.google/terms).
The FAQ entry is titled "Why can't I use third-party software (such as Claude Code, OpenClaw, or
OpenCode) with my Antigravity login?" and recommends "a Gemini Enterprise or Google AI Studio API
key" for third-party coding agents (https://antigravity.google/docs/faq/). Whether a script that
launches the unmodified `agy` binary counts is not answered by Google: forum threads asking
exactly this got only non-staff replies saying it is fine. So AutoClaude driving `agy` on
Scott's AI Pro login risks those accounts. The safe route is an AI Studio API key, which is
billed per use and not covered by the subscription, which undercuts "I pay for it already".
Scott using Antigravity by hand is fine either way.

**More from the workflow research (2026-10-09; Google's docs, the `google-antigravity/
antigravity-cli` repo at 1.3.2, issues; not run here).**
- Windows: "runs natively on macOS, Linux, Googlebook, and Windows"; install
  `irm https://antigravity.google/cli/install.ps1 | iex` to `%LOCALAPPDATA%\agy\bin`; tokens in
  Windows Credential Manager; settings under `%USERPROFILE%\.gemini\antigravity-cli\`. Windows
  Server is never mentioned. Open Windows issues: a `run_command` leaks dwm.exe handles (#1188),
  a hung MCP server blocks a headless turn and then reports an empty SUCCESS (#841).
- Read-only is not available from a flag: `--sandbox` restricts terminal commands only and
  `write_file` still works (#45); there is no per-run settings or permissions flag (#627). Deny
  rules (`write_file(*)`, `command(*)`) and a PreToolUse hook returning deny were honoured
  headless in user reports, but only through global or project settings.
- Quota stops (1.2.14+): exit code 3 and a stderr line `AGY_ERROR: {...,"status":
  "RESOURCE_EXHAUSTED","error_code":429,...}` with "Resets in 1h1m35s" in the text.
  `agy -p "/usage" --output-format json` reads the quota without spending any. A tool that was
  auto-denied can still end with exit 0, SUCCESS and no `structured_output` (#794).
  `--print-timeout` is 5m by the headless page but "unlimited" by changelog 1.2.6.
- Instructions: reads `AGENTS.md`, `GEMINI.md`, `.agents/rules/*.md`; never `CLAUDE.md`.
- Models on AI Pro: Gemini 3.1 Pro and 3.6 to 3.8 Flash; also Claude Sonnet 5.5 and Opus 5.5
  (thinking) on non-trial AI Pro, in a separate "Claude and GPT models" quota with its own
  5-hour and weekly limits (https://antigravity.google/docs/models/). AI Pro quota numbers are
  not published.
- Data: under the consumer terms Google may use "Interactions" to improve its products and
  machine learning, and reviewers may read them; opt-out is in settings.

**Where it fits, best first.**
1. *Sweep verifiers.* Verification is about 90% of a sweep's sessions (DEFERRED 26) and a
   thorough sweep gives each candidate 3 verifiers. Making one or more of them Gemini moves that
   share of the usage off Claude, and a vote from another model family is more independent than
   three Claude votes. Verifiers are read-only and answer a schema: the cleanest fit.
2. *Sweep reviewers*, as an extra pass over the same areas: different models miss different
   things. A long context could read a whole small project at once (cross-file duplicates for
   optimize).
3. *The gate's security review* of a step's diff, as a second reviewer (the original entry).
4. *Overflow.* When Claude's 5-hour reading nears the limit, a sweep's pool sends read-only
   sessions to Gemini instead of waiting. Fits DEFERRED 26's spare-usage idea.
5. *Maybe later:* the browser tester. It needs Playwright MCP under `agy` and the same tool
   restrictions the Claude tester has.
6. *Images (Nano Banana, Google's image model).* Scott, 2026-10-09: "we could use gemini for
   nano bananna if we every need images". Claude cannot make raster images; today a builder can
   only hand-write SVG. An app being built may want icons, illustrations, placeholder art or
   mockups. Shape: a command the builder calls (like `autoclaude decide`) that asks Gemini for an
   image, saves it into the project and returns the path; the step's Accept lines and the browser
   tester judge the result as usual. Unknown: whether `agy` or the AI Pro plan can generate
   images headlessly at all (the Gemini API's image models are billed per call with an API key,
   which is not the subscription). The spike answers that first.
Not the builder and not the decider. A run is built on Claude Code itself: the Stop gate, the
tool guard (PreToolUse), the supervisor's `claude --continue`, the statusline usage reading.
A Gemini builder would bypass the guard and the gate, which is a second product. The decider is
cheap and benefits from consistency. In a normal run the review sessions are a small part of
the usage (the builder is most of it), so outside sweeps the gain is a second opinion, not
savings.

**To prove first (a Phase 0-style spike on Windows), after the terms question is settled.**
- `agy` installs and runs on Windows Server 2025 (Windows 11 is documented; Server is not), and
  print mode takes a long prompt.
- Read-only can be enforced. Claude checkers get `--allowedTools Read,Glob,Grep`; `agy`
  auto-allows workspace writes and `--sandbox` does not stop them (#45). Options: deny rules in
  a project's settings, a PreToolUse hook that denies, or a scratch copy of the project as the
  workspace. A reviewer that can edit the project breaks the independence the gate rests on.
- `--json-schema` holds with the real verdict schemas (nested objects, enums), and a denied
  tool is told apart from a real answer (#794).
- The quota stop matches the `AGY_ERROR` form above on the installed version.
- Its settings are global in the user's home, so AutoClaude must pass everything per run (or per
  project) and not rewrite the owner's own `agy` settings.

**Privacy.** Code and findings go to Google under the consumer AI Pro terms and their own
data-use settings. Per-project opt-in, off by default, so a project with sensitive data can stay
Claude-only. Live sweep checks (secrets file, attacks) stay with Claude.

**Why it waits.** Not asked to be built yet; the terms question above has no official answer;
the spike has not run; AI Pro's quota is unknown.
**Trigger.** Scott says go and chooses between his AI Pro login (account risk) and a billed AI
Studio API key, or Google answers the terms question.
**Path.**
1. Spike under `spikes/`, results in `VERIFY.md`: the list above.
2. A runner for `agy` beside `runHeadless` that returns the same normalised result
   (`ok`, `infra`, `structured`, `rateLimited`, ...), with an `agyBinary()` lookup and an
   environment override like `AUTOCLAUDE_CLAUDE_BIN`.
3. Settings (names to settle): on/off per project, the model, which roles use it, how many of a
   finding's verifiers are Gemini. Settings page, USAGE, INSTRUCTIONS, CHANGELOG
   (docs-coverage test).
4. Reports name the model behind each vote and each finding; preflight checks `agy` is found and
   signed in when it is on.
**Open decisions for Scott.** Which roles first; which Gemini model (D44 says newest Opus as
main and no small Claude models; the Gemini equivalent of that floor); whether a Gemini vote can
reject a finding on its own or only alongside a Claude vote.
**No rework.** Every checker and sweep session already goes through one runner with a JSON
schema and a normalised result, and votes are already tallied per verifier. A provider is one
more runner behind that interface.

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

## 24. Duplicates the sweep's merge still misses

**What.** Seen in the P10.12 proof after the P10.14 merge rules: the same problem as two
whole-file findings in different categories (".gitignore does not cover .env" as secrets and as
config), a package reported in both package-lock.json and package.json, and code copied to three
places (only pairs merge).
**Why it waits.** Each is shown once more than needed, never lost or wrongly fixed, and loosening
the merge risks folding genuinely different problems together.
**Trigger.** A real report where these repeats get in the way.
**Path.** Category groups for the whole-file rule (secrets/config for ignore-file findings), the
lockfile and manifest as one place for package findings, and clusters instead of pairs for
duplicate code (findings.js dedupe).
**No rework.** The merge already runs in three passes over the same list; each is a new pass or a
wider match.

## 25. Leftovers after a completed run, and a shared-file race

**What.** Seen in the P10.12 proof: (1) after a run completes, the supervisor waits for the last
builder session, which sits idle at its prompt until the owner closes the window, so the window
and a claude process stay; (2) a dev server the run's checkers started was still running hours
after the run completed; (3) with several Claude sessions at once (a sweep's 3), one session once
read ~/.claude.json mid-write ("corrupted: Unexpected EOF"); its retry worked and the file stayed
valid.
**Why it waits.** None loses work: (1) and (2) only hold a folder and a port until the window is
closed; (3) is Claude Code's own file and the retry already covers it.
**Trigger.** An owner tripping over a held folder or port, or (3) failing a session twice.
**Path.** (1) on complete, end an idle builder session and exit; (2) stop any dev server the run
started at completion (devserver.js already knows which it started); (3) stagger session starts
by a second or two.
**No rework.** Each is a few lines in supervisor.js, gate.js complete() or the sweep pool.

## 26. Sweeps in pieces (spare usage before a weekly reset)

**What.** Scott's idea (2026-10-04): start a sweep overnight on leftover weekly usage, stop it in
the morning unfinished, fix what that night found, and carry on later, with each piece cheaper
than starting again. How sweeps behave today (read from sweep.js 1.1.1):
- A stopped sweep (`sweep-stop`) resumed with `sweep-run <id>` carries on where it stopped and
  never reruns a finished session. One sweep spread over several nights costs the same as one
  run straight through.
- Findings come only at the end. The stages run in order (inventory, scanners, map, review,
  live, merge, verify, report, after), and verification starts after every reviewer has
  finished. Verification is most of the work: 75 of 84 sessions in the practice security sweep,
  78 of 86 in the optimize one. A sweep stopped part way leaves unverified candidates in
  `agents/*.json`, with no report and no fix plan. A stop during verify decides nothing from a
  part of the votes.
- A new sweep starts from zero. Only `autoclaude.accepted.json` carries over. It is applied at
  merge, after review, so it saves the verifier sessions of accepted findings and nothing else.
  A re-sweep after fixes costs about the same in review. It costs less in verification, which
  scales with the number of findings.
- A sweep's file list and areas are fixed when it starts. Reviewers read the working tree as it
  is when each one runs. Code changed between pieces of one sweep (fixes, or a fix run's branch
  checked out in the same folder) means later areas see other code than earlier ones, and
  verifiers judge earlier candidates against the changed code.
- Possible today: split the code with `exclude`, one finished sweep per part. Every part runs the
  scanners, the map, the cross-cutting reviewers and the live checks again.
- Size today: the practice app (29 files, 5 areas) took 31 min and $20 at API prices per sweep,
  3 sessions at a time. A project with ten times the areas is still a few hours, so most
  projects fit in one night. Usage is the limit, not the clock. `autoclaude security --estimate`
  (or `optimize --estimate`) prints the size and starts nothing.
- Seen in both practice reports: the 5-hour and weekly readings were the same before and after a
  $20 sweep. Check whether the sweep's headless sessions refresh the usage reading before relying
  on a usage-based stop.

**Why it waits.** Not asked to be built yet, and a real old project's size has not been
measured. One overnight sweep may simply finish.
**Trigger.** Scott asks for it, or a real sweep is too big to finish in the time or usage left.
**Path**, in the recommended order:
1. *Partial report.* `autoclaude sweep-report <id>` (or `sweep-stop --report`): merge, verify and
   report what the finished reviewers found. Areas not yet reviewed are listed as not reviewed,
   which the coverage table already supports. A resume reviews the remaining areas and verifies
   only the new candidates, so merge has to keep earlier verdicts by fingerprint (today it
   rewrites the store with `verdict: null`).
2. *A deadline.* `--until <hh:mm>` and/or a weekly-usage ceiling for the sweep. At the deadline
   it stops launching reviewers and writes the partial report from step 1.
3. *Incremental re-sweeps.* Remember each finished area's file hashes, the plugin version and the
   options. A new sweep skips areas unchanged since the last finished sweep and carries their
   findings forward. Scanners, the map, the cross-cutting reviewers and the live checks always
   run again. This is the saving for "fix, then sweep again". The risk: a change in one file can
   open a hole in an unchanged one (shared auth code, say), so offer it as a choice, with a full
   sweep as the default.
4. *(Larger)* Verify each area as soon as its reviewer finishes, so any stop leaves verified
   findings for the finished areas. Duplicates across areas would then be verified twice before
   they merge.
Whatever is built, a piece must not run while a fix run is working in the same folder.
**No rework.** The ordered stages and the saved per-session results are already there.
(1) is a new command plus a verdict-keeping merge. (2) is a stop condition in `runPool`.
(3) is a filter in `buildAgentPlan` and a carry-forward in merge.

## 27. Verification time limits and automatic recovery of paused runs

**What.** Scott (2026-10-09) asked whether Gemini could take over "for times where claude times
out... to automate continuing without needing me to get you to do it outside of autoclaude
runs", added "The stop checks at the end of phases only have 900 seconds", and confirmed he
meant verification at the end of a phase running out of time and pausing the run until he fixes
it by hand. A workflow (4 researchers, 3 designs, 1 adversarial judge; read-only) mapped the
limits and designed the fix. Verified by hand afterwards: the DB report and gate log below,
`checks.js` rerunWanted, the gate's check-failure path, Google's FAQ and terms.

**What "900 seconds" is.** Not the stop. A stop gives a verification's parts 1740 s
(`gate.timeoutSec` 1800 less 60 s for the commit), and a part may need at most 1218 s to fit
(`gate.fitPct` 70). The 900 s is a check's own `timeoutSec`: the default when unset
(`DEFAULT_CHECK_TIMEOUT_SEC`, `lib/checks.js`), what `init` writes for e2e, and what the DB
project set for `npm test`. The tester and the security review also default to 900 s, but their
turn budgets end them sooner (the DB run's security reviews averaged 77 s).

**What happens today when a check hits its own limit**, with time left in the stop:
- It is killed at 900 s ("timed out after 900 s"), not rerun (`rerunWanted` excludes timeouts),
  and counted as the builder's failed attempt. The third attempt pauses the run as
  `step-failed`. It is not carried to the next stop and not treated as out of time.
- The builder cannot raise the limit (the config is locked during a run). Nothing tells the
  owner that the check's own limit, not the stop, was the binding one.
- Seen in the DB run: S11.4 attempt 1, `npm test` "timed out after 900 s" with about 757 s of
  the stop left (`C:\Database\.autoclaude\reports\S11.4-1.md`, gate.log lines 99-104). The
  builder then sped the suite up (commit `bebdb37`: 928 s to 634 s) and attempt 2 passed
  65 minutes later. The timeout was a useful signal; it should not have cost an attempt.
- Related gaps: the estimate never learns a check's timed-out runs (only passes are recorded),
  so `lint-plan` says a 900 s check fits; validation accepts a check `timeoutSec` above what a
  stop can give; a checker that hits its own limit is reported as `infra` ("Check Playwright
  and the claude CLI"), and its same-stop retry is a second Opus session that ends the same way;
  a second out-of-time try of a stop's first part cannot succeed (it already had the whole
  stop).
- The 1800 s Stop-hook cap is our own `hooks.json` value. Claude Code documents a 600 s default
  for command hooks and no maximum; nothing above 1800 s has been tested. `lib/configpage.js`
  and `docs/USAGE.md` wrongly call it Claude Code's limit.

**Recommended plan** (the judge's synthesis; each plugin change bumps the version, each setting
reaches the settings page, INSTRUCTIONS, USAGE and CHANGELOG, each choice gets a decision):
- *A0. Wording.* Fix "Claude Code's limit" (configpage, USAGE), say the tester limit scales 1x
  to 4x and also bounds the bug bash, name a check's own `timeoutSec` first in the out-of-time
  help, the plan skill and `estimate.js`, and stop suggesting weaker checks in alerts.
  Accept: `grep "Claude Code's limit"` finds nothing; the out-of-time alert for a check names its
  `timeoutSec`.
- *A1. A check that hits its own limit is not an attempt the first time.* Raise that check's
  limit for the rest of the run to the fit limit (1218 s by default) in run state
  (`state.checkLimits`, not the config), carry it to the next stop, write a follow-up row ("did
  not finish in its T s; passed in N s") so the fix-up pass asks for a faster suite, and alert.
  A second timeout at the raised limit, or a check already at the fit limit, is the builder's
  attempt with "a hang or a real slowdown: fix it; never skip or delete tests". Accept: a
  fixture check with `timeoutSec` 5 that needs 8 s leaves attempts at 0, passes in the next stop,
  sets `state.checkLimits`, writes the row and the alert; a check that never ends costs one extra
  stop, then shows attempt 1/3.
- *A2. Estimates see timeouts.* `check-times.json` keeps a timed-out lower bound; `lint-plan`
  and the preflight warn; validation warns when a check's `timeoutSec` exceeds what a stop
  gives. Accept: `lint-plan` prints the warning on a fixture with a recorded timeout.
- *A3. Checkers that hit their own limit.* No same-stop retry; raise the limit for the run to
  min(stop, 2x) and park; a second time is `infra` with a message naming `tester.timeoutSec` or
  `security.timeoutSec`. Accept: a stub runner that times out gets one try, is parked, gets the
  raised limit next stop, and the alert names the setting.
- *A4. A checker that hits the Claude usage limit pauses as a new `usage-limit` reason*, keeps
  `state.verifying`, records the reset time, counts nothing (today it becomes `infra`; only the
  sweep reads `rateLimited`). Accept: a stub returning `rateLimited: true` leaves the run paused
  as `usage-limit` with attempts and infra counts unchanged.
- *B1. Record what a pause needs:* `state.pauseDetail` (reason, step, phase, part, whether the
  per-step way out applies), hashes of the plan and config at the pause, and a `recoveryLog`
  that `resume` does not reset.
- *B2. Automatic recovery in the supervisor, plain Node, no model acts.* Only two cases:
  `usage-limit` waits for the reset plus a grace, then resumes with the attempts kept;
  `out-of-time` on a checker (not a check, not a fix-up pass) waits 10 minutes, then does what
  the alert tells the owner today (`verify-per-step <phase>`, then `resume`), once per phase,
  with an alert that names the extra usage and the undo (`verify-per-step N --off`). Never
  `review`, `blocked`, `security`, `step-failed`, `stuck`, `infra`, `commit-failed`. Guards:
  re-read state under the lock, do nothing if the plan or config changed since the pause (the
  owner may be mid-edit), at most 3 actions per run, never touch PLAN.md, checks or checker
  settings, no commit from the supervisor. The watchdog must relaunch a supervisor for a paused
  run with a pending timed recovery (today it skips paused runs). Setting:
  `supervisor.autoRecover` (the supervisor group is already safe to change during a run).
  Accept: `decide()` tests for every pause reason; a scenario where out-of-time ends with
  `gate.stepPhases` written, the run running and one `recoveryLog` entry; the same pause a
  second time only pages; a plan edited during the pause stops any action.
- *B3. Alerts that are silent today:* `GATE ERROR` and config errors (at most hourly), and the
  Notification types `quota_auto_resume_disabled` / `quota_auto_resume_stale` (Claude Code gave
  up waiting, or waits for Enter after a sleep).
- *Optional, later:* B4, a read-only triage note (decider pattern, never acts) for the pauses
  that stay with the owner; A5, a spike of a Stop hook timeout above 1800 s on Windows (and
  whether a cancelled hook's `npm test` and `claude -p` children are killed, or keep burning
  usage), only if a single check really needs more than 1218 s.
Order: A0, A1 with A2, A3, A4, B1 with B2, B3, watch one run, then B4 and A5 if wanted.

**Risks the judge raised.** Per-step verification spends more of the 5-hour window (every check
and a tester per step), so auto-switching must say so and happen at most once per phase.
Resuming `step-failed` automatically would let the builder refill its own attempts through test
output it controls, so it stays out. More parks between stops push toward Claude Code's cap of
8 blocks in a row without a tool call (count parks; keep them at 6 or fewer). A foreground Bash
call is capped at 10 minutes, so a check over 600 s is also hard for the builder to rerun
(unchecked).

**Gemini's part: none.** A run is Claude Code (gate, guard, supervisor), so Gemini cannot keep
it going, and once Claude has usage again plain Node covers every safe recovery. See DEFERRED 8
for the terms-of-service question that applies to any scripted use of his AI Pro login.
**Already provided by Claude Code, do not rebuild:** automatic continue at the 5-hour limit in
interactive sessions (on by default since 2.1.234, Scott's settings leave it on): it covers the
builder and his own sessions outside runs while the session stays open. It re-arms at most twice
in a row, does not start for a reset more than 24 h away, not in `-p` or background sessions,
and after a sleep of about 30 minutes it waits for Enter. Not stated for the VS Code extension.

**Open decisions for Scott** (judge's defaults): where he saw the 900 s (default: a check's own
limit, as in the DB run); A1 on by default (yes); keep 900 s for an unset check limit (yes,
A1 handles real slowness); automatic recovery on for usage-limit and checker out-of-time only
(yes, in this computer's defaults, per project override); recovery may write `gate.stepPhases`
through the existing command (yes); never auto-resume `step-failed` or `stuck` (never); triage
note (off until one live run); spike above 1800 s (no); Gemini in recovery (no).
**Why it waits.** Not approved to build yet.
**Trigger.** Scott says go.
**No rework.** Parking, carry-over, `verify-per-step`, `resumeRun` and the supervisor's paused
loop already exist; A1 to A4 change how a timeout is classified, B2 adds one branch to the
supervisor's decision for a paused run.
