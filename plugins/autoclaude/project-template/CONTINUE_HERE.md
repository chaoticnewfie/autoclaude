# CONTINUE_HERE.md - resume point for {{PROJECT_NAME}}

Where things are right now. Rewritten, not appended, at the end of every prompt and before every
`autoclaude ready`. Read this first, then `CLAUDE.md`, then the current phase of `PLAN.md`.
History lives in `docs/SESSION_LOG.md` and `PROGRESS.md`, not here.

## Last updated

{{DATE}}, by `autoclaude init`. Nothing has been built yet.

## Where things are

- The doc set is in place: `CLAUDE.md`, `PLAN.md`, `PROGRESS.md`, this file and `docs/`. Every
  log is empty.
- `PLAN.md` has a "Phase 1: TODO" heading and no steps. `autoclaude lint-plan` reports no steps
  and `autoclaude start` refuses to run. That is intended: a run cannot start on placeholders.
- `CLAUDE.md` still has TODO lines under "Tech stack", "Commands" and rule 12 (the backup
  command).
- `autoclaude.config.json` holds whatever `init` detected. Its commands have to match the
  Commands section of `CLAUDE.md` once that is filled in.
- Nothing new is committed yet. Whatever the project had before `init` ran is untouched; `init`
  never overwrites an existing file.

## The exact next step

1. Fill in the TODO lines in `CLAUDE.md` (Tech stack, Commands, the backup rule) and check the
   commands in `autoclaude.config.json` against them.
2. Run `/autoclaude:plan`. It interviews the owner, settles the decisions up front, writes the
   goal, the constraints and the "When something is unclear" defaults into `PLAN.md`, and fills
   Phase 1 with steps in the step format. In a project that already had a plan, it reviews that
   plan first and rewrites it into the step format.
3. Run `autoclaude lint-plan` until it passes, commit, push, then `autoclaude start`.

## Notes

- If this file still says "by `autoclaude init`" and the project has clearly moved on, the file
  was not rewritten after a prompt. Fix that first: it is a rule, not a nicety.
- TODO lines are for the owner. A run never guesses at them.
- Add `.env.example` with placeholders before the first step that needs configuration. Real
  values stay in `.env`, which is gitignored.
