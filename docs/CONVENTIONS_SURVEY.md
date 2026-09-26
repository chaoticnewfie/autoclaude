# Conventions survey: what Scott's repos have in common

**Surveyed 2026-09-26** by reading `CLAUDE.md`, `PLAN.md`, `CONTINUE_HERE.md`, `docs/`,
`.gitattributes`, `.editorconfig`, CI workflows and memory notes in every `chaoticnewfie` repo:
`DB` (local clone at `C:\Database`), `Lists`, `Game`, `Splat`, `VTT`, `Asset-Manager`, `Crypto`,
`Tactical` (one binary, no docs). Purpose: decide what goes into this repo's `CLAUDE.md` and into
the project template that `autoclaude init` writes into every future project.

Scott picks from the numbered list in section 2. Until he does, nothing below is a rule.

---

## 1. What each repo keeps

| Repo | Rules file | Plan | Resume point | Decisions | Log | Gotchas | Other |
|---|---|---|---|---|---|---|---|
| DB | `CLAUDE.md` (rules only, status line, repo map, docs index) | `PLAN.md` (historical; code wins) | `CONTINUE_HERE.md` (rewritten every prompt) | `docs/DECISIONS.md` (dated, append-only, rejected alternatives) | session-end blocks in CONTINUE_HERE | "Known gotchas" numbered list | `docs/DEFERRED.md`, `docs/NEW_DEVICE.md`, `docs/REVIEW_FINDINGS.md`, Makefile, `secrets/` gitignored |
| Lists | `CLAUDE.md` (rules, definition of done, fixed stack, invariants) | `PLAN.md` (header status table, requested-features intake, phases, recommended next step) | `CONTINUE_HERE.md` (TL;DR, NEXT TASK, rewritten) | `docs/DECISIONS.md` | `docs/SESSION_LOG.md` (append-only) | "Facts worth not re-deriving" | CI docs gate, `npm run check`, `.editorconfig`, `docs/features/*.md`, OpenAPI freshness check |
| Game | `CLAUDE.md` (process rules + a very long decisions-and-why) | `docs/plan.md` | (in plan) | inline in CLAUDE.md | (in plan) | "Gotchas" | `docs/memory/*.md` (feedback notes with Why / How to apply), `ideas/` |
| Splat | `CLAUDE.md` (golden rule: keep PLAN.md alive; automate everything; multi-device) | `PLAN.md` (vision, locked decisions, phases, backlog, gotchas, changelog) | "Current status" in CLAUDE.md | "Decisions (locked)" table in PLAN.md | Changelog in PLAN.md | "Key facts & gotchas" | - |
| VTT | `CLAUDE.md` (stack, commands, container restart rules, key notes) | - | - | - | - | "Key notes" | `.claude/settings.local.json` with PostToolUse hooks (eslint --fix, container restarts) |
| Asset-Manager | `CLAUDE.md` (git workflow, DB, env, deploy, stack, patterns) | - | - | "Known patterns & decisions" | - | - | - |
| Crypto | - | `PLAN.md` (context, verified facts, decisions, architecture) | - | in PLAN.md | - | - | `.gitattributes` LF |

Every repo: no secrets committed, `.env.example` with placeholders, `.gitattributes` forcing LF
(CRLF only for `.ps1` / `.bat` / `.cmd`) in every repo that deploys to Linux.

---

## 2. Candidate rules (pick for CLAUDE.md and the template)

Numbered so Scott can answer "all except 7 and 12".

1. **Three files, three jobs.** `CLAUDE.md` = rules, constraints and standing decisions only.
   `PLAN.md` = what is being built and in what order. `CONTINUE_HERE.md` = where things are right
   now, rewritten (not appended) every prompt. On conflict `CLAUDE.md` wins. (DB, Lists, Game, Splat)
2. **Definition of done, every prompt.** Checks green with counts stated in the reply; docs updated
   in the same pass; committed and pushed; anything requested but not built is captured. (Lists)
3. **Everything lives in the project folder and in git.** No `~/.claude/plans`, no machine-local
   notes. Memory notes, ideas and plans are tracked files. (Game, Splat, DB, user-level rule)
4. **Commit and push after every change.** GitHub is never behind the working tree or the server.
   Conventional prefixes: `feat(x):`, `fix(x):`, `docs:`, `chore:`. (Lists, Splat, Asset-Manager, Game)
5. **Decision log.** `docs/DECISIONS.md`, dated, append-only, each entry has the choice, the why
   and what was rejected. A reversal is a new entry that supersedes, never an edit. (DB, Lists, Game, Splat)
