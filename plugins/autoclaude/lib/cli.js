// Command dispatch for bin/autoclaude.js. Node built-ins only.
// Phase 1 commands: status, pause, note, resume, lint-plan, usage, install-cli, notify-test.
// Later phases add init, run, supervise, start, ready, blocked, answer, watchdog.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { findProjectRoot, projectPaths, pluginRoot, binDir, machinePaths, isWindows } from "./paths.js";
import { loadConfig, formatConfigErrors } from "./config.js";
import { loadState, updateState, describeState, STATUS } from "./state.js";
import { parsePlan, lintPlan, formatLint, stepById, nextStep, progress } from "./plan.js";
import { readUsage, formatUsage } from "./usage.js";
import { notify, readMachineNotify, writeMachineNotify, resolveChannel } from "./notify.js";
import { readText, readJson, appendLine, ageMs, ensureDir, writeFileAtomic, writeJsonAtomic } from "./fsatomic.js";
import { isPidAlive, findOnPath } from "./proc.js";
import { initProject, formatInitReport } from "./init.js";
import { writeReady, writeBlocked, readReady } from "./protocol.js";
import { firstUnfinished, planSlug, setMarker, MARKERS } from "./plan.js";
import * as git from "./git.js";
import { resumeRun, commitPending } from "./resume.js";
import { preflight, formatPreflight } from "./preflight.js";
import { supervise } from "./supervisor.js";
import { openConsoleWindow, isPidAlive as pidAlive } from "./proc.js";
import { registerProject } from "./registry.js";
import { installLauncher } from "./launcher.js";
import { runChecks } from "./checks.js";
import { restartDevServer, stopDevServer, devServerInfo } from "./devserver.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8")).version;

const HELP = `autoclaude ${VERSION}

Usage: autoclaude <command> [options]

Project commands (run inside a project):
  init [<folder>] [--playwright] [--no-statusline] [--dev-url <url>] [--dir <folder>]
                        Set the project up (the current folder unless one is given): config, doc
                        set, .gitignore, browser-tester config, machine registry, statusline
                        bridge. Never overwrites existing files.
  run [--check]         Preflight, then open the ac-<project> window where the supervisor runs the
                        build. A finished plan with new steps added starts a fresh run.
                        --check: only run and print the preflight; opens no window
  status [--all]        State, current step, attempts, usage, last progress (--all: every registered project)
  checks                Run the configured checks the way the gate does (starting the dev server
                        first when a check needs it) and print one line per check
  guard-test "<command>"
                        Show whether the run's tool guard would allow this command in the Bash
                        tool and in the PowerShell tool, and why not
  start [--no-preflight]  Preflight, create the run branch, set the run going (the run window does this)
  supervise             The supervisor loop itself (what \`run\` starts in the window)
  nudge "<prompt>"      Restart the running session now with this prompt (for example "/compact")
  ready [<step>]        Builder: tell the gate the current step is done (verified on the next stop)
  blocked <step> "<q>"  Builder: stop the run with a question only the owner can answer
  answer "<text>"       Owner: answer the blocked question; recorded as a decision, the run resumes
  pause [--now]         Pause after the next verified commit. --now pauses at once: the supervisor
                        ends the builder session and the dev server is stopped
  note "<text>"         Leave a review note for Claude; it is read on the next resume or session start
  resume                Clear a pause and set the run going again (refuses if PLAN.md fails lint)
  lint-plan [file]      Check the plan against the step format

Machine commands:
  usage                 Show the 5-hour and 7-day usage percentages Claude Code last reported
  install-cli [--no-path]  Put an \`autoclaude\` shim on your PATH
  notify-setup [--channel ntfy|discord|stdout] [--ntfy <topic url>] [--ntfy-token <token>]
               [--discord <webhook url>] [--show] [--clear]
                        Store the notification channel for this machine (outside any repo).
                        --ntfy or --discord without --channel also picks that channel
  notify-test [message] Send a test notification through the configured channel
  watchdog [--install | --uninstall | --status]
                        One pass: bring back the supervisor of any running project whose window
                        is gone. --install schedules it every 5 minutes.
  uninstall [--purge]   Remove what AutoClaude added to this machine: the watchdog task, the
                        status line bridge, the command shims and, on Windows, their PATH entry
                        (on Linux and macOS ~/.local/bin and PATH are left alone) (--purge also
                        deletes the machine settings: notification channel, registry, logs)
  version | help

`;

class Io {
  constructor(io) {
    this.cwd = io.cwd || process.cwd();
    this.env = io.env || process.env;
    this.stdoutStream = io.stdout || process.stdout;
    this.stderrStream = io.stderr || process.stderr;
    this.now = io.now || (() => new Date());
    // Test seams for commands that change the machine (uninstall).
    this.deps = io.deps || {};
  }
  out(s = "") { this.stdoutStream.write(s + "\n"); }
  err(s = "") { this.stderrStream.write(s + "\n"); }
}

export async function runCli(argv, rawIo = {}) {
  const io = new Io(rawIo);
  const [cmd = "help", ...rest] = argv;
  try {
    switch (cmd) {
      case "help": case "--help": case "-h": io.out(HELP.trimEnd()); return 0;
      case "version": case "--version": case "-v": io.out(VERSION); return 0;
      // Async commands are awaited, so one that throws (a bad option, say) ends in the catch
      // below with a message instead of escaping as a rejected promise.
      case "init": return cmdInit(rest, io);
      case "status": return cmdStatus(rest, io);
      case "run": return await cmdRun(rest, io);
      case "checks": return await cmdChecks(rest, io);
      case "guard-test": return await cmdGuardTest(rest, io);
      case "supervise": return await cmdSupervise(rest, io);
      case "nudge": return cmdNudge(rest, io);
      case "watchdog": return await cmdWatchdog(rest, io);
      case "uninstall": return await cmdUninstall(rest, io);
      case "start": return await cmdStart(rest, io);
      case "ready": return cmdReady(rest, io);
      case "blocked": return cmdBlocked(rest, io);
      case "answer": return cmdAnswer(rest, io);
      case "pause": return cmdPause(rest, io);
      case "note": return cmdNote(rest, io);
      case "resume": return await cmdResume(rest, io);
      case "lint-plan": return cmdLintPlan(rest, io);
      case "usage": return cmdUsage(rest, io);
      case "install-cli": return cmdInstallCli(rest, io);
      case "notify-setup": return cmdNotifySetup(rest, io);
      case "notify-test": return await cmdNotifyTest(rest, io);
      default:
        io.err(`autoclaude: unknown command "${cmd}". Run "autoclaude help".`);
        return 2;
    }
  } catch (e) {
    io.err(`autoclaude: ${e && e.message ? e.message : e}`);
    return 1;
  }
}

