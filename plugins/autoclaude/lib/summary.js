// Run summaries (PLAN.md P6.5, P8.5): the plan-complete message and the optional morning
// summary. Steps done, attempts, the run's own decisions, decisions for the owner to review, open
// items, the push state, usage used and elapsed time. Built from the files the run already keeps;
// nothing extra is tracked. The doc parsers here are shared with lib/handoff.js, so the alert and
// HANDOFF.md always count the same things. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { readText } from "./fsatomic.js";
import { progress } from "./plan.js";
import { runPlanOverride } from "./config.js";

export const HANDOFF_FILE = "HANDOFF.md";

// The hand-back of a run on a generated plan (`autoclaude run --plan`, P10.7) gets its own name,
// so the project's own HANDOFF.md is left alone: SECURITY_PLAN.md -> HANDOFF-SECURITY.md,
// OPTIMIZE_PLAN.md -> HANDOFF-OPTIMIZE.md, fixes.md -> HANDOFF-FIXES.md.
export function handoffFileFor(planFile) {
  const base = path.basename(String(planFile || "")).replace(/[.]md$/i, "").replace(/[-_. ]?plan$/i, "");
  const name = base.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "RUN";
  return `HANDOFF-${name}.md`;
}

// The hand-back file of the run on config.plan: its own name while a run-plan override points
// config.plan at a generated plan, HANDOFF.md otherwise. Project-relative. Shared by
// lib/handoff.js (which writes it), the alerts here and the builder's session context.
export function handoffFileName(root, config) {
  let over = null;
  try { over = runPlanOverride(root); } catch { over = null; }
  return over && config && over === config.plan ? handoffFileFor(over) : HANDOFF_FILE;
}

// PROGRESS.md lines look like "- 2026-09-27 S1.2 Title (attempt 2)". A built step's line
// ("... (built; verified with Phase 1)") is not an entry: the step gets its attempt line when its
// feature is verified, so counting both would count it twice.
export function progressEntries(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (/\(built; verified with Phase [^)]*\)\s*$/.test(line)) continue;
    const m = line.match(/^- (\d{4}-\d\d-\d\d) (\S+) (.*?)(?: \(attempt (\d+)\))?\s*$/);
    if (m) out.push({ date: m[1], id: m[2], title: m[3], attempt: m[4] ? Number(m[4]) : 1 });
  }
  return out;
}

// The text with fenced code blocks blanked out (kept as empty lines, so line numbers hold): the
// decisions template's "Entry format" example holds a D-### that is not a real entry.
export function outsideFences(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!fence) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) { fence = open[1]; out.push(""); } else out.push(line);
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
      out.push("");
    }
  }
  return out.join("\n");
}

// docs/DECISIONS.md entries: "## D-### (YYYY-MM-DD, <step>) Title" then "- Field: value" lines.
// Older entries without the bracket still count, with date and step null.
const ENTRY_RE = /^##[ \t]+(D-\d+|N-\d+)\b[ \t]*(?:\((\d{4}-\d\d-\d\d)(?:[ \t]*,[ \t]*([^)]*?))?[ \t]*\))?[ \t]*(.*?)[ \t]*$/;
const FIELD_RE = /^[ \t]*(?:[-*][ \t]+)?\**([A-Za-z][A-Za-z ]*?)\**[ \t]*:[ \t]*\**[ \t]*(.*?)[ \t]*$/;

