// Notification hook (PLAN.md P6.1, D39). While a run is active:
//   - every notification is written to .autoclaude/idle for the supervisor, which relaunches an
//     idle or stuck session on its own;
//   - a prompt that is waiting for a person (permission_prompt, agent_needs_input,
//     elicitation_dialog) also pages the owner, at most once per 30 minutes, because the
//     PermissionRequest hook should have answered it and something is off.
//   - idle_prompt alone does not page: the supervisor fixes that case within minutes, and a page
//     for it would be a false alarm (success criterion "Quiet").
// Silent when no run is active, for nested checker runs, and for a person's own session in the
// project while a supervised run is going (only the builder's prompts matter here). Never throws.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const PAGE_TYPES = new Set(["permission_prompt", "agent_needs_input", "elicitation_dialog"]);
const THROTTLE_MS = 30 * 60 * 1000;

async function main() {
  if (process.env.AUTOCLAUDE_ROLE) return;
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const { findProjectRoot, projectPaths } = await import("../lib/paths.js");
  const { loadState } = await import("../lib/state.js");
  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root) return;
  const state = loadState(root);
  if (state.status !== "running") return;
  const { isBuilderSession } = await import("../lib/builder.js");
  if (!isBuilderSession(root)) return;
  const { writeJsonAtomic, readJson, appendLine } = await import("../lib/fsatomic.js");
  const p = projectPaths(root);
  const type = input.notification_type || "unknown";
  const now = Date.now();
  writeJsonAtomic(p.idleFile, { type, at: new Date(now).toISOString(), message: String(input.message || "").slice(0, 300) });
  appendLine(path.join(p.logsDir, "hooks.log"), `${new Date(now).toISOString()} Notification ${type}: ${String(input.message || "").slice(0, 120)}`);
  if (!PAGE_TYPES.has(type)) return;
  const throttleFile = path.join(p.runtimeDir, "notify-throttle.json");
  let last = 0;
  try { last = (readJson(throttleFile, {}) || {}).lastAt || 0; } catch {}
  if (now - last < THROTTLE_MS) return;
  writeJsonAtomic(throttleFile, { lastAt: now, type });
  const { notify } = await import("../lib/notify.js");
  await notify({
    title: "AutoClaude: the session is waiting for a person",
    message: `${path.basename(root)} on ${state.currentStep || "?"}: ${type}${input.message ? ` (${String(input.message).slice(0, 200)})` : ""}. Window ${state.windowTitle || "ac-" + path.basename(root)}. Check it, or \`autoclaude status\`.`,
    priority: "high"
  }, { logFile: path.join(p.logsDir, "notify.log"), stdout: { write() { return true; } } });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
