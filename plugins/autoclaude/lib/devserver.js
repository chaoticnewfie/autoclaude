// The project's dev server, for the gate (PLAN.md P3.3): health-check the URL, start the
// configured command detached when nothing answers, log it to .autoclaude/logs/devserver.log,
// reuse a server that is already up, and stop only what we started. Node built-ins only.
// Windows facts (checked 2026-09-26): a child spawned without `detached` lands in libuv's
// kill-on-close job object and dies with its parent, so the server is detached on every OS.
// A detached cmd.exe has no console, and Windows then gives its external child a fresh
// console whose handles replace the inherited log handle (even with a cmd-side redirect),
// so on Windows a detached node wrapper runs cmd.exe non-detached with the log descriptor;
// the wrapper's pid is the one recorded and killed. /bin/sh needs none of that.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { ensureDir, readJson, readText, writeJsonAtomic, removeIfExists, appendLine } from "./fsatomic.js";
import { projectPaths, isWindows } from "./paths.js";
import { killTree } from "./proc.js";

const POLL_MS = 500;
const TAIL_LINES = 40;

// Runs as `node -e WRAPPER -- <logFile> <command>` on Windows. Plain ASCII, no shell involved.
const WRAPPER = `
const fs = require("node:fs");
const { spawn } = require("node:child_process");
const [log, command] = process.argv.slice(1);
const out = fs.openSync(log, "a");
const child = spawn("cmd.exe", ["/d", "/s", "/c", '"' + command + '"'], { windowsVerbatimArguments: true, windowsHide: true, stdio: ["ignore", out, out] });
child.on("exit", (code) => process.exit(code === null ? 1 : code));
`;

export function devServerFiles(root) {
  const p = projectPaths(root);
  return { infoFile: path.join(p.runtimeDir, "devserver.json"), logFile: path.join(p.logsDir, "devserver.log") };
}

// url + healthPath with exactly one slash between them.
export function healthUrl(url, healthPath = "/") {
  const base = String(url).replace(/\/+$/, "");
  const p = String(healthPath || "/");
  return base + (p.startsWith("/") ? p : "/" + p);
}

// True for any answer below 500 (a 404 on the health path still means the server is up).
// False on a network error or when nothing answers within timeoutMs. Never rejects.
export async function isHealthy(url, { timeoutMs = 2000 } = {}) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    await res.arrayBuffer().catch(() => {});
    return res.status < 500;
  } catch {
    return false;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function tail(file, lines = TAIL_LINES) {
  let text;
  try {
    text = readText(file, "");
  } catch {
    return [];
  }
  const all = text.split(/\r?\n/);
  if (all.length && all[all.length - 1] === "") all.pop();
  return all.slice(-lines);
}

// Same shell as runCommand (cmd.exe /d /s /c on Windows, /bin/sh -c elsewhere), detached,
// with stdout and stderr appended to logFile.
function spawnDetached(command, { cwd, env, logFile }) {
  let child;
  if (isWindows) {
    child = spawn(process.execPath, ["-e", WRAPPER, "--", logFile, command], { cwd, env, detached: true, windowsHide: true, stdio: "ignore" });
  } else {
    const out = fs.openSync(logFile, "a");
    try {
      child = spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["ignore", out, out] });
    } finally {
      fs.closeSync(out);
    }
  }
  child.unref();
  return child;
}

// devServer is the config object { command, url, healthPath, startTimeoutSec }. Resolves to
// { ok: true, skipped: true } when nothing is configured, { ok: true, reused: true, url } when
// the URL already answers, { ok: true, reused: false, pid, url } after a start, or
// { ok: false, error, logTail } when the command never answered or could not be started.
export async function ensureDevServer(devServer, { root, env = process.env, log = null }) {
  const { command = null, url = null, healthPath = "/", startTimeoutSec = 90 } = devServer || {};
  if (!command || !url) return { ok: true, skipped: true };
  const say = (line) => { if (log) log(line); };
  const check = healthUrl(url, healthPath);
  let logFile = null;
  try {
    if (await isHealthy(check)) {
      say(`dev server already answering at ${check}, reusing it`);
      return { ok: true, reused: true, url };
    }
    ({ logFile } = devServerFiles(root));
    return await startDevServer({ root, env, command, url, check, startTimeoutSec, say });
  } catch (e) {
    const error = `could not start dev server: ${e.message}`;
    say(error);
    return { ok: false, error, logTail: logFile ? tail(logFile) : [] };
  }
}

async function startDevServer({ root, env, command, url, check, startTimeoutSec, say }) {
  const { infoFile, logFile } = devServerFiles(root);
  ensureDir(path.dirname(logFile));
  appendLine(logFile, `\n[${new Date().toISOString()}] autoclaude: starting ${command}`);
  const child = spawnDetached(command, { cwd: root, env, logFile });
  let spawnError = null;
  child.on("error", (e) => { spawnError = e; });
  const pid = child.pid;
  say(`started dev server (pid ${pid}) in ${root}: ${command}`);
  writeJsonAtomic(infoFile, { pid, url, command, startedAt: new Date().toISOString(), startedByUs: true });
  const deadline = Date.now() + startTimeoutSec * 1000;
  for (;;) {
    if (await isHealthy(check)) {
      say(`dev server answering at ${check}`);
      return { ok: true, reused: false, pid, url };
    }
    if (spawnError || Date.now() >= deadline) break;
    await sleep(POLL_MS);
  }
  killTree(pid);
  removeIfExists(infoFile);
  const error = spawnError
    ? `could not start dev server: ${spawnError.message}`
    : `dev server did not answer at ${check} within ${startTimeoutSec} s`;
  say(error);
  return { ok: false, error, pid, logTail: tail(logFile) };
}

// Waits until nothing answers at url (after a kill the port can take a moment to free up).
async function waitUntilDown(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await isHealthy(url, { timeoutMs: 1000 }))) return true;
    await sleep(POLL_MS);
  }
  return false;
}

// Before every verification (PLAN.md P4.3): a server the gate started is stopped and started
// again, so the checks and the browser tester see the code as it is now; a plain `node server.js`
// does not reload on its own. A server someone else started is reused (reported as reused).
// Same result shape as ensureDevServer, plus `restarted`.
export async function restartDevServer(devServer, opts) {
  const { root } = opts;
  const stopped = stopDevServer({ root });
  if (stopped.stopped && devServer && devServer.url) {
    await waitUntilDown(healthUrl(devServer.url, devServer.healthPath));
  }
  const r = await ensureDevServer(devServer, opts);
  return { ...r, restarted: stopped.stopped };
}

// Ends the server we started, if any, and forgets it. A server we merely reused is left alone.
export function stopDevServer({ root }) {
  const info = devServerInfo({ root });
  if (!info || !info.startedByUs) return { stopped: false, pid: info && info.pid ? info.pid : null };
  killTree(info.pid);
  removeIfExists(devServerFiles(root).infoFile);
  return { stopped: true, pid: info.pid };
}

// The recorded { pid, url, command, startedAt, startedByUs }, or null.
export function devServerInfo({ root }) {
  try {
    return readJson(devServerFiles(root).infoFile, null);
  } catch {
    return null;
  }
}
