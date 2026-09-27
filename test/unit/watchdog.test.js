import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TASK_NAME, projectSlug, supervisorPid, launchSupervisor, watchdogPass, installWatchdog,
  uninstallWatchdog, watchdogStatus, defaultRunner, parseSchtasksList
} from "../../plugins/autoclaude/lib/watchdog.js";

const tmp = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `autoclaude-wd-${tag}-`));

function makeProject(parent, name, { status = "running", pidFile = null, statePid = null } = {}) {
  const root = path.join(parent, name);
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), JSON.stringify({ version: 1, status, supervisorPid: statePid }));
  if (pidFile !== null) fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), `${pidFile}\n`);
  return root;
}

// Records every call; `respond(program, args)` returns the fake result (default: exit 0).
function fakeRunner(respond = () => ({ code: 0, stdout: "", stderr: "" })) {
  const calls = [];
  return { calls, run: (program, args) => { calls.push([program, args]); return respond(program, args); } };
}

function fakeLauncher(result = { method: "fake", pid: 9001 }) {
  const calls = [];
  return { calls, launch: async (opts) => { calls.push(opts); if (result instanceof Error) throw result; return result; } };
}

const readLines = (file) => fs.readFileSync(file, "utf8").split("\n").filter(Boolean);

test("projectSlug lowercases the folder name and turns non-alphanumerics into dashes", () => {
  assert.equal(projectSlug(path.join(os.tmpdir(), "My App_2.0")), "my-app-2-0");
  assert.equal(projectSlug(path.join(os.tmpdir(), "db")), "db");
  assert.equal(projectSlug(path.join(os.tmpdir(), "AutoClaude")), "autoclaude");
});

test("supervisorPid reads the pid file first, then state, else null", () => {
  const parent = tmp("pid");
  const none = makeProject(parent, "none");
  assert.equal(supervisorPid(none), null);
  const fromState = makeProject(parent, "state", { statePid: 4321 });
  assert.equal(supervisorPid(fromState), 4321);
  const both = makeProject(parent, "both", { pidFile: 1234, statePid: 4321 });
  assert.equal(supervisorPid(both), 1234);
  const garbage = makeProject(parent, "garbage", { statePid: 4321 });
  fs.writeFileSync(path.join(garbage, ".autoclaude", "supervisor.pid"), "not a pid");
  assert.equal(supervisorPid(garbage), 4321);
  assert.equal(supervisorPid(path.join(parent, "no-such-folder")), null);
});

test("launchSupervisor opens ac-<slug> in the project running node, the CLI and supervise", () => {
  const root = makeProject(tmp("launch"), "My Project");
  const seen = [];
  const env = { MARKER: "1" };
  const back = launchSupervisor({ root, env, open: (o) => { seen.push(o); return { method: "fake", pid: 5 }; } });
  assert.deepEqual(back, { method: "fake", pid: 5 });
  assert.equal(seen.length, 1);
  const o = seen[0];
  assert.equal(o.title, "ac-my-project");
  assert.equal(o.cwd, root);
  assert.equal(o.program, process.execPath);
  assert.equal(o.args.length, 2);
  assert.ok(o.args[0].endsWith(path.join("bin", "autoclaude.js")), o.args[0]);
  assert.ok(fs.existsSync(o.args[0]), "the CLI path must exist");
  assert.equal(o.args[1], "supervise");
  assert.equal(o.logFile, path.join(root, ".autoclaude", "logs", "supervisor.log"));
  assert.ok(fs.existsSync(path.join(root, ".autoclaude", "logs")), "the log folder is created before the window opens");
  assert.equal(o.env, env);
});

