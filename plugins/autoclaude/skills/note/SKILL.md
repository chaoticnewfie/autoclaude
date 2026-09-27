---
name: note
description: Record a review note for the AutoClaude run (a correction, a preference, a change of direction). The note is written to the project's review-notes file and handed to Claude on the next resume. Use when the user types /autoclaude:note or wants to leave feedback for the unattended run.
---

Take the user's note text exactly as written and run this with the Bash tool, quoting the text as one argument:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" note "<the note text>"
```

Show the output verbatim. Do not act on the note yourself in this session unless the user asks you to; it is meant for the run.