export function parseDecisions(text) {
  const out = [];
  let cur = null;
  for (const line of outsideFences(text).split("\n")) {
    const m = line.match(ENTRY_RE);
    if (m) {
      cur = { id: m[1], kind: m[1][0] === "N" ? "note" : "decision", date: m[2] || null, step: m[3] ? m[3].trim() : null, title: m[4] || "", fields: {}, ownerReview: false };
      out.push(cur);
      continue;
    }
    if (/^#{1,2}[ \t]/.test(line)) { cur = null; continue; }
    if (!cur) continue;
    const f = line.match(FIELD_RE);
    if (f) {
      const key = f[1].trim().toLowerCase();
      const value = f[2].replace(/\*+$/, "").trim();
      if (!(key in cur.fields)) cur.fields[key] = value;
      if (key === "owner review" && /^yes\b/i.test(value)) cur.ownerReview = true;
    }
  }
  return out;
}

// Where a decisions log stands: the highest D-### and N-### numbers in it, 0 when there are
// none. Each new entry is numbered one above the highest already there, so the entries logged
// after this mark are exactly the later ones; a date cannot tell two runs of one day apart.
export function decisionsMark(text) {
  const mark = { D: 0, N: 0 };
  for (const e of parseDecisions(text)) {
    const n = Number(e.id.slice(2));
    if (n > mark[e.id[0]]) mark[e.id[0]] = n;
  }
  return mark;
}

// Logged during this run: numbered above `since` (a decisionsMark from the run's start) when
// that is known for the entry's kind, otherwise dated on or after sinceDate. An entry without a
// date counts.
function isNew(e, { since = null, sinceDate = null } = {}) {
  const top = since && typeof since === "object" ? since[e.id[0]] : undefined;
  if (Number.isInteger(top) && top >= 0) return Number(e.id.slice(2)) > top;
  return !sinceDate || !e.date || e.date >= sinceDate;
}

// Decisions the run made itself: not planning ones, not the owner's answers to a blocked
// question ("By: owner"), and not ones logged before the run started (see isNew), so a second
// run does not count the first run's.
export function runDecisions(entries, { since = null, sinceDate = null } = {}) {
  return entries.filter((e) => e.kind === "decision" && String(e.step || "").trim().toLowerCase() !== "planning" && !/^owner\b/i.test(String(e.fields.by || "").trim()) && isNew(e, { since, sinceDate }));
}

// Decisions marked "Owner review: yes"; with since or sinceDate, only this run's (an earlier
// run's were in its own hand-back).
export function ownerReviewDecisions(entries, { since = null, sinceDate = null } = {}) {
  return entries.filter((e) => e.kind === "decision" && e.ownerReview && isNew(e, { since, sinceDate }));
}

// Where the decisions log stood when the run started: state.decisionsAtStart, recorded by
// `autoclaude start`, or for a run started without it the log as committed at the run's base
// commit (start needs a clean tree, so that is the file as it was). null when neither is known,
// and the run's start date decides instead.
export function decisionsAtStart({ root, config, state, env = process.env }) {
  const m = state && state.decisionsAtStart;
  if (m && typeof m === "object" && (Number.isInteger(m.D) || Number.isInteger(m.N))) return m;
  const base = state && typeof state.baseCommit === "string" ? state.baseCommit.trim() : "";
  const rel = String((config && config.docs && config.docs.decisions) || "").replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  if (!/^[0-9a-f]{7,64}$/i.test(base) || !rel || path.isAbsolute(rel)) return null;
  try {
    const r = spawnSync("git", ["show", `${base}:./${rel}`], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 30000 });
    return r.status === 0 ? decisionsMark(r.stdout) : null;
  } catch {
    return null;
  }
}

// Markdown table rows. Header names (lower case) map the cells when the table has a header;
// otherwise `defaultColumns` does. Escaped pipes (\|) stay inside their cell.
export function parseTableRows(text, defaultColumns = []) {
  const lines = outsideFences(text).split("\n");
  const rows = [];
  const cellsOf = (line) => line.trim().replace(/^\|/, "").replace(/(?<!\\)\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
  const isSep = (line) => /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(line);
  let columns = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!/^\s*\|/.test(line)) { columns = null; continue; }
    if (isSep(line)) continue;
    if (columns === null && i + 1 < lines.length && isSep(lines[i + 1])) { columns = cellsOf(line).map((c) => c.toLowerCase()); continue; }
    const cells = cellsOf(line);
    const byName = {};
    // A short or missing header borrows the file's usual column names for the rest.
    cells.forEach((c, j) => { byName[(columns && columns[j]) || defaultColumns[j] || `col${j + 1}`] = c; });
    const status = "status" in byName ? byName.status : cells[cells.length - 1] || "";
    rows.push({ cells: byName, status, line: i + 1 });
  }
  return rows;
}

