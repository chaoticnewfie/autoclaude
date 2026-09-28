---
name: resume
description: Resume a paused AutoClaude run (after a review pause, an answered question, a stuck pause, a pause during a feature's fix-up pass), or pick a running one back up after the session was restarted. Use when the user types /autoclaude:resume, or when the supervisor relaunched this session with it.
---

1. Find out whose session this is. Run with the Bash tool:

```
echo "AUTOCLAUDE_BUILDER=$AUTOCLAUDE_BUILDER"
```

`AUTOCLAUDE_BUILDER=1` means the supervisor started this session as the run's builder (it also starts a fresh one for every feature). Anything else is a person's own session.

2. Run with the Bash tool and show the output verbatim:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" resume
```

If it refuses because the plan fails lint, list the problems it printed and stop; do not edit the plan yourself. If it says the plan is complete or no run was started, show that and stop.

3. In a person's own session (step 1 did not print 1), run `node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" status`. If its `supervisor:` line says `alive`, stop here: the supervisor's builder session in the `ac-<project>` window picks the run up on its next pass. Say so in one line. Never build the step in this session. Only when no supervisor is alive does this session carry on as the builder (a run started by hand, as before); mention that `autoclaude run` from a terminal gives the run a supervisor that keeps it going.

4. As the builder, once it resumed or says the run is already running: the run is on. Read the "AutoClaude run in progress" context (injected at the start of this session; if there is none, read the current step in the plan and the "During an AutoClaude run" section of the project's `CLAUDE.md`), then `CONTINUE_HERE.md`. Act on owner answers and notes first, look at `git status` and the diff for work already done on the step, then carry on exactly as the context says. If the run was in a feature's fix-up pass, finish it: every finding the gate listed is fixed, or left for the owner with a reason in its row, then `autoclaude ready <step>` again. Do not wait for the user; nobody is there.
