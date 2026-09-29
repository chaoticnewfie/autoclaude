// The supervisor (PLAN.md P6.3, P6.4, D18): runs in the `ac-<project>` console window, owns the
// interactive builder session (`claude` with inherited stdio), and every poll decides from files
// alone whether the session is working, waiting out a usage limit, idle, stalled or gone. The
// first launch gives the session its own id (`claude --session-id <uuid>`, kept in state as
// builderSessionId) and every relaunch is `claude --resume <that id> ... "/autoclaude:resume"`,
// so it resumes the builder's conversation and never a person's own session in the same folder;
// all run state is in files, so nothing is lost. Two relaunches in a row without progress pause
// the run as stuck and page the owner. After a verified feature the gate sets state.freshSession
// and the supervisor replaces the session with a new one under a new id (D49). Node built-ins only.
//
// While a session is alive the supervisor never prints to the console (it would corrupt the
// session's screen); it logs to .autoclaude/logs/supervisor.log.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { projectPaths, isWindows } from "./paths.js";
import { loadState, updateState, STATUS } from "./state.js";
import { loadConfig } from "./config.js";
import { readJson, writeJsonAtomic, appendLine, removeIfExists, ensureDir, readText } from "./fsatomic.js";
import { readHeartbeat } from "./protocol.js";
import { readUsage } from "./usage.js";
import { claudeBinary } from "./headless.js";
import { killTree, isPidAlive, cmdShimArg, cmdShimLine, spawnClaude } from "./proc.js";
import { notify } from "./notify.js";
import { resumeRun, undoCutVerification } from "./resume.js";
import { buildSummary } from "./summary.js";
import { parsePlan } from "./plan.js";
import { stopDevServer } from "./devserver.js";
import { recordRunEnv } from "./checks.js";

const MIN = 60 * 1000;

// Environment for the builder: nothing from a parent Claude Code session (so it is never treated
// as nested) and no role marker; CLAUDE_CONFIG_DIR and everything else pass through.
// AUTOCLAUDE_BUILDER=1 is how the hooks tell the builder from any other session on the machine.
export function childEnv(env = process.env) {
  const out = { ...env };
  for (const k of Object.keys(out)) {
    if (k === "CLAUDECODE" || k === "CLAUDE_PID" || k === "CLAUDE_EFFORT" || k === "CLAUDE_AGENT_SDK_VERSION" || k === "AUTOCLAUDE_ROLE" || k.startsWith("CLAUDE_CODE_") || k.startsWith("CLAUDE_PLUGIN_")) delete out[k];
  }
  out.AUTOCLAUDE_BUILDER = "1";
  return out;
}

// The --settings JSON for the builder, or null. Planning writes, for what the plan allows outside
// the project, Claude Code permission allow rules (they skip the auto-mode classifier, except for
// protected paths) and plain-language trusted-infrastructure lines for auto mode. Claude Code reads
// autoMode.environment only from user settings, managed settings or --settings, never from a
// project's files, so it has to come in here; "$defaults" keeps the built-in list. --settings
// merges with the settings files, so nothing the owner set is lost. Only non-empty parts go in.
export function builderSettings(config) {
  const perms = (config && config.permissions) || {};
  const allow = Array.isArray(perms.allow) ? perms.allow.filter((r) => typeof r === "string" && r.trim()) : [];
  const environment = Array.isArray(perms.environment) ? perms.environment.filter((r) => typeof r === "string" && r.trim()) : [];
  if (!allow.length && !environment.length) return null;
  const s = {};
  if (allow.length) s.permissions = { allow };
  if (environment.length) s.autoMode = { environment: ["$defaults", ...environment] };
  return JSON.stringify(s);
}

// The per-launch options from the project's settings: model, effort and the settings JSON.
export function launchOptions(config) {
  const b = (config && config.builder) || {};
  return { model: b.model || null, effort: b.effort || null, settings: builderSettings(config) };
}

