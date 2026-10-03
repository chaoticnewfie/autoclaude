# Session log

One entry per working session: what was done, what was committed. Append only.

## 2026-09-26 (Code VM, Windows Server 2025) - Plan review and revision

- Read the plan drafted on the phone (2026-09-24).
- Surveyed every chaoticnewfie repo for shared conventions: `docs/CONVENTIONS_SURVEY.md`.
- Scott's answers: pause feature approved as proposed; conventions all except 10, with 15 reworded;
  pure Windows support required (Server 2025 and Windows 11, no WSL); agents are fine in reasonable
  numbers as long as they are stopped when no longer needed.
- Renamed autopilot to autoclaude throughout. Replaced the tmux and systemd design with a Node
  supervisor (D18). Added pause-for-review (D19), shareability (D20), one `init` for new and
  existing projects (D23), doc paths (D24). Wrote `CLAUDE.md`, `docs/DECISIONS.md`,
  `docs/DEFERRED.md`, `.editorconfig`, `.gitignore`.
- Commits: `46a7aa9` plan, survey and resume point; `aa8a448` the revision.

## 2026-09-26 (Code VM) - Phase 0 spikes

- Installed Claude Code native 2.1.283 (`~/.local/bin`, added to the user PATH) and Playwright
  Chromium. Verified the native CLI runs headless from inside a Claude session with or without the
  `CLAUDE*` environment stripped.
- Spikes under `spikes/`: p02 Stop-hook loop (3 and 10 blocks with tool use, 8 without, 300 s
  timeout survived), p04 nested headless with `--json-schema` (works; `--bare` fails auth), p05
  Playwright MCP through `cmd /c npx` (clicked and read the page), p10 plugin exec-form hooks with
  `${CLAUDE_PLUGIN_ROOT}` and a path with a space, plus `renameSync` over a locked file (EPERM,
  retry works). p08 supervisor: detached window, three spawn, `taskkill /T`, `--continue` relaunch
  cycles with no orphans; the interactive claude sat on the first-run theme picker, so hooks,
  statusline and permission checks are still pending.
- Found and rejected Claude Code background sessions (`claude --bg`) as the runner: Stop hooks do
  not run there (D26). Found `cachedUsageUtilization` in `~/.claude.json` as a second usage source
  (D27). The auto-mode classifier denied editing `~/.claude.json`; that boundary is now D28.
- Wrote `VERIFY.md`, ticked P0.1, P0.2, P0.4, P0.5, P0.10, added D26 to D31, updated the plan.
- Next: Scott runs `claude` once in `C:\AutoClaude` (theme, trust, `/config`), then the p08 rerun
  closes P0.3, P0.6, P0.8 and CHECKPOINT 0 follows.

## 2026-09-27 (Code VM) - Phase 0 closed

- Scott did the one-time interactive run and confirmed auto-continue at usage limit is on. The
  trust key landed as `projects["C:/AutoClaude"]` (forward slashes).
- Reran `spikes/p08-supervisor`: statusline `rate_limits` 4 s after start; `--continue` from a new
  process resumed the same session and answered; `idle_prompt` 61 s after each stop; the
  `AskUserQuestion` PreToolUse deny and, in a fourth run with `mkdir`, the PermissionRequest deny
  both reached Claude with the guidance text and no prompt; `taskkill /T` left no orphans;
  `claude agents --json` reports the interactive session as `idle` or `busy`.
- `VERIFY.md` rows P0.3, P0.6, P0.8 set to Pass; P0.9 done; PLAN.md ticked. Only the RDP
  disconnect check remains and it is Scott's.
- Next: CHECKPOINT 0 review, then Phase 1.

## 2026-09-27 (Code VM) - Phase 1

- Scott: Phase 0 accepted implicitly ("continue with phase 1"); new requirement R17 (plans must
  settle decisions ahead of time; existing projects get a plan review) recorded in PLAN.md.
