import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { decide, childEnv, launchArgs, supervise, builderSettings, launchOptions, spawnClaude, cmdShimLine, cmdShimArg } from "../../plugins/autoclaude/lib/supervisor.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { saveState, loadState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const MIN = 60000;
const T = Date.parse("2026-09-27T05:00:00Z");
const cfg = mergeConfig({});
const base = (over = {}) => ({
  status: "running", pauseReason: null, now: T, childAlive: true, cfg,
  sup: { recoveries: 0, countAtLastRecovery: -1, resumedAt: null },
  lastActivityAt: T - MIN, heartbeatCount: 10, idle: null, failure: null, gateAt: null,
  usage: { source: null }, agentStatus: null, weeklyResetsAt: null, ...over
});

test("working, the gate verifying, and a live usage-limit wait are all left alone", () => {
  assert.equal(decide(base()).action, "none");
  assert.equal(decide(base({ lastActivityAt: T - 90 * MIN, gateAt: T - 20 * MIN })).reason, "the gate is verifying a step");
  const wait = decide(base({ lastActivityAt: T - 60 * MIN, failure: { type: "rate_limit", at: T - 50 * MIN }, usage: { fiveHour: { pct: 100, resetsAt: T + 30 * MIN }, sevenDay: { pct: 40 } } }));
  assert.equal(wait.action, "none");
  assert.match(wait.reason, /waiting out a usage limit/);
});

test("relaunch when the session exits, errors, sits idle, stalls, or ignores a resume", () => {
  assert.match(decide(base({ childAlive: false })).reason, /session exited/);
  assert.match(decide(base({ failure: { type: "server_error", at: T - 2 * MIN }, lastActivityAt: T - 3 * MIN })).reason, /API error \(server_error\)/);
  assert.equal(decide(base({ failure: { type: "server_error", at: T - 30 * 1000 }, lastActivityAt: T - MIN })).action, "none", "give an API error a minute");
  assert.match(decide(base({ idle: { type: "idle_prompt", at: T - 16 * MIN }, lastActivityAt: T - 17 * MIN })).reason, /idle at its prompt for 16 min/);
  assert.equal(decide(base({ idle: { type: "idle_prompt", at: T - 5 * MIN }, lastActivityAt: T - 6 * MIN })).action, "none");
  assert.match(decide(base({ lastActivityAt: T - 50 * MIN, agentStatus: "idle" })).reason, /no activity for 50 min and the session is idle/);
  assert.equal(decide(base({ lastActivityAt: T - 50 * MIN, agentStatus: "busy" })).action, "none", "a long busy stretch is allowed up to twice the stall time");
  assert.match(decide(base({ lastActivityAt: T - 95 * MIN, agentStatus: "busy" })).reason, /no activity for 95 min/);
  assert.match(decide(base({ lastActivityAt: T - 5 * MIN, sup: { recoveries: 0, countAtLastRecovery: -1, resumedAt: T - 3 * MIN } })).reason, /resumed but the session did not pick it up/);
  assert.equal(decide(base({ lastActivityAt: T - MIN, sup: { recoveries: 0, countAtLastRecovery: -1, resumedAt: T - 3 * MIN } })).action, "none", "activity after the resume");
  const afterLimit = decide(base({ lastActivityAt: T - 6 * 60 * MIN, failure: { type: "rate_limit", at: T - 5.5 * 60 * MIN }, usage: { fiveHour: { resetsAt: T - 60 * MIN }, sevenDay: { pct: 40 } } }));
  assert.match(afterLimit.reason, /usage limit reset but the session did not continue/);
});

test("a dead session wins over a stale verifying marker; a nudge waits for the gate, then goes first", () => {
  assert.match(decide(base({ childAlive: false, gateAt: T - MIN })).reason, /session exited/);
  const waiting = decide(base({ nudge: "/compact", gateAt: T - MIN }));
  assert.deepEqual([waiting.action, waiting.reason], ["none", "the gate is verifying a step; the nudge waits"]);
  const n = decide(base({ nudge: "/compact", idle: { type: "idle_prompt", at: T - 20 * MIN }, lastActivityAt: T - 21 * MIN }));
  assert.deepEqual([n.action, n.reason], ["nudge", "the owner asked for: /compact"]);
  assert.deepEqual(launchArgs("resume", "/compact"), ["--continue", "--permission-mode", "auto", "/compact"]);
  assert.deepEqual(launchArgs("resume", "/compact", "id-1"), ["--resume", "id-1", "--permission-mode", "auto", "/compact"]);
  assert.deepEqual(launchArgs("resume", null, "id-1", "opus"), ["--resume", "id-1", "--model", "opus", "--permission-mode", "auto", "/autoclaude:resume"]);
  assert.deepEqual(launchArgs("start", null, "id-2", "opus"), ["--session-id", "id-2", "--model", "opus", "--permission-mode", "auto", "/autoclaude:start"]);
});

