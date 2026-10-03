// Backstop watchdog: a scheduled task that relaunches a dead supervisor. PLAN.md P6.4, D18.
// Node built-ins only.
//
// Every 5 minutes the OS scheduler runs `node <bin>/autoclaude-launch.mjs watchdog`; the launcher
// finds the current plugin install and runs its CLI (D42). One pass looks
// at every project in the machine registry whose run state is "running" and opens a new supervisor
// window when the recorded supervisor process is gone (killed, crashed, or the user logged off and
// back on). A healthy run is never touched, and a pass never throws. The same pass brings back a
// project's sweeps (P10.1): one whose window died while it was running or waiting, and one paused
// at the weekly limit once that window has reset, when the project allows it.
//
// Scheduling, per platform:
// - Windows: a Task Scheduler entry made with schtasks, every 5 minutes, only while the user is
//   logged on (/IT), because the supervisor is a visible console window on that user's desktop.
//   The task runs wscript.exe on a small VBScript that starts node with its window hidden, so
//   nothing flashes on screen every 5 minutes.
// - Linux: a systemd user service and timer from templates/watchdog/.
// - No systemctl (macOS, minimal Linux): a crontab line the user adds by hand.
// Every system-changing call goes through an injectable run(program, args) so tests can fake it.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { openConsoleWindow, isPidAlive, findOnPath } from "./proc.js";
import { binDir, homeDir, machinePaths, projectPaths, pluginRoot } from "./paths.js";
import { loadRegistry } from "./registry.js";
import { installLauncher } from "./launcher.js";
import { loadState, STATUS } from "./state.js";
import { loadConfig } from "./config.js";
import { readUsage } from "./usage.js";
import { readText, readJson, writeJsonAtomic, writeFileAtomic, appendLine, ensureDir, removeIfExists } from "./fsatomic.js";

export const TASK_NAME = "AutoClaude watchdog";
export const VBS_NAME = "autoclaude-watchdog.vbs";
export const SERVICE_NAME = "autoclaude-watchdog.service";
export const TIMER_NAME = "autoclaude-watchdog.timer";
// schtasks rejects a /TR value of 261 characters or more.
export const MAX_TR_LENGTH = 260;
// A "running" state untouched for this long is a leftover, not a crash to recover from.
export const STALE_RUN_MS = 24 * 60 * 60 * 1000;
// The machine log gets a line per project every 5 minutes; keep one old file past this size.
const LOG_MAX_BYTES = 1024 * 1024;
// schtasks says one of these when the task is not there ("cannot find the file specified" on
// Windows Server 2025, "does not exist in the system" on some other builds).
const TASK_NOT_FOUND = /cannot find|does not exist/i;

export function cliPath() {
  return path.join(pluginRoot(), "bin", "autoclaude.js");
}

export function templatesDir() {
  return path.join(pluginRoot(), "templates", "watchdog");
}

