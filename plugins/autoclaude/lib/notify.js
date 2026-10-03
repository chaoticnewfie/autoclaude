// Notifications: ntfy, a Discord webhook, or stdout plus a log file. Node built-ins only
// (the global fetch). Channel settings come from plugin userConfig, which Claude Code exports
// to hook processes as CLAUDE_PLUGIN_OPTION_<KEY>, or from explicit options (CLI, tests).
import fs from "node:fs";
import path from "node:path";
import { appendLine, readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { machinePaths, projectPaths } from "./paths.js";

export const PRIORITY = Object.freeze({ high: "high", default: "default", low: "low" });

// Informational alerts the owner can switch in notify.events (P8.6, D49). Every other alert
// (blocked, failed, stuck, paused by the gate, plan complete, push failed...) is critical and
// always sent. Defaults live in config.js DEFAULTS.notify.events.
export const SWITCHABLE_EVENTS = Object.freeze(["featureVerified", "stepVerified", "runStarted", "runResumed", "pausedByOwner"]);
const EVENT_DEFAULTS = Object.freeze({ featureVerified: true, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false });
const EVENT_TITLES = Object.freeze({
  featureVerified: "AutoClaude: feature verified",
  stepVerified: "AutoClaude: step verified",
  runStarted: "AutoClaude: run started",
  runResumed: "AutoClaude: run resumed",
  pausedByOwner: "AutoClaude: paused"
});
const NTFY_PRIORITY = { high: "5", default: "3", low: "2" };
const FETCH_TIMEOUT_MS = 10000;

// Per-machine channel file (D32): <claude config dir>/autoclaude/notify.json, written by
// `autoclaude notify-setup` or mirrored from plugin userConfig by the SessionStart hook.
// Keys: channel, ntfy_url, ntfy_token, discord_webhook. Never inside a project.
export function readMachineNotify(file = machinePaths().notifyFile) {
  try {
    const j = readJson(file, null);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export function writeMachineNotify(values, file = machinePaths().notifyFile) {
  const current = readMachineNotify(file);
  const next = { ...current };
  for (const [k, v] of Object.entries(values)) {
    if (v === null || v === "") delete next[k];
    else if (v !== undefined) next[k] = String(v);
  }
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, next);
  try { fs.chmodSync(file, 0o600); } catch {}
  return next;
}

// Precedence: explicit options, then the plugin userConfig environment (hook processes only),
// then the per-machine file (CLI and supervisor).
export function resolveChannel(opts = {}, env = process.env, machineFile = machinePaths().notifyFile) {
  const machine = opts.noMachineFile ? {} : readMachineNotify(machineFile);
  const pick = (key, envKey, fileKey) => {
    if (opts[key] !== undefined && opts[key] !== null) return String(opts[key]).trim();
    if (env[envKey]) return String(env[envKey]).trim();
    return String(machine[fileKey] || "").trim();
  };
  const ntfyUrl = pick("ntfyUrl", "CLAUDE_PLUGIN_OPTION_NTFY_URL", "ntfy_url");
  const ntfyToken = pick("ntfyToken", "CLAUDE_PLUGIN_OPTION_NTFY_TOKEN", "ntfy_token");
  const discordWebhook = pick("discordWebhook", "CLAUDE_PLUGIN_OPTION_DISCORD_WEBHOOK", "discord_webhook");
  // The first source that names a channel wins; an empty or "auto" one passes to the next, so a
  // channel chosen with `notify-setup` is not overruled by a userConfig left on auto.
  let channel = [opts.channel, env.CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL, machine.channel]
    .map((v) => String(v ?? "").trim().toLowerCase())
    .find((v) => v && v !== "auto") || "";
  if (!channel) channel = ntfyUrl ? "ntfy" : discordWebhook ? "discord" : "stdout";
  if (channel === "ntfy" && !ntfyUrl) channel = "stdout";
  if (channel === "discord" && !discordWebhook) channel = "stdout";
  if (!["ntfy", "discord", "stdout"].includes(channel)) channel = "stdout";
  return { channel, ntfyUrl, ntfyToken, discordWebhook };
}

function logLine(logFile, priority, channel, title, message, extra = "") {
  if (!logFile) return;
  const flat = String(message).replace(/\s*\n\s*/g, " | ");
  appendLine(logFile, `${new Date().toISOString()} [${priority}] ${channel} ${title}: ${flat}${extra ? " " + extra : ""}`);
}

async function postWithTimeout(url, init) {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const res = await fetch(url, { ...init, signal });
  // Drain the body so the connection is released before the process winds down.
  try { await res.text(); } catch {}
  return res;
}

// Sends one notification. Never throws: a delivery failure falls back to stdout and is reported
// in the return value. Returns { channel, ok, status, error, fallback }.
export async function notify({ title, message, priority = PRIORITY.default, tags = [] }, opts = {}) {
  const { channel, ntfyUrl, ntfyToken, discordWebhook } = resolveChannel(opts, opts.env || process.env, opts.machineFile);
  const stdout = opts.stdout || process.stdout;
  const logFile = opts.logFile || null;
  const text = String(message || "");
  const head = String(title || "AutoClaude");

  const toStdout = (note) => {
    stdout.write(`[autoclaude ${priority}] ${head}\n${text}\n${note ? note + "\n" : ""}`);
  };

  try {
    if (channel === "ntfy") {
      const headers = { Title: head, Priority: NTFY_PRIORITY[priority] || NTFY_PRIORITY.default, "Content-Type": "text/plain; charset=utf-8" };
      if (tags.length) headers.Tags = tags.join(",");
      if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;
      const res = await postWithTimeout(ntfyUrl, { method: "POST", headers, body: text });
      if (!res.ok) throw new Error(`ntfy responded ${res.status}`);
      logLine(logFile, priority, channel, head, text, `-> ${res.status}`);
      return { channel, ok: true, status: res.status, error: null, fallback: false };
    }
    if (channel === "discord") {
      let content = `**${head}**\n${text}`;
      if (content.length > 1990) content = content.slice(0, 1985) + " [...]";
      const res = await postWithTimeout(discordWebhook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
      if (!res.ok) throw new Error(`discord responded ${res.status}`);
      logLine(logFile, priority, channel, head, text, `-> ${res.status}`);
      return { channel, ok: true, status: res.status, error: null, fallback: false };
    }
    toStdout(null);
    logLine(logFile, priority, channel, head, text);
    return { channel, ok: true, status: null, error: null, fallback: false };
  } catch (e) {
    const error = e && e.name === "TimeoutError" ? `timed out after ${FETCH_TIMEOUT_MS} ms` : String(e && e.message ? e.message : e);
    toStdout(`(delivery through ${channel} failed: ${error})`);
    logLine(logFile, priority, channel, head, text, `FAILED: ${error}`);
    return { channel, ok: false, status: null, error, fallback: true };
  }
}

// True for every critical event (anything not in SWITCHABLE_EVENTS); for a switchable one, the
// project's notify.events value, or the built-in default when the config does not say.
export function eventEnabled(config, event) {
  if (!SWITCHABLE_EVENTS.includes(event)) return true;
  const v = config && config.notify && config.notify.events ? config.notify.events[event] : undefined;
  return typeof v === "boolean" ? v : EVENT_DEFAULTS[event];
}

// ---------- the sweep-finished alert (PLAN.md P10.1, D58) ----------

// Always sent: it is not in SWITCHABLE_EVENTS, so eventEnabled() is true for it.
export const SWEEP_FINISHED_EVENT = "sweepFinished";
export const SWEEP_SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);
const SWEEP_PLAN_FILES = Object.freeze({ security: "SECURITY_PLAN.md", optimize: "OPTIMIZE_PLAN.md" });

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const count = (v) => (Array.isArray(v) ? v.length : Number.isFinite(Number(v)) && Number(v) > 0 ? Math.floor(Number(v)) : 0);

// { critical, high, medium, low } from either such an object or a list of findings (counted by
// their severity field; anything else is ignored).
export function severityCounts(input) {
  const out = { critical: 0, high: 0, medium: 0, low: 0 };
  if (Array.isArray(input)) {
    for (const f of input) if (f && SWEEP_SEVERITIES.includes(f.severity)) out[f.severity]++;
  } else if (input && typeof input === "object") {
    for (const s of SWEEP_SEVERITIES) out[s] = count(input[s]);
  }
  return out;
}

function durationText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h${min % 60 ? ` ${min % 60} min` : ""}`;
}

// Project-relative with forward slashes, the way the run's other alerts name files.
function shownPath(root, file) {
  if (!file) return null;
  const s = String(file);
  if (!root || !path.isAbsolute(s)) return s.split(path.sep).join("/");
  const rel = path.relative(root, s);
  const outside = !rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
  return outside ? s : rel.split(path.sep).join("/");
}

// The title and message of the alert a sweep sends when it ends. Counts, the report's path and
// what happens next only: never a finding's text, file, evidence or an error message, because an
// alert channel (an ntfy topic) may be readable by others. fixRefused is the one free text, and
// the engine's reasons name a state (a paused run, a dirty tree, a red check), never a finding.
// info: { kind: "security" | "optimize", project, root (to show paths relative to it),
//   status: "done" (default) | "failed", counts (confirmed: { critical, high, medium, low } or the
//   confirmed findings), uncertain, refuted, accepted (numbers or lists), reportFile,
//   after: "report" | "plan" | "fix", planFile (the generated plan), fixRefused (the engine's
//   reason when "fix" could not start the run), durationMs, cli }
// Returns { title, message, priority, tags }.
export function sweepFinishedAlert(info = {}) {
  const kind = info.kind === "optimize" ? "optimize" : "security";
  const project = String(info.project || (info.root ? path.basename(info.root) : "") || "this project");
  const cli = info.cli || "autoclaude";
  const failed = info.status === "failed";
  const c = severityCounts(info.counts);
  const confirmed = SWEEP_SEVERITIES.reduce((n, s) => n + c[s], 0);
  const report = shownPath(info.root, info.reportFile);
  const plan = shownPath(info.root, info.planFile) || SWEEP_PLAN_FILES[kind];
  const took = durationText(info.durationMs);
  const lines = [];

  if (failed) {
    lines.push(`The ${kind} sweep stopped before it finished${took ? `, after ${took}` : ""}.`);
    lines.push(`${report ? `What it found so far: ${report}. ` : ""}Its state and log are in the sweep folder under .autoclaude/sweeps/. \`${cli} status\` shows where it stopped.`);
  } else {
    lines.push(`The ${kind} sweep finished${took ? ` in ${took}` : ""}.`);
    lines.push(confirmed
      ? `Confirmed: ${plural(confirmed, "finding")} (${SWEEP_SEVERITIES.map((s) => `${c[s]} ${s}`).join(", ")}).`
      : "Confirmed: no findings.");
    const other = [];
    if (count(info.uncertain)) other.push(`${count(info.uncertain)} uncertain (never fixed automatically)`);
    if (count(info.refuted)) other.push(`${count(info.refuted)} disproved`);
    if (count(info.accepted)) other.push(`${count(info.accepted)} accepted earlier`);
    if (other.length) lines.push(`Also: ${other.join(", ")}.`);
    if (report) lines.push(`Report: ${report} (not committed).`);
    if (info.after === "fix" && confirmed && info.fixRefused) {
      // The engine's own reason (a run is paused, the tree is dirty, a check is red), one line.
      const why = String(info.fixRefused).replace(/\s+/g, " ").trim().slice(0, 160);
      lines.push(`Next: the fix run did not start (${why}). Review ${plan}, then \`${cli} run --plan ${plan}\`.`);
    } else if (info.after === "fix") {
      lines.push(confirmed
        ? `Next: the fix run starts on its own branch in a new window, working through ${plan}; its own alerts follow.`
        : "Next: nothing to fix, so no fix run starts.");
    } else if (info.after === "plan") {
      lines.push(confirmed
        ? `Next: review ${plan}, then \`${cli} run --plan ${plan}\` to fix the findings.`
        : "Next: nothing to fix, so no plan was written.");
    } else {
      lines.push("Next: read the report. Nothing in the project was changed.");
    }
  }
  const urgent = failed || (kind === "security" && c.critical + c.high > 0);
  return {
    title: `AutoClaude: ${kind} sweep ${failed ? "stopped" : "finished"} (${project})`,
    message: lines.join("\n"),
    priority: urgent ? PRIORITY.high : PRIORITY.default,
    tags: [failed ? "warning" : kind === "security" ? "lock" : "white_check_mark"]
  };
}

