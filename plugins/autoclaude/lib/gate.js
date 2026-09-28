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
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot, projectPaths, pluginRoot } from "./paths.js";
import { isBuilderSession, liveSupervisorPid } from "./builder.js";
import { loadState, saveState, updateState, STATUS } from "./state.js";
import { loadConfig } from "./config.js";
import { parsePlan, stepById, nextStep, firstUnfinished, isPhaseEnd, isFeatureEnd, isFinished, setMarker, stepText, progress, planSlug, reopenUnverified, MARKERS } from "./plan.js";
import { readText, writeFileAtomic, writeJsonAtomic, appendLine, ensureDir } from "./fsatomic.js";
import { pendingVerifyFile, undoCutVerification } from "./resume.js";
import { readReady, clearReady, readBlocked, clearBlocked, readHeartbeat } from "./protocol.js";
import { runChecks } from "./checks.js";
import { writeReport, checkFailureSection, summarize, fence } from "./report.js";
import { restartDevServer, stopDevServer } from "./devserver.js";
import { runBrowserCheck } from "./tester.js";
import { runSecurityReview, securityWanted } from "./security.js";
import { buildSummary } from "./summary.js";
import * as git from "./git.js";
import { notify } from "./notify.js";
import { readUsage } from "./usage.js";

const MAX_REASON = 4000;
// The informational alerts and whether each is on when notify.events does not say (D49).
// lib/notify.js owns the real list; this is only the fallback for an older notify.js.
const EVENT_DEFAULTS = Object.freeze({ featureVerified: true, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false });

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

// "phase" unless the project asks for the old per-step verification.
export function verifyMode(config) {
  return config && config.gate && config.gate.verifyAt === "step" ? "step" : "phase";
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

// Non-blocking security findings, one row each in the security findings file (the template's
// table: Date | Severity | File | Issue | Fix | Status), committed with the step.
function appendSecurityFindings(root, config, step, findings, date) {
  const file = path.join(root, config.docs.security);
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, "# SECURITY-FINDINGS\n\nFindings from the AutoClaude security reviewer that did not fail a step. One row each, appended; close a row by changing its status.\n\n| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n");
  }
  const cell = (s) => String(s || "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  for (const f of findings) {
    const where = f.line ? `${f.file}:${f.line}` : f.file;
    appendLine(file, `| ${date} | ${cell(f.severity)} | ${cell(where)} | ${cell(f.issue)} (found at ${step.id}) | ${cell(f.fix)} | open |`);
  }
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

// Medium and low bugs, and possible weakened tests, from a passing browser check: one row each
// in the blockers file (the template's table), committed with the step.
function appendFollowUps(root, config, step, items, date) {
  const file = path.join(root, config.docs.blockers);
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, "# BLOCKERS\n\nFollow-ups the AutoClaude gate found that did not fail a step. One row each, appended; close a row by changing its status.\n\n| Date | Found by | Step | What | Owner | Status |\n|---|---|---|---|---|---|\n");
  }
  const cell = (s) => String(s || "").replace(/\r?\n/g, " ").replace(/\|/g, "\\|").trim();
  const part = (label, s) => (s ? `${label}${String(s).trim().replace(/[.\s]+$/, "")}` : null);
  for (const b of items) {
    const what = [part(`${b.severity}: `, b.title), part("Actual: ", b.actual), part("Expected: ", b.expected), part("Repro: ", b.repro)].filter(Boolean).join(". ") + ".";
    appendLine(file, `| ${date} | ${b.foundBy === "bugbash" ? "bug bash" : "browser tester"} | ${step.id} | ${cell(what)} | Claude | open |`);
  }
}

// The fix-up list: every non-blocking finding of a verified feature, where it was filed.
function fixupFindings(config, followUps, securityFindings) {
  const cut = (s) => { const t = String(s || "").replace(/\s+/g, " ").trim(); return t.length > 200 ? t.slice(0, 197) + "..." : t; };
  return [
    ...followUps.map((b) => ({ source: b.foundBy === "bugbash" ? "bug bash" : "browser tester", severity: b.severity || "low", text: cut(b.title || b.actual), doc: config.docs.blockers })),
    ...securityFindings.map((f) => ({ source: "security review", severity: f.severity || "low", text: cut(`${f.line ? `${f.file}:${f.line}` : f.file || "?"}: ${f.issue}`), doc: config.docs.security }))
  ];
}

