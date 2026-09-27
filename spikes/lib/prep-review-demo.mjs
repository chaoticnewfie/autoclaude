// Prepares spikes/out/todo-live for the pause-note-resume demo: the happy plan with
// review.pauseAt every-step, the browser tester's MCP config, and a clean committed tree.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../../test/fixtures/prepare.js";
import { playwrightMcpConfig } from "../../plugins/autoclaude/lib/init.js";
import { writeJsonAtomic } from "../../plugins/autoclaude/lib/fsatomic.js";

const dest = "C:/AutoClaude/spikes/out/todo-live";
const env = gitEnv(process.env);
prepareFixture({ dest, plan: "happy", git: true, env });
const cfgFile = path.join(dest, "autoclaude.config.json");
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
cfg.review = { pauseAt: "every-step" };
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
writeJsonAtomic(path.join(dest, ".autoclaude", "mcp.playwright.json"), playwrightMcpConfig());
const r = spawnSync("git", ["commit", "-qam", "demo: pause after every step"], { cwd: dest, env, encoding: "utf8" });
console.log(r.status === 0 ? "prepared with review.pauseAt every-step" : `commit failed: ${r.stderr}`);
