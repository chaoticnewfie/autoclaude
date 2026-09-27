// P0.8 spike (also covers P0.3 statusline and P0.6 permission behaviour):
// a supervisor that runs an interactive claude in this console window, holds it
// long enough for idle_prompt to fire, kills the process tree, relaunches with
// --continue and a new prompt, and checks for orphans. Three runs:
//   1. auto mode, trivial prompt                      -> READY
//   2. --continue, manual mode, needs a permission     -> PermissionRequest hook denies
//   3. --continue, auto mode, asks to use AskUserQuestion -> PreToolUse hook denies
// Launch from a fresh console window:
//   start "ac-spike" node supervise.mjs [holdMs]
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = process.env.AC_SPIKE_CWD || path.dirname(fileURLToPath(import.meta.url));
const out = path.join(path.dirname(fileURLToPath(import.meta.url)), "out");
fs.mkdirSync(out, { recursive: true });
const logFile = path.join(out, "supervisor.log");
const log = (m) => {
  const line = new Date().toISOString() + " " + m;
  console.log(line);
  fs.appendFileSync(logFile, line + "\n");
};

const env = { ...process.env };
for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
const home = process.env.USERPROFILE || process.env.HOME;
env.PATH = "C:\\Program Files\\nodejs;" + path.join(home, ".local", "bin") + ";" + path.join(process.env.LOCALAPPDATA || "", "autoclaude", "bin") + ";C:\\Program Files\\Git\\cmd;" + env.PATH;
const claude = path.join(home, ".local", "bin", "claude.exe");

fs.writeFileSync(path.join(out, "supervisor.pid"), String(process.pid));
log("supervisor pid=" + process.pid + " ppid=" + process.ppid + " cwd=" + here);

function tasklist(filter) {
  try { return execSync("tasklist /FI \"" + filter + "\" /FO CSV /NH", { encoding: "utf8" }).trim(); }
  catch (e) { return "tasklist failed: " + e.message; }
}

function runChild(args, holdMs) {
  return new Promise((resolve) => {
    const child = spawn(claude, args, { cwd: here, env, stdio: "inherit", windowsHide: false });
    log("spawned claude pid=" + child.pid + " args=" + JSON.stringify(args));
    let exited = false;
    child.on("error", (e) => log("spawn error: " + e.message));
    child.on("exit", (code, signal) => {
      exited = true;
      log("child exit code=" + code + " signal=" + signal);
      resolve({ code, signal });
    });
    setTimeout(() => {
      if (exited) return;
      log("hold over; claude processes: " + tasklist("IMAGENAME eq claude.exe").replace(/\r?\n/g, " | "));
      log("killing tree of pid " + child.pid);
      try {
        execSync("taskkill /T /F /PID " + child.pid, { stdio: "pipe" });
        log("taskkill ok");
      } catch (e) {
        log("taskkill failed: " + e.message);
      }
    }, holdMs);
  });
}

const holdMs = Number(process.argv[2] || 80000);
// Extra arguments after holdMs become a single custom run, e.g.
//   node supervise.mjs 70000 --continue --permission-mode manual "prompt"
const custom = process.argv.slice(3);
const runs = custom.length ? [custom] : [
  ["--permission-mode", "auto", "Reply with the single word READY and nothing else, then wait."],
  ["--continue", "--permission-mode", "manual", "Use the Bash tool to run exactly: git status . Report the result in one line, then wait."],
  ["--continue", "--permission-mode", "auto", "Use the AskUserQuestion tool to ask me whether I prefer red or blue. Then wait."]
];
for (let i = 0; i < runs.length; i++) {
  await runChild(runs[i], holdMs);
  await new Promise((r) => setTimeout(r, 3000));
  log("after run " + (i + 1) + ", claude processes: " + (tasklist("IMAGENAME eq claude.exe") || "(none)").replace(/\r?\n/g, " | "));
}
log("DONE. This window closes in 30 s.");
await new Promise((r) => setTimeout(r, 30000));
