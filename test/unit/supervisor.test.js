import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { decide, childEnv, launchArgs, supervise } from "../../plugins/autoclaude/lib/supervisor.js";
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

test("childEnv drops parent-session variables and keeps the config dir; launch arguments", () => {
  const e = childEnv({ PATH: "x", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_PLUGIN_ROOT: "r", CLAUDE_CONFIG_DIR: "c", AUTOCLAUDE_ROLE: "tester" });
  assert.deepEqual(e, { PATH: "x", CLAUDE_CONFIG_DIR: "c" });
  assert.deepEqual(launchArgs("start"), ["--permission-mode", "auto", "/autoclaude:start"]);
  assert.deepEqual(launchArgs("resume"), ["--continue", "--permission-mode", "auto", "/autoclaude:resume"]);
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
  const run = (maxLoops) => supervise({ root, env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-sup-cfg-")) }, spawnChild, agentStatus: () => "idle", say: async (m) => { sent.push(m); }, now: () => clock, sleep, maxLoops, console: out });
  return { run, launches, children, sent, out, clock: () => clock };
}

test("supervise: a running run is resumed with --continue; an exited session is relaunched; two dead relaunches pause as stuck", async () => {
  const root = fakeProject("running");
  const h = harness(root, { exitAfterLaunch: true });
  await h.run(5);
  assert.equal(h.launches[0], "--continue --permission-mode auto /autoclaude:resume");
  assert.equal(h.launches.length, 3, "first launch plus two relaunches");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "stuck"]);
  assert.equal(h.sent.length, 1);
  assert.match(h.sent[0].title, /stuck on S1\.1/);
  assert.equal(h.sent[0].priority, "high");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "supervisor.pid")), false, "the pid file is removed when the supervisor ends");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "supervisor.log"), "utf8"), /relaunch: the session exited/);
});

test("supervise: an idle run is started with /autoclaude:start; a paused run waits and relaunches after resume", async () => {
  let root = fakeProject("idle");
  let h = harness(root);
  await h.run(1);
  assert.equal(h.launches[0], "--permission-mode auto /autoclaude:start");

  root = fakeProject("paused", { pauseReason: "review" });
  h = harness(root);
  const p = h.run(6);
  // The owner resumes while the supervisor waits; with no session alive it launches at once.
  await new Promise((r) => setTimeout(r, 30));
  saveState(root, { ...loadState(root), status: "running", pauseReason: null });
  await p;
  assert.deepEqual(h.launches, ["--continue --permission-mode auto /autoclaude:resume"]);
  assert.equal(loadState(root).supervisorPid, process.pid);
  assert.match(loadState(root).windowTitle, /^ac-autoclaude-sup-/);
});

test("supervise: a nudge restarts with its prompt, and when that ends idle the run continues without counting a recovery", async () => {
  const root = fakeProject("running");
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
    "--continue --permission-mode auto /autoclaude:resume",
    "--continue --permission-mode auto /compact",
    "--continue --permission-mode auto /autoclaude:resume"
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
  assert.deepEqual(launches, ["--continue --permission-mode auto /autoclaude:resume"], "no relaunch in the two polls after the gate ended");
  assert.doesNotMatch(fs.readFileSync(path.join(rt, "logs", "supervisor.log"), "utf8"), /relaunch/);
});

test("supervise: a complete run exits at once without launching anything", async () => {
  const root = fakeProject("complete");
  const h = harness(root);
  const r = await h.run(3);
  assert.equal(r.exit, "complete");
  assert.deepEqual(h.launches, []);
});
