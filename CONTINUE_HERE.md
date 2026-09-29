# CONTINUE_HERE.md

**Last updated: 2026-09-29.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 8 is done (P8.1 to P8.9 ticked); CHECKPOINT 8 with Scott is next.** Version 0.10.3 is on
GitHub. This machine runs the plugin installed from GitHub (updated in place from 0.9.4 to 0.10.2
for the practice run; `claude plugin marketplace update autoclaude` then
`claude plugin update autoclaude@autoclaude` brings it to 0.10.3).

The practice run (P8.9) on `spikes/out/todo-live`: planning 13 turns, about 40 min, 11 question
rounds; the run did 7 steps in 2 features in 64 min (rehearsal: 39 min per step; practice: 9).
Evidence is in PLAN.md P8.9, the project's HANDOFF.md, `.autoclaude/logs/` and
`spikes/out/practice/` (planning turns, timeline, Docker before list). One bug it found (a
Playwright connect timeout counted as a failed attempt) is fixed in 0.10.3 (D52).

## The exact next step

CHECKPOINT 8: show Scott the practice run's HANDOFF.md (`spikes/out/todo-live/HANDOFF.md`), the
alerts on Discord, the settings page (`autoclaude config` in that folder), and the time per
feature against the rehearsal. Ask him about DEFERRED 22 (the fix-up pass cost 16.5 of 64 min;
a `fixup.minSeverity` setting?) and the D50 and D51 choices. Then Phase 9: P9.1 is Scott's run of
the DB project's next part on 0.10.x.

## Notes for whoever continues

- `INSTRUCTIONS.md` (repo root) is the plain guide for people; `docs/USAGE.md` is the full
  reference. When behavior changes, update both, then copy INSTRUCTIONS.md over
  `plugins/autoclaude/project-template/AUTOCLAUDE.md` (a test checks they match).
- The practice project: `node spikes/lib/prep-practice.mjs` rebuilds it (with `claudeMdExcludes`
  so this repo's CLAUDE.md stays out); `spikes/lib/plan-turn.mjs` drives planning headless;
  `spikes/lib/watch-run.mjs` logs a run's state changes; `spikes/lib/config-live.mjs` drives the
  settings page. The `todo-backups` container from the practice run is still running (port 8091);
  `docker compose down` in `spikes/out/todo-live` removes it.
- Docker Desktop here answers `docker ps -a` in about 48 s, so `autoclaude start` takes about
  2.5 minutes recording the footprint.
- The VS Code tool shells lack node on PATH; the Bash tool collapses doubled backslashes, so write
  code with escapes through the Edit tool. Run one full suite at a time.
- Bump the plugin version with every plugin change (CLAUDE.md rule 14).

## Decisions Scott still owns

- Whether the project template ships the fuller docs set as stubs (default: core files only).
- The build and verification choices in D50 to D52, for review at CHECKPOINT 8.
- DEFERRED 22: limit or switch off the fix-up pass; the other small practice-run items.