test("once a nudged prompt ends at the idle prompt, the run continues at once and it is not a recovery", () => {
  const nudged = { recoveries: 0, countAtLastRecovery: -1, resumedAt: null, nudgedAt: T - 3 * MIN };
  const c = decide(base({ sup: nudged, idle: { type: "idle_prompt", at: T - MIN }, lastActivityAt: T - 2 * MIN }));
  assert.deepEqual([c.action, c.reason], ["continue", "the owner's nudge has finished; back to the plan"]);
  assert.equal(decide(base({ sup: nudged, idle: null, lastActivityAt: T - 2 * MIN })).action, "none", "the nudged prompt is still running");
  assert.equal(decide(base({ sup: nudged, idle: { type: "idle_prompt", at: T - 5 * MIN }, lastActivityAt: T - 2 * MIN })).action, "none", "an idle marker from before the nudge does not count");
  assert.equal(decide(base({ sup: nudged, idle: { type: "idle_prompt", at: T - MIN }, gateAt: T - MIN })).action, "none", "the gate still wins");
});

test("two relaunches without progress pause the run as stuck", () => {
  const stuck = decide(base({ childAlive: false, heartbeatCount: 10, sup: { recoveries: 2, countAtLastRecovery: 10, resumedAt: null } }));
  assert.equal(stuck.action, "pause-stuck");
  assert.match(stuck.reason, /after 2 relaunches without progress/);
  assert.equal(decide(base({ childAlive: false, heartbeatCount: 11, sup: { recoveries: 2, countAtLastRecovery: 10, resumedAt: null } })).action, "relaunch", "progress since the last relaunch");
});

test("a real weekly limit pauses; paused runs wait, and auto-resume after the weekly reset when configured", () => {
  const weekly = decide(base({ failure: { type: "rate_limit", at: T - MIN }, lastActivityAt: T - 2 * MIN, usage: { sevenDay: { pct: 100, resetsAt: T + 3 * 24 * 60 * MIN } } }));
  assert.equal(weekly.action, "pause-weekly");
  assert.equal(decide(base({ status: "paused", pauseReason: "weekly-limit", weeklyResetsAt: T - 60 * MIN })).action, "none", "auto-resume is off by default");
  const auto = mergeConfig({ usage: { autoResumeAfterWeeklyReset: true } });
  assert.equal(decide(base({ cfg: auto, status: "paused", pauseReason: "weekly-limit", weeklyResetsAt: T - 60 * MIN })).action, "resume-weekly");
  assert.equal(decide(base({ cfg: auto, status: "paused", pauseReason: "weekly-limit", weeklyResetsAt: T + 60 * MIN })).action, "none");
  assert.equal(decide(base({ status: "paused", pauseReason: "review", childAlive: false })).action, "none", "a paused run keeps its supervisor");
  assert.equal(decide(base({ status: "complete", childAlive: false })).action, "exit");
  assert.equal(decide(base({ status: "complete", childAlive: true })).action, "none");
});

test("childEnv drops parent-session variables, keeps the config dir and marks the builder; launch arguments", () => {
  const e = childEnv({ PATH: "x", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: "r", CLAUDE_CONFIG_DIR: "c", AUTOCLAUDE_ROLE: "tester" });
  assert.deepEqual(e, { PATH: "x", CLAUDE_CONFIG_DIR: "c", AUTOCLAUDE_BUILDER: "1" });
  // A start names the session; every relaunch resumes that one by id, never "the latest here".
  assert.deepEqual(launchArgs("start", null, "11111111-2222-4333-8444-555555555555"), ["--session-id", "11111111-2222-4333-8444-555555555555", "--permission-mode", "auto", "/autoclaude:start"]);
  assert.deepEqual(launchArgs("resume", null, "11111111-2222-4333-8444-555555555555"), ["--resume", "11111111-2222-4333-8444-555555555555", "--permission-mode", "auto", "/autoclaude:resume"]);
  // Runs started by an older version have no builderSessionId: --continue, as before.
  assert.deepEqual(launchArgs("start"), ["--permission-mode", "auto", "/autoclaude:start"]);
  assert.deepEqual(launchArgs("resume"), ["--continue", "--permission-mode", "auto", "/autoclaude:resume"]);
});

