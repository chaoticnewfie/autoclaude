// The Stop gate: PLAN.md section 4.4. Called by scripts/stop-gate.js with the hook input.
// Returns { decision: "allow" | "block", reason, events } so scenario tests can assert on it
// without parsing stdout. Every side effect goes through the libs; nothing here is Windows-specific.
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot, projectPaths } from "./paths.js";
import { loadState, saveState, STATUS } from "./state.js";
import { loadConfig } from "./config.js";
import { parsePlan, lintPlan, stepById, nextStep, firstUnfinished, isPhaseEnd, setMarker, stepText, progress, planSlug, MARKERS } from "./plan.js";
import { readText, writeFileAtomic, appendLine } from "./fsatomic.js";
import { readReady, clearReady, readBlocked, clearBlocked, readHeartbeat } from "./protocol.js";
import { runChecks } from "./checks.js";
import { writeReport, checkFailureSection, summarize, fence } from "./report.js";
import { restartDevServer, stopDevServer } from "./devserver.js";
import { runBrowserCheck } from "./tester.js";
import { runSecurityReview, securityWanted } from "./security.js";
import { buildSummary } from "./summary.js";
import { ensureDir } from "./fsatomic.js";
import * as git from "./git.js";
import { notify } from "./notify.js";
import { readUsage } from "./usage.js";

const MAX_REASON = 4000;

export function cliCommand(env = process.env) {
  // What the builder should type. Claude's Bash tool is Git Bash on Windows, which resolves the
  // extensionless shim only, so that is the one that counts; fall back to the node invocation.
  const dirs = (env.PATH || env.Path || "").split(path.delimiter);
  const hasShim = dirs.some((d) => d && fs.existsSync(path.join(d, "autoclaude")));
  if (hasShim) return "autoclaude";
  return `node "${path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "bin", "autoclaude.js").replace(/\\/g, "/")}"`;
}

function nowIso(deps) { return (deps.now ? deps.now() : new Date()).toISOString(); }

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

function logLine(root, text) {
  try { appendLine(path.join(root, ".autoclaude", "logs", "gate.log"), `${new Date().toISOString()} ${text}`); } catch {}
}

function block(reason, events) {
  return { decision: "block", reason: reason.length > MAX_REASON ? reason.slice(0, MAX_REASON - 60) + "\n[... truncated ...]" : reason, events };
}

