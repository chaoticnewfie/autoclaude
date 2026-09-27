// The ready/blocked protocol between the builder session and the gate (PLAN.md 4.4, P3.2).
// The CLI writes a marker file; the Stop hook consumes it. Node built-ins only.
import { readJson, writeJsonAtomic, removeIfExists, ensureDir } from "./fsatomic.js";
import { projectPaths } from "./paths.js";

export function writeReady(root, step, { now = new Date() } = {}) {
  const p = projectPaths(root);
  ensureDir(p.runtimeDir);
  writeJsonAtomic(p.readyFile, { step: step || null, at: now.toISOString() });
}

export function readReady(root) {
  try { return readJson(projectPaths(root).readyFile, null); } catch { return null; }
}

export function clearReady(root) {
  return removeIfExists(projectPaths(root).readyFile);
}

export function writeBlocked(root, step, question, { now = new Date() } = {}) {
  const p = projectPaths(root);
  ensureDir(p.runtimeDir);
  writeJsonAtomic(p.blockedFile, { step: step || null, question: String(question || ""), at: now.toISOString() });
}

export function readBlocked(root) {
  try { return readJson(projectPaths(root).blockedFile, null); } catch { return null; }
}

export function clearBlocked(root) {
  return removeIfExists(projectPaths(root).blockedFile);
}

// Heartbeat: the PostToolUse hook bumps a counter; the gate and the supervisor read it.
export function bumpHeartbeat(root) {
  const p = projectPaths(root);
  ensureDir(p.runtimeDir);
  const current = readHeartbeat(root);
  const next = { count: (current.count || 0) + 1, at: new Date().toISOString() };
  writeJsonAtomic(p.heartbeatFile, next);
  return next;
}

export function readHeartbeat(root) {
  try {
    const j = readJson(projectPaths(root).heartbeatFile, null);
    return j && typeof j === "object" ? j : { count: 0, at: null };
  } catch {
    return { count: 0, at: null };
  }
}
