---
name: status
description: Show the AutoClaude state of this project (running, paused, current step, attempts, usage, last progress). Use when the user asks how the autoclaude run is going or types /autoclaude:status.
---

Run this command with the Bash tool and show its output to the user verbatim, without commentary:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" status
```

If the output says the project is not initialized, tell the user that `/autoclaude:init` sets it up.
