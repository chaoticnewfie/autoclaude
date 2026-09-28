---
name: pause
description: Pause the AutoClaude run of this project for review, after the next commit, or immediately with "now" (which also ends the builder session and stops the dev server). Use when the user types /autoclaude:pause or asks to pause the autopilot to look things over.
---

Run this with the Bash tool. Add `--now` only if the user asked to stop immediately rather than after the step in progress is committed:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" pause
```

Show the output verbatim. Without `--now` the gate finishes the step in progress, commits it, then pauses. With `--now` the run pauses at once: the supervisor ends the builder session on its next check, the dev server is stopped, unfinished work stays in the working tree uncommitted, and the step starts again with fresh attempts on resume. Either form sends a "paused by the owner" alert only when that alert is switched on (it is off by default; `autoclaude config` opens the settings page where alerts are switched).

Then tell the user, in one line, that they can leave notes with `/autoclaude:note` and continue with `autoclaude resume` from a terminal (`/autoclaude:resume` in this session runs the same command).
