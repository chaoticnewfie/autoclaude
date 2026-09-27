---
name: init
description: Set this project up for AutoClaude - config, the doc set, the statusline bridge, the machine registry - without overwriting anything that exists. Use when the user types /autoclaude:init or asks to add autoclaude to a project.
---

1. Ask the user two quick things only if not obvious from the conversation: whether to add a Playwright scaffold (only for a web UI project with no runnable end-to-end setup, meaning no Playwright config and no `@playwright/test` dependency; the scaffold then needs `npm i -D @playwright/test`, which the project's own rules may want the owner to approve), and whether the statusline bridge may be installed (it edits `~/.claude/settings.json` once, with a backup, and chains any existing status line).

2. Run with the Bash tool from the project root (add `--playwright` and/or `--no-statusline` according to the answers; add `--dev-url <url>` if you already know the dev server address):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" init
```

3. Show the output verbatim. Then open `autoclaude.config.json` and show the detected `checks` and `devServer`: they are guesses. `/autoclaude:plan` settles them with the user and runs them with `autoclaude checks`, the way the gate does. Every command in `checks` must exit non-zero on failure.

4. If the output says the project already had code or a plan, recommend a plan review now: `/autoclaude:plan` reads the existing plan, lists every step that would stall an unattended run (no Accept line, a decision left open, needs a secret or a human), and rewrites it into the step format. Do not start a run before that review.

5. Check that the `autoclaude` command exists: run `autoclaude version`. If that fails, install it (once per machine; it adds a small launcher to the user's PATH):

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" install-cli
```

Tell the user that terminals opened before this, including this session's own shell, do not see the new command: they open a new terminal for `autoclaude run`. Until then, call it as `node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" <command>`.

6. Finish by pointing at `CLAUDE.md` in the project (the rules a run follows) and at `/autoclaude:plan` as the next step in every case: it writes or reviews the plan, sets the checks, the dev server and the guard rules, commits, and hands over a project ready for `autoclaude run`.
