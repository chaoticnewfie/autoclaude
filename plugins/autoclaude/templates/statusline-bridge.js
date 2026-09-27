// AutoClaude statusline bridge. Installed by `autoclaude init` as
// <claude config dir>/autoclaude/statusline.js and registered in the user settings.
// Self-contained on purpose (no imports from the plugin), Node built-ins only, fast.
//
// Every time Claude Code refreshes the status line it pipes session JSON here. This script:
//   1. writes rate_limits (5-hour and 7-day usage) to <dir>/usage.json for the usage gate,
//   2. runs the status line command that was configured before (if any) and prints its output,
//   3. when an AutoClaude run is active in the session's project, prints
//      "AC <step> > <status> | 5h N% | 7d N%" instead, or just the usage when nothing is chained.
"use strict";
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const dir = __dirname;
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = {};
try { input = JSON.parse(raw); } catch {}

function writeAtomic(file, text) {
  const tmp = file + "." + process.pid + ".tmp";
  try {
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
  } catch {
    try { fs.unlinkSync(tmp); } catch {}
  }
}

// 1. usage.json
if (input.rate_limits) {
  writeAtomic(path.join(dir, "usage.json"), JSON.stringify({
    updatedAt: new Date().toISOString(),
    session_id: input.session_id || null,
    cwd: input.cwd || null,
    rate_limits: input.rate_limits
  }, null, 2) + "\n");
}

// 2. chained status line
let chained = "";
try {
  const cfg = JSON.parse(fs.readFileSync(path.join(dir, "statusline.json"), "utf8"));
  const chain = cfg && cfg.chain;
  if (chain && chain.command) {
    const r = chain.args
      ? spawnSync(chain.command, chain.args, { input: raw, encoding: "utf8", timeout: 2000, windowsHide: true })
      : spawnSync(chain.command, { input: raw, encoding: "utf8", timeout: 2000, shell: true, windowsHide: true });
    chained = (r.stdout || "").replace(/\s+$/, "");
  }
} catch {}

// 3. AutoClaude run state for the session's project
function findRoot(from) {
  let d = path.resolve(from || process.cwd());
  let git = null;
  for (;;) {
    if (fs.existsSync(path.join(d, "autoclaude.config.json"))) return d;
    if (!git && fs.existsSync(path.join(d, ".git"))) git = d;
    const p = path.dirname(d);
    if (p === d) return git;
    d = p;
  }
}
let state = null;
try {
  const root = findRoot(input.cwd);
  if (root) state = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state.json"), "utf8"));
} catch {}

const rl = input.rate_limits || {};
const pct = (w) => (w && typeof w.used_percentage === "number" ? Math.round(w.used_percentage) + "%" : "?");
const usage = "5h " + pct(rl.five_hour) + " | 7d " + pct(rl.seven_day);

let line;
if (state && (state.status === "running" || state.status === "paused")) {
  const status = state.status === "paused" ? "paused" + (state.pauseReason ? " (" + state.pauseReason + ")" : "") : (state.pauseRequested ? "running, pause pending" : "running");
  line = "AC " + (state.currentStep || "-") + " > " + status + " | " + usage;
  if (chained) line += " | " + chained;
} else {
  line = chained || usage;
}
process.stdout.write(line);