- RDP disconnect and reconnect verified with a live spike window: both processes survived.
- Built the plugin skeleton: local marketplace, `plugin.json` with userConfig, skills `status`,
  `pause`, `note`, `resume`; `claude plugin validate --strict` passes; installed on this machine
  through `claude plugin marketplace add` and `claude plugin install` (loads in place from the repo).
- Libraries: `paths`, `fsatomic` (atomic writes with EPERM retry), `config` (defaults, merge,
  validation), `state`, `plan` (parse, lint, next step, byte-exact marker writes; fenced blocks
  ignored; phase headings at H2 to H4), `usage` (statusline file first, cached key as fallback),
  `notify` (ntfy, Discord, stdout), `proc` (shell runs with timeout, kill tree, PATH lookup,
  console-window launcher), `cli` (status, pause, note, resume, lint-plan, usage, install-cli,
  notify-test). `install-cli` wrote the shim and added it to the user PATH on this VM.
- Tests: `node scripts/check.js` -> syntax 19/19, **44 tests, 44 pass**. The parser test runs on
  this repo's own PLAN.md, which is why P8.1 to P8.3 gained Accept lines.
- Found: `cachedUsageUtilization` vanished from `~/.claude.json` after an interactive session
  rewrote it (D27 amended).
- Scott provided a Discord webhook. First test went through the userConfig environment path
  (HTTP 204, confirmed on his phone), but Node then crashed on exit (forced `process.exit` while
  the HTTP client was closing); fixed by setting `process.exitCode` and draining the response.
  Found that plugin userConfig reaches only hook processes, so the CLI and supervisor get a
  per-machine `notify.json` via `autoclaude notify-setup` (D32); second test sent from the CLI
  with no environment, HTTP 204. The webhook is in the OS secure store and in that file, never in
  the repo or the log. CLI tests now run under a throwaway `CLAUDE_CONFIG_DIR`.
- P1.5 ticked. Phase 1 complete; CHECKPOINT 1 presented.

## 2026-09-27 (Code VM) - Phase 2

- Scott: go for Phase 2; asked how a resumed run knows where it is (answered, D33).
- One background agent drafted `project-template/` (13 files) from the conventions survey and
  the R17 rules; reviewed and kept as delivered. Stopped when done.
- Built `lib/init.js` and the init skill, `lib/registry.js`, `lib/statusline.js` with the
  self-contained `templates/statusline-bridge.js`, `hooks/hooks.json` with the SessionStart hook,
  `scripts/session-context.js` and `prompts/context.md`, the todo-app fixture and three fixture
  plans. `npm test` counterpart: `node scripts/check.js` -> 61 tests pass.
- Live, on a scratch copy of the fixture under `spikes/out/todo-demo`: `init` created the config
  (lint, unit, e2e, dev server) and the doc set, registered the project, and installed the
  statusline bridge into `~/.claude/settings.json` with a backup. A headless session answered
  with the injected step and owner note. An interactive window showed
  `AC S1.1 > running | 5h 44% | 7d 11%` and wrote `usage.json`.
- Gotcha: the scratch copy had its own `.git`, so it needed its own workspace trust and the first
  window stopped on the trust dialog; removed the nested repo (now in `CLAUDE.md` facts).
- Three Discord test notifications delivered in total today.
- P2.1 to P2.5 ticked. CHECKPOINT 2 presented; Scott's look at `/compact` re-injection pending.

## 2026-09-27 (Code VM) - Phase 3, the gate

- Scott: go for Phase 3. Two background agents wrote the leaf libraries against written
  contracts (`checks` + `report`, 13 tests; `devserver` + `git`, 15 tests) while the core was
  written here: `lib/protocol.js`, `lib/gate.js` (section 4.4 in full, plus the review pause,
  the weekly-usage pause and the D33 re-baseline), `scripts/stop-gate.js` (lazy imports so a
  half-written library can never break a session), `scripts/heartbeat.js`,
  `scripts/tool-guard.js`, `hooks/hooks.json` with all four hooks, CLI `start`, `ready`,
  `blocked`, the start skill, `test/fixtures/prepare.js`, the fixture Playwright spec.
