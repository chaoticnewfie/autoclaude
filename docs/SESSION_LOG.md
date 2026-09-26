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
