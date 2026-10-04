# CONTINUE_HERE.md

**Last updated: 2026-10-04.** Rewrite this file at the end of every prompt.

## Where things are

**Phase 9 under way: P9.1's run is done, its full review is not.** Scott ran the DB project's next
part on 0.10.3: 36 steps in 12 features, 28 h 40 min, VM 105 created and the stack deployed,
alerts received, no pauses or recoveries. It was measured read-only (docs/SESSION_LOG.md,
2026-10-02): builder model time 25% of the run (thinking about 8%), builder tool time 52% (tests
about 34%), gate 22% (checks 92% of it). From that, D54 (0.10.4) and D55 (0.10.5): the builder keeps xhigh, `builder.effort: "ultracode"`
launches at xhigh (ultracode stays off in runs), and a new `checkers.effort` setting (default
xhigh, on the settings page) sets the tester, bug bash, security review and decider together.

**1.0.0 is released** (tag v1.0.0, CHANGELOG.md, D57) and the repository is public from
2026-10-02 (D56), with no license yet. This machine runs 1.0.0 (updated from GitHub).

## The exact next step

CHECKPOINT 10 with Scott (pinged on Discord 2026-10-04). Phase 10 is built, reviewed and proven
live (P10.12 ticked); this machine is back on GitHub 1.0.1. Show him: the security report and
HANDOFF-SECURITY.md, the optimize report and OPTIMIZE_PLAN.md (spikes/out/todo-live/.autoclaude/
sweeps/), the alerts, the times. Ask: (1) rerun a failed check once before counting it
(the planted flaky test paused the fix run); (2) fix the small proof findings before 1.1.0
(same-file findings not merged when one is file-level: OPT-007/013, OPT-019/023; scanner
findings without titles; raw keys in the baseline table); (3) D59 and the D61 addendum;
(4) P10.13 is built but its automatic phase split was not yet seen in a live planning
session. Then merge phase10-sweeps into main (expect conflicts with the 1.0.1 hotfix in git.js,
gate.js, CHANGELOG.md and the version files) and release 1.1.0.

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
- Whether to merge the DB project's Phase A run branch before planning the next part.
- DEFERRED 22 (fix-up pass cost and small items): deferred until a real run measures them.
- Rerun a failed check once before counting it as an attempt (flaky tests paused the P10.12
  fix run; 4 of 5 check failures in the DB run were flaky). Ask at CHECKPOINT 10.
