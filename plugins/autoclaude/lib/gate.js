// The Stop gate: PLAN.md section 4.4, with per-feature verification (D49). Called by
// scripts/stop-gate.js with the hook input. Returns { decision: "allow" | "block", reason,
// events } so scenario tests can assert on it without parsing stdout. Every side effect goes
// through the libs; nothing here is Windows-specific.
//
// gate.verifyAt "phase" (the default): a ready inside a phase commits the step as built [~]
// with no checks; the step that closes the phase verifies the whole phase at once (every check,
// the browser tester over every Accept line, the bug bash, the security review), gives any
// non-blocking findings a fix-up pass, then commits, tags and pushes. "step" verifies every step
// the way 0.9 did. Either way the plan ticks and PROGRESS lines are written before the checks
// and taken out again on a failure, so the tree that is verified is the tree that is committed.
//
// One stop has gate.timeoutSec, at most the hook's own timeout. The checks and the checkers run
// against a deadline inside it. A verification's parts (each check, the browser tester, the bug
// bash, the security review, which by default runs alongside the browser checks) run as far as
// they fit, each weighed by what it is expected to need; what does not fit is carried to the next
// stop (state.verifying, D60), and the builder is told to end its turn. The checks of a fix-up
// pass, and a step's second run of the checks with its findings filed, are staged the same way.
// A part that does not fit even in a stop of its own is "out of time", never the builder's
// attempt, and pauses the run the second time. What a gate cut off by the hook leaves behind is picked up by the next
// stop: a verification under way is undone (and counted), and a verified commit under way
// (state.closing) or the end of the run (state.completing) is finished.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { findProjectRoot, projectPaths, pluginRoot } from "./paths.js";
import { isBuilderSession, liveSupervisorPid } from "./builder.js";
import { loadState, saveState, updateState, STATUS, finishRunPlan } from "./state.js";
import { loadConfig, DEFAULTS, MAX_GATE_TIMEOUT_SEC } from "./config.js";
import { parsePlan, stepById, nextStep, firstUnfinished, isPhaseEnd, isFeatureEnd, isFinished, setMarker, stepText, progress, planSlug, MARKERS } from "./plan.js";
import { readText, readJson, writeFileAtomic, writeJsonAtomic, appendLine, ensureDir } from "./fsatomic.js";
import { pendingVerifyFile, undoCutVerification, undoVerification, liveOtherGate, heldByLiveGate, phaseTag, verifyModeFor, reopenForMode, verifyPartName } from "./resume.js";
import { readReady, clearReady, readBlocked, clearBlocked, readHeartbeat } from "./protocol.js";
import { runChecks, MIN_CHECK_MS, DEFAULT_CHECK_TIMEOUT_SEC } from "./checks.js";
import { writeReport, checkFailureSection, summarize, fence } from "./report.js";
import { restartDevServer, stopDevServer } from "./devserver.js";
import { runBrowserCheck, browserTimeoutSec, acceptCount, KINDS, untrackedSet, sweepStrays } from "./tester.js";
import { runSecurityReview, securityWanted } from "./security.js";
import { buildSummary, isOpenStatus } from "./summary.js";
import * as git from "./git.js";
import { notify } from "./notify.js";
import { readUsage } from "./usage.js";

const MAX_REASON = 4000;
// The informational alerts and whether each is on when notify.events does not say (D49).
// lib/notify.js owns the real list; this is only the fallback for an older notify.js.
const EVENT_DEFAULTS = Object.freeze({ featureVerified: true, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false });
// Seconds of a stop kept after the checkers, for the commit, the tag and the push.
export const RESERVE_SEC = 60;
// The checks and the checkers of a stop never get less than this, whatever gate.timeoutSec.
export const MIN_STOP_PARTS_SEC = 120;
// A checker is not started with less of the gate's time than this for it.
const MIN_CHECKER_MS = 60000;
// The end of the run in a stop that already verified the last feature: the machine clean-up
// starts only with this much left on top of the hand-back's share, the hand-back with its share.
const FOOTPRINT_MIN_MS = 90000;
const HANDBACK_MS = 45000;
// The Docker bookkeeping after the checks is best effort and short.
const NOTE_FOOTPRINT_MS = 30000;
// A check's recent time with a quarter on top is what it is expected to need (D60).
const CHECK_HEADROOM = 1.25;
// A verification carried over between stops starts again when the files change in between; the
// third time the run pauses instead of starting it again all night.
const MAX_STAGED_RESTARTS = 2;

export function cliCommand(env = process.env) {
  // What the builder should type. Claude's Bash tool is Git Bash on Windows, which resolves the
  // extensionless shim only, so that is the one that counts; fall back to the node invocation.
  const dirs = (env.PATH || env.Path || "").split(path.delimiter);
  const hasShim = dirs.some((d) => d && fs.existsSync(path.join(d, "autoclaude")));
  if (hasShim) return "autoclaude";
  // pluginRoot() goes through fileURLToPath: a URL pathname would print %20 for a space.
  return `node "${path.join(pluginRoot(), "bin", "autoclaude.js").replace(/\\/g, "/")}"`;
}

function nowIso(deps) { return (deps.now ? deps.now() : new Date()).toISOString(); }
function nowMs(deps) { return deps.now ? deps.now().getTime() : Date.now(); }

// The seconds one stop has for a verification's parts (the checks and the checkers): its
// gate.timeoutSec less RESERVE_SEC for the commit, the tag and the push, never under
// MIN_STOP_PARTS_SEC. runGate sets its deadline by it; lib/estimate.js sizes phases by it.
export function stopPartsSec(config) {
  const t = Number(config && config.gate ? config.gate.timeoutSec : NaN);
  return Math.max(MIN_STOP_PARTS_SEC, (t > 0 ? t : DEFAULTS.gate.timeoutSec) - RESERVE_SEC);
}

// "phase" unless the project asks for the old per-step verification, everywhere or (with the
// phase's number, gate.stepPhases: `autoclaude verify-per-step`) for that phase.
export function verifyMode(config, phaseNum = null) {
  return verifyModeFor(config, phaseNum);
}

// Another module's export, loaded on first use. A module that is missing or half-written (a
// partial install, a test) gives null instead of breaking the gate.
async function lazyExport(spec, name) {
  try {
    const m = await import(spec);
    return typeof m[name] === "function" ? m[name] : null;
  } catch {
    return null;
  }
}

// Why a configured check did not run, in words the builder can act on. The usual case is a
// needsDevServer check in a project with no dev server set up, which the builder cannot fix by
// editing the (read-only) config.
export function notRunReason(result, config, cli = "autoclaude", step = null) {
  const why = result.reason || "no reason recorded";
  const ds = config.devServer || {};
  const needs = (config.checks || []).some((c) => c.name === result.name && c.needsDevServer);
  if (needs && !(ds.command && ds.url)) {
    return `it needs the dev server (needsDevServer), but devServer.command and devServer.url are not both set in autoclaude.config.json, which is read-only during a run. If the step cannot pass without it, run \`${cli} blocked ${step ? step.id : "<step>"} "<what the check needs>"\``;
  }
  return why;
}

