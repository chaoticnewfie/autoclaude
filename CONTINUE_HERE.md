# CONTINUE_HERE.md

**Last updated: 2026-09-26 (end of the Phase 0 session).** Rewrite this file at the end of every prompt.

## Where things are

**Phase 0 is nearly done. No plugin code exists yet.** Findings and evidence: `VERIFY.md`.

| Step | State |
|---|---|
| P0.1 environment, P0.2 Stop-hook loop, P0.4 nested headless, P0.5 browser tester, P0.10 plugin hooks | Done and ticked in `PLAN.md` |
| P0.7 usage-limit behaviour | Done from the docs; the `/config` look is Scott's |
| P0.3 statusline, P0.6 permissions, P0.8 supervisor | Blocked on one thing: the native CLI has never completed its first interactive run on this VM |
| P0.9 reconcile | `VERIFY.md` written; `PLAN.md` and `docs/DECISIONS.md` (D26 to D31) updated |

Installed on this VM today: Claude Code native 2.1.283 (`%USERPROFILE%\.local\bin`, on the user
PATH), Playwright Chromium. Nothing else changed on the machine. `~/.claude.json` was not touched.

## What Scott needs to do (five minutes)

1. Open a terminal (Windows Terminal or PowerShell, a fresh one so PATH is current), then:
   `cd C:\AutoClaude` and `claude`.
2. Pick a theme. Accept the workspace trust dialog for `C:\AutoClaude`.
3. Run `/config` and confirm "Continue automatically at usage limit" is on (it should be, by default).
4. `/exit`.
5. Say so in chat. The interactive spike (`spikes/p08-supervisor`) then reruns unchanged and closes
   P0.3, P0.6 and P0.8. While that window is open, an RDP disconnect and reconnect would close the
   last P0.8 line too.

## The exact next step (after the above)

```
cd /c/AutoClaude/spikes/p08-supervisor && rm -rf out
node ../lib/open-window.mjs ac-spike "C:\AutoClaude\spikes\p08-supervisor" "C:\Program Files\nodejs\node.exe" "C:\AutoClaude\spikes\p08-supervisor\supervise.mjs" 80000
```

Then read `out/supervisor.log`, `out/hooks.jsonl` (SessionStart, Notification `idle_prompt`,
PermissionRequest deny, PreToolUse deny, Stop, StopFailure), `out/statusline.jsonl`
(`rate_limits`), and the three transcripts under `~/.claude/projects/C--AutoClaude-spikes-p08-supervisor/`.
Update `VERIFY.md` rows P0.3, P0.6, P0.8, tick them in `PLAN.md`, then **CHECKPOINT 0** with Scott.

## Decisions Scott still owns

- License and public versus private (`docs/DECISIONS.md` D20).
- Whether the project template ships the fuller docs set as stubs (default: core files only).

## Facts that save time

In `CLAUDE.md`, "Facts worth not re-deriving": PATH quirks, the Git Bash `/D` mangling, the
`start` title rule, `claude config` not being a subcommand, `--bare` breaking auth, and where usage
data lives. Spike helpers: `spikes/lib/claude-clean.mjs` (run the native CLI with `CLAUDE*` env
stripped), `spikes/lib/open-window.mjs` (detached console window), `spikes/lib/summarize.js`
(summarize a `-p` JSON result and its transcript), `spikes/lib`-style outputs go under `out/` and
are gitignored.