6. **Session log.** One append-only entry per session: date, machine, what was done, commits,
   deployed SHA. (Lists `docs/SESSION_LOG.md`; Splat changelog; DB session-end blocks)
7. **Requested-features intake table** in `PLAN.md`: date, Scott's words, where it was slotted,
   status. Nothing dropped, nothing built early unless he says so. (Lists)
8. **Facts worth not re-deriving.** A gotchas section; anything that cost more than five minutes
   to work out goes in, with the fix. (Lists, Game, DB, Splat, VTT)
9. **Deferred list.** `docs/DEFERRED.md`: what, why it waits, the trigger, the concrete path, and
   why adding it later costs no rework. (DB; Splat and Lists have a lighter backlog section)
10. **Cold-start doc.** `docs/NEW_DEVICE.md`: prerequisites, what is deliberately not in the repo
    (keys, secrets), verified facts, the one local-testing trap. (DB, Splat, Lists)
11. **No secrets in committed files.** Placeholders in `.env.example`; real values in gitignored
    `.env` or `secrets/`, or env vars. (all repos)
12. **Line endings and editor settings.** `.gitattributes` with `* text=auto eol=lf`, CRLF only for
    `.ps1` / `.bat` / `.cmd`, binaries marked; `.editorconfig` with 2-space indent, utf-8, LF, final
    newline. (DB, Game, Splat, Crypto, Lists)
13. **Automate everything: run it, do not ask.** Only hand over a step that needs a browser, a
    physical device or a decision only Scott can make. Locate binaries directly instead of asking
    to fix PATH. Start long-running things in the background. (Splat)
14. **Trust the docs; do not re-survey.** Session start = read `CONTINUE_HERE.md`, then
    `CLAUDE.md`, then the relevant part of `PLAN.md`. Spot-check one claim before a risky change.
    (Lists, DB)
15. **Keep agent fan-out small.** Do the work directly; big fan-out only when something major is
    at risk, never for a single feature. (Game memory note, user-level rule)
16. **Verification gate and CI.** One command (`npm run check` = lint + typecheck + test) before
    every commit; CI runs it plus a production-only `npm audit`, and fails any PR that touches code
    without touching `PLAN.md`, `CONTINUE_HERE.md` or `docs/`. (Lists)
17. **Status in one line** at the top of `CLAUDE.md`, plus a docs index table ("read it when").
    (DB, Splat)
18. **Backup before any deploy that carries a migration**, and report the backup filename. (Game, Lists, DB)
19. **Shell hygiene on Windows.** Use the Bash tool for git commits with multi-line messages; keep
    heredoc content ASCII-only and apostrophe-free (cp1252 mangles the rest, and a quoted heredoc
    still failed on an apostrophe here on 2026-09-26); write prose files with the Write tool.
    (VTT, Lists)
20. **Fixed stack stated in CLAUDE.md**, "do not deviate without being asked". (Lists, VTT, Asset-Manager)

## 3. Things that vary between repos (not rules)

- Where decisions live: a separate `docs/DECISIONS.md` (DB, Lists) versus inline in `CLAUDE.md`
  (Game, 123 KB) versus a table in `PLAN.md` (Splat). The separate file scales; Game shows what
  happens without it.
- Plan format: only the autoclaude plan uses step IDs and `Accept:` lines. Lists uses plain
  checkboxes under phase headings; Game and Splat use prose phases. `autoclaude init` on an existing
  repo has to cope with all three, or the plan skill has to convert.
- Lint tool: Biome (Lists), ESLint (VTT), none (Splat). Test runner: Vitest (Lists), custom
  `verify:*` scripts (Game), pytest (Crypto).
- Hooks: VTT is the only repo with project hooks (`PostToolUse` lint-fix and container restarts).

## 4. Facts about this machine that matter for the build

- `Code` VM (Windows Server 2025). Git 2.55 at `/mingw64/bin/git` (Git Bash), `gh` 2.x at
  `C:\Program Files\GitHub CLI\gh.exe` (logged in as chaoticnewfie), Node 24.19 and npm 11.17 at
  `C:\Program Files\nodejs\` (not on PowerShell PATH; call by full path or prepend for the session).
- The only `claude` binary is the VS Code extension's bundled
  `resources/native-binary/claude.exe` (Claude Code 2.1.283). No standalone CLI install, no tmux,
  WSL not checked yet.
- `~/.claude/settings.json` already has Stop / PermissionRequest / PreToolUse hooks from the
  `ai-agent-sound-notification` VS Code extension. They call `node` by bare name.
- GitHub `chaoticnewfie/autoclaude` exists, private, and is empty.
