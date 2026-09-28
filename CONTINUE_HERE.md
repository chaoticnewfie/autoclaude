# CONTINUE_HERE.md

**Last updated: 2026-09-27.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 7 done (CHECKPOINT 7 held 2026-09-28); Phase 8 planned and being built.** The DB
rehearsal ran 28 of 28 steps unattended; its review and eight rounds of questions with Scott
became Phase 8 in PLAN.md (D49). Version 0.9.4 is on GitHub; Phase 8 ends at 0.10.0. The DB
project may now be read (Scott lifted the blind rule for the review); its run branch is not merged.

## The exact next step

Build PLAN.md P8.1 to P8.8, then P8.9: a practice run on the fixture that Claude does itself,
headless where possible (Scott: "you do it all yourself unless you need me"). Then CHECKPOINT 8.
Release numbering: 0.10.0 after the practice run (updates in place from 0.9.4), 1.0 only after
the DB project's next part and a review (Phase 9).

## Notes for whoever continues

- `INSTRUCTIONS.md` (repo root) is the plain guide for people; `docs/USAGE.md` is the full
  reference. When behavior changes, update both, then copy INSTRUCTIONS.md over
  `plugins/autoclaude/project-template/AUTOCLAUDE.md` (a test checks they match): `init` puts
  that copy into every project as `AUTOCLAUDE.md` (D46). Models default to Opus, never Haiku (D44).

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
