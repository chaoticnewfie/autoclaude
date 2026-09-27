// The supervisor (PLAN.md P6.3, P6.4, D18): runs in the `ac-<project>` console window, owns the
// interactive builder session (`claude` with inherited stdio), and every poll decides from files
// alone whether the session is working, waiting out a usage limit, idle, stalled or gone. It
// relaunches with `claude --continue ... "/autoclaude:resume"`, which resumes the same
// conversation; all run state is in files, so nothing is lost. Two relaunches in a row without
// progress pause the run as stuck and page the owner. Node built-ins only.
//
// While a session is alive the supervisor never prints to the console (it would corrupt the
// session's screen); it logs to .autoclaude/logs/supervisor.log.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { projectPaths } from "./paths.js";
import { loadState, updateState, STATUS } from "./state.js";
import { loadConfig } from "./config.js";
import { readJson, writeJsonAtomic, appendLine, removeIfExists, ensureDir, readText } from "./fsatomic.js";
import { readHeartbeat } from "./protocol.js";
import { readUsage } from "./usage.js";
import { claudeBinary } from "./headless.js";
import { killTree, isPidAlive } from "./proc.js";
import { notify } from "./notify.js";
import { resumeRun } from "./resume.js";
import { buildSummary } from "./summary.js";
import { parsePlan } from "./plan.js";

const MIN = 60 * 1000;

// Environment for the builder: nothing from a parent Claude Code session (so it is never treated
// as nested) and no role marker; CLAUDE_CONFIG_DIR and everything else pass through.
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || k === "CLAUDE_AGENT_SDK_VERSION" || k === "AUTOCLAUDE_ROLE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_PLUGIN_")) delete out[k];
  }
  return out;
}

export function launchArgs(kind, prompt = null) {
  if (kind === "start") return ["--permission-mode", "auto", "/autoclaude:start"];
  return ["--continue", "--permission-mode", "auto", prompt || "/autoclaude:resume"];
}

const ts = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const mins = (ms) => `${Math.round(ms / MIN)} min`;