test("pause --now: a paused run with a halt request ends a live session; nothing else does", () => {
  const h = decide(base({ status: "paused", pauseReason: "review", haltSession: true, childAlive: true }));
  assert.deepEqual([h.action, h.reason], ["halt", "the owner paused the run with --now; ending the session"]);
  assert.equal(decide(base({ status: "paused", pauseReason: "review", haltSession: true, childAlive: false })).action, "none", "no session left to end");
  assert.equal(decide(base({ status: "paused", pauseReason: "review", haltSession: false, childAlive: true })).action, "none", "an ordinary pause lets the session finish its turn");
  assert.equal(decide(base({ status: "running", haltSession: true })).action, "none", "a resumed run is not halted by a stale request");
});

// ---------- the loop, with a fake claude and a fake clock ----------

function fakeProject(status, extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, supervisor: { pollSec: 60, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 2 } }));
  fs.writeFileSync(path.join(root, "PLAN.md"), "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** One\n  - Accept: a\n");
  saveState(root, { ...defaultState(), status, currentStep: "S1.1", startedAt: new Date(T).toISOString(), ...extra });
  return root;
}

function harness(root, { exitAfterLaunch = false } = {}) {
  let clock = T;
  const launches = [];
  const children = [];
  const sent = [];
  // Fake pids must never reach the real taskkill: "killing" one makes its fake session exit.
  const kills = [];
  const kill = (pid) => { kills.push(pid); const c = children.find((x) => x.pid === pid); if (c) setImmediate(() => c.emit("exit", null)); return true; };
  let ids = 0;
  const newSessionId = () => `sess-${++ids}`;
  const spawnChild = (args) => {
    const c = new EventEmitter();
    c.pid = 1000 + launches.length;
    launches.push(args.join(" "));
    children.push(c);
    if (exitAfterLaunch) setImmediate(() => c.emit("exit", 1));
    return c;
  };
  const sleep = async (ms) => { clock += ms; await new Promise((r) => setImmediate(r)); };
  const out = { lines: [], log(s) { this.lines.push(s); } };
  const run = (maxLoops) => supervise({ root, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-cfg-")) }, spawnChild, agentStatus: () => "idle", say: async (m) => { sent.push(m); }, now: () => clock, sleep, maxLoops, kill, newSessionId, console: out });
  return { run, launches, children, sent, out, kills, clock: () => clock };
}

const tick = () => new Promise((r) => setImmediate(r));

test("supervise: a running run is resumed with --continue; an exited session is relaunched; two dead relaunches pause as stuck", async () => {
  const root = fakeProject("running");
  const h = harness(root, { exitAfterLaunch: true });
  await h.run(5);
  assert.equal(h.launches[0], "--continue --model opus --permission-mode auto /autoclaude:resume");
  assert.equal(h.launches.length, 3, "first launch plus two relaunches");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "stuck"]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].title, /stuck on S1\.1/);
  assert.equal(h.sent[0].priority, "high");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "supervisor.pid")), false, "the pid file is removed when the supervisor ends");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /relaunch: the session exited/);
});

test("supervise: a run with a builder session id is resumed by that id, never with --continue", async () => {
  const root = fakeProject("running", { builderSessionId: "b-1" });
  const h = harness(root, { exitAfterLaunch: true });
  await h.run(2);
  assert.deepEqual(h.launches.slice(0, 2), ["--resume b-1 --model opus --permission-mode auto /autoclaude:resume", "--resume b-1 --model opus --permission-mode auto /autoclaude:resume"]);
  assert.equal(loadState(root).builderSessionId, "b-1", "a relaunch keeps the id");
});