// Sends the sweep-finished alert through notifyEvent (always on; logged in the project). Never
// throws. opts as for notifyEvent.
export async function notifySweepFinished(root, config, info = {}, opts = {}) {
  return notifyEvent(root, config, SWEEP_FINISHED_EVENT, sweepFinishedAlert({ root, ...info }), opts);
}

// Sends one alert for a named event when the owner wants it, and otherwise only logs that it was
// skipped. message is a string (the event's own title is used) or { title, message, priority,
// tags }. opts go to notify(); opts.notify replaces the sender (tests, the gate's own notifier).
// Logs to <root>/.autoclaude/logs/notify.log unless opts.logFile says otherwise. Never throws.
// Returns notify()'s result plus { event, sent, skipped }.
export async function notifyEvent(root, config, event, message, opts = {}) {
  const { notify: sender, ...rest } = opts || {};
  const logFile = rest.logFile || (root ? path.join(projectPaths(root).logsDir, "notify.log") : path.join(machinePaths().logsDir, "notify.log"));
  const msg = typeof message === "string" || message === undefined || message === null
    ? { title: EVENT_TITLES[event] || "AutoClaude", message: String(message ?? "") }
    : { title: EVENT_TITLES[event] || "AutoClaude", ...message };
  if (!eventEnabled(config, event)) {
    try { appendLine(logFile, `${new Date().toISOString()} [${msg.priority || PRIORITY.default}] skipped: event ${event} is off (${msg.title})`); } catch {}
    return { event, sent: false, skipped: true, channel: null, ok: true, status: null, error: null, fallback: false };
  }
  try {
    const r = await (typeof sender === "function" ? sender : notify)(msg, { ...rest, logFile });
    return { event, sent: true, skipped: false, ...(r && typeof r === "object" ? r : {}) };
  } catch (e) {
    // An injected sender may throw; an alert must never break the gate or the CLI.
    const error = String(e && e.message ? e.message : e);
    try { appendLine(logFile, `${new Date().toISOString()} [${msg.priority || PRIORITY.default}] event ${event} FAILED: ${error}`); } catch {}
    return { event, sent: false, skipped: false, channel: null, ok: false, status: null, error, fallback: false };
  }
}
