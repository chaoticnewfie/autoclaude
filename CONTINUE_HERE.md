# CONTINUE_HERE.md

**Last updated: 2026-09-28.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 8 built and pushed as 0.10.0 (commit f78f434); the practice run (P8.9) is next.** All of
D47 to D50 is in the code: verification once per feature, a fresh builder per feature, pushes per
feature, `autoclaude decide`, HANDOFF.md, the Docker footprint, per-event alerts, layered
settings and the settings page, the command-aware tool guard, and the planning skill that asks in
rounds. Full suite: 390 of 391 on the last run (the one failure was the PowerShell file-lock test
starting too slowly under load; it now reports a skip then). A four-lens verification workflow
(gate state machine, Accept-line audit, safety, Windows live-readiness) was checking the
committed code when this was written; its confirmed findings get fixed before the practice run.
P8.1 to P8.8 are not ticked yet: tick them with that workflow's Accept-line evidence and the
GitHub install check (`test/live/gh-install.live.mjs`).

## The exact next step

P8.9, done by Claude: update this machine's install in place (`claude plugin marketplace update
autoclaude`, `claude plugin update autoclaude@autoclaude`), `node spikes/lib/prep-practice.mjs`,
`autoclaude init` in `spikes/out/todo-live`, then plan it headless with
`node spikes/lib/plan-turn.mjs new|next <message file>`, answering each round as the owner from
`spikes/out/practice/owner-answers.md` (gitignored). Then `autoclaude run` from PowerShell with
node and git on PATH, change a setting through the settings page during the run, create a stray
Docker volume to prove the cleanup, and check pushes in `spikes/out/practice-remote.git`,
HANDOFF.md and the alerts. Then CHECKPOINT 8 with Scott.

Release numbering: 0.10.0 now (updates in place from 0.9.4); 1.0 only after the DB project's next
part and a review (Phase 9).

## Notes for whoever continues

- `INSTRUCTIONS.md` (repo root) is the plain guide for people; `docs/USAGE.md` is the full
  reference. When behavior changes, update both, then copy INSTRUCTIONS.md over
  `plugins/autoclaude/project-template/AUTOCLAUDE.md` (a test checks they match): `init` puts
  that copy into every project as `AUTOCLAUDE.md` (D46). Models default to Opus, never Haiku (D44).
- Docker on this VM has about 36 volumes from before, most of them leaked by the DB rehearsal.
  The practice run's cleanup must leave every one of them in place.
- To test unpushed plugin changes without installing on this machine, run
  `node test/live/gh-install.live.mjs C:/AutoClaude` (throwaway config). Do not re-add the clone
  as a marketplace while the GitHub one is installed: both are named `autoclaude`.
- The VS Code tool shells lack node on PATH; the Bash tool collapses doubled backslashes, so write
  code with escapes through the Edit tool.
- Bump the plugin version with every plugin change (CLAUDE.md rule 14).

## Decisions Scott still owns

- Whether the project template ships the fuller docs set as stubs (default: core files only).
- The build agents' choices listed in D50 (for example: no "Phase N verified" alert for the last
  feature, HANDOFF.md committed and pushed, a plain push allowed when `git.push` is true), for
  review at CHECKPOINT 8.