test("supervise: an idle run is started with /autoclaude:start under a new session id; a paused run waits and relaunches after resume", async () => {
  let root = fakeProject("idle", { builderSessionId: "left-from-an-old-run" });
  let h = harness(root);
  await h.run(1);
  assert.equal(h.launches[0], "--session-id sess-1 --model opus --permission-mode auto /autoclaude:start");
  assert.equal(loadState(root).builderSessionId, "sess-1", "recorded before the session starts, so the hooks can know it");

  root = fakeProject("paused", { pauseReason: "review" });
  h = harness(root);
  const p = h.run(6);
  // The owner resumes while the supervisor waits; with no session alive it launches at once.
  await new Promise((r) => setTimeout(r, 30));
  saveState(root, { ...loadState(root), status: "running", pauseReason: null });
  await p;
  assert.deepEqual(h.launches, ["--continue --model opus --permission-mode auto /autoclaude:resume"]);
  assert.equal(loadState(root).supervisorPid, process.pid);
  assert.match(loadState(root).windowTitle, /^ac-autoclaude-sup-/);
});

test("supervise: pause --now ends the live session and clears the request; resume relaunches it by id", async () => {
  const root = fakeProject("running", { builderSessionId: "b-7" });
  const h = harness(root);
  const p = h.run(8);
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true });
  for (let i = 0; i < 2000 && loadState(root).haltSession; i++) await tick();
  assert.equal(loadState(root).haltSession, false, "the request is cleared once acted on");
  assert.deepEqual(h.kills, [h.children[0].pid], "the live session was ended");
  saveState(root, { ...loadState(root), status: "running", pauseReason: null });
  await p;
  assert.deepEqual(h.launches, ["--resume b-7 --model opus --permission-mode auto /autoclaude:resume", "--resume b-7 --model opus --permission-mode auto /autoclaude:resume"]);
  const log = fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8");
  assert.match(log, /halt: the owner paused the run with --now; ending the session/);
  assert.match(log, /ended the session; the run stays paused until `autoclaude resume`/);
});

test("supervise: a halt request with no session to end, or on a run resumed in time, is just cleared", async () => {
  let root = fakeProject("paused", { pauseReason: "review", haltSession: true });
  let h = harness(root);
  await h.run(1);
  assert.equal(loadState(root).haltSession, false);
  assert.deepEqual([h.kills, h.launches], [[], []]);

  root = fakeProject("running", { builderSessionId: "b-3" });
  h = harness(root);
  const p = h.run(2);
  saveState(root, { ...loadState(root), haltSession: true });
  await p;
  assert.equal(loadState(root).haltSession, false);
  assert.deepEqual(h.kills, [], "the running session is left alone");
});

test("supervise: a nudge restarts with its prompt, and when that ends idle the run continues without counting a recovery", async () => {
  const root = fakeProject("running", { builderSessionId: "b-2" });
  const h = harness(root);
  const rt = path.join(root, ".autoclaude");
  fs.mkdirSync(rt, { recursive: true });
  fs.writeFileSync(path.join(rt, "nudge.json"), JSON.stringify({ prompt: "/compact", at: new Date(T).toISOString() }));
  const p = h.run(4);
  // After the nudge relaunch, the fake session "finishes" /compact and goes idle.
  for (let i = 0; i < 200 && h.launches.length < 2; i++) await new Promise((r) => setImmediate(r));
  fs.writeFileSync(path.join(rt, "idle"), JSON.stringify({ type: "idle_prompt", at: new Date(h.clock() + 1000).toISOString() }));
  await p;
  assert.deepEqual(h.launches, [
    "--resume b-2 --model opus --permission-mode auto /autoclaude:resume",
    "--resume b-2 --model opus --permission-mode auto /compact",
    "--resume b-2 --model opus --permission-mode auto /autoclaude:resume"
  ]);
  const log = fs.readFileSync(path.join(rt, "logs", "supervisor.log"), "utf8");
  assert.match(log, /nudge: the owner asked for: [/]compact/);
  assert.match(log, /continue: the owner's nudge has finished/);
  const sup = JSON.parse(fs.readFileSync(path.join(rt, "supervisor.json"), "utf8"));
  assert.deepEqual([sup.recoveries, sup.nudgedAt], [0, null]);
});

test("supervise: a long verification counts as activity, so its end is not mistaken for a stall", async () => {
  const root = fakeProject("running");
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, supervisor: { pollSec: 60, idleRelaunchMin: 3, stallMin: 3, resumeGraceMin: 1, rateLimitGraceMin: 10, maxRecoveries: 3 } }));
  const rt = path.join(root, ".autoclaude");
  fs.mkdirSync(rt, { recursive: true });
  const gateFile = path.join(rt, "gate.json");
  fs.writeFileSync(gateFile, JSON.stringify({ pid: process.pid, at: new Date(T + 30000).toISOString() }));
  let clock = T;
  let polls = 0;
  const launches = [];
  const spawnChild = (args) => { const c = new EventEmitter(); c.pid = 2000 + launches.length; launches.push(args.join(" ")); return c; };
  // The gate verifies for nine polls (nine minutes, three times the stall time), then ends.
  const sleep = async (ms) => { clock += ms; if (++polls === 10) fs.rmSync(gateFile, { force: true }); await new Promise((r) => setImmediate(r)); };
  const out = { lines: [], log(x) { this.lines.push(x); } };
  await supervise({ root, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-cfg-")) }, spawnChild, agentStatus: () => "idle", say: async () => {}, now: () => clock, sleep, maxLoops: 12, console: out });
  assert.deepEqual(launches, ["--continue --model opus --permission-mode auto /autoclaude:resume"], "no relaunch in the two polls after the gate ended");
  assert.doesNotMatch(fs.readFileSync(path.join(rt, "logs", "supervisor.log"), "utf8"), /relaunch/);
});

