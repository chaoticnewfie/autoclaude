# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 7: P7.1 (plan skill) and P7.2 (docs) are done; P7.3, Scott's blind rehearsal, is next.**
Phases 0 to 6 done. Version 0.9.3 is on GitHub (`main`), 266 tests pass, remote in sync.

This round (see `docs/SESSION_LOG.md` and D41 to D45):
- The repo stays private, shared by invitation, no license; the rehearsal runs all day (D41).
- Everything the plugin needs ships inside `plugins/autoclaude/`, and a launcher keeps the
  command and the watchdog working across plugin updates (D42).
- Six reviewers and four fixers closed real bugs before the rehearsal: the guard now covers the
  PowerShell tool and paths with spaces; the builder is one known session (`--session-id`,
  `--resume <id>`, `AUTOCLAUDE_BUILDER=1`) and other sessions in the project are left alone;
  `pause --now` ends the session; finished plans continue with `autoclaude run`; new commands
  `run --check`, `checks`, `guard-test`, `uninstall` (D43).
- Verified live: `test/live/gh-install.live.mjs` 9/9 from GitHub; a real run on the fixture
  (session id, builder identity, pause --now, resume by id, 3/3 steps); an onboarding rehearsal
  by link on a scratch project that reached the preflight on its own.

**This machine has no AutoClaude installed, on purpose**: plugin, marketplace, command, status
line bridge and watchdog were removed with `autoclaude uninstall` and `claude plugin uninstall`.
Kept: the Discord setting in `~/.claude/autoclaude/notify.json`. The registry is empty.

## Blind rehearsal rule (D37)

**Do not open or inspect Scott's DB project, and do not tailor AutoClaude to it.** Scott gives a
Claude session in that project only the repo URL; that Claude works from `README.md` and
`docs/USAGE.md`.

## The exact next step

**P7.3, done by Scott:**
1. Open Claude Code in the DB project and say: "Add AutoClaude to this project:
   https://github.com/chaoticnewfie/autoclaude". Approve its installs; when it says to, exit and
   start a new session there, and run `/autoclaude:init`, then `/autoclaude:plan`.
2. In the interview, when asked what the run must never touch, name everything this VM can
   reach: the Proxmox host (this account has a root SSH key to it), other VMs, GitHub pushes.
3. Do the plan's "Before the run" list (trust, sleep off, watchdog), then from a new terminal in
   the project: `autoclaude run --check`, then `autoclaude run`.
4. Report anything odd from the onboarding; every guess the other Claude had to make becomes a
   docs fix here (generic only, D37), with a version bump and push. Scott updates with
   `claude plugin marketplace update autoclaude` and `claude plugin update autoclaude@autoclaude`
   while the run is paused.

Then CHECKPOINT 7 (review of the run with Scott) and P7.4 (version 1.0.0, tag, CHANGELOG).

## Notes for whoever continues

- `INSTRUCTIONS.md` (repo root) is the plain guide for people; `docs/USAGE.md` is the full
  reference. When behavior changes, update both.

- To test unpushed plugin changes without installing on this machine, run
  `node test/live/gh-install.live.mjs C:/AutoClaude` (throwaway config). Do not re-add the clone
  as a marketplace while the GitHub one is installed: both are named `autoclaude`.
- `spikes/lib/prep-live.mjs` rebuilds `spikes/out/todo-live` (trusted) for a short real run; start
  it from PowerShell with node and git on PATH (see CLAUDE.md facts).
- The VS Code tool shells lack node on PATH; the Bash tool collapses doubled backslashes, so write
  code with escapes through the Edit tool.
- Bump the plugin version with every plugin change (CLAUDE.md rule 14).

## Decisions Scott still owns

- Whether the project template ships the fuller docs set as stubs (default: core files only).