function fixupText(g, fixup) {
  const { config, cli } = g;
  const n = fixup.findings.length;
  const list = fixup.findings.map((f, i) => `${i + 1}. [${f.source}, ${f.severity}] ${f.text} (${f.doc})`).join("\n");
  return `Phase ${fixup.phase} passed its verification, with ${n} non-blocking finding${n === 1 ? "" : "s"} to handle before the feature closes. For each one: fix it and set its row's Status to "fixed", or leave it for the owner: set its row's Status to "left for the owner: <why, and what fixing it would take>" (in ${config.docs.blockers} also set Owner to "owner"). Then run \`${cli} ready ${fixup.stepId}\`: the checks run once more and the feature closes. Do not start the next step yet.\n\nFindings:\n${list}`;
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

// The plan and PROGRESS.md as they were before a verification wrote its ticks, with the ticks
// and the lines it wrote (lib/resume.js pendingVerifyFile). Kept on disk while the checks run,
// so a gate cut off by the hook's timeout, or ended with its session by `pause --now`, is undone
// by the next gate, the supervisor or `autoclaude resume`, whichever comes first.
function clearPending(root) {
  try { fs.rmSync(pendingVerifyFile(root), { force: true }); } catch {}
}

// Budget for one git call of a push: what is left of this stop's time (gate.timeoutSec, at most
// the hook's own timeout) over the four network calls a push with its retry can make. A push
// that outlives the hook would be killed with it.
function pushTimeoutMs(g) {
  const left = g.startedMs + g.config.gate.timeoutSec * 1000 - Date.now() - 10000;
  return Math.max(5000, Math.min(120000, Math.floor(left / 4)));
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
  const g = { root, config, env, deps, cli, say, sayEvent, planFile, ev, events, startedMs: Date.now(), loaded };

  // A verification that was cut off (the hook's timeout, a crash): its ticks and PROGRESS lines
  // come out first.
  const interrupted = undoCutVerification(root, config);
  if (interrupted) { ev("verify-interrupted", { step: interrupted.step }); logLine(root, `the verification of ${interrupted.step} was cut off; its plan ticks and PROGRESS lines were undone`); }

  let planText = readText(planFile, null);
  if (planText === null) { ev("no-plan"); logLine(root, "plan file missing, allowing stop"); return allow(events); }
  let parsed = parsePlan(planText);

  // Integrity: every [x] and [~] must be one the gate (or the owner, before the run) recorded.
  const allowedTicks = new Set(state.tickedByGate || []);
  const rogue = parsed.steps.filter((s) => isFinished(s) && !allowedTicks.has(s.id));
  if (rogue.length) {
    for (const s of rogue) planText = setMarker(planText, s.id, MARKERS.todo);
    writeFileAtomic(planFile, planText);
    parsed = parsePlan(planText);
    ev("integrity-reverted", { ids: rogue.map((s) => s.id) });
    logLine(root, `integrity: reverted ${rogue.map((s) => s.id).join(", ")}`);
    return block(`Only the gate ticks boxes in ${config.plan}. I reverted ${rogue.map((s) => s.id).join(", ")} to [ ]. Do not edit ${config.plan}. When ${state.currentStep} is done, run \`${cli} ready ${state.currentStep}\`.`, events);
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

  // No ready marker: keep the builder going, unless nothing is happening.
  const ready = readReady(root);
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

  // Ready.
  clearReady(root);
  if (fixup) return await fixupReady(g, state, step, parsed);
  const perFeature = verifyMode(config) === "phase";
  if (perFeature && !isFeatureEnd(parsed, step.id)) return await builtStep(g, state, step, parsed, planText);
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
  if (config.git.commitEachStep) {
    const message = await commitMessage(g, {
      subject: `autoclaude(${step.id}): ${step.title}`,
      lead: `Built, not verified yet: ${step.id} is verified with Phase ${phase.num} (${phase.title}), all of it at once, when the phase's last step is ready.`,
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
  if (commitError) return await commitFailed(g, base, step, next, commitError);
  if (next) await g.sayEvent("stepVerified", { title: `AutoClaude: ${step.id} built`, message: `${step.id} ${step.title} is built and committed; its verification comes with Phase ${phase.num} (${phase.title}). Next: ${next.id} ${next.title}.`, priority: "low" });
  return await advance(g, base, { step, parsed: tparsed, next, sha, phaseEnd: false, closedFeature: false, built: true });
}

// The dev server (when anything needs it) and the configured checks, in order.
// Returns { failure, failedCheck, sections, timings, devServerReady }.
async function runCheckStage(g, { step, browserWanted }) {
  const { root, config, env, deps, cli } = g;
  const sections = [];
  const timings = [];
  let failure = null;
  let failedCheck = null;
  const restart = deps.restartDevServer || restartDevServer;
  const needsServer = config.checks.some((c) => c.needsDevServer) || browserWanted;
  let devServerReady = false;
  if (needsServer && config.devServer.command && config.devServer.url) {
    const ds = await restart(config.devServer, { root, env });
    if (ds.ok) {
      devServerReady = true;
      if (ds.reused) sections.push({ title: "Dev server reused", body: `Something the gate did not start already answers at ${config.devServer.url}. It was used as it is and may be running older code.` });
    } else {
      failure = `the dev server did not start: ${ds.error}`;
      sections.push({ title: "Dev server FAILED to start", body: `${ds.error}\n\n${fence((ds.logTail || []).join("\n") || "(no log output)")}` });
    }
  }
  if (!failure) {
    const checkResults = await runChecks(config.checks, { cwd: root, env, devServerReady });
    for (const r of checkResults.results) {
      const passed = r.code === 0 && !r.timedOut;
      if (r.ran) {
        sections.push({ title: `Check "${r.name}": ${passed ? "passed" : "FAILED"}`, body: `\`${r.command}\` in ${Math.round(r.durationMs / 1000)} s${passed ? "" : `\n\n${checkFailureSection(r).body}`}` });
        timings.push({ name: r.name, status: passed ? "passed" : "FAILED", ms: r.durationMs });
      } else if (!r.skipped) {
        sections.push({ title: `Check "${r.name}": NOT RUN`, body: `\`${r.command}\` did not run: ${notRunReason(r, config, cli, step)}.` });
      }
    }
    const f = checkResults.failed;
    if (f) {
      failedCheck = f;
      failure = f.ran ? `check "${f.name}" failed` : `check "${f.name}" did not run: ${notRunReason(f, config, cli, step)}`;
    }
  }
  return { failure, failedCheck, sections, timings, devServerReady };
}

// The full verification of a step ("step" mode) or of the whole phase it closes (feature).
async function verify(g, state, step, parsed, planText, feature) {
  const { root, config, env, deps, cli, ev, events, say, planFile } = g;
  const attempt = (state.attempts[step.id] || 0) + 1;
  const max = config.retries.maxAttemptsPerStep;
  const phase = step.phase;
  const st = { ...state };
  if (!st.phaseStartedAt) st.phaseStartedAt = st.stepStartedAt || st.startedAt || nowIso(deps);
  if (feature && !st.phaseBaseCommit) st.phaseBaseCommit = (await builtFeatureBase(g, phase)) || (await git.head(root, { env })) || null;
  const scopeIds = (feature && phase ? phase.steps : [step]).map((s) => s.id);
  const toTick = scopeIds.filter((id) => stepById(parsed, id).marker !== MARKERS.done);
  const label = feature && phase ? `Phase ${phase.num} (${phase.title})` : step.id;
  ev("verify", { step: step.id, attempt, ...(feature ? { feature: phase ? phase.num : null, steps: scopeIds } : {}) });
  logLine(root, `verifying ${feature && phase ? `${label} at ${step.id}` : step.id} attempt ${attempt}`);

  // Ticks and PROGRESS lines first, so the checks see exactly what the commit will hold. The
  // snapshot names both, so they come out on a failure, or later if this gate is cut off,
  // without touching anything else.
  const progressFile = path.join(root, config.docs.progress);
  const date = nowIso(deps).slice(0, 10);
  const added = toTick.map((id) => { const s = stepById(parsed, id); return `- ${date} ${s.id} ${s.title} (attempt ${attempt})\n`; }).join("");
  writeJsonAtomic(pendingVerifyFile(root), { step: step.id, plan: planText, progress: readText(progressFile, null), ticked: toTick, added });
  let ticked = planText;
  for (const id of toTick) ticked = setMarker(ticked, id, MARKERS.done);
  writeFileAtomic(planFile, ticked);
  if (added) appendLine(progressFile, added);
  const restore = () => undoCutVerification(root, config);
  const tparsed = parsePlan(ticked);
  const tstep = stepById(tparsed, step.id);
  const scope = scopeIds.map((id) => stepById(tparsed, id));

  // Which browser checks this verification needs (Phase 4). The tester skips `no-ui` steps; the
  // bug bash runs when a phase closes and the phase has any UI step at all.
  const deadlineMs = Date.now() + Math.max(120, config.gate.timeoutSec - 60) * 1000;
  const runBrowser = "runTester" in deps ? deps.runTester : runBrowserCheck;
  const uiSteps = scope.filter((s) => !s.tags.includes("no-ui"));
  const phaseEnd = feature || isPhaseEnd(tparsed, step.id);
  const testerWanted = !!(runBrowser && config.tester.enabled && uiSteps.length);
  const bugBashWanted = !!(runBrowser && config.bugBash.atPhaseEnd && tstep.phase && phaseEnd && tstep.phase.steps.some((s) => !s.tags.includes("no-ui")));
  const stage = await runCheckStage(g, { step: tstep, browserWanted: testerWanted || bugBashWanted });
  const { sections, timings } = stage;
  let failure = stage.failure;

  const followUps = [];
  if (!failure && (testerWanted || bugBashWanted) && !stage.devServerReady) {
    ev("browser-skipped", { reason: "no dev server" });
    sections.push({ title: "Browser checks skipped", body: "No devServer command and url are set in autoclaude.config.json, so the browser tester and the bug bash could not open the app. Set devServer to have UI steps checked in a browser." });
  } else if (!failure && !testerWanted && !bugBashWanted) {
    ev("tester-skipped");
  }
  // The independent checkers, in order: browser tester, bug bash (both need the dev server),
  // then the security reviewer (P5.4, needs only the diff). Same rules for all three: a failure
  // counts as an attempt; a checker that cannot run never does, and pauses the second time.
  // For a feature the tester gets every UI step of the phase, one criterion per Accept line.
  const checkers = [];
  if (!failure && stage.devServerReady) {
    if (testerWanted) checkers.push({ kind: "tester", label: "browser tester", run: () => runBrowser({ kind: "tester", root, config, step: tstep, ...(feature ? { steps: uiSteps } : {}), parsed: tparsed, state: st, env, attempt, deadlineMs }) });
    if (bugBashWanted) checkers.push({ kind: "bugbash", label: "bug bash", run: () => runBrowser({ kind: "bugbash", root, config, step: tstep, parsed: tparsed, state: st, env, attempt, deadlineMs }) });
  }
  // The security review of a feature reads its whole diff, from state.phaseBaseCommit.
  const runSecurity = "runSecurity" in deps ? deps.runSecurity : runSecurityReview;
  const securityOn = feature ? scope.some((s) => securityWanted(config, s, tparsed)) : securityWanted(config, tstep, tparsed);
  if (!failure && runSecurity && securityOn) {
    checkers.push({ kind: "security", label: "security review", run: () => runSecurity({ root, config, step: tstep, ...(feature ? { steps: scope } : {}), parsed: tparsed, state: st, env, attempt, deadlineMs }) });
  }
  const securityFindings = [];
  let failureKind = failure ? "checks" : null;
  for (const c of checkers) {
    const t0 = Date.now();
    const r = await c.run();
    timings.push({ name: c.label, status: r.status === "passed" ? "passed" : r.status === "infra" ? "could not run" : "FAILED", ms: Date.now() - t0 });
    ev(c.kind, { status: r.status, verdictFile: r.verdictFile });
    sections.push(...(r.sections || []));
    if (r.status === "infra") {
      // The checker could not run: a machine problem, never the builder's attempt (P4.2).
      restore();
      const n = ((st.infraFailures || {})[step.id] || 0) + 1;
      const report = writeReport({ root, step: step.id, attempt: `${attempt}-infra${n}`, title: `AutoClaude report: ${step.id}, ${c.label} could not run`, sections });
      logLine(root, `${step.id}: ${c.label} could not run (${n}): ${r.failed} (${report.relPath})`);
      ev("infra", { kind: c.kind, count: n, report: report.relPath });
      const infraFailures = { ...(st.infraFailures || {}), [step.id]: n };
      // A `pause --now` while the checker ran stays in force: saving `st` would undo it.
      const meanwhile = pausedMeanwhile(root);
      const halt = meanwhile ? !!meanwhile.haltSession : !!st.haltSession;
      if (n >= 2) {
        save(g, { ...st, infraFailures, status: STATUS.paused, pauseReason: "infra", haltSession: halt });
        stopDevServer({ root });
        ev("paused", { reason: "infra" });
        await say({ title: `AutoClaude paused: the ${c.label} cannot run`, message: `${r.failed}\nReport: ${report.relPath}\nCheck ${c.kind === "security" ? "the claude CLI" : "Playwright and the claude CLI"} on this machine, then \`${cli} resume\`.`, priority: "high" });
        return allow(events);
      }
      if (meanwhile) {
        save(g, { ...st, infraFailures, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: halt });
        stopDevServer({ root });
        ev("paused", { reason: "owner", during: "verification" });
        return allow(events);
      }
      save(g, { ...st, infraFailures });
      return block(`The ${c.label} could not run: ${r.failed}. That is a problem on this machine, not with ${step.id}, and it did not count as an attempt. Run \`${cli} ready ${step.id}\` again. Report: ${report.relPath}`, events);
    }
    if (c.kind === "security") securityFindings.push(...(r.findings || []));
    else followUps.push(...(r.followUps || []));
    if (r.status === "failed") { failure = r.failed; failureKind = c.kind; break; }
  }

  if (failure) {
    restore();
    const accepts = feature ? failingAcceptLines(scope, sections, stage.failedCheck) : [];
    if (accepts.length) sections.unshift({ title: "Failing Accept lines", body: accepts.map((a) => `- ${a.step}: ${a.accept}`).join("\n") });
    const report = writeReport({ root, step: step.id, attempt, title: `AutoClaude report: ${feature && phase ? `${label}, verified at ${step.id},` : step.id} attempt ${attempt}`, sections });
    const attempts = { ...st.attempts, [step.id]: attempt };
    ev("failed", { step: step.id, attempt, failure, report: report.relPath, ...(feature ? { accept: accepts } : {}) });
    logLine(root, `${feature && phase ? `${label} at ${step.id}` : step.id} attempt ${attempt} failed: ${failure} (${report.relPath})`);
    if (attempt >= max) {
      writeFileAtomic(planFile, setMarker(planText, step.id, MARKERS.failed));
      const reason = failureKind === "security" ? "security" : "step-failed";
      save(g, { ...st, attempts, status: STATUS.paused, pauseReason: reason });
      stopDevServer({ root });
      ev("paused", { reason });
      await say({ title: `AutoClaude paused: ${feature && phase ? `Phase ${phase.num}, verified at ${step.id},` : step.id} failed ${attempt} times`, message: `${failure}\nReport: ${report.relPath}\nFix it or adjust the plan, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    const meanwhile = pausedMeanwhile(root);
    if (meanwhile) {
      save(g, { ...st, attempts, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    const owner = ownerInput(st, config);
    save(g, owner.mark({ ...st, attempts }));
    const failingSections = sections.filter((s) => /FAILED|failed|NOT RUN|Failing Accept/.test(s.title));
    const owners = [...new Set(accepts.map((a) => a.step))];
    const headline = feature && phase
      ? `${label}, verified at ${step.id}, attempt ${attempt}/${max} failed: ${failure}.${owners.length ? ` The failing Accept lines belong to ${owners.join(", ")}.` : ""} Fix the causes, then run \`${cli} ready ${step.id}\` again.`
      : `${step.id} attempt ${attempt}/${max} failed: ${failure}. Fix the causes, then run \`${cli} ready ${step.id}\` again.`;
    return block(owner.text + summarize({ headline, sections: failingSections, reportPath: report.relPath, maxChars: MAX_REASON - owner.text.length }), events);
  }

  // Pass. The ticks stay; the findings are filed next to them.
  clearPending(root);
  if (followUps.length) appendFollowUps(root, config, step, followUps, date);
  if (securityFindings.length) appendSecurityFindings(root, config, step, securityFindings, date);
  const report = writeReport({ root, step: step.id, attempt, title: `AutoClaude report: ${feature && phase ? `${label}, verified at ${step.id},` : step.id} attempt ${attempt} passed`, sections });
  const tickedIds = [...new Set([...(st.tickedByGate || []), ...toTick])];
  const findings = fixupFindings(config, followUps, securityFindings);
  if (feature && findings.length) {
    // The fix-up pass (D49): the builder fixes or hands over each finding, then the checks run
    // once more before the feature is committed.
    const fixup = { phase: phase ? phase.num : null, stepId: step.id, findings, attempt, report: report.relPath, checks: timings, at: nowIso(deps) };
    const next = { ...st, tickedByGate: tickedIds, fixup, attempts: { ...st.attempts, [step.id]: 0 }, infraFailures: { ...(st.infraFailures || {}), [step.id]: 0 }, noProgress: 0 };
    ev("fixup", { step: step.id, findings: findings.length, report: report.relPath });
    logLine(root, `${label} verified at ${step.id} with ${findings.length} non-blocking finding(s); fix-up pass before it closes`);
    const meanwhile = pausedMeanwhile(root);
    if (meanwhile) {
      save(g, { ...next, status: STATUS.paused, pauseReason: meanwhile.pauseReason || "review", haltSession: !!meanwhile.haltSession });
      stopDevServer({ root });
      ev("paused", { reason: "owner", during: "verification" });
      return allow(events);
    }
    const owner = ownerInput(next, config);
    save(g, owner.mark({ ...next, toolCallsAtLastGate: readHeartbeat(root).count }));
    return block(`${owner.text}${fixupText(g, fixup)}`, events);
  }
  return await close(g, { ...st, tickedByGate: tickedIds }, { step: tstep, parsed: tparsed, scope, attempt, timings, findings: findings.length, report: report.relPath, feature, phaseEnd });
}

// The ready after a fix-up pass: the checks only (the ticks and PROGRESS lines are already
// written), then the feature closes.
async function fixupReady(g, state, step, parsed) {
  const { root, config, cli, ev, events, say } = g;
  const fixup = state.fixup;
  const attempt = (state.attempts[step.id] || 0) + 1;
  const max = config.retries.maxAttemptsPerStep;
  ev("verify", { step: step.id, attempt, fixup: true });
  logLine(root, `fix-up checks for Phase ${fixup.phase} at ${step.id}, attempt ${attempt}`);
  const stage = await runCheckStage(g, { step, browserWanted: false });
  if (stage.failure) {
    const report = writeReport({ root, step: `${step.id}-fixup`, attempt, title: `AutoClaude report: the fix-up checks of Phase ${fixup.phase}, attempt ${attempt}`, sections: stage.sections });
    const attempts = { ...state.attempts, [step.id]: attempt };
    ev("failed", { step: step.id, attempt, failure: stage.failure, report: report.relPath, fixup: true });
    logLine(root, `fix-up checks of Phase ${fixup.phase} attempt ${attempt} failed: ${stage.failure} (${report.relPath})`);
    if (attempt >= max) {
      save(g, { ...state, attempts, status: STATUS.paused, pauseReason: "step-failed" });
      stopDevServer({ root });
      ev("paused", { reason: "step-failed", fixup: true });
      await say({ title: `AutoClaude paused: the fix-up checks of Phase ${fixup.phase} failed ${attempt} times`, message: `${stage.failure}\nReport: ${report.relPath}\nThe feature passed its verification; its fix-up pass broke a check. Fix it, then \`${cli} resume\` (the run resumes in the fix-up pass).`, priority: "high" });
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
    const failingSections = stage.sections.filter((s) => /FAILED|failed|NOT RUN/.test(s.title));
    return block(owner.text + summarize({ headline: `The fix-up checks of Phase ${fixup.phase} (attempt ${attempt}/${max}) failed: ${stage.failure}. Fix the causes, then run \`${cli} ready ${step.id}\` again.`, sections: failingSections, reportPath: report.relPath, maxChars: MAX_REASON - owner.text.length }), events);
  }
  const report = writeReport({ root, step: `${step.id}-fixup`, attempt, title: `AutoClaude report: the fix-up checks of Phase ${fixup.phase}, attempt ${attempt} passed`, sections: stage.sections });
  const scope = step.phase ? step.phase.steps : [step];
  const timings = [...(fixup.checks || []), ...stage.timings.map((t) => ({ ...t, name: `${t.name} (after the fix-up)` }))];
  return await close(g, { ...state }, { step, parsed, scope, attempt: fixup.attempt || 1, timings, findings: fixup.findings.length, report: [fixup.report, report.relPath].filter(Boolean).join(" and "), feature: true, phaseEnd: true, fixupDone: true });
}

// A verified step or feature: commit with a body, tag a phase end, push, alert, move on.
async function close(g, st, c) {
  const { root, config, env, deps, ev } = g;
  const { step, parsed, feature, phaseEnd } = c;
  const phase = step.phase;
  let sha = null;
  let commitError = null;
  let tagName = null;
  if (config.git.commitEachStep) {
    const lead = feature && phase
      ? `Verified Phase ${phase.num} (${phase.title}) as one feature: ${c.scope.map((s) => s.id).join(", ")}, attempt ${c.attempt}${c.fixupDone ? ", then a fix-up pass" : ""}.`
      : `Verified ${step.id}, attempt ${c.attempt}.`;
    const message = await commitMessage(g, { subject: `autoclaude(${step.id}): ${step.title}`, lead, steps: c.scope, timings: c.timings, findings: c.findings, report: c.report });
    const r = await git.commitAll(root, message, { env });
    sha = r.sha || null;
    if (!r.ok) { commitError = String(r.stderr || "").trim() || "unknown error"; logLine(root, `commit failed: ${commitError}`); }
    else if (phaseEnd && config.git.tagPhaseEnds && phase) {
      const name = `ac-phase-${phase.num}`;
      // A phase verified again (the owner reopened or added a step) keeps the tag of its first
      // verification while pushes are on: a pushed tag moves only with a force push, which a run
      // never makes, and a moved one would fail every later push.
      if (config.git.push && (await git.tagExists(root, name, { env }))) logLine(root, `${name} already marks an earlier verification of Phase ${phase.num}; left where it is`);
      else {
        const t = await git.tag(root, name, { force: true, env });
        if (t.ok) tagName = name;
        else logLine(root, `tag failed: ${t.stderr}`);
      }
    }
  }
  ev("passed", { step: step.id, attempt: c.attempt, sha, phaseEnd, ...(feature ? { feature: phase ? phase.num : null } : {}) });
  logLine(root, `${feature && phase ? `Phase ${phase.num} (at ${step.id})` : step.id} verified${sha ? ` (${sha.slice(0, 7)})` : commitError ? " but NOT committed" : ""}`);

  // Owner input that reached the builder (in a gate message) belonged to this step: done with.
  // Notes not yet delivered stay pending for the next step or the next session start.
  // The feature's base and start time go with it, unless another feature still has built steps
  // (the owner reopened an earlier phase in the middle of a later one): that one's review and
  // timing still need them.
  const took = st.phaseStartedAt ? fmtMinutes(nowMs(deps) - Date.parse(st.phaseStartedAt)) : null;
  const featureDone = phaseEnd && !parsed.steps.some((s) => s.marker === MARKERS.built);
  const base = {
    ...st, attempts: { ...st.attempts, [step.id]: 0 }, infraFailures: { ...(st.infraFailures || {}), [step.id]: 0 },
    noProgress: 0, headAtLastGate: sha || st.headAtLastGate, fixup: null,
    pendingNotes: (st.pendingNotes || []).filter((n) => !n.delivered), ownerAnswer: null,
    ...(featureDone ? { phaseBaseCommit: null, phaseStartedAt: null } : {})
  };
  const next = nextStep(parsed);
  if (commitError) return await commitFailed(g, base, step, next, commitError);
  if (sha) {
    // Recorded at once (only the fields the commit settled, so an owner pause made meanwhile
    // stands): a gate cut off from here on, say by the hook's timeout during a slow push, leaves
    // a state the next stop carries on from instead of ticks the integrity check would revert,
    // and a tag the next push takes along.
    const pendingTag = tagName && config.git.push ? tagName : null;
    updateState(root, (s) => {
      s.tickedByGate = base.tickedByGate; s.fixup = null; s.headAtLastGate = sha;
      s.attempts = { ...(s.attempts || {}), [step.id]: 0 };
      if (featureDone) { s.phaseBaseCommit = null; s.phaseStartedAt = null; }
      if (pendingTag) {
        const prev = s.pushState || { branch: null, remote: null, unpushedCommits: null };
        s.pushState = { ...prev, ok: false, skipped: false, at: nowIso(deps), error: "the gate stopped before its push finished", unpushedTags: [...new Set([...(prev.unpushedTags || []), pendingTag])] };
      }
    });
  }
  if (sha && config.git.push) base.pushState = await pushNow(g, base, tagName);
  // The last feature's alert is the completion alert.
  if (next) {
    if (phaseEnd && phase) {
      const ps = config.git.push ? base.pushState : null;
      const pushed = ps ? (ps.ok ? ` Pushed to ${ps.remote}.` : ps.skipped ? "" : ` Push FAILED: ${ps.error}.`) : "";
      // Per step, the phase's steps were verified one by one; per feature, all at once.
      const n = feature ? c.scope.length : phase.steps.length;
      await g.sayEvent("featureVerified", { title: `AutoClaude: Phase ${phase.num} verified`, message: `Phase ${phase.num} ${phase.title}: ${n} step${n === 1 ? "" : "s"} verified${took ? ` in ${took}` : ""}${c.attempt > 1 ? ` (attempt ${c.attempt})` : ""}${c.fixupDone ? ", after a fix-up pass" : ""}.${pushed} Next: ${next.id} ${next.title}.`, priority: "default" });
    }
    if (!feature) await g.sayEvent("stepVerified", { title: `AutoClaude: ${step.id} verified`, message: `${step.id} ${step.title} passed its checks (attempt ${c.attempt}) and is committed. Next: ${next.id} ${next.title}.`, priority: "low" });
  }
  return await advance(g, base, { step, parsed, next, sha, phaseEnd, closedFeature: phaseEnd, feature, scope: c.scope });
}

// A step that passed (or was built) but could not be committed stops the run: carrying on would
// pile later steps onto an unrecorded one (seen live: git was not on the run window's PATH, and
// the last step was reported verified and the plan complete with nothing committed).
// `autoclaude resume` commits the pending steps before the session restarts.
async function commitFailed(g, base, step, next, commitError) {
  const { root, cli, ev, events, say } = g;
  save(g, { ...base, uncommitted: [...(base.uncommitted || []), step.id], currentStep: next ? next.id : null, status: STATUS.paused, pauseReason: "commit-failed", stepStartedAt: null });
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
    ? `${step.id} built and committed${short}; Phase ${phase.num} is verified as a whole when its last step is ready, so run only the tests for what you change`
    : feature && phase ? `Phase ${phase.num} (${phase.title}) verified and committed${short}` : `${step.id} verified and committed${short}`;
  return block(`${owner.text}${done}. Next: ${next.id} ${next.title}. When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${next.id}\`.\n\n${stepText(parsed, next)}`, events);
}

// No step is left to do. Built steps no verification would reach first go back to [ ] (the
// owner ticked the step that closes their feature, a start that skipped them, verifyAt changed
// to "step"), so a plan never completes with an unverified step; then the plan completes.
async function finishPlan(g, state, parsed) {
  const { root, config, deps, cli, ev, events, planFile } = g;
  const mode = verifyMode(config);
  const { text, reopened } = reopenUnverified(readText(planFile, ""), mode);
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
  const why = mode === "step" || !step.phase
    ? `${step.id} was built but never verified, and each step is verified on its own ready (gate.verifyAt "step")`
    : `${step.id} was built but Phase ${step.phase.num} (${step.phase.title}) was never verified: every other step of it is done or built, so ${step.id} now closes it`;
  return block(`${owner.text}${why}. Check that its Accept lines hold, rewrite ${config.docs.continueHere}, then run \`${cli} ready ${step.id}\`.\n\n${stepText(rp, step)}`, events);
}

// Plan complete: clean up the run's machine footprint, write the hand-back (P8.5), commit and
// push it, and send the completion alert.
async function complete(g, state, parsed) {
  const { root, config, env, deps, ev, events, say } = g;
  const done = { ...state, status: STATUS.complete, currentStep: null, pauseRequested: false, fixup: null, freshSession: false };
  save(g, done);
  stopDevServer({ root });
  const p = progress(parsed);
  const started = state.startedAt ? Date.parse(state.startedAt) : null;
  const mins = started ? Math.round((nowMs(deps) - started) / 60000) : null;
  ev("complete", { done: p.done, total: p.total, mins });
  logLine(root, `plan complete: ${p.done}/${p.total}`);

  // Either module may be missing (an older install, a test); the completion goes on without it.
  let footprint = null;
  const finish = "finishFootprint" in deps ? deps.finishFootprint : await lazyExport("./footprint.js", "finishFootprint");
  if (finish) {
    try { footprint = await finish(root, { remove: true, config }); } catch (e) { logLine(root, `footprint cleanup failed: ${e && e.message ? e.message : e}`); }
  }
  let handoff = null;
  const write = "writeHandoff" in deps ? deps.writeHandoff : await lazyExport("./handoff.js", "writeHandoff");
  if (write) {
    try { handoff = await write({ root, config, state: done, parsed, footprint, env }); } catch (e) { logLine(root, `hand-back failed: ${e && e.message ? e.message : e}`); }
    if (handoff && !handoff.path && handoff.error) logLine(root, `hand-back failed: ${handoff.error}`);
  }
  // The hand-back goes on the run branch with the rest, and out with a last push.
  let pushState = done.pushState;
  if (handoff && handoff.path && config.git.commitEachStep) {
    const c = await git.commitAll(root, `autoclaude: hand-back\n\nHANDOFF.md, written when the plan completed: what was built, what is left for the owner, secrets, open findings, decisions for review, push state and the machine footprint.\n`, { env });
    if (!c.ok) logLine(root, `hand-back commit failed: ${String(c.stderr || "").trim()}`);
    else if (c.committed && config.git.push) {
      pushState = await pushNow(g, done, null);
      save(g, { ...done, pushState });
    }
  }
  ev("handoff", { path: handoff && handoff.path ? handoff.path : null, footprint: !!footprint });

  let summary = `${p.done}/${p.total} steps verified${mins !== null ? ` in ${mins} min` : ""}.`;
  try {
    const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: nowMs(deps) });
    // The hand-back's push state predates its own commit and push; the alert gives the last one.
    const latest = handoff && handoff.summary ? { ...handoff, summary: { ...handoff.summary, push: pushState } } : handoff;
    summary = buildSummary({ root, config, state: { ...done, pushState }, parsed, usage: usage.stale ? null : usage, now: nowMs(deps), handoff: latest });
  } catch {}
  const lines = [summary];
  // The summary builder may already state these; say them once.
  if (!/\bpush/i.test(summary)) lines.push(pushLine(config, pushState));
  const handoffRel = handoff && handoff.path ? path.relative(root, path.resolve(root, handoff.path)).split(path.sep).join("/") : null;
  const branch = (await git.currentBranch(root, { env })) || "?";
  lines.push(`Branch ${branch}.${handoffRel && !summary.includes(handoffRel) ? ` Read ${handoffRel} first.` : ""} Review the commits, ${config.docs.decisions} and ${config.docs.blockers} before merging.`);
  await say({ title: `AutoClaude: plan complete (${planSlug(parsed)})`, message: lines.join("\n"), priority: "default" });
  return allow(events);
}