test("watchdogPass relaunches a dead supervisor once, records lastLaunchAt, and waits out the gap", async () => {
  const parent = tmp("pass");
  const root = makeProject(parent, "Dead App", { pidFile: 111 });
  const logFile = path.join(parent, "machine", "logs", "watchdog.log");
  const { calls, launch } = fakeLauncher();
  const isAlive = () => false;
  const T = Date.parse("2026-09-26T12:00:00.000Z");

  const r1 = await watchdogPass({ registry: [{ root }], now: T, isAlive, launch, logFile });
  assert.deepEqual(r1.map((r) => [r.root, r.action, r.pid]), [[root, "launched", 111]]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].root, root);
  const record = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "watchdog.json"), "utf8"));
  assert.equal(record.lastLaunchAt, "2026-09-26T12:00:00.000Z");
  assert.equal(record.pid, 9001);
  assert.equal(record.previousPid, 111);
  const projectLog = readLines(path.join(root, ".autoclaude", "logs", "watchdog.log"));
  assert.equal(projectLog.length, 1);
  assert.match(projectLog[0], /^2026-09-26T12:00:00\.000Z launched .* pid=111 via=fake$/);

  const r2 = await watchdogPass({ registry: [{ root }], now: T + 60 * 1000, isAlive, launch, logFile });
  assert.deepEqual(r2.map((r) => r.action), ["too-soon"]);
  assert.equal(r2[0].lastLaunchAt, "2026-09-26T12:00:00.000Z");
  assert.equal(calls.length, 1, "a slow-starting supervisor must not be launched twice");

  const r3 = await watchdogPass({ registry: [{ root }], now: T + 4 * 60 * 1000, isAlive, launch, logFile });
  assert.deepEqual(r3.map((r) => r.action), ["launched"]);
  assert.equal(calls.length, 2);

  const machineLog = readLines(logFile);
  assert.equal(machineLog.length, 3);
  assert.match(machineLog[1], / too-soon .*Dead App pid=111$/);
  assert.equal(readLines(path.join(root, ".autoclaude", "logs", "watchdog.log")).length, 2, "too-soon is not logged in the project");
});

test("watchdogPass leaves live, paused, complete and idle runs alone and reports missing folders", async () => {
  const parent = tmp("skip");
  const alive = makeProject(parent, "alive", { pidFile: 222 });
  const aliveByState = makeProject(parent, "alive-by-state", { statePid: 444 });
  const paused = makeProject(parent, "paused", { status: "paused", pidFile: 333 });
  const complete = makeProject(parent, "complete", { status: "complete", pidFile: 333 });
  const bare = path.join(parent, "no-runtime-folder");
  fs.mkdirSync(bare);
  const gone = path.join(parent, "gone");
  const logFile = path.join(parent, "watchdog.log");
  const { calls, launch } = fakeLauncher();
  const isAlive = (pid) => pid === 222 || pid === 444;
  const registry = { projects: [{ root: alive, name: "alive" }, aliveByState, { root: paused }, { root: complete }, { root: bare }, { root: gone }, null, {}] };

  const results = await watchdogPass({ registry, now: Date.now(), isAlive, launch, logFile });
  assert.deepEqual(results.map((r) => [r.root, r.action, r.pid]), [
    [alive, "alive", 222],
    [aliveByState, "alive", 444],
    [paused, "not-running", null],
    [complete, "not-running", null],
    [bare, "not-running", null],
    [gone, "missing", null],
    [null, "missing", null],
    [null, "missing", null]
  ]);
  assert.equal(calls.length, 0);
  assert.equal(readLines(logFile).length, 8, "one machine log line per action");
  for (const root of [alive, paused, complete]) assert.equal(fs.existsSync(path.join(root, ".autoclaude", "watchdog.json")), false);
  assert.equal(fs.existsSync(gone), false, "a missing project folder is not created");
});

test("a launch that fails becomes launch-failed, records nothing, and the pass never throws", async () => {
  const parent = tmp("fail");
  const root = makeProject(parent, "broken", { pidFile: 555 });
  const logFile = path.join(parent, "watchdog.log");

  const thrower = fakeLauncher(new Error("no console available"));
  const r1 = await watchdogPass({ registry: [{ root }], isAlive: () => false, launch: thrower.launch, logFile });
  assert.equal(r1.length, 1);
  assert.equal(r1[0].action, "launch-failed");
  assert.equal(r1[0].pid, 555);
  assert.match(r1[0].error, /no console available/);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "watchdog.json")), false);
  assert.match(readLines(path.join(root, ".autoclaude", "logs", "watchdog.log"))[0], /launch-failed .* error=no console available$/);

  const tmux = fakeLauncher({ method: "tmux", pid: null, ok: false, stderr: "duplicate session: ac-broken" });
  const r2 = await watchdogPass({ registry: [{ root }], isAlive: () => false, launch: tmux.launch, logFile });
  assert.equal(r2[0].action, "launch-failed", "a failed launch is retried on the next pass, not held back by the gap");
  assert.match(r2[0].error, /duplicate session/);

  const sync = await watchdogPass({ registry: [{ root }], isAlive: () => { throw new Error("boom"); }, launch: tmux.launch, logFile });
  assert.equal(sync[0].action, "error");
  assert.match(sync[0].error, /boom/);
});