const BLOCKERS_HEADER = "# BLOCKERS\n\nFollow-ups the AutoClaude gate found that did not fail a step. One row each, appended; close a row by changing its status.\n\n| Date | Found by | Step | What | Owner | Status |\n|---|---|---|---|---|---|\n";
const SECURITY_HEADER = "# SECURITY-FINDINGS\n\nFindings from the AutoClaude security reviewer that did not fail a step. One row each, appended; close a row by changing its status.\n\n| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n";
const cell = (s) => String(s || "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();

// Non-blocking security findings, one row each in the security findings file (the template's
// table: Date | Severity | File | Issue | Fix | Status).
function securityRows(step, findings, date) {
  return findings.map((f) => {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    return `| ${date} | ${cell(f.severity)} | ${cell(where)} | ${cell(f.issue)} (found at ${step.id}) | ${cell(f.fix)} | open |`;
  });
}

// Medium and low bugs, and possible weakened tests, from a passing browser check: one row each
// in the blockers file (the template's table).
function followUpRows(step, items, date) {
  const part = (label, s) => (s ? `${label}${String(s).trim().replace(/[.\s]+$/, "")}` : null);
  return items.map((b) => {
    const what = [part(`${b.severity}: `, b.title), part("Actual: ", b.actual), part("Expected: ", b.expected), part("Repro: ", b.repro)].filter(Boolean).join(". ") + ".";
    return `| ${date} | ${b.foundBy === "bugbash" ? "bug bash" : "browser tester"} | ${step.id} | ${cell(what)} | Claude | open |`;
  });
}

// Files the findings rows of a passed verification, committed with it: docs is [{ file, header,
// lines }]. They go into the verification's snapshot first, so a gate cut off from here on takes
// them out with its ticks instead of filing them twice. Returns [{ file, text, created }].
function fileRows(g, snap, docs) {
  const entries = [];
  for (const d of docs) {
    if (!d.lines.length) continue;
    const abs = path.join(g.root, d.file);
    const cur = readText(abs, null);
    const created = cur === null;
    const lead = !created && cur && !cur.endsWith("\n") ? "\n" : "";
    entries.push({ file: d.file, abs, created, text: (created ? d.header : lead) + d.lines.map((l) => `${l}\n`).join("") });
  }
  if (!entries.length) return [];
  writeJsonAtomic(pendingVerifyFile(g.root), { ...snap, rows: entries.map(({ file, text, created }) => ({ file, text, created })) });
  for (const e of entries) {
    ensureDir(path.dirname(e.abs));
    fs.appendFileSync(e.abs, e.text);
  }
  return entries;
}

// Owner notes and an owner answer not yet passed to the builder in a gate message. The text goes
// in front of the gate's reason (so truncation never cuts it); `mark` flags them as delivered.
// Session-start injection still repeats everything pending until the step passes.
export function ownerInput(state, config) {
  const notes = (state.pendingNotes || []).filter((n) => !n.delivered);
  const ans = state.ownerAnswer && state.ownerAnswer.answer && !state.ownerAnswer.delivered ? state.ownerAnswer : null;
  if (!notes.length && !ans) return { text: "", mark: (s) => s };
  const parts = [];
  if (ans) parts.push(`OWNER ANSWER to your blocked question "${ans.question}": ${ans.answer} (recorded as ${ans.decisionId || "a decision"}). Act on it first.`);
  if (notes.length) parts.push(`OWNER REVIEW NOTES, act on these first and record how you handled each in ${config.docs.decisions} as N-###:\n${notes.map((n) => `- ${n.text}`).join("\n")}`);
  const mark = (s) => ({
    ...s,
    pendingNotes: (s.pendingNotes || []).map((n) => ({ ...n, delivered: true })),
    ownerAnswer: s.ownerAnswer ? { ...s.ownerAnswer, delivered: true } : null
  });
  return { text: parts.join("\n\n") + "\n\n", mark };
}

// The fix-up list: every non-blocking finding of a verified feature, where it was filed, and
// the row it was filed as (rows.followUps and rows.security, in the findings' order).
function fixupFindings(config, followUps, securityFindings, rows = {}) {
  const cut = (s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > 200 ? t.slice(0, 197) + "..." : t; };
  return [
    ...followUps.map((b, i) => ({ source: b.foundBy === "bugbash" ? "bug bash" : "browser tester", severity: b.severity || "low", text: cut(b.title || b.actual), doc: config.docs.blockers, row: (rows.followUps || [])[i] || null })),
    ...securityFindings.map((f, i) => ({ source: "security review", severity: f.severity || "low", text: cut(`${f.line ? `${f.file}:${f.line}` : f.file || "?"}: ${f.issue}`), doc: config.docs.security, row: (rows.security || [])[i] || null }))
  ];
}

function fixupText(g, fixup) {
  const { config, cli } = g;
  const n = fixup.findings.length;
  const list = fixup.findings.map((f, i) => `${i + 1}. [${f.source}, ${f.severity}] ${f.text} (${f.doc})`).join("\n");
  return `Phase ${fixup.phase} passed its verification, with ${n} non-blocking finding${n === 1 ? "" : "s"} to handle before the feature closes. For each one: fix it and set its row's Status to "fixed", or leave it for the owner: set its row's Status to "left for the owner: <why, and what fixing it would take>" (in ${config.docs.blockers} also set Owner to "owner"). Then run \`${cli} ready ${fixup.stepId}\`: the checks run once more and the feature closes. Do not start the next step yet.\n\nFindings:\n${list}`;
}

// A table row's cells, as written (an escaped \| stays inside its cell).
function rowCells(line) {
  return String(line).trim().replace(/^\|/, "").replace(/(?<!\\)\|\s*$/, "").split(/(?<!\\)\|/).map((c) => c.trim());
}

const HANDED_OVER = /^\s*left for (the )?owner\s*:\s*\S.{2,}/i;
// The first four cells (date and what was found) identify a row; the builder changes only the
// last ones (Owner, Status).
const ROW_KEY_CELLS = 4;

// The fix-up findings whose rows have no outcome yet: neither closed ("fixed") nor handed over
// ("left for the owner: <why>"), or no longer in their file at all. Each gets `status` (the
// row's status, null when the row is gone). A row is found by its first four cells as the gate
// wrote them, else (the builder added a note to the text) by the first three with the text the
// gate wrote still in the fourth. A finding recorded without its row (a fix-up pass from an
// older version) is not checked.
export function openFixupFindings(root, findings) {
  const docs = new Map();
  const list = (findings || []).filter((f) => f && f.row && f.doc);
  const found = new Map();
  for (const exact of [true, false]) {
    for (const f of list) {
      if (found.has(f)) continue;
      if (!docs.has(f.doc)) docs.set(f.doc, { lines: (readText(path.join(root, f.doc), "") || "").split(/\r?\n/), used: new Set() });
      const d = docs.get(f.doc);
      const want = rowCells(f.row);
      const key = want.slice(0, exact ? ROW_KEY_CELLS : ROW_KEY_CELLS - 1).join("\u0000");
      const text = want[ROW_KEY_CELLS - 1] || "";
      if (!exact && !text) continue;
      for (let i = d.lines.length - 1; i >= 0; i--) {
        if (d.used.has(i) || !/^\s*\|/.test(d.lines[i])) continue;
        const cells = rowCells(d.lines[i]);
        if (cells.slice(0, exact ? ROW_KEY_CELLS : ROW_KEY_CELLS - 1).join("\u0000") !== key) continue;
        if (!exact && !String(cells[ROW_KEY_CELLS - 1] || "").includes(text)) continue;
        d.used.add(i);
        found.set(f, cells[cells.length - 1] || "");
        break;
      }
    }
  }
  const open = [];
  for (const f of list) {
    const status = found.has(f) ? found.get(f) : null;
    if (status === null || (isOpenStatus(status) && !HANDED_OVER.test(status))) open.push({ ...f, status });
  }
  return open;
}

const ROW_PUT_BACK = "left for the owner: its row was deleted during the fix-up pass instead of given a status, so the gate put it back; check whether it was fixed";

// Rows of fix-up findings that are gone from their files (the builder deleted the row instead of
// setting its status): the gate wrote them, so it writes them back, handed to the owner (Status
// "left for the owner: ...", and Owner "owner" in the blockers file). A deleted row can then
// never hold a feature open, and the hand-back still lists the finding. Returns how many.
function putBackRows(g, gone) {
  const byDoc = new Map();
  for (const f of gone) {
    const cells = rowCells(f.row);
    if (cells.length < 2) continue;
    cells[cells.length - 1] = ROW_PUT_BACK;
    const security = f.doc === g.config.docs.security;
    if (!security && cells.length >= 6) cells[4] = "owner";
    if (!byDoc.has(f.doc)) byDoc.set(f.doc, { header: security ? SECURITY_HEADER : BLOCKERS_HEADER, lines: [] });
    byDoc.get(f.doc).lines.push(`| ${cells.join(" | ")} |`);
  }
  let n = 0;
  for (const [doc, { header, lines }] of byDoc) {
    const abs = path.join(g.root, doc);
    const cur = readText(abs, null);
    const lead = cur === null ? header : cur && !cur.endsWith("\n") ? "\n" : "";
    ensureDir(path.dirname(abs));
    fs.appendFileSync(abs, lead + lines.map((l) => `${l}\n`).join(""));
    n += lines.length;
  }
  return n;
}

// Which Accept lines (and so which steps) a failed feature verification names: the tester's
// [FAIL] criteria matched against every Accept line of the phase, a [FAIL] criterion that names
// a step id, and a failing check whose output names a step's Test: file.
export function failingAcceptLines(steps, sections, failedCheck = null) {
  const norm = (t) => String(t || "").toLowerCase().replace(/[`"'*_]/g, "").replace(/\s+/g, " ").trim();
  const fails = [];
  for (const s of sections || []) {
    for (const line of String(s.body || "").split(/\r?\n/)) {
      const m = line.match(/^\s*-\s*\[FAIL\]\s*(.+)$/);
      if (m) fails.push({ raw: m[1].trim(), norm: norm(m[1]) });
    }
  }
  const out = [];
  const add = (step, accept, via) => { if (!out.some((o) => o.step === step && o.accept === accept)) out.push({ step, accept, via }); };
  const matched = new Set();
  for (const st of steps) {
    for (const a of st.accept) {
      const na = norm(a).slice(0, 80);
      if (!na) continue;
      for (const f of fails) {
        if (f.norm.includes(na) || (f.norm.length >= 15 && na.includes(f.norm.slice(0, 80)))) { add(st.id, a, "tester"); matched.add(f); }
      }
    }
  }
  for (const f of fails) {
    if (matched.has(f)) continue;
    const st = steps.find((s) => new RegExp(`\\b${s.id.replace(/\./g, "\\.")}\\b`, "i").test(f.raw));
    if (st) add(st.id, f.raw, "tester");
  }
  if (failedCheck) {
    const text = [failedCheck.tail, failedCheck.stdout, failedCheck.stderr].filter(Boolean).join("\n");
    for (const st of steps) {
      const named = st.test.filter((t) => text.includes(t) || text.includes(path.basename(t)));
      if (named.length) add(st.id, `(the failing check's output names its test ${named.join(", ")})`, "check");
    }
  }
  return out;
}

function logLine(root, text) {
  try { appendLine(path.join(root, ".autoclaude", "logs", "gate.log"), `${new Date().toISOString()} ${text}`); } catch {}
}

function block(reason, events) {
  return { decision: "block", reason: reason.length > MAX_REASON ? reason.slice(0, MAX_REASON - 60) + "\n[... truncated ...]" : reason, events };
}

function allow(events) {
  return { decision: "allow", reason: null, events };
}

// The state as it is on disk now, when the owner paused it while this gate was verifying.
function pausedMeanwhile(root) {
  const now = loadState(root);
  return now.status === STATUS.paused ? now : null;
}

const noteKey = (n) => `${n && n.at}\u0000${n && n.text}`;

// The owner's pause request as it stands: changed on disk while this gate ran (`autoclaude
// pause`, or `resume` withdrawing one) means the owner's value; otherwise the gate's own.
function ownerPauseRequest(g, disk, own) {
  return !!disk.pauseRequested !== g.loaded.pauseRequested ? !!disk.pauseRequested : !!own;
}

// Every state save of the gate goes through here. The gate builds its state from what it loaded
// when the stop began, and a verification can take half an hour: `autoclaude pause` and
// `autoclaude note` made meanwhile, and the ids the supervisor and the session hook keep, would
// otherwise be overwritten (seen in review: a pause request made during a feature's
// verification was lost, and the run carried on).
function save(g, next) {
  const disk = loadState(g.root);
  const out = { ...next };
  for (const k of ["supervisorPid", "windowTitle", "builderSessionId", "sessionId"]) out[k] = disk[k];
  const known = new Set([...(next.pendingNotes || []).map(noteKey), ...g.loaded.notes]);
  out.pendingNotes = [...(next.pendingNotes || []), ...(disk.pendingNotes || []).filter((n) => !known.has(noteKey(n)))];
  if (out.status === STATUS.running) out.pauseRequested = ownerPauseRequest(g, disk, out.pauseRequested);
  // The run was running when this gate began, so a pause on disk is the owner's (`pause --now`);
  // the paths that can take long check for it themselves, and this keeps it on any other.
  if (out.status === STATUS.running && disk.status === STATUS.paused) Object.assign(out, { status: STATUS.paused, pauseReason: disk.pauseReason || "review", haltSession: !!disk.haltSession });
  return saveState(g.root, out);
}

function fmtMinutes(ms) {
  if (!(ms >= 0)) return null;
  const min = Math.round(ms / 60000);
  return min < 90 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;
}

function secs(ms) {
  return `${Math.round((Number(ms) || 0) / 1000)} s`;
}

// The plan and PROGRESS.md as they were before a verification wrote its ticks, with the ticks,
// the lines and the findings rows it wrote (lib/resume.js pendingVerifyFile). Kept on disk while
// the checks run, so a gate cut off by the hook's timeout, or ended with its session by `pause
// --now`, is undone by the next gate, the supervisor or `autoclaude resume`, whichever comes
// first. It goes only once the run state records the verification's outcome.
function clearPending(root) {
  try { fs.rmSync(pendingVerifyFile(root), { force: true }); } catch {}
}

// What is left of this stop's time (gate.timeoutSec, at most the hook's own timeout), in ms.
function timeLeft(g) {
  return g.startedMs + g.config.gate.timeoutSec * 1000 - g.clock();
}

// Budget for one git call of a push: what is left of this stop's time over the four network
// calls a push with its retry can make. A push that outlives the hook would be killed with it.
function pushTimeoutMs(g) {
  const left = timeLeft(g) - 10000;
  return Math.max(5000, Math.min(120000, Math.floor(left / 4)));
}

// Notes which new Docker objects tie to this project while they still exist (lib/footprint.js
// noteFootprint), after each verification's checks, so the end of the run can tell the run's
// objects from anyone else's. Best effort and short; never in the verification's way.
async function noteFootprintNow(g) {
  if (g.config.footprint && g.config.footprint.docker === false) return;
  const note = "noteFootprint" in g.deps ? g.deps.noteFootprint : await lazyExport("./footprint.js", "noteFootprint");
  if (!note) return;
  try {
    const r = await note(g.root, { config: g.config, deadline: Date.now() + Math.max(0, Math.min(NOTE_FOOTPRINT_MS, g.deadlineMs - g.clock())) });
    if (r && r.ok === false && r.reason) logLine(g.root, `footprint note skipped: ${r.reason}`);
  } catch (e) {
    logLine(g.root, `footprint note failed: ${e && e.message ? e.message : e}`);
  }
}

// The check times this project has on record (lib/checks.js readCheckTimes: { "<name>": {
// recentMs, medianMs } }), or {} when it has none or the install's checks.js cannot say.
async function recordedCheckTimes(g) {
  const read = "readCheckTimes" in g.deps ? g.deps.readCheckTimes : await lazyExport("./checks.js", "readCheckTimes");
  if (!read) return {};
  try {
    const t = await read(g.root);
    return t && typeof t === "object" ? t : {};
  } catch {
    return {};
  }
}

// Every run of the checks goes on record (lib/checks.js recordCheckTimes), so the next estimate
// uses recent times. Best effort: an install without it, or a failed write, changes nothing.
async function recordCheckTimesNow(g, results) {
  // A check stopped at the gate's deadline has no time of its own to give.
  const ran = (results || []).filter((r) => r && r.ran && !r.outOfTime);
  if (!ran.length) return;
  const rec = "recordCheckTimes" in g.deps ? g.deps.recordCheckTimes : await lazyExport("./checks.js", "recordCheckTimes");
  if (!rec) return;
  try { await rec(g.root, ran); } catch (e) { logLine(g.root, `could not record the check times: ${e && e.message ? e.message : e}`); }
}

function median(list) {
  const xs = (Array.isArray(list) ? list : []).map(Number).filter((n) => n > 0).sort((a, b) => a - b);
  if (!xs.length) return 0;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

// A check's recent time on this computer, in ms (lib/checks.js readCheckTimes: its median, else
// the median of its recent times); 0 when none is on record.
export function recordedCheckMs(check, times = {}) {
  const t = times && check ? times[check.name] : null;
  const ms = t && Number(t.medianMs) > 0 ? Number(t.medianMs) : median(t && t.recentMs);
  return ms > 0 ? ms : 0;
}

// What a check is expected to need, in ms: its recent time on record with a quarter on top, else
// its timeoutSec; never more than its timeoutSec (it is stopped there), never less than the least
// a check is started with. lib/estimate.js counts a check the same way.
export function expectedCheckMs(check, times = {}) {
  const capMs = (Number(check && check.timeoutSec) > 0 ? Number(check.timeoutSec) : DEFAULT_CHECK_TIMEOUT_SEC) * 1000;
  const ms = recordedCheckMs(check, times);
  if (!(ms > 0)) return capMs;
  return Math.max(MIN_CHECK_MS, Math.min(capMs, Math.ceil(ms * CHECK_HEADROOM)));
}

// The most a single part of a verification may need: gate.fitPct percent of the seconds a stop
// has for its parts (stopPartsSec), in whole seconds. lib/estimate.js sizes phases by it.
export function fitLimitSec(config) {
  const g = (config && config.gate) || DEFAULTS.gate;
  return Math.floor((stopPartsSec(config) * (typeof g.fitPct === "number" && g.fitPct > 0 ? g.fitPct : DEFAULTS.gate.fitPct)) / 100);
}

// What the checkers are expected to need (D60), fitted to measured runs.
// The browser tester: a fixed cost plus a cost per Accept line it checks in the browser. The DB
// run's one-step features took 68 to 125 s for 3 to 5 Accept lines (16 to 27 turns), the practice
// app's two-step feature 110 s for 9 lines. The fixed part is the session start, Playwright MCP
// connecting through npx, the browser and the verdict; a line is a few browser actions. Both sit
// at the top of what was measured, so a feature is over-estimated rather than under.
export const TESTER_BASE_SEC = 50;
export const TESTER_SEC_PER_LINE = 15;
// The bug bash has no list to work through: it explores until its turns run out (tester.maxTurns
// times 1.5, 60 by default; seen live wrapping up at that limit). Practice runs took 128 to 300 s
// for 26 to 43 turns, about 7 s a turn, so a whole budget is about 420 s, under half of its own
// limit (tester.timeoutSec, 900 by default).
export const BUGBASH_SEC_PER_TURN = 7;
// The security review reads the feature's diff. The DB runs' 30 reviews took 24 to 187 s, 77 s
// on average, whole features of up to 9 steps among them; 180 s covers nearly all of them and is
// a fifth of its own limit (security.timeoutSec, 900 by default).
export const SECURITY_SEC = 180;

// A checker's own limit, in seconds, where it is stopped: tester.timeoutSec (the tester's scaled
// by its Accept lines, lib/tester.js browserTimeoutSec), security.timeoutSec for the security
// review. `opts` is { step } or { steps }, as the checker is run.
function checkerLimitSec(kind, config, opts = {}) {
  if (kind === "security") return Number(config.security && config.security.timeoutSec) > 0 ? Number(config.security.timeoutSec) : SECURITY_SEC;
  return browserTimeoutSec(kind, config, opts);
}

// What a checker ("tester", "bugbash" or "security") is expected to need by the model above, in
// seconds, never more than its own limit: the tester its fixed cost and a cost per Accept line of
// the steps it checks (those of `steps` not tagged no-ui, else `step`), the bug bash its whole turn
// budget, the security review SECURITY_SEC. lib/estimate.js counts a checker's part by this, and
// the gate weighs it by this with a quarter on top (expectedCheckerMs).
export function checkerNeedSec(kind, config, { step = null, steps = null } = {}) {
  const limit = checkerLimitSec(kind, config, { step, steps });
  if (kind === "tester") {
    const list = Array.isArray(steps) && steps.length ? steps.filter((s) => !(Array.isArray(s.tags) && s.tags.includes("no-ui"))) : step ? [step] : [];
    return Math.min(limit, TESTER_BASE_SEC + TESTER_SEC_PER_LINE * acceptCount(list));
  }
  if (kind === "bugbash") return Math.min(limit, Math.round(config.tester.maxTurns * KINDS.bugbash.turnsFactor) * BUGBASH_SEC_PER_TURN);
  return Math.min(limit, SECURITY_SEC);
}

// What the gate weighs a checker by before it starts it after another part of the same stop, in
// ms: what it is expected to need (checkerNeedSec) with a quarter on top, as for a check, never
// more than its own limit or than the most a part may need (fitLimitSec). Not its worst case: a
// tester weighed by its scaled timeout (1800 s for 6 to 10 Accept lines) never started after any
// check. Its run still gets the gate's real deadline, so one that overruns is stopped there and
// carried to the next stop.
export function expectedCheckerMs(kind, config, opts = {}) {
  const need = Math.ceil(checkerNeedSec(kind, config, opts) * CHECK_HEADROOM * 1000);
  return Math.min(checkerLimitSec(kind, config, opts) * 1000, fitLimitSec(config) * 1000, need);
}

// Who closes a phase's feature (verifyAt "phase"), for the messages: "S1.3, the step that closes
// the phase,". That is its last step not yet done or built (isFeatureEnd; session-context.js says
// the same), which is not the phase's last once the owner has ticked that one.
function closerText(parsed, phaseNum) {
  const ph = parsed && parsed.phases ? parsed.phases.find((p) => p.num === phaseNum) : null;
  const open = ph ? ph.steps.filter((s) => !isFinished(s)) : [];
  return open.length ? `${open[open.length - 1].id}, the step that closes the phase,` : "the step that closes the phase";
}

// The commit a feature started from, when the state lost it (a restarted run) but the feature
// has built steps: the parent of the gate's oldest commit of one of them.
async function builtFeatureBase(g, phase) {
  for (const s of phase ? phase.steps.filter((x) => x.marker === MARKERS.built) : []) {
    const r = await git.git(g.root, ["log", "--format=%H", "-F", `--grep=autoclaude(${s.id}): `, "HEAD"], { env: g.env });
    const oldest = r.ok ? r.stdout.split(/\r?\n/).filter(Boolean).pop() : null;
    if (!oldest) continue;
    const p = await git.git(g.root, ["rev-parse", "--verify", "-q", `${oldest}^`], { env: g.env });
    if (p.ok && p.stdout.trim()) return p.stdout.trim();
  }
  return null;
}

// The D-### entries in the decisions file that the last commit does not have yet.
async function decisionsSince(g) {
  const rel = g.config.docs.decisions;
  const now = readText(path.join(g.root, rel), "") || "";
  const before = (await git.showFile(g.root, "HEAD", rel, { env: g.env })) || "";
  const re = /^#{2,4}[ \t]+(D-\d+)\b[^\r\n]*/gm;
  const old = new Set([...before.matchAll(re)].map((m) => m[1]));
  const out = [];
  for (const m of now.matchAll(re)) if (!old.has(m[1])) out.push(m[0].replace(/^#+[ \t]+/, "").trim().slice(0, 160));
  return out;
}

// Every gate commit carries a body (P8.4): the Accept lines, the checks with their durations,
// the decisions made since the previous gate commit, the findings filed and the report.
async function commitMessage(g, { subject, lead, steps, timings = [], findings = 0, report = null }) {
  const lines = [subject, "", lead, "", "Accept:"];
  for (const s of steps) {
    lines.push(`${s.id} ${s.title}`);
    for (const a of s.accept) lines.push(`  - ${a}`);
  }
  lines.push("", timings.length ? "Checks:" : "Checks: none at this step.");
  for (const t of timings) lines.push(`- ${t.name}: ${t.status}${t.ms !== null && t.ms !== undefined ? ` in ${secs(t.ms)}` : ""}`);
  const decisions = await decisionsSince(g);
  lines.push("", decisions.length ? "Decisions since the previous gate commit:" : "Decisions since the previous gate commit: none.");
  for (const d of decisions) lines.push(`- ${d}`);
  lines.push("", `Findings filed: ${findings}.`, `Report: ${report || "none"}.`);
  return lines.join("\n") + "\n";
}

// Pushes the run branch and the new tag (plus any tag an earlier push left behind), and returns
// the pushState to record. A failed push is alerted, never a failed step.
async function pushNow(g, st, tagName) {
  const pushFn = g.deps.pushRun || git.pushRun;
  const tags = [...new Set([...((st.pushState && st.pushState.unpushedTags) || []), ...(tagName ? [tagName] : [])])];
  let r;
  try {
    r = await pushFn(g.root, { tags, env: g.env, timeoutMs: pushTimeoutMs(g) });
  } catch (e) {
    r = { ok: false, skipped: false, error: String(e && e.message ? e.message : e), unpushedTags: tags };
  }
  const pushState = {
    branch: r.branch || null, remote: r.remote || null, ok: !!r.ok, skipped: !!r.skipped, at: nowIso(g.deps),
    error: r.ok ? null : r.error || "unknown error", unpushedCommits: r.unpushedCommits ?? null, unpushedTags: r.unpushedTags || []
  };
  g.ev("push", { ok: pushState.ok, skipped: pushState.skipped, remote: pushState.remote, error: pushState.error });
  if (pushState.ok) logLine(g.root, `pushed ${pushState.branch}${tags.length ? ` and ${tags.join(", ")}` : ""} to ${pushState.remote}`);
  else if (pushState.skipped) logLine(g.root, `push skipped: ${pushState.error}`);
  else {
    logLine(g.root, `push FAILED to ${pushState.remote}: ${pushState.error}`);
    await g.say({ title: `AutoClaude: push failed (${pushState.branch || "run branch"})`, message: `Could not push ${pushState.branch || "the run branch"}${tags.length ? ` and ${tags.join(", ")}` : ""} to ${pushState.remote}: ${pushState.error}\nThe commits are safe here; the gate tries again after the next feature, or push by hand with \`git push -u ${pushState.remote} ${pushState.branch}\`.`, priority: "default" });
  }
  return pushState;
}

function pushLine(config, ps) {
  if (!config.git.push) return "Push: off (git.push is false), nothing was pushed.";
  if (!ps) return "Push: nothing was pushed.";
  if (ps.skipped) return `Push: skipped, ${ps.error}.`;
  if (ps.ok) return `Push: ${ps.branch} and its tags are on ${ps.remote}.`;
  const left = [ps.unpushedCommits ? `${ps.unpushedCommits} commit${ps.unpushedCommits === 1 ? "" : "s"}` : null, (ps.unpushedTags || []).length ? `tags ${ps.unpushedTags.join(", ")}` : null].filter(Boolean).join(" and ");
  return `Push: FAILED to ${ps.remote}: ${ps.error}${left ? `. Not pushed: ${left}` : ""}.`;
}

// What the owner can do about a verification that does not fit in one stop.
function outOfTimeHelp(config) {
  return `The checks and the checkers need longer than one stop allows: gate.timeoutSec is ${config.gate.timeoutSec} s, and it cannot go above the Stop hook's ${MAX_GATE_TIMEOUT_SEC} s. The feature is too big for one verification: split its phase into smaller ones, make the checks faster (and keep each check's timeoutSec well below gate.timeoutSec), or lower tester.maxTurns and tester.timeoutSec, or turn off bugBash.atPhaseEnd.`;
}

// The way out that needs no change to the plan (D60): the step's phase verified step by step,
// with `verify-per-step`, then a resume. Null when the phase already is, or there is none.
function perStepWayOut(g, stepId) {
  const s = stepById(parsePlan(readText(g.planFile, "") || ""), String(stepId || ""));
  const num = s && s.phase ? s.phase.num : null;
  if (num === null || verifyMode(g.config, num) === "step") return null;
  return `The quickest way on, with no change to the plan: \`${g.cli} verify-per-step ${num}\`, then \`${g.cli} resume\`. Phase ${num} is then verified one step at a time.`;
}

// The run pauses because a verification does not fit in one stop; resume clears the count.
// verify-per-step is offered only where it can help: not in a fix-up pass (resume keeps the pass,
// whose checks are the same either way), and not for a check (`part`), which every verification
// runs whole.
async function pauseOutOfTime(g, st, stepId, what, { report = null, outOfTime = null, part = null } = {}) {
  const { root, config, cli, ev, events, say } = g;
  const meanwhile = pausedMeanwhile(root);
  const fixupPass = !!(st.fixup && st.fixup.stepId === stepId);
  save(g, { ...st, verifying: null, ...(outOfTime ? { outOfTime } : {}), status: STATUS.paused, pauseReason: "out-of-time", haltSession: meanwhile ? !!meanwhile.haltSession : !!st.haltSession });
  stopDevServer({ root });
  ev("paused", { reason: "out-of-time" });
  const wayOut = fixupPass || part === "check" ? null : perStepWayOut(g, stepId);
  logLine(root, `${stepId}: paused, out of time: ${what}${wayOut ? `. ${wayOut}` : ""}`);
  await say({ title: `AutoClaude paused: ${stepId} does not fit in one verification`, message: `${what}.\n${outOfTimeHelp(config)} Then \`${cli} resume\`.${wayOut ? `\n${wayOut}` : ""}${report ? `\nReport: ${report}` : ""}`, priority: "high" });
  return allow(events);
}

// A check or a checker stopped at the gate's deadline: not the builder's attempt. The first
// time the builder readies again; the second time the run pauses, since the same verification
// would run out of time the same way. `part` is the kind of part that ran out ("check", ...).
async function ranOutOfTime(g, st, step, what, report, part = null) {
  const { root, cli, ev, events } = g;
  const n = ((st.outOfTime || {})[step.id] || 0) + 1;
  const outOfTime = { ...(st.outOfTime || {}), [step.id]: n };
  ev("out-of-time", { step: step.id, count: n, report });
  logLine(root, `${step.id}: out of time (${n}): ${what} (${report})`);
  if (n >= 2) return await pauseOutOfTime(g, st, step.id, what, { report, outOfTime, part });
  const meanwhile = pausedMeanwhile(root);
  if (meanwhile) {
    save(g, { ...st, outOfTime, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
    stopDevServer({ root });
    ev("paused", { reason: "owner", during: "verification" });
    return allow(events);
  }
  save(g, { ...st, outOfTime });
  return block(`${what}. The gate's time ran out before the verification finished: that is not a failure of ${step.id}, and it did not count as an attempt. Run \`${cli} ready ${step.id}\` again; if it runs out of time again, the run pauses for the owner. Report: ${report}`, events);
}

export async function runGate(input, deps = {}) {
  const events = [];
  const ev = (type, detail = {}) => events.push({ type, ...detail });
  const env = deps.env || process.env;
  const notifier = deps.notify || ((msg, opts) => notify(msg, { env, ...opts }));

  if (env.AUTOCLAUDE_ROLE) { ev("nested-role"); return allow(events); }
  const root = deps.root || findProjectRoot(input.cwd || process.cwd());
  if (!root) { ev("no-project"); return allow(events); }
  const state = loadState(root);
  if (state.status !== STATUS.running) { ev("not-running", { status: state.status }); return allow(events); }
  // A person's own session in the project while a supervised run is going stops normally.
  if (!isBuilderSession(root, env)) { ev("not-builder"); return allow(events); }
  // The supervisor is about to replace this session with a fresh one for the next feature. With
  // no live supervisor nothing would start it, so this session carries on instead.
  if (state.freshSession) {
    if ((deps.liveSupervisorPid || liveSupervisorPid)(root)) { ev("fresh-session-pending"); return allow(events); }
    updateState(root, (s) => { s.freshSession = false; });
    state.freshSession = false;
    ev("fresh-session-dropped");
  }

  const cfgLoad = loadConfig(root);
  if (cfgLoad.errors.length) { ev("config-error"); logLine(root, `config errors, allowing stop: ${JSON.stringify(cfgLoad.errors)}`); return allow(events); }
  const config = cfgLoad.config;
  const p = projectPaths(root);
  const planFile = path.join(root, config.plan);
  const cli = cliCommand(env);
  const logFile = path.join(p.logsDir, "notify.log");
  const say = (msg) => notifier(msg, { logFile, stdout: deps.stdout });
  // Informational alerts go through the owner's per-event switches; critical ones use say().
  const sayEvent = async (event, msg) => {
    const notifyEvent = await lazyExport("./notify.js", "notifyEvent");
    if (notifyEvent) {
      const r = await notifyEvent(root, config, event, msg, { env, logFile, stdout: deps.stdout, notify: notifier });
      ev(r && r.skipped ? "alert-skipped" : "alert", { event });
      return r;
    }
    const own = config.notify && config.notify.events && typeof config.notify.events[event] === "boolean" ? config.notify.events[event] : EVENT_DEFAULTS[event];
    if (own === false) {
      try { appendLine(logFile, `${new Date().toISOString()} skipped: event ${event} is off`); } catch {}
      ev("alert-skipped", { event });
      return { ok: true, skipped: true };
    }
    ev("alert", { event });
    return say(msg);
  };
  const loaded = { pauseRequested: !!state.pauseRequested, notes: (state.pendingNotes || []).map(noteKey) };
  // deps.clock (epoch ms) is the gate's clock for its time budget; deps.pid the process the
  // verification snapshot names (tests).
  const clock = deps.clock || Date.now;
  const startedMs = clock();
  const g = {
    root, config, env, deps, cli, say, sayEvent, planFile, ev, events, loaded, clock, startedMs,
    // The checks and the checkers run against this; the rest of the stop is for the commit,
    // the tag and the push.
    deadlineMs: startedMs + stopPartsSec(config) * 1000,
    pid: "pid" in deps ? deps.pid : process.pid
  };

  // Another session's gate is at work in this project (a second session in a run started by
  // hand, or a gate left behind by a halt on Linux or macOS): this one stands down and touches
  // neither that verification nor the plan.
  if (liveOtherGate(root, config, g.pid)) {
    ev("gate-busy");
    logLine(root, "another gate is at work in this project; this stop is allowed without a verification");
    return allow(events);
  }

  // A verification that was cut off (the hook's timeout, a crash): its ticks, PROGRESS lines and
  // findings rows come out first, and it counts as one that ran out of time.
  const interrupted = undoCutVerification(root, config, { self: g.pid });
  if (interrupted) {
    const what = interrupted.fixup ? `the fix-up checks of ${interrupted.step} were cut off` : `the verification of ${interrupted.step} was cut off`;
    ev("verify-interrupted", { step: interrupted.step, count: interrupted.count });
    logLine(root, `${what}${interrupted.fixup ? "" : "; its plan ticks, PROGRESS lines and findings rows were undone"}${interrupted.count ? ` (out of time ${interrupted.count})` : ""}`);
    // A verification cut off in a later stop of it leaves state.verifying with its snapshot.
    const now = loadState(root);
    state.outOfTime = now.outOfTime;
    state.verifying = now.verifying;
    if (interrupted.step && interrupted.count >= 2) {
      return await pauseOutOfTime(g, state, interrupted.step, `The ${interrupted.fixup ? "fix-up checks" : "verification"} of ${interrupted.step} ${interrupted.fixup ? "were" : "was"} cut off ${interrupted.count} times by the Stop hook's timeout before ${interrupted.fixup ? "they" : "it"} finished`);
    }
  }

  let planText = readText(planFile, null);
  if (planText === null) { ev("no-plan"); logLine(root, "plan file missing, allowing stop"); return allow(events); }
  let parsed = parsePlan(planText);

  // Integrity: every [x] and [~] must be one the gate (or the owner, before the run) recorded,
  // the ticks of a verification carried over from an earlier stop included.
  const staged = state.verifying && state.verifying.stepId ? state.verifying : null;
  const allowedTicks = new Set([...(state.tickedByGate || []), ...(staged && Array.isArray(staged.ticked) ? staged.ticked : [])]);
  const rogue = parsed.steps.filter((s) => isFinished(s) && !allowedTicks.has(s.id));
  if (rogue.length) {
    for (const s of rogue) planText = setMarker(planText, s.id, MARKERS.todo);
    writeFileAtomic(planFile, planText);
    parsed = parsePlan(planText);
    ev("integrity-reverted", { ids: rogue.map((s) => s.id) });
    logLine(root, `integrity: reverted ${rogue.map((s) => s.id).join(", ")}`);
    return block(`Only the gate ticks boxes in ${config.plan}. I reverted ${rogue.map((s) => s.id).join(", ")} to [ ]. Do not edit ${config.plan}. When ${state.currentStep} is done, run \`${cli} ready ${state.currentStep}\`.`, events);
  }

  // A verified step or feature whose gate was cut off before its commit was recorded: finished
  // now, not verified again.
  if (state.closing && state.closing.stepId) {
    const r = await resumeClose(g, state, parsed);
    if (r) return r;
    // Verified again instead (the files changed after its checks): the ticks may be out.
    planText = readText(planFile, planText);
    parsed = parsePlan(planText);
  }
  // A verification carried over from an earlier stop goes on from where it was (D60), before
  // anything reads its ticks as done. Started again when the files changed since (`restart`,
  // acted on below as the ready it was), or dropped, and the stop goes on as usual.
  let restart = null;
  if (state.verifying && state.verifying.stepId) {
    const r = await carryOn(g, state, parsed);
    if (r && r.decision) return r;
    restart = r && r.restart ? r.restart : null;
    planText = readText(planFile, planText);
    parsed = parsePlan(planText);
  }
  // The end of the run, cut off or out of time in an earlier stop: finished now.
  if (state.completing) {
    if (!firstUnfinished(parsed)) return await complete(g, state, parsed);
    updateState(root, (s) => { s.completing = null; });
    state.completing = null;
    ev("complete-dropped");
    logLine(root, "the end of the run was not finished, and the plan has unfinished steps again; carrying on with them");
  }

  // A feature in its fix-up pass stays on its closing step, which is already ticked.
  let fixup = state.fixup && state.fixup.stepId ? state.fixup : null;
  let step = null;
  if (fixup) {
    step = stepById(parsed, fixup.stepId);
    if (!step || step.marker !== MARKERS.done) {
      ev("fixup-dropped", { step: fixup.stepId });
      logLine(root, `fix-up pass of ${fixup.stepId} dropped: the step is no longer ticked`);
      fixup = null;
      state.fixup = null;
      step = null;
    } else {
      state.currentStep = step.id;
    }
  }
  // Re-baseline (D33): the current step must exist and be unfinished.
  if (!fixup) {
    step = state.currentStep ? stepById(parsed, state.currentStep) : null;
    if (!step || isFinished(step)) {
      const fresh = firstUnfinished(parsed);
      if (!fresh) return await finishPlan(g, state, parsed);
      state.currentStep = fresh.id;
      step = fresh;
      ev("rebaselined", { step: fresh.id });
    }
  }

  // Blocked marker: a critical question for the owner. In a fix-up pass the step stays ticked,
  // so the resumed run carries on with the same pass.
  const blocked = readBlocked(root);
  if (blocked) {
    clearBlocked(root);
    if (!fixup) {
      planText = setMarker(planText, step.id, MARKERS.blocked);
      writeFileAtomic(planFile, planText);
    }
    save(g, { ...state, status: STATUS.paused, pauseReason: "blocked", currentStep: step.id, lastBlockedQuestion: blocked.question });
    stopDevServer({ root });
    ev("paused", { reason: "blocked" });
    logLine(root, `blocked on ${step.id}: ${blocked.question}`);
    await say({ title: `AutoClaude blocked on ${step.id}`, message: `${blocked.question}\n\nAnswer with: ${cli} answer "<your answer>"`, priority: "high" });
    return allow(events);
  }

  // No ready marker: keep the builder going, unless nothing is happening. A verification that
  // starts again is the ready it began with.
  const ready = restart ? { step: restart } : readReady(root);
  if (!ready || (ready.step && ready.step !== step.id)) {
    if (ready) { clearReady(root); ev("ready-wrong-step", { marked: ready.step }); }
    const beat = readHeartbeat(root);
    const head = (await git.head(root, { env })) || null;
    const noProgress = beat.count === state.toolCallsAtLastGate && head === state.headAtLastGate;
    const next = { ...state, toolCallsAtLastGate: beat.count, headAtLastGate: head, noProgress: noProgress ? state.noProgress + 1 : 0 };
    if (next.noProgress >= config.retries.maxNoProgressStops) {
      save(g, { ...next, status: STATUS.paused, pauseReason: "stuck" });
      stopDevServer({ root });
      ev("paused", { reason: "stuck" });
      logLine(root, `stuck on ${step.id} after ${next.noProgress} stops with no progress`);
      await say({ title: `AutoClaude stuck on ${step.id}`, message: `The session stopped ${next.noProgress} times without tool use or new commits. Look at the project, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    const owner = ownerInput(next, config);
    save(g, owner.mark(next));
    ev("nudge", { noProgress: next.noProgress });
    const wrong = ready ? `The ready marker named ${ready.step}, but the current step is ${step.id}. ` : "";
    if (fixup) return block(`${owner.text}${wrong}${fixupText(g, fixup)}`, events);
    return block(`${owner.text}${wrong}Continue ${step.id} (${step.title}). When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${step.id}\`. If you truly cannot proceed without a human, run \`${cli} blocked ${step.id} "<question with options>"\`.\n\n${stepText(parsed, step)}`, events);
  }

  // Ready. A phase in gate.stepPhases is verified step by step, whatever verifyAt says.
  clearReady(root);
  const perFeature = verifyMode(config, step.phase ? step.phase.num : null) === "phase";
  if (!fixup && perFeature && !isFeatureEnd(parsed, step.id)) return await builtStep(g, state, step, parsed, planText);
  // A verification that ran out of time twice (counted by whoever undid the cut-off ones, the
  // supervisor included) is not started a third time.
  const timesOut = (state.outOfTime || {})[step.id] || 0;
  if (timesOut >= 2) return await pauseOutOfTime(g, state, step.id, `The verification of ${step.id} ran out of time ${timesOut} times before it finished`);
  if (fixup) return await fixupReady(g, state, step, parsed);
  return await verify(g, state, step, parsed, planText, perFeature);
}

// A step inside a phase, per-feature mode: committed as built [~], no checks (D49).
async function builtStep(g, state, step, parsed, planText) {
  const { root, config, env, deps, ev, planFile } = g;
  const phase = step.phase;
  const st = { ...state };
  if (!st.phaseStartedAt) st.phaseStartedAt = st.stepStartedAt || st.startedAt || nowIso(deps);
  if (!st.phaseBaseCommit) st.phaseBaseCommit = (await builtFeatureBase(g, phase)) || (await git.head(root, { env })) || null;
  ev("built", { step: step.id, phase: phase.num });
  // Recorded before the plan changes: a gate cut off from here on leaves a [~] the integrity
  // check accepts (the next stop moves on, and the next commit takes this step's work along),
  // never one it reverts as the builder's.
  updateState(root, (s) => {
    s.tickedByGate = [...new Set([...(s.tickedByGate || []), step.id])];
    s.phaseBaseCommit = st.phaseBaseCommit; s.phaseStartedAt = st.phaseStartedAt;
  });
  const text = setMarker(planText, step.id, MARKERS.built);
  writeFileAtomic(planFile, text);
  const tparsed = parsePlan(text);
  appendLine(path.join(root, config.docs.progress), `- ${nowIso(deps).slice(0, 10)} ${step.id} ${step.title} (built; verified with Phase ${phase.num})`);
  let sha = null;
  let commitError = null;
  let message = null;
  if (config.git.commitEachStep) {
    message = await commitMessage(g, {
      subject: `autoclaude(${step.id}): ${step.title}`,
      lead: `Built, not verified yet: ${step.id} is verified with Phase ${phase.num} (${phase.title}), all of it at once, when ${closerText(tparsed, phase.num)} is ready.`,
      steps: [step]
    });
    const c = await git.commitAll(root, message, { env });
    sha = c.sha || null;
    if (!c.ok) { commitError = String(c.stderr || "").trim() || "unknown error"; logLine(root, `commit failed: ${commitError}`); }
  }
  logLine(root, `${step.id} built${sha ? ` (${sha.slice(0, 7)})` : commitError ? " but NOT committed" : ""}; verified with Phase ${phase.num}`);
  const base = {
    ...st, tickedByGate: [...new Set([...(st.tickedByGate || []), step.id])], attempts: { ...st.attempts, [step.id]: 0 },
    noProgress: 0, headAtLastGate: sha || st.headAtLastGate,
    pendingNotes: (st.pendingNotes || []).filter((n) => !n.delivered), ownerAnswer: null
  };
  const next = nextStep(tparsed);
  if (commitError) return await commitFailed(g, base, step, next, commitError, message);
  if (next) await g.sayEvent("stepVerified", { title: `AutoClaude: ${step.id} built`, message: `${step.id} ${step.title} is built and committed; its verification comes with Phase ${phase.num} (${phase.title}). Next: ${next.id} ${next.title}.`, priority: "low" });
  return await advance(g, base, { step, parsed: tparsed, next, sha, phaseEnd: false, closedFeature: false, built: true });
}

// The configured checks as parts of a verification, one each, in order: `kind` "check" (key
// check:<i>:<name>), or "recheck" (recheck:<i>:<name>) for a per-step verification's second run
// with its findings filed. `ms` is what the check is expected to need (expectedCheckMs).
function checkParts(config, times, kind = "check") {
  return config.checks.map((check, i) => {
    const key = `${kind}:${i}:${check.name}`;
    return { key, kind, name: verifyPartName(key), check, ms: expectedCheckMs(check, times) };
  });
}

// Runs the check parts of `list` that rec.done does not name yet, one by one, in this stop: the
// checks of a verification, its second run with the findings filed, a fix-up pass's checks.
// `ranHere` counts the parts this stop has run already. Before each check but the stop's first
// part, the time left is weighed against what the check is expected to need; one that does not
// fit, or is stopped at the deadline, after another part of this stop is carried over (`carry`
// says why) and never counted. A check that passes goes into rec.done. Returns { ran (the results
// of the checks that ran, for the record of check times), sections, timings, ranHere, carry,
// failedCheck } (failedCheck: one that failed, did not run, or ran out of time as the stop's
// first part).
async function runCheckParts(g, rec, list, { step, devServerReady, ranHere = 0 }) {
  const out = { ran: [], sections: [], timings: [], ranHere, carry: null, failedCheck: null };
  for (const p of list) {
    if (rec.done.includes(p.key)) continue;
    if (out.ranHere && g.deadlineMs - g.clock() < p.ms) { out.carry = `${p.name} is expected to need ${secs(p.ms)}`; break; }
    const r = (await runChecks([p.check], { cwd: g.root, env: g.env, devServerReady, deadlineMs: g.deadlineMs, now: g.clock })).results[0];
    if (r.ran) out.ran.push(r);
    if (r.outOfTime && out.ranHere) { out.carry = `${p.name} was stopped at the gate's deadline`; break; }
    checkSection(g, r, step, out.sections, out.timings);
    if (!r.ok) { out.failedCheck = r; break; }
    rec.done.push(p.key);
    out.ranHere++;
  }
  return out;
}

// A check's result in the report (sections) and in the commit body (timings).
function checkSection(g, r, step, sections, timings) {
  const passed = r.code === 0 && !r.timedOut;
  if (r.ran) {
    sections.push({ title: `Check "${r.name}": ${passed ? "passed" : r.outOfTime ? "OUT OF TIME" : "FAILED"}`, body: `\`${r.command}\` in ${Math.round(r.durationMs / 1000)} s${passed ? "" : `\n\n${checkFailureSection(r).body}`}` });
    timings.push({ name: r.name, status: passed ? "passed" : r.outOfTime ? "out of time" : "FAILED", ms: r.durationMs });
  } else if (!r.skipped) {
    sections.push({ title: `Check "${r.name}": NOT RUN`, body: `\`${r.command}\` did not run: ${notRunReason(r, g.config, g.cli, step)}.` });
  }
}

// Why a check failed a verification, in one line.
function checkFailure(g, f, step) {
  return f.outOfTime ? `check "${f.name}" ran out of the gate's time: ${f.reason}` : f.ran ? `check "${f.name}" failed` : `check "${f.name}" did not run: ${notRunReason(f, g.config, g.cli, step)}`;
}

// Starts (or restarts) the dev server for a verification. Returns { ok, failure } and adds what
// the report needs to `sections`.
async function devServerFor(g, sections) {
  const { root, config, env, deps } = g;
  const ds = await (deps.restartDevServer || restartDevServer)(config.devServer, { root, env });
  if (ds.ok) {
    if (ds.reused) sections.push({ title: "Dev server reused", body: `Something the gate did not start already answers at ${config.devServer.url}. It was used as it is and may be running older code.` });
    return { ok: true, failure: null };
  }
  sections.push({ title: "Dev server FAILED to start", body: `${ds.error}\n\n${fence((ds.logTail || []).join("\n") || "(no log output)")}` });
  return { ok: false, failure: `the dev server did not start: ${ds.error}` };
}

// The full verification of a step ("step" mode) or of the whole phase it closes (feature). The
// ticks and PROGRESS lines are written first; then its parts run in order, as far as they fit in
// this stop (runVerification), and the rest is carried to the next stop.
async function verify(g, state, step, parsed, planText, feature) {
  const { root, config, env, deps, ev, planFile } = g;
  const attempt = (state.attempts[step.id] || 0) + 1;
  const phase = step.phase;
  const st = { ...state, verifying: null };
  if (!st.phaseStartedAt) st.phaseStartedAt = st.stepStartedAt || st.startedAt || nowIso(deps);
  if (feature && !st.phaseBaseCommit) st.phaseBaseCommit = (await builtFeatureBase(g, phase)) || (await git.head(root, { env })) || null;
  const scopeIds = (feature && phase ? phase.steps : [step]).map((s) => s.id);
  const toTick = scopeIds.filter((id) => stepById(parsed, id).marker !== MARKERS.done);
  const label = feature && phase ? `Phase ${phase.num} (${phase.title})` : step.id;
  ev("verify", { step: step.id, attempt, ...(feature ? { feature: phase ? phase.num : null, steps: scopeIds } : {}) });
  logLine(root, `verifying ${feature && phase ? `${label} at ${step.id}` : step.id} attempt ${attempt}`);

  // Ticks and PROGRESS lines first, so the checks see exactly what the commit will hold. The
  // snapshot names both (and later the findings rows), so they come out on a failure, or later
  // if this gate is cut off, without touching anything else.
  const progressFile = path.join(root, config.docs.progress);
  const date = nowIso(deps).slice(0, 10);
  const added = toTick.map((id) => { const s = stepById(parsed, id); return `- ${date} ${s.id} ${s.title} (attempt ${attempt})\n`; }).join("");
  const snap = { id: crypto.randomUUID(), step: step.id, pid: g.pid, at: new Date().toISOString(), plan: planText, progress: readText(progressFile, null), ticked: toTick, added };
  writeJsonAtomic(pendingVerifyFile(root), snap);
  let ticked = planText;
  for (const id of toTick) ticked = setMarker(ticked, id, MARKERS.done);
  writeFileAtomic(planFile, ticked);
  if (added) appendLine(progressFile, added);
  // What the parts have found so far, and how to take the ticks out again without the snapshot:
  // the record a stop parks in state.verifying when the rest does not fit (D60).
  const rec = {
    verifyId: snap.id, stepId: step.id, feature: !!feature, phase: phase ? phase.num : null, attempt, scope: scopeIds, ticked: toTick,
    undo: { ticked: toTick, markers: Object.fromEntries(toTick.map((id) => [id, stepById(parsed, id).marker])), added, progressCreated: snap.progress === null },
    done: [], sections: [], timings: [], followUps: [], securityFindings: [], noted: false, turns: 0, restarts: g.restarts || 0, startedAt: snap.at
  };
  return await runVerification(g, st, rec, snap, parsePlan(ticked));
}

const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// checkers.parallel: "security" (the default) runs the security review, which reads only the
// diff and needs no browser, alongside the browser checks; "off" runs every checker one after
// another; "all" runs the tester and the bug bash at the same time too, which only an app whose
// test data can take both at once should allow, since they share one dev server.
export function checkersParallel(config) {
  const v = config && config.checkers ? config.checkers.parallel : undefined;
  return v === "off" || v === "all" ? v : "security";
}

// The lanes the checker parts run in, side by side; the parts of a lane run one after another.
// By default the browser tester then the bug bash (never at the same time: they share the dev
// server, and the bug bash tries to break things), and the security review in a lane of its own.
export function checkerLanes(config, parts) {
  const mode = checkersParallel(config);
  if (mode === "off") return parts.length ? [parts] : [];
  if (mode === "all") return parts.map((p) => [p]);
  return [parts.filter((p) => p.kind !== "security"), parts.filter((p) => p.kind === "security")].filter((lane) => lane.length);
}

// The parts of a verification, in order: each configured check, the browser tester and the bug
// bash (both need the dev server; without one set up they are left out, and the report says so),
// then the security review (it needs only the diff, so by default it runs alongside the browser
// checks: checkerLanes). `ms` is what each is expected to need: a check its recent time
// (expectedCheckMs), a checker the estimate's model (expectedCheckerMs), each with a quarter on
// top. For a feature the tester gets every UI step of the phase, one criterion per Accept line,
// and the bug bash runs when the phase has any UI step at all. The checkers are run with sweep:
// false: the gate sweeps their strays itself, once every lane is done (runVerification).
function verificationParts(g, { tstep, tparsed, feature, scope, st, attempt, times }) {
  const { root, config, env, deps } = g;
  const parts = checkParts(config, times);
  const runBrowser = "runTester" in deps ? deps.runTester : runBrowserCheck;
  const uiSteps = scope.filter((s) => !s.tags.includes("no-ui"));
  const phaseEnd = feature || isPhaseEnd(tparsed, tstep.id);
  const testerWanted = !!(runBrowser && config.tester.enabled && uiSteps.length);
  const bugBashWanted = !!(runBrowser && config.bugBash.atPhaseEnd && tstep.phase && phaseEnd && tstep.phase.steps.some((s) => !s.tags.includes("no-ui")));
  const browser = !!(config.devServer.command && config.devServer.url);
  const browserRun = (kind, extra) => (deadlineMs) => runBrowser({ kind, root, config, step: tstep, ...extra, parsed: tparsed, state: st, env, attempt, deadlineMs, sweep: false });
  if (browser && testerWanted) parts.push({ key: "tester", kind: "tester", name: verifyPartName("tester"), label: "browser tester", ms: expectedCheckerMs("tester", config, feature ? { steps: uiSteps } : { step: tstep }), run: browserRun("tester", feature ? { steps: uiSteps } : {}) });
  if (browser && bugBashWanted) parts.push({ key: "bugbash", kind: "bugbash", name: verifyPartName("bugbash"), label: "bug bash", ms: expectedCheckerMs("bugbash", config, { step: tstep }), run: browserRun("bugbash", {}) });
  // The security review of a feature reads its whole diff, from state.phaseBaseCommit.
  const runSecurity = "runSecurity" in deps ? deps.runSecurity : runSecurityReview;
  const securityOn = feature ? scope.some((s) => securityWanted(config, s, tparsed)) : securityWanted(config, tstep, tparsed);
  if (runSecurity && securityOn) parts.push({ key: "security", kind: "security", name: verifyPartName("security"), label: "security review", ms: expectedCheckerMs("security", config, { step: tstep }), run: (deadlineMs) => runSecurity({ root, config, step: tstep, ...(feature ? { steps: scope } : {}), parsed: tparsed, state: st, env, attempt, deadlineMs, sweep: false }) });
  return { parts, testerWanted, bugBashWanted, browser, phaseEnd };
}

const CHECKER_KINDS = Object.freeze(["tester", "bugbash", "security"]);
const isChecker = (p) => CHECKER_KINDS.includes(p.kind);

// Carries what is left of a verification (or of a fix-up pass's checks: rec.fixup) to the next
// stop (D60). The record is parked in state.verifying with the tree it was verified on so far,
// before the snapshot is freed from this gate, so a gate cut off in between is still undone as
// one cut off. The builder is told to end its turn without changing anything; the next stop
// carries on, and starts again from the first part if the files changed. Nothing is counted. An
// owner pause made meanwhile stands. `head` opens the message ("The verification of Phase 1
// (Lists) goes on"), `what` names it in the log, `again` in the warning about a change.
async function parkStaged(g, st, rec, snap, parts, { why, what, head, again }) {
  const { root, ev, events } = g;
  const left = parts.filter((p) => !rec.done.includes(p.key));
  rec.turns = (rec.turns || 0) + 1;
  rec.tree = await stagedTree(g);
  // The parts still to run, by key, for `autoclaude status` and a builder session started
  // meanwhile (lib/resume.js stagedVerification).
  Object.assign(rec, { parked: true, pid: null, at: new Date().toISOString(), left: left.map((p) => p.key) });
  const next = { ...st, verifying: rec, noProgress: 0, toolCallsAtLastGate: readHeartbeat(root).count };
  ev("staged", { step: rec.stepId, turn: rec.turns, done: [...rec.done], left: left.map((p) => p.key), ...(rec.fixup ? { fixup: true } : {}) });
  logLine(root, `${what}: ${why}, with ${secs(Math.max(0, g.deadlineMs - g.clock()))} of this stop left; ${andList(left.map((p) => p.name))} carried to the next stop`);
  const meanwhile = pausedMeanwhile(root);
  save(g, meanwhile ? { ...next, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession } : next);
  try { writeJsonAtomic(pendingVerifyFile(root), { ...snap, pid: null, at: rec.at }); } catch (e) { logLine(root, `could not free the verification snapshot: ${e && e.message ? e.message : e}`); }
  if (meanwhile) {
    stopDevServer({ root });
    ev("paused", { reason: "owner", during: "verification" });
    return allow(events);
  }
  const done = parts.filter((p) => rec.done.includes(p.key)).map((p) => p.name);
  return block(`${head} in the next turn: ${andList(done)} ${done.length === 1 ? "is" : "are"} done, and ${andList(left.map((p) => p.name))} would not fit in what is left of this stop. Nothing failed and no attempt was counted. End your turn now without changing anything: the next stop carries on from here (a change to the files starts ${again} again from the beginning).`, events);
}

// Runs what is left of a verification in this stop. rec.done names the parts done in earlier
// stops of it, and rec keeps what they found. Before each part but this stop's first, the time
// left is weighed against what the part is expected to need: when it is short, or a part is
// stopped at the deadline after another part of this stop, the rest goes to the next stop
// (park), which never counts as an attempt or as out of time. A stop's first part always runs,
// with the whole of the stop's time, so a part that does not fit even in a stop of its own is
// out of time, as before. Each check runs on its own (lib/checks.js runChecks), in order; the
// checkers then run in their lanes (checkerLanes), and nothing starts after a failed check. A
// step verified on its own with findings filed runs its checks once more, staged the same way
// (kind "recheck"), with the rows kept across stops. The outcome (a failure, out of time, a
// checker that cannot run, the pass with its fix-up pass or its commit) is the same in whichever
// stop it comes.
async function runVerification(g, st, rec, snap, tparsed) {
  const { root, config, env, deps, cli, ev, events, say, planFile } = g;
  const step = stepById(tparsed, rec.stepId);
  const phase = step.phase;
  const feature = !!rec.feature;
  const attempt = rec.attempt;
  const max = config.retries.maxAttemptsPerStep;
  const scope = rec.scope.map((id) => stepById(tparsed, id)).filter(Boolean);
  const label = feature && phase ? `Phase ${phase.num} (${phase.title})` : step.id;
  const date = nowIso(deps).slice(0, 10);
  const { sections, timings, followUps, securityFindings } = rec;
  const restore = () => undoCutVerification(root, config, { own: true });
  const times = await recordedCheckTimes(g);
  const { parts, testerWanted, bugBashWanted, browser, phaseEnd } = verificationParts(g, { tstep: step, tparsed, feature, scope, st, attempt, times });
  // The second run of the checks, once a step's findings rows are filed (rec.rows): a part of
  // the verification from then on, carried over like any other.
  const rechecks = () => (!feature && rec.rows && rec.rows.filed.length ? checkParts(config, times, "recheck") : []);
  if (rec.rows) parts.push(...rechecks());
  const todo = parts.filter((p) => !rec.done.includes(p.key));

  // Out of the gate's time: nothing is taken as the builder's fault, and the ticks come out.
  // `part` is the kind of the part that ran out, for the alert.
  const outOfTime = async (what, part = null) => {
    const n = ((st.outOfTime || {})[step.id] || 0) + 1;
    const report = writeReport({ root, step: step.id, attempt: `${attempt}-time${n}`, title: `AutoClaude report: ${label}, verified at ${step.id}, ran out of time`, sections });
    restore();
    return await ranOutOfTime(g, st, step, what, report.relPath, part === "recheck" ? "check" : part);
  };

  // A failed attempt: the ticks, PROGRESS lines and any findings rows come out again.
  const fail = async (failure, failureKind, failedCheck) => {
    restore();
    const accepts = feature ? failingAcceptLines(scope, sections, failedCheck) : [];
    if (accepts.length) sections.unshift({ title: "Failing Accept lines", body: accepts.map((a) => `- ${a.step}: ${a.accept}`).join("\n") });
    const report = writeReport({ root, step: step.id, attempt, title: `AutoClaude report: ${feature && phase ? `${label}, verified at ${step.id},` : step.id} attempt ${attempt}`, sections });
    const attempts = { ...st.attempts, [step.id]: attempt };
    // The verification finished, so it fitted in the stop.
    const outOfTimeCounts = { ...(st.outOfTime || {}), [step.id]: 0 };
    ev("failed", { step: step.id, attempt, failure, report: report.relPath, ...(feature ? { accept: accepts } : {}) });
    logLine(root, `${feature && phase ? `${label} at ${step.id}` : step.id} attempt ${attempt} failed: ${failure} (${report.relPath})`);
    if (attempt >= max) {
      // The plan as it is now, not as this gate read it: the owner may have edited it while the
      // checks ran (a `pause --now`, then a new step or a reworded Accept line).
      try { const now = readText(planFile, null); if (now !== null) writeFileAtomic(planFile, setMarker(now, step.id, MARKERS.failed)); } catch (e) { logLine(root, `could not mark ${step.id} [!]: ${e && e.message ? e.message : e}`); }
      const reason = failureKind === "security" ? "security" : "step-failed";
      save(g, { ...st, attempts, outOfTime: outOfTimeCounts, status: STATUS.paused, pauseReason: reason });
      stopDevServer({ root });
      ev("paused", { reason });
      await say({ title: `AutoClaude paused: ${feature && phase ? `Phase ${phase.num}, verified at ${step.id},` : step.id} failed ${attempt} times`, message: `${failure}\nReport: ${report.relPath}\nFix it or adjust the plan, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    const meanwhile = pausedMeanwhile(root);
    if (meanwhile) {
      save(g, { ...st, attempts, outOfTime: outOfTimeCounts, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    const owner = ownerInput(st, config);
    save(g, owner.mark({ ...st, attempts, outOfTime: outOfTimeCounts }));
    const failingSections = sections.filter((s) => /FAILED|failed|NOT RUN|Failing Accept/.test(s.title));
    const owners = [...new Set(accepts.map((a) => a.step))];
    const headline = feature && phase
      ? `${label}, verified at ${step.id}, attempt ${attempt}/${max} failed: ${failure}.${owners.length ? ` The failing Accept lines belong to ${owners.join(", ")}.` : ""} Fix the causes, then run \`${cli} ready ${step.id}\` again.`
      : `${step.id} attempt ${attempt}/${max} failed: ${failure}. Fix the causes, then run \`${cli} ready ${step.id}\` again.`;
    return block(owner.text + summarize({ headline, sections: failingSections, reportPath: report.relPath, maxChars: MAX_REASON - owner.text.length }), events);
  };

  // The rest goes to the next stop (D60, parkStaged).
  const park = (why) => parkStaged(g, st, rec, snap, parts, { why, what: `${label} at ${step.id}`, head: `The verification of ${label} goes on`, again: "the verification" });

  // The dev server, when a part still to run needs it.
  let failure = null;
  let failureKind = null;
  let failedCheck = null;
  let devServerReady = false;
  const needsServer = (list) => list.some((p) => p.kind === "tester" || p.kind === "bugbash" || ((p.kind === "check" || p.kind === "recheck") && p.check.needsDevServer));
  if (browser && needsServer(todo)) {
    const ds = await devServerFor(g, sections);
    devServerReady = ds.ok;
    if (!ds.ok) { failure = ds.failure; failureKind = "checks"; }
  }

  // The checks, one by one.
  let ranHere = 0;
  const checksLeft = todo.filter((p) => p.kind === "check");
  const cr = failure ? null : await runCheckParts(g, rec, checksLeft, { step, devServerReady, ranHere });
  if (cr) {
    sections.push(...cr.sections);
    timings.push(...cr.timings);
    ranHere = cr.ranHere;
  }
  if (checksLeft.length || !rec.turns) {
    await recordCheckTimesNow(g, cr ? cr.ran : []);
    await noteFootprintNow(g);
  }
  if (cr && cr.carry) return await park(cr.carry);
  if (cr && cr.failedCheck) {
    failedCheck = cr.failedCheck;
    failure = checkFailure(g, failedCheck, step);
    failureKind = "checks";
  }
  if (failedCheck && failedCheck.outOfTime) return await outOfTime(`The verification of ${label} ran out of time: ${failure}`, "check");
  if (failure) return await fail(failure, failureKind, failedCheck);

  if (!rec.noted) {
    rec.noted = true;
    if ((testerWanted || bugBashWanted) && !browser) {
      ev("browser-skipped", { reason: "no dev server" });
      sections.push({ title: "Browser checks skipped", body: "No devServer command and url are set in autoclaude.config.json, so the browser tester and the bug bash could not open the app. Set devServer to have UI steps checked in a browser." });
    } else if (!testerWanted && !bugBashWanted) {
      ev("tester-skipped");
    }
  }

  // The independent checkers, each its own part, in lanes that run side by side
  // (checkerLanes): parts in a lane run one after another. Each part starts only when what it is
  // allowed fits in what is left of the stop (a stop's first parts always start), with the gate's
  // deadline as its limit. A lane stops at a part that does not fit (the rest of it carries to the
  // next stop) and at a part that does not pass, and no lane starts a part once another has not
  // passed. Every part started is waited for: a security review still running when a browser
  // check fails finishes, and its findings go into the builder's report.
  const lanes = checkerLanes(config, todo.filter(isChecker));
  // Files a checker leaves in the project are moved out before the commit (lib/tester.js
  // sweepStrays), but no checker sweeps for itself here (sweep: false): one lane's sweep would
  // move files the app writes while another lane is still using it (an upload under test). The
  // untracked files are noted once, before any lane starts, and swept once, after every lane is
  // done, into one report folder for this stop's checkers (<step>-<attempt>-checkers/stray/).
  const strayBase = lanes.length ? await untrackedSet(root, env) : null;
  const started = [];
  const running = new Set();
  let stopNew = false;
  // The first part of every lane is weighed at one and the same moment, before any starts.
  const startLeft = g.deadlineMs - g.clock();
  const startFirst = ranHere === 0;
  const runLane = async (lane) => {
    for (let i = 0; i < lane.length; i++) {
      const p = lane[i];
      if (stopNew) return;
      const left = i === 0 ? startLeft : g.deadlineMs - g.clock();
      const first = i === 0 ? startFirst : ranHere === 0;
      if (!first && (left < p.ms || left < MIN_CHECKER_MS)) return;
      const o = { p, first, alongside: new Set(), t0: Date.now(), ms: 0, r: null };
      for (const other of running) { other.alongside.add(p.label); o.alongside.add(other.p.label); }
      running.add(o);
      started.push(o);
      const leftSec = Math.max(0, Math.round(left / 1000));
      try {
        o.r = left < MIN_CHECKER_MS
          ? { status: "out-of-time", failed: `the ${p.label} had ${leftSec} s of the gate's time left, too little to start it`, sections: [{ title: `The ${p.label}: out of time`, body: `Not started: ${leftSec} s of the gate's time was left for it.` }] }
          : await p.run(g.deadlineMs);
      } catch (e) {
        o.r = { status: "infra", failed: `the ${p.label} stopped with an error: ${e && e.message ? e.message : e}`, sections: [{ title: `The ${p.label}: could not run`, body: String(e && e.stack ? e.stack : e) }] };
      }
      o.ms = Date.now() - o.t0;
      running.delete(o);
      if (!["failed", "infra", "out-of-time"].includes(o.r.status)) { ranHere++; continue; }
      // One stopped at the deadline after another part of this stop is carried over, and leaves
      // the others alone; any other outcome ends the verification here.
      if (!(o.r.status === "out-of-time" && !first)) stopNew = true;
      return;
    }
  };
  await Promise.all(lanes.map((lane) => runLane(lane)));
  const strayDir = path.join(projectPaths(root).reportsDir, `${step.id}-${attempt}-checkers`);
  const strays = strayBase && started.length ? await sweepStrays(root, strayBase, strayDir, env) : [];
  const strayRel = path.relative(root, path.join(strayDir, "stray")).replace(/\\/g, "/");
  if (strays.length) logLine(root, `${label} at ${step.id}: moved ${strays.length} file(s) the checkers left in the project to ${strayRel}: ${strays.join(", ")}`);

  // Once every lane is done: the events, the timings (marked when they overlapped) and the
  // report sections, in the fixed order tester, bug bash, security review, then one outcome by a
  // fixed priority: out of time > could not run > failed > carried over > passed.
  const order = ["tester", "bugbash", "security"];
  started.sort((a, b) => order.indexOf(a.p.kind) - order.indexOf(b.p.kind));
  const carried = started.filter((o) => o.r.status === "out-of-time" && !o.first);
  const settled = started.filter((o) => !carried.includes(o));
  for (const o of started) ev(o.p.kind, { status: o.r.status, verdictFile: o.r.verdictFile });
  for (const o of settled) {
    const status = o.r.status === "passed" ? "passed" : o.r.status === "infra" ? "could not run" : o.r.status === "out-of-time" ? "out of time" : "FAILED";
    const others = order.map((k) => parts.find((p) => p.kind === k)).filter((p) => p && o.alongside.has(p.label)).map((p) => `the ${p.label}`);
    timings.push({ name: others.length ? `${o.p.label} (alongside ${andList(others)})` : o.p.label, status, ms: o.ms });
    sections.push(...(o.r.sections || []));
    if (o.r.status === "infra" || o.r.status === "out-of-time") continue;
    if (o.p.kind === "security") securityFindings.push(...(o.r.findings || []));
    else followUps.push(...(o.r.followUps || []));
    if (o.r.status !== "failed") rec.done.push(o.p.key);
  }
  if (strays.length) sections.push({ title: "Files the checkers left in the project", body: `Moved to ${strayRel}, so the commit cannot pick them up:\n${strays.map((f) => `- ${f}`).join("\n")}` });
  const timedOut = settled.find((o) => o.r.status === "out-of-time");
  if (timedOut) return await outOfTime(`The verification of ${label} ran out of time: ${timedOut.r.failed}`, timedOut.p.kind);
  const infra = settled.find((o) => o.r.status === "infra");
  if (infra) {
    // The checker could not run: a machine problem, never the builder's attempt (P4.2).
    const { p, r } = infra;
    restore();
    const n = ((st.infraFailures || {})[step.id] || 0) + 1;
    const report = writeReport({ root, step: step.id, attempt: `${attempt}-infra${n}`, title: `AutoClaude report: ${step.id}, ${p.label} could not run`, sections });
    logLine(root, `${step.id}: ${p.label} could not run (${n}): ${r.failed} (${report.relPath})`);
    ev("infra", { kind: p.kind, count: n, report: report.relPath });
    const infraFailures = { ...(st.infraFailures || {}), [step.id]: n };
    // A `pause --now` while the checker ran stays in force: saving `st` would undo it.
    const meanwhile = pausedMeanwhile(root);
    const halt = meanwhile ? !!meanwhile.haltSession : !!st.haltSession;
    if (n >= 2) {
      save(g, { ...st, infraFailures, status: STATUS.paused, pauseReason: "infra", haltSession: halt });
      stopDevServer({ root });
      ev("paused", { reason: "infra" });
      await say({ title: `AutoClaude paused: the ${p.label} cannot run`, message: `${r.failed}\nReport: ${report.relPath}\nCheck ${p.kind === "security" ? "the claude CLI" : "Playwright and the claude CLI"} on this machine, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    if (meanwhile) {
      save(g, { ...st, infraFailures, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: halt });
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    save(g, { ...st, infraFailures });
    return block(`The ${p.label} could not run: ${r.failed}. That is a problem on this machine, not with ${step.id}, and it did not count as an attempt. Run \`${cli} ready ${step.id}\` again. Report: ${report.relPath}`, events);
  }
  // Two failures make one attempt; "security" when the security review is one of them.
  const failedParts = settled.filter((o) => o.r.status === "failed");
  if (failedParts.length) return await fail(failedParts.map((o) => o.r.failed).join("; "), failedParts.some((o) => o.p.kind === "security") ? "security" : failedParts[0].p.kind, null);
  const notDone = parts.filter((p) => p.kind !== "recheck" && !rec.done.includes(p.key));
  if (notDone.length) return await park(carried.length ? `${andList(carried.map((o) => o.p.name))} stopped at the gate's deadline` : `${andList(notDone.map((p) => p.name))} would not fit`);

  // Pass. The findings are filed next to the ticks, once: rec.rows keeps them (and the snapshot
  // and its undo record name them) when the checks' second run below is carried to a later stop.
  if (!rec.rows) {
    const fRows = followUpRows(step, followUps, date);
    const sRows = securityRows(step, securityFindings, date);
    const filed = fileRows(g, snap, [{ file: config.docs.blockers, header: BLOCKERS_HEADER, lines: fRows }, { file: config.docs.security, header: SECURITY_HEADER, lines: sRows }]).map(({ file, text, created }) => ({ file, text, created }));
    rec.rows = { followUps: fRows, security: sRows, filed };
    if (filed.length) {
      snap.rows = filed;
      rec.undo = { ...rec.undo, rows: filed };
    }
    parts.push(...rechecks());
  }
  // Per step, the rows go into this step's commit, so the checks run once more with them in the
  // tree: the verified commit is a tree the checks passed on (per feature, the fix-up pass runs
  // them again). Staged like the first run: what does not fit after another part of this stop is
  // carried over, with the rows filed, which are then part of the tree the next stop compares.
  const again = parts.filter((p) => p.kind === "recheck");
  if (again.length) {
    const docs = [...new Set(rec.rows.filed.map((e) => e.file))].join(" and ");
    if (browser && !devServerReady && needsServer(again.filter((p) => !rec.done.includes(p.key)))) {
      const ds = await devServerFor(g, sections);
      devServerReady = ds.ok;
      if (!ds.ok) return await fail(`${ds.failure} once the findings were filed in ${docs}`, "checks", null);
    }
    const rr = await runCheckParts(g, rec, again, { step, devServerReady, ranHere });
    sections.push(...rr.sections.map((s) => ({ ...s, title: `${s.title} (with the findings filed)` })));
    timings.push(...rr.timings.map((t) => ({ ...t, name: `${t.name} (with the findings filed)` })));
    await recordCheckTimesNow(g, rr.ran);
    if (rr.carry) return await park(rr.carry);
    if (rr.failedCheck) {
      const f = checkFailure(g, rr.failedCheck, step);
      if (rr.failedCheck.outOfTime) return await outOfTime(`The verification of ${label} ran out of time: ${f}`, "recheck");
      return await fail(`${f} once the findings were filed in ${docs}`, "checks", rr.failedCheck);
    }
  }
  if (rec.turns) sections.push({ title: "Spread over turns", body: `The verification did not fit in one stop of the gate, so it ran over ${rec.turns + 1} stops, as much of it as fitted in each.` });
  const report = writeReport({ root, step: step.id, attempt, title: `AutoClaude report: ${feature && phase ? `${label}, verified at ${step.id},` : step.id} attempt ${attempt} passed`, sections });
  const toTick = rec.ticked;
  const tickedIds = [...new Set([...(st.tickedByGate || []), ...toTick])];
  const filed = rec.rows.filed;
  const findings = fixupFindings(config, followUps, securityFindings, { followUps: rec.rows.followUps, security: rec.rows.security });
  if (feature && findings.length) {
    // The fix-up pass (D49): the builder fixes or hands over each finding, then the checks run
    // once more before the feature is committed. The state records the pass (with the
    // snapshot's id) before the snapshot goes.
    const fixup = { phase: phase ? phase.num : null, stepId: step.id, findings, attempt, report: report.relPath, checks: timings, at: nowIso(deps), verifyId: snap.id };
    const next = { ...st, tickedByGate: tickedIds, fixup, attempts: { ...st.attempts, [step.id]: 0 }, infraFailures: { ...(st.infraFailures || {}), [step.id]: 0 }, outOfTime: { ...(st.outOfTime || {}), [step.id]: 0 }, noProgress: 0 };
    ev("fixup", { step: step.id, findings: findings.length, report: report.relPath });
    logLine(root, `${label} verified at ${step.id} with ${findings.length} non-blocking finding(s); fix-up pass before it closes`);
    const meanwhile = pausedMeanwhile(root);
    if (meanwhile) {
      save(g, { ...next, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
      clearPending(root);
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    const owner = ownerInput(next, config);
    save(g, owner.mark({ ...next, toolCallsAtLastGate: readHeartbeat(root).count }));
    clearPending(root);
    return block(`${owner.text}${fixupText(g, fixup)}`, events);
  }
  // The outcome is recorded (the ticks, and the commit to make) before the snapshot goes: a gate
  // cut off from here on, in a slow pre-commit hook, the tag or the push, leaves ticks the next
  // stop accepts and a commit it finishes, never ticks it reverts or a feature verified twice.
  // With the tree that was verified, and how to take this verification out again, in case the
  // files have changed by then.
  const undo = { ...rec.undo, rows: filed.map(({ file, text, created }) => ({ file, text, created })) };
  const closing = {
    verifyId: snap.id, stepId: step.id, scope: rec.scope, attempt, timings, findings: findings.length, report: report.relPath,
    feature, phaseEnd, fixupDone: false, headBefore: config.git.commitEachStep ? await git.head(root, { env }) : null,
    tree: config.git.commitEachStep ? await stagedTree(g) : null, undo, pid: g.pid, at: new Date().toISOString()
  };
  updateState(root, (s) => { s.tickedByGate = [...new Set([...(s.tickedByGate || []), ...toTick])]; s.closing = closing; s.verifying = null; });
  clearPending(root);
  return await close(g, { ...st, tickedByGate: tickedIds, closing }, { step, parsed: tparsed, scope, closing });
}

// A stop of a verification carried over from an earlier one (state.verifying, parked by
// runVerification): it goes on with the parts not done yet, on the same files. When the files
// changed since that stop (other than the resume file alone, as for a cut-off close) it starts
// again from its first part instead, counting nothing: this returns { restart: stepId }, which
// runGate acts on as the ready the verification began with, and the third time the run pauses.
// A record whose snapshot is gone or whose ticks were changed, or a question from the builder,
// drops it: its ticks and PROGRESS lines come out, and the stop goes on as usual (null). The
// checks of a fix-up pass carried over (rec.fixup) go on the same way (runFixupChecks), and are
// dropped when their pass is no longer under way; started again, they are the pass's ready.
async function carryOn(g, state, parsed) {
  const { root, config, cli, ev, events, say } = g;
  const rec = state.verifying;
  let snap = null;
  try { snap = readJson(pendingVerifyFile(root), null); } catch { snap = null; }
  const own = !!(snap && snap.id && snap.id === rec.verifyId);
  const fixupChecks = !!rec.fixup;
  const what = fixupChecks ? `the fix-up checks of Phase ${rec.phase}` : `the verification of ${rec.feature && Number.isInteger(rec.phase) ? `Phase ${rec.phase}` : rec.stepId}`;
  const was = fixupChecks ? "were" : "was";
  const drop = (why) => {
    const ids = undoVerification(root, config, own ? snap : rec.undo || {});
    if (own) clearPending(root);
    updateState(root, (s) => { s.verifying = null; });
    state.verifying = null;
    ev("verify-dropped", { step: rec.stepId, why });
    logLine(root, `${what} carried over from an earlier stop ${was} dropped: ${why}${ids.length ? ` (unticked ${ids.join(", ")})` : ""}`);
    return null;
  };
  const ticks = Array.isArray(rec.ticked) ? rec.ticked : [];
  if (!own) return drop("its snapshot is gone");
  const at0 = stepById(parsed, rec.stepId);
  if (!at0 || (fixupChecks && at0.marker !== MARKERS.done) || !ticks.every((id) => (stepById(parsed, id) || {}).marker === MARKERS.done)) return drop("its plan ticks were changed");
  if (fixupChecks && !(state.fixup && state.fixup.stepId === rec.stepId)) return drop("its fix-up pass is no longer under way");
  if (readBlocked(root)) return drop("the builder asked the owner a question");
  const tree = await stagedTree(g);
  if (rec.tree && tree && tree !== rec.tree && !(await onlyResumeFileChanged(g, rec.tree, tree))) {
    const restarts = (rec.restarts || 0) + 1;
    undoCutVerification(root, config, { own: true });
    state.verifying = null;
    if (restarts > MAX_STAGED_RESTARTS) {
      save(g, { ...state, status: STATUS.paused, pauseReason: "stuck" });
      stopDevServer({ root });
      ev("paused", { reason: "stuck", step: rec.stepId, restarts });
      logLine(root, `the files changed between the stops of ${what} ${restarts} times; paused as stuck`);
      await say({ title: `AutoClaude stuck on ${rec.stepId}`, message: `${what[0].toUpperCase()}${what.slice(1)} did not fit in one stop, and the files changed between ${fixupChecks ? "their" : "its"} stops ${restarts} times, so ${fixupChecks ? "they" : "it"} started again each time and never finished. Something changes the project while the gate waits between stops: the builder, or a process writing to files git tracks. Look at the project, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    g.restarts = restarts;
    ev("verify-restarted", { step: rec.stepId, restarts });
    logLine(root, `the files changed since the last stop of ${what}; ${fixupChecks ? "they start" : "it starts"} again from ${fixupChecks ? "their" : "its"} first part, and nothing is counted`);
    return { restart: rec.stepId };
  }
  const ready = readReady(root);
  if (ready && (!ready.step || ready.step === rec.stepId)) clearReady(root);
  const at = new Date().toISOString();
  const live = { ...rec, parked: false, pid: g.pid, at };
  const held = { ...snap, pid: g.pid, at };
  updateState(root, (s) => { s.verifying = live; });
  writeJsonAtomic(pendingVerifyFile(root), held);
  ev("verify-continued", { step: rec.stepId, turn: (rec.turns || 0) + 1, done: [...(rec.done || [])], ...(fixupChecks ? { fixup: true } : {}) });
  logLine(root, `${what} ${fixupChecks ? "go" : "goes"} on at ${rec.stepId}, stop ${(rec.turns || 0) + 1} of ${fixupChecks ? "them" : "it"} (${(rec.done || []).length} part(s) done)`);
  if (fixupChecks) return await runFixupChecks(g, { ...state, verifying: null }, live, held, parsed);
  return await runVerification(g, { ...state, verifying: null }, live, held, parsed);
}

// The ready after a fix-up pass: every finding has an outcome, then the checks only (the ticks
// and PROGRESS lines are already written), then the feature closes.
async function fixupReady(g, state, step, parsed) {
  const { root, config, cli, ev, events, say } = g;
  const fixup = state.fixup;
  const attempt = (state.attempts[step.id] || 0) + 1;
  const max = config.retries.maxAttemptsPerStep;
  // Each finding fixed, or left for the owner with a reason (D49). A ready without that is an
  // attempt, so a pass that never records them cannot loop. A row the builder deleted goes back,
  // left for the owner, before anything is counted: nobody but the gate has its exact text.
  let open = openFixupFindings(root, fixup.findings);
  const gone = open.filter((f) => f.status === null);
  let putBack = "";
  if (gone.length) {
    const n = putBackRows(g, gone);
    ev("fixup-rows-restored", { step: step.id, rows: n });
    logLine(root, `fix-up pass of Phase ${fixup.phase} at ${step.id}: ${n} findings row(s) deleted instead of given a status were put back, left for the owner: ${gone.map((f) => f.text).join("; ")}`);
    putBack = `The row${n === 1 ? "" : "s"} of ${gone.map((f) => `"${f.text}"`).join(", ")} ${n === 1 ? "was" : "were"} deleted; I put ${n === 1 ? "it" : "them"} back, left for the owner. Never delete a findings row: set its Status instead.\n\n`;
    open = openFixupFindings(root, fixup.findings);
  }
  if (open.length) {
    const attempts = { ...state.attempts, [step.id]: attempt };
    const n = open.length;
    const list = open.map((f, i) => `${i + 1}. [${f.source}, ${f.severity}] ${f.text} (${f.doc}): ${f.status === null ? "its row is no longer in the file" : `status "${f.status}"`}`).join("\n");
    ev("fixup-open", { step: step.id, open: n, attempt });
    logLine(root, `fix-up pass of Phase ${fixup.phase} at ${step.id}, attempt ${attempt}: ${n} finding(s) without an outcome`);
    if (attempt >= max) {
      save(g, { ...state, attempts, status: STATUS.paused, pauseReason: "step-failed" });
      stopDevServer({ root });
      ev("paused", { reason: "step-failed", fixup: true });
      await say({ title: `AutoClaude paused: the fix-up pass of Phase ${fixup.phase} left findings open ${attempt} times`, message: `${n} finding${n === 1 ? "" : "s"} still ha${n === 1 ? "s" : "ve"} no outcome:\n${list}\nSet each row's Status to "fixed" or "left for the owner: <why>", then \`${cli} resume\` (the run resumes in the fix-up pass).`, priority: "high" });
      return allow(events);
    }
    const meanwhile = pausedMeanwhile(root);
    if (meanwhile) {
      save(g, { ...state, attempts, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    const owner = ownerInput(state, config);
    save(g, owner.mark({ ...state, attempts }));
    return block(`${owner.text}${putBack}The fix-up pass of Phase ${fixup.phase} is not finished (attempt ${attempt}/${max}): ${n} finding${n === 1 ? " still has" : "s still have"} no outcome. For each one, fix it and set its row's Status to "fixed", or set it to "left for the owner: <why, and what fixing it would take>". Then run \`${cli} ready ${step.id}\` again.\n\n${list}`, events);
  }
  ev("verify", { step: step.id, attempt, fixup: true });
  logLine(root, `fix-up checks for Phase ${fixup.phase} at ${step.id}, attempt ${attempt}`);
  // Nothing to undo, but a pass cut off by the hook's timeout counts like a verification.
  const snap = { id: crypto.randomUUID(), step: step.id, fixup: true, pid: g.pid, at: new Date().toISOString(), ticked: [] };
  writeJsonAtomic(pendingVerifyFile(root), snap);
  // What the checks have done so far: the record a stop parks in state.verifying (fixup: true)
  // when the rest does not fit, as for a verification (D60).
  const rec = {
    verifyId: snap.id, stepId: step.id, feature: true, fixup: true, phase: fixup.phase, attempt, scope: [], ticked: [], undo: {},
    done: [], sections: [], timings: [], turns: 0, restarts: g.restarts || 0, startedAt: snap.at
  };
  return await runFixupChecks(g, { ...state, verifying: null }, rec, snap, parsed);
}

// The checks of a fix-up pass, on the files as the pass left them (the ticks and PROGRESS lines
// are already written), then the feature closes. Staged like a verification's checks (D60): one
// check per part, as many as fit in this stop, the rest carried to the next (parkStaged); only a
// check that does not fit even as the first part of a stop is out of time. rec.done names the
// checks done in earlier stops, rec.sections and rec.timings keep what they gave.
async function runFixupChecks(g, st, rec, snap, parsed) {
  const { root, config, cli, ev, events, say } = g;
  const fixup = st.fixup;
  const step = stepById(parsed, rec.stepId);
  const attempt = rec.attempt;
  const max = config.retries.maxAttemptsPerStep;
  const { sections, timings } = rec;
  const parts = checkParts(config, await recordedCheckTimes(g));
  const todo = parts.filter((p) => !rec.done.includes(p.key));
  let failure = null;
  let failedCheck = null;
  let devServerReady = false;
  if (config.devServer.command && config.devServer.url && todo.some((p) => p.check.needsDevServer)) {
    const ds = await devServerFor(g, sections);
    devServerReady = ds.ok;
    failure = ds.failure;
  }
  const cr = failure ? null : await runCheckParts(g, rec, todo, { step, devServerReady });
  if (cr) {
    sections.push(...cr.sections);
    timings.push(...cr.timings);
    await recordCheckTimesNow(g, cr.ran);
    if (cr.failedCheck) { failedCheck = cr.failedCheck; failure = checkFailure(g, failedCheck, step); }
  }
  await noteFootprintNow(g);
  if (cr && cr.carry) {
    return await parkStaged(g, st, rec, snap, parts, { why: cr.carry, what: `the fix-up checks of Phase ${fixup.phase} at ${step.id}`, head: `The fix-up checks of Phase ${fixup.phase} go on`, again: "the fix-up checks" });
  }
  if (failedCheck && failedCheck.outOfTime) {
    const n = ((st.outOfTime || {})[step.id] || 0) + 1;
    const report = writeReport({ root, step: `${step.id}-fixup`, attempt: `${attempt}-time${n}`, title: `AutoClaude report: the fix-up checks of Phase ${fixup.phase} ran out of time`, sections });
    clearPending(root);
    return await ranOutOfTime(g, st, step, `The fix-up checks of Phase ${fixup.phase} ran out of time: ${failure}`, report.relPath, "check");
  }
  if (failure) {
    clearPending(root);
    const report = writeReport({ root, step: `${step.id}-fixup`, attempt, title: `AutoClaude report: the fix-up checks of Phase ${fixup.phase}, attempt ${attempt}`, sections });
    const attempts = { ...st.attempts, [step.id]: attempt };
    const outOfTimeCounts = { ...(st.outOfTime || {}), [step.id]: 0 };
    ev("failed", { step: step.id, attempt, failure, report: report.relPath, fixup: true });
    logLine(root, `fix-up checks of Phase ${fixup.phase} attempt ${attempt} failed: ${failure} (${report.relPath})`);
    if (attempt >= max) {
      save(g, { ...st, attempts, outOfTime: outOfTimeCounts, status: STATUS.paused, pauseReason: "step-failed" });
      stopDevServer({ root });
      ev("paused", { reason: "step-failed", fixup: true });
      await say({ title: `AutoClaude paused: the fix-up checks of Phase ${fixup.phase} failed ${attempt} times`, message: `${failure}\nReport: ${report.relPath}\nThe feature passed its verification; its fix-up pass broke a check. Fix it, then \`${cli} resume\` (the run resumes in the fix-up pass).`, priority: "high" });
      return allow(events);
    }
    const meanwhile = pausedMeanwhile(root);
    if (meanwhile) {
      save(g, { ...st, attempts, outOfTime: outOfTimeCounts, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    const owner = ownerInput(st, config);
    save(g, owner.mark({ ...st, attempts, outOfTime: outOfTimeCounts }));
    const failingSections = sections.filter((s) => /FAILED|failed|NOT RUN/.test(s.title));
    return block(owner.text + summarize({ headline: `The fix-up checks of Phase ${fixup.phase} (attempt ${attempt}/${max}) failed: ${failure}. Fix the causes, then run \`${cli} ready ${step.id}\` again.`, sections: failingSections, reportPath: report.relPath, maxChars: MAX_REASON - owner.text.length }), events);
  }
  if (rec.turns) sections.push({ title: "Spread over turns", body: `The fix-up checks did not fit in one stop of the gate, so they ran over ${rec.turns + 1} stops, as many of them as fitted in each.` });
  const report = writeReport({ root, step: `${step.id}-fixup`, attempt, title: `AutoClaude report: the fix-up checks of Phase ${fixup.phase}, attempt ${attempt} passed`, sections });
  const scope = step.phase ? step.phase.steps : [step];
  const closingTimings = [...(fixup.checks || []), ...timings.map((t) => ({ ...t, name: `${t.name} (after the fix-up)` }))];
  const closing = {
    verifyId: null, stepId: step.id, scope: scope.map((s) => s.id), attempt: fixup.attempt || 1, timings: closingTimings, findings: fixup.findings.length,
    report: [fixup.report, report.relPath].filter(Boolean).join(" and "), feature: true, phaseEnd: true, fixupDone: true,
    headBefore: config.git.commitEachStep ? await git.head(root, { env: g.env }) : null,
    tree: config.git.commitEachStep ? await stagedTree(g) : null, pid: g.pid, at: new Date().toISOString()
  };
  updateState(root, (s) => { s.closing = closing; s.verifying = null; });
  clearPending(root);
  return await close(g, { ...st, closing }, { step, parsed, scope, closing });
}

// A verified commit whose gate was cut off (the hook's timeout in a slow pre-commit hook, the
// tag or the push) before the state recorded it: finished from state.closing. Returns null when
// there is nothing to finish, and the normal stop goes on.
async function resumeClose(g, state, parsed) {
  const { root, config, ev, events } = g;
  const rec = state.closing;
  // Still in the hands of a gate that is alive.
  if (heldByLiveGate(rec, g.pid, config)) {
    ev("gate-busy", { closing: rec.stepId });
    return allow(events);
  }
  const step = stepById(parsed, rec.stepId);
  if (!step || step.marker !== MARKERS.done) {
    updateState(root, (s) => { s.closing = null; });
    state.closing = null;
    ev("close-dropped", { step: rec.stepId });
    logLine(root, `the commit of ${rec.stepId} was cut off, and the step is no longer ticked; it is done again`);
    return null;
  }
  // The files changed after the checks passed (the builder carried on, the owner edited during a
  // pause): committing them now would record unchecked work as verified, so it is verified again.
  // A change to CONTINUE_HERE.md alone is not: a relaunched builder rewrites it before its ready.
  if (config.git.commitEachStep && rec.tree && !(await committedAt(g, rec, step))) {
    const tree = await stagedTree(g);
    if (tree && tree !== rec.tree && !(await onlyResumeFileChanged(g, rec.tree, tree))) return await verifyAgain(g, state, rec, step);
  }
  clearReady(root);
  ev("close-resumed", { step: step.id });
  logLine(root, `the commit of ${rec.stepId} was cut off; finishing it`);
  const scope = (Array.isArray(rec.scope) && rec.scope.length ? rec.scope : [step.id]).map((id) => stepById(parsed, id)).filter(Boolean);
  return await close(g, { ...state }, { step, parsed, scope, closing: rec, resumed: true });
}

// A cut-off close whose tree is no longer the verified one. A close after a fix-up pass goes
// back to that pass (the step and its phase stay ticked; the next ready runs the checks again).
// Any other close takes out its ticks, PROGRESS lines and findings rows (state.closing.undo),
// and the current step is the first unfinished one again (a resume during the pause had moved
// it past the ticked step), so its ready verifies the step or the feature from the start. A
// ready already waiting for that step is acted on in this stop (returns null, and the stop goes
// on); otherwise the builder is told.
// A passing verification resets the step's out-of-time count, so cut-off closes have their own
// count (reset when a close commits): the second one pauses as out of time, with its alert,
// instead of verifying again every night long.
async function verifyAgain(g, state, rec, step) {
  const { root, config, cli, ev, events } = g;
  const fixupPass = !!(rec.fixupDone && state.fixup && state.fixup.stepId === step.id);
  let undone = [];
  if (!fixupPass) undone = undoVerification(root, config, rec.undo || { markers: { [step.id]: MARKERS.todo }, ticked: [step.id] });
  const after = parsePlan(readText(g.planFile, "") || "");
  const cur = fixupPass ? stepById(after, step.id) || step : firstUnfinished(after) || stepById(after, step.id) || step;
  const key = closeCutoffKey(step.id);
  const saved = updateState(root, (s) => {
    s.closing = null;
    s.tickedByGate = (s.tickedByGate || []).filter((id) => !undone.includes(id) || isFinished(stepById(after, id) || {}));
    s.currentStep = cur.id;
    s.outOfTime = { ...(s.outOfTime || {}), [key]: ((s.outOfTime || {})[key] || 0) + 1 };
  });
  Object.assign(state, { closing: null, tickedByGate: saved.tickedByGate, currentStep: cur.id, outOfTime: saved.outOfTime });
  const phase = step.phase;
  const what = rec.feature && phase ? `Phase ${phase.num} (${phase.title})` : step.id;
  const cutoffs = saved.outOfTime[key];
  if (cutoffs >= 2) {
    ev("close-changed", { step: step.id, fixup: fixupPass, unticked: undone, cutoffs });
    logLine(root, `the commit of ${step.id} was cut off ${cutoffs} times after its checks passed, and the files changed each time; pausing as out of time`);
    return await pauseOutOfTime(g, saved, cur.id, `The commit of ${what} was cut off ${cutoffs} times after its verification passed (the hook's time limit), and the files had changed each time, so it would be verified again`);
  }
  ev("close-changed", { step: step.id, fixup: fixupPass, unticked: undone });
  logLine(root, `the commit of ${step.id} was cut off, and the files changed after its checks passed; ${fixupPass ? "its fix-up checks run again" : `it is verified again${undone.length ? ` (unticked ${undone.join(", ")})` : ""}`}`);
  const ready = readReady(root);
  if (ready && (!ready.step || ready.step === cur.id)) return null;
  const again = fixupPass
    ? `the checks run again on the files as they are now before the feature closes`
    : `it is verified again: its plan ticks and PROGRESS lines were taken out`;
  return block(`${what} passed its verification, but its commit was cut off and the files changed after the checks passed, so ${again}. ${cur.id === step.id ? "" : `The current step is ${cur.id} (${cur.title}). `}When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${cur.id}\`.\n\n${stepText(after, cur)}`, events);
}

// The state.outOfTime key that counts a step's cut-off closes.
export function closeCutoffKey(stepId) {
  return `close:${stepId}`;
}

// True when two trees differ only in the resume file (docs.continueHere).
async function onlyResumeFileChanged(g, fromTree, toTree) {
  const r = await git.git(g.root, ["diff-tree", "-r", "--name-only", "--no-renames", fromTree, toTree], { env: g.env });
  if (!r.ok) return false;
  const changed = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const resumeFile = g.config.docs.continueHere.replace(/\\/g, "/").replace(/^\.\//, "");
  return changed.length > 0 && changed.every((p) => p === resumeFile);
}

// The subject of a commit, or "".
async function subjectOf(g, sha) {
  const r = await git.git(g.root, ["log", "-1", "--format=%s", sha], { env: g.env });
  return r.ok ? r.stdout.trim() : "";
}

// The commit a cut-off close made before the state recorded it (HEAD moved on from the
// record's headBefore to a commit of this step), or null.
async function committedAt(g, rec, step) {
  const head = await git.head(g.root, { env: g.env });
  return head && head !== rec.headBefore && (await subjectOf(g, head)).startsWith(`autoclaude(${step.id}): `) ? head : null;
}

// The tree a commit of the working tree would hold now: staged the way git.commitAll stages it
// (git.stageForCommit: everything but secrets/ and docs/private/), then written with write-tree.
// A verified close records it, so a close finished by a later stop can tell whether the files are
// still the verified ones. Staged in a copy of the index (GIT_INDEX_FILE), so the real one is left
// as it was. null when git cannot say.
async function stagedTree(g) {
  const where = await git.git(g.root, ["rev-parse", "--git-path", "index"], { env: g.env });
  if (!where.ok || !where.stdout.trim()) return null;
  const real = path.resolve(g.root, where.stdout.trim());
  const copy = path.join(os.tmpdir(), `autoclaude-index-${process.pid}-${crypto.randomBytes(4).toString("hex")}`);
  try {
    if (fs.existsSync(real)) fs.copyFileSync(real, copy);
    const opts = { env: { ...g.env, GIT_INDEX_FILE: copy } };
    const staged = await git.stageForCommit(g.root, opts);
    if (!staged.ok) return null;
    const r = await git.git(g.root, ["write-tree"], opts);
    return r.ok ? r.stdout.trim() || null : null;
  } catch {
    return null;
  } finally {
    try { fs.rmSync(copy, { force: true }); } catch {}
  }
}

// A verified step or feature: commit with a body, tag a phase end, push, alert, move on.
// c.closing is the state's record of it (state.closing); c.resumed when a later stop finishes
// the close a cut-off gate began.
async function close(g, st, c) {
  const { root, config, env, deps, ev, events, cli } = g;
  const { step, parsed, closing: rec } = c;
  const feature = !!rec.feature;
  const phaseEnd = !!rec.phaseEnd;
  const phase = step.phase;
  let sha = null;
  let commitError = null;
  let tagName = null;
  let message = null;
  if (config.git.commitEachStep) {
    const lead = feature && phase
      ? `Verified Phase ${phase.num} (${phase.title}) as one feature: ${c.scope.map((s) => s.id).join(", ")}, attempt ${rec.attempt}${rec.fixupDone ? ", then a fix-up pass" : ""}.`
      : `Verified ${step.id}, attempt ${rec.attempt}.`;
    message = await commitMessage(g, { subject: `autoclaude(${step.id}): ${step.title}`, lead, steps: c.scope, timings: rec.timings || [], findings: rec.findings || 0, report: rec.report });
    // A cut-off gate may have made the commit already, before the state recorded it.
    const head = c.resumed ? await committedAt(g, rec, step) : null;
    if (head) {
      sha = head;
      logLine(root, `${step.id} was committed (${head.slice(0, 7)}) before its gate was cut off; carrying on from that commit`);
    } else {
      const r = await git.commitAll(root, message, { env });
      if (!r.ok) { commitError = String(r.stderr || "").trim() || "unknown error"; logLine(root, `commit failed: ${commitError}`); }
      else if (!r.committed) {
        // Nothing to commit: the verification's ticks were taken out before the commit (another
        // session's gate, an edit). Nothing verified reached git, so it is verified again.
        updateState(root, (s) => { s.closing = null; });
        ev("close-lost", { step: step.id });
        logLine(root, `${step.id} passed, but nothing was left to commit: its plan ticks were taken out before the commit`);
        return block(`${feature && phase ? `Phase ${phase.num} (${phase.title})` : step.id} passed its verification, but its plan ticks were gone before the gate could commit them (another session's gate or an edit took them out), so nothing was committed. Run \`${cli} ready ${step.id}\` again.`, events);
      } else sha = r.sha || null;
    }
    if (sha && phaseEnd && config.git.tagPhaseEnds && phase) {
      const t = await phaseTag(root, config, parsed, phase.num, { env, base: st.baseCommit });
      if (t.other) logLine(root, `${t.plain} marks Phase ${phase.num} of ${t.other}, not of this run; this run's Phase ${phase.num} is tagged ${t.name}`);
      // Already on this very commit: a close that was cut off after its tag.
      if (t.sha && t.sha === sha) tagName = t.name;
      // A phase verified again (the owner reopened or added a step) keeps the tag of its first
      // verification while pushes are on: a pushed tag moves only with a force push, which a run
      // never makes, and a moved one would fail every later push.
      else if (t.sha && config.git.push) logLine(root, `${t.name} already marks an earlier verification of Phase ${phase.num}; left where it is`);
      else {
        const r = await git.tag(root, t.name, { force: true, env });
        if (r.ok) tagName = t.name;
        else logLine(root, `tag failed: ${r.stderr}`);
      }
    }
  }
  ev("passed", { step: step.id, attempt: rec.attempt, sha, phaseEnd, ...(feature ? { feature: phase ? phase.num : null } : {}), ...(c.resumed ? { resumed: true } : {}) });
  logLine(root, `${feature && phase ? `Phase ${phase.num} (at ${step.id})` : step.id} verified${sha ? ` (${sha.slice(0, 7)})` : commitError ? " but NOT committed" : ""}`);

  // Owner input that reached the builder (in a gate message) belonged to this step: done with.
  // Notes not yet delivered stay pending for the next step or the next session start.
  // The feature's base and start time go with it, unless another feature still has built steps
  // (the owner reopened an earlier phase in the middle of a later one): that one's review and
  // timing still need them.
  const took = st.phaseStartedAt ? fmtMinutes(nowMs(deps) - Date.parse(st.phaseStartedAt)) : null;
  const featureDone = phaseEnd && !parsed.steps.some((s) => s.marker === MARKERS.built);
  const base = {
    ...st, attempts: { ...st.attempts, [step.id]: 0 }, infraFailures: { ...(st.infraFailures || {}), [step.id]: 0 }, outOfTime: { ...(st.outOfTime || {}), [step.id]: 0 },
    noProgress: 0, headAtLastGate: sha || st.headAtLastGate, fixup: null, closing: null,
    pendingNotes: (st.pendingNotes || []).filter((n) => !n.delivered), ownerAnswer: null,
    ...(featureDone ? { phaseBaseCommit: null, phaseStartedAt: null } : {})
  };
  const next = nextStep(parsed);
  if (commitError) return await commitFailed(g, base, step, next, commitError, message);
  // Recorded at once (only the fields the commit settled, so an owner pause made meanwhile
  // stands): a gate cut off from here on, say by the hook's timeout during a slow push, leaves a
  // state the next stop carries on from, and a tag the next push takes along.
  const pendingTag = tagName && config.git.push ? tagName : null;
  updateState(root, (s) => {
    s.tickedByGate = base.tickedByGate; s.fixup = null; s.closing = null; s.headAtLastGate = sha || s.headAtLastGate;
    s.attempts = { ...(s.attempts || {}), [step.id]: 0 };
    s.outOfTime = { ...(s.outOfTime || {}), [step.id]: 0, [closeCutoffKey(step.id)]: 0 };
    if (featureDone) { s.phaseBaseCommit = null; s.phaseStartedAt = null; }
    if (pendingTag) {
      const prev = s.pushState || { branch: null, remote: null, unpushedCommits: null };
      s.pushState = { ...prev, ok: false, skipped: false, at: nowIso(deps), error: "the gate stopped before its push finished", unpushedTags: [...new Set([...(prev.unpushedTags || []), pendingTag])] };
    }
  });
  if (sha && config.git.push) base.pushState = await pushNow(g, base, tagName);
  // The last feature's alert is the completion alert.
  if (next) {
    if (phaseEnd && phase) {
      const ps = config.git.push ? base.pushState : null;
      const pushed = ps ? (ps.ok ? ` Pushed to ${ps.remote}.` : ps.skipped ? "" : ` Push FAILED: ${ps.error}.`) : "";
      // Per step, the phase's steps were verified one by one; per feature, all at once.
      const n = feature ? c.scope.length : phase.steps.length;
      await g.sayEvent("featureVerified", { title: `AutoClaude: Phase ${phase.num} verified`, message: `Phase ${phase.num} ${phase.title}: ${n} step${n === 1 ? "" : "s"} verified${took ? ` in ${took}` : ""}${rec.attempt > 1 ? ` (attempt ${rec.attempt})` : ""}${rec.fixupDone ? ", after a fix-up pass" : ""}.${pushed} Next: ${next.id} ${next.title}.`, priority: "default" });
    }
    if (!feature) await g.sayEvent("stepVerified", { title: `AutoClaude: ${step.id} verified`, message: `${step.id} ${step.title} passed its checks (attempt ${rec.attempt}) and is committed. Next: ${next.id} ${next.title}.`, priority: "low" });
  }
  return await advance(g, base, { step, parsed, next, sha, phaseEnd, closedFeature: phaseEnd, feature, scope: c.scope });
}

// A step that passed (or was built) but could not be committed stops the run: carrying on would
// pile later steps onto an unrecorded one (seen live: git was not on the run window's PATH, and
// the last step was reported verified and the plan complete with nothing committed).
// `autoclaude resume` commits the pending steps, with the message kept here, before the session
// restarts.
async function commitFailed(g, base, step, next, commitError, message = null) {
  const { root, cli, ev, events, say } = g;
  const uncommittedMessages = { ...(base.uncommittedMessages || {}), ...(message ? { [step.id]: message } : {}) };
  save(g, { ...base, closing: null, uncommitted: [...(base.uncommitted || []), step.id], uncommittedMessages, currentStep: next ? next.id : null, status: STATUS.paused, pauseReason: "commit-failed", stepStartedAt: null });
  stopDevServer({ root });
  ev("paused", { reason: "commit-failed" });
  const why = commitError.split(/\r?\n/)[0].slice(0, 300);
  await say({ title: `AutoClaude paused: ${step.id} passed but was not committed`, message: `git said: ${why}\nThe work is safe in the working tree. Fix git on this machine (is it on PATH where the run was started?), then \`${cli} resume\`, which commits it first.`, priority: "high" });
  return allow(events);
}

// After a commit: an owner pause, the end of the plan, a review pause, the weekly usage gate, a
// fresh builder for the next feature, or on to the next step in this session.
async function advance(g, base, { step, parsed, next, sha, phaseEnd, closedFeature, built = false, feature = false, scope = [] }) {
  const { root, config, deps, cli, ev, events, say } = g;
  // The owner paused (`pause --now`) while this gate ran. The step is committed, but the run
  // stays paused: saving `base` would have set it back to running.
  const meanwhile = next ? pausedMeanwhile(root) : null;
  if (meanwhile) {
    save(g, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession, pauseRequested: false, stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "owner", during: "verification" });
    return allow(events);
  }
  if (!next) return await finishPlan(g, base, parsed);

  const phase = step.phase;
  const what = built
    ? `Built ${step.id} ${step.title} (verified with Phase ${phase.num})`
    : feature && phase ? `Verified Phase ${phase.num} ${phase.title} (${scope.map((s) => s.id).join(", ")})` : `Verified ${step.id} ${step.title}`;
  // An `autoclaude pause` made while this gate verified counts for this commit.
  base.pauseRequested = ownerPauseRequest(g, loadState(root), base.pauseRequested);
  const pauseNow = base.pauseRequested || config.review.pauseAt === "every-step" || (phaseEnd && config.review.pauseAt === "phase-end");
  if (pauseNow) {
    save(g, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: "review", pauseRequested: false, stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "review" });
    await say({ title: "AutoClaude paused for review", message: `${what}. Next: ${next.id} ${next.title}.\nLeave notes with \`${cli} note "..."\`, then \`${cli} resume\`.`, priority: "default" });
    return allow(events);
  }

  // Usage gate (P5.5). Stale or missing data never pauses a run; it is logged once until fresh
  // data arrives again.
  const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: nowMs(deps) });
  if (usage.stale) {
    if (!base.usageStaleWarned) {
      logLine(root, `WARNING usage data is ${usage.source ? `${Math.round(usage.ageMin)} min old` : "missing"} (staleAfterMin ${config.usage.staleAfterMin}); the weekly-limit pause is not enforced until fresh data arrives`);
      ev("usage-stale");
    }
    base.usageStaleWarned = true;
  } else {
    base.usageStaleWarned = false;
  }
  if (!usage.stale && usage.sevenDay && usage.sevenDay.pct >= config.usage.weeklyPauseAtPct) {
    save(g, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: "weekly-limit", stepStartedAt: null, weeklyResetsAt: usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toISOString() : null });
    stopDevServer({ root });
    ev("paused", { reason: "weekly-limit", pct: usage.sevenDay.pct });
    const resets = usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toLocaleString() : "unknown";
    await say({ title: "AutoClaude paused: weekly usage limit", message: `7-day usage is ${Math.round(usage.sevenDay.pct)}% (threshold ${config.usage.weeklyPauseAtPct}%). Resets ${resets}. ${config.usage.autoResumeAfterWeeklyReset ? "The supervisor resumes after the reset." : `Resume with \`${cli} resume\` when you want.`}`, priority: "default" });
    return allow(events);
  }

  // A fresh builder per feature (D49): with a supervisor to start it, this session stops here.
  // Without one (a run started by hand in this session) the session carries on as before.
  if (closedFeature) {
    const pid = (deps.liveSupervisorPid || liveSupervisorPid)(root);
    if (pid) {
      save(g, { ...base, currentStep: next.id, stepStartedAt: nowIso(deps), freshSession: true, toolCallsAtLastGate: readHeartbeat(root).count });
      ev("fresh-session", { next: next.id, supervisorPid: pid });
      logLine(root, `feature closed; the supervisor (pid ${pid}) starts a fresh builder for ${next.id}`);
      return allow(events);
    }
  }

  const owner = ownerInput(base, config);
  save(g, owner.mark({ ...base, currentStep: next.id, stepStartedAt: nowIso(deps), toolCallsAtLastGate: readHeartbeat(root).count }));
  ev("advanced", { next: next.id });
  const short = sha ? ` (${sha.slice(0, 7)})` : "";
  const done = built
    ? `${step.id} built and committed${short}; Phase ${phase.num} is verified as a whole when ${closerText(parsed, phase.num)} is ready, so run only the tests for what you change`
    : feature && phase ? `Phase ${phase.num} (${phase.title}) verified and committed${short}` : `${step.id} verified and committed${short}`;
  return block(`${owner.text}${done}. Next: ${next.id} ${next.title}. When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${next.id}\`.\n\n${stepText(parsed, next)}`, events);
}

// No step is left to do. Built steps no verification would reach first go back to [ ] (the
// owner ticked the step that closes their feature, a start that skipped them, verifyAt changed
// to "step", or the phase is now verified step by step), so a plan never completes with an
// unverified step; then the plan completes.
async function finishPlan(g, state, parsed) {
  const { root, config, deps, cli, ev, events, planFile } = g;
  const { text, reopened } = reopenForMode(readText(planFile, ""), config);
  if (!reopened.length) return await complete(g, state, parsed);
  writeFileAtomic(planFile, text);
  const rp = parsePlan(text);
  const step = stepById(rp, reopened[0]);
  ev("reopened", { ids: reopened });
  logLine(root, `reopened ${reopened.join(", ")}: built but never verified`);
  const next = { ...state, tickedByGate: (state.tickedByGate || []).filter((id) => !reopened.includes(id)), currentStep: step.id, stepStartedAt: nowIso(deps), noProgress: 0, toolCallsAtLastGate: readHeartbeat(root).count };
  const meanwhile = pausedMeanwhile(root);
  if (meanwhile) {
    save(g, { ...next, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession, pauseRequested: false, stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "owner", during: "verification" });
    return allow(events);
  }
  const owner = ownerInput(next, config);
  save(g, owner.mark(next));
  const why = !step.phase || verifyMode(config, step.phase.num) === "step"
    ? `${step.id} was built but never verified, and each step ${step.phase && verifyMode(config) === "phase" ? `of Phase ${step.phase.num} is verified on its own ready (gate.stepPhases)` : `is verified on its own ready (gate.verifyAt "step")`}`
    : `${step.id} was built but Phase ${step.phase.num} (${step.phase.title}) was never verified: every other step of it is done or built, so ${step.id} now closes it`;
  return block(`${owner.text}${why}. Check that its Accept lines hold, rewrite ${config.docs.continueHere}, then run \`${cli} ready ${step.id}\`.\n\n${stepText(rp, step)}`, events);
}

const HANDBACK_SUBJECT = "autoclaude: hand-back";
// The body names the file: HANDOFF.md, or HANDOFF-<NAME>.md for a run on a generated plan.
const handbackMessage = (file) => `${HANDBACK_SUBJECT}\n\n${file || "HANDOFF.md"}, written when the plan completed: what was built, what is left for the owner, secrets, open findings, decisions for review, push state and the machine footprint.\n`;

// Plan complete: clean up the run's machine footprint, write the hand-back (P8.5), commit and
// push it, send the completion alert, and only then mark the run complete. Each stage records
// its result in state.completing, so a stop that has too little time left (the last feature's
// verification used most of it) hands the rest to the next stop, and a gate killed on the way
// is finished by the next one.
async function complete(g, state, parsed) {
  const { root, config, env, deps, ev, events, say } = g;
  const p = progress(parsed);
  const first = !(state.completing && typeof state.completing === "object");
  let c = first ? { at: nowIso(deps) } : { ...state.completing };
  const base = { ...state, currentStep: null, pauseRequested: false, fixup: null, closing: null, freshSession: false };
  if (first) {
    save(g, { ...base, completing: c });
    stopDevServer({ root });
    logLine(root, `plan complete: ${p.done}/${p.total}; finishing the run`);
  } else {
    ev("complete-resumed");
    logLine(root, "finishing the end of the run that an earlier stop began");
  }
  const record = (patch) => { c = { ...c, ...patch }; updateState(root, (s) => { s.completing = c; }); };
  // A stop that already spent its time on the last verification leaves what does not fit to the
  // next stop; a fresh stop always goes ahead.
  const spent = g.clock() - g.startedMs > 30000;
  const defer = (what) => {
    ev("complete-deferred", { stage: what });
    logLine(root, `plan complete; ${what} is left to the next stop (${Math.round(timeLeft(g) / 1000)} s left in this one)`);
    return block(`The plan is complete, and the gate is finishing the run (${what}) but this stop is out of time. End your turn now and do nothing else; the next stop finishes it.`, events);
  };

  // Either module may be missing (an older install, a test); the completion goes on without it.
  if (!c.footprintDone) {
    const finish = "finishFootprint" in deps ? deps.finishFootprint : await lazyExport("./footprint.js", "finishFootprint");
    let footprint = null;
    if (finish) {
      if (spent && timeLeft(g) < FOOTPRINT_MIN_MS + HANDBACK_MS) return defer("the machine clean-up and the hand-back");
      const deadline = Date.now() + Math.max(30000, timeLeft(g) - HANDBACK_MS);
      try { footprint = await finish(root, { remove: true, config, deadline }); } catch (e) { logLine(root, `footprint cleanup failed: ${e && e.message ? e.message : e}`); }
    }
    record({ footprintDone: true, footprint });
  }
  if (!c.handoffDone) {
    const write = "writeHandoff" in deps ? deps.writeHandoff : await lazyExport("./handoff.js", "writeHandoff");
    let handoff = null;
    if (write) {
      if (spent && timeLeft(g) < HANDBACK_MS) return defer("the hand-back");
      try { handoff = await write({ root, config, state: { ...base, status: STATUS.complete }, parsed, footprint: c.footprint || null, env }); } catch (e) { logLine(root, `hand-back failed: ${e && e.message ? e.message : e}`); }
      if (handoff && !handoff.path && handoff.error) logLine(root, `hand-back failed: ${handoff.error}`);
    }
    record({ handoffDone: true, handoff: handoff ? { path: handoff.path || null, summary: handoff.summary || null } : null });
  }
  // The hand-back goes on the run branch with the rest, and out with a last push.
  const handoff = c.handoff;
  if (!c.committed) {
    let pushWanted = false;
    if (handoff && handoff.path && config.git.commitEachStep) {
      // HEAD before the commit is recorded first: a gate cut off after the commit landed and
      // before the record below leaves a commit the next stop finds, and still pushes.
      const head = await git.head(root, { env });
      if (c.headBefore !== undefined && head && head !== c.headBefore && (await subjectOf(g, head)) === HANDBACK_SUBJECT) {
        pushWanted = !!config.git.push;
        logLine(root, `the hand-back was committed (${head.slice(0, 7)}) before its gate was cut off; carrying on from that commit`);
      } else {
        record({ headBefore: head });
        const r = await git.commitAll(root, handbackMessage(path.basename(handoff.path)), { env });
        if (!r.ok) logLine(root, `hand-back commit failed: ${String(r.stderr || "").trim()}`);
        else pushWanted = !!(r.committed && config.git.push);
      }
    }
    record({ committed: true, pushWanted });
  }
  let pushState = c.pushed ? c.pushState : base.pushState;
  if (c.pushWanted && !c.pushed) {
    pushState = await pushNow(g, { ...base, pushState }, null);
    record({ pushed: true, pushState });
  }
  ev("handoff", { path: handoff && handoff.path ? handoff.path : null, footprint: !!c.footprint });

  const started = state.startedAt ? Date.parse(state.startedAt) : null;
  const mins = started ? Math.round((nowMs(deps) - started) / 60000) : null;
  const done = { ...base, status: STATUS.complete, completing: null, pushState };
  let summary = `${p.done}/${p.total} steps verified${mins !== null ? ` in ${mins} min` : ""}.`;
  try {
    const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: nowMs(deps) });
    // The hand-back's push state predates its own commit and push; the alert gives the last one.
    const latest = handoff && handoff.summary ? { ...handoff, summary: { ...handoff.summary, push: pushState } } : handoff;
    summary = buildSummary({ root, config, state: done, parsed, usage: usage.stale ? null : usage, now: nowMs(deps), handoff: latest });
  } catch {}
  const lines = [summary];
  // The summary builder may already state these; say them once.
  if (!/\bpush/i.test(summary)) lines.push(pushLine(config, pushState));
  const handoffRel = handoff && handoff.path ? path.relative(root, path.resolve(root, handoff.path)).split(path.sep).join("/") : null;
  const branch = (await git.currentBranch(root, { env })) || "?";
  lines.push(`Branch ${branch}.${handoffRel && !summary.includes(handoffRel) ? ` Read ${handoffRel} first.` : ""} Review the commits, ${config.docs.decisions} and ${config.docs.blockers} before merging.`);
  // The alert before the state: a gate killed between the two sends it again, never not at all.
  await say({ title: `AutoClaude: plan complete (${planSlug(parsed)})`, message: lines.join("\n"), priority: "default" });
  save(g, done);
  ev("complete", { done: p.done, total: p.total, mins });
  logLine(root, `run complete: ${p.done}/${p.total}`);
  // A run on a generated plan (`autoclaude run --plan`, P10.7) hands the project back to its own
  // plan and run state once it is complete. A gate cut off before this leaves it to the next plain
  // `autoclaude run`, which does the same.
  const handBack = "finishRunPlan" in deps ? deps.finishRunPlan : finishRunPlan;
  if (handBack) {
    try {
      const r = handBack(root, { completed: true, now: new Date(nowMs(deps)) });
      if (r && r.plan) logLine(root, `the run on ${r.plan} is complete; the project's own plan${r.restored ? " and its run state are" : " is"} back`);
    } catch (e) { logLine(root, `could not hand the project back to its own plan: ${e && e.message ? e.message : e}`); }
  }
  return allow(events);
}
