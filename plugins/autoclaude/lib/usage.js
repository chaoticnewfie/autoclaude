// Usage percentages from two read-only sources (D27):
//   1. <machineDir>/usage.json, written by the statusline bridge from the status line's
//      rate_limits { five_hour: { used_percentage, resets_at (unix s) }, seven_day: {...} }.
//   2. ~/.claude.json -> cachedUsageUtilization { fetchedAtMs, utilization: { five_hour:
//      { utilization, resets_at (ISO) }, seven_day: {...} } }, refreshed by any session.
// The fresher one wins. Node built-ins only.
import { readJson } from "./fsatomic.js";
import { machinePaths, claudeUserConfigFile } from "./paths.js";

function window(pct, resetsAt) {
  if (typeof pct !== "number" || Number.isNaN(pct)) return null;
  return { pct, resetsAt: resetsAt || null };
}

function fromStatusline(file) {
  let j;
  try { j = readJson(file, null); } catch { return null; }
  if (!j || !j.rate_limits) return null;
  const at = j.updatedAt ? Date.parse(j.updatedAt) : null;
  const rl = j.rate_limits;
  const toMs = (s) => (typeof s === "number" ? s * 1000 : null);
  return {
    source: "statusline",
    fetchedAt: at,
    fiveHour: rl.five_hour ? window(rl.five_hour.used_percentage, toMs(rl.five_hour.resets_at)) : null,
    sevenDay: rl.seven_day ? window(rl.seven_day.used_percentage, toMs(rl.seven_day.resets_at)) : null
  };
}

function fromCached(file) {
  let j;
  try { j = readJson(file, null); } catch { return null; }
  const c = j && j.cachedUsageUtilization;
  if (!c || !c.utilization) return null;
  const toMs = (iso) => (iso ? Date.parse(iso) : null);
  const u = c.utilization;
  return {
    source: "cached",
    fetchedAt: typeof c.fetchedAtMs === "number" ? c.fetchedAtMs : null,
    fiveHour: u.five_hour ? window(u.five_hour.utilization, toMs(u.five_hour.resets_at)) : null,
    sevenDay: u.seven_day ? window(u.seven_day.utilization, toMs(u.seven_day.resets_at)) : null
  };
}

// Returns { source, fetchedAt, ageMin, stale, fiveHour, sevenDay } or { source: null } when
// nothing is known. `stale` is true when the freshest data is older than staleAfterMin.
export function readUsage({ usageFile = machinePaths().usageFile, userConfigFile = claudeUserConfigFile(), staleAfterMin = 30, now = Date.now() } = {}) {
  const candidates = [fromStatusline(usageFile), fromCached(userConfigFile)].filter(Boolean);
  if (candidates.length === 0) return { source: null, fetchedAt: null, ageMin: null, stale: true, fiveHour: null, sevenDay: null };
  candidates.sort((a, b) => (b.fetchedAt || 0) - (a.fetchedAt || 0));
  const best = candidates[0];
  const ageMin = best.fetchedAt ? (now - best.fetchedAt) / 60000 : null;
  return { ...best, ageMin, stale: ageMin === null || ageMin > staleAfterMin };
}

function fmtReset(ms, now) {
  if (!ms) return "";
  const d = new Date(ms);
  const sameDay = new Date(now).toDateString() === d.toDateString();
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return sameDay ? ` (resets ${hh}:${mm})` : ` (resets ${d.toLocaleDateString(undefined, { weekday: "short" })} ${hh}:${mm})`;
}

export function formatUsage(u, now = Date.now()) {
  if (!u || !u.source) return "usage: unknown (no statusline data yet)";
  const parts = [];
  if (u.fiveHour) parts.push(`5h ${Math.round(u.fiveHour.pct)}%${fmtReset(u.fiveHour.resetsAt, now)}`);
  if (u.sevenDay) parts.push(`7d ${Math.round(u.sevenDay.pct)}%${fmtReset(u.sevenDay.resetsAt, now)}`);
  const age = u.ageMin === null ? "age unknown" : `${Math.round(u.ageMin)} min old`;
  return `usage: ${parts.join(" | ") || "no windows reported"} [${u.source}, ${age}${u.stale ? ", stale" : ""}]`;
}
