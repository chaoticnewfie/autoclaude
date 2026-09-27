---
name: resume
description: Resume a paused AutoClaude run (after a review pause, an answered question, a stuck pause), or pick a running one back up after the session was restarted. Use when the user types /autoclaude:resume, or when the supervisor relaunched this session with it.
---

1. Run this with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" resume
```

2. If it resumed, or it says the run is already running: the run is on. Read the injected "AutoClaude run in progress" context (it is at the start of this session) and carry on with the current step exactly as it says, owner answers and notes first. Do not wait for the user; nobody is there.

3. If it refuses because the plan fails lint, list the problems it printed and stop; do not edit the plan yourself. If it says the plan is complete or no run was started, show that and stop.