// Pure decision. Every input is a plain value; see supervise() for where each comes from.
// Returns { action: "none" | "relaunch" | "nudge" | "continue" | "pause-stuck" | "pause-weekly" | "resume-weekly" | "exit", reason }.
export function decide(i) {
  const { status, now, childAlive, cfg, sup } = i;
  const s = cfg.supervisor;
  if (status === STATUS.running) {
    let want = null;
    const last = i.lastActivityAt || 0;
    if (!childAlive) want = "the session exited";
    // A verification in progress is never interrupted, not even by an owner nudge (seen live: a
    // nudge that landed during the gate's run killed it and wasted the builder's `ready`).
    else if (i.gateAt && now - i.gateAt < (cfg.gate.timeoutSec + 300) * 1000) return { action: "none", reason: i.nudge ? "the gate is verifying a step; the nudge waits" : "the gate is verifying a step" };
    else if (i.nudge) return { action: "nudge", reason: `the owner asked for: ${i.nudge}` };
    // A nudged prompt (for example /compact) ends at an idle prompt; carry on with the run at once
    // instead of waiting out idleRelaunchMin (seen live: a compacted session just sat there).
    else if (sup.nudgedAt && i.idle && i.idle.at >= sup.nudgedAt && i.idle.at >= last) return { action: "continue", reason: "the owner's nudge has finished; back to the plan" };
    else if (i.failure && i.failure.type === "rate_limit" && i.failure.at >= last) {
      if (i.usage && i.usage.sevenDay && i.usage.sevenDay.pct >= 99) return { action: "pause-weekly", reason: `the weekly usage limit is reached (${Math.round(i.usage.sevenDay.pct)}%)` };
      const reset = (i.usage && i.usage.fiveHour && i.usage.fiveHour.resetsAt) || i.failure.at + 5 * 60 * MIN;
      const until = Math.max(reset, i.failure.at) + s.rateLimitGraceMin * MIN;
      if (now < until) return { action: "none", reason: `waiting out a usage limit until ${new Date(until).toISOString()}` };
      want = "the usage limit reset but the session did not continue";
    } else if (i.failure && i.failure.type !== "rate_limit" && i.failure.at >= last && now - i.failure.at > MIN) {
      want = `the turn ended with an API error (${i.failure.type})`;
    } else if (sup.resumedAt && last < sup.resumedAt && now - sup.resumedAt > s.resumeGraceMin * MIN) {
      want = "the run was resumed but the session did not pick it up";
    } else if (i.idle && i.idle.at >= last && now - i.idle.at > s.idleRelaunchMin * MIN) {
      want = `the session has been idle at its prompt for ${mins(now - i.idle.at)}`;
    } else if (now - last > s.stallMin * MIN) {
      if (i.agentStatus === "idle") want = `no activity for ${mins(now - last)} and the session is idle`;
      else if (now - last > 2 * s.stallMin * MIN) want = `no activity for ${mins(now - last)}`;
    }
    if (!want) return { action: "none", reason: "working" };
    if (sup.recoveries >= s.maxRecoveries && i.heartbeatCount === sup.countAtLastRecovery) {
      return { action: "pause-stuck", reason: `${want}, after ${sup.recoveries} relaunches without progress` };
    }
    return { action: "relaunch", reason: want };
  }
  if (status === STATUS.paused) {
    if (i.pauseReason === "weekly-limit" && cfg.usage.autoResumeAfterWeeklyReset && i.weeklyResetsAt && now > i.weeklyResetsAt + s.rateLimitGraceMin * MIN) {
      return { action: "resume-weekly", reason: "the weekly usage limit has reset" };
    }
    return { action: "none", reason: `paused (${i.pauseReason || "?"})` };
  }
  if (!childAlive) return { action: "exit", reason: status === STATUS.complete ? "the plan is complete" : `the run is ${status}` };
  return { action: "none", reason: status };
}

// The builder session's entry in `claude agents --json`: "busy", "idle", or null when unknown.
export function queryAgentStatus(pid, env = process.env) {
  if (!pid) return null;
  const exe = claudeBinary(env);
  if (!exe) return null;
  const r = spawnSync(exe, ["agents", "--json", "--all"], { env: childEnv(env), encoding: "utf8", timeout: 30000, windowsHide: true });
  if (r.status !== 0) return null;
  try {
    const list = JSON.parse(r.stdout);
    const me = Array.isArray(list) ? list.find((a) => a && a.pid === pid) : null;
    return me ? me.status || null : null;
  } catch {
    return null;
  }
}

