---
name: config
description: Open the AutoClaude settings page in the browser - this project's run settings, alerts (channel, webhook, which events), checks, dev server, deny rules and permissions, this computer's defaults, the watchdog and the status line bridge. Use when the user types /autoclaude:config or wants to change an AutoClaude setting.
---

Start the settings page with the Bash tool, with `run_in_background` set to true, from the project folder:

```
node "${CLAUDE_PLUGIN_ROOT}/bin/autoclaude.js" config
```

Wait a moment, then read the command's output. Its first line gives the page's link (`http://127.0.0.1:<port>/?token=...`). The command also tries to open the browser by itself. Give the user the link in one line, and say that the page is served from this computer only and that the link carries its access token, so it should not be shared.

Then wait. Do not change settings for the user unless they ask; the page is where they do it. The command ends when the user clicks Done on the page, or after 30 minutes without use, and prints that it closed. When it has ended, say so in one line.

If the output or the page says this folder has no AutoClaude project, tell the user that `/autoclaude:init` sets one up; until then the page offers only this computer's defaults, the alert channel and the computer tasks.

Tell the user, once, that `autoclaude config` in any terminal inside the project opens the same page, with no Claude session needed.
