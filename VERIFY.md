# VERIFY.md - Phase 0 findings

**Machine:** Scott's `Code` VM (Windows Server 2025). **Date:** 2026-09-26. **Claude Code:** 2.1.283 native.
Every Phase 0 step gets a row: Pass, Changed (the plan was updated), Blocked (needs something first), or
Partial. Spike code lives under `spikes/`; run outputs are gitignored, so the evidence is quoted here.

| Step | Result | One line |
|---|---|---|
| P0.1 Environment | Pass | Recorded below. Native CLI installed and on the user PATH. |
| P0.2 Stop-hook continue loop | Pass | 3 and 10 blocks honored with tool use between them; the 8-block cap applies only without tool use; a hook that slept 300 s under a 1200 s timeout was not killed. |
| P0.3 Statusline bridge | Pass | A project-settings status line ran in the interactive session; `rate_limits.five_hour` and `seven_day` appeared 4 s after startup, right after the first API response, and updated during the run. |
| P0.4 Nested headless run from a hook | Changed | Works with `--settings '{"disableAllHooks":true}'`, inherited env and all; `--bare` fails auth and is rejected. |
| P0.5 Headless browser testing | Changed | Works. On Windows the MCP server must be launched as `cmd /c npx ...`; `npx playwright install chromium` needs no `--with-deps`. |
| P0.6 Unattended permission behaviour | Pass | PermissionRequest deny (a `mkdir` in manual mode) and PreToolUse deny on `AskUserQuestion` both reached Claude as the tool result with the guidance text; no prompt appeared; Claude carried on and reported. |
| P0.7 Usage-limit behaviour | Pass (docs) | Documented below. The `/config` visual check is Scott's during the one-time interactive run. |
| P0.8 Supervisor | Pass, one line for Scott | Detached window, spawn, `taskkill /T`, relaunch with `--continue` and a new prompt (submitted and answered in the same session), `idle_prompt` 61 s after each stop, no orphans. The RDP disconnect and reconnect check is Scott's. |
| P0.9 Reconcile | Done | This file. PLAN.md and docs/DECISIONS.md updated (D26 to D31). |
| P0.10 Plugin hooks on Windows | Pass | Exec-form hooks run, `${CLAUDE_PLUGIN_ROOT}` expands, a plugin path with a space works, `renameSync` over a locked file fails with EPERM and a retry loop rides it out. |
| Extra: Claude Code background sessions (`claude --bg`) | Rejected as the runner | **Stop hooks do not run in background sessions** (agent-view docs). The gate is a Stop hook. See D26. |

---

## P0.1 Environment

- OS: Windows Server 2025 Datacenter, build 10.0.26100. PowerShell 5.1.26100.33438. No WSL, no tmux (by design).
- Node v24.19.0 and npm 11.17.0 at `C:\Program Files\nodejs` (machine PATH). Git 2.55.0.windows.3 at `C:\Program Files\Git` (machine PATH). GitHub CLI 2.101.0, logged in as `chaoticnewfie`.
- Claude Code native 2.1.283 at `%USERPROFILE%\.local\bin\claude.exe`, installed 2026-09-26 with `irm https://claude.ai/install.ps1 | iex`. The installer does not touch PATH; `C:\Users\<user>\.local\bin` was added to the user PATH by hand. The VS Code extension bundles its own 2.1.283 binary, not on PATH.
- Plan: claude.ai Max. Login: OAuth in `~/.claude/.credentials.json`. No `ANTHROPIC_API_KEY` anywhere; every spike used the subscription.
- Shells opened before the installs do not have node, git or gh on PATH; the registry PATH has all three. Hooks need `node` resolvable from the claude process's PATH.
- `~/.claude/settings.json` has no `autoContinueAtUsageLimit` key (default on) and carries Stop, PermissionRequest and PreToolUse hooks from the `ai-agent-sound-notification` VS Code extension.

## P0.2 Stop-hook continue loop (`spikes/p02-stop-loop`)

A project `.claude/settings.json` Stop hook (`node "<path>/stop-hook.js"`, `timeout: 1200`) run under `claude -p "Say hello and then stop." --allowedTools "Bash(echo:*)" --output-format json`.