test("supervise: a --resume that dies at once opens a fresh session under a new id with the run context", async () => {
  const root = fakeProject("running", { builderSessionId: "sess-old" });
  // The fake clock jumps a whole poll before a fake exit is seen, so poll faster than the 30 s
  // that counts as "died at once".
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, supervisor: { pollSec: 10, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 5 } }));
  const h = harness(root, { exitAfterLaunch: true });
  await h.run(2);
  assert.equal(h.launches[0], "--resume sess-old --model opus --permission-mode auto /autoclaude:resume");
  assert.equal(h.launches[1], "--session-id sess-1 --model opus --permission-mode auto /autoclaude:resume", "a fresh session, not the same failing resume");
  assert.equal(h.launches[2], "--resume sess-1 --model opus --permission-mode auto /autoclaude:resume", "the new id is the one resumed from then on");
  assert.equal(loadState(root).builderSessionId, "sess-1");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /could not be resumed; opening a fresh one/);
});

test("supervise: a complete run exits at once without launching anything", async () => {
  const root = fakeProject("complete");
  const h = harness(root);
  const r = await h.run(3);
  assert.equal(r.exit, "complete");
  assert.deepEqual(h.launches, []);
});

// ---------- Phase 8: effort, permissions, a fresh session per feature ----------

test("launch arguments: effort only when set, and the permissions JSON as one argument", () => {
  const settings = JSON.stringify({ permissions: { allow: ["Bash(ssh pve *)"] }, autoMode: { environment: ["$defaults", "pve (10.0.0.2) is our Proxmox host"] } });
  const o = { effort: "high", settings };
  assert.deepEqual(launchArgs("start", null, "s-1", "opus", o), ["--session-id", "s-1", "--model", "opus", "--effort", "high", "--settings", settings, "--permission-mode", "auto", "/autoclaude:start"]);
  assert.deepEqual(launchArgs("resume", null, "s-1", "opus", o), ["--resume", "s-1", "--model", "opus", "--effort", "high", "--settings", settings, "--permission-mode", "auto", "/autoclaude:resume"]);
  assert.deepEqual(launchArgs("fresh", null, "s-2", "opus", o), ["--session-id", "s-2", "--model", "opus", "--effort", "high", "--settings", settings, "--permission-mode", "auto", "/autoclaude:resume"]);
  assert.deepEqual(launchArgs("resume", "/compact", "s-1", "opus", { effort: null, settings: null }), ["--resume", "s-1", "--model", "opus", "--permission-mode", "auto", "/compact"], "unset effort: the owner's own default");
});

