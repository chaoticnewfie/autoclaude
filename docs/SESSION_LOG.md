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