// A start launch names its session (`--session-id`, a fresh UUID each time: Claude Code refuses
// an id that is already in use). A relaunch resumes that session by id; `--continue` would pick
// the most recent conversation in the folder, which can be a person's own session. Runs started
// by a version without builderSessionId fall back to `--continue`. A "fresh" launch is a new
// session under a new id with the run's prompt (a new feature, D49, or a resume that failed).
// The builder's model (builder.model, Opus by default, D44) is passed on every launch, so it never
// depends on the owner's own Claude Code default. Effort is passed only when builder.effort is
// set: unset, the owner's own default applies (D49). The settings JSON goes in as one argument.
export function launchArgs(kind, prompt = null, sessionId = null, model = null, { effort = null, settings = null } = {}) {
  const m = [...(model ? ["--model", model] : []), ...(effort ? ["--effort", effort] : []), ...(settings ? ["--settings", settings] : [])];
  if (kind === "start") return [...(sessionId ? ["--session-id", sessionId] : []), ...m, "--permission-mode", "auto", "/autoclaude:start"];
  if (kind === "fresh") return ["--session-id", sessionId, ...m, "--permission-mode", "auto", prompt || "/autoclaude:resume"];
  return [...(sessionId ? ["--resume", sessionId] : ["--continue"]), ...m, "--permission-mode", "auto", prompt || "/autoclaude:resume"];
}

// cmdShimArg, cmdShimLine and spawnClaude live in proc.js (headless.js needs them too); they are
// re-exported here for existing callers.
export { cmdShimArg, cmdShimLine, spawnClaude };

const ts = (iso) => { const t = iso ? Date.parse(iso) : NaN; return Number.isFinite(t) ? t : null; };
const mins = (ms) => `${Math.round(ms / MIN)} min`;