test("builderSettings: nothing without entries; allow rules and $defaults plus the trusted-infrastructure lines", () => {
  assert.equal(builderSettings(mergeConfig({})), null);
  assert.equal(builderSettings({ permissions: { allow: [" "], environment: [] } }), null, "blank entries do not count");
  assert.equal(builderSettings({}), null, "an older config without the key");
  const both = mergeConfig({ permissions: { allow: ["Bash(ssh pve *)", "Bash(docker *)"], environment: ["The Proxmox host pve at 10.0.0.2 is ours"] } });
  assert.deepEqual(JSON.parse(builderSettings(both)), { permissions: { allow: ["Bash(ssh pve *)", "Bash(docker *)"] }, autoMode: { environment: ["$defaults", "The Proxmox host pve at 10.0.0.2 is ours"] } });
  assert.deepEqual(JSON.parse(builderSettings({ permissions: { allow: ["Bash(docker *)"] } })), { permissions: { allow: ["Bash(docker *)"] } }, "only the parts that have entries");
  assert.deepEqual(JSON.parse(builderSettings({ permissions: { environment: ["x"] } })), { autoMode: { environment: ["$defaults", "x"] } });
  assert.deepEqual(launchOptions(mergeConfig({ builder: { effort: "max" } })), { model: "opus", effort: "max", settings: null });
  assert.deepEqual(launchOptions(mergeConfig({})), { model: "opus", effort: null, settings: null });
  // Ultracode's orchestration stays off in runs (D54): "ultracode" launches at xhigh.
  assert.deepEqual(launchOptions(mergeConfig({ builder: { effort: "ultracode" } })), { model: "opus", effort: "xhigh", settings: null });
});

test("decide: a fresh-session request replaces the session, waits for a verification, and never counts as a relaunch", () => {
  const f = decide(base({ freshSession: true }));
  assert.deepEqual([f.action, f.reason], ["fresh", "the feature is verified; a fresh builder session takes the next one"]);
  assert.equal(decide(base({ freshSession: true, childAlive: false })).action, "fresh", "an exited session is replaced by a fresh one, not resumed");
  assert.equal(decide(base({ freshSession: true, childAlive: false, sup: { recoveries: 2, countAtLastRecovery: 10, resumedAt: null } })).action, "fresh", "never paused as stuck");
  const wait = decide(base({ freshSession: true, gateAt: T - MIN }));
  assert.deepEqual([wait.action, wait.reason], ["none", "the gate is verifying; the fresh session waits"]);
  assert.equal(decide(base({ freshSession: true, status: "paused", pauseReason: "review" })).action, "none", "a paused run waits for the resume");
});

test("supervise: a fresh-session request ends the builder and opens a new session under a new id, with effort and permissions", async () => {
  const root = fakeProject("running", { builderSessionId: "b-1" });
  const settings = { permissions: { allow: ["Bash(docker *)"], environment: ["the local Docker engine is ours"] } };
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, builder: { effort: "xhigh" }, ...settings, supervisor: { pollSec: 60, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 2 } }));
  const h = harness(root);
  const p = h.run(3);
  for (let i = 0; i < 200 && h.launches.length < 1; i++) await tick();
  // The gate verified a feature and asks for a fresh session.
  saveState(root, { ...loadState(root), freshSession: true });
  await p;
  const json = JSON.stringify({ permissions: { allow: ["Bash(docker *)"] }, autoMode: { environment: ["$defaults", "the local Docker engine is ours"] } });
  assert.deepEqual(h.launches, [
    `--resume b-1 --model opus --effort xhigh --settings ${json} --permission-mode auto /autoclaude:resume`,
    `--session-id sess-1 --model opus --effort xhigh --settings ${json} --permission-mode auto /autoclaude:resume`
  ]);
  assert.deepEqual(h.kills, [h.children[0].pid], "the old session was ended first");
  const s = loadState(root);
  assert.deepEqual([s.builderSessionId, s.freshSession], ["sess-1", false]);
  const sup = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "supervisor.json"), "utf8"));
  assert.equal(sup.recoveries, 0, "not a recovery");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /fresh: the feature is verified/);
});

test("supervise: a supervisor that starts on a pending fresh-session request opens the fresh session at once", async () => {
  const root = fakeProject("running", { builderSessionId: "b-9", freshSession: true });
  const h = harness(root);
  await h.run(1);
  assert.deepEqual(h.launches, ["--session-id sess-1 --model opus --permission-mode auto /autoclaude:resume"]);
  assert.deepEqual([loadState(root).builderSessionId, loadState(root).freshSession], ["sess-1", false]);
});

