// Prepares spikes/out/todo-live for a short live run of the real `autoclaude run`: the fixture
// app with the three-step happy plan, short supervisor timings, and the browser tester's MCP
// config. Leaves a clean committed tree. Used to check behaviour that only a real run window
// shows (session ids, builder identity, pause --now), 2026-09-27.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../../test/fixtures/prepare.js";
import { playwrightMcpConfig } from "../../plugins/autoclaude/lib/init.js";
import { writeJsonAtomic } from "../../plugins/autoclaude/lib/fsatomic.js";

const dest = "C:/AutoClaude/spikes/out/todo-live";
const env = gitEnv(process.env);
fs.rmSync(dest, { recursive: true, force: true });
prepareFixture({ dest, plan: "happy", git: true, env });

const cfgFile = path.join(dest, "autoclaude.config.json");
const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
cfg.supervisor = { pollSec: 20, idleRelaunchMin: 3, stallMin: 3, resumeGraceMin: 1, rateLimitGraceMin: 10, maxRecoveries: 3 };
fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
writeJsonAtomic(path.join(dest, ".autoclaude", "mcp.playwright.json"), playwrightMcpConfig());

const r = spawnSync("git", ["add", "-A"], { cwd: dest, env });
const c = spawnSync("git", ["commit", "-qm", "live: happy plan, short supervisor timings"], { cwd: dest, env, encoding: "utf8" });
console.log(r.status === 0 && c.status === 0 ? "prepared the live run" : `git failed: ${c.stderr}`);
