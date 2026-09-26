# CONTINUE_HERE.md

**Last updated: 2026-09-26.** Rewrite this file at the end of every prompt.

## Where things are

Nothing is built. The repo holds the approved build plan and a survey of Scott's conventions.

- `PLAN.md`: the build plan drafted with Claude on the phone (2026-09-24). Read section 0 first.
- `docs/CONVENTIONS_SURVEY.md`: what every `chaoticnewfie` repo does the same way, as a numbered
  list Scott picks from for this repo's `CLAUDE.md` and for the project template.
- Remote: `chaoticnewfie/autoclaude` (private). Local: `C:\AutoClaude` on the `Code` VM.

## Waiting on Scott (asked 2026-09-26)

1. Confirm the one-paragraph description of the project matches his vision.
2. Pick which numbered conventions from `docs/CONVENTIONS_SURVEY.md` section 2 go into
   `CLAUDE.md` and the template.
3. Decide where unattended runs live: WSL2 on the `Code` VM, or the Debian LXC the plan assumes.
4. Naming: keep `autopilot` from the plan, or rename plugin, CLI and skills to `autoclaude`.
5. Shape of the pause-for-review feature (proposal is in the same message).

## New requirements since the plan was drafted

- The repo will be used on other devices and shared with other people through GitHub. No personal
  paths, IPs or homelab facts inside the plugin or its templates; per-machine values go in plugin
  userConfig; docs written for a stranger.
- Optional pause: Scott can stop an unattended run to review progress, leave notes, edit the plan,
  and resume with those notes injected. Off by default.

## The exact next step

Once the answers arrive: write `CLAUDE.md` from the chosen conventions, fold the new requirements
and any renames into `PLAN.md` (log each change in `docs/DECISIONS.md`), then start Phase 0.