// The state a gate leaves when its session is ended in the middle of a verification: the plan
// ticked, the PROGRESS line written, and the snapshot that names both.
function cutVerification(root) {
  const planFile = path.join(root, "PLAN.md");
  const plan = fs.readFileSync(planFile, "utf8");
  const line = "- 2026-09-28 S1.1 One (attempt 1)\n";
  fs.writeFileSync(planFile, plan.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  fs.writeFileSync(path.join(root, "PROGRESS.md"), "# Progress\n" + line);
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autoclaude", "verify-pending.json"), JSON.stringify({ step: "S1.1", plan, progress: "# Progress\n", ticked: ["S1.1"], added: line }));
  return plan;
}

test("supervise: ending a session in the middle of a verification takes that gate's ticks and PROGRESS lines out at once, but never under a live gate", async () => {
  let root = fakeProject("running", { builderSessionId: "b-6" });
  const plan = cutVerification(root);
  let h = harness(root);
  const p = h.run(3);
  for (let i = 0; i < 200 && h.launches.length < 1; i++) await tick();
  // The launch itself found the leftovers of a gate that died with an earlier session.
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), plan);
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), "# Progress\n");
  // `pause --now` while the new session's gate verifies: the supervisor ends the session.
  cutVerification(root);
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true });
  await p;
  assert.deepEqual(h.kills, [h.children[0].pid]);
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), plan, "the owner reviews the plan as it is");
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), "# Progress\n");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")), false);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /verification of S1\.1 was cut off with the session/);

  // A gate that is still alive (it holds gate.json) finishes, or undoes, its own verification.
  root = fakeProject("running", { builderSessionId: "b-8" });
  cutVerification(root);
  fs.writeFileSync(path.join(root, ".autoclaude", "gate.json"), JSON.stringify({ pid: process.pid, at: new Date(T).toISOString() }));
  h = harness(root);
  await h.run(1);
  assert.match(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), /- \[x\] \*\*S1\.1\*\*/);
  assert.ok(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")));
});

test("supervise: supervisor.json is written only when it changes, and the window's PATH is recorded for the checks", async () => {
  const root = fakeProject("running", { builderSessionId: "b-4" });
  const rt = path.join(root, ".autoclaude");
  const supFile = path.join(rt, "supervisor.json");
  let clock = T;
  let polls = 0;
  const spawnChild = (args) => { const c = new EventEmitter(); c.pid = 3000; return c; };
  // After the first poll wrote the file, a probe key is added behind the supervisor's back: a
  // rewrite would drop it. Nothing changes for the next polls, so it must survive them.
  const sleep = async (ms) => {
    clock += ms;
    if (++polls === 2) {
      const j = fs.existsSync(supFile) ? JSON.parse(fs.readFileSync(supFile, "utf8")) : {};
      fs.writeFileSync(supFile, JSON.stringify({ ...j, probe: 1 }));
    }
    await new Promise((r) => setImmediate(r));
  };
  const env = { PATH: "C:\\run\\path", CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-cfg-")) };
  await supervise({ root, env, spawnChild, agentStatus: () => "busy", say: async () => {}, now: () => clock, sleep, maxLoops: 5, console: { log() {} } });
  assert.equal(JSON.parse(fs.readFileSync(supFile, "utf8")).probe, 1, "no rewrite while nothing changed");
  const runEnv = JSON.parse(fs.readFileSync(path.join(rt, "run-env.json"), "utf8"));
  assert.equal(runEnv.PATH, "C:\\run\\path");
});

test("supervise: the optional morning summary goes out once a day, at low priority", async () => {
  const root = fakeProject("running");
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, notify: { morningSummaryAt: "00:00" }, supervisor: { pollSec: 60, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 2 } }));
  const h = harness(root);
  await h.run(3);
  const morning = h.sent.filter((m) => /morning summary/.test(m.title));
  assert.equal(morning.length, 1, "three polls on one day, one summary");
  assert.equal(morning[0].priority, "low");
  assert.match(morning[0].message, /Steps: 0\/1 verified/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /sent the morning summary/);
});

// ---------- claude from an npm install (a .cmd shim) ----------

