// Denial bookkeeping for unattended runs (PLAN.md P5.3). Every denial (a permission prompt
// answered by the PermissionRequest hook, or a tool-guard block) is logged; when more than
// `limit` happen within an hour the owner is told once per hour, because a run that keeps
// hitting walls is usually stuck on something only a person can fix. Node built-ins only.
import path from "node:path";
import { readJson, writeJsonAtomic, appendLine } from "./fsatomic.js";
import { projectPaths } from "./paths.js";

const HOUR = 60 * 60 * 1000;

function files(root) {
  const p = projectPaths(root);
  return { stateFile: path.join(p.runtimeDir, "denials.json"), logFile: path.join(p.logsDir, "denials.log") };
}

// Returns { count (within the last hour, including this one), notify (true once per hour when
// count exceeds limit) }. Never throws.
export function recordDenial(root, { kind, tool, detail = "", reason = "" }, { limit = 10, now = Date.now() } = {}) {
  const f = files(root);
  try {
    appendLine(f.logFile, `${new Date(now).toISOString()} ${kind} ${tool || "?"} ${String(detail).slice(0, 200)} -> ${String(reason).slice(0, 100)}`);
  } catch {}
  let s = null;
  try { s = readJson(f.stateFile, null); } catch { s = null; }
  const times = (s && Array.isArray(s.times) ? s.times : []).filter((t) => now - t < HOUR);
  times.push(now);
  const lastNotifiedAt = s && typeof s.lastNotifiedAt === "number" ? s.lastNotifiedAt : 0;
  const notify = times.length > limit && now - lastNotifiedAt >= HOUR;
  try { writeJsonAtomic(f.stateFile, { times, lastNotifiedAt: notify ? now : lastNotifiedAt }); } catch {}
  return { count: times.length, notify };
}
