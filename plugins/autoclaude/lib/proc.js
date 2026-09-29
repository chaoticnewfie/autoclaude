// Process helpers that behave the same on Windows, Linux and macOS. Node built-ins only.
// Windows facts these encode (VERIFY.md): a shell command runs through cmd.exe /d /s /c so
// npm's .cmd shims resolve; a process tree is ended with taskkill /T /F; a detached console
// window comes from `cmd start "title"` with the title quoted; never launch through Git Bash.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { isWindows } from "./paths.js";

// Runs a shell command line, captures output, enforces a timeout by killing the process tree.
// Resolves to { code, signal, stdout, stderr, timedOut, durationMs }. Never rejects for a
// non-zero exit; rejects only when the process cannot be spawned at all.
export function runCommand(command, options = {}) {
  const { cwd = process.cwd(), env = process.env, timeoutMs = 0, onLine = null, input = null } = options;
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = isWindows
      ? spawn("cmd.exe", ["/d", "/s", "/c", `"${command}"`], { cwd, env, windowsVerbatimArguments: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn("/bin/sh", ["-c", command], { cwd, env, detached: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let timer = null;
    const feed = (stream, sink) => {
      let buf = "";
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        if (sink === "out") stdout += chunk; else stderr += chunk;
        if (!onLine) return;
        buf += chunk;
        let i;
        while ((i = buf.indexOf("\n")) >= 0) { onLine(buf.slice(0, i).replace(/\r$/, ""), sink); buf = buf.slice(i + 1); }
      });
    };
    feed(child.stdout, "out");
    feed(child.stderr, "err");
    if (input !== null) child.stdin.end(input); else child.stdin.end();
    if (timeoutMs > 0) {
      timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    }
    child.on("error", (e) => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
  });
}

// Ends a process and everything it spawned. Safe to call on a pid that already exited.
export function killTree(pid) {
  if (!pid) return false;
  if (isWindows) {
    const r = spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "pipe", windowsHide: true });
    return r.status === 0;
  }
  try { process.kill(-pid, "SIGKILL"); return true; } catch {}
  try { process.kill(pid, "SIGKILL"); return true; } catch { return false; }
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

// Finds an executable on PATH the way the OS would (PATHEXT on Windows). Returns the full path or null.
export function findOnPath(name, env = process.env) {
  const dirs = (env.PATH || env.Path || "").split(path.delimiter).filter(Boolean);
  const exts = isWindows ? (env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").map((e) => e.toLowerCase()) : [""];
  const candidates = isWindows && !path.extname(name) ? exts.map((e) => name + e) : [name];
  for (const dir of dirs) {
    for (const c of candidates) {
      const full = path.join(dir, c);
      try {
        const st = fs.statSync(full);
        if (st.isFile()) return full;
      } catch {}
    }
  }
  return null;
}

// Quote one argument for a cmd.exe `start` line.
export function cmdQuote(s) {
  const str = String(s);
  return /[\s"&|<>^()]/.test(str) || str === "" ? `"${str.replace(/"/g, "\\\"")}"` : str;
}

// The exact `start` line used on Windows, exported so tests can check it without opening a window.
export function buildStartLine({ title, cwd, program, args = [] }) {
  return ["start", JSON.stringify(title), "/D", cmdQuote(cwd), cmdQuote(program), ...args.map(cmdQuote)].join(" ");
}

// Opens a new detached console window (Windows), a tmux session (when tmux exists), or a
// detached background process logging to `logFile`. Returns { method, pid, command }.
export function openConsoleWindow({ title, cwd, program, args = [], logFile = null, env = process.env }) {
  if (isWindows) {
    const line = buildStartLine({ title, cwd, program, args });
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: true, env });
    child.unref();
    return { method: "windows-console", pid: child.pid, command: line };
  }
  const tmux = findOnPath("tmux", env);
  if (tmux) {
    const inner = [program, ...args].map((a) => `'${String(a).replace(/'/g, "'\\''")}'`).join(" ");
    const r = spawnSync(tmux, ["new-session", "-d", "-s", title, "-c", cwd, inner], { stdio: "pipe", env });
    return { method: "tmux", pid: null, command: `tmux new-session -d -s ${title} ${inner}`, ok: r.status === 0, stderr: String(r.stderr || "") };
  }
  const out = logFile ? fs.openSync(logFile, "a") : "ignore";
  const child = spawn(program, args, { cwd, detached: true, stdio: ["ignore", out, out], env });
  child.unref();
  return { method: "background", pid: child.pid, command: [program, ...args].join(" ") };
}

// cmd.exe metacharacters, escaped with a caret after quoting so a line cmd parses hands them on
// unchanged (the approach of the cross-spawn package).
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

// One argument on a cmd.exe line that runs a batch file: quoted for the program's own parser
// (backslashes before a quote and at the end doubled), then every metacharacter escaped twice,
// because a batch shim (npm's claude.cmd) hands its arguments to cmd once more through %*.
export function cmdShimArg(arg) {
  const quoted = `"${String(arg).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, "$1$1")}"`;
  return quoted.replace(CMD_META, "^$1").replace(CMD_META, "^$1");
}

// The /c line that runs `exe` (a .cmd or .bat) with `args`, for cmd.exe /d /s /c.
export function cmdShimLine(exe, args = []) {
  return `"${[String(exe).replace(CMD_META, "^$1"), ...args.map(cmdShimArg)].join(" ")}"`;
}

// Starts claude. Node refuses to spawn a .cmd or .bat without a shell (since the 2024 fix for
// CVE-2024-27980; a synchronous EINVAL), and an npm install of Claude Code is exactly that, so
// one runs through cmd.exe with every argument escaped. `spawnFn` is for tests.
export function spawnClaude(exe, args, opts = {}, { windows = isWindows, spawnFn = spawn } = {}) {
  if (windows && /\.(cmd|bat)$/i.test(String(exe || ""))) {
    return spawnFn("cmd.exe", ["/d", "/s", "/c", cmdShimLine(exe, args)], { ...opts, windowsVerbatimArguments: true });
  }
  return spawnFn(exe, args, opts);
}
