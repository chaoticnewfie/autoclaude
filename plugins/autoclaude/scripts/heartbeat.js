// PostToolUse hook (async): while a run is active, count tool calls so the gate and the
// supervisor can tell "working" from "stalled". Silent and instant otherwise.
import fs from "node:fs";
import { findProjectRoot } from "../lib/paths.js";
import { loadState, STATUS } from "../lib/state.js";
import { bumpHeartbeat } from "../lib/protocol.js";

try {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const root = findProjectRoot(input.cwd || process.cwd());
  if (root && loadState(root).status === STATUS.running) bumpHeartbeat(root);
} catch {}
