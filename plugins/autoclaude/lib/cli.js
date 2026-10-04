// Command dispatch for bin/autoclaude.js. Node built-ins only.
// Phase 1 commands: status, pause, note, resume, lint-plan, usage, install-cli, notify-test.
// Later phases add init, run, supervise, start, ready, blocked, answer, watchdog.
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { findProjectRoot, projectPaths, pluginRoot, binDir, machinePaths, isWindows } from "./paths.js";
import { loadConfig, formatConfigErrors, readRunPlan, clearRunPlan, resolveRunPlanSource, runPlanFile, updateProjectConfig } from "./config.js";
import { loadState, updateState, describeState, STATUS, hasMainStateKept, readMainStateKept, restoreMainState, finishRunPlan, beginRunPlan, mainStateFile } from "./state.js";
import { handoffFileFor } from "./handoff.js";
import { parsePlan, lintPlan, formatLint, stepById, nextStep, progress } from "./plan.js";
import { readUsage, formatUsage } from "./usage.js";
import { notify, readMachineNotify, writeMachineNotify, resolveChannel } from "./notify.js";
import { readText, readJson, appendLine, ageMs, ensureDir, writeFileAtomic, writeJsonAtomic } from "./fsatomic.js";
import { isPidAlive, findOnPath } from "./proc.js";
import { initProject, formatInitReport } from "./init.js";
import { writeReady, writeBlocked, readReady } from "./protocol.js";
import { firstUnfinished, planSlug, setMarker, isFinished, MARKERS } from "./plan.js";
import * as git from "./git.js";
import { resumeRun, commitPending, stagedVerification, stagedPartsText } from "./resume.js";
import { preflight, formatPreflight } from "./preflight.js";
import { supervise } from "./supervisor.js";
import { openConsoleWindow, isPidAlive as pidAlive } from "./proc.js";
import { registerProject } from "./registry.js";
import { installLauncher } from "./launcher.js";
import { runChecks, checksEnv, describeChecksEnv, recordRunEnv, recordCheckTimes, readCheckTimes } from "./checks.js";
import { estimatePlan, formatPlanEstimate } from "./estimate.js";
import { restartDevServer, stopDevServer, devServerInfo } from "./devserver.js";
import { runDecider, runHeadless } from "./headless.js";
import { stepText } from "./plan.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8")).version;

const HELP = `autoclaude ${VERSION}

Usage: autoclaude <command> [options]
       autoclaude <command> --help   (one command's usage)

Project commands (run inside a project):
  init [<folder>] [--playwright] [--no-statusline] [--dev-url <url>] [--dir <folder>]
                        Set the project up (the current folder unless one is given): config, doc
                        set, .gitignore, browser-tester config, machine registry, statusline
                        bridge. Never overwrites existing files.
  run [--check] [--plan <file>]
                        Preflight, then open the ac-<project> window where the supervisor runs the
                        build. A finished plan with new steps added starts a fresh run. Records
                        this terminal's PATH, which the gate and \`autoclaude checks\` then use.
                        --check: only run and print the preflight; opens no window.
                        --plan <file>: run a generated plan instead of the project's own: a
                        sweep's SECURITY_PLAN.md or OPTIMIZE_PLAN.md, from the sweep's folder
                        (.autoclaude/sweeps/<id>/) or committed in the project. Once the preflight
                        passes: a new branch from this commit, the plan committed there, and the
                        project's own plan and run state kept aside until this run completes.
                        Refused while another run is running or paused; changes nothing on --check
  security [options]    Run a security sweep in its own window (whole-codebase review, secret and
                        dependency scans, config and live checks), every finding independently
                        verified. Writes a report, a fix plan (--plan), or fixes through a gated
                        run (--fix). Options below
  optimize [options]    Run an optimize sweep (unused code and packages, duplicates, performance,
                        poorly built features, test-suite speed). Same report/plan/fix options
                        --report | --plan | --fix   what happens after the sweep (default: config)
                        --depth thorough|standard|quick   how hard each finding is checked
                        --modules a,b,c    only these modules (default: all for the kind)
                        --no-browser       no browser session (security: no live checks;
                                           optimize: no page timings, its code review stays)
                        --url <target>     add a target URL (the local dev server is added by default)
                        --exclude <glob>   leave files out (repeatable)
                        --no-advisories    do not send package names to npm/OSV
                        --writes           allow write tests (only on a throwaway database)
                        --reset "<cmd>"    the command that resets that database
                        --options <file>   a JSON file of the full options (flags win over it)
                        --estimate         print the sessions and rough time only; starts nothing
  sweep-run <id>        Drive or resume the sweep <id>; the sweep window runs this and it picks up
                        where it left off after a crash or restart. Run by hand, it also resumes
                        a sweep stopped with sweep-stop (--auto, which the windows AutoClaude
                        opens pass, leaves a stopped sweep alone)
  sweep-stop [<id>]     Stop a sweep for good: it is marked stopped, its window and the sessions
                        it runs are ended, and the watchdog leaves it alone (closing the window
                        is not enough: the watchdog opens it again). Without an id, the sweep
                        that is running or waiting. Finished work is kept, and sweep-run <id>
                        resumes it where it stopped
  sweep-status          This project's sweeps (running, waiting, paused, stopped, done, failed);
                        one whose window is gone shows as stopped, with the command that carries
                        it on and the one that stops it for good
  status [--all]        State, current step, attempts, usage, a running sweep, a run-plan override, last progress (--all: every registered project)
  config                Open the settings page in your browser, served from this computer only:
                        this project's settings, this computer's defaults, the alert channel,
                        the watchdog and the status line
  checks                Run the configured checks the way the gate does (with the PATH the run
                        recorded, starting the dev server first when a check needs it) and print
                        one line per check. The times of the checks that pass are recorded for
                        the phase estimates of lint-plan and run --check
  guard-test "<command>"
                        Show whether the run's tool guard would allow this command in the Bash
                        tool and in the PowerShell tool, and why not
  start [--no-preflight]  Preflight, create the run branch, set the run going (the run window does this)
  supervise             The supervisor loop itself (what \`run\` starts in the window)
  nudge "<prompt>"      Restart the running session now with this prompt (for example "/compact")
  ready [<step>]        Builder: tell the gate the current step is done (verified on the next stop)
  blocked <step> "<q>"  Builder: stop the run with a question only the owner can answer
  decide "<question>"   Builder: settle an open question now with the decider, a read-only Claude
                        session that reads the plan and the decisions log, and wait for it.
                        Prints JSON: classification, recommendation, reasoning,
                        question_for_owner, owner_review. Exit 1 only if the decider could not run
  answer "<text>"       Owner: answer the blocked question; recorded as a decision, the run resumes
  pause [--now]         Pause after the next committed step. --now pauses at once: the supervisor
                        ends the builder session and the dev server is stopped
  note "<text>"         Leave a review note for Claude; it is read on the next resume or session start
  resume                Clear a pause and set the run going again (refuses if PLAN.md fails lint)
  lint-plan [file]      Check the plan against the step format, then estimate each unfinished
                        phase's verification (each check at its recorded time, the browser tester
                        by its Accept lines, the bug bash, the security review) and print a
                        WARNING for a phase whose largest part needs more than gate.fitPct percent
                        of gate.timeoutSec. The warnings do not change the exit code
  verify-per-step <phase> [--off]
                        Verify that phase step by step instead of as one feature (adds it to
                        gate.stepPhases in autoclaude.config.json), for a plan already running out
                        of time; \`autoclaude resume\` then carries on without the plan being
                        rewritten. Refused while the run is running (pause it first).
                        --off: verify the phase as one feature again

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

// Every command runCli knows, for `<command> --help`.
export const COMMANDS = ["help", "version", "init", "status", "config", "run", "security", "optimize", "sweep-run", "sweep-stop", "sweep-status", "checks", "guard-test", "supervise", "nudge", "watchdog", "uninstall", "start", "ready", "blocked", "decide", "answer", "pause", "note", "resume", "lint-plan", "verify-per-step", "usage", "install-cli", "notify-setup", "notify-test"];
// Commands whose arguments are free text: only a first argument of --help or -h asks for help,
// so a note or a question that mentions -h is left alone.
const TEXT_COMMANDS = ["nudge", "blocked", "decide", "answer", "note", "guard-test", "notify-test"];

// One command's entry in HELP: its line and the more deeply indented lines under it.
export function commandHelp(cmd) {
  const lines = HELP.split("\n");
  const start = lines.findIndex((l) => {
    const m = l.match(/^ {2}(\S+)/);
    return !!m && m[1] === cmd;
  });
  if (start < 0) return null;
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length && /^ {3,}\S/.test(lines[i]); i++) out.push(lines[i]);
  return out.join("\n");
}

function wantsHelp(cmd, rest) {
  if (!COMMANDS.includes(cmd) || cmd === "help") return false;
  const isHelp = (a) => a === "--help" || a === "-h";
  return TEXT_COMMANDS.includes(cmd) ? isHelp(rest[0]) : rest.some(isHelp);
}

export async function runCli(argv, rawIo = {}) {
  const io = new Io(rawIo);
  const [cmd = "help", ...rest] = argv;
  if (wantsHelp(cmd, rest)) {
    const entry = commandHelp(cmd);
    io.out(entry ? `Usage: autoclaude ${cmd} ...\n\n${entry}` : HELP.trimEnd());
    return 0;
  }
  try {
    switch (cmd) {
      case "help": case "--help": case "-h": io.out(HELP.trimEnd()); return 0;
      case "version": case "--version": case "-v": io.out(VERSION); return 0;
      // Async commands are awaited, so one that throws (a bad option, say) ends in the catch
      // below with a message instead of escaping as a rejected promise.
      case "init": return cmdInit(rest, io);
      case "status": return await cmdStatus(rest, io);
      case "config": return await cmdConfig(rest, io);
      case "run": return await cmdRun(rest, io);
      case "security": return await cmdSweepStart("security", rest, io);
      case "optimize": return await cmdSweepStart("optimize", rest, io);
      case "sweep-run": return await cmdSweepRun(rest, io);
      case "sweep-stop": return await cmdSweepStop(rest, io);
      case "sweep-status": return await cmdSweepStatus(rest, io);
      case "checks": return await cmdChecks(rest, io);
      case "guard-test": return await cmdGuardTest(rest, io);
      case "supervise": return await cmdSupervise(rest, io);
      case "nudge": return cmdNudge(rest, io);
      case "watchdog": return await cmdWatchdog(rest, io);
      case "uninstall": return await cmdUninstall(rest, io);
      case "start": return await cmdStart(rest, io);
      case "ready": return cmdReady(rest, io);
      case "blocked": return cmdBlocked(rest, io);
      case "decide": return await cmdDecide(rest, io);
      case "answer": return cmdAnswer(rest, io);
      case "pause": return await cmdPause(rest, io);
      case "note": return cmdNote(rest, io);
      case "resume": return await cmdResume(rest, io);
      case "lint-plan": return cmdLintPlan(rest, io);
      case "verify-per-step": return cmdVerifyPerStep(rest, io);
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
  // Problems in this computer's defaults file are ignored, not fatal: say so once, on stderr so
  // a command whose stdout is data (decide prints JSON) stays parseable.
  const warnings = cfg.warnings || [];
  if (warnings.length) io.err(`autoclaude: note: ${warnings.length} setting(s) in this computer's defaults were ignored (${warnings.map((w) => w.path || "file").join(", ")}); \`autoclaude config\` shows why`);
  // mainPlan: the project's own plan, also while a run-plan override (`run --plan`) points
  // config.plan at a generated one.
  return { root, config: cfg.config, paths: projectPaths(root), mainPlan: cfg.mainPlan || cfg.config.plan, mainContinueHere: cfg.mainContinueHere, runPlan: cfg.runPlan || null };
}