- Stop input keys (2.1.283): `session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, stop_hook_active, last_assistant_message, background_tasks, session_crons`.
- `stop_hook_active` is `false` on the first call and `true` on every later call of the same turn. `last_assistant_message` is present on every call.
- Output `{"decision":"block","reason":"..."}` at the top level makes Claude continue with the reason as its instruction. Verified 3 times (mode tool3) and 10 times (mode tool10): every block was honored and Claude ran the requested `echo tick N` between blocks (transcript: 10 tool uses, 21 turns, 52 s).
- Without tool use (mode notool10), Claude Code honored 8 blocks and overrode the ninth. The hooks guide: "overrides a Stop hook after it blocks eight times in a row without progress"; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` raises it. So tool use counts as progress and the plan's assumption holds; the variable stays unset.
- Mode sleep: the hook slept 300 s on its second call under `timeout: 1200` and was not killed; calls 3 and 4 followed, run duration 321 s.
- Shell-form hooks on this machine run under Git for Windows bash (`bash.exe` is the parent, `MSYSTEM=MINGW64`), as the docs say; PowerShell is the fallback when Git Bash is absent.
- Hook stdin length was 469 to 640 bytes. The 10,000-character output truncation could not be located in the current docs; the gate keeps its reasons short regardless.

## P0.3 Statusline bridge: Pass

Rerun after Scott's one-time interactive run (2026-09-27 00:03 UTC). A `statusLine` command set in the spike's project `.claude/settings.json` ran in the interactive session:

- First call at 00:03:02, 4 s after spawn, before any API response: keys `session_id, transcript_path, cwd, scratchpad_dir, effort, model, workspace, version, output_style, cost, context_window, exceeds_200k_tokens, fast_mode, thinking`, no `rate_limits`.
- Second call at 00:03:06, right after the first API response: `rate_limits: { five_hour: { used_percentage: 11, resets_at: 1790479800 }, seven_day: { used_percentage: 6, resets_at: 1790776800 } }`, plus `prompt_cache` and `session_name`.
- Later calls kept `rate_limits` and tracked usage (12 % and 7 % by 00:05:54). So the bridge can write `usage.json` from the second call onward, about 5 s after a session starts.

Docs, for the implementation:

- Input carries `rate_limits.five_hour`, `rate_limits.seven_day` and `rate_limits.spend_limit`, each `{ used_percentage, resets_at }` with `resets_at` in Unix seconds. `rate_limits` appears only for Pro and Max, only after the first API response, and each window may be absent; a window is dropped once its `resets_at` passes.
- Updates are debounced at 300 ms, run on every message, and also when a window's `resets_at` is reached; a `refreshInterval` setting can add a timer.
- A second usage source exists and needs no terminal: `~/.claude.json` -> `cachedUsageUtilization` = `{ fetchedAtMs, utilization: { five_hour: { utilization, resets_at }, seven_day: { utilization, resets_at }, ... } }`, refreshed by any session (the VS Code session had written it). Read-only for us (D27, D28).

## P0.4 Nested headless run from a hook (`spikes/p04-nested`)

A Stop hook spawned `claude -p --output-format json --json-schema <schema> --model sonnet` three ways:

| Variant | Env | Result |
|---|---|---|
| `--settings '{"disableAllHooks":true}'` | inherited (`CLAUDECODE=1`, `CLAUDE_CODE_ENTRYPOINT=sdk-cli`) | pass, 6.5 s, `structured_output` = `{verdict:"pass", note:"... Sonnet 5 (claude-sonnet-5)"}` |
| same | all `CLAUDE*` stripped | pass, 7.3 s, same shape |
| `--bare` | stripped | **fails**: exit 1, `is_error: true`, no model used. `--bare` skips keychain and credential reads. |

- Nested-session detection does not interfere; stripping the env is unnecessary. The recursion guard (`SPIKE_NESTED_DEPTH`) never fired, so `disableAllHooks` really disabled the project Stop hook in the child.
- The nested runs used the subscription login (no API key present).
- Plan change: tester and reviewer use `--settings '{"disableAllHooks":true}'`, never `--bare` (D30).

## P0.5 Headless browser testing (`spikes/p05-browser`)

- `npx playwright install chromium` succeeded (chromium-1243, headless shell, ffmpeg, winldd under `%LOCALAPPDATA%\ms-playwright`). No `--with-deps` on Windows.
- `claude -p ... --mcp-config mcp.playwright.cmd.json --strict-mcp-config --permission-mode dontAsk --allowedTools "mcp__playwright" --model sonnet --max-turns 15` navigated to a local page, clicked the button and replied with the exact resulting text `CLICKED-OK-4173`. 6 turns, 16 s, no permission denials.
- The working MCP config on Windows is `{"command":"cmd","args":["/c","npx","-y","@playwright/mcp@latest","--headless"]}`. A bare `npx` command is a `.cmd` shim, which cannot be spawned without a shell (docs and the exec-form hook note say the same). The `init` template writes the `cmd /c` form on Windows and plain `npx` elsewhere.

## P0.6 Unattended permission behaviour: Partial

Interactive only (in `-p` mode there are no prompts; a tool that is not allowed is denied automatically and shows up in `permission_denials`).

- **PreToolUse deny on `AskUserQuestion`: verified.** Run 3 of the supervisor spike (`--permission-mode auto`, prompt "Use the AskUserQuestion tool to ask me whether I prefer red or blue") fired the hook with `tool_name: AskUserQuestion` and the question in `tool_input`; the hook returned `hookSpecificOutput.permissionDecision: "deny"` with a reason. The transcript shows the tool result `PreToolUse:AskUserQuestion hook error: SPIKE: AskUserQuestion is disabled ...` and Claude replied `ASK-DENIED-HANDLED` and picked blue itself. Exactly the §4.5 behaviour.
- **PermissionRequest deny: verified.** Run 2 (`--permission-mode manual`, `git status`) never prompted, because `git status` is on Claude Code's built-in read-only allowlist. Run 4 (`--continue --permission-mode manual`, `mkdir permission-test-dir`) fired PermissionRequest 4 s after spawn with input keys `session_id, transcript_path, cwd, scratchpad_dir, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, permission_suggestions` (`tool_name: Bash`, `tool_input.command: "mkdir permission-test-dir"`, suggestions to add the directory or switch to `acceptEdits`). The hook answered `hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } }`. The transcript shows the message as the tool result, Claude replied `PERMISSION-DENIED-HANDLED` and explained the directory does not exist, Stop fired 2 s later, and the directory was never created. No prompt was shown.
- Auto-mode fallback prompts (after repeated classifier blocks) go through the same permission-prompt path, so the same hook catches them; documented from the permissions reference rather than forced.

## P0.7 Usage-limit behaviour (docs, interactive-mode and hooks reference)

- Automatic continue is on by default in interactive sessions signed in with a claude.ai subscription (v2.1.234+). Setting: `autoContinueAtUsageLimit` in user or managed settings. Scott's settings do not override it. The visual `/config` check ("Continue automatically at usage limit") is part of Scott's one-time interactive run.
- At the reset Claude Code sends a fixed continuation prompt; it re-arms the wait at most twice in a row, then stops with `Automatic continue stopped after repeated usage-limit hits`.
- It does not start the wait on its own for Remote Control or agent-team teammate sessions (D14 confirmed), for a reset more than 24 hours away (weekly limits), or for a limit on a model family the session is not using.
- After the machine slept more than about 30 minutes across the reset, it shows `press enter to continue` instead of continuing. A `UserPromptSubmit` hook that blocks the continuation ends the wait.
- Notification hook matchers exist for the supervisor: `quota_auto_resume_fired`, `quota_auto_resume_stale`, `quota_auto_resume_disabled`, next to `idle_prompt`, `permission_prompt`, `agent_needs_input`. StopFailure matchers include `rate_limit`.
- Background sessions (`claude --bg`) do not auto-continue at all: they wait for a reply.

## P0.8 Supervisor (`spikes/p08-supervisor`): Partial

Verified:
- A detached console window opens from Node with `cmd.exe /d /s /c "start \"ac-spike\" /D <dir> node supervise.mjs"` (`spikes/lib/open-window.mjs`, `detached: true`, `unref()`), and it outlives the launching shell. Two lessons: launch from Node, not from Git Bash, because MSYS path conversion turns `/D` into `D:/`; and the `start` title must be quoted or `start` treats it as the program (both produced a hung `cmd` with an error dialog).
- Inside that window the supervisor spawned `claude` with inherited stdio, ended it with `taskkill /T /F /PID` (child exit code 1, no orphan `claude.exe`), and relaunched it twice with `--continue` and a new prompt. Three spawn-kill cycles, 80 s each, all clean.
- `claude agents --json --all` lists interactive sessions too: `{ pid, cwd, kind: "interactive", startedAt, sessionId, name, status: "busy" }`. This is a state probe the supervisor can use next to the heartbeat and idle marker.

First attempt (2026-09-26 17:20 local): the interactive `claude` in the window stopped at the first-run screen ("Choose the text style that looks best with your terminal", screenshot), because `~/.claude.json` had no `hasCompletedOnboarding` and no `projects[...].hasTrustDialogAccepted` (the VS Code extension never needed either). Setting those keys from this session was denied by the auto-mode classifier as self-modification. That is the right boundary for the tool too: `autoclaude start` checks both keys read-only and, if either is missing, tells the user to run `claude` once in the project, pick a theme, accept trust and exit (D28). It never edits `~/.claude.json`. Scott did the one-time run; the keys are now `hasCompletedOnboarding: true` and `projects["C:/AutoClaude"].hasTrustDialogAccepted: true`. **The trust key uses the repository root with forward slashes**, which the preflight must match.

Rerun (2026-09-27 00:03 UTC), three runs in one window, 80 s each, all in one session `0fd2994f`:

| Run | Args | What happened |
|---|---|---|
| 1 | `--permission-mode auto "Reply READY..."` | SessionStart `startup` at +3 s, `READY`, Stop at +7 s, Notification `idle_prompt` ("Claude is waiting for your input") at +68 s, 61 s after the stop. Killed at +80 s, exit code 1, no orphan. |
| 2 | `--continue --permission-mode manual "run git status..."` | SessionStart `resume` at +3 s in the **same** session, prompt submitted and answered (`git status` ran, PostToolUse fired with `permission_mode: default`), Stop, `idle_prompt` 60 s later. |
| 3 | `--continue --permission-mode auto "use AskUserQuestion..."` | SessionStart `resume`, PreToolUse fired for `AskUserQuestion` and the deny reached Claude, Stop, `idle_prompt` 60 s later. |

- `claude agents --json --all` during run 1 listed the spike session as `{ pid: 4636, kind: "interactive", status: "idle", name: "p08-supervisor-6a", cwd, sessionId }` while this VS Code session read `busy`. So the supervisor has three consistent idle signals: the heartbeat age, the `idle_prompt` marker, and `claude agents --json`.
- StopFailure never fired (no API errors occurred), so the `rate_limit` input shape is documented from the hooks reference only: `hook_event_name: "StopFailure"` with the error type as the matcher value (`rate_limit`, `overloaded`, `server_error`, ...).
- Still Scott's: with a spike window open, disconnect RDP and reconnect, then check the window and `out/supervisor.log` are still alive. Log-off and sleep end the session by Windows semantics; documented in `docs/USAGE.md` later.

## P0.10 Plugin hooks on Windows (`spikes/p10-plugin`)

- `claude plugin validate` passes for the plugin and the local marketplace (one warning: no marketplace description).
- With `--plugin-dir`, an exec-form hook `{"command":"node","args":["${CLAUDE_PLUGIN_ROOT}/scripts/log.js","SessionStart"]}` ran on Windows with `${CLAUDE_PLUGIN_ROOT}` expanded in `args`, the parent process being `claude.exe` itself (no shell), and these environment variables set: `CLAUDE_PLUGIN_ROOT`, `CLAUDE_PLUGIN_DATA` (`~/.claude/plugins/data/<name>-inline`), `CLAUDE_PROJECT_DIR`. stdin carried the hook JSON. The SessionStart `additionalContext` reached Claude (it answered the planted secret word).
- The same plugin copied to a path with a space (`with space/spikeplug`) behaved identically.
- `CLAUDE_PLUGIN_OPTION_<KEY>` was not exported for a `userConfig` option with a default under `--plugin-dir`; to check again after a marketplace install in P1.1.
- `fs.renameSync` over a file another process holds open with `FileShare.None` fails with `EPERM`; a retry loop with growing sleeps succeeded after 10 attempts and 4.5 s once the lock dropped. `lib/fsatomic.js` retries `EPERM` and `EBUSY` for up to 15 s.

## Background sessions, considered and rejected (agent-view docs)

Claude Code 2.1.283 has `claude --bg`: a full conversation hosted by a supervisor daemon with no terminal, state under `~/.claude/jobs/<id>/`, `claude agents --json`, `claude logs`, `claude stop`, `claude respawn`, `claude attach`, Windows supported, survives terminal close and machine sleep, restarts crashed processes. It looked like a drop-in replacement for D18. It is not, for three reasons: **Stop hooks do not run in background sessions** (the gate is a Stop hook); usage limits are not auto-continued there (the session waits for a reply); and edits are isolated into a worktree unless `worktree.bgIsolation: "none"` is set. Recorded as D26; revisit trigger in `docs/DEFERRED.md`.

## Changes made to the plan from these findings

- P0.4: tester and reviewer use `--settings '{"disableAllHooks":true}'`; `--bare` is rejected (D30).
- P0.5: Windows MCP config uses `cmd /c npx`; `init` writes the right form per OS (P2.1).
- P0.8: the launcher spawns `cmd start` from Node with a quoted title; the supervisor also polls `claude agents --json` (D31).
- P6.3 preflight: onboarding and workspace trust are checked read-only; the user is told to run `claude` once if missing (D28).
- Usage gate: reads statusline `usage.json` first and `cachedUsageUtilization` as the fallback (D27).
- Hooks: exec form with `args` everywhere in `hooks.json`; `node` must be on the claude process PATH, and `init` checks it (D29).
- Block cap: tool use resets it; the gate's no-progress counter (3) is the real guard; `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP` stays unset.
