// Run summaries (PLAN.md P6.5): the plan-complete message and the optional morning summary.
// Steps done, attempts, decisions made, blockers and findings, usage used, elapsed time.
// Built from the files the run already keeps; nothing extra is tracked. Node built-ins only.
import path from "node:path";
import { readText } from "./fsatomic.js";
import { progress } from "./plan.js";

// PROGRESS.md lines look like "- 2026-09-27 S1.2 Title (attempt 2)".
export function progressEntries(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^- (\d{4}-\d\d-\d\d) (\S+) (.*?)(?: \(attempt (\d+)\))?\s*$/);
    if (m) out.push({ date: m[1], id: m[2], title: m[3], attempt: m[4] ? Number(m[4]) : 1 });
  }
  return out;
}

function countMatches(text, re) {
  return (String(text || "").match(re) || []).length;
}

function fmtDuration(ms) {
  if (!(ms >= 0)) return "unknown";
  const min = Math.round(ms / 60000);
  if (min < 90) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

// sinceDate: "YYYY-MM-DD"; only progress lines on or after it count as "this period".
export function buildSummary({ root, config, state, parsed, usage = null, now = Date.now(), sinceDate = null }) {
  const p = progress(parsed);
  const entries = progressEntries(readText(path.join(root, config.docs.progress), ""));
  const period = sinceDate ? entries.filter((e) => e.date >= sinceDate) : entries;
  const attempts = period.reduce((n, e) => n + e.attempt, 0);
  const firstTry = period.filter((e) => e.attempt === 1).length;
  const decisionsText = readText(path.join(root, config.docs.decisions), "");
  const decisions = countMatches(decisionsText, /^## D-\d+/gm);
  const notes = countMatches(decisionsText, /^## N-\d+/gm);
  const blockers = countMatches(readText(path.join(root, config.docs.blockers), ""), /^\| \d{4}-\d\d-\d\d \|/gm);
  const findings = countMatches(readText(path.join(root, config.docs.security), ""), /^\| \d{4}-\d\d-\d\d \|/gm);
  const started = state.startedAt ? Date.parse(state.startedAt) : null;
  const lines = [];
  lines.push(`Steps: ${p.done}/${p.total} verified${sinceDate ? `, ${period.length} since ${sinceDate}` : ""}${p.failed ? `, ${p.failed} failed` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}.`);
  if (period.length) lines.push(`Attempts: ${attempts} for ${period.length} step${period.length === 1 ? "" : "s"} (${firstTry} passed first time).`);
  lines.push(`Decisions logged: ${decisions}${notes ? `, owner notes handled: ${notes}` : ""}. Follow-ups: ${blockers}. Security findings filed: ${findings}.`);
  if (usage && usage.sevenDay) {
    const used = typeof state.usageAtStart === "number" ? ` (${Math.max(0, Math.round(usage.sevenDay.pct - state.usageAtStart))} points this run)` : "";
    lines.push(`Weekly usage: ${Math.round(usage.sevenDay.pct)}%${used}.`);
  }
  if (started) lines.push(`Elapsed: ${fmtDuration(now - started)}.`);
  if (state.status === "paused") lines.push(`Now: paused (${state.pauseReason || "?"}) at ${state.currentStep || "?"}.`);
  else if (state.status === "running") lines.push(`Now: running ${state.currentStep || "?"}.`);
  return lines.join("\n");
}