// A row stays open until its status says it was dealt with. "left for the owner" is open: the
// owner still has to act on it.
const CLOSED_RE = /^\s*(fixed|closed|done|resolved|won'?t[ -]?fix|wontfix|dropped|duplicate|invalid|not a bug|obsolete|superseded)\b/i;
export function isOpenStatus(status) {
  return !CLOSED_RE.test(String(status || ""));
}

const SECURITY_COLUMNS = ["date", "severity", "file", "issue", "fix", "status"];
const BLOCKER_COLUMNS = ["date", "found by", "step", "what", "owner", "status"];
const RANK = { high: 3, medium: 2, low: 1 };

// A follow-up the run handed to the owner (the template's "left for the owner: <reason>" status,
// or a row whose Owner column says owner).
const LEFT_RE = /^\s*left for (the )?owner\b/i;

// A findings file under docs/private/ is gitignored and never committed (P10.10, D58).
export function isPrivateDoc(rel) {
  return /^docs\/private\//i.test(String(rel || "").replace(/\\/g, "/").replace(/^(\.\/)+/, ""));
}

// Rows of the security findings file and the blockers file that are not closed, most severe
// first: [{ source: "security" | "follow-up", file, date, step, severity, text, status,
// leftForOwner, private }]. A row of a private findings file (docs/private/) carries no detail:
// its text names only the severity and the file, so HANDOFF.md (committed and pushed) and the
// alerts never repeat what the file keeps out of git.
export function unresolvedRows(root, config) {
  const out = [];
  const docs = (config && config.docs) || {};
  const sec = docs.security || "docs/private/SECURITY-FINDINGS.md";
  const blk = docs.blockers || "docs/BLOCKERS.md";
  const secret = isPrivateDoc(sec);
  for (const r of parseTableRows(readText(path.join(root, sec), ""), SECURITY_COLUMNS)) {
    if (!isOpenStatus(r.status)) continue;
    const c = r.cells;
    const severity = String(c.severity || "").trim().toLowerCase();
    const sev = RANK[severity] ? severity : null;
    const text = secret ? `${sev ? `${sev} ` : ""}security finding, details in ${sec} (kept out of git)` : [c.severity, c.file, c.issue].filter(Boolean).join(" ").trim();
    out.push({ source: "security", file: sec, date: c.date || null, step: null, severity: sev, text, fix: secret ? "" : c.fix || "", status: secret ? (LEFT_RE.test(r.status) ? "left for the owner" : "open") : r.status, leftForOwner: LEFT_RE.test(r.status), private: secret });
  }
  for (const r of parseTableRows(readText(path.join(root, blk), ""), BLOCKER_COLUMNS)) {
    if (!isOpenStatus(r.status)) continue;
    const c = r.cells;
    const what = c.what || "";
    const sev = (what.match(/^\s*(high|medium|low)\s*:/i) || [])[1];
    const left = LEFT_RE.test(r.status) || /^\s*owner\s*$/i.test(c.owner || "");
    out.push({ source: "follow-up", file: blk, date: c.date || null, step: c.step || null, severity: sev ? sev.toLowerCase() : null, text: [c.step, what].filter(Boolean).join(" ").trim(), owner: c.owner || "", status: r.status, leftForOwner: left });
  }
  return out.map((x, i) => ({ x, i })).sort((a, b) => (RANK[b.x.severity] || 0) - (RANK[a.x.severity] || 0) || a.i - b.i).map((p) => p.x);
}

// The body of the plan's "## After the run" section (fenced blocks kept, the next "## " heading
// ends it), or "" when the plan has none.
export function afterRunSection(planText) {
  const lines = String(planText || "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##[ \t]+After the run[ \t]*$/i.test(l));
  if (start < 0) return "";
  let end = lines.length;
  let fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*(```|~~~)/.exec(lines[i]);
    if (m) { fence = fence === null ? m[1] : fence === m[1] ? null : fence; continue; }
    if (fence === null && /^##[ \t]/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

// The section's top-level list items, first line each. A lone "Nothing..." item and the
// template's placeholder are not work for the owner.
export function afterRunItems(section) {
  const items = [];
  for (const line of outsideFences(section).split("\n")) {
    const m = line.match(/^(?:[-*+]|\d+[.)])[ \t]+(.*\S)/);
    if (m) items.push(m[1].trim());
  }
  return items.filter((t) => !/^not written yet\b/i.test(t) && !(items.length === 1 && /^nothing\b/i.test(t)));
}

// What the owner gets back, from the files the run keeps: the items left for them (the plan's
// "After the run" list plus follow-ups the run left for the owner), the other unresolved rows,
// decisions to review and the run's own decisions. Shared by the alert and HANDOFF.md.
export function collectHandback({ root, config, state, parsed, env = process.env }) {
  const planText = parsed && Array.isArray(parsed.lines) ? parsed.lines.join("\n") : readText(path.join(root, config.plan), "");
  const section = afterRunSection(planText);
  const rows = unresolvedRows(root, config);
  const left = rows.filter((r) => r.leftForOwner);
  const ownerItems = [
    ...afterRunItems(section).map((text) => ({ text, from: "plan" })),
    ...left.map((r) => ({ text: r.text, from: r.file, status: r.status }))
  ];
  const since = { since: decisionsAtStart({ root, config, state, env }), sinceDate: state && state.startedAt ? String(state.startedAt).slice(0, 10) : null };
  const decisions = parseDecisions(readText(path.join(root, config.docs.decisions), ""));
  return {
    afterRun: section,
    ownerItems,
    leftRows: left,
    openFindings: rows.filter((r) => !r.leftForOwner),
    ownerReviewDecisions: ownerReviewDecisions(decisions, since),
    runDecisions: runDecisions(decisions, since),
    notes: decisions.filter((e) => e.kind === "note" && isNew(e, since))
  };
}

function count(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

function clip(s, max = 140) {
  const t = String(s || "").replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

// Commits and tags not on the remote, as numbers, whatever shape the gate recorded them in.
function howMany(v) {
  if (Array.isArray(v)) return v.length;
  return typeof v === "number" && v > 0 ? v : 0;
}

// The push state (state.pushState, written by the gate after each feature) as a sentence
// without its label: "<branch> and its tags are on origin (...)." or "FAILED for <branch> ...".
export function pushStatus(pushState, config) {
  const on = !!(config && config.git && config.git.push);
  const ps = pushState && typeof pushState === "object" ? pushState : null;
  if (!ps) return on ? "nothing has been pushed yet." : "off (git.push is false), so nothing was pushed.";
  // The recorded time is UTC; say so, since the owner reads it in local time.
  const when = ps.at ? ` (${String(ps.at).replace("T", " ").slice(0, 16)} UTC)` : "";
  const branch = ps.branch || "the run branch";
  const remote = ps.remote ? `${ps.remote}` : "the remote";
  if (ps.skipped) return `skipped${when}${ps.error ? `: ${String(ps.error).split(/\r?\n/)[0].slice(0, 200)}` : ""}. Nothing is on ${remote} from this run.`;
  if (ps.ok) return `${branch} and its tags are on ${remote}${when}.`;
  const commits = howMany(ps.unpushedCommits);
  const tags = Array.isArray(ps.unpushedTags) ? ps.unpushedTags : [];
  const tagCount = tags.length || howMany(ps.unpushedTags);
  const left = [commits ? count(commits, "commit") : null, tagCount ? `${count(tagCount, "tag")}${tags.length ? ` (${tags.join(", ")})` : ""}` : null].filter(Boolean).join(" and ");
  const err = String(ps.error || "no error recorded").split(/\r?\n/)[0].slice(0, 200);
  return `FAILED for ${branch}${when}: ${err}.${left ? ` Not on the remote: ${left}.` : ""}`;
}

// One sentence on the push state, labelled.
export function pushLine(pushState, config) {
  const s = pushStatus(pushState, config);
  return s.startsWith("FAILED ") ? `Push ${s}` : `Push: ${s}`;
}

function fmtDuration(ms) {
  if (!(ms >= 0)) return "unknown";
  const min = Math.round(ms / 60000);
  if (min < 90) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const TOP = 3;

// sinceDate: "YYYY-MM-DD"; only progress lines on or after it count as "this period".
// handoff: the result of lib/handoff.js writeHandoff at plan completion, when there is one; its
// counts are then the ones reported, so the alert and HANDOFF.md agree.
export function buildSummary({ root, config, state, parsed, usage = null, now = Date.now(), sinceDate = null, handoff = null }) {
  const p = progress(parsed);
  const entries = progressEntries(readText(path.join(root, config.docs.progress), ""));
  const period = sinceDate ? entries.filter((e) => e.date >= sinceDate) : entries;
  const attempts = period.reduce((n, e) => n + e.attempt, 0);
  const firstTry = period.filter((e) => e.attempt === 1).length;
  const started = state.startedAt ? Date.parse(state.startedAt) : null;
  const complete = state.status === "complete";
  const s = handoff && handoff.summary ? handoff.summary : null;
  const got = collectHandback({ root, config, state, parsed });
  // A hand-back field of an unexpected shape falls back to what the files say.
  const list = (key, fallback) => (s && Array.isArray(s[key]) ? s[key] : fallback);
  const runCount = s && typeof s.runDecisions === "number" ? s.runDecisions : s && Array.isArray(s.runDecisions) ? s.runDecisions.length : got.runDecisions.length;

  const lines = [];
  const built = typeof p.built === "number" && p.built ? `, ${p.built} built and waiting for their feature's verification` : "";
  lines.push(`Steps: ${p.done}/${p.total} verified${sinceDate ? `, ${period.length} since ${sinceDate}` : ""}${built}${p.failed ? `, ${p.failed} failed` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}.`);
  if (period.length) lines.push(`Attempts: ${attempts} for ${count(period.length, "step")} (${firstTry} passed first time).`);
  lines.push(`Decisions the run made: ${runCount}${got.notes.length ? `, owner notes handled: ${got.notes.length}` : ""}.`);
  const reviewList = list("ownerReviewDecisions", got.ownerReviewDecisions);
  if (reviewList.length) {
    const top = reviewList.slice(0, TOP).map((d) => `${d.id} ${clip(d.title, 80)}`).join("; ");
    lines.push(`For your review: ${count(reviewList.length, "decision")} marked "Owner review: yes": ${top}${reviewList.length > TOP ? ` (+${reviewList.length - TOP} more)` : ""}.`);
  }
  // Mid-run (the morning summary) the plan's own "After the run" list is not news; only what the
  // run has handed over so far is.
  const ownerList = list("ownerItems", complete ? got.ownerItems : got.ownerItems.filter((i) => i.from !== "plan"));
  const secrets = list("secretsCreated", []);
  if (ownerList.length || secrets.length || complete) {
    const top = ownerList.slice(0, TOP).map((i) => clip(typeof i === "string" ? i : i.text, 100)).join("; ");
    lines.push(`Left for you: ${ownerList.length ? `${count(ownerList.length, "item")}: ${top}${ownerList.length > TOP ? ` (+${ownerList.length - TOP} more)` : ""}` : "nothing"}${secrets.length ? `. The run created ${count(secrets.length, "secret file")} in secrets/` : ""}.`);
  }
  const openList = list("openFindings", got.openFindings);
  if (openList.length) {
    const sec = openList.filter((f) => f.source === "security").length;
    const fol = openList.length - sec;
    const kinds = [sec ? count(sec, "security finding") : null, fol ? count(fol, "follow-up") : null].filter(Boolean).join(", ");
    const top = openList.slice(0, TOP).map((f) => clip(f.text, 100)).join("; ");
    lines.push(`Open items: ${kinds}. Top: ${top}${openList.length > TOP ? ` (+${openList.length - TOP} more)` : ""}.`);
  } else {
    lines.push("Open items: none.");
  }
  if (s) lines.push(`Hand-back: ${path.basename(handoff.path || handoffFileName(root, config))} in the project folder.`);
  else if (complete && handoffIsFresh(root, config, state)) lines.push(`Hand-back: ${handoffFileName(root, config)} in the project folder.`);
  lines.push(pushLine(s ? s.push : state.pushState, config));
  if (s && s.footprint) {
    const f = s.footprint;
    const bits = [
      f.removed && f.removed.length ? `removed ${f.removed.length} unused thing${f.removed.length === 1 ? "" : "s"} the run created` : null,
      f.runningCreated && f.runningCreated.length ? `${count(f.runningCreated.length, "container")} it started still running` : null,
      f.kept && f.kept.length ? `kept ${f.kept.length}` : null,
      f.unattributed && f.unattributed.length ? `left alone ${f.unattributed.length} not tied to this project` : null
    ].filter(Boolean);
    if (bits.length) lines.push(`Docker: ${bits.join(", ")}.`);
  }
  if (usage && usage.sevenDay) {
    const used = typeof state.usageAtStart === "number" ? ` (${Math.max(0, Math.round(usage.sevenDay.pct - state.usageAtStart))} points this run)` : "";
    lines.push(`Weekly usage: ${Math.round(usage.sevenDay.pct)}%${used}.`);
  }
  if (started) lines.push(`Elapsed: ${fmtDuration(now - started)}.`);
  if (state.status === "paused") lines.push(`Now: paused (${state.pauseReason || "?"}) at ${state.currentStep || "?"}.`);
  else if (state.status === "running") lines.push(`Now: running ${state.currentStep || "?"}.`);
  return lines.join("\n");
}

// The run's hand-back (HANDOFF.md, or HANDOFF-<NAME>.md for a run on a generated plan) written
// during this run (not one left from an earlier run).
function handoffIsFresh(root, config, state) {
  try {
    const st = fs.statSync(path.join(root, handoffFileName(root, config)));
    const started = state.startedAt ? Date.parse(state.startedAt) : NaN;
    return !(started > st.mtimeMs);
  } catch {
    return false;
  }
}
