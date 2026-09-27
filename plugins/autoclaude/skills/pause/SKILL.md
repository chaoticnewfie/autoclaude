---
name: pause
description: Pause the AutoClaude run of this project for review, after the next verified commit (or immediately with "now"). Use when the user types /autoclaude:pause or asks to pause the autopilot to look things over.
---

Run this with the Bash tool. Add `--now` only if the user asked to stop immediately rather than after the current step is verified and committed:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" pause
```

Show the output verbatim. Then tell the user, in one line, that they can leave notes with `/autoclaude:note` and continue with `/autoclaude:resume`.