function allow(events) {
  return { decision: "allow", reason: null, events };
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

  const cfgLoad = loadConfig(root);
  if (cfgLoad.errors.length) { ev("config-error"); logLine(root, `config errors, allowing stop: ${JSON.stringify(cfgLoad.errors)}`); return allow(events); }
  const config = cfgLoad.config;
  const p = projectPaths(root);
  const planFile = path.join(root, config.plan);
  const cli = cliCommand(env);
  const logFile = path.join(p.logsDir, "notify.log");
  const say = (msg) => notifier(msg, { logFile, stdout: deps.stdout });

  let planText = readText(planFile, null);
  if (planText === null) { ev("no-plan"); logLine(root, "plan file missing, allowing stop"); return allow(events); }
  let parsed = parsePlan(planText);

  // Integrity: every [x] must be one the gate (or the owner, before the run) recorded.
  const allowedTicks = new Set(state.tickedByGate || []);
  const rogue = parsed.steps.filter((s) => s.marker === MARKERS.done && !allowedTicks.has(s.id));
  if (rogue.length) {
    for (const s of rogue) planText = setMarker(planText, s.id, MARKERS.todo);
    writeFileAtomic(planFile, planText);
    parsed = parsePlan(planText);
    ev("integrity-reverted", { ids: rogue.map((s) => s.id) });
    logLine(root, `integrity: reverted ${rogue.map((s) => s.id).join(", ")}`);
    return block(`Only the gate ticks boxes in ${config.plan}. I reverted ${rogue.map((s) => s.id).join(", ")} to [ ]. Do not edit ${config.plan}. When ${state.currentStep} is done, run \`${cli} ready ${state.currentStep}\`.`, events);
  }

  // Re-baseline (D33): the current step must exist and be unfinished.
  let step = state.currentStep ? stepById(parsed, state.currentStep) : null;
  if (!step || step.marker === MARKERS.done) {
    const fresh = firstUnfinished(parsed);
    if (!fresh) return await complete(root, state, config, parsed, ev, events, say, deps);
    state.currentStep = fresh.id;
    step = fresh;
    ev("rebaselined", { step: fresh.id });
  }

  // Blocked marker: a critical question for the owner.
  const blocked = readBlocked(root);
  if (blocked) {
    clearBlocked(root);
    planText = setMarker(planText, step.id, MARKERS.blocked);
    writeFileAtomic(planFile, planText);
    saveState(root, { ...state, status: STATUS.paused, pauseReason: "blocked", currentStep: step.id, lastBlockedQuestion: blocked.question });
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
    const head = (await git.head(root)) || null;
    const noProgress = beat.count === state.toolCallsAtLastGate && head === state.headAtLastGate;
    const next = { ...state, toolCallsAtLastGate: beat.count, headAtLastGate: head, noProgress: noProgress ? state.noProgress + 1 : 0 };
    if (next.noProgress >= config.retries.maxNoProgressStops) {
      saveState(root, { ...next, status: STATUS.paused, pauseReason: "stuck" });
      stopDevServer({ root });
      ev("paused", { reason: "stuck" });
      logLine(root, `stuck on ${step.id} after ${next.noProgress} stops with no progress`);
      await say({ title: `AutoClaude stuck on ${step.id}`, message: `The session stopped ${next.noProgress} times without tool use or new commits. Look at the project, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    const owner = ownerInput(next, config);
    saveState(root, owner.mark(next));
    ev("nudge", { noProgress: next.noProgress });
    const wrong = ready ? `The ready marker named ${ready.step}, but the current step is ${step.id}. ` : "";
    return block(`${owner.text}${wrong}Continue ${step.id} (${step.title}). When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${step.id}\`. If you truly cannot proceed without a human, run \`${cli} blocked ${step.id} "<question with options>"\`.\n\n${stepText(parsed, step)}`, events);
  }

  // Ready: verify.
  clearReady(root);
  const attempt = (state.attempts[step.id] || 0) + 1;
  ev("verify", { step: step.id, attempt });
  logLine(root, `verifying ${step.id} attempt ${attempt}`);
  const sections = [];
  let failure = null;

  // Which browser checks this verification needs (Phase 4). The tester skips `no-ui` steps; the
  // bug bash runs at a phase's last step when the phase has any UI step at all.
  const deadlineMs = Date.now() + Math.max(120, config.gate.timeoutSec - 60) * 1000;
  const runBrowser = "runTester" in deps ? deps.runTester : runBrowserCheck;
  const restart = deps.restartDevServer || restartDevServer;
  const testerWanted = !!(runBrowser && config.tester.enabled && !step.tags.includes("no-ui"));
  const bugBashWanted = !!(runBrowser && config.bugBash.atPhaseEnd && step.phase && isPhaseEnd(parsed, step.id) && step.phase.steps.some((s) => !s.tags.includes("no-ui")));
  const needsServer = config.checks.some((c) => c.needsDevServer) || testerWanted || bugBashWanted;
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

  let checkResults = null;
  if (!failure) {
    checkResults = await runChecks(config.checks, { cwd: root, env, devServerReady });
    for (const r of checkResults.results) if (r.ran) sections.push({ title: `Check "${r.name}": ${r.code === 0 && !r.timedOut ? "passed" : "FAILED"}`, body: `\`${r.command}\` in ${Math.round(r.durationMs / 1000)} s${r.code === 0 && !r.timedOut ? "" : `\n\n${checkFailureSection(r).body}`}` });
    if (!checkResults.ok) failure = `check "${checkResults.failed.name}" failed`;
  }

  const followUps = [];
  if (!failure && (testerWanted || bugBashWanted) && !devServerReady) {
    ev("browser-skipped", { reason: "no dev server" });
    sections.push({ title: "Browser checks skipped", body: "No devServer command and url are set in autoclaude.config.json, so the browser tester and the bug bash could not open the app. Set devServer to have UI steps checked in a browser." });
  } else if (!failure && !testerWanted && !bugBashWanted) {
    ev("tester-skipped");
  }
  // The independent checkers, in order: browser tester, bug bash (both need the dev server),
  // then the security reviewer (P5.4, needs only the diff). Same rules for all three: a failure
  // counts as an attempt; a checker that cannot run never does, and pauses the second time.
  const checkers = [];
  if (!failure && devServerReady) {
    if (testerWanted) checkers.push({ kind: "tester", label: "browser tester", run: () => runBrowser({ kind: "tester", root, config, step, parsed, env, attempt, deadlineMs }) });
    if (bugBashWanted) checkers.push({ kind: "bugbash", label: "bug bash", run: () => runBrowser({ kind: "bugbash", root, config, step, parsed, env, attempt, deadlineMs }) });
  }
  const runSecurity = "runSecurity" in deps ? deps.runSecurity : runSecurityReview;
  if (!failure && runSecurity && securityWanted(config, step, parsed)) {
    checkers.push({ kind: "security", label: "security review", run: () => runSecurity({ root, config, step, parsed, state, env, attempt, deadlineMs }) });
  }
  const securityFindings = [];
  let failureKind = failure ? "checks" : null;
  for (const c of checkers) {
    const r = await c.run();
    ev(c.kind, { status: r.status, verdictFile: r.verdictFile });
    sections.push(...(r.sections || []));
    if (r.status === "infra") {
      // The checker could not run: a machine problem, never the builder's attempt (P4.2).
      const n = ((state.infraFailures || {})[step.id] || 0) + 1;
      const report = writeReport({ root, step: step.id, attempt: `${attempt}-infra${n}`, title: `AutoClaude report: ${step.id}, ${c.label} could not run`, sections });
      logLine(root, `${step.id}: ${c.label} could not run (${n}): ${r.failed} (${report.relPath})`);
      ev("infra", { kind: c.kind, count: n, report: report.relPath });
      const infraFailures = { ...(state.infraFailures || {}), [step.id]: n };
      if (n >= 2) {
        saveState(root, { ...state, infraFailures, status: STATUS.paused, pauseReason: "infra" });
        stopDevServer({ root });
        ev("paused", { reason: "infra" });
        await say({ title: `AutoClaude paused: the ${c.label} cannot run`, message: `${r.failed}\nReport: ${report.relPath}\nCheck ${c.kind === "security" ? "the claude CLI" : "Playwright and the claude CLI"} on this machine, then \`${cli} resume\`.`, priority: "high" });
        return allow(events);
      }
      saveState(root, { ...state, infraFailures });
      return block(`The ${c.label} could not run: ${r.failed}. That is a problem on this machine, not with ${step.id}, and it did not count as an attempt. Run \`${cli} ready ${step.id}\` again. Report: ${report.relPath}`, events);
    }
    if (c.kind === "security") securityFindings.push(...(r.findings || []));
    else followUps.push(...(r.followUps || []));
    if (r.status === "failed") { failure = r.failed; failureKind = c.kind; break; }
  }

  if (failure) {
    const report = writeReport({ root, step: step.id, attempt, title: `AutoClaude report: ${step.id} attempt ${attempt}`, sections });
    const attempts = { ...state.attempts, [step.id]: attempt };
    ev("failed", { step: step.id, attempt, failure, report: report.relPath });
    logLine(root, `${step.id} attempt ${attempt} failed: ${failure} (${report.relPath})`);
    if (attempt >= config.retries.maxAttemptsPerStep) {
      planText = setMarker(planText, step.id, MARKERS.failed);
      writeFileAtomic(planFile, planText);
      const reason = failureKind === "security" ? "security" : "step-failed";
      saveState(root, { ...state, attempts, status: STATUS.paused, pauseReason: reason });
      stopDevServer({ root });
      ev("paused", { reason });
      await say({ title: `AutoClaude paused: ${step.id} failed ${attempt} times`, message: `${failure}\nReport: ${report.relPath}\nFix it or adjust the plan, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    const owner = ownerInput(state, config);
    saveState(root, owner.mark({ ...state, attempts }));
    const failingSections = sections.filter((s) => /FAILED|failed/.test(s.title));
    return block(owner.text + summarize({ headline: `${step.id} attempt ${attempt}/${config.retries.maxAttemptsPerStep} failed: ${failure}. Fix the causes, then run \`${cli} ready ${step.id}\` again.`, sections: failingSections, reportPath: report.relPath, maxChars: MAX_REASON - owner.text.length }), events);
  }

  // Pass.
  planText = setMarker(planText, step.id, MARKERS.done);
  writeFileAtomic(planFile, planText);
  parsed = parsePlan(planText);
  const ticked = [...(state.tickedByGate || []), step.id];
  const phaseEnd = isPhaseEnd(parsed, step.id);
  const date = nowIso(deps).slice(0, 10);
  appendLine(path.join(root, config.docs.progress), `- ${date} ${step.id} ${step.title} (attempt ${attempt})`);
  if (followUps.length) appendFollowUps(root, config, step, followUps, date);
  if (securityFindings.length) appendSecurityFindings(root, config, step, securityFindings, date);
  let sha = null;
  let commitError = null;
  if (config.git.commitEachStep) {
    const c = await git.commitAll(root, `autoclaude(${step.id}): ${step.title}`);
    sha = c.sha || null;
    if (!c.ok) { commitError = String(c.stderr || "").trim() || "unknown error"; logLine(root, `commit failed: ${commitError}`); }
    if (phaseEnd && config.git.tagPhaseEnds && step.phase) {
      const t = await git.tag(root, `ac-phase-${step.phase.num}`, { force: true });
      if (!t.ok) logLine(root, `tag failed: ${t.stderr}`);
    }
  }
  ev("passed", { step: step.id, attempt, sha, phaseEnd });
  logLine(root, `${step.id} verified${sha ? ` (${sha.slice(0, 7)})` : commitError ? " but NOT committed" : ""}`);

  // Owner input that reached the builder (in a gate message) belonged to this step: done with.
  // Notes not yet delivered stay pending for the next step or the next session start.
  const base = {
    ...state, tickedByGate: ticked, attempts: { ...state.attempts, [step.id]: 0 }, infraFailures: { ...(state.infraFailures || {}), [step.id]: 0 },
    noProgress: 0, headAtLastGate: sha || state.headAtLastGate,
    pendingNotes: (state.pendingNotes || []).filter((n) => !n.delivered), ownerAnswer: null
  };
  const next = nextStep(parsed);

  // A step that passed but could not be committed stops the run: carrying on would pile later
  // steps onto an unrecorded one (seen live: git was not on the run window's PATH, and the last
  // step was reported verified and the plan complete with nothing committed). `autoclaude
  // resume` commits the pending steps before the session restarts.
  if (commitError) {
    saveState(root, { ...base, uncommitted: [...(state.uncommitted || []), step.id], currentStep: next ? next.id : null, status: STATUS.paused, pauseReason: "commit-failed", stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "commit-failed" });
    const why = commitError.split(/\r?\n/)[0].slice(0, 300);
    await say({ title: `AutoClaude paused: ${step.id} passed but was not committed`, message: `git said: ${why}\nThe work is safe in the working tree. Fix git on this machine (is it on PATH where the run was started?), then \`${cli} resume\`, which commits it first.`, priority: "high" });
    return allow(events);
  }
  if (!next) return await complete(root, base, config, parsed, ev, events, say, deps);

  const pauseNow = state.pauseRequested || config.review.pauseAt === "every-step" || (phaseEnd && config.review.pauseAt === "phase-end");
  if (pauseNow) {
    saveState(root, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: "review", pauseRequested: false, stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "review" });
    await say({ title: "AutoClaude paused for review", message: `Verified ${step.id} ${step.title}. Next: ${next.id} ${next.title}.\nLeave notes with \`${cli} note "..."\`, then \`${cli} resume\`.`, priority: "default" });
    return allow(events);
  }

  // Usage gate (P5.5). Stale or missing data never pauses a run; it is logged once until fresh
  // data arrives again.
  const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: deps.now ? deps.now().getTime() : Date.now() });
  if (usage.stale) {
    if (!state.usageStaleWarned) {
      logLine(root, `WARNING usage data is ${usage.source ? `${Math.round(usage.ageMin)} min old` : "missing"} (staleAfterMin ${config.usage.staleAfterMin}); the weekly-limit pause is not enforced until fresh data arrives`);
      ev("usage-stale");
    }
    base.usageStaleWarned = true;
  } else {
    base.usageStaleWarned = false;
  }
  if (!usage.stale && usage.sevenDay && usage.sevenDay.pct >= config.usage.weeklyPauseAtPct) {
    saveState(root, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: "weekly-limit", stepStartedAt: null, weeklyResetsAt: usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toISOString() : null });
    stopDevServer({ root });
    ev("paused", { reason: "weekly-limit", pct: usage.sevenDay.pct });
    const resets = usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toLocaleString() : "unknown";
    await say({ title: "AutoClaude paused: weekly usage limit", message: `7-day usage is ${Math.round(usage.sevenDay.pct)}% (threshold ${config.usage.weeklyPauseAtPct}%). Resets ${resets}. ${config.usage.autoResumeAfterWeeklyReset ? "The supervisor resumes after the reset." : `Resume with \`${cli} resume\` when you want.`}`, priority: "default" });
    return allow(events);
  }

  const owner = ownerInput(base, config);
  saveState(root, owner.mark({ ...base, currentStep: next.id, stepStartedAt: nowIso(deps), toolCallsAtLastGate: readHeartbeat(root).count }));
  ev("advanced", { next: next.id });
  return block(`${owner.text}${step.id} verified and committed${sha ? ` (${sha.slice(0, 7)})` : ""}. Next: ${next.id} ${next.title}. When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${next.id}\`.\n\n${stepText(parsed, next)}`, events);
}