- `test/scenarios/stop-gate.test.js`: 12 scenarios, all green on the first run. Full suite: 107
  tests pass, syntax 49/49, `claude plugin validate --strict` passes.
- Agent finding worth keeping: on Windows a dev server started from a hook must be detached, and
  a detached cmd.exe loses the inherited log handle, so the dev server runs through a detached
  console-less node wrapper (now in `CLAUDE.md` facts). Stale-pid caveat filed as DEFERRED 12.
- Both agents stopped on completion. Scratch project for the live run prepared at
  `spikes/out/todo-live` (happy plan, its own git repo, so it needs Scott's one-time trust).
- P3.1 to P3.8 ticked. CHECKPOINT 3 (the first live run) is next.

## 2026-09-27 (Code VM) - CHECKPOINT 3, first live runs

- Scott trusted `spikes/out/todo-live` once. `autoclaude start` created branch
  `autoclaude/todo-fixture`; the builder ran in a window opened by the spike supervisor with
  `--permission-mode auto` and one initial prompt.
- **Happy plan: 3/3 steps verified and committed, 02:04 to 02:10 UTC, every step on its first
  attempt.** Commits `c6b4611`, `aebe624`, `2ca5f87` (`autoclaude(S1.x): ...`), tag `ac-phase-1`,
  clean tree, PLAN.md ticked by the gate, three PROGRESS.md lines, state `complete`, Discord
  summary delivered (HTTP 204). The builder logged five D-### decisions and rewrote
  CONTINUE_HERE.md before each `ready` without being reminded.
- One permission prompt appeared and Scott accepted it (auto-mode classifier fallback); the
  Phase 5 PermissionRequest hook is what removes that.
- Found and fixed: Git Bash does not resolve the `.cmd` shim by bare name, so `install-cli` now
  writes an extensionless sh shim too (D34); the tool guard denied two plain reads because of a
  `2>/dev/null` on the same line, so its shell rules now match only real writes to protected
  paths (D34, 9 new assertions); `status | head` crashed with EPIPE, now ignored. 108 tests pass.
- **Broken plan: paused after 3 attempts, 02:14 to 02:17 UTC.** Attempts 1 to 3 each failed the
  unit check, three reports were written, the step is `[!]`, state `paused (step-failed)`, and a
  high-priority Discord message named the report (HTTP 204). The `fixture-unchanged` check passed
  every time: the builder did not touch the impossible test. Report 3 shows the failing test
  output in the first screen, which is the "feedback Claude gets is clear" check of section 6.5.
- CHECKPOINT 3 met. Phase 3 complete.

## 2026-09-27 (Code VM) - Phase 4, the browser tester (model switched to Opus 5.5 by Scott)

- Built `lib/headless.js` (the `claude -p` runner shared with the Phase 5 reviewer), `lib/tester.js`,
  `prompts/tester.md`, `prompts/bugbash.md`, gate wiring (dev server restart before each
  verification, tester for UI steps, bug bash at phase ends, infra failures never counted and a
  pause on the second, minor bugs to BLOCKERS.md), `AUTOCLAUDE_ROLE` guards in every hook, the
  fake-claude fixture, unit and scenario tests, and `test/live/ui-bug.live.mjs`.
- Live run 1 never reached the browser: the fixture's `node --test test/` fails on Node 24 on
  Windows; fixed to a glob. Live run 2: the tester caught the broken form perfectly on attempt 1
  (evidence per Accept line, root cause, console error), passed the fix, but the bug bash failed
  the phase on an absurd-input layout issue it called high, and named screenshots leaked into the
  project root. Fixed: bug bash severity rules and evaluation (normal-use criteria plus high bugs
  only), checker working directory = its report folder with `--add-dir`, a stray-file sweep. Live
  run 3: tester fail, fix, tester pass, bug bash pass, plan complete, one commit, clean root, six
  screenshots in the report folders, three follow-ups in BLOCKERS.md. D35 logged.
- One SSH push to GitHub timed out and succeeded on retry. `node scripts/check.js`: 131 tests pass.
- P4.1 to P4.5 ticked. CHECKPOINT 4 presented.

## 2026-09-27 (Code VM) - Phase 7 reshaped, Phase 5 built

- Scott: the Phase 7 rehearsal runs on his DB project, onboarded from the repo link (D36); then
  "dont look at that project at all" (D37): a blind test, nothing prepared for it. Generic
  lessons kept: `guard.deny`, an existing-project plan review (P7.1).
- Phase 5: one background agent built the security reviewer against a written contract (12 unit
  tests, one live Opus run that caught a planted SQL injection and a hardcoded key as high in
  14 s). Built here: the PermissionRequest auto-deny hook and denial counting, `guard.deny`, the
  decider agent, `autoclaude answer` and its skill, the resume re-baseline (D33 made concrete:
  the first unfinished step in plan order), owner input in gate messages, the stale-usage
  warning, security in the gate, and a hook stdout fix (notify's fallback must never corrupt a
  hook's JSON answer).
- Live 1, `plans/needs-owner.md`: the builder asked the decider, blocked with a five-option
  question, Scott got the Discord message and typed "b" into the run window, the builder recorded
  it with `autoclaude answer` (D-001), built the Discord webhook with tests, and the gate verified
  it including a real security review (pass, one low cross-site-request finding filed). 6 minutes.
- Live 2, happy plan with `review.pauseAt: every-step`: pause after S1.1, a note, resume, the
  builder applied it without breaking the Accept line and recorded N-001, pause after S1.2. Bug
  found and fixed: a note delivered at session start was never marked delivered, so it would have
  been re-applied on the next step.
- 161 tests pass. P5.1 to P5.6 ticked. CHECKPOINT 5 presented.

## 2026-09-27 (Code VM) - Phase 6 built and chaos-tested

- Built: the Notification hook (idle marker; pages only for prompts that wait for a person, D39),
  the StopFailure hook (`failure.json`), `autoclaude run` (preflight, the `ac-<slug>` window),
  `autoclaude supervise` with one pure `decide` function, `autoclaude nudge`, the Task Scheduler
  watchdog (hidden VBScript, every 5 minutes), plan-complete and morning summaries. A background
  agent built the watchdog against a written contract.
- Live chaos run on a 5-step fixture plan, 68 minutes, log in `spikes/out/chaos-events.log`:
  killed claude (relaunched in 11 s), killed dev server (restarted by the gate), killed
  supervisor (the watchdog brought it back), Scott's RDP disconnect (nothing noticed it), forced
  `/compact` by nudge (context re-injected), stalled hook (relaunched after twice the stall time).
- Bugs the run exposed, all fixed with tests the same session: a nudge that killed a
  verification; a compacted session idling until the idle rule; a nine-minute verification
  mistaken for silence; a bug bash thrown away twice at its turn limit (now a turn budget in the
  prompt and one `--resume` wrap-up, verified live); a failed commit (git not on the run window's
  PATH) that did not stop the run (now a `commit-failed` pause, and `resume` commits first). Also
  fixed earlier in the phase: first session without run rules, a false "did not pick it up",
  the watchdog reviving an abandoned scratch run, Git Bash turning `/compact` into a path.
- Notifications from the run: a high "paused: the bug bash cannot run" and the default
  "plan complete" summary, both accepted by Discord. Idle markers paged nobody, as designed.
- 204 tests pass. P6.1 to P6.6 ticked. CHECKPOINT 6 presented.

## 2026-09-27 (Code VM) - Phase 7: plan skill, docs, and a review round before the rehearsal

- Scott settled D20: the repo stays private, shared with invited collaborators, no license; the
  rehearsal runs during the day (D41).
- Writing the install docs exposed that a GitHub install could not work: `init` read the project
  template from the repo root, and the shim and watchdog stored a versioned plugin path. Fixed
  (D42): the template ships inside the plugin, and a launcher finds the current install each
  time. The marketplace is now named `autoclaude`. A scripted install from GitHub into a
  throwaway config proved it, including a simulated update.
- Built the `/autoclaude:plan` skill, README.md, docs/USAGE.md and `autoclaude uninstall`.
- A review workflow (6 agents: two fact-checkers, a newcomer reading only the docs, two dry runs
  of the plan skill on scratch projects, a completeness critic) found real bugs, not just doc
  gaps. The worst: the tool guard ignored Claude Code's PowerShell tool, and did nothing at all
  from a path with a space; any session opened in a project during a run was treated as the
  builder, and `--continue` could resume the wrong conversation; `pause --now` left the builder
  working with every guard off; a finished plan could not be extended; new projects could not
  pass the dev server preflight. A fix workflow (4 agents, disjoint files) fixed them all, plus
  follow-ups done here: a failed `--resume` opens a fresh session, and a `pause --now` during a
  verification survives the gate's final save (D43).
- Verified live on this VM, version 0.9.1: `test/live/gh-install.live.mjs` installed from GitHub
  into a config folder with a space and a tilde, 9/9 (init from the cache copy, the launcher, the
  installed guard denying pushes from both shell tools, a simulated update). A real
  `autoclaude run` on the fixture's 3-step plan: the builder started under a chosen session id; a
  separate Claude session run in the project meanwhile was ignored by every hook (heartbeat
  unchanged) while the builder's own hooks worked; `pause --now` ended the builder within 20 s;
  `resume` relaunched it with `--resume <id>` and the context was re-injected; the plan
  completed 3/3 in 12 minutes, the bug bash wrapped up at its turn limit with a pass.
- Then `autoclaude uninstall` and `claude plugin uninstall` took this machine back to no
  AutoClaude, keeping only the Discord setting, for the onboarding rehearsal.
- 264 tests pass.
- Onboarding rehearsal by link on a scratch "existing project" outside the repo (headless
  `claude -p`, told only the repo URL, notes instead of questions): 13 minutes, 45 turns. It read
  the private repo with gh, installed the plugin from GitHub and the CLI, followed the init and
  plan skills by reading them, reviewed the owner's list and rules, planned 6 steps, set checks,
  the dev server and 13 tested deny rules (including the Proxmox host this VM has a root key
  for), committed, and stopped at `autoclaude run --check` with only `FAIL trust`, which a
  headless session can never give. Its notes led to 0.9.2: the run rules override the user's
  own `~/.claude/CLAUDE.md`; init reads a Node server's port and `/health` route, uses 127.0.0.1,
  and names the project from package.json; the plan skill reads the user-level rules and warns
  against writing deny patterns from a shell; USAGE notes on trust and on network access.
- `autoclaude uninstall` run through its own `.cmd` shim printed "The system cannot find the
  path specified" (cmd rereads a batch file it is running); the shim is now deleted two seconds
  after the command exits. Checked in real cmd, exit codes intact.
- The machine is back to no AutoClaude (plugin, marketplace, command, status line bridge and
  watchdog removed; the Discord setting kept; the registry emptied) for Scott's blind rehearsal.
- 265 tests pass. P7.1 and P7.2 ticked.

## 2026-09-27 (Code VM) - INSTRUCTIONS.md

- Scott asked for a plain instructions file for people that comes with the repo. Wrote
  `INSTRUCTIONS.md` at the repo root (what it does, requirements, one-time setup, starting in a
  project, running, pausing and notes, what each alert means, answering questions, after the run,
  settings, safety, troubleshooting, updating, a command list) and linked it from the top of
  README.md. He first described a copy that `init` would put into every project, then asked for
  just this one file in the repo instead. No plugin change, so no version bump.

## 2026-09-27 (Code VM) - Model policy (0.9.3)

- Scott: never Haiku; the newest Sonnet is the floor for very basic work; the newest Opus is the
  main model and the ceiling. Nothing in the plugin used Haiku; the Haiku he saw came from
  `--model haiku` verification calls during testing. Now (D44): `builder.model` (new, passed as
  `--model` on every launch), the decider agent, `tester.model` (was sonnet) and `security.model`
  all default to `opus`; config validation refuses anything but opus/sonnet aliases or full
  claude-opus-*/claude-sonnet-* ids. Saved as a memory and in repo rule 10 for building sessions.
- Scott also asked that AutoClaude's files not end up in the project repos it builds. AutoClaude
  never pushes (git.push is false, the guard denies the builder's pushes, the gate never pushes)
  and `.autoclaude/` is gitignored, but the config, the run records and the doc set are committed
  on the run branch and reach GitHub when the owner merges and pushes. Which of them should stay
  local-only is his call; asked.
- 266 tests pass.
- Scott answered the git question with "Leave it as is": only `.autoclaude/` stays out of a
  project's git (D45). INSTRUCTIONS.md now says what is committed and that AutoClaude never
  pushes.

## 2026-09-27 (Code VM) - Instructions in every project (0.9.4)

- Scott asked whether AutoClaude should live in its own cloned folder per device with projects
  pointing at it, and the instructions pulled into each project; then chose the one-time install
  per device. The plugin install already is that per-device folder (Claude Code's plugin cache),
  so what changed (D46): `init` copies INSTRUCTIONS.md into each project as AUTOCLAUDE.md, with a
  line naming the version that copied it and how to refresh it. The template copy is kept
  identical to the root file by a test. INSTRUCTIONS.md now says it is the only install per
  device and that a clone is for reading, not installing. `gh-install.live.mjs` also checks the
  copy.
- The fsatomic lock test timed out once under full-suite load (PowerShell took over 30 s to
  start); its wait is now 60 s.
- 268 tests pass.

## 2026-09-27 (Code VM) - Rehearsal under way; speed noted

- Scott installed the plugin from GitHub himself and started the DB rehearsal; it runs cleanly
  (9 of 28 steps verified by 19:34, no blocks). He finds it much slower than working in the
  VS Code extension. From his screenshots only (the DB project stays unopened, D37): about 27
  minutes per step, 2 points of the weekly limit for 6 steps, the builder spending about 4
  minutes running the checks the gate then runs again, and the builder on his default xhigh
  effort because AutoClaude never sets one. Speed options recorded as DEFERRED 18, to be measured
  and decided at CHECKPOINT 7. Docs only; no plugin change during the run.
- Scott pictured checks running once per feature (a phase), not after every step, which is how
  the gate works today (full checks and the browser tester per step, bug bash and security at
  phase ends). Recorded as the first option of DEFERRED 18 for CHECKPOINT 7.
- Scott expected the rehearsal to create the DB project's VM; runs are built to stay inside the
  project (the plan skill turns outside work into scripts, and I had advised him to name the
  Proxmox host off limits). He never wanted that: a run should do the whole project like a
  watched session, with limits only where he sets them. Recorded as D47 and DEFERRED 19, to build
  after the rehearsal with CHECKPOINT 7.
- Scott: the planning session never asked him what was off limits; he meant to say "do not touch
  any other VM or project, but create the VM and work on it there". Cause, from the skill text
  (the DB project stays unopened): the interview only asks what the docs do not already answer,
  and his notes list the Proxmox host and VMs, so the session decided the scope itself; 3d adds
  deny rules without a confirmation step, and 1b turns outside work into scripts. Recorded as
  DEFERRED 19 item 6: the scope question is mandatory and confirmed.
- Scott set the planning principle: many questions up front rather than assumptions; the run
  builds the bulk, he fine-tunes interactively after. Recorded as D48 and DEFERRED 19 item 7.

## 2026-09-28 (Code VM) - Rehearsal review (CHECKPOINT 7) and Phase 8 planned

- The DB rehearsal finished: 28 of 28 steps, 18 h 23 min, 26 first time, no pauses or relaunches,
  one alert, 10 weekly points. P7.3 ticked. Scott lifted the blind rule for the review.
- Two read-only agents measured and reviewed the run. Builder time 850 min, of which 568 min were
  the builder's own test runs (291 min of full-suite runs) and 216 min model time; the gate spent
  253 min re-running the same suite. Planning asked 8 questions, none about scope, and wrote the
  deny rules itself; the VM was left to Scott. Other findings: one 18-hour context (459K tokens
  average), the last commit and tags unpushed, a verified commit failing its own test, 13
  false-positive denials, the checks' environment differing from the gate's, background deciders
  triggering "Continue" nudges, 33 leaked Docker volumes. Scripts and reports in
  spikes/out/review/.
- Eight rounds of questions with Scott settled Phase 8 (D49): verify once per feature, targeted
  tests while building, a fresh builder per feature, pushes per feature, full scope with a
  snapshot offer and pre-approved permissions, secrets into secrets/, a fix-up pass for findings,
  HANDOFF.md, Docker cleanup, per-event alerts, layered settings and a browser config page,
  version 0.10.0 after a practice run Claude does itself, 1.0 after the DB project's next part.

## 2026-09-28 (Code VM) - Phase 8 built (0.10.0)

- Six build agents, an integration agent and an adversarial reviewer built Phase 8 in one
  workflow. Integration: 368 of 368 tests and 44 end-to-end interface checks with fakes (Docker,
  notifier, push, decider, browser). The reviewer added test/scenarios/feature-gate.test.js and
  fixed what it proved: a pause or note given during a verification was lost; a session ended
  mid-verification left plan ticks and PROGRESS lines behind; a phase verified again broke the
  next tag push; built steps no verification would reach could stay [~] at completion. The
  session hosting the workflow ended before the reviewer reported; its edits were complete and
  the full suite then ran 390 of 391 (the PowerShell file-lock test starting too slowly under
  load, which now reports a skip in that case).
- Docs for 0.10.0: INSTRUCTIONS.md and its template copy, docs/USAGE.md, README.md. D50 records
  the build agents' choices; DEFERRED 20 (Docker images) and 21 (guard blind spots).
- Pushed as f78f434 (code), 3355ad2 (docs), 7d9ab81 (practice helpers). A four-lens verification
  workflow then checked the committed code before the practice run.
- The verification workflow (37 agents) confirmed 29 defects, 3 of them high: the Docker cleanup
  treated anything created during the run as the run's own, and would have removed another
  project's volumes; it never checked it was talking to the same Docker engine. Two fix rounds
  (0.10.1 fd083a0, then 0.10.2) and their skeptic checks followed; a cmd.exe redirect regression
  and a cut-off-close loop from round 2 were fixed by hand. D51 records the choices; the guard's
  remaining best-effort gaps are DEFERRED 21. Full suite: 467 tests, 466 pass, 1 skipped.
- The practice project now excludes this repo's CLAUDE.md through claudeMdExcludes (checked:
  a session there loads only the user CLAUDE.md). P8.2 to P8.7 ticked.
- 0.10.2 pushed; test/live/gh-install.live.mjs 10/10 on it; this machine updated in place from
  0.9.4 to 0.10.2. P8.8 ticked.
- P8.9 practice run, done headless by Claude: planning in 13 turns (11 rounds, about 40 min),
  then 7 steps in 2 features in 64 minutes, each feature verified once with a fix-up pass,
  pushes per feature, a fresh builder for feature 2, HANDOFF.md, the settings page changing an
  alert switch mid-run (and refusing gate.verifyAt), Docker cleanup that removed a planted tied
  volume and left a planted untied one. Found: a Playwright MCP connect timeout counted as a
  failed attempt (fixed, D52), headless init applying its own recommendations (fixed), and
  four small tuning items (DEFERRED 22). 0.10.3. P8.1 and P8.9 ticked; CHECKPOINT 8 is next.
- CHECKPOINT 8 held: Scott accepted D50 to D52 and keeps the fix-up pass (D53). He runs the DB
  project's next part today (P9.1). Checked the DB project read-only: the Phase A run branch is
  28 commits ahead of main and not merged; its config (from 0.9.4) already pushes; its old deny
  rules block ssh, pve and qm; AUTOCLAUDE.md is the 0.9.4 copy; no watchdog is installed.

## 2026-10-02 (Code VM) - P9.1 run measured: effort, ultracode, where the time went

- Scott reported the DB project's second run (P9.1) finished: VM created, database deployed,
  alerts received, the Phase 8 fixes all worked. Measured read-only from C:\database's logs and
  transcripts: 36 steps in 12 features, 28 h 40 min (48 min per step; the steps were larger,
  real VM builds and deploys), 9 of 12 features passed first time, no pauses, no recoveries,
  0 workflows. Weekly usage about 14 points (about 0.5 per hour).
- Where the time went: builder model generation 25% (thinking alone about 8%), builder tool time
  52% (tests in all forms about 34% of the run), the gate 22% (its checks 92% of that; the
  checker models 5%). Gate rework (3 failed attempts, 8 fix-ups, 10 fix-up check passes) 170 min
  plus about 246 min of builder fixes; 4 of the 5 check failures were flaky or timing tests.
- Effort: the builder ran at xhigh (`--effort ultracode` set xhigh). Ultracode itself never took
  effect: its reminder is attached only to prompts a person types, so the builder made no
  workflow calls. The checkers (tester, security, decider) ran at high, not xhigh, most likely
  because they inherited the builder's CLAUDE_EFFORT ("ultracode"), which `claude -p` does not
  take as xhigh. In the rehearsal they ran at xhigh.
- Estimate: high instead of xhigh for the builder saves about 55 to 125 min of 28.7 h (3 to 7%);
  one extra failed attempt costs 35 to 80 min. Bigger levers: test time and fix-up passes that
  rerun the whole 10 to 20 min check suite.
- Scott keeps xhigh for the builder, chose his own default for the checkers and no ultracode in
  runs (D54): runHeadless drops an inherited CLAUDE_EFFORT; builder.effort "ultracode" launches at
  xhigh. Docs, the settings page and the plan skill say so. 0.10.4.
- Scott asked what high effort for everything would cost and save. Security reviews compared:
  first run (xhigh, per-step reviews) 17 reviews, 29 findings (1.7 each; 1 medium, 0 high),
  98 s average; second run (high, whole-feature reviews) 13 reviews, 10 findings (0.8 each; 1
  high, a real flaw it caught), 50 s average. Estimate for high everywhere: about 1 to 2.5 h of a
  28.7 h run. No change made; the choice stays D54.
- Scott asked for the effort to be settable on the settings page. Builder effort already was;
  added `checkers.effort` (one level for tester, bug bash, security review and decider, default
  xhigh, D55), passed as --effort; the plan skill asks it. 0.10.5.
- Updated this machine's install from 0.10.3 to 0.10.5 (launcher reports 0.10.5).
- Scott is making the repo public (D56). Scanned all 55 commits: no secrets, no IPs or domains;
  his Gmail address is on every commit (kept; new commits use the no-reply address). Install docs
  no longer mention an invitation or the GitHub CLI. No license for now.
- Scott asked for 1.0 now (D57): version 1.0.0, tag v1.0.0, CHANGELOG.md; P9.5 ticked, CHECKPOINT 9 held; P9.1's written review and P9.2 to P9.4 continue after 1.0.
- This machine updated from 0.10.5 to 1.0.0 from GitHub; the launcher reports 1.0.0.

## 2026-10-02 (Code VM) - Security and optimize sweeps planned (Phase 10)

- Scott asked for `autoclaude security` and `autoclaude optimize`. A 3-agent read-only research
  workflow (reuse seams, security techniques, optimization techniques; results in the session
  scratchpad, summarized in D58) and seven rounds of questions settled the design. Phase 10
  (P10.1 to P10.12, CHECKPOINT 10) is in PLAN.md; the plan lints at 75 steps in 11 phases.
- Phase 10 build workflow started (5 builders, integrator, adversarial review).
- Hotfix 1.0.1 on main: with git 2.55, the gate's commit failed in any project whose .gitignore
  ignores an existing secrets/ folder (an exclude pathspec for an ignored folder exits 1), so a
  run that generated a secret would pause as commit-failed. Staging is now add -A, then reset
  secrets/. Found by the Phase 10 integrator; reproduced, test added (fails without the fix).
  Full suite on main: 474 of 474.