// ---------- shared ----------

function requireProject(io, { needConfig = true } = {}) {
  const root = findProjectRoot(io.cwd);
  if (!root) {
    io.out("autoclaude: not initialized in this project (no autoclaude.config.json and no git repository found)");
    return null;
  }
  const cfg = loadConfig(root);
  if (needConfig && !cfg.exists) {
    io.out("autoclaude: not initialized in this project");
    io.out(`  project: ${root}`);
    io.out("  run /autoclaude:init (or `autoclaude init`) to set it up");
    return null;
  }
  if (cfg.errors.length) {
    io.out(`autoclaude: ${cfg.file} has problems:`);
    io.out(formatConfigErrors(cfg.errors));
    return null;
  }
  return { root, config: cfg.config, paths: projectPaths(root) };
}

function loadPlan(project) {
  const file = path.join(project.root, project.config.plan);
  const text = readText(file, null);
  if (text === null) return { file, parsed: null, problems: [{ line: 0, id: null, message: `plan file not found: ${file}` }] };
  const parsed = parsePlan(text);
  return { file, parsed, problems: lintPlan(parsed) };
}

function fmtAge(ms) {
  if (ms === null) return "never";
  const min = ms / 60000;
  if (min < 1) return `${Math.round(ms / 1000)} s ago`;
  if (min < 120) return `${Math.round(min)} min ago`;
  return `${(min / 60).toFixed(1)} h ago`;
}

// ---------- init ----------

function cmdInit(args, io) {
  const opts = { playwright: false, statusline: true, devUrl: null, now: io.now(), env: io.env };
  let dir = null;
  const setDir = (d) => {
    if (dir !== null) throw new Error(`init takes one folder; got ${dir} and ${d}`);
    dir = d;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--playwright") opts.playwright = true;
    else if (a === "--no-statusline") opts.statusline = false;
    else if (a === "--dev-url") { opts.devUrl = args[++i]; if (!opts.devUrl) throw new Error("--dev-url needs a value"); }
    else if (a === "--dir") { const d = args[++i]; if (!d) throw new Error("--dir needs a value"); setDir(d); }
    else if (!a.startsWith("-")) setDir(a);
    else throw new Error(`unknown option ${a} (to set up another folder, give it as \`init <folder>\` or \`init --dir <folder>\`)`);
  }
  if (dir === null) dir = io.cwd;
  const report = initProject(path.resolve(io.cwd, dir), opts);
  io.out(formatInitReport(report));
  return report.warnings.length ? 0 : 0;
}

// ---------- status ----------

function cmdStatus(args, io) {
  if (args.includes("--all")) return statusAll(io);
  const project = requireProject(io);
  if (!project) return 1;
  const { root, config, paths } = project;
  const state = loadState(root);
  const plan = loadPlan(project);
  io.out(`autoclaude: ${describeState(state)}  (${root})`);
  if (plan.parsed) {
    const p = progress(plan.parsed);
    io.out(`  plan: ${config.plan}, ${p.done}/${p.total} steps verified${p.failed ? `, ${p.failed} failed` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}${plan.problems.length ? `, ${plan.problems.length} lint problem(s)` : ""}`);
    const current = state.currentStep ? stepById(plan.parsed, state.currentStep) : nextStep(plan.parsed);
    if (current) {
      const attempts = state.attempts[current.id] || 0;
      io.out(`  ${state.currentStep ? "current" : "next"} step: ${current.id} ${current.title}${attempts ? ` (attempt ${attempts}/${config.retries.maxAttemptsPerStep})` : ""}`);
    } else if (plan.parsed.steps.length === 0) {
      io.out("  next step: none yet (the plan has no steps; run /autoclaude:plan)");
    } else {
      io.out("  next step: none left");
    }
  } else {
    io.out(`  plan: ${plan.problems[0].message}`);
  }
  if (state.pendingNotes.length) io.out(`  review notes waiting: ${state.pendingNotes.length}`);
  io.out(`  last progress: ${fmtAge(ageMs(paths.heartbeatFile, io.now().getTime()))}`);
  if (state.supervisorPid) io.out(`  supervisor: pid ${state.supervisorPid} ${isPidAlive(state.supervisorPid) ? "alive" : "not running"}`);
  io.out(`  ${formatUsage(readUsage({ staleAfterMin: config.usage.staleAfterMin, now: io.now().getTime() }), io.now().getTime())}`);
  return 0;
}

function statusAll(io) {
  const reg = readJson(machinePaths().registryFile, null);
  const projects = reg && Array.isArray(reg.projects) ? reg.projects : [];
  if (projects.length === 0) {
    io.out("autoclaude: no registered projects on this machine (init registers a project)");
    return 0;
  }
  for (const p of projects) {
    const root = p.root;
    if (!fs.existsSync(root)) { io.out(`${root}: missing`); continue; }
    const state = loadState(root);
    io.out(`${root}: ${describeState(state)}${state.currentStep ? `, step ${state.currentStep}` : ""}`);
  }
  return 0;
}

// ---------- run / supervise ----------

function supervisorPid(root) {
  try { return Number(fs.readFileSync(projectPaths(root).supervisorPidFile, "utf8")) || null; } catch { return null; }
}

// What a finished run says when asked to go again: new steps are the only way on.
function completeMessage(project, hasNewSteps) {
  const plan = project.config.plan;
  if (hasNewSteps) return `autoclaude: the last run finished, and ${plan} has new steps. Commit them, then \`autoclaude run\` starts a fresh run on them (resume only continues a paused run).`;
  return `autoclaude: the plan is complete; every step in ${plan} is verified. To continue, add steps to ${plan}, commit them, then \`autoclaude run\`.`;
}