const NODE_WIN = "C:\\Program Files\\nodejs\\node.exe";
const CLI_WIN = "C:\\Users\\someone\\.claude\\plugins\\cache\\autoclaude\\bin\\autoclaude.js";

test("installWatchdog on Windows writes a hidden-window VBScript and runs schtasks /Create", () => {
  const dir = path.join(tmp("bin"), "bin");
  const { calls, run } = fakeRunner(() => ({ code: 0, stdout: "SUCCESS: The scheduled task \"AutoClaude watchdog\" has successfully been created.\r\n", stderr: "" }));
  const r = installWatchdog({ run, dir, node: NODE_WIN, cli: CLI_WIN, platform: "win32" });
  const vbs = path.join(dir, "autoclaude-watchdog.vbs");
  const tr = `wscript.exe //B //Nologo "${vbs}"`;
  assert.equal(r.ok, true);
  assert.equal(r.file, vbs);
  assert.match(r.stdout, /SUCCESS/);
  assert.deepEqual(calls, [["schtasks", ["/Create", "/F", "/SC", "MINUTE", "/MO", "5", "/TN", "AutoClaude watchdog", "/TR", tr, "/IT"]]]);
  assert.equal(TASK_NAME, "AutoClaude watchdog");
  assert.ok(tr.length < 261, `/TR is ${tr.length} characters`);
  assert.match(r.command, /^schtasks \/Create \/F \/SC MINUTE \/MO 5 \/TN "AutoClaude watchdog" \/TR ".*" \/IT$/);

  const text = fs.readFileSync(vbs, "utf8");
  assert.ok(/^[\x00-\x7f]*$/.test(text), "an ASCII path gives a plain ASCII script");
  assert.ok(!/[^\r]\n/.test(text), "VBScript lines end in CRLF");
  assert.ok(text.includes('Set shell = CreateObject("WScript.Shell")'));
  const expected = 'shell.Run """C:\\Program Files\\nodejs\\node.exe"" ""C:\\Users\\someone\\.claude\\plugins\\cache\\autoclaude\\bin\\autoclaude.js"" watchdog", 0, False';
  assert.ok(text.includes(expected), text);
  const literal = text.match(/shell\.Run (".*"), 0, False/)[1];
  const inner = literal.slice(1, -1);
  assert.ok(!inner.replace(/""/g, "").includes('"'), "every quote inside the literal is doubled");
  assert.equal(inner.replace(/""/g, '"'), `"${NODE_WIN}" "${CLI_WIN}" watchdog`);
});

test("installWatchdog on Windows refuses a /TR over 260 characters before writing or scheduling", () => {
  const dir = path.join(tmp("long"), "x".repeat(240));
  const { calls, run } = fakeRunner();
  const r = installWatchdog({ run, dir, node: NODE_WIN, cli: CLI_WIN, platform: "win32" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /at most 260/);
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(dir), false);
});

test("installWatchdog writes a non-ASCII path as UTF-16 LE with a BOM so wscript reads it intact", () => {
  const dir = tmp("utf16");
  const cli = "C:\\Users\\Jos\u00e9\\.claude\\plugins\\autoclaude\\bin\\autoclaude.js";
  const { run } = fakeRunner();
  const r = installWatchdog({ run, dir, node: NODE_WIN, cli, platform: "win32" });
  assert.equal(r.ok, true);
  const buf = fs.readFileSync(r.file);
  assert.deepEqual([buf[0], buf[1]], [0xff, 0xfe]);
  assert.ok(buf.subarray(2).toString("utf16le").includes(`""${cli}""`));
});

