---
name: start
description: Start an AutoClaude run in this project - preflight, run branch, first unfinished step - and then work that step. Use when the user types /autoclaude:start, or when `autoclaude run` opened this session with it.
---

1. Run with the Bash tool:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" start
```

2. If it refuses (a FAIL line in the preflight, plan lint problems, a dirty working tree, not a git repository, already running), show the output verbatim and stop; the owner fixes that.

3. If it prints "running on branch ...", the run is on. The rules and the current step are injected at session start and after every stop; read the "AutoClaude run in progress" context and start the current step exactly as it says: build it, test it, rewrite CONTINUE_HERE.md, then `autoclaude ready <step>` and end your turn. The gate takes it from there. Do not wait for the user; nobody is there.