test("spawnClaude: a .cmd or .bat runs through cmd.exe with every argument escaped; a native claude is spawned as it is", () => {
  const calls = [];
  const spawnFn = (cmd, args, opts) => { calls.push({ cmd, args, opts }); return {}; };
  const args = ["--settings", "{\"a\":\"b & c\"}", "/autoclaude:start"];
  spawnClaude("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", args, { cwd: "x" }, { windows: true, spawnFn });
  assert.equal(calls[0].cmd, "cmd.exe");
  assert.deepEqual(calls[0].args.slice(0, 3), ["/d", "/s", "/c"]);
  assert.equal(calls[0].args[3], cmdShimLine("C:\\Users\\me\\AppData\\Roaming\\npm\\claude.cmd", args));
  assert.deepEqual([calls[0].opts.cwd, calls[0].opts.windowsVerbatimArguments], ["x", true]);
  // Quoted for the program, then every cmd metacharacter escaped twice (the shim's %* is parsed again).
  assert.equal(cmdShimArg("b & c"), "^^^\"b^^^ ^^^&^^^ c^^^\"");
  assert.equal(cmdShimArg("a\\"), "^^^\"a\\\\^^^\"", "a trailing backslash is doubled so it does not escape the quote");
  spawnClaude("C:\\Users\\me\\.local\\bin\\claude.exe", args, {}, { windows: true, spawnFn });
  spawnClaude("/usr/local/bin/claude.cmd", args, {}, { windows: false, spawnFn });
  assert.deepEqual(calls.slice(1).map((c) => [c.cmd, c.args]), [["C:\\Users\\me\\.local\\bin\\claude.exe", args], ["/usr/local/bin/claude.cmd", args]]);
});

test("supervise: claude resolved to an npm claude.cmd starts, and gets its arguments exactly, the permissions JSON included", { skip: process.platform !== "win32" && "a .cmd shim is Windows-only" }, async () => {
  const root = fakeProject("idle");
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, permissions: { allow: ["Bash(npm run *)"], environment: ["the db (10.0.0.9) & its 50% | ^ \"quoted\" host"] }, supervisor: { pollSec: 60, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 2 } }));
  // An npm-style shim in a folder with a space: it hands %* to node, like npm's claude.cmd.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude npm "));
  const out = path.join(dir, "argv.json");
  fs.writeFileSync(path.join(dir, "cli.js"), `require("fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify(process.argv.slice(2)));`);
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, `@ECHO off\r\nSETLOCAL\r\n"${process.execPath}" "${path.join(dir, "cli.js")}" %*\r\n`);
  const env = { PATH: process.env.PATH || process.env.Path, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-cfg-")), AUTOCLAUDE_CLAUDE_BIN: shim };
  const sleep = async () => { for (let i = 0; i < 200 && !fs.existsSync(out); i++) await new Promise((r) => setTimeout(r, 50)); };
  const r = await supervise({ root, env, say: async () => {}, sleep, maxLoops: 0, newSessionId: () => "sess-9", console: { log() {} } });
  assert.equal(r.exit, "done");
  const settings = JSON.stringify({ permissions: { allow: ["Bash(npm run *)"] }, autoMode: { environment: ["$defaults", "the db (10.0.0.9) & its 50% | ^ \"quoted\" host"] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(out, "utf8")), ["--session-id", "sess-9", "--model", "opus", "--settings", settings, "--permission-mode", "auto", "/autoclaude:start"]);
});

test("supervise: a claude that cannot be started at all does not crash the supervisor; the stuck pause says why", async () => {
  const root = fakeProject("running", { builderSessionId: "b-1" });
  const sent = [];
  let clock = T;
  const r = await supervise({
    root, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-cfg-")) },
    // What Node does with a .cmd and no shell: a synchronous throw.
    spawnChild: () => { throw Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }); },
    agentStatus: () => null, say: async (m) => { sent.push(m); }, now: () => clock, sleep: async (ms) => { clock += ms; }, maxLoops: 4, kill: () => true, newSessionId: () => "s", console: { log() {} }
  });
  assert.equal(r.exit, "done");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "stuck"]);
  assert.match(sent[0].message, /claude could not start: spawn EINVAL/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /claude could not start: spawn EINVAL/);
});
