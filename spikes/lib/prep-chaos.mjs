// Prepares spikes/out/todo-live for the Phase 6 chaos run: the chaos plan, short supervisor
// timings, the browser tester's MCP config, and a test-only PreToolUse hook that sleeps while the
// file .chaos-stall exists (the "stalled tool call" case). Leaves a clean committed tree.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../../test/fixtures/prepare.js";
import { playwrightMcpConfig } from "../../plugins/autoclaude/lib/init.js";
import { writeJsonAtomic } from "../../plugins/autoclaude/lib/fsatomic.js";

const dest = "C:/AutoClaude/spikes/out/todo-live";
const env = gitEnv(process.env);
prepareFixture({ dest, plan: "chaos", git: true, env });

const cfgFile = path.join(dest, "autoclaude.config.json");
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
cfg.supervisor = { pollSec: 20, idleRelaunchMin: 3, stallMin: 3, resumeGraceMin: 1, rateLimitGraceMin: 10, maxRecoveries: 3 };
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");

fs.mkdirSync(path.join(dest, "tools"), { recursive: true });
fs.writeFileSync(path.join(dest, "tools", "stall-hook.js"), [
  "// Test harness, not part of the app: while the file .chaos-stall exists, every tool call",
  "// blocks here for 20 minutes, which is how the chaos run simulates a stalled session.",
  "const fs = require(\"fs\");",
  "const path = require(\"path\");",
  "if (fs.existsSync(path.join(__dirname, \"..\", \".chaos-stall\"))) {",
  "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20 * 60 * 1000);",
  "}",
  ""
].join("\n"));
fs.writeFileSync(path.join(dest, "tools", "package.json"), JSON.stringify({ type: "commonjs" }) + "\n");
fs.mkdirSync(path.join(dest, ".claude"), { recursive: true });
fs.writeFileSync(path.join(dest, ".claude", "settings.json"), JSON.stringify({
  hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/tools/stall-hook.js"], timeout: 1500 }] }] }
}, null, 2) + "\n");
fs.appendFileSync(path.join(dest, ".gitignore"), ".chaos-stall\n");
writeJsonAtomic(path.join(dest, ".autoclaude", "mcp.playwright.json"), playwrightMcpConfig());

const r = spawnSync("git", ["add", "-A"], { cwd: dest, env });
const c = spawnSync("git", ["commit", "-qm", "chaos: plan, supervisor timings, stall hook"], { cwd: dest, env, encoding: "utf8" });
console.log(r.status === 0 && c.status === 0 ? "prepared the chaos run" : `git failed: ${c.stderr}`);
