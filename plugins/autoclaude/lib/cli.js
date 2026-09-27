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
import { readText, readJson, appendLine, ageMs, ensureDir } from "./fsatomic.js";
import { isPidAlive, findOnPath } from "./proc.js";
import { initProject, formatInitReport } from "./init.js";
import { writeReady, writeBlocked, readReady } from "./protocol.js";
import { firstUnfinished, planSlug, MARKERS } from "./plan.js";
import * as git from "./git.js";

const VERSION = JSON.parse(fs.readFileSync(path.join(pluginRoot(), ".claude-plugin", "plugin.json"), "utf8")).version;

const HELP = `autoclaude ${VERSION}

Usage: autoclaude <command> [options]

Project commands (run inside a project):
  init [--playwright] [--no-statusline] [--dev-url <url>] [--dir <path>]
                        Set the project up: config, doc set, .gitignore, browser-tester config,
                        machine registry, statusline bridge. Never overwrites existing files.
  status [--all]        State, current step, attempts, usage, last progress (--all: every registered project)
  start                 Preflight, create the run branch, set the run going on the first unfinished step
  ready [<step>]        Builder: tell the gate the current step is done (verified on the next stop)
  blocked <step> "<q>"  Builder: stop the run with a question only the owner can answer
  pause [--now]         Pause after the next verified commit (or right now with --now)
  note "<text>"         Leave a review note for Claude; it is read on the next resume or session start
  resume                Clear a pause and set the run going again (refuses if PLAN.md fails lint)
  lint-plan [file]      Check the plan against the step format

Machine commands:
  usage                 Show the 5-hour and 7-day usage percentages Claude Code last reported
  install-cli [--no-path]  Put an \`autoclaude\` shim on your PATH
  notify-setup [--channel ntfy|discord|stdout] [--ntfy <topic url>] [--ntfy-token <token>]
               [--discord <webhook url>] [--show] [--clear]
                        Store the notification channel for this machine (outside any repo)
  notify-test [message] Send a test notification through the configured channel
  version | help

Coming in later phases: init, run, start, ready, blocked, answer, watchdog.
`;

