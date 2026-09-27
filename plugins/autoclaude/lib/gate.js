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
import { writeReport, checkFailureSection, summarize } from "./report.js";
import { ensureDevServer, stopDevServer } from "./devserver.js";
import * as git from "./git.js";
import { notify } from "./notify.js";
import { readUsage } from "./usage.js";

const MAX_REASON = 4000;

export function cliCommand(env = process.env) {
  // What the builder should type. The shim is on the user PATH after install-cli; fall back to node.
  const dirs = (env.PATH || env.Path || "").split(path.delimiter);
  const hasShim = dirs.some((d) => d && (fs.existsSync(path.join(d, "autoclaude.cmd")) || fs.existsSync(path.join(d, "autoclaude"))));
  if (hasShim) return "autoclaude";
  return `node "${path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..", "bin", "autoclaude.js").replace(/\\/g, "/")}"`;
}

function nowIso(deps) { return (deps.now ? deps.now() : new Date()).toISOString(); }

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
    saveState(root, next);
    ev("nudge", { noProgress: next.noProgress });
    const wrong = ready ? `The ready marker named ${ready.step}, but the current step is ${step.id}. ` : "";
    return block(`${wrong}Continue ${step.id} (${step.title}). When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${step.id}\`. If you truly cannot proceed without a human, run \`${cli} blocked ${step.id} "<question with options>"\`.\n\n${stepText(parsed, step)}`, events);
  }

  // Ready: verify.
  clearReady(root);
  const attempt = (state.attempts[step.id] || 0) + 1;
  ev("verify", { step: step.id, attempt });
  logLine(root, `verifying ${step.id} attempt ${attempt}`);
  const sections = [];
  let failure = null;

  const needsServer = config.checks.some((c) => c.needsDevServer);
  let devServerReady = false;
  if (needsServer && config.devServer.command) {
    const ds = await ensureDevServer(config.devServer, { root, env });
    if (ds.ok) devServerReady = true;
    else {
      failure = `dev server: ${ds.error}`;
      sections.push({ title: "Dev server failed to start", body: `${ds.error}\n\n\`\`\`\n${ds.logTail || ""}\n\`\`\`` });
    }
  }

  let checkResults = null;
  if (!failure) {
    checkResults = await runChecks(config.checks, { cwd: root, env, devServerReady });
    for (const r of checkResults.results) if (r.ran) sections.push({ title: `Check "${r.name}": ${r.code === 0 && !r.timedOut ? "passed" : "FAILED"}`, body: `\`${r.command}\` in ${Math.round(r.durationMs / 1000)} s${r.code === 0 && !r.timedOut ? "" : `\n\n${checkFailureSection(r).body}`}` });
    if (!checkResults.ok) failure = `check "${checkResults.failed.name}" failed`;
  }

  if (!failure && deps.tester) {
    const t = await deps.tester({ root, config, step, parsed, env });
    if (t && t.sections) sections.push(...t.sections);
    if (t && t.failed) failure = t.failed;
  } else if (!failure) {
    ev("tester-skipped");
  }

  if (failure) {
    const report = writeReport({ root, step: step.id, attempt, title: `AutoClaude report: ${step.id} attempt ${attempt}`, sections });
    const attempts = { ...state.attempts, [step.id]: attempt };
    ev("failed", { step: step.id, attempt, failure, report: report.relPath });
    logLine(root, `${step.id} attempt ${attempt} failed: ${failure} (${report.relPath})`);
    if (attempt >= config.retries.maxAttemptsPerStep) {
      planText = setMarker(planText, step.id, MARKERS.failed);
      writeFileAtomic(planFile, planText);
      saveState(root, { ...state, attempts, status: STATUS.paused, pauseReason: "step-failed" });
      stopDevServer({ root });
      ev("paused", { reason: "step-failed" });
      await say({ title: `AutoClaude paused: ${step.id} failed ${attempt} times`, message: `${failure}\nReport: ${report.relPath}\nFix it or adjust the plan, then \`${cli} resume\`.`, priority: "high" });
      return allow(events);
    }
    saveState(root, { ...state, attempts });
    const failingSections = sections.filter((s) => /FAILED|failed/.test(s.title));
    return block(summarize({ headline: `${step.id} attempt ${attempt}/${config.retries.maxAttemptsPerStep} failed: ${failure}. Fix the causes, then run \`${cli} ready ${step.id}\` again.`, sections: failingSections, reportPath: report.relPath, maxChars: MAX_REASON }), events);
  }

  // Pass.
  planText = setMarker(planText, step.id, MARKERS.done);
  writeFileAtomic(planFile, planText);
  parsed = parsePlan(planText);
  const ticked = [...(state.tickedByGate || []), step.id];
  const phaseEnd = isPhaseEnd(parsed, step.id);
  const date = nowIso(deps).slice(0, 10);
  appendLine(path.join(root, config.docs.progress), `- ${date} ${step.id} ${step.title} (attempt ${attempt})`);
  let sha = null;
  if (config.git.commitEachStep) {
    const c = await git.commitAll(root, `autoclaude(${step.id}): ${step.title}`);
    sha = c.sha || null;
    if (!c.ok) logLine(root, `commit failed: ${c.stderr}`);
    if (phaseEnd && config.git.tagPhaseEnds && step.phase) {
      const t = await git.tag(root, `ac-phase-${step.phase.num}`, { force: true });
      if (!t.ok) logLine(root, `tag failed: ${t.stderr}`);
    }
  }
  ev("passed", { step: step.id, attempt, sha, phaseEnd });
  logLine(root, `${step.id} verified${sha ? ` (${sha.slice(0, 7)})` : ""}`);

  const base = { ...state, tickedByGate: ticked, attempts: { ...state.attempts, [step.id]: 0 }, noProgress: 0, headAtLastGate: sha || state.headAtLastGate };
  const next = nextStep(parsed);
  if (!next) return await complete(root, base, config, parsed, ev, events, say, deps);

  const pauseNow = state.pauseRequested || config.review.pauseAt === "every-step" || (phaseEnd && config.review.pauseAt === "phase-end");
  if (pauseNow) {
    saveState(root, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: "review", pauseRequested: false, stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "review" });
    await say({ title: "AutoClaude paused for review", message: `Verified ${step.id} ${step.title}. Next: ${next.id} ${next.title}.\nLeave notes with \`${cli} note "..."\`, then \`${cli} resume\`.`, priority: "default" });
    return allow(events);
  }

  const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: deps.now ? deps.now().getTime() : Date.now() });
  if (!usage.stale && usage.sevenDay && usage.sevenDay.pct >= config.usage.weeklyPauseAtPct) {
    saveState(root, { ...base, currentStep: next.id, status: STATUS.paused, pauseReason: "weekly-limit", stepStartedAt: null });
    stopDevServer({ root });
    ev("paused", { reason: "weekly-limit", pct: usage.sevenDay.pct });
    const resets = usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toLocaleString() : "unknown";
    await say({ title: "AutoClaude paused: weekly usage limit", message: `7-day usage is ${Math.round(usage.sevenDay.pct)}% (threshold ${config.usage.weeklyPauseAtPct}%). Resets ${resets}. ${config.usage.autoResumeAfterWeeklyReset ? "The supervisor resumes after the reset." : `Resume with \`${cli} resume\` when you want.`}`, priority: "default" });
    return allow(events);
  }

  saveState(root, { ...base, currentStep: next.id, stepStartedAt: nowIso(deps), toolCallsAtLastGate: readHeartbeat(root).count });
  ev("advanced", { next: next.id });
  return block(`${step.id} verified and committed${sha ? ` (${sha.slice(0, 7)})` : ""}. Next: ${next.id} ${next.title}. When every Accept line holds, rewrite ${config.docs.continueHere} and run \`${cli} ready ${next.id}\`.\n\n${stepText(parsed, next)}`, events);
}

async function complete(root, state, config, parsed, ev, events, say, deps) {
  saveState(root, { ...state, status: STATUS.complete, currentStep: null, pauseRequested: false });
  stopDevServer({ root });
  const p = progress(parsed);
  const started = state.startedAt ? Date.parse(state.startedAt) : null;
  const mins = started ? Math.round(((deps.now ? deps.now().getTime() : Date.now()) - started) / 60000) : null;
  ev("complete", { done: p.done, total: p.total });
  try { appendLine(path.join(root, ".autoclaude", "logs", "gate.log"), `${new Date().toISOString()} plan complete: ${p.done}/${p.total}`); } catch {}
  await say({ title: `AutoClaude: plan complete (${planSlug(parsed)})`, message: `${p.done}/${p.total} steps verified${mins !== null ? ` in ${mins} min` : ""}. Branch ${(await git.currentBranch(root)) || "?"}. Review the commits and ${config.docs.decisions}.`, priority: "default" });
  return allow(events);
}