test("installWatchdog passes a schtasks failure through", () => {
  const { run } = fakeRunner(() => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied.\r\n" }));
  const r = installWatchdog({ run, dir: tmp("denied"), node: NODE_WIN, cli: CLI_WIN, platform: "win32" });
  assert.equal(r.ok, false);
  assert.match(r.stderr, /Access is denied/);
});

test("uninstallWatchdog on Windows: a missing task is ok, the script goes only once the task is gone", () => {
  const dir = tmp("uninstall");
  const vbs = path.join(dir, "autoclaude-watchdog.vbs");
  const reply = (code, stderr) => fakeRunner(() => ({ code, stdout: "", stderr }));

  fs.writeFileSync(vbs, "x");
  const ok = reply(0, "");
  assert.deepEqual(uninstallWatchdog({ run: ok.run, dir, platform: "win32" }), { ok: true, stderr: "", wasInstalled: true });
  assert.deepEqual(ok.calls, [["schtasks", ["/Delete", "/F", "/TN", "AutoClaude watchdog"]]]);
  assert.equal(fs.existsSync(vbs), false);

  fs.writeFileSync(vbs, "x");
  const gone = uninstallWatchdog({ run: reply(1, "ERROR: The system cannot find the file specified.\r\n").run, dir, platform: "win32" });
  assert.equal(gone.ok, true);
  assert.equal(gone.wasInstalled, false);
  assert.equal(fs.existsSync(vbs), false);

  const older = uninstallWatchdog({ run: reply(1, "ERROR: The specified task name \"\\AutoClaude watchdog\" does not exist in the system.\r\n").run, dir, platform: "win32" });
  assert.equal(older.ok, true);

  fs.writeFileSync(vbs, "x");
  const denied = uninstallWatchdog({ run: reply(1, "ERROR: Access is denied.\r\n").run, dir, platform: "win32" });
  assert.equal(denied.ok, false);
  assert.match(denied.stderr, /Access is denied/);
  assert.equal(fs.existsSync(vbs), true, "the script stays while the task still points at it");
});

// Shape of `schtasks /Query /TN <name> /FO LIST /V` on Windows Server 2025 (captured 2026-09-26
// from a built-in task, values made generic). A task with two triggers prints two blocks.
const SCHTASKS_SAMPLE = [
  "",
  "Folder: \\",
  "HostName:                             MYPC",
  "TaskName:                             \\AutoClaude watchdog",
  "Next Run Time:                        9/26/2026 3:05:00 PM",
  "Status:                               Ready",
  "Logon Mode:                           Interactive only",
  "Last Run Time:                        9/26/2026 3:00:01 PM",
  "Last Result:                          0",
  "Author:                               MYPC\\someone",
  "Task To Run:                          wscript.exe //B //Nologo \"C:\\Users\\someone\\AppData\\Local\\autoclaude\\bin\\autoclaude-watchdog.vbs\"",
  "Start In:                             N/A",
  "Comment:                              N/A",
  "Scheduled Task State:                 Enabled",
  "Idle Time:                            Disabled",
  "Power Management:                     Stop On Battery Mode, No Start On Batteries",
  "Run As User:                          someone",
  "Delete Task If Not Rescheduled:       Disabled",
  "Stop Task If Runs X Hours and X Mins: 72:00:00",
  "Schedule:                             Scheduling data is not available in this format.",
  "Schedule Type:                        One Time Only, Minute",
  "Start Time:                           2:55:00 PM",
  "Start Date:                           9/26/2026",
  "End Date:                             N/A",
  "Days:                                 N/A",
  "Months:                               N/A",
  "Repeat: Every:                        0 Hour(s), 5 Minute(s)",
  "Repeat: Until: Time:                  None",
  "Repeat: Until: Duration:              Disabled",
  "Repeat: Stop If Still Running:        Disabled",
  "",
  "HostName:                             MYPC",
  "TaskName:                             \\AutoClaude watchdog",
  "Next Run Time:                        9/27/2026 9:00:00 AM",
  "Status:                               Running",
  "Last Run Time:                        9/20/2026 9:00:00 AM",
  "Last Result:                          267011",
  ""
].join("\r\n");

test("watchdogStatus parses schtasks /Query /FO LIST /V, and a missing task is not installed", () => {
  const { calls, run } = fakeRunner(() => ({ code: 0, stdout: SCHTASKS_SAMPLE, stderr: "" }));
  assert.deepEqual(watchdogStatus({ run, platform: "win32" }), {
    installed: true, status: "Ready", nextRun: "9/26/2026 3:05:00 PM", lastRun: "9/26/2026 3:00:01 PM", lastResult: "0"
  });
  assert.deepEqual(calls, [["schtasks", ["/Query", "/TN", "AutoClaude watchdog", "/FO", "LIST", "/V"]]]);
  assert.equal(parseSchtasksList("Scheduled Task State: Enabled\r\n").status, null, "Scheduled Task State is not Status");

  const missing = fakeRunner(() => ({ code: 1, stdout: "", stderr: "ERROR: The system cannot find the file specified.\r\n" }));
  assert.deepEqual(watchdogStatus({ run: missing.run, platform: "win32" }), { installed: false, status: null, nextRun: null, lastRun: null, lastResult: null });

  const denied = fakeRunner(() => ({ code: 1, stdout: "", stderr: "ERROR: Access is denied.\r\n" }));
  const d = watchdogStatus({ run: denied.run, platform: "win32" });
  assert.equal(d.installed, false);
  assert.match(d.error, /Access is denied/);
});

const LINUX = {
  node: "/usr/bin/node",
  cli: "/home/someone/.claude/plugins/autoclaude/bin/autoclaude.js",
  env: { HOME: "/home/someone", PATH: "/usr/local/bin:/usr/bin:/bin:/home/someone/.local/bin" }
};

test("installWatchdog on Linux writes the systemd user units and enables the timer", () => {
  const unitDir = path.join(tmp("systemd"), ".config", "systemd", "user");
  const { calls, run } = fakeRunner();
  const r = installWatchdog({ ...LINUX, run, unitDir, platform: "linux", which: () => "/usr/bin/systemctl" });
  assert.equal(r.ok, true, r.stderr);
  assert.deepEqual(calls, [
    ["systemctl", ["--user", "daemon-reload"]],
    ["systemctl", ["--user", "enable", "--now", "autoclaude-watchdog.timer"]]
  ]);
  const service = fs.readFileSync(path.join(unitDir, "autoclaude-watchdog.service"), "utf8");
  const timer = fs.readFileSync(path.join(unitDir, "autoclaude-watchdog.timer"), "utf8");
  assert.equal(r.file, path.join(unitDir, "autoclaude-watchdog.service"));
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^ExecStart=\/usr\/bin\/node \/home\/someone\/\.claude\/plugins\/autoclaude\/bin\/autoclaude\.js watchdog$/m);
  assert.match(service, /^Environment="PATH=\/usr\/local\/bin:\/usr\/bin:\/bin:\/home\/someone\/\.local\/bin"$/m);
  assert.match(service, /loginctl enable-linger/);
  assert.ok(!service.includes("{{"), "every placeholder is filled");
  for (const line of ["OnBootSec=2min", "OnUnitActiveSec=5min", "Persistent=true", "WantedBy=timers.target"]) {
    assert.match(timer, new RegExp(`^${line}$`, "m"));
  }

  const spaced = path.join(tmp("systemd-space"), "user");
  const r2 = installWatchdog({ ...LINUX, node: "/opt/my node/bin/node", run: fakeRunner().run, unitDir: spaced, platform: "linux", which: () => "/usr/bin/systemctl" });
  assert.equal(r2.ok, true);
  assert.match(fs.readFileSync(path.join(spaced, "autoclaude-watchdog.service"), "utf8"), /^ExecStart="\/opt\/my node\/bin\/node" \/home\/someone\/.* watchdog$/m);

  const failing = fakeRunner((program, args) => ({ code: args[1] === "enable" ? 1 : 0, stdout: "", stderr: args[1] === "enable" ? "Failed to connect to bus" : "" }));
  const r3 = installWatchdog({ ...LINUX, run: failing.run, unitDir: spaced, platform: "linux", which: () => "/usr/bin/systemctl" });
  assert.equal(r3.ok, false);
  assert.match(r3.stderr, /Failed to connect to bus/);
  assert.match(r3.cronLine, /^\*\/5 \* \* \* \* /, "a failed systemd install still offers the crontab line");
});