class Io {
  constructor(io) {
    this.cwd = io.cwd || process.cwd();
    this.env = io.env || process.env;
    this.stdoutStream = io.stdout || process.stdout;
    this.stderrStream = io.stderr || process.stderr;
    this.now = io.now || (() => new Date());
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
      case "init": return cmdInit(rest, io);
      case "status": return cmdStatus(rest, io);
      case "start": return cmdStart(rest, io);
      case "ready": return cmdReady(rest, io);
      case "blocked": return cmdBlocked(rest, io);
      case "pause": return cmdPause(rest, io);
      case "note": return cmdNote(rest, io);
      case "resume": return cmdResume(rest, io);
      case "lint-plan": return cmdLintPlan(rest, io);
      case "usage": return cmdUsage(rest, io);
      case "install-cli": return cmdInstallCli(rest, io);
      case "notify-setup": return cmdNotifySetup(rest, io);
      case "notify-test": return cmdNotifyTest(rest, io);
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
  let dir = io.cwd;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--playwright") opts.playwright = true;
    else if (a === "--no-statusline") opts.statusline = false;
    else if (a === "--dev-url") { opts.devUrl = args[++i]; if (!opts.devUrl) throw new Error("--dev-url needs a value"); }
    else if (a === "--dir") { dir = args[++i]; if (!dir) throw new Error("--dir needs a value"); }
    else throw new Error(`unknown option ${a}`);
  }
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
  const branch = config.branch.replace("{planSlug}", planSlug(plan.parsed));
  const co = await git.checkoutBranch(root, branch, { create: true, env: gitEnv });
  if (!co.ok) { io.out(`autoclaude: could not check out ${branch}: ${co.stderr}`); return 1; }
  const ticked = plan.parsed.steps.filter((s) => s.marker === MARKERS.done).map((s) => s.id);
  const now = io.now().toISOString();
  updateState(root, (s) => {
    s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.currentStep = first.id;
    s.attempts = {}; s.noProgress = 0; s.recoveries = 0; s.tickedByGate = ticked; s.startedAt = now; s.stepStartedAt = now;
    s.headAtLastGate = null; s.toolCallsAtLastGate = 0;
  });
  io.out(`autoclaude: running on branch ${branch}${co.created ? " (created)" : ""}. First step: ${first.id} ${first.title}.`);
  io.out(`  the builder session works the plan; the gate verifies on every stop. Watch with \`autoclaude status\`.`);
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
    updateState(project.root, (s) => { s.status = STATUS.paused; s.pauseReason = "review"; s.pauseRequested = false; });
    io.out(`autoclaude: paused now for review (step ${state.currentStep || "?"} stays open with its attempts). Leave notes with \`autoclaude note "..."\`, then \`autoclaude resume\`.`);
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

function cmdResume(args, io) {
  const project = requireProject(io);
  if (!project) return 1;
  const state = loadState(project.root);
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
    io.out("autoclaude: the plan is complete; nothing to resume (add steps to the plan and run `autoclaude start`)");
    return 1;
  }
  if (state.status === STATUS.idle) {
    io.out("autoclaude: no run has been started yet; use `autoclaude run` (Phase 6) to start one");
    return 1;
  }
  const next = updateState(project.root, (s) => { s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.recoveries = 0; });
  const notes = next.pendingNotes.length;
  io.out(`autoclaude: resumed${notes ? ` with ${notes} review note(s) waiting for Claude` : ""}. The supervisor nudges the session on its next pass.`);
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
  const entry = path.join(pluginRoot(), "bin", "autoclaude.js");
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

function cmdNotifySetup(args, io) {
  const file = machinePaths().notifyFile;
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => { const v = args[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    if (a === "--channel") values.channel = next().toLowerCase();
    else if (a === "--ntfy") values.ntfy_url = next();
    else if (a === "--ntfy-token") values.ntfy_token = next();
    else if (a === "--discord") values.discord_webhook = next();
    else if (a === "--clear") { values.channel = null; values.ntfy_url = null; values.ntfy_token = null; values.discord_webhook = null; }
    else if (a === "--show") { /* handled below */ }
    else throw new Error(`unknown option ${a}`);
  }
  if (values.channel && !["ntfy", "discord", "stdout"].includes(values.channel)) throw new Error("--channel must be ntfy, discord or stdout");
  if (values.ntfy_url && !/^https?:\/\//.test(values.ntfy_url)) throw new Error("--ntfy needs a full topic URL such as https://ntfy.sh/your-topic");
  if (values.discord_webhook && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\//.test(values.discord_webhook)) throw new Error("--discord needs a Discord webhook URL");
  const stored = Object.keys(values).length ? writeMachineNotify(values, file) : readMachineNotify(file);
  const resolved = resolveChannel({}, io.env, file);
  io.out(`autoclaude: notification settings for this machine are in ${file} (never commit this file)`);
  io.out(`  channel: ${resolved.channel}${stored.channel ? "" : " (auto)"}`);
  io.out(`  ntfy_url: ${stored.ntfy_url || "(not set)"}`);
  io.out(`  ntfy_token: ${stored.ntfy_token ? "(set)" : "(not set)"}`);
  io.out(`  discord_webhook: ${mask(stored.discord_webhook)}`);
  if (resolved.channel === "stdout") io.out("  nothing will reach a phone until --ntfy or --discord is set (or the plugin's userConfig, which hook processes read)");
  return 0;
}

async function cmdNotifyTest(args, io) {
  const message = args.join(" ").trim() || `AutoClaude test notification from ${io.env.COMPUTERNAME || io.env.HOSTNAME || "this machine"} at ${io.now().toISOString()}`;
  const logFile = path.join(machinePaths().logsDir, "notify.log");
  const r = await notify({ title: "AutoClaude test", message, priority: "default", tags: ["white_check_mark"] }, { logFile, stdout: io.stdoutStream, env: io.env });
  if (r.ok && !r.fallback) io.out(`autoclaude: sent through ${r.channel}${r.status ? ` (HTTP ${r.status})` : ""}. Log: ${logFile}`);
  else io.out(`autoclaude: ${r.channel} delivery failed (${r.error}); printed above instead. Log: ${logFile}`);
  if (r.channel === "stdout") io.out("  no channel is configured: run `autoclaude notify-setup --discord <webhook>` or `--ntfy <topic url>` (and /plugin configure autoclaude@autoclaude-local for hook processes)");
  return r.ok ? 0 : 1;
}
