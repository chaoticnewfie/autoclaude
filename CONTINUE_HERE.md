# CONTINUE_HERE.md

**Last updated: 2026-10-09.** Rewrite this file at the end of every prompt.

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

1.1.1 is released (2026-10-04; tags v1.1.0 and v1.1.1; Phase 10: security and optimize sweeps, phases that
fit their verification, flaky-check reruns; D58 to D62), proven live on practice apps and
installed on this machine from GitHub. Next: P9.1's written review of the DB project's second run,
then P9.2 to P9.4. Backlog from the proof: DEFERRED 23 to 25. Scott's idea of running sweeps in
pieces on spare weekly usage is designed in DEFERRED 26, not built. His idea of Gemini (his
Google AI Pro plan) as an optional second provider is designed in DEFERRED 8, not built: the
Antigravity CLI `agy` (Gemini CLI no longer serves AI Pro) for sweep verifiers and reviewers
first, plus images (Nano Banana). Blocked first by Antigravity's terms, which forbid third-party
tools using the login (account risk); the safe route is a billed AI Studio API key.

**Proposed, waiting for Scott's go: DEFERRED 27.** Verification at the end of a phase "only has
900 seconds": that is a check's own `timeoutSec`, and a timeout there counts as the builder's
attempt (the DB run's S11.4). The plan there: A0 wording, A1 a timed-out check gets a raised
limit and the next stop instead of an attempt, A2 estimates see timeouts, A3 checkers that hit
their own limit, A4 a `usage-limit` pause, B1 to B3 automatic recovery of two pause kinds in
the supervisor (plain Node, no model) and alerts that are silent today.

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
- DEFERRED 22 (fix-up pass cost and small items): deferred until a real run measures them.
- DEFERRED 8 (Gemini as a second provider): AI Pro login (account risk) or a billed API key;
  then when to spike it, which roles first, which Gemini model, whether a Gemini vote alone can
  reject a finding.
- DEFERRED 27: whether to build it, where he saw the 900 s (the DB run's case is on this
  machine; others may be on his desktop), and the open decisions listed there with defaults.
