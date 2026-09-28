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
