---
name: answer
description: Answer the question an AutoClaude run stopped on (a blocked step). The answer is recorded as a decision and the run resumes. Use when the user types /autoclaude:answer or answers the question from a blocked-run notification.
---

Take the user's answer exactly as written and run this with the Bash tool, quoting it as one argument:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" answer "<the answer>"
```

Show the output verbatim. If it says nothing is waiting for an answer, run `node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" status` and show that instead. In the run's own builder session (the one that asked the question, with the "AutoClaude run in progress" context), carry on with the step using the answer once the run is going again. In any other session, do not act on the answer yourself; it is for the run.