test("installWatchdog without systemctl returns the crontab line and changes nothing", () => {
  const unitDir = path.join(tmp("cron"), "user");
  const { calls, run } = fakeRunner();
  const r = installWatchdog({ ...LINUX, run, unitDir, platform: "darwin", which: () => null });
  assert.equal(r.ok, false);
  assert.equal(r.cronLine, "*/5 * * * * PATH=/usr/local/bin:/usr/bin:/bin:/home/someone/.local/bin /usr/bin/node /home/someone/.claude/plugins/autoclaude/bin/autoclaude.js watchdog");
  assert.ok(r.stderr.includes(r.cronLine));
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(unitDir), false);

  const odd = installWatchdog({ ...LINUX, node: "/Users/some one/node", run, unitDir, platform: "darwin", which: () => null });
  assert.match(odd.cronLine, / '\/Users\/some one\/node' /);
});

test("uninstallWatchdog and watchdogStatus on Linux go through systemctl", () => {
  const unitDir = path.join(tmp("systemd-rm"), "user");
  installWatchdog({ ...LINUX, run: fakeRunner().run, unitDir, platform: "linux", which: () => "/usr/bin/systemctl" });
  const { calls, run } = fakeRunner();
  const u = uninstallWatchdog({ run, unitDir, env: LINUX.env, platform: "linux", which: () => "/usr/bin/systemctl" });
  assert.equal(u.ok, true);
  assert.deepEqual(calls, [
    ["systemctl", ["--user", "disable", "--now", "autoclaude-watchdog.timer"]],
    ["systemctl", ["--user", "daemon-reload"]]
  ]);
  assert.deepEqual(fs.readdirSync(unitDir), []);

  const notThere = fakeRunner(() => ({ code: 1, stdout: "", stderr: "Failed to disable unit: Unit file autoclaude-watchdog.timer does not exist." }));
  assert.equal(uninstallWatchdog({ run: notThere.run, unitDir, env: LINUX.env, platform: "linux", which: () => "/usr/bin/systemctl" }).ok, true);
  const noSystemd = uninstallWatchdog({ run, unitDir, env: LINUX.env, platform: "darwin", which: () => null });
  assert.equal(noSystemd.ok, true);
  assert.match(noSystemd.manual, /crontab -e/);

  const shown = fakeRunner((program, args) => ({
    code: 0,
    stderr: "",
    stdout: args[2] === "autoclaude-watchdog.timer"
      ? "LoadState=loaded\nActiveState=active\nNextElapseUSecRealtime=Sat 2026-09-26 15:05:00 CDT\nLastTriggerUSec=Sat 2026-09-26 15:00:00 CDT\n"
      : "Result=success\n"
  }));
  assert.deepEqual(watchdogStatus({ run: shown.run, env: LINUX.env, platform: "linux", which: () => "/usr/bin/systemctl" }), {
    installed: true, status: "active", nextRun: "Sat 2026-09-26 15:05:00 CDT", lastRun: "Sat 2026-09-26 15:00:00 CDT", lastResult: "success"
  });
  const absent = fakeRunner(() => ({ code: 0, stdout: "LoadState=not-found\nActiveState=inactive\n", stderr: "" }));
  assert.equal(watchdogStatus({ run: absent.run, env: LINUX.env, platform: "linux", which: () => "/usr/bin/systemctl" }).installed, false);
  const cron = fakeRunner(() => ({ code: 0, stdout: `${installWatchdog({ ...LINUX, run: fakeRunner().run, platform: "darwin", which: () => null }).cronLine}\n`, stderr: "" }));
  const c = watchdogStatus({ run: cron.run, env: LINUX.env, platform: "darwin", which: () => null });
  assert.equal(c.installed, true);
  assert.equal(c.status, "cron");
  assert.deepEqual(cron.calls, [["crontab", ["-l"]]]);
});

test("defaultRunner runs a program with an argument array and no shell", () => {
  const r = defaultRunner(process.execPath, ["-e", "process.stdout.write(process.argv[1]); process.stderr.write('e'); process.exit(3)", "a b & c"]);
  assert.equal(r.code, 3);
  assert.equal(r.stdout, "a b & c");
  assert.equal(r.stderr, "e");
  const missing = defaultRunner("definitely-not-a-real-program-xyz", []);
  assert.equal(missing.code, -1);
  assert.match(missing.stderr, /ENOENT/);
});
