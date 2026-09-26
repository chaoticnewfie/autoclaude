# DEFERRED

Things deliberately not built yet. Each entry says what, why it waits, the trigger that means it
is time, the concrete path, and why adding it later costs no rework. If something seems missing
it should be here; if it is not, it is an open decision in `DECISIONS.md` or an oversight.

---

## 1. Pause from the phone

**What.** A button in the ntfy notification that pauses the run.
**Why it waits.** ntfy action buttons need an HTTP endpoint to hit, and v1 has no server.
**Trigger.** Scott wants to stop a run while away from a keyboard more than once.
**Path.** A tiny HTTP listener in the supervisor reachable on the LAN or through a tunnel, or a
file the supervisor polls on a share.
**No rework.** The pause is already a state flag the gate reads; only the way of setting it changes.

## 2. tmux attach on Linux and macOS

**What.** `autoclaude run` puts the supervisor in a tmux session when tmux exists, so `tmux attach`
works there.
**Why it waits.** Windows first. The supervisor design does not need tmux anywhere.
**Trigger.** Someone runs it on Linux and wants to watch from another terminal.
**Path.** Detect `tmux` on PATH, wrap the same command; everything else unchanged.

## 3. A real pseudo-terminal (node-pty)

**What.** Driving `claude` through a pty so the supervisor can read the screen and type into it.
**Why it waits.** Native dependency; restart-with-prompt covers every recovery case identified.
**Trigger.** A recovery case appears that a restart cannot handle.
**Path.** Optional dependency loaded only if present.

## 4. `Depends:` with park-and-skip for failed steps

From the draft (P8.3). Failed steps park and independent steps continue. Off by default when it
arrives. Trigger: a run pausing on a step that nothing else needs.

## 5. Parallel steps in worktrees

From the draft (non-goal for v1). Trigger: plans with clearly independent phases and spare quota.

## 6. Run windows (nights only)

Trigger: Scott wants daytime quota protected by a schedule rather than by the weekly threshold.
Path: the supervisor already polls on a timer; a window is a check before each restart or nudge.

## 7. Progress dashboard page

Trigger: `autoclaude status` and notifications stop being enough. Path: a static page reading
`.autoclaude/state.json` and `PROGRESS.md`.

## 8. Second-opinion reviewer through another provider

Trigger: a class of bug the security reviewer keeps missing. Path: a second `claude -p`-shaped
runner behind the same verdict schema.

## 9. Answering blockers through Remote Control

Trigger: `autoclaude answer` from a shell proves inconvenient from the phone.

## 10. Windows toast notifications as a local channel

Trigger: someone without ntfy or Discord wants alerts on the same machine. Path: a PowerShell
one-liner behind the same notify interface, opt-in.
