# CONTINUE_HERE.md - resume point for {{PROJECT_NAME}}

Where things are right now. Rewritten, not appended, at the end of every prompt and before every
`autoclaude ready`. Read this first, then `CLAUDE.md`, then the current phase of `PLAN.md`.
History lives in `docs/SESSION_LOG.md` and `PROGRESS.md`, not here.

## Last updated

{{DATE}}, by `autoclaude init`. Nothing has been planned or built yet.

## Where things are

- The doc set is in place: `CLAUDE.md`, `PLAN.md`, `PROGRESS.md`, this file and `docs/`. Every
  log is empty.
- `PLAN.md` is still the template: placeholders and a "Phase 1: TODO" heading with no steps.
  `autoclaude lint-plan` fails and a run cannot start. That is intended: a run never starts on
  placeholders.
- `CLAUDE.md` still has TODO lines under "Tech stack", "Commands" and the backup rule.
- `autoclaude.config.json` holds what `init` guessed for `checks` and `devServer`.
- Nothing new is committed yet. Whatever the project had before `init` ran is untouched; `init`
  never overwrites an existing file.

## The exact next step

1. Run `/autoclaude:plan` in a Claude Code session opened in this folder. With the owner it
   settles the decisions, fills the TODO lines in `CLAUDE.md`, sets and runs the checks, the dev
   server and the guard rules, writes the plan, commits everything and rewrites this file.
2. Do what the plan's "Before the run" section lists.
3. Start the run with `autoclaude run` from a new terminal opened in this folder. Never
   `autoclaude start`: the run window calls that itself.

## Notes

- If this file still says "by `autoclaude init`" and the project has clearly moved on, the file
  was not rewritten after a prompt. Fix that first: it is a rule, not a nicety.
- A run never guesses at a placeholder; `/autoclaude:plan` fills them in with the owner.
- Add `.env.example` with placeholders before the first step that needs configuration. Real
  values stay in `.env`, which is gitignored.
