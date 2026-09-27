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
