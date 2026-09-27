---
name: init
description: Set this project up for AutoClaude - config, the doc set, the statusline bridge, the machine registry - without overwriting anything that exists. Use when the user types /autoclaude:init or asks to add autoclaude to a project.
---

1. Ask the user two quick things only if not obvious from the conversation: whether to add a Playwright scaffold (only if the project has no e2e tests yet and has a web UI), and whether the statusline bridge may be installed (it edits `~/.claude/settings.json` once, with a backup, and chains any existing status line).

2. Run with the Bash tool from the project root (add `--playwright` and/or `--no-statusline` according to the answers; add `--dev-url <url>` if you already know the dev server address):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" init
```

3. Show the output verbatim. Then open `autoclaude.config.json` and confirm the detected `checks` and `devServer` with the user; fix anything wrong with the Edit tool. Every command in `checks` must exit non-zero on failure.

4. If the output says the project already had code or a plan, recommend a plan review now: `/autoclaude:plan` reads the existing plan, lists every step that would stall an unattended run (no Accept line, a decision left open, needs a secret or a human), and rewrites it into the step format. Do not start a run before that review.

5. Finish by pointing at `CLAUDE.md` in the project (the rules a run follows) and `/autoclaude:plan` for a new plan.
