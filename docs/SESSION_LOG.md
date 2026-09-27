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