function localHHMM(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
function localDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export async function supervise({
  root,
  env = process.env,
  spawnChild = null,
  agentStatus = queryAgentStatus,
  say = null,
  now = () => Date.now(),
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  maxLoops = Infinity,
  console: out = console
} = {}) {
  const p = projectPaths(root);
  ensureDir(p.logsDir);
  const logFile = path.join(p.logsDir, "supervisor.log");
  const supFile = path.join(p.runtimeDir, "supervisor.json");
  let child = null;
  let childAlive = false;
  let childStartedAt = null;
  const log = (m) => {
    appendLine(logFile, `${new Date(now()).toISOString()} ${m}`);
    if (!childAlive) out.log(`[autoclaude] ${m}`);
  };
  const cfgNow = () => loadConfig(root).config;
  const notifyOwner = say || ((msg) => notify(msg, { logFile: path.join(p.logsDir, "notify.log"), stdout: { write() { return true; } }, env }));
  const title = `ac-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

  fs.writeFileSync(p.supervisorPidFile, String(process.pid));
  updateState(root, (s) => { s.supervisorPid = process.pid; s.windowTitle = title; });
  let sup = { recoveries: 0, countAtLastRecovery: -1, resumedAt: null, nudgedAt: null, lastMorningDate: null };
  try { sup = { ...sup, ...(readJson(supFile, {}) || {}), resumedAt: null, nudgedAt: null }; } catch {}
  const saveSup = () => { try { writeJsonAtomic(supFile, sup); } catch {} };

  const doSpawn = spawnChild || ((args, opts) => spawn(claudeBinary(env), args, { ...opts, stdio: "inherit" }));
  const launch = (kind, prompt = null) => {
    const args = launchArgs(kind, prompt);
    log(`launching claude ${args.join(" ")}`);
    child = doSpawn(args, { cwd: root, env: childEnv(env) });
    childAlive = true;
    childStartedAt = now();
    child.on("exit", (code) => { childAlive = false; appendLine(logFile, `${new Date(now()).toISOString()} claude exited (code ${code})`); });
    child.on("error", (e) => { childAlive = false; appendLine(logFile, `${new Date(now()).toISOString()} claude could not start: ${e.message}`); });
  };
  const stopChild = async () => {
    if (!child || !childAlive) return;
    killTree(child.pid);
    for (let i = 0; i < 40 && childAlive; i++) await sleep(250);
  };

  let state = loadState(root);
  let lastStatus = state.status;
  if (state.status === STATUS.complete) { log("the plan is already complete; nothing to supervise"); return { exit: "complete" }; }
  if (state.status === STATUS.running) launch("resume");
  else if (state.status === STATUS.idle) launch("start");
  else log(`the run is paused (${state.pauseReason || "?"}); waiting for \`autoclaude resume\``);

  let loops = 0;
  // The last poll that saw the gate verifying. A verification is activity: without this the
  // session looked silent for the whole verification and was relaunched two seconds after a
  // nine-minute bug bash ended (seen live), which threw away the gate's answer.
  let gateSeenAt = 0;
  try {
    for (;;) {
      await sleep((cfgNow().supervisor.pollSec || 60) * 1000);
      if (++loops > maxLoops) break;
      const cfg = cfgNow();
      state = loadState(root);
      const t = now();
      if (lastStatus !== STATUS.running && state.status === STATUS.running) {
        // Only a resume from a pause needs watching for "the session did not pick it up"; the
        // idle-to-running change is the session's own `autoclaude start`, already in progress.
        if (lastStatus === STATUS.paused) sup.resumedAt = t;
        sup.recoveries = 0; sup.countAtLastRecovery = -1;
        log(`the run is ${lastStatus === STATUS.paused ? "running again" : "running"} (was ${lastStatus})`);
      }
      lastStatus = state.status;
      const beat = readHeartbeat(root);
      if (beat.count > sup.countAtLastRecovery && sup.countAtLastRecovery >= 0) { sup.recoveries = 0; sup.countAtLastRecovery = -1; }
      const idle = (() => { try { const j = readJson(p.idleFile, null); return j ? { type: j.type, at: ts(j.at) } : null; } catch { return null; } })();
      const failure = (() => { try { const j = readJson(p.failureFile, null); return j ? { type: j.type, at: ts(j.at) } : null; } catch { return null; } })();
      // A verifying marker only counts while the gate process that wrote it is alive; a session
      // killed mid-verification leaves a stale one behind.
      const gate = (() => {
        const f = path.join(p.runtimeDir, "gate.json");
        try {
          const j = readJson(f, null);
          if (!j) return null;
          if (j.pid && !isPidAlive(j.pid)) { removeIfExists(f); return null; }
          return ts(j.at);
        } catch { return null; }
      })();
      const nudgeFile = path.join(p.runtimeDir, "nudge.json");
      const nudge = (() => { try { const j = readJson(nudgeFile, null); return j && j.prompt ? String(j.prompt) : null; } catch { return null; } })();
      const usage = readUsage({ staleAfterMin: 24 * 60, now: t });
      if (gate && t - gate < (cfg.gate.timeoutSec + 300) * 1000) gateSeenAt = t;
      const lastActivityAt = Math.max(ts(beat.at) || 0, childStartedAt || 0, gateSeenAt);
      const stale = t - lastActivityAt > cfg.supervisor.stallMin * MIN;
      const input = {
        status: state.status, pauseReason: state.pauseReason, now: t, childAlive, cfg, sup,
        lastActivityAt, heartbeatCount: beat.count, idle, failure, gateAt: gate, usage, nudge,
        agentStatus: stale && childAlive && child ? agentStatus(child.pid, env) : null,
        weeklyResetsAt: ts(state.weeklyResetsAt) || (usage.sevenDay && usage.sevenDay.resetsAt) || null
      };
      const d = decide(input);
      if (d.action !== "none") log(`${d.action}: ${d.reason}`);

      if (d.action === "nudge") {
        // An owner request, not a recovery: it does not count towards the stuck limit.
        removeIfExists(nudgeFile);
        removeIfExists(p.idleFile);
        await stopChild();
        sup.nudgedAt = now();
        launch("resume", nudge);
      } else if (d.action === "continue") {
        // Also an owner request, so it does not count towards the stuck limit either.
        sup.nudgedAt = null;
        removeIfExists(p.idleFile);
        await stopChild();
        launch("resume");
      } else if (d.action === "relaunch") {
        await stopChild();
        sup.recoveries += 1; sup.countAtLastRecovery = beat.count; sup.resumedAt = null; sup.nudgedAt = null;
        removeIfExists(p.idleFile);
        if (failure && failure.type !== "rate_limit") removeIfExists(p.failureFile);
        launch("resume");
      } else if (d.action === "pause-stuck") {
        updateState(root, (s) => { s.status = STATUS.paused; s.pauseReason = "stuck"; });
        lastStatus = STATUS.paused;
        await notifyOwner({ title: `AutoClaude stuck on ${state.currentStep || "?"}`, message: `${d.reason}. The run is paused. Look at the ${title} window and .autoclaude/logs/supervisor.log, then \`autoclaude resume\`.`, priority: "high" });
      } else if (d.action === "pause-weekly") {
        updateState(root, (s) => { s.status = STATUS.paused; s.pauseReason = "weekly-limit"; s.weeklyResetsAt = usage.sevenDay && usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toISOString() : null; });
        lastStatus = STATUS.paused;
        await notifyOwner({ title: "AutoClaude paused: weekly usage limit", message: `${d.reason}. ${cfg.usage.autoResumeAfterWeeklyReset ? "It resumes after the reset." : "Resume with `autoclaude resume` when you want."}`, priority: "default" });
      } else if (d.action === "resume-weekly") {
        const project = { root, config: cfg };
        resumeRun(project, loadState(root), { weeklyResetsAt: null });
        await notifyOwner({ title: "AutoClaude resumed after the weekly reset", message: `Continuing ${loadState(root).currentStep || "?"}.`, priority: "default" });
      } else if (d.action === "exit") {
        log(`${d.reason}; the supervisor is done`);
        break;
      }

      // Optional morning summary (P6.5), once a day at notify.morningSummaryAt local time.
      const at = cfg.notify.morningSummaryAt;
      if (at && (state.status === STATUS.running || state.status === STATUS.paused) && localHHMM(t) >= at && sup.lastMorningDate !== localDate(t)) {
        const parsed = parsePlan(readText(path.join(root, cfg.plan), ""));
        const since = sup.lastMorningDate || (state.startedAt || "").slice(0, 10) || null;
        const text = buildSummary({ root, config: cfg, state, parsed, usage: usage.stale ? null : usage, now: t, sinceDate: since });
        await notifyOwner({ title: `AutoClaude morning summary (${path.basename(root)})`, message: text, priority: "low" });
        sup.lastMorningDate = localDate(t);
        log("sent the morning summary");
      }
      saveSup();
    }
  } finally {
    saveSup();
    try { if (Number(fs.readFileSync(p.supervisorPidFile, "utf8")) === process.pid) fs.unlinkSync(p.supervisorPidFile); } catch {}
  }
  return { exit: "done", loops };
}