// "C:\Code\My App" -> "my-app". The supervisor window (or tmux session) is titled ac-<slug>, and
// `autoclaude run` and the supervisor build that title the same way, so the names must match.
export function projectSlug(root) {
  return path.basename(path.resolve(String(root))).toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

function positivePid(v) {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// The number in .autoclaude/supervisor.pid, else state.supervisorPid, else null.
export function supervisorPid(root) {
  let fromFile = null;
  try {
    fromFile = positivePid(readText(projectPaths(root).supervisorPidFile, null));
  } catch {}
  if (fromFile) return fromFile;
  try {
    return positivePid(loadState(root).supervisorPid);
  } catch {
    return null;
  }
}

// Opens the supervisor console window for one project. Returns what `open` returns.
export function launchSupervisor({ root, env = process.env, open = openConsoleWindow } = {}) {
  const p = projectPaths(root);
  ensureDir(p.logsDir);
  return open({
    title: `ac-${projectSlug(root)}`,
    cwd: root,
    program: process.execPath,
    args: [cliPath(), "supervise"],
    logFile: path.join(p.logsDir, "supervisor.log"),
    env
  });
}

// <project>/.autoclaude/watchdog.json: { lastLaunchAt, pid, method, previousPid }
export function watchdogFile(root) {
  return path.join(projectPaths(root).runtimeDir, "watchdog.json");
}

function lastLaunchMs(file) {
  let j = null;
  try {
    j = readJson(file, null);
  } catch {
    return null;
  }
  const v = j && j.lastLaunchAt;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

function isDirectory(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function message(e) {
  return String((e && e.message) || e || "unknown error").replace(/\s+/g, " ").trim();
}

function logTo(file, line) {
  try {
    try {
      if (fs.statSync(file).size > LOG_MAX_BYTES) fs.renameSync(file, `${file}.1`);
    } catch {}
    appendLine(file, line);
  } catch {}
}

async function checkProject(entry, { env, nowMs, isAlive, launch, minRelaunchGapMs }) {
  const raw = typeof entry === "string" ? entry : entry && entry.root;
  if (!raw) return { root: null, action: "missing", pid: null };
  const root = path.resolve(String(raw));
  try {
    if (!isDirectory(root)) return { root, action: "missing", pid: null };
    const state = loadState(root);
    if (state.status !== STATUS.running) return { root, action: "not-running", pid: null };
    const pid = supervisorPid(root);
    if (pid && isAlive(pid)) return { root, action: "alive", pid };
    // Only bring back a run that was really under supervision recently. A "running" state that
    // never had a supervisor, or has not changed for a day, is a leftover, not a crash (seen live:
    // the first pass revived a scratch project last touched hours earlier and burned a session on
    // it). The owner restarts such a run with `autoclaude run`.
    const updated = state.updatedAt ? Date.parse(state.updatedAt) : NaN;
    if (!pid || !Number.isFinite(updated) || nowMs - updated > STALE_RUN_MS) {
      return { root, action: "stale", pid };
    }
    const file = watchdogFile(root);
    const last = lastLaunchMs(file);
    if (last !== null && nowMs - last >= 0 && nowMs - last < minRelaunchGapMs) {
      return { root, action: "too-soon", pid, lastLaunchAt: new Date(last).toISOString() };
    }
    let opened;
    try {
      opened = await launch({ root, env });
    } catch (e) {
      return { root, action: "launch-failed", pid, error: message(e) };
    }
    // openConsoleWindow's tmux path reports a failed start as ok: false instead of throwing.
    if (opened && opened.ok === false) return { root, action: "launch-failed", pid, error: message(opened.stderr || "the launcher reported a failure") };
    try {
      writeJsonAtomic(file, { lastLaunchAt: new Date(nowMs).toISOString(), pid: positivePid(opened && opened.pid), method: (opened && opened.method) || null, previousPid: pid });
    } catch {}
    return { root, action: "launched", pid, opened: opened || null };
  } catch (e) {
    return { root, action: "error", pid: null, error: message(e) };
  }
}

// ---- Sweeps (P10.1) ----

// Opens the ac-sweep-<slug> window for one sweep, running `autoclaude sweep-run --auto <id>`, which
// picks the sweep up where it stopped. --auto: a sweep the owner stopped (`autoclaude sweep-stop`)
// in the meantime is left alone. Returns what `open` returns.
export function launchSweep({ root, id, env = process.env, open = openConsoleWindow, logFile = null } = {}) {
  const dir = path.join(projectPaths(root).runtimeDir, "sweeps", id);
  ensureDir(dir);
  return open({
    title: `ac-sweep-${projectSlug(root)}`,
    cwd: root,
    program: process.execPath,
    args: [cliPath(), "sweep-run", "--auto", id],
    logFile: logFile || path.join(dir, "sweep.log"),
    env
  });
}

// <project>/.autoclaude/watchdog-sweeps.json: { <id>: { lastLaunchAt, reason, method, pid,
// previousPid, weeklyKey } }, the sweep windows this watchdog opened.
export function sweepWatchdogFile(root) {
  return path.join(projectPaths(root).runtimeDir, "watchdog-sweeps.json");
}

function toMs(v) {
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

// A sweep the engine paused at the weekly usage limit.
export function isWeeklyPause(s) {
  return !!s && s.status === "paused" && (s.pauseReason === "weekly-limit" || s.pauseReason === "weekly" || s.weekly === true || /weekly usage limit/i.test(String(s.error || s.reason || "")));
}

// When the weekly window that paused the sweep resets, as far as anything says: the reset the
// sweep recorded, else the usage reading's own reset when it lies in the past, else a reading
// taken after the pause that is under the threshold (the window reset and a session refreshed it).
// Returns { passed, key } with key naming that reset, so one reset resumes a sweep once only.
export function weeklyResetPassed(s, usage, { nowMs, graceMs, pauseAtPct }) {
  const recorded = toMs(s && s.weeklyResetsAt);
  if (recorded !== null) return { passed: nowMs > recorded + graceMs, key: `recorded:${recorded}` };
  const seven = usage && usage.sevenDay;
  if (!seven) return { passed: false, key: null };
  const reset = toMs(seven.resetsAt);
  if (reset !== null && nowMs > reset + graceMs) return { passed: true, key: `reading:${reset}` };
  const pausedAt = toMs(s && (s.pausedAt || s.updatedAt));
  const fetched = toMs(usage.fetchedAt);
  if (typeof seven.pct === "number" && seven.pct < pauseAtPct && fetched !== null && pausedAt !== null && fetched > pausedAt) return { passed: true, key: `fresh:${fetched}` };
  return { passed: false, key: null };
}

// True when the sweep's own record says the owner stopped it (`autoclaude sweep-stop`).
function ownerStopped(root, id) {
  try { const s = readJson(path.join(projectPaths(root).runtimeDir, "sweeps", id, "sweep.json"), null); return !!s && s.status === "stopped"; } catch { return false; }
}

async function lazy(spec, name) {
  try { const m = await import(spec); return typeof m[name] === "function" ? m[name] : null; } catch { return null; }
}

// The sweeps of one project that the watchdog brings back: a sweep whose driver is gone while it
// was running or waiting (findDeadSweeps, from the sweep engine) is opened again, unless it has
// shown no sign of life for a day; a sweep paused at the weekly limit is resumed once the weekly
// window has reset, and only when the project's usage.autoResumeAfterWeeklyReset is on. A sweep
// the owner stopped (status "stopped", `autoclaude sweep-stop`) is never brought back, whatever a
// lookup returns. Throttled like a supervisor. Results: { root, sweep, action, pid } with action
// sweep-launched, sweep-resumed, sweep-too-soon, sweep-stale, sweep-paused-weekly, sweep-stopped,
// sweep-launch-failed or sweep-error. Never throws.
async function checkSweeps(root, { env, nowMs, isAlive, minRelaunchGapMs, sweeps }) {
  const out = [];
  try {
    const findDead = sweeps.findDeadSweeps || (await lazy("./sweep.js", "findDeadSweeps"));
    const findActive = sweeps.findActiveSweeps || (await lazy("./sweep.js", "findActiveSweeps"));
    const launch = sweeps.launchSweep || launchSweep;
    const file = sweepWatchdogFile(root);
    let record = {};
    try { record = readJson(file, {}) || {}; } catch { record = {}; }
    const open = async (s, action, extra = {}) => {
      // Read afresh just before opening: the owner may have stopped it since the lookup.
      if (s.status === "stopped" || ownerStopped(root, s.id)) return { root, sweep: s.id, action: "sweep-stopped", pid: s.pid || null };
      const last = record[s.id] ? toMs(record[s.id].lastLaunchAt) : null;
      if (last !== null && nowMs - last >= 0 && nowMs - last < minRelaunchGapMs) return { root, sweep: s.id, action: "sweep-too-soon", pid: s.pid || null, lastLaunchAt: new Date(last).toISOString() };
      let opened;
      try { opened = await launch({ root, id: s.id, env }); } catch (e) { return { root, sweep: s.id, action: "sweep-launch-failed", pid: s.pid || null, error: message(e) }; }
      if (opened && opened.ok === false) return { root, sweep: s.id, action: "sweep-launch-failed", pid: s.pid || null, error: message(opened.stderr || "the launcher reported a failure") };
      record[s.id] = { lastLaunchAt: new Date(nowMs).toISOString(), reason: action, method: (opened && opened.method) || null, pid: positivePid(opened && opened.pid), previousPid: s.pid || null, ...extra };
      try { writeJsonAtomic(file, record); } catch {}
      return { root, sweep: s.id, action, pid: s.pid || null, opened: opened || null };
    };
    const dead = findDead ? ((await findDead(root, { isAlive, now: nowMs })) || []) : [];
    for (const s of dead) {
      if (!s || typeof s.id !== "string" || !["running", "waiting"].includes(s.status)) continue;
      const seen = toMs(s.heartbeatAt) ?? toMs(s.updatedAt) ?? toMs(s.startedAt);
      if (seen === null || nowMs - seen > STALE_RUN_MS) { out.push({ root, sweep: s.id, action: "sweep-stale", pid: s.pid || null }); continue; }
      out.push(await open(s, "sweep-launched"));
    }
    const paused = findActive ? ((await findActive(root)) || []).filter(isWeeklyPause) : [];
    if (paused.length) {
      let cfg = null;
      try { cfg = loadConfig(root).config; } catch { cfg = null; }
      if (cfg && cfg.usage && cfg.usage.autoResumeAfterWeeklyReset) {
        const read = sweeps.readUsage || readUsage;
        let usage = null;
        try { usage = read({ staleAfterMin: 7 * 24 * 60, now: nowMs }); } catch { usage = null; }
        const graceMs = ((cfg.supervisor && cfg.supervisor.rateLimitGraceMin) || 10) * 60 * 1000;
        for (const s of paused) {
          if (typeof s.id !== "string") continue;
          if (s.pid && isAlive(s.pid)) continue;
          const w = weeklyResetPassed(s, usage, { nowMs, graceMs, pauseAtPct: cfg.usage.weeklyPauseAtPct });
          const tried = record[s.id] && record[s.id].weeklyKey;
          if (!w.passed || (w.key && tried === w.key)) { out.push({ root, sweep: s.id, action: "sweep-paused-weekly", pid: s.pid || null }); continue; }
          out.push(await open(s, "sweep-resumed", { weeklyKey: w.key }));
        }
      }
    }
  } catch (e) {
    out.push({ root, sweep: null, action: "sweep-error", pid: null, error: message(e) });
  }
  return out;
}

// One watchdog pass. `registry` is { projects: [...] } or a plain array of entries ({ root } or a
// path string). Each result is { root, action, pid } where pid is the recorded supervisor pid
// (null when none); "launched" results also carry `opened` (what launch returned), "too-soon"
// results carry `lastLaunchAt`, "launch-failed" and "error" results carry `error`. A project's
// sweeps that need the watchdog add results with `sweep` (the id) and a sweep-* action; `sweeps`
// replaces the sweep engine's lookups, the sweep launcher and the usage reader in tests.
export async function watchdogPass({
  registry = loadRegistry(),
  env = process.env,
  now = Date.now(),
  isAlive = isPidAlive,
  launch = launchSupervisor,
  minRelaunchGapMs = 4 * 60 * 1000,
  logFile = null,
  sweeps = {}
} = {}) {
  const results = [];
  try {
    const nowMs = now instanceof Date ? now.getTime() : Number(now);
    const at = new Date(nowMs).toISOString();
    const machineLog = logFile || path.join(machinePaths().logsDir, "watchdog.log");
    const entries = Array.isArray(registry) ? registry : registry && Array.isArray(registry.projects) ? registry.projects : [];
    const log = (r) => {
      const via = r.opened && r.opened.method ? ` via=${r.opened.method}` : "";
      const line = `${at} ${r.action} ${r.root || "(no root in registry entry)"}${r.sweep ? ` sweep=${r.sweep}` : ""}${r.pid ? ` pid=${r.pid}` : ""}${via}${r.error ? ` error=${r.error}` : ""}`;
      logTo(machineLog, line);
      if (["launched", "launch-failed", "sweep-launched", "sweep-resumed", "sweep-launch-failed"].includes(r.action) && r.root) logTo(path.join(projectPaths(r.root).logsDir, "watchdog.log"), line);
    };
    for (const entry of entries) {
      const r = await checkProject(entry, { env, nowMs, isAlive, launch, minRelaunchGapMs });
      results.push(r);
      log(r);
      if (r.root && r.action !== "missing" && isDirectory(r.root)) {
        for (const s of await checkSweeps(r.root, { env, nowMs, isAlive, minRelaunchGapMs, sweeps })) {
          results.push(s);
          log(s);
        }
      }
    }
  } catch {}
  return results;
}

// ---- Installing the schedule ----

// Runs a program with an argument array, no shell. Returns { code, stdout, stderr }; code is -1
// when the program could not be started or was killed.
export function defaultRunner(program, args = []) {
  const r = spawnSync(program, args, { encoding: "utf8", windowsHide: true, timeout: 60000 });
  const stderr = String(r.stderr || "") + (r.error ? `${r.stderr ? "\n" : ""}${r.error.message}` : "");
  return { code: typeof r.status === "number" ? r.status : -1, stdout: String(r.stdout || ""), stderr };
}

function str(v) {
  return v === undefined || v === null ? "" : String(v);
}

function displayCommand(program, args) {
  return [program, ...args].map((a) => (/[\s"]/.test(a) || a === "" ? `"${a.replace(/"/g, '\\"')}"` : a)).join(" ");
}

// A VBScript string literal: wrapped in quotes, every inner quote doubled.
export function vbsString(s) {
  return `"${String(s).replace(/"/g, '""')}"`;
}

// Starts one watchdog pass with the window hidden (style 0) and without waiting (False).
export function buildWatchdogVbs({ node, cli }) {
  const command = `"${node}" "${cli}" watchdog`;
  return [
    "' AutoClaude backstop watchdog. Written by autoclaude watchdog --install, removed by --uninstall.",
    "' Task Scheduler runs this through wscript.exe every 5 minutes. It starts one watchdog pass",
    "' with its window hidden (style 0) and does not wait for it (False), so nothing flashes on screen.",
    'Set shell = CreateObject("WScript.Shell")',
    `shell.Run ${vbsString(command)}, 0, False`,
    ""
  ].join("\r\n");
}

// The /TR value of the scheduled task.
export function taskCommand(vbsFile) {
  return `wscript.exe //B //Nologo "${vbsFile}"`;
}

// wscript reads a script as ANSI unless it starts with a UTF-16 LE byte order mark, so a path with
// non-ASCII characters (a user name like "Jose" with an accent) is written as UTF-16 LE.
function encodeForWsh(text) {
  return /^[\x00-\x7f]*$/.test(text) ? text : Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, "utf16le")]);
}

function systemdUserDir(env) {
  const config = env.XDG_CONFIG_HOME || path.join(env.HOME || homeDir(), ".config");
  return path.join(config, "systemd", "user");
}

const SAFE_ARG = /^[A-Za-z0-9_@%+=:,./-]+$/;

// One ExecStart= word: % and $ escaped, double-quoted when it holds anything unusual.
function systemdWord(s) {
  const t = String(s).replace(/%/g, "%%").replace(/\$/g, "$$$$");
  return SAFE_ARG.test(t) ? t : `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

// The inside of Environment="PATH=...": backslash, quote and % escaped.
function systemdQuoted(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%");
}

// One word of a crontab command: single-quoted for /bin/sh when needed; cron turns a bare % into a
// newline, so % is escaped as \%.
function cronWord(s) {
  const t = String(s);
  const quoted = SAFE_ARG.test(t) ? t : `'${t.replace(/'/g, "'\\''")}'`;
  return quoted.replace(/%/g, "\\%");
}

function fill(template, values) {
  return template.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in values ? values[k] : m));
}

function pathValue(env) {
  return env.PATH || env.Path || "/usr/local/bin:/usr/bin:/bin";
}

export function cronLineFor({ node, cli, env = process.env, templates = templatesDir() }) {
  const text = fs.readFileSync(path.join(templates, "crontab.txt"), "utf8");
  const line = text.split(/\r?\n/).find((l) => l.trim() && !l.trim().startsWith("#")) || "";
  return fill(line.trim(), { PATH: cronWord(pathValue(env)), NODE: cronWord(node), CLI: cronWord(cli) });
}

function installSystemd({ run, env, node, cli, unitDir, which, templates }) {
  const cronLine = cronLineFor({ node, cli, env, templates });
  if (!which("systemctl", env)) {
    return { ok: false, file: null, files: [], command: "crontab -e", stdout: "", stderr: `systemctl was not found on PATH. Add this line with crontab -e:\n${cronLine}`, cronLine };
  }
  const dir = unitDir || systemdUserDir(env);
  ensureDir(dir);
  const service = path.join(dir, SERVICE_NAME);
  const timer = path.join(dir, TIMER_NAME);
  const serviceText = fill(fs.readFileSync(path.join(templates, SERVICE_NAME), "utf8"), { PATH: systemdQuoted(pathValue(env)), NODE: systemdWord(node), CLI: systemdWord(cli) });
  writeFileAtomic(service, serviceText);
  writeFileAtomic(timer, fs.readFileSync(path.join(templates, TIMER_NAME), "utf8"));
  let stdout = "";
  let stderr = "";
  const steps = [["--user", "daemon-reload"], ["--user", "enable", "--now", TIMER_NAME]];
  for (const args of steps) {
    const r = run("systemctl", args);
    stdout += str(r.stdout);
    stderr += str(r.stderr);
    if (r.code !== 0) return { ok: false, file: service, files: [service, timer], command: displayCommand("systemctl", args), stdout, stderr, cronLine };
  }
  return { ok: true, file: service, files: [service, timer], command: displayCommand("systemctl", steps[1]), stdout, stderr };
}

// Registers the scheduled task. Windows: writes <dir>/autoclaude-watchdog.vbs and runs
// schtasks /Create. Elsewhere: systemd user units, or the crontab line when systemctl is missing.
// Returns { ok, file, command, stdout, stderr } (plus files and cronLine off Windows).
export function installWatchdog({
  run = defaultRunner,
  env = process.env,
  dir = binDir(),
  node = process.execPath,
  cli = null,
  platform = process.platform,
  unitDir = null,
  which = findOnPath,
  templates = templatesDir()
} = {}) {
  // The task runs the launcher, not a path inside one versioned plugin folder, so a plugin update
  // cannot break it (D42).
  if (!cli) cli = installLauncher({ dir });
  if (platform !== "win32") return installSystemd({ run, env, node, cli, unitDir, which, templates });
  const file = path.join(dir, VBS_NAME);
  const tr = taskCommand(file);
  const args = ["/Create", "/F", "/SC", "MINUTE", "/MO", "5", "/TN", TASK_NAME, "/TR", tr, "/IT"];
  const command = displayCommand("schtasks", args);
  if (tr.length > MAX_TR_LENGTH) {
    return { ok: false, file, command, stdout: "", stderr: `The scheduled task command would be ${tr.length} characters and schtasks accepts at most ${MAX_TR_LENGTH}. The watchdog script path is too long: ${file}` };
  }
  ensureDir(dir);
  writeFileAtomic(file, encodeForWsh(buildWatchdogVbs({ node, cli })));
  const r = run("schtasks", args);
  return { ok: r.code === 0, file, command, stdout: str(r.stdout), stderr: str(r.stderr) };
}

// Removes the scheduled task and its script. A task that is not there counts as ok.
// Returns { ok, stderr } (plus wasInstalled; off Windows without systemctl, `manual`).
export function uninstallWatchdog({
  run = defaultRunner,
  dir = binDir(),
  env = process.env,
  platform = process.platform,
  unitDir = null,
  which = findOnPath
} = {}) {
  if (platform !== "win32") {
    if (!which("systemctl", env)) {
      return { ok: true, stderr: "", wasInstalled: false, manual: "systemctl was not found on PATH. If you added the AutoClaude watchdog line to your crontab, remove it with crontab -e." };
    }
    const r = run("systemctl", ["--user", "disable", "--now", TIMER_NAME]);
    const text = str(r.stdout) + str(r.stderr);
    const missing = r.code !== 0 && /not loaded|does not exist|not found|no such file/i.test(text);
    if (r.code !== 0 && !missing) return { ok: false, stderr: str(r.stderr) || text, wasInstalled: true };
    const units = unitDir || systemdUserDir(env);
    let stderr = str(r.stderr);
    try {
      removeIfExists(path.join(units, SERVICE_NAME));
      removeIfExists(path.join(units, TIMER_NAME));
    } catch (e) {
      stderr += `${stderr ? "\n" : ""}${message(e)}`;
    }
    run("systemctl", ["--user", "daemon-reload"]);
    return { ok: true, stderr, wasInstalled: r.code === 0 };
  }
  const r = run("schtasks", ["/Delete", "/F", "/TN", TASK_NAME]);
  const text = str(r.stdout) + str(r.stderr);
  const missing = r.code !== 0 && TASK_NOT_FOUND.test(text);
  if (r.code !== 0 && !missing) return { ok: false, stderr: str(r.stderr) || text, wasInstalled: true };
  // The script goes only once the task is gone: a task left pointing at a missing script would
  // fail every 5 minutes.
  let stderr = r.code === 0 ? str(r.stderr) : "";
  try {
    removeIfExists(path.join(dir, VBS_NAME));
  } catch (e) {
    stderr += `${stderr ? "\n" : ""}${message(e)}`;
  }
  return { ok: true, stderr, wasInstalled: r.code === 0 };
}

// Reads Status, Next Run Time, Last Run Time and Last Result from `schtasks /Query /FO LIST /V`.
// A task with several triggers prints one block per trigger; the first value of each key wins.
export function parseSchtasksList(text) {
  const keys = { "Status": "status", "Next Run Time": "nextRun", "Last Run Time": "lastRun", "Last Result": "lastResult" };
  const out = { status: null, nextRun: null, lastRun: null, lastResult: null };
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const field = keys[line.slice(0, i).trim()];
    if (field && out[field] === null) out[field] = line.slice(i + 1).trim();
  }
  return out;
}

function parseKeyValues(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

// Returns { installed, status, nextRun, lastRun, lastResult } (plus error when the query failed
// for another reason than a missing task).
export function watchdogStatus({ run = defaultRunner, env = process.env, platform = process.platform, which = findOnPath } = {}) {
  const none = { installed: false, status: null, nextRun: null, lastRun: null, lastResult: null };
  if (platform !== "win32") {
    if (!which("systemctl", env)) {
      const r = run("crontab", ["-l"]);
      // The line runs the launcher (D42); an older install ran the plugin's CLI directly.
      const installed = r.code === 0 && /autoclaude(?:\.js|-launch\.mjs)['"]?\s+watchdog/.test(str(r.stdout));
      return { ...none, installed, status: installed ? "cron" : null };
    }
    const t = parseKeyValues(run("systemctl", ["--user", "show", TIMER_NAME, "--property=LoadState,ActiveState,NextElapseUSecRealtime,LastTriggerUSec"]).stdout);
    if (t.LoadState !== "loaded") return none;
    const s = parseKeyValues(run("systemctl", ["--user", "show", SERVICE_NAME, "--property=Result"]).stdout);
    return { installed: true, status: t.ActiveState || null, nextRun: t.NextElapseUSecRealtime || null, lastRun: t.LastTriggerUSec || null, lastResult: s.Result || null };
  }
  const r = run("schtasks", ["/Query", "/TN", TASK_NAME, "/FO", "LIST", "/V"]);
  const out = str(r.stdout);
  if (r.code !== 0) {
    const text = str(r.stderr) + out;
    return TASK_NOT_FOUND.test(text) ? none : { ...none, error: text.trim() || `schtasks exited with code ${r.code}` };
  }
  return { installed: true, ...parseSchtasksList(out) };
}
