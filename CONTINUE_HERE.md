# CONTINUE_HERE.md

**Last updated: 2026-09-26.** Rewrite this file at the end of every prompt.

## Where things are

**Docs only. No code, nothing installed.** The plan is approved and revised; Phase 0 has not started.

- `PLAN.md`: the plan, revised 2026-09-26 for pure Windows (a Node supervisor instead of tmux and
  systemd, D18), pause for review (section 4.10, D19), shareability (D20) and one `init` for new and
  existing projects (D23). Read section 0, then Phase 0.
- `CLAUDE.md`: the rules for this repo, built from Scott's conventions across his repos
  (`docs/CONVENTIONS_SURVEY.md`, all except 10, with 15 reworded).
- `docs/DECISIONS.md`: D17 to D25, made 2026-09-26. `docs/DEFERRED.md`: ten later ideas with triggers.
- Remote `chaoticnewfie/autoclaude` (private), branch `main`, in sync with `C:\AutoClaude`.

## What Scott has decided (2026-09-26)

- Vision confirmed as described in the chat. Pause feature as proposed in D19.
- Pure Windows: Windows Server 2025 (the `Code` VM) and Windows 11, no WSL. Linux and macOS keep
  working through the same code.
- Name: `autoclaude` everywhere (D17).
- Agents: reasonable numbers are fine, stop them when done (`CLAUDE.md` rule 10). His global
  `~/.claude/CLAUDE.md` was corrected to say the same.

## Still open (Scott to decide, not blocking)

- License (MIT suggested) and public versus private. `docs/DECISIONS.md` D20.
- Whether `project-template/` ships the fuller docs set (ARCHITECTURE, DATA_MODEL, API, DEPLOY) as
  empty stubs. Default: core files only, and `init` offers the rest.

## The exact next step

Phase 0 of `PLAN.md`. Start with P0.1 (record the environment in `VERIFY.md`), which needs the
native Claude Code install on this VM (`irm https://claude.ai/install.ps1 | iex`, then `claude`
to log in). Then P0.2 to P0.10, each as a throwaway script under `spikes/`, results in `VERIFY.md`.
Stop at CHECKPOINT 0 and walk Scott through `VERIFY.md` and any plan changes.

Known machine facts that save time are in `CLAUDE.md`, "Facts worth not re-deriving".