function loadPlan(project) {
  const file = path.join(project.root, project.config.plan);
  const text = readText(file, null);
  if (text === null) return { file, parsed: null, problems: [{ line: 0, id: null, message: `plan file not found: ${file}` }] };
  const parsed = parsePlan(text);
  return { file, parsed, problems: lintPlan(parsed) };
}

// A function from another module, imported only when a command needs it, so a module that is
// missing or broken never stops the command. io.deps[name] replaces it in tests. Null when absent.
async function optional(io, file, name) {
  if (typeof io.deps[name] === "function") return io.deps[name];
  try {
    const m = await import(file);
    return typeof m[name] === "function" ? m[name] : null;
  } catch {
    return null;
  }
}

const SILENT = { write() { return true; } };

// An informational alert (notify.events, P8.6): sent only when the owner switched that event on,
// otherwise just logged. Never fails the command that sends it.
async function sendEvent(io, project, event, message) {
  const send = await optional(io, "./notify.js", "notifyEvent");
  if (!send) return;
  try { await send(project.root, project.config, event, message, { env: io.env, stdout: SILENT }); } catch {}
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

async function cmdStatus(args, io) {
  if (args.includes("--all")) return statusAll(io);
  const project = requireProject(io);
  if (!project) return 1;
  const { root, config, paths } = project;
  const state = loadState(root);
  const plan = loadPlan(project);
  io.out(`autoclaude: ${describeState(state)}  (${root})`);
  if (plan.parsed) {
    const p = progress(plan.parsed);
    io.out(`  plan: ${config.plan}, ${p.done}/${p.total} steps verified${p.built ? `, ${p.built} built and waiting for their feature's verification` : ""}${p.failed ? `, ${p.failed} failed` : ""}${p.blocked ? `, ${p.blocked} blocked` : ""}${plan.problems.length ? `, ${plan.problems.length} lint problem(s)` : ""}`);
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
  // A verification spread over turns (state.verifying, D60): the phase, the parts done and the
  // parts left.
  const staged = stagedVerification(state.verifying);
  if (staged) {
    const ph = staged.feature && staged.phase !== null && plan.parsed ? plan.parsed.phases.find((x) => x.num === staged.phase) : null;
    const what = ph ? `Phase ${ph.num} (${ph.title})` : staged.what;
    const alive = io.deps.isPidAlive || isPidAlive;
    const where = staged.parked
      ? `carried over to the next turn after ${staged.turns} stop${staged.turns === 1 ? "" : "s"}; the gate carries it on when the builder's turn ends`
      : state.verifying.pid && alive(state.verifying.pid)
        ? `the gate is at work on it (stop ${staged.turns + 1} of it)`
        : `cut off in stop ${staged.turns + 1} of it; the next stop takes it out`;
    const partsText = stagedPartsText(staged);
    io.out(`  verification: ${staged.fixup ? "the fix-up checks of " : ""}${what}${staged.feature ? `, at ${staged.stepId}` : ""}, ${where}${partsText ? `; ${partsText}` : ""}`);
  }
  if (state.pendingNotes.length) io.out(`  review notes waiting: ${state.pendingNotes.length}`);
  // An active run-plan override (a sweep's generated plan is the one `autoclaude run` uses, P10.7).
  try {
    const runPlanOverride = await optional(io, "./fixplan.js", "runPlanOverride");
    const over = runPlanOverride ? runPlanOverride(root) : null;
    if (over) io.out(`  run plan override: ${over} (\`autoclaude run\` uses this plan, not ${project.mainPlan || config.plan})`);
  } catch {}
  const last = state.lastRunPlan;
  if (last && last.plan) {
    const at = Date.parse(last.completedAt);
    io.out(`  last run on a generated plan: ${last.plan}${last.branch ? ` on ${last.branch}` : ""}, completed ${Number.isFinite(at) ? fmtAge(io.now().getTime() - at) : "earlier"}; its hand-back is ${handoffFileFor(last.plan)}`);
  }
  // A sweep still going in this project (P10.1); one whose window is gone shows as stopped, with
  // the command that carries it on.
  try {
    const { findActiveSweeps } = await import("./sweep.js");
    for (const s of findActiveSweeps(root, { isAlive: io.deps.isPidAlive })) io.out(`  ${describeSweepLine(s, io)}`);
  } catch {}
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

// ---------- config ----------

// The settings page (P8.7), served by lib/configpage.js until the owner clicks Done. Outside a
// project it shows this computer's defaults only, so no project is required.
async function cmdConfig(args, io) {
  if (args.length) throw new Error(`unknown option ${args[0]}`);
  let mod = null;
  try {
    mod = typeof io.deps.openConfigPage === "function" ? { openConfigPage: io.deps.openConfigPage } : await import(io.deps.configPageFile || "./configpage.js");
  } catch (e) {
    const missing = e && (e.code === "ERR_MODULE_NOT_FOUND" || /Cannot find module/.test(String(e.message)));
    io.err(missing
      ? "autoclaude: the config page is not in this install (lib/configpage.js is missing); edit autoclaude.config.json by hand"
      : `autoclaude: the config page could not load: ${e && e.message ? e.message : e}`);
    return 1;
  }
  if (typeof mod.openConfigPage !== "function") {
    io.err("autoclaude: the config page is not in this install (lib/configpage.js has no openConfigPage)");
    return 1;
  }
  // A folder AutoClaude was never set up in (a plain git repository) gets the computer's page only.
  const found = findProjectRoot(io.cwd);
  const root = found && fs.existsSync(projectPaths(found).configFile) ? found : null;
  const r = await mod.openConfigPage({ root, io });
  if (typeof r === "number") return r;
  return r && r.ok === false ? 1 : 0;
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

// What a plain `autoclaude run` does with a run-plan override (P10.7) before it starts:
// "hand-back" when the run on the generated plan completed (the gate does this itself; this is for
// a gate cut off before it), "drop" for an override with no run behind it (idle, and no state of
// the project's own kept aside: only `run --plan` sets both), "restore" for a kept state with no
// override at all (the override was deleted by hand), "keep" to bring back or start the run on the
// generated plan, and null when there is nothing to settle.
function runPlanSettlement(root) {
  const over = readRunPlan(root);
  const st = loadState(root);
  const kept = hasMainStateKept(root);
  if (over.plan) {
    if (st.status === STATUS.complete) return { action: "hand-back", plan: over.plan, kept };
    if (st.status === STATUS.idle && !kept) return { action: "drop", plan: over.plan, kept };
    return { action: "keep", plan: over.plan, kept };
  }
  if (!over.exists && kept && st.status !== STATUS.running && st.status !== STATUS.paused) return { action: "restore", plan: null, kept };
  return null;
}

async function cmdRun(args, io) {
  let checkOnly = false;
  let planFile = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--check") checkOnly = true;
    else if (a === "--plan") { planFile = args[++i]; if (!planFile) throw new Error("--plan needs a file"); }
    else throw new Error(`unknown option ${a}`);
  }
  if (planFile) return cmdRunPlan(planFile, { checkOnly }, io);
  // Settled before the config is read, so loadConfig (and every reader) sees the plan the run will
  // really work. --check changes nothing: it judges the project as the real run would find it.
  const found = findProjectRoot(io.cwd);
  const settle = found ? runPlanSettlement(found) : null;
  if (settle && !checkOnly) {
    if (settle.action === "hand-back") {
      const r = finishRunPlan(found, { completed: true, now: io.now() });
      io.out(`autoclaude: the run on ${settle.plan} is complete; the project's own plan${r.restored ? " and its run state are" : " is"} back`);
    } else if (settle.action === "drop") {
      clearRunPlan(found);
      io.out(`autoclaude: dropped the run plan override to ${settle.plan}: no run on it was started; the project's own plan is back`);
    } else if (settle.action === "restore") {
      restoreMainState(found);
      io.out("autoclaude: the project's own run state, kept aside for a run on a generated plan, is back (that run's override is gone)");
    }
  }
  const project = requireProject(io);
  if (!project) return 1;
  const { root } = project;
  let state = loadState(root);
  if (settle && checkOnly && settle.action !== "keep") {
    // The real run would settle first: judge the project's own plan and state, as it would.
    // The project's own resume file comes back with its plan (the override renamed it, D59).
    const docs = project.mainContinueHere ? { docs: { ...project.config.docs, continueHere: project.mainContinueHere } } : {};
    project.config = { ...project.config, plan: project.mainPlan, ...docs };
    state = (settle.kept && readMainStateKept(root)) || state;
    io.out(`autoclaude: \`autoclaude run\` would first hand the project back to its own plan, ${project.mainPlan}${settle.plan ? ` (the run plan override to ${settle.plan} ${settle.action === "drop" ? "has no run behind it" : "is complete"})` : ""}`);
  } else if (settle && settle.action === "keep") {
    io.out(`autoclaude: run plan override: this run works ${settle.plan} (set by \`autoclaude run --plan\`); the project's own plan, ${project.mainPlan}, and its state come back when it completes`);
  }
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
  // The checks are judged with this terminal's own PATH: the window, the builder and the gate
  // inherit it, and it is what gets recorded for `autoclaude checks` below. Only a check from Git
  // Bash (the planning session's Bash tool) is judged the way `autoclaude checks` judges it,
  // without Git Bash's own folders: the run itself is started from a terminal that has none.
  const gitBashCheck = checkOnly && !!io.env.MSYSTEM;
  const pf = await preflight(project, { env: io.env, checksEnv: gitBashCheck ? checksEnv(null, io.env).env : io.env, devServer: fresh, skip });
  io.out(`autoclaude: preflight${fresh ? "" : ` (a run is under way, ${describeState(state)}, so only the tools and the folder's trust are checked)`}`);
  if (gitBashCheck) io.out("  PATH for the checks: this shell's PATH without Git Bash's own folders, as `autoclaude run` from PowerShell or cmd would see it");
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
  const w = openRunWindow(root, io);
  if (!w.ok) {
    io.out(`autoclaude: ${w.error}`);
    io.out("  Nothing is running. Fix that and run `autoclaude run` again.");
    return 1;
  }
  io.out(`autoclaude: ${continuing ? "continuing the finished plan with its new steps" : fresh ? "starting the run" : `bringing back the ${state.status} run`} in a new window, ${w.title} (${w.method}).`);
  printRunHelp(io);
  return 0;
}

function printRunHelp(io) {
  io.out("  Watch:  the window, or `autoclaude status` from any terminal. Leave the window open; an RDP disconnect is fine, logging off is not.");
  io.out("  Stop:   `autoclaude pause` (after the current step is committed) or `autoclaude pause --now`.");
  io.out("  Notes:  `autoclaude note \"...\"` any time; they reach Claude at the next step or resume.");
}

// Registers the project, records this terminal's PATH for the checks, and opens the ac-<project>
// window running the supervisor. { ok, title, method } or { ok: false, title, error }.
function openRunWindow(root, io) {
  registerProject(root);
  recordRunEnv(root, io.env, { now: io.now });
  const title = `ac-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
  const open = io.deps.openConsoleWindow || openConsoleWindow;
  let r;
  try {
    r = open({
      title,
      cwd: root,
      program: process.execPath,
      args: [path.join(pluginRoot(), "bin", "autoclaude.js"), "supervise"],
      logFile: path.join(projectPaths(root).logsDir, "supervisor.log"),
      env: io.env
    });
  } catch (e) {
    return { ok: false, title, error: `could not open the window ${title}: ${e && e.message ? e.message : e}` };
  }
  if (r && r.method === "tmux" && r.ok === false) return { ok: false, title, error: `could not start the tmux session ${title}: ${String(r.stderr || "").trim() || "tmux failed"}` };
  return { ok: true, title, method: r && r.method };
}

// ---------- run --plan (P10.7) ----------

// Plan paths compared the way the file system may: case and slashes aside.
function samePlanPath(a, b) {
  const norm = (p) => String(p || "").replace(/\\/g, "/").replace(/^[.]\//, "").toLowerCase();
  return !!a && !!b && norm(a) === norm(b);
}

// The run branch for a generated plan, from its H1 like any run branch (config.branch's
// {planSlug}; autoclaude/{planSlug} when the project's template has none).
function runPlanBranchBase(config, parsed) {
  const template = typeof config.branch === "string" && config.branch.includes("{planSlug}") ? config.branch : "autoclaude/{planSlug}";
  return template.replace("{planSlug}", planSlug(parsed));
}

// The first of base, base-2, base-3 ... that is not a branch yet: a run on a generated plan always
// starts a new branch from the current commit, never an old branch tip. null when 99 are taken.
async function freeBranchName(root, base, env) {
  for (let n = 1; n < 100; n++) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!(await git.branchExists(root, name, { env }))) return name;
  }
  return null;
}

// The run files `run --plan` changes, as they are now, so a failure can put them back exactly.
function runFilesSnapshot(root) {
  const files = [runPlanFile(root), projectPaths(root).stateFile, mainStateFile(root)];
  return files.map((file) => ({ file, text: readText(file, null) }));
}

function restoreRunFiles(snapshot) {
  for (const { file, text } of snapshot) {
    try {
      if (text === null) fs.rmSync(file, { force: true });
      else writeFileAtomic(file, text);
    } catch {}
  }
}

// `autoclaude run --plan <file>`: work a generated plan (a sweep's SECURITY_PLAN.md or
// OPTIMIZE_PLAN.md, left in the sweep's folder or committed in the project) instead of the
// project's own. Refused while another run is running or paused. Nothing changes until the
// preflight passes on a clean tree; then: a new branch from the current commit, named from the
// plan's H1; the plan copied to the project root under its own name and committed there (when it
// came from a sweep's folder); the project's own run state kept aside; the run-plan override set;
// the window opened. A failure on the way undoes all of it, and --check changes nothing, so a
// refused or failed `run --plan` leaves no override, no branch and no state behind.
async function cmdRunPlan(planFile, { checkOnly }, io) {
  const found = findProjectRoot(io.cwd);
  if (!found) { io.out("autoclaude: not in a project (no autoclaude.config.json and no git repository found)"); return 1; }
  const abs = path.resolve(io.cwd, planFile);
  let isFile = false;
  try { isFile = fs.statSync(abs).isFile(); } catch {}
  if (!isFile) { io.out(`autoclaude: --plan file not found: ${abs}`); return 1; }
  const where = resolveRunPlanSource(found, abs);
  if (where.error) { io.out(`autoclaude: cannot run on that plan: it ${where.error}`); return 1; }
  const project = requireProject(io);
  if (!project) return 1;
  const { root } = project;
  const { source, target, sweepId } = where;
  const mainPlan = project.mainPlan || project.config.plan;
  if (samePlanPath(target, mainPlan)) {
    io.out(`autoclaude: not running ${source}: ${target} is the project's own plan, which \`autoclaude run\` runs`);
    return 1;
  }
  // Another run going: the override would switch its gate and hooks to this plan at once, and the
  // new branch would move the working tree from under it.
  const current = readRunPlan(root).plan;
  const st = loadState(root);
  const spid = supervisorPid(root);
  const live = st.status === STATUS.running || st.status === STATUS.paused;
  if (live || (spid && pidAlive(spid))) {
    const same = current && samePlanPath(current, target) ? ` To carry that run on, \`autoclaude run\`${st.status === STATUS.paused ? " (or `autoclaude resume`)" : ""}.` : "";
    io.out(`autoclaude: not running ${source}: a run of ${current || "the project's own plan"} is ${live ? st.status : "under way"} in this project. Let it finish (or pause it and finish it later), then run \`autoclaude run --plan ${source}\` again.${same}`);
    return 1;
  }
  const text = readText(path.join(root, source), "") || "";
  const parsed = parsePlan(text);
  // The preflight judges this plan, applied in memory only; the full preflight, as for a new run.
  const planProject = { ...project, config: { ...project.config, plan: source } };
  const gitBashCheck = checkOnly && !!io.env.MSYSTEM;
  const pf = await preflight(planProject, { env: io.env, checksEnv: gitBashCheck ? checksEnv(null, io.env).env : io.env, devServer: true, skip: [] });
  io.out(`autoclaude: preflight for ${source}`);
  if (gitBashCheck) io.out("  PATH for the checks: this shell's PATH without Git Bash's own folders, as `autoclaude run` from PowerShell or cmd would see it");
  io.out(formatPreflight(pf));
  const base = runPlanBranchBase(project.config, parsed);
  if (checkOnly) {
    io.out(pf.ok
      ? `autoclaude: preflight passed; \`autoclaude run --plan ${source}\` would create a new branch from this commit (${base}, or ${base}-2 and on when that exists), ${source !== target ? `commit the plan there as ${target}, ` : ""}and start the run on it; ${mainPlan} and its run state are left alone`
      : `autoclaude: preflight failed; fix the FAIL lines above before \`autoclaude run --plan ${source}\``);
    return pf.ok ? 0 : 1;
  }
  if (!pf.ok) { io.out("autoclaude: not starting; fix the FAIL lines above and run it again"); return 1; }

  const gitEnv = { ...io.env, PATH: io.env.PATH || io.env.Path || process.env.PATH };
  const startBranch = await git.currentBranch(root, { env: gitEnv });
  const startHead = await git.head(root, { env: gitEnv });
  const back = startBranch && startBranch !== "HEAD" ? startBranch : startHead;
  const branch = await freeBranchName(root, base, gitEnv);
  if (!branch) { io.out(`autoclaude: not starting: ${base} and ${base}-2 to ${base}-99 are all branches already; delete the old ones you have merged, then run it again`); return 1; }
  const made = await git.git(root, ["checkout", "-q", "-b", branch], { env: gitEnv });
  if (!made.ok) { io.out(`autoclaude: not starting: could not create the branch ${branch}: ${String(made.stderr || "").trim()}`); return 1; }

  const snapshot = runFilesSnapshot(root);
  const targetAbs = path.join(root, target);
  const targetExisted = fs.existsSync(targetAbs);
  let wrote = false;
  let committed = false;
  const undo = async (why) => {
    io.out(`autoclaude: not starting: ${why}`);
    restoreRunFiles(snapshot);
    // The plan file as this commit has it, then the starting branch back and the new one gone.
    if (wrote && !committed) {
      await git.git(root, ["reset", "-q", "--", target], { env: gitEnv });
      if (targetExisted) await git.git(root, ["checkout", "-q", "--", target], { env: gitEnv });
      else { try { fs.rmSync(targetAbs, { force: true }); } catch {} }
    }
    const co = back ? await git.git(root, ["checkout", "-q", back], { env: gitEnv }) : { ok: false, stderr: "no commit to go back to" };
    const del = co.ok ? await git.git(root, ["branch", "-q", "-D", branch], { env: gitEnv }) : { ok: false };
    if (co.ok && del.ok) io.out(`  Nothing is left behind: back on ${startBranch === "HEAD" ? String(back).slice(0, 7) : back}, the branch ${branch} is deleted, and no run plan is set.`);
    else io.out(`  No run plan is set, but the branch ${branch} is still there (${co.ok ? "it could not be deleted" : `could not go back to ${back}: ${String(co.stderr || "").trim()}`}). Remove it with \`git checkout ${back}\` and \`git branch -D ${branch}\`.`);
    return 1;
  };
  try {
    if (source !== target) {
      // The very text the preflight judged, committed where the gate can tick it.
      writeFileAtomic(targetAbs, text);
      wrote = true;
      const c = await git.commitAll(root, `autoclaude: fix plan from sweep ${sweepId}\n\nCopied from ${source} for \`autoclaude run --plan\`. The details of each finding stay in the sweep's gitignored report.\n`, { env: gitEnv });
      if (!c.ok) return await undo(`could not commit ${target} on ${branch}: ${String(c.stderr || "").trim()}`);
      committed = true;
    }
    const tracked = await git.git(root, ["ls-files", "--error-unmatch", "--", target], { env: gitEnv });
    if (!tracked.ok) return await undo(`${target} is not in git (a .gitignore rule?); the gate commits the plan's ticks, so the plan must be tracked`);
    beginRunPlan(root, target, { branch, source, sweepId }, { now: io.now() });
  } catch (e) {
    return await undo(e && e.message ? e.message : String(e));
  }
  const w = openRunWindow(root, io);
  if (!w.ok) return await undo(w.error);
  io.out(`autoclaude: running ${target} on the new branch ${branch} (from ${startBranch === "HEAD" ? String(startHead || "").slice(0, 7) : startBranch})${source !== target ? `, where ${target} is committed from ${source}` : ""}, in a new window, ${w.title} (${w.method}).`);
  io.out(`  ${mainPlan} and its run state are kept aside, and come back when this run completes. Its hand-back is ${handoffFileFor(target)}.`);
  printRunHelp(io);
  return 0;
}

// ---------- security / optimize sweeps ----------

// Parses the sweep flags shared by `security` and `optimize` into an options object for
// sweep.startSweep (which normalizes and validates it). --options <file> supplies the full
// object the skill wrote; flags override it.
function parseSweepArgs(args, io) {
  const opts = {};
  let fromFile = {};
  const exclude = [];
  const urls = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => { const v = args[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--report" || a === "--plan" || a === "--fix") opts.after = a.slice(2);
    else if (a === "--after") opts.after = next();
    else if (a === "--depth") opts.depth = next();
    else if (a === "--modules") opts.modules = next().split(",").map((s) => s.trim()).filter(Boolean);
    else if (a === "--no-browser") opts._noBrowser = true;
    else if (a === "--url") urls.push({ url: next(), mode: "readonly" });
    else if (a === "--exclude") exclude.push(next());
    else if (a === "--no-advisories") opts.advisories = false;
    else if (a === "--writes") opts.writesAllowed = true;
    else if (a === "--reset") opts.resetCommand = next();
    else if (a === "--options") {
      const file = path.resolve(io.cwd, next());
      const raw = readJson(file, null);
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`--options file is not a JSON object: ${file}`);
      fromFile = raw;
    } else if (a === "--yes" || a === "-y") { /* the skill already confirmed; accepted */ }
    else if (a === "--estimate") opts._estimate = true;
    else throw new Error(`unknown option ${a}`);
  }
  // The file gives the full set; a flag wins over it wherever both say something, wherever the
  // flag stands. --url and --exclude add to the file's lists.
  const merged = { ...fromFile, ...opts };
  if (urls.length) merged.targets = [...(Array.isArray(fromFile.targets) ? fromFile.targets : []), ...urls];
  if (exclude.length) merged.exclude = [...(Array.isArray(fromFile.exclude) ? fromFile.exclude : []), ...exclude];
  return merged;
}

// `autoclaude security` / `autoclaude optimize`: build the options, then start the sweep in its
// own window. The skills gather the options and call this; a person can also call it with flags.
async function cmdSweepStart(kind, args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  let opts;
  try { opts = parseSweepArgs(args, io); } catch (e) { io.err(`autoclaude: ${e.message}`); return 2; }
  const noBrowser = opts._noBrowser; delete opts._noBrowser;
  const estimateOnly = !!opts._estimate; delete opts._estimate;
  if (noBrowser) {
    // No browser session: security drops its live checks; optimize keeps its code-level
    // performance review and skips only the browser walk and the page timings.
    opts.browser = false;
    if (kind === "security") {
      const { MODULES } = await import("./sweep.js");
      opts.modules = (Array.isArray(opts.modules) ? opts.modules : (MODULES[kind] || [])).filter((m) => m !== "live");
    }
  }
  const startSweep = await optional(io, "./sweep.js", "startSweep");
  if (!startSweep) { io.out("autoclaude: this install cannot run sweeps (lib/sweep.js is missing)"); return 1; }
  // --estimate: the sessions and rough time this sweep would take; nothing is written or started.
  const r = await startSweep({ root: project.root, kind, options: opts, config: project.config, io, deps: io.deps, estimateOnly });
  if (!r.ok) { io.out(`autoclaude: could not ${estimateOnly ? "estimate" : "start"} the ${kind} sweep: ${r.error}`); return 1; }
  if (estimateOnly) return 0;
  // In the machine registry, so the watchdog can bring the sweep's window back (P10.1).
  try { registerProject(project.root); } catch {}
  io.out(`autoclaude: ${kind} sweep ${r.id} is running in a new window (${r.window && r.window.method}).`);
  io.out("  Watch:  the window, or `autoclaude sweep-status` from any terminal. Leave the window open; an RDP disconnect is fine, logging off is not.");
  io.out(`  Report: .autoclaude/sweeps/${r.id}/report.md when it finishes (gitignored).`);
  return 0;
}

// The command the sweep window runs: drive (or resume) the sweep, then, in "fix" mode, start the
// normal run on the generated plan. --auto marks a window AutoClaude opened (the start, the
// watchdog): it leaves a sweep the owner stopped alone. Run by hand without it, it resumes one.
async function cmdSweepRun(args, io) {
  const id = args.find((a) => !a.startsWith("-"));
  if (!id) { io.err("autoclaude: usage: autoclaude sweep-run <id>"); return 2; }
  const auto = args.includes("--auto");
  const project = requireProject(io);
  if (!project) return 1;
  const runSweep = await optional(io, "./sweep.js", "runSweep");
  if (!runSweep) { io.out("autoclaude: this install cannot run sweeps (lib/sweep.js is missing)"); return 1; }
  const r = await runSweep({ root: project.root, id, io, deps: io.deps, auto });
  if (!r.ok) { io.out(`autoclaude: sweep ${id} ${r.status || "failed"}${r.error ? `: ${r.error}` : ""}`); return 1; }
  if (r.status === "stopped") {
    io.out(r.already
      ? `autoclaude: sweep ${id} was stopped by the owner (\`autoclaude sweep-stop\`); this window leaves it alone. \`autoclaude sweep-run ${id}\` resumes it.`
      : `autoclaude: sweep ${id} stopped by the owner (\`autoclaude sweep-stop\`). Its finished work is kept; \`autoclaude sweep-run ${id}\` resumes it where it stopped.`);
    return 0;
  }
  if (r.status === "paused") {
    io.out(`autoclaude: sweep ${id} paused: ${r.reason}. Rerun \`autoclaude sweep-run ${id}\` when usage allows, or give it up with \`autoclaude sweep-stop ${id}\`.`);
    if (/weekly/i.test(String(r.reason || ""))) io.out("  After the weekly reset the watchdog carries it on by itself when usage.autoResumeAfterWeeklyReset is on and the watchdog is installed (`autoclaude watchdog --install`).");
    return 0;
  }
  io.out(`autoclaude: sweep ${id} ${r.status}${typeof r.confirmed === "number" ? ` (${r.confirmed} confirmed)` : ""}.`);
  // A check the green-baseline test could not judge (it needs a dev server that did not start).
  if (r.checksNote) io.out(`  note: ${r.checksNote}`);
  const planRel = r.planFile ? (path.isAbsolute(r.planFile) ? path.relative(project.root, r.planFile) : r.planFile).replace(/\\/g, "/") : null;
  if (r.startRun && planRel) {
    // `run --plan` makes the branch, commits the plan there and starts the run (P10.7).
    io.out(`autoclaude: starting the fix run on ${planRel}`);
    const code = await cmdRun(["--plan", path.resolve(project.root, planRel)], { ...io, cwd: project.root, out: (s) => io.out(s), err: (s) => io.err(s) });
    if (code !== 0) {
      // The finished alert said the run starts; say that it did not (the reason is in this
      // window, and never in the alert).
      const notifyEvent = await optional(io, "./notify.js", "notifyEvent");
      const name = path.basename(project.root);
      if (notifyEvent) await notifyEvent(project.root, project.config, "sweepFixNotStarted", { title: `AutoClaude: the fix run did not start (${name})`, message: `The fix plan is ${planRel}, but \`autoclaude run --plan ${planRel}\` stopped and changed nothing; the sweep window says why. Fix that, then run it again.`, priority: "high" }, { env: io.env, notify: io.deps.notify });
    }
    return code;
  }
  if (planRel && !(r.already && r.after === "fix")) {
    io.out(`  fix plan written: ${planRel}${r.fixRefused ? ` (fix right away was refused: ${r.fixRefused})` : ""}`);
    io.out(`  review it (edit it if you like), then \`autoclaude run --plan ${planRel}\` makes a new branch from the current commit, commits the plan there and starts the run; ${project.mainPlan || project.config.plan} and its run state are left alone`);
  }
  if (r.already && r.after === "fix" && planRel) io.out(`  this sweep finished earlier; if its fix run is not running (\`autoclaude status\`), start it with \`autoclaude run --plan ${planRel}\``);
  if (r.reportFile) io.out(`  report: ${(path.isAbsolute(r.reportFile) ? path.relative(project.root, r.reportFile) : r.reportFile).replace(/\\/g, "/")}`);
  return 0;
}

// `autoclaude sweep-stop [<id>]`: stop a sweep for good (sweep.stopSweep). Closing its window is
// not enough, since the watchdog opens it again; this marks it stopped, ends the window's process
// tree, and the watchdog leaves it alone. `sweep-run <id>` resumes it on purpose.
async function cmdSweepStop(args, io) {
  const flag = args.find((a) => a.startsWith("-"));
  if (flag) throw new Error(`unknown option ${flag}`);
  if (args.length > 1) { io.err("autoclaude: usage: autoclaude sweep-stop [<id>]"); return 2; }
  const project = requireProject(io, { needConfig: false });
  if (!project) return 1;
  const stopSweep = await optional(io, "./sweep.js", "stopSweep");
  if (!stopSweep) { io.out("autoclaude: this install cannot run sweeps (lib/sweep.js is missing)"); return 1; }
  const r = stopSweep({ root: project.root, id: args[0] || null, now: io.now().getTime(), deps: io.deps });
  if (!r.ok) { io.out(`autoclaude: ${r.error}`); return 1; }
  if (r.already) { io.out(`autoclaude: sweep ${r.id} is already stopped; \`autoclaude sweep-run ${r.id}\` resumes it.`); return 0; }
  const ended = r.killed ? "; its window and the sessions it ran are ended"
    : r.pid ? `; its process ${r.pid} did not end when asked, but the sweep checks before every session and stops by itself` : "";
  io.out(`autoclaude: sweep ${r.id} stopped (it was ${r.from}${r.stage ? ` at stage ${r.stage}` : ""})${ended}${r.devServerStopped ? "; the dev server it started is stopped" : ""}.`);
  io.out(`  It stays stopped: the watchdog leaves it alone. Its finished work is kept in .autoclaude/sweeps/${r.id}/; \`autoclaude sweep-run ${r.id}\` resumes it where it stopped.`);
  return 0;
}

// One sweep as `status` shows it (sweep.describeSweep's displayStatus: a sweep whose window is
// gone reads "stopped (window gone)"), with the command that carries a stopped or paused one on
// and the one that stops it for good.
function describeSweepLine(s, io) {
  const started = Date.parse(s.startedAt);
  const resume = s.resumeCommand ? `; carry it on with \`${s.resumeCommand}\`` : "";
  const stop = s.stopCommand ? `${resume ? ", or stop it for good with" : "; stop it with"} \`${s.stopCommand}\`` : "";
  return `sweep: ${s.kind} ${s.displayStatus || s.status}${sweepStageText(s)}${Number.isFinite(started) ? `, started ${fmtAge(io.now().getTime() - started)}` : ""}${resume}${stop}`;
}

// " (stage review)" for a sweep going, " at stage review" for one whose window is gone or that the
// owner stopped.
function sweepStageText(s) {
  if (s.status === "stopped") return s.stage ? ` at stage ${s.stage}` : "";
  if (s.status !== "running" && s.status !== "waiting") return "";
  return s.liveness === "dead" ? ` at stage ${s.stage}` : ` (stage ${s.stage})`;
}

async function cmdSweepStatus(args, io) {
  if (args.length) throw new Error(`unknown option ${args[0]}`);
  const project = requireProject(io, { needConfig: false });
  if (!project) return 1;
  const { sweepStatus } = await import("./sweep.js");
  const { sweeps } = sweepStatus(project.root, { isAlive: io.deps.isPidAlive });
  if (!sweeps.length) { io.out("autoclaude: no sweeps in this project yet (`autoclaude security` or `autoclaude optimize` starts one)"); return 0; }
  for (const s of sweeps) {
    const counts = s.result && typeof s.result.confirmed === "number" ? `, ${s.result.confirmed} confirmed` : "";
    // The real verification count, known once the findings are merged (scanner hits included).
    const verify = typeof s.verifySessions === "number" && s.status !== "done" ? `, ${s.verifySessions} verification session${s.verifySessions === 1 ? "" : "s"}` : "";
    io.out(`  ${s.id}: ${s.displayStatus || s.status}${sweepStageText(s)}${counts}${verify}${s.error ? ` - ${s.error}` : ""}`);
    if (s.status === "stopped") io.out(`    the watchdog leaves it alone; \`${s.resumeCommand}\` resumes it where it stopped`);
    else if (s.resumeCommand) io.out(`    carry it on with \`${s.resumeCommand}\`${s.liveness === "dead" ? " (its window is gone: closed, logged off or restarted)" : ""}`);
    if (s.stopCommand) io.out(`    stop it for good with \`${s.stopCommand}\`${s.liveness === "alive" || s.liveness === "starting" ? " (closing its window is not enough when the watchdog is installed: it opens the window again)" : ""}`);
    if (s.status === "done" && s.result && s.result.runCommand && s.result.after === "plan") io.out(`    fix plan: ${s.result.planFile}; run it with \`${s.result.runCommand}\``);
  }
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
  // The gate's environment, so a pass here means a pass there (P8.4).
  const ce = checksEnv(root, io.env);
  io.out(`autoclaude: running ${config.checks.length} check(s) in ${root}`);
  io.out(`  PATH: ${describeChecksEnv(ce)}`);
  const needsServer = config.checks.some((c) => c.needsDevServer);
  let devServerReady = false;
  let stopAfter = false;
  if (needsServer && config.devServer.command && config.devServer.url) {
    // Like the preflight: a server that was already recorded (a run's) is left running after.
    stopAfter = !devServerInfo({ root });
    const ds = await restart(config.devServer, { root, env: ce.env });
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
    result = await runChecks(config.checks, { cwd: root, env: ce.env, devServerReady, onProgress: (r) => io.out(line(r)) });
  } finally {
    if (stopAfter) stop({ root });
  }
  for (const r of result.results) if (r.skipped) io.out(line(r));
  // The phase estimates (lint-plan, run --check, planning) use these times (P10.13).
  recordCheckTimes(root, result.results);
  if (result.ok) {
    io.out(`autoclaude: all ${result.results.length} check(s) passed; their times are recorded for the phase estimates`);
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
  // `autoclaude uninstall` typed in cmd or PowerShell runs through autoclaude.cmd, and cmd reads
  // a batch file again after each command: deleting it now ends the command with "The system
  // cannot find the path specified". On Windows it (and the folder) go a moment after we exit.
  const cmdShim = path.join(dir, "autoclaude.cmd");
  const later = win && files.includes(cmdShim);
  for (const f of files) if (!(later && f === cmdShim)) fs.rmSync(f, { force: true });
  if (later) (io.deps.deleteLater || deleteAfterExit)(cmdShim, dir);
  io.out(`  command shims: ${files.length ? `removed ${files.length} file(s) from ${dir}` : "none found"}`);
  if (win) {
    // On Windows the folder is AutoClaude's own (%LOCALAPPDATA%\autoclaude\bin), and so is its
    // PATH entry. Elsewhere it is ~/.local/bin, shared with other tools: the folder and PATH stay.
    try { if (!later && fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir); } catch {}
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

// Deletes `file` about two seconds from now, from a detached hidden cmd, then removes `dir` if it
// is empty by then. Windows only.
function deleteAfterExit(file, dir) {
  const line = `ping -n 3 127.0.0.1 >nul & del /f /q "${file}" >nul 2>&1 & rd "${dir}" >nul 2>&1`;
  try {
    const child = spawn("cmd.exe", ["/d", "/s", "/c", `"${line}"`], { detached: true, stdio: "ignore", windowsVerbatimArguments: true, windowsHide: true });
    child.unref();
  } catch {}
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
  for (const r of results) if (r.action !== "not-running") io.out(`${r.root}${r.sweep ? ` (sweep ${r.sweep})` : ""}: ${r.action}${r.error ? ` (${r.error})` : ""}`);
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
  // A run on a generated plan works on the new branch `run --plan` made for it (P10.7).
  const over = readRunPlan(root);
  const runPlanBranch = over.plan && over.plan === config.plan && over.branch ? over.branch : null;
  const branch = runPlanBranch || config.branch.replace("{planSlug}", planSlug(plan.parsed));
  // A finished plan continued with new steps finds the run branch of the last run still there.
  // Checking it out as it is would drop steps committed elsewhere (say, on main after a merge).
  const onBranch = await git.currentBranch(root, { env: gitEnv });
  if (!runPlanBranch && onBranch !== branch && (await git.branchExists(root, branch, { env: gitEnv }))) {
    const merged = await git.git(root, ["merge-base", "--is-ancestor", branch, "HEAD"], { env: gitEnv });
    if (merged.ok) {
      // Everything on the old run branch is already here, so moving it forward loses nothing.
      const moved = await git.git(root, ["branch", "-f", branch, "HEAD"], { env: gitEnv });
      if (!moved.ok) { io.out(`autoclaude: could not move ${branch} forward to ${onBranch}: ${moved.stderr.trim()}`); return 1; }
    } else {
      const there = await git.git(root, ["show", `${branch}:${config.plan.replace(/\\/g, "/")}`], { env: gitEnv });
      const theirs = there.ok ? stepById(parsePlan(there.stdout), first.id) : null;
      if (!theirs || isFinished(theirs)) {
        io.out(`autoclaude: not starting; the run branch ${branch} is left from an earlier run, and its ${config.plan} does not have ${first.id} to do. Merge ${onBranch || "this branch"} into ${branch}, or rename the old one (git branch -m ${branch} ${branch}-old), then run again.`);
        return 1;
      }
    }
  }
  const co = await git.checkoutBranch(root, branch, { create: true, env: gitEnv });
  if (!co.ok) { io.out(`autoclaude: could not check out ${branch}: ${co.stderr}`); return 1; }
  // Built [~] steps count as ticked too: the gate recorded them, and the integrity check would
  // otherwise revert them.
  const ticked = plan.parsed.steps.filter((s) => isFinished(s)).map((s) => s.id);
  const now = io.now().toISOString();
  const baseCommit = await git.head(root, { env: gitEnv });
  const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now: io.now().getTime() });
  // Steps an earlier run verified but could not commit: start needs a clean tree, so they are
  // committed by now (by hand) or gone; `resume` must not commit later edits under their names.
  if ((state.uncommitted || []).length) io.out(`autoclaude: the last run verified ${state.uncommitted.join(", ")} but could not commit ${state.uncommitted.length === 1 ? "it" : "them"}; the working tree is clean, so that is taken as done.`);
  // Tags an earlier run could not push are still pushed with this run's next push.
  const leftTags = [];
  for (const t of (state.pushState && state.pushState.unpushedTags) || []) if (await git.tagExists(root, t, { env: gitEnv })) leftTags.push(t);
  // Where the decisions log stands, so the hand-back counts only this run's entries.
  const mark = await optional(io, "./summary.js", "decisionsMark");
  let decisionsAtStart = null;
  if (mark) { try { decisionsAtStart = mark(readText(path.join(root, config.docs.decisions), "") || ""); } catch {} }
  updateState(root, (s) => {
    s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.haltSession = false; s.currentStep = first.id;
    s.attempts = {}; s.infraFailures = {}; s.outOfTime = {}; s.noProgress = 0; s.recoveries = 0; s.tickedByGate = ticked; s.startedAt = now; s.stepStartedAt = now;
    s.headAtLastGate = null; s.toolCallsAtLastGate = 0; s.baseCommit = baseCommit; s.ownerAnswer = null; s.lastBlockedQuestion = null;
    s.usageAtStart = usage.sevenDay && !usage.stale ? usage.sevenDay.pct : null; s.weeklyResetsAt = null; s.decisionsAtStart = decisionsAtStart;
    s.uncommitted = []; s.uncommittedMessages = {}; s.lastRunPlan = null;
    // Nothing of an earlier run's feature carries over (D49), except the tags it could not push.
    s.fixup = null; s.freshSession = false; s.phaseBaseCommit = null; s.phaseStartedAt = null; s.closing = null; s.completing = null;
    s.pushState = leftTags.length ? { branch: null, remote: null, ok: false, skipped: false, at: (s.pushState && s.pushState.at) || null, error: (s.pushState && s.pushState.error) || "not pushed by the last run", unpushedCommits: null, unpushedTags: leftTags } : null;
  });
  if (leftTags.length) io.out(`  ${leftTags.join(", ")} ${leftTags.length === 1 ? "was" : "were"} not pushed by the last run; the next push takes ${leftTags.length === 1 ? "it" : "them"} along.`);
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
  // The machine's Docker state before the run touches it, so the end of the run can remove what
  // the run created and nothing else (P8.5). Last, so a slow Docker engine never holds back the
  // run rules above; the builder acts only after this command returns.
  const recordFootprint = await optional(io, "./footprint.js", "recordFootprintStart");
  if (recordFootprint) {
    try { await recordFootprint(root, {}); } catch (e) { io.out(`  (could not record the machine footprint: ${e && e.message ? e.message : e})`); }
  }
  const todo = plan.parsed.steps.filter((s) => !isFinished(s)).length;
  await sendEvent(io, project, "runStarted", { title: `AutoClaude started: ${path.basename(root)}`, message: `Running on branch ${branch}, ${todo} step(s) to do. First: ${first.id} ${first.title}.`, priority: "low" });
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

// The decider, synchronously (P8.4): the builder waits for the answer instead of starting the
// decider agent and carrying on. Prints the decision as JSON; exit 1 only when the decider itself
// could not run. Every call is logged to .autoclaude/logs/decide.log for the review.
async function cmdDecide(args, io) {
  const question = args.join(" ").trim();
  if (!question) { io.err('autoclaude: usage: autoclaude decide "<question, with the options you see>"'); return 2; }
  const project = requireProject(io);
  if (!project) return 1;
  const { root, config, paths } = project;
  const state = loadState(root);
  const plan = loadPlan(project);
  const step = plan.parsed && state.currentStep ? stepById(plan.parsed, state.currentStep) : null;
  const run = io.deps.runHeadless || runHeadless;
  const r = await runDecider({
    root,
    question,
    planFile: path.join(root, config.plan),
    decisionsFile: path.join(root, config.docs.decisions),
    model: (config.builder && config.builder.model) || "opus",
    effort: config.checkers ? config.checkers.effort : null,
    template: readText(path.join(pluginRoot(), "agents", "decider.md"), ""),
    step,
    stepText: step ? stepText(plan.parsed, step) : null,
    env: io.env,
    run
  });
  try {
    ensureDir(paths.logsDir);
    appendLine(path.join(paths.logsDir, "decide.log"), JSON.stringify({ at: io.now().toISOString(), step: state.currentStep || null, question, ok: r.ok, decision: r.decision, error: r.error, durationMs: r.durationMs, costUsd: r.costUsd }));
  } catch {}
  if (!r.ok) {
    io.err(`autoclaude: the decider could not answer: ${r.error}`);
    io.err("  Ask the autoclaude:decider agent with the Agent tool instead, in the foreground, and wait for its answer.");
    return 1;
  }
  io.out(JSON.stringify(r.decision, null, 2));
  return 0;
}

// ---------- pause / note / resume ----------

async function cmdPause(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const now = args.includes("--now");
  const name = path.basename(project.root);
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
    await sendEvent(io, project, "pausedByOwner", { title: `AutoClaude paused: ${name}`, message: `Paused now for review, on ${step}. \`autoclaude resume\` carries on.`, priority: "low" });
    return 0;
  }
  if (state.pauseRequested) {
    io.out("autoclaude: a pause is already requested; the gate will pause after the next committed step");
    return 0;
  }
  updateState(project.root, (s) => { s.pauseRequested = true; });
  io.out(`autoclaude: pause requested. The gate finishes ${state.currentStep || "the current step"}, commits it, then pauses for review. Use --now to stop immediately.`);
  await sendEvent(io, project, "pausedByOwner", { title: `AutoClaude pause requested: ${name}`, message: `The run pauses for review once ${state.currentStep || "the current step"} is committed.`, priority: "low" });
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
  const changes = resumeRun(project, state, {}, { env: io.env });
  const next = loadState(project.root);
  const notes = next.pendingNotes.length;
  io.out(`autoclaude: resumed on ${next.currentStep || "?"}${notes ? ` with ${notes} review note(s) waiting for Claude` : ""}. The supervisor nudges the session on its next pass.`);
  for (const c of changes) io.out(`  ${c}`);
  await sendEvent(io, project, "runResumed", { title: `AutoClaude resumed: ${path.basename(project.root)}`, message: `Resumed on ${next.currentStep || "?"}${notes ? `, with ${notes} review note(s) for Claude` : ""}.`, priority: "low" });
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
    fields: [["Question", question], ["Answer", text], ["By", "owner, with `autoclaude answer`"]]
  }));
  const changes = resumeRun(project, state, { ownerAnswer: { step, question, answer: text, at, decisionId: id }, lastBlockedQuestion: null }, { env: io.env });
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
  for (const l of planEstimateLines(parsed, io)) io.out(l);
  return 0;
}

// The per-phase verification estimate after a clean lint (P10.13, D60), with the settings of the
// project lint-plan runs in and the check times recorded there. Nothing outside a project that
// has its autoclaude.config.json: without its checks and dev server the numbers would mean
// nothing. A WARNING line never changes lint-plan's exit code.
function planEstimateLines(parsed, io) {
  const root = findProjectRoot(io.cwd);
  if (!root) return [];
  const cfg = loadConfig(root);
  if (!cfg.exists || cfg.errors.length) return [];
  const { lines, warnings } = formatPlanEstimate(estimatePlan(parsed, { config: cfg.config, checkTimes: readCheckTimes(root) }));
  return [...lines, ...warnings];
}

// ---------- verify-per-step ----------

// Marks a phase to be verified step by step (gate.stepPhases, P10.13): the way out for a plan
// already running whose feature keeps running out of time, without rewriting the plan. Written to
// the project's own autoclaude.config.json, like any setting; locked while the run is running, as
// on the settings page.
function cmdVerifyPerStep(args, io) {
  let off = false;
  let num = null;
  for (const a of args) {
    if (a === "--off") off = true;
    else if (/^\d+$/.test(a) && num === null) num = Number(a);
    else if (/^\d+$/.test(a)) throw new Error(`verify-per-step takes one phase number; got ${num} and ${a}`);
    else throw new Error(`unknown option ${a} (give the phase number, for example \`autoclaude verify-per-step 3\`)`);
  }
  if (num === null || num < 1) { io.err("autoclaude: usage: autoclaude verify-per-step <phase number> [--off]"); return 2; }
  const project = requireProject(io);
  if (!project) return 1;
  const { root, config } = project;
  const state = loadState(root);
  if (state.status === STATUS.running) {
    io.out("autoclaude: the run is running, and how a feature is verified cannot change under it. Pause it first (`autoclaude pause --now`, or `autoclaude pause` to stop after the next commit), then run this again and `autoclaude resume`.");
    return 1;
  }
  const plan = loadPlan(project);
  const phase = plan.parsed ? plan.parsed.phases.find((ph) => ph.num === num) : null;
  if (plan.parsed && !phase) { io.out(`autoclaude: ${config.plan} has no Phase ${num}`); return 1; }
  const name = phase ? `Phase ${num} (${phase.title})` : `Phase ${num}`;
  const current = Array.isArray(config.gate.stepPhases) ? config.gate.stepPhases : [];
  const has = current.includes(num);
  if (config.gate.verifyAt === "step") io.out(`autoclaude: note: gate.verifyAt is "step", so every phase is verified step by step already; gate.stepPhases matters only with "phase".`);
  if (off ? !has : has) {
    io.out(`autoclaude: ${name} is ${off ? "already verified as one feature" : "already verified step by step"}; nothing changed (gate.stepPhases is ${JSON.stringify(current)})`);
    return 0;
  }
  const next = off ? current.filter((n) => n !== num) : [...current, num].sort((a, b) => a - b);
  const after = state.status === STATUS.paused
    ? "Run `autoclaude resume` to carry on."
    : "Commit autoclaude.config.json, then `autoclaude run` (its preflight needs a clean working tree).";
  // Only the project's own file changes: the other layers' values stay inherited.
  updateProjectConfig(root, (raw) => {
    raw.gate = { ...(raw.gate && typeof raw.gate === "object" && !Array.isArray(raw.gate) ? raw.gate : {}), stepPhases: next };
    if (!next.length) delete raw.gate.stepPhases;
    if (!Object.keys(raw.gate).length) delete raw.gate;
  });
  io.out(off
    ? `autoclaude: ${name} is verified as one feature again (gate.stepPhases is ${JSON.stringify(next)} in autoclaude.config.json).`
    : `autoclaude: ${name} is now verified step by step (gate.stepPhases is ${JSON.stringify(next)} in autoclaude.config.json): each of its unfinished steps gets the checks, a browser test of its own Accept lines and the security review when due, and its last step the bug bash, so no single part of the verification covers the whole phase. The plan is not changed.`);
  io.out(`  ${after}`);
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
