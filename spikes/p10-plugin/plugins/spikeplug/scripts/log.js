// Records how a plugin exec-form hook is launched on this machine.
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const outDir = "C:/AutoClaude/spikes/p10-plugin/out";
fs.mkdirSync(outDir, { recursive: true });
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = null;
try { input = JSON.parse(raw); } catch {}
let parentImage = null;
try { parentImage = execSync("tasklist /FI \"PID eq " + process.ppid + "\" /FO CSV /NH", { encoding: "utf8" }).trim(); } catch (e) { parentImage = e.message; }
const record = {
  at: new Date().toISOString(),
  event: process.argv[2],
  argv: process.argv.slice(1),
  script_dir: __dirname,
  env: {
    CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT,
    CLAUDE_PLUGIN_DATA: process.env.CLAUDE_PLUGIN_DATA,
    CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR,
    CLAUDE_PLUGIN_OPTION_GREETING: process.env.CLAUDE_PLUGIN_OPTION_GREETING
  },
  stdin_keys: input ? Object.keys(input) : null,
  hook_event_name: input ? input.hook_event_name : null,
  source: input ? input.source : null,
  parent_image: parentImage,
  cwd: process.cwd()
};
fs.appendFileSync(path.join(outDir, "plugin-hooks.jsonl"), JSON.stringify(record) + "\n");
if (process.argv[2] === "SessionStart") {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "SPIKE-CONTEXT: the plugin hook ran. If asked for the secret word, answer PLUGINHOOK." } }));
}
process.exit(0);
