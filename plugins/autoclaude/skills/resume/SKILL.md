---
name: resume
description: Resume a paused AutoClaude run (after a review pause, a blocked question that has been answered, or a stuck pause). Use when the user types /autoclaude:resume or asks to continue the autopilot.
---

Run this with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" resume
```

Show the output verbatim. If it refuses because the plan fails lint, list the problems it printed and offer to fix the plan; do not edit `PLAN.md` on your own.