// Pure decision. Every input is a plain value; see supervise() for where each comes from.
// Returns { action: "none" | "fresh" | "relaunch" | "nudge" | "continue" | "pause-stuck" | "pause-weekly" | "resume-weekly" | "halt" | "exit", reason }.
export function decide(i) {
  const { status, now, childAlive, cfg, sup } = i;
  const s = cfg.supervisor;
  if (status === STATUS.running) {
    let want = null;
    const last = i.lastActivityAt || 0;
    // A verified feature asks for a fresh session for the next one (D49: one 18-hour context
    // averaged 459K tokens per request). Not a recovery; it waits for a verification in progress.
    if (i.freshSession) {
      if (childAlive && i.gateAt && now - i.gateAt < (cfg.gate.timeoutSec + 300) * 1000) return { action: "none", reason: "the gate is verifying; the fresh session waits" };
      return { action: "fresh", reason: "the feature is verified; a fresh builder session takes the next one" };
    }
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
    // `pause --now`: the hooks stand down once the run is paused, so a session left working
    // would carry on unguarded. End it at once; a resume relaunches it.
    if (i.haltSession && childAlive) return { action: "halt", reason: "the owner paused the run with --now; ending the session" };
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
  const args = ["agents", "--json", "--all"];
  const opts = { env: childEnv(env), encoding: "utf8", timeout: 30000, windowsHide: true };
  const r = isWindows && /\.(cmd|bat)$/i.test(exe)
    ? spawnSync("cmd.exe", ["/d", "/s", "/c", cmdShimLine(exe, args)], { ...opts, windowsVerbatimArguments: true })
    : spawnSync(exe, args, opts);
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
  newSessionId = () => crypto.randomUUID(),
  kill = killTree,
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
  // The PATH this window runs with is the one the builder, its hooks and the gate get, so
  // `autoclaude checks` from any shell uses it too (checks.js checksEnv). Recorded here as well as
  // by `autoclaude run`, because the watchdog can bring a supervisor back from another shell.
  try { recordRunEnv(root, env, { now: () => new Date(now()) }); } catch {}
  let sup = { recoveries: 0, countAtLastRecovery: -1, resumedAt: null, nudgedAt: null, lastMorningDate: null };
  // supervisor.json is written only when it changes: the rehearsal's supervisor rewrote it every
  // poll, and a builder whose tests walk the project tree saw a file change under them.
  let savedSup = null;
  try {
    const stored = readJson(supFile, null);
    if (stored) savedSup = JSON.stringify(stored);
    sup = { ...sup, ...(stored || {}), resumedAt: null, nudgedAt: null };
  } catch {}
  const saveSup = () => {
    const text = JSON.stringify(sup);
    if (text === savedSup) return;
    try { writeJsonAtomic(supFile, sup); savedSup = text; } catch {}
  };

  const doSpawn = spawnChild || ((args, opts) => {
    const exe = claudeBinary(env);
    if (!exe) throw new Error("the claude CLI was not found; install Claude Code natively (https://claude.ai/install.ps1 on Windows)");
    return spawnClaude(exe, args, { ...opts, stdio: "inherit" });
  });
  // Why the last launch could not start claude at all, for the stuck alert.
  let spawnError = null;
  // A `--resume <id>` that dies within this long found no conversation to resume (for example a
  // start session that ended before it saved anything); the next relaunch then opens a fresh
  // session under a new id instead of failing the same way until the run pauses as stuck.
  const RESUME_FAIL_MS = 30 * 1000;
  // Model, effort and the permissions JSON, read at every launch so a changed setting applies to
  // the next session.
  const options = () => { try { return launchOptions(cfgNow()); } catch { return { model: null, effort: null, settings: null }; } };
  let resumeFailedFast = false;
  // A session ended in the middle of a verification (a halt, a crash, a stall) takes its gate
  // with it, and that gate's plan ticks and PROGRESS lines would stay behind. They come out as
  // soon as the gate is gone, so the owner reviewing a pause sees the plan as it is.
  const undoCut = () => {
    try {
      // Counted as out of time when the run is still running (the gate's next ready pauses the
      // run the second time), not when the owner's pause ended it.
      const r = undoCutVerification(root, cfgNow(), { unlessGateRunning: true });
      if (r) log(r.fixup ? `the fix-up checks of ${r.step || "the last step"} were cut off with the session` : `the verification of ${r.step || "the last step"} was cut off with the session; its plan ticks and PROGRESS lines were taken out again`);
    } catch (e) {
      appendLine(logFile, `${new Date(now()).toISOString()} could not undo a cut-off verification: ${e && e.message ? e.message : e}`);
    }
  };
  const launch = (kind, prompt = null) => {
    undoCut();
    let sessionId = null;
    let args;
    const o = options();
    if (kind === "start" || kind === "fresh") {
      // A new session: a new id, and any fresh-session request is now served.
      sessionId = newSessionId();
      updateState(root, (s) => { s.builderSessionId = sessionId; s.freshSession = false; });
      args = launchArgs(kind, prompt, sessionId, o.model, o);
    } else if (resumeFailedFast) {
      sessionId = newSessionId();
      updateState(root, (s) => { s.builderSessionId = sessionId; });
      log("the builder session could not be resumed; opening a fresh one with the run context");
      args = launchArgs("fresh", prompt, sessionId, o.model, o);
    } else {
      sessionId = loadState(root).builderSessionId || null;
      args = launchArgs(kind, prompt, sessionId, o.model, o);
    }
    resumeFailedFast = false;
    const resuming = args[0] === "--resume";
    log(`launching claude ${args.join(" ")}`);
    // A spawn that throws (no claude, or one Node cannot start) is a session that exited at once:
    // the poll relaunches it and, with no progress, pauses the run as stuck with this reason.
    try {
      child = doSpawn(args, { cwd: root, env: childEnv(env) });
      spawnError = null;
    } catch (e) {
      child = null;
      childAlive = false;
      childStartedAt = now();
      spawnError = e && e.message ? e.message : String(e);
      log(`claude could not start: ${spawnError}`);
      return;
    }
    childAlive = true;
    const startedAt = childStartedAt = now();
    child.on("exit", (code) => {
      childAlive = false;
      if (resuming && code !== 0 && now() - startedAt < RESUME_FAIL_MS) resumeFailedFast = true;
      appendLine(logFile, `${new Date(now()).toISOString()} claude exited (code ${code})`);
    });
    child.on("error", (e) => { childAlive = false; appendLine(logFile, `${new Date(now()).toISOString()} claude could not start: ${e.message}`); });
  };
  const stopChild = async () => {
    if (!child || !childAlive) return;
    kill(child.pid);
    for (let i = 0; i < 40 && childAlive; i++) await sleep(250);
  };

  let state = loadState(root);
  let lastStatus = state.status;
  if (state.status === STATUS.complete) { log("the plan is already complete; nothing to supervise"); return { exit: "complete" }; }
  // A halt request left by a supervisor that died has no session to end any more.
  if (state.haltSession) updateState(root, (s) => { s.haltSession = false; });
  if (state.status === STATUS.running) launch(state.freshSession ? "fresh" : "resume");
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
        status: state.status, pauseReason: state.pauseReason, haltSession: !!state.haltSession, freshSession: !!state.freshSession, now: t, childAlive, cfg, sup,
        lastActivityAt, heartbeatCount: beat.count, idle, failure, gateAt: gate, usage, nudge,
        agentStatus: stale && childAlive && child ? agentStatus(child.pid, env) : null,
        weeklyResetsAt: ts(state.weeklyResetsAt) || (usage.sevenDay && usage.sevenDay.resetsAt) || null
      };
      const d = decide(input);
      if (d.action !== "none") log(`${d.action}: ${d.reason}`);

      if (d.action === "fresh") {
        // Planned, so not a recovery; a verified feature is progress, so the stuck count restarts.
        await stopChild();
        if (childAlive) log("the session was told to end but had not exited 10 s later; trying again on the next poll");
        else {
          sup.recoveries = 0; sup.countAtLastRecovery = -1; sup.resumedAt = null; sup.nudgedAt = null;
          removeIfExists(p.idleFile);
          launch("fresh");
        }
      } else if (d.action === "nudge") {
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
        await notifyOwner({ title: `AutoClaude stuck on ${state.currentStep || "?"}`, message: `${d.reason}.${spawnError ? ` claude could not start: ${spawnError}.` : ""} The run is paused. Look at the ${title} window and .autoclaude/logs/supervisor.log, then \`autoclaude resume\`.`, priority: "high" });
      } else if (d.action === "pause-weekly") {
        updateState(root, (s) => { s.status = STATUS.paused; s.pauseReason = "weekly-limit"; s.weeklyResetsAt = usage.sevenDay && usage.sevenDay.resetsAt ? new Date(usage.sevenDay.resetsAt).toISOString() : null; });
        lastStatus = STATUS.paused;
        await notifyOwner({ title: "AutoClaude paused: weekly usage limit", message: `${d.reason}. ${cfg.usage.autoResumeAfterWeeklyReset ? "It resumes after the reset." : "Resume with `autoclaude resume` when you want."}`, priority: "default" });
      } else if (d.action === "resume-weekly") {
        const project = { root, config: cfg };
        resumeRun(project, loadState(root), { weeklyResetsAt: null }, { env });
        await notifyOwner({ title: "AutoClaude resumed after the weekly reset", message: `Continuing ${loadState(root).currentStep || "?"}.`, priority: "default" });
      } else if (d.action === "halt") {
        await stopChild();
        // A verification cut short can leave a dev server it had just started.
        stopDevServer({ root });
        if (childAlive) log("the session was told to end but had not exited 10 s later; trying again on the next poll");
        else {
          updateState(root, (s) => { s.haltSession = false; });
          log("ended the session; the run stays paused until `autoclaude resume`");
          undoCut();
        }
      } else if (d.action === "exit") {
        log(`${d.reason}; the supervisor is done`);
        break;
      }
      if (d.action !== "halt" && state.haltSession && (state.status !== STATUS.paused || !childAlive)) {
        // Nothing left to end (the session had already exited), or the run was resumed before
        // this poll: clear the request so it cannot end a later session by surprise.
        updateState(root, (s) => { if (s.status !== STATUS.paused || !childAlive) s.haltSession = false; });
        // A session that died in the middle of a verification left its gate's ticks behind.
        if (!childAlive) undoCut();
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
