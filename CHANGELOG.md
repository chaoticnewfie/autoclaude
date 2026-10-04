# Changelog

## 1.1.0 (2026-10-04)

- **Security sweep** (`/autoclaude:security`, `autoclaude security`): a whole-project review by
  area, secrets in the files and the git history, package advisories, config and infrastructure,
  and live attacks on the running app through an allow-list proxy; every finding checked by
  independent sessions; a gitignored report with suggested fixes.
- **Optimize sweep** (`/autoclaude:optimize`, `autoclaude optimize`): unused code and packages,
  duplicates, measured performance, poorly built features, slow and flaky tests; tiered fixes,
  with tests that pin current behaviour before any rebuild.
- **Report, plan or fix right away**, and `autoclaude run --plan <file>` to run a generated fix plan
  on its own branch while the project's own plan and state wait.
- `autoclaude sweep-status`, `sweep-stop` and `sweep-run`; accepted findings remembered in
  `autoclaude.accepted.json`.
- **Phases that fit their verification**: the gate spreads one feature's verification over
  turns when time is short; check times are recorded; `lint-plan`, `run --check` and planning
  estimate each phase and planning splits one that does not fit; `autoclaude verify-per-step
  <phase>` for a plan that keeps running out of time.
- The security review runs alongside the browser checks once the checks pass (`checkers.parallel`).
- A failed check runs once more before it counts; one that then passes is reported as flaky.
- Security findings from normal runs go to the gitignored `docs/private/SECURITY-FINDINGS.md`.
- Playwright MCP pinned to a tested version, and its arbitrary-code tool denied to every browser
  checker.
## 1.0.1 (2026-10-03)

- Fixed: in a project whose `.gitignore` ignores `secrets/` and where that folder exists (a run
  generated a secret there), every gate commit failed and the run paused as `commit-failed`. git
  2.55 rejects an exclude pathspec for an ignored folder; the gate now stages everything and then
  unstages `secrets/`.

## 1.0.0 (2026-10-02)

The first stable release, and the repository is public. Everything below has been proven on two
all-day unattended runs of a real project: 28 steps in 18 hours, then 36 steps in 28.7 hours that
created a virtual machine and deployed a database stack onto it.

- Install, init and every command from the public repository; no invitation or GitHub sign-in.

## 0.10.x (2026-09-28 to 2026-10-02)

- **0.10.5** One `checkers.effort` setting for the browser tester, bug bash, security review and
  decider, `xhigh` by default, on the settings page.
- **0.10.4** The checkers no longer inherit the builder's effort by accident; `builder.effort:
  "ultracode"` runs at `xhigh`, because a run never uses ultracode's multi-agent workflows.
- **0.10.3** A browser checker with no working browser counts as "could not run", never as a
  failed attempt; MCP servers get 120 s to start.
- **0.10.1, 0.10.2** Fixes from two verification rounds: Docker cleanup removes only what is
  provably the project's, on the same engine; a verification cut off by the hook's time limit is
  counted and paused, not looped; resumable commits and hand-back; a stricter tool guard
  (destructive pushes, settings files, inline code, literal delete targets).
- **0.10.0** Verification once per feature instead of per step; a fresh builder session per
  feature; the branch and a tag pushed after each verified feature; planning that asks the scope
  and never assumes; pre-approved permissions for what the plan allows; `autoclaude decide`;
  `HANDOFF.md` at the end; Docker cleanup; alerts per event; layered settings and the settings
  page (`autoclaude config`).

## 0.9.x (2026-09-27)

- Installs from the GitHub marketplace; `INSTRUCTIONS.md` copied into each project as
  `AUTOCLAUDE.md`; the `/autoclaude:plan` skill; README and the full guide; Opus as the main
  model, Sonnet the floor, never Haiku.

## Before 0.9 (2026-09-26 to 2026-09-27)

- The gate (checks, headless browser tester, bug bash, security review), the supervisor and
  scheduled watchdog, Discord and ntfy alerts, pause, notes, resume and blocked questions,
  weekly usage limits, all on Windows first.