function hasUnfinishedStep(project) {
  const plan = loadPlan(project);
  return !!(plan.parsed && firstUnfinished(plan.parsed));
}

async function cmdRun(args, io) {
  let checkOnly = false;
  for (const a of args) {
    if (a === "--check") checkOnly = true;
    else throw new Error(`unknown option ${a}`);
  }
  const project = requireProject(io);
  if (!project) return 1;
  const { root } = project;
  const state = loadState(root);
  const pid = supervisorPid(root);
  if (pid && pidAlive(pid)) {
    io.out(`autoclaude: this project already has a supervisor (pid ${pid}, window ${state.windowTitle || "?"}). Watch it with \`autoclaude status\`.`);
    return 1;
  }
  // A finished plan the owner has added steps to is a fresh run; without new steps there is
  // nothing to do.
  const continuing = state.status === STATUS.complete;
  if (continuing && !hasUnfinishedStep(project)) {
    io.out(completeMessage(project, false));
    return 1;
  }
  // A new run gets the full preflight; bringing back the supervisor of a run already under way
  // (after a reboot, or a closed window) checks only the tools and the folder's trust, because
  // mid-step the working tree is legitimately dirty.
  const fresh = state.status === STATUS.idle || continuing;
  const skip = fresh ? [] : ["plan", "git", "checks", "playwright", "dev server", "usage"];
  const pf = await preflight(project, { env: io.env, devServer: fresh, skip });
  io.out(`autoclaude: preflight${fresh ? "" : ` (a run is under way, ${describeState(state)}, so only the tools and the folder's trust are checked)`}`);
  io.out(formatPreflight(pf));
  const what = continuing ? "continue the finished plan with its new steps" : fresh ? "start the run" : `bring back the ${state.status} run`;
  if (checkOnly) {
    io.out(pf.ok ? `autoclaude: preflight passed; \`autoclaude run\` would ${what}` : "autoclaude: preflight failed; fix the FAIL lines above before `autoclaude run`");
    return pf.ok ? 0 : 1;
  }
  if (!pf.ok) { io.out("autoclaude: not starting; fix the FAIL lines above and run it again"); return 1; }
  // Back to idle, so the supervisor launches /autoclaude:start, which sets up the new run.
  if (continuing) {
    updateState(root, (s) => {
      s.status = STATUS.idle; s.pauseReason = null; s.pauseRequested = false; s.currentStep = null;
      s.haltSession = false; s.builderSessionId = null;
    });
  }
  registerProject(root);
  const title = `ac-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const open = io.deps.openConsoleWindow || openConsoleWindow;
  const r = open({
    title,
    cwd: root,
    program: process.execPath,
    args: [path.join(pluginRoot(), "bin", "autoclaude.js"), "supervise"],
    logFile: path.join(projectPaths(root).logsDir, "supervisor.log"),
    env: io.env
  });
  if (r.method === "tmux" && r.ok === false) {
    io.out(`autoclaude: could not start the tmux session ${title}: ${String(r.stderr || "").trim() || "tmux failed"}`);
    io.out("  Nothing is running. Fix that and run `autoclaude run` again.");
    return 1;
  }
  io.out(`autoclaude: ${continuing ? "continuing the finished plan with its new steps" : fresh ? "starting the run" : `bringing back the ${state.status} run`} in a new window, ${title} (${r.method}).`);
  io.out("  Watch:  the window, or `autoclaude status` from any terminal. Leave the window open; an RDP disconnect is fine, logging off is not.");
  io.out("  Stop:   `autoclaude pause` (after the current step is verified) or `autoclaude pause --now`.");
  io.out("  Notes:  `autoclaude note \"...\"` any time; they reach Claude at the next step or resume.");
  return 0;
}

async function cmdSupervise(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const other = supervisorPid(project.root);
  if (other && other !== process.pid && pidAlive(other)) {
    io.out(`autoclaude: another supervisor (pid ${other}) is already running this project; this one stops.`);
    return 1;
  }
  io.out(`autoclaude: supervisor for ${project.root} (pid ${process.pid}). This window runs the build. Closing it stops the run until \`autoclaude run\` or the watchdog brings it back.`);
  const r = await supervise({ root: project.root, env: io.env });
  io.out(`autoclaude: supervisor finished (${r.exit}).`);
  return 0;
}

function cmdNudge(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  let prompt = args.join(" ").trim();
  // Git Bash rewrites an argument like "/compact" into "C:/Program Files/Git/compact" before
  // any program sees it (seen live). Undo that, since a nudge is never a path inside Git.
  const msys = prompt.match(/^[A-Za-z]:[\\/](?:Program Files[\\/]Git|msys64|Git)[\\/]([^\\/\s][^\s]*)$/i);
  if (msys && (io.env.MSYSTEM || io.env.SHELL)) prompt = `/${msys[1]}`;
  if (!prompt) { io.err('autoclaude: usage: autoclaude nudge "<prompt>"   (for example "/compact")'); return 2; }
  const state = loadState(project.root);
  if (state.status !== STATUS.running) { io.out(`autoclaude: the run is ${describeState(state)}; a nudge only applies to a running session`); return 1; }
  const pid = supervisorPid(project.root);
  if (!pid || !pidAlive(pid)) { io.out("autoclaude: no supervisor is running for this project, so nothing would act on it; use `autoclaude run`"); return 1; }
  writeJsonAtomic(path.join(projectPaths(project.root).runtimeDir, "nudge.json"), { prompt, at: io.now().toISOString() });
  io.out(`autoclaude: on its next pass the supervisor restarts the session with: ${prompt}`);
  return 0;
}

// ---------- checks / guard-test ----------

// The project's checks, run the way the gate runs them: the dev server first when a check needs
// it, then every check in order, stopping at the first failure.
async function cmdChecks(args, io) {
  if (args.length) throw new Error(`unknown option ${args[0]}`);
  const project = requireProject(io);
  if (!project) return 1;
  const { root, config } = project;
  if (!config.checks.length) {
    io.out("autoclaude: no checks are configured (the \"checks\" list in autoclaude.config.json is empty)");
    return 0;
  }
  const restart = io.deps.restartDevServer || restartDevServer;
  const stop = io.deps.stopDevServer || stopDevServer;
  io.out(`autoclaude: running ${config.checks.length} check(s) in ${root}`);
  const needsServer = config.checks.some((c) => c.needsDevServer);
  let devServerReady = false;
  let stopAfter = false;
  if (needsServer && config.devServer.command && config.devServer.url) {
    // Like the preflight: a server that was already recorded (a run's) is left running after.
    stopAfter = !devServerInfo({ root });
    const ds = await restart(config.devServer, { root, env: io.env });
    devServerReady = !!ds.ok;
    io.out(ds.ok ? `  dev server: ${ds.reused ? "already answering" : "started"} at ${config.devServer.url}` : `  dev server: FAILED to start: ${ds.error}`);
  } else if (needsServer) {
    io.out("  dev server: not configured (devServer.command and devServer.url), so a check that needs it fails");
  }
  const secs = (ms) => `${Math.round((ms || 0) / 1000)} s`;
  const line = (r) => {
    if (r.skipped) return `  skip ${r.name}: not run, an earlier check failed`;
    if (r.ok) return `  ok   ${r.name} (${secs(r.durationMs)}): ${r.command}`;
    return `  FAIL ${r.name} (${r.reason || "failed"}${r.ran ? `, ${secs(r.durationMs)}` : ""}): ${r.command}`;
  };
  let result;
  try {
    result = await runChecks(config.checks, { cwd: root, env: io.env, devServerReady, onProgress: (r) => io.out(line(r)) });
  } finally {
    if (stopAfter) stop({ root });
  }
  for (const r of result.results) if (r.skipped) io.out(line(r));
  if (result.ok) {
    io.out(`autoclaude: all ${result.results.length} check(s) passed`);
    return 0;
  }
  const f = result.failed;
  if (f.tail) {
    const tail = f.tail.split("\n").slice(-30);
    io.out(`  last ${tail.length} line(s) of "${f.name}":`);
    for (const l of tail) io.out(`    ${l}`);
  }
  io.out(`autoclaude: check "${f.name}" failed`);
  return 1;
}

// What the PreToolUse tool guard would decide for a command during a run here, for the Bash
// tool and the PowerShell tool. The project need not be running. Always exit 0 once decided.
async function cmdGuardTest(args, io) {
  const command = args.join(" ").trim();
  if (!command) { io.err('autoclaude: usage: autoclaude guard-test "<command>"'); return 2; }
  const project = requireProject(io);
  if (!project) return 1;
  // Imported here so a broken guard script can never stop the other commands.
  const { decide } = await import("../scripts/tool-guard.js");
  io.out(`autoclaude: during a run in ${project.root}, the tool guard decides for: ${command}`);
  for (const tool of ["Bash", "PowerShell"]) {
    let reason = null;
    try {
      reason = decide({ hook_event_name: "PreToolUse", cwd: project.root, tool_name: tool, tool_input: { command } }, { root: project.root, config: project.config });
    } catch (e) {
      reason = `the guard itself failed (${e.message})`;
    }
    io.out(`  ${tool}: ${reason ? `denied: ${reason}` : "allowed"}`);
  }
  return 0;
}

// ---------- uninstall ----------

// Removes AutoClaude's machine-level pieces. The plugin itself is removed with Claude Code's own
// commands, printed at the end; project files are never touched.
async function cmdUninstall(args, io) {
  const purge = args.includes("--purge");
  const w = await import("./watchdog.js");
  const s = await import("./statusline.js");
  const l = await import("./launcher.js");
  const uninstallWatchdog = io.deps.uninstallWatchdog || ((o) => w.uninstallWatchdog(o));
  const uninstallStatusline = io.deps.uninstallStatusline || (() => s.uninstallStatusline());
  const win = io.deps.isWindows ?? isWindows;
  const removeFromUserPath = io.deps.removeFromUserPath || ((d) => removeDirFromUserPath(d, win));
  let ok = true;
  io.out("autoclaude: removing AutoClaude from this machine");

  const wd = uninstallWatchdog({ env: io.env });
  if (wd.ok) io.out(`  watchdog: ${wd.wasInstalled === false ? "was not installed" : "removed"}${wd.manual ? ` (${wd.manual})` : ""}`);
  else { ok = false; io.out(`  watchdog: could not remove it: ${String(wd.stderr || "").trim()}`); }

  try {
    const sl = uninstallStatusline();
    io.out(`  status line bridge: ${sl.removed ? (sl.restored ? "removed; your previous status line is back" : "removed") : "was not installed"}`);
  } catch (e) { ok = false; io.out(`  status line bridge: could not remove it: ${e.message}`); }

  const dir = io.env.AUTOCLAUDE_BIN_DIR || binDir();
  const files = ["autoclaude", "autoclaude.cmd", l.LAUNCHER_NAME, l.LAUNCHER_SIDECAR, "autoclaude-watchdog.vbs"].map((f) => path.join(dir, f)).filter((f) => fs.existsSync(f));
  for (const f of files) fs.rmSync(f, { force: true });
  io.out(`  command shims: ${files.length ? `removed ${files.length} file(s) from ${dir}` : "none found"}`);
  if (win) {
    // On Windows the folder is AutoClaude's own (%LOCALAPPDATA%\autoclaude\bin), and so is its
    // PATH entry. Elsewhere it is ~/.local/bin, shared with other tools: the folder and PATH stay.
    try { if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
    io.out(`  PATH: ${removeFromUserPath(dir)}`);
  } else {
    io.out(`  PATH: unchanged (${dir} is shared with other tools, so it stays)`);
  }

  const machine = machinePaths().dir;
  if (purge) {
    fs.rmSync(machine, { recursive: true, force: true });
    io.out(`  machine settings: removed ${machine}`);
  } else {
    io.out(`  machine settings: kept in ${machine} (notification channel, project registry, logs); \`autoclaude uninstall --purge\` removes them`);
  }
  io.out("");
  io.out("Last, remove the plugin itself:");
  io.out("  claude plugin uninstall autoclaude@autoclaude");
  io.out("  claude plugin marketplace remove autoclaude");
  io.out("Project files (autoclaude.config.json, .autoclaude/, the docs) are left alone; delete them by hand if you want.");
  return ok ? 0 : 1;
}

// Takes `dir` out of the user's PATH on Windows: the user environment through PowerShell, as
// install-cli added it. Elsewhere the folder is ~/.local/bin, which other tools use too.
function removeDirFromUserPath(dir, win = isWindows) {
  if (!win) return `unchanged (${dir} is shared with other tools, so it stays)`;
  const ps = `$d='${dir.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); $parts=@($p -split ';' | Where-Object { $_ -and ($_.TrimEnd('\\') -ne $d.TrimEnd('\\')) }); if ($parts.Count -eq @($p -split ';' | Where-Object { $_ }).Count) { 'absent' } else { [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User'); 'removed' }`;
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
  if (r.status !== 0) return `could not update the user PATH (${String(r.stderr || r.error).trim().slice(0, 200)}); remove ${dir} from it by hand`;
  return String(r.stdout).trim() === "removed" ? `removed ${dir} from your user PATH (new terminals pick it up)` : `${dir} was not on your user PATH`;
}

async function cmdWatchdog(args, io) {
  const w = await import("./watchdog.js");
  if (args.includes("--install")) {
    const r = w.installWatchdog({ env: io.env });
    if (r.ok) io.out(`autoclaude: watchdog installed (${process.platform === "win32" ? `scheduled task "${w.TASK_NAME}", every 5 minutes while you are logged on` : "systemd user timer"}).`);
    else io.out(`autoclaude: could not install the watchdog: ${String(r.stderr || r.error || "").trim()}${r.cronLine ? `\n  add this line with \`crontab -e\`:\n    ${r.cronLine}` : ""}`);
    return r.ok ? 0 : 1;
  }
  if (args.includes("--uninstall")) {
    const r = w.uninstallWatchdog({ env: io.env });
    io.out(r.ok ? "autoclaude: watchdog removed" : `autoclaude: could not remove the watchdog: ${String(r.stderr || "").trim()}`);
    return r.ok ? 0 : 1;
  }
  if (args.includes("--status")) {
    const s = w.watchdogStatus({ env: io.env });
    if (!s.installed) { io.out("autoclaude: the watchdog is not installed (`autoclaude watchdog --install`)"); return 1; }
    io.out(`autoclaude: watchdog ${s.status || "installed"}; last run ${s.lastRun || "?"} (result ${s.lastResult ?? "?"}); next run ${s.nextRun || "?"}`);
    return 0;
  }
  const results = await w.watchdogPass({ env: io.env });
  for (const r of results) if (r.action !== "not-running") io.out(`${r.root}: ${r.action}${r.error ? ` (${r.error})` : ""}`);
  return 0;
}

// ---------- start / ready / blocked ----------

async function cmdStart(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const { root, config } = project;
  const state = loadState(root);
  if (state.status === STATUS.running) { io.out(`autoclaude: already running (step ${state.currentStep || "?"})`); return 1; }
  const plan = loadPlan(project);
  if (plan.problems.length) {
    io.out(`autoclaude: not starting, ${config.plan} has ${plan.problems.length} problem(s):`);
    io.out(formatLint(plan.problems));
    return 1;
  }
  const first = firstUnfinished(plan.parsed);
  if (!first) { io.out("autoclaude: every step is already verified; nothing to run"); return 1; }
  const gitEnv = { ...io.env, PATH: io.env.PATH || io.env.Path || process.env.PATH };
  if (!(await git.isRepo(root, { env: gitEnv }))) { io.out("autoclaude: not starting, the project is not a git repository (the gate commits every verified step)"); return 1; }
  const st = await git.status(root, { env: gitEnv });
  if (!st.clean) {
    io.out(`autoclaude: not starting, the working tree is not clean (${st.entries.length} change(s)). Commit or stash first:`);
    for (const e of st.entries.slice(0, 10)) io.out(`  ${e.code} ${e.path}`);
    return 1;
  }
  if (!args.includes("--no-preflight")) {
    const pf = await preflight(project, { env: gitEnv });
    io.out("autoclaude: preflight");
    io.out(formatPreflight(pf));
    if (!pf.ok) { io.out("autoclaude: not starting; fix the FAIL lines above and run it again"); return 1; }
  }
  const branch = config.branch.replace("{planSlug}", planSlug(plan.parsed));
  // A finished plan continued with new steps finds the run branch of the last run still there.
  // Checking it out as it is would drop steps committed elsewhere (say, on main after a merge).
  const onBranch = await git.currentBranch(root, { env: gitEnv });
  if (onBranch !== branch && (await git.branchExists(root, branch, { env: gitEnv }))) {
    const merged = await git.git(root, ["merge-base", "--is-ancestor", branch, "HEAD"], { env: gitEnv });
    if (merged.ok) {
      // Everything on the old run branch is already here, so moving it forward loses nothing.
      const moved = await git.git(root, ["branch", "-f", branch, "HEAD"], { env: gitEnv });
      if (!moved.ok) { io.out(`autoclaude: could not move ${branch} forward to ${onBranch}: ${moved.stderr.trim()}`); return 1; }
    } else {
      const there = await git.git(root, ["show", `${branch}:${config.plan.replace(/\\/g, "/")}`], { env: gitEnv });
      const theirs = there.ok ? stepById(parsePlan(there.stdout), first.id) : null;
      if (!theirs || theirs.marker === MARKERS.done) {
        io.out(`autoclaude: not starting; the run branch ${branch} is left from an earlier run, and its ${config.plan} does not have ${first.id} to do. Merge ${onBranch || "this branch"} into ${branch}, or rename the old one (git branch -m ${branch} ${branch}-old), then run again.`);
        return 1;
      }
    }
  }
  const co = await git.checkoutBranch(root, branch, { create: true, env: gitEnv });
  if (!co.ok) { io.out(`autoclaude: could not check out ${branch}: ${co.stderr}`); return 1; }
  const ticked = plan.parsed.steps.filter((s) => s.marker === MARKERS.done).map((s) => s.id);
  const now = io.now().toISOString();
  const baseCommit = await git.head(root, { env: gitEnv });
  const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: io.now().getTime() });
  updateState(root, (s) => {
    s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.haltSession = false; s.currentStep = first.id;
    s.attempts = {}; s.infraFailures = {}; s.noProgress = 0; s.recoveries = 0; s.tickedByGate = ticked; s.startedAt = now; s.stepStartedAt = now;
    s.headAtLastGate = null; s.toolCallsAtLastGate = 0; s.baseCommit = baseCommit; s.ownerAnswer = null; s.lastBlockedQuestion = null;
    s.usageAtStart = usage.sevenDay && !usage.stale ? usage.sevenDay.pct : null; s.weeklyResetsAt = null;
  });
  io.out(`autoclaude: running on branch ${branch}${co.created ? " (created)" : ""}. First step: ${first.id} ${first.title}.`);
  io.out(`  the builder session works the plan; the gate verifies on every stop. Watch with \`autoclaude status\`.`);
  // The session that ran `start` began before the run existed, so it never got the run's rules
  // at session start (seen in the first `autoclaude run`). Give them here, in the tool result.
  try {
    const { buildContext } = await import("../scripts/session-context.js");
    const { cliCommand } = await import("./gate.js");
    const promptTemplate = readText(path.join(pluginRoot(), "prompts", "context.md"), "");
    const context = buildContext({ root, state: loadState(root), config, planText: readText(path.join(root, config.plan), ""), progressText: readText(path.join(root, config.docs.progress), ""), promptTemplate, cli: cliCommand(io.env), now: io.now() });
    io.out("");
    io.out(context);
  } catch (e) {
    io.out(`  (could not print the run rules: ${e.message}; they arrive with the gate's first message)`);
  }
  return 0;
}

function cmdReady(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const state = loadState(project.root);
  if (state.status !== STATUS.running) { io.out(`autoclaude: no run is active (${describeState(state)})`); return 1; }
  const id = args[0] || null;
  if (id && state.currentStep && id !== state.currentStep) {
    io.out(`autoclaude: the current step is ${state.currentStep}, not ${id}. Run \`autoclaude ready ${state.currentStep}\` when that step is done.`);
    return 1;
  }
  writeReady(project.root, id || state.currentStep, { now: io.now() });
  io.out(`autoclaude: ${id || state.currentStep || "the run"} marked ready. Stop now; the gate verifies it and tells you the result.`);
  return 0;
}

function cmdBlocked(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const state = loadState(project.root);
  if (state.status !== STATUS.running) { io.out(`autoclaude: no run is active (${describeState(state)})`); return 1; }
  const id = args[0];
  const question = args.slice(1).join(" ").trim();
  if (!id || !question) { io.err('autoclaude: usage: autoclaude blocked <step> "<question with the options>"'); return 2; }
  if (state.currentStep && id !== state.currentStep) { io.out(`autoclaude: the current step is ${state.currentStep}, not ${id}.`); return 1; }
  writeBlocked(project.root, id, question, { now: io.now() });
  io.out("autoclaude: blocked marker written. Stop now; the run pauses and the owner is notified with your question.");
  return 0;
}

// ---------- pause / note / resume ----------

function cmdPause(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const now = args.includes("--now");
  const state = loadState(project.root);
  if (state.status !== STATUS.running) {
    io.out(`autoclaude: nothing to pause, the run is ${describeState(state)}`);
    return 1;
  }
  if (now) {
    // The hooks stand down once the run is paused, so the session must not carry on: a live
    // supervisor ends it on its next poll. The dev server the gate started goes too.
    const pid = supervisorPid(project.root);
    const supervised = !!(pid && pidAlive(pid));
    updateState(project.root, (s) => { s.status = STATUS.paused; s.pauseReason = "review"; s.pauseRequested = false; s.haltSession = supervised; });
    const ds = stopDevServer({ root: project.root });
    const step = state.currentStep || "the current step";
    io.out(`autoclaude: paused now for review${ds.stopped ? "; the dev server is stopped" : ""}.`);
    if (supervised) io.out(`  The supervisor (pid ${pid}) ends the builder session on its next check, within ${project.config.supervisor.pollSec} s.`);
    else io.out("  No supervisor is running for this project, so nothing ends the builder session: if a Claude session is still working on the run, stop it by hand (Esc, then /exit).");
    io.out(`  Work in progress stays in the working tree. On \`autoclaude resume\`, ${step} starts again with fresh attempts.`);
    io.out("  Leave notes first with `autoclaude note \"...\"` if you want Claude to change course.");
    return 0;
  }
  if (state.pauseRequested) {
    io.out("autoclaude: a pause is already requested; the gate will pause after the next verified commit");
    return 0;
  }
  updateState(project.root, (s) => { s.pauseRequested = true; });
  io.out(`autoclaude: pause requested. The gate finishes ${state.currentStep || "the current step"}, commits it, then pauses for review. Use --now to stop immediately.`);
  return 0;
}

function cmdNote(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const text = args.join(" ").trim();
  if (!text) { io.err('autoclaude: usage: autoclaude note "<text>"'); return 2; }
  const at = io.now().toISOString();
  const file = path.join(project.root, project.config.docs.reviewNotes);
  if (!fs.existsSync(file)) {
    ensureDir(path.dirname(file));
    appendLine(file, "# Review notes\n\nNotes left by the owner while a run was paused (or running). Claude reads pending notes on the next resume or session start and records what it did with each one in the decisions log.\n");
  }
  appendLine(file, `\n## ${at}\n\n${text}\n`);
  const state = updateState(project.root, (s) => { s.pendingNotes.push({ at, text }); });
  io.out(`autoclaude: note recorded in ${project.config.docs.reviewNotes} (${state.pendingNotes.length} pending). Claude reads it on the next resume or session start.`);
  return 0;
}

async function cmdResume(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  let state = loadState(project.root);
  const plan = loadPlan(project);
  if (plan.problems.length) {
    io.out(`autoclaude: not resuming, ${project.config.plan} has ${plan.problems.length} problem(s):`);
    io.out(formatLint(plan.problems));
    return 1;
  }
  if (state.status === STATUS.running) {
    if (state.pauseRequested) {
      updateState(project.root, (s) => { s.pauseRequested = false; });
      io.out("autoclaude: pause request withdrawn; the run continues");
      return 0;
    }
    io.out("autoclaude: already running");
    return 0;
  }
  if (state.status === STATUS.complete) {
    io.out(completeMessage(project, hasUnfinishedStep(project)));
    return 1;
  }
  if (state.status === STATUS.idle) {
    io.out("autoclaude: no run has been started yet; use `autoclaude run` to start one");
    return 1;
  }
  if ((state.uncommitted || []).length) {
    const c = await commitPending(project, state, { env: io.env });
    if (!c.ok) {
      io.out(`autoclaude: not resuming; ${c.ids.join(", ")} passed verification but still cannot be committed. git said: ${c.error.split(/\r?\n/)[0]}`);
      return 1;
    }
    io.out(`autoclaude: committed ${c.ids.join(", ")} (${String(c.sha || "").slice(0, 7)}), which passed verification before the commit failed`);
    state = loadState(project.root);
  }
  const changes = resumeRun(project, state);
  const next = loadState(project.root);
  const notes = next.pendingNotes.length;
  io.out(`autoclaude: resumed on ${next.currentStep || "?"}${notes ? ` with ${notes} review note(s) waiting for Claude` : ""}. The supervisor nudges the session on its next pass.`);
  for (const c of changes) io.out(`  ${c}`);
  return 0;
}

// ---------- answer ----------

// The text with every fenced code block left out: the template's "Entry format" example holds a
// D-001 that is not a real entry (it made the first real answer D-002).
export function outsideFences(text) {
  const out = [];
  let fence = null;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!fence) {
      const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
      if (open) fence = open[1];
      else out.push(line);
    } else {
      const close = line.match(/^ {0,3}(`{3,}|~{3,})\s*$/);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length) fence = null;
    }
  }
  return out.join("\n");
}

export function nextDecisionId(text) {
  let max = 0;
  for (const m of outsideFences(text).matchAll(/\bD-(\d{3,})\b/g)) max = Math.max(max, Number(m[1]));
  return `D-${String(max + 1).padStart(3, "0")}`;
}

// The file with one entry appended in the project template's format (docs/DECISIONS.md "Entry
// format"): `## D-### (YYYY-MM-DD, <step>) Title`, then `- Field: value` lines. The template's
// "(none yet)" placeholder goes when the first entry lands.
export function appendDecisionEntry(existing, { id, date, step, title, fields }) {
  let text = existing === null || existing === undefined ? "# DECISIONS\n" : String(existing);
  text = text.replace(/^(## Entries[ \t]*\r?\n)\s*\(none yet\)[ \t]*(\r?\n|$)/m, "$1");
  if (!text.endsWith("\n")) text += "\n";
  const body = fields.map(([k, v]) => `- ${k}: ${String(v).replace(/\s*\r?\n\s*/g, " ")}`).join("\n");
  return `${text}\n## ${id} (${date}, ${step}) ${title}\n${body}\n`;
}

function cmdAnswer(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const text = args.join(" ").trim();
  if (!text) { io.err('autoclaude: usage: autoclaude answer "<your answer>"'); return 2; }
  const state = loadState(project.root);
  if (!(state.status === STATUS.paused && state.pauseReason === "blocked")) {
    io.out(`autoclaude: nothing is waiting for an answer (the run is ${describeState(state)})`);
    return 1;
  }
  const plan = loadPlan(project);
  if (plan.problems.length) {
    io.out(`autoclaude: not resuming, ${project.config.plan} has ${plan.problems.length} problem(s):`);
    io.out(formatLint(plan.problems));
    return 1;
  }
  const at = io.now().toISOString();
  const step = state.currentStep || "?";
  const question = state.lastBlockedQuestion || "(the question was not recorded)";
  const file = path.join(project.root, project.config.docs.decisions);
  const existing = readText(file, null);
  const id = nextDecisionId(existing || "");
  ensureDir(path.dirname(file));
  writeFileAtomic(file, appendDecisionEntry(existing, {
    id, date: at.slice(0, 10), step, title: "Owner answer to a blocked question",
    fields: [["Question", question], ["Answer", text], ["Decided by", "the owner, with `autoclaude answer`"]]
  }));
  const changes = resumeRun(project, state, { ownerAnswer: { step, question, answer: text, at, decisionId: id }, lastBlockedQuestion: null });
  io.out(`autoclaude: answer recorded in ${project.config.docs.decisions} as ${id}; the run is going again on ${loadState(project.root).currentStep || "?"}.`);
  io.out("  Claude gets the answer at its next session start and in the gate's next message.");
  for (const c of changes) io.out(`  ${c}`);
  return 0;
}

// ---------- lint-plan / usage ----------

function cmdLintPlan(args, io) {
  let file = args[0];
  if (!file) {
    const project = requireProject(io, { needConfig: false });
    if (!project) return 1;
    file = path.join(project.root, project.config.plan);
  } else {
    file = path.resolve(io.cwd, file);
  }
  const text = readText(file, null);
  if (text === null) { io.out(`autoclaude: plan file not found: ${file}`); return 1; }
  const parsed = parsePlan(text);
  const problems = lintPlan(parsed);
  if (problems.length) {
    io.out(`autoclaude: ${file} has ${problems.length} problem(s):`);
    io.out(formatLint(problems));
    return 1;
  }
  const p = progress(parsed);
  io.out(`autoclaude: ${file} ok: ${p.total} steps in ${parsed.phases.length} phases (${p.done} verified, ${p.todo} to do${p.failed ? `, ${p.failed} failed` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""})`);
  return 0;
}

function cmdUsage(args, io) {
  const u = readUsage({ now: io.now().getTime() });
  io.out(formatUsage(u, io.now().getTime()));
  return u.source ? 0 : 1;
}

// ---------- install-cli ----------

function cmdInstallCli(args, io) {
  const dir = io.env.AUTOCLAUDE_BIN_DIR || binDir();
  const updatePath = !args.includes("--no-path");
  ensureDir(dir);
  // The shims run the launcher, which finds the current plugin install each time, so they keep
  // working after a plugin update moves the plugin to a new versioned folder (D42).
  const entry = installLauncher({ dir });
  const node = process.execPath;
  // Two shims on Windows, like npm ships: autoclaude.cmd for cmd and PowerShell, and an
  // extensionless sh script for Git Bash, which is the shell Claude Code's Bash tool uses there
  // and which does not resolve .cmd files by bare name (seen in the first live run).
  const shim = path.join(dir, "autoclaude");
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${node.replace(/\\/g, "/")}" "${entry.replace(/\\/g, "/")}" "$@"\n`);
  try { fs.chmodSync(shim, 0o755); } catch {}
  const written = [shim];
  if (isWindows) {
    const cmdShim = path.join(dir, "autoclaude.cmd");
    fs.writeFileSync(cmdShim, `@echo off\r\n"${node}" "${entry}" %*\r\n`);
    written.push(cmdShim);
  }
  io.out(`autoclaude: wrote ${written.join(" and ")}`);
  const onPath = (io.env.PATH || io.env.Path || "").split(path.delimiter).some((d) => path.resolve(d) === path.resolve(dir));
  if (onPath) { io.out("  that directory is already on your PATH"); return 0; }
  if (!updatePath) { io.out(`  add ${dir} to your PATH to use \`autoclaude\` directly`); return 0; }
  if (isWindows) {
    // PowerShell 5.1 ships with every Windows; SetEnvironmentVariable persists to HKCU and broadcasts the change.
    const ps = `$d='${dir.replace(/'/g, "''")}'; $p=[Environment]::GetEnvironmentVariable('Path','User'); if (($p -split ';') -contains $d) { 'already' } else { [Environment]::SetEnvironmentVariable('Path', (($p.TrimEnd(';') + ';' + $d).TrimStart(';')), 'User'); 'added' }`;
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps], { encoding: "utf8", windowsHide: true });
    if (r.status === 0) {
      io.out(`  ${String(r.stdout).trim() === "added" ? "added to" : "already in"} your user PATH. Open a new terminal to use \`autoclaude\`.`);
      io.out("  Note: terminals inside VS Code keep the PATH VS Code started with; close VS Code fully and reopen it, or use a Start-menu PowerShell.");
      return 0;
    }
    io.out(`  could not update the user PATH (${String(r.stderr || r.error).trim().slice(0, 200)}); add ${dir} to it by hand`);
    return 1;
  }
  io.out(`  add this line to your shell profile, then open a new terminal:\n    export PATH="${dir}:$PATH"`);
  return 0;
}

// ---------- notify-setup / notify-test ----------

const mask = (s) => (s ? s.slice(0, Math.min(12, s.length)) + "..." + s.slice(-4) : "(not set)");

// An ntfy topic is the secret itself (anyone who knows it can read and post): show the host and
// the first 3 characters of the topic only.
export function maskNtfyUrl(url) {
  if (!url) return "(not set)";
  const m = String(url).match(/^(https?:\/\/[^/]+\/)(.*)$/i);
  if (!m) return mask(String(url));
  return `${m[1]}${m[2].slice(0, 3)}...`;
}

function cmdNotifySetup(args, io) {
  const file = machinePaths().notifyFile;
  const values = {};
  // Giving a URL picks its channel (the last one given wins); an explicit --channel always wins.
  let explicitChannel = null;
  let impliedChannel = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => { const v = args[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--channel") explicitChannel = next().toLowerCase();
    else if (a === "--ntfy") { values.ntfy_url = next(); impliedChannel = "ntfy"; }
    else if (a === "--ntfy-token") values.ntfy_token = next();
    else if (a === "--discord") { values.discord_webhook = next(); impliedChannel = "discord"; }
    else if (a === "--clear") { values.channel = null; values.ntfy_url = null; values.ntfy_token = null; values.discord_webhook = null; impliedChannel = null; }
    else if (a === "--show") { /* handled below */ }
    else throw new Error(`unknown option ${a}`);
  }
  if (explicitChannel) values.channel = explicitChannel;
  else if (impliedChannel) values.channel = impliedChannel;
  if (values.channel && !["ntfy", "discord", "stdout"].includes(values.channel)) throw new Error("--channel must be ntfy, discord or stdout");
  if (values.ntfy_url && !/^https?:\/\//.test(values.ntfy_url)) throw new Error("--ntfy needs a full topic URL such as https://ntfy.sh/your-topic");
  if (values.discord_webhook && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(values.discord_webhook)) throw new Error("--discord needs a Discord webhook URL");
  const stored = Object.keys(values).length ? writeMachineNotify(values, file) : readMachineNotify(file);
  const resolved = resolveChannel({}, io.env, file);
  io.out(`autoclaude: notification settings for this machine are in ${file} (never commit this file)`);
  io.out(`  channel: ${resolved.channel}${stored.channel ? "" : " (auto)"}`);
  io.out(`  ntfy_url: ${maskNtfyUrl(stored.ntfy_url)}`);
  io.out(`  ntfy_token: ${stored.ntfy_token ? "(set)" : "(not set)"}`);
  io.out(`  discord_webhook: ${mask(stored.discord_webhook)}`);
  if (resolved.channel === "stdout" && stored.channel === "stdout") io.out("  stdout is chosen: alerts only go to the log (`--channel ntfy` or `--channel discord` changes that)");
  else if (resolved.channel === "stdout") io.out("  nothing will reach a phone until --ntfy or --discord is set (or the plugin's userConfig, which hook processes read)");
  return 0;
}

async function cmdNotifyTest(args, io) {
  const message = args.join(" ").trim() || `AutoClaude test notification from ${io.env.COMPUTERNAME || io.env.HOSTNAME || "this machine"} at ${io.now().toISOString()}`;
  const logFile = path.join(machinePaths().logsDir, "notify.log");
  const r = await notify({ title: "AutoClaude test", message, priority: "default", tags: ["white_check_mark"] }, { logFile, stdout: io.stdoutStream, env: io.env });
  if (r.ok && !r.fallback) io.out(`autoclaude: sent through ${r.channel}${r.status ? ` (HTTP ${r.status})` : ""}. Log: ${logFile}`);
  else io.out(`autoclaude: ${r.channel} delivery failed (${r.error}); printed above instead. Log: ${logFile}`);
  if (r.channel === "stdout") io.out("  no channel is configured: run `autoclaude notify-setup --discord <webhook>` or `--ntfy <topic url>`; every AutoClaude process on this machine reads that setting");
  return r.ok ? 0 : 1;
}