async function complete(root, state, config, parsed, ev, events, say, deps) {
  saveState(root, { ...state, status: STATUS.complete, currentStep: null, pauseRequested: false });
  stopDevServer({ root });
  const p = progress(parsed);
  const started = state.startedAt ? Date.parse(state.startedAt) : null;
  const mins = started ? Math.round(((deps.now ? deps.now().getTime() : Date.now()) - started) / 60000) : null;
  ev("complete", { done: p.done, total: p.total, mins });
  try { appendLine(path.join(root, ".autoclaude", "logs", "gate.log"), `${new Date().toISOString()} plan complete: ${p.done}/${p.total}`); } catch {}
  let summary = `${p.done}/${p.total} steps verified${mins !== null ? ` in ${mins} min` : ""}.`;
  try {
    const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: deps.now ? deps.now().getTime() : Date.now() });
    summary = buildSummary({ root, config, state: { ...state, status: STATUS.complete }, parsed, usage: usage.stale ? null : usage, now: deps.now ? deps.now().getTime() : Date.now() });
  } catch {}
  await say({ title: `AutoClaude: plan complete (${planSlug(parsed)})`, message: `${summary}\nBranch ${(await git.currentBranch(root)) || "?"}. Review the commits, ${config.docs.decisions} and ${config.docs.blockers} before merging.`, priority: "default" });
  return allow(events);
}
