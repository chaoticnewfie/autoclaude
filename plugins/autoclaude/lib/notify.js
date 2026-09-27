// Notifications: ntfy, a Discord webhook, or stdout plus a log file. Node built-ins only
// (the global fetch). Channel settings come from plugin userConfig, which Claude Code exports
// to hook processes as CLAUDE_PLUGIN_OPTION_<KEY>, or from explicit options (CLI, tests).
import { appendLine } from "./fsatomic.js";

export const PRIORITY = Object.freeze({ high: "high", default: "default", low: "low" });
const NTFY_PRIORITY = { high: "5", default: "3", low: "2" };
const FETCH_TIMEOUT_MS = 10000;

export function resolveChannel(opts = {}, env = process.env) {
  const pick = (key, envKey) => (opts[key] !== undefined && opts[key] !== null ? String(opts[key]) : env[envKey] || "").trim();
  const ntfyUrl = pick("ntfyUrl", "CLAUDE_PLUGIN_OPTION_NTFY_URL");
  const ntfyToken = pick("ntfyToken", "CLAUDE_PLUGIN_OPTION_NTFY_TOKEN");
  const discordWebhook = pick("discordWebhook", "CLAUDE_PLUGIN_OPTION_DISCORD_WEBHOOK");
  let channel = pick("channel", "CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL").toLowerCase();
  if (!channel || channel === "auto") channel = ntfyUrl ? "ntfy" : discordWebhook ? "discord" : "stdout";
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
  return fetch(url, { ...init, signal });
}

// Sends one notification. Never throws: a delivery failure falls back to stdout and is reported
// in the return value. Returns { channel, ok, status, error, fallback }.
export async function notify({ title, message, priority = PRIORITY.default, tags = [] }, opts = {}) {
  const { channel, ntfyUrl, ntfyToken, discordWebhook } = resolveChannel(opts);
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
