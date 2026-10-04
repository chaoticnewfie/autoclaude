// A feature's verification spread over turns (P10.13, D60): its parts (each check, the browser
// tester, the bug bash, the security review) run as far as they fit in one stop, the rest waits
// for the next, and nothing about that is counted against the builder. By default the security
// review runs alongside the browser checks (checkers.parallel). The gate runs through
// lib/gate.js with a fake clock and fake checkers on a scratch copy of the fixture; nothing here
// touches this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { resumeRun, undoCutVerification, pendingVerifyFile } from "../../plugins/autoclaude/lib/resume.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { writeReady } from "../../plugins/autoclaude/lib/protocol.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";
import { buildContext } from "../../plugins/autoclaude/scripts/session-context.js";
import { runCli } from "../../plugins/autoclaude/lib/cli.js";
import { runSecurityReview } from "../../plugins/autoclaude/lib/security.js";
import { estimatePlan } from "../../plugins/autoclaude/lib/estimate.js";

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-staged-cfg-"));

const node = JSON.stringify(process.execPath);
const env = gitEnv({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` });
// Every check appends to one file, so the fake clock can move with the checks that ran.
const counting = (name, extra = {}) => ({ name, command: `${node} -e "require('fs').appendFileSync('.autoclaude/check-runs','x')"`, timeoutSec: 60, ...extra });
const FAIL = { name: "unit", command: `${node} -e "console.log('boom'); process.exit(1)"`, timeoutSec: 60 };

const FEATURES = "# Features plan\n\n## Phase 1: Lists\n- [ ] **S1.1** One\n  - Accept: the page shows one\n  - Tags: ui\n- [ ] **S1.2** Two\n  - Accept: the page shows two\n  - Tags: ui\n- [ ] **S1.3** Three\n  - Accept: the store counts three\n  - Test: test/todos.test.js\n  - Tags: no-ui\n\n## Phase 2: More\n- [ ] **S2.1** Four\n  - Accept: the page shows four\n  - Tags: ui\n- [ ] **S2.2** Five\n  - Accept: the page shows five\n  - Tags: ui\n\n## Phase 3: Store\n- [ ] **S3.1** Six\n  - Accept: the store keeps six\n  - Test: test/todos.test.js\n  - Tags: no-ui\n";

const sent = [];
const base = { env, notify: async (msg) => { sent.push(msg); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null, noteFootprint: null, finishFootprint: null, writeHandoff: null, readCheckTimes: () => ({}), recordCheckTimes: () => {} };
const DEAD_PID = 2 ** 30;
const T0 = Date.parse("2026-10-03T10:00:00Z");
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env });
const gitLog = (root) => git(root, "log", "--format=%s").stdout.trim().split("\n");
const treeClean = (root) => git(root, "status", "--porcelain").stdout.trim() === "";
const markers = (root) => parsePlan(fs.readFileSync(path.join(root, "PLAN.md"), "utf8")).steps.map((s) => s.marker).join("");
const progressText = (root) => fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8");
const count = (text, needle) => text.split(needle).length - 1;
const checkRuns = (root) => { try { return fs.readFileSync(path.join(root, ".autoclaude", "check-runs"), "utf8").length; } catch { return 0; } };
const snapshot = (root) => { try { return JSON.parse(fs.readFileSync(pendingVerifyFile(root), "utf8")); } catch { return null; } };
const types = (r) => r.events.map((e) => e.type);
const tick = () => new Promise((r) => setImmediate(r));

function scratch({ checks = [counting("unit")], gate = { verifyAt: "phase" }, cfg = {} } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-staged-"));
  prepareFixture({ dest, plan: "happy", git: true, checks, devServer: { command: "npm run dev", url: "http://127.0.0.1:4173", healthPath: "/health", startTimeoutSec: 10 }, env });
  fs.writeFileSync(path.join(dest, "PLAN.md"), FEATURES);
  const cfgFile = path.join(dest, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), gate, ...cfg }, null, 2) + "\n");
  git(dest, "commit", "-qam", "fixture: features plan");
  saveState(dest, { ...defaultState(), status: "running", currentStep: "S1.1", tickedByGate: [], startedAt: new Date().toISOString() });
  return dest;
}

const project = (root) => ({ root, config: mergeConfig(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"))) });

function editConfig(root, change) {
  const cfgFile = path.join(root, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify(change(JSON.parse(fs.readFileSync(cfgFile, "utf8"))), null, 2) + "\n");
}

// A fake clock for one stop: it starts where the stop starts, moves `perCheck` s with every check
// that runs, and moves whatever a fake checker adds to `t.extra`. Each stop gets a fresh one. A
// stop has 1740 s for its parts (gate.timeoutSec 1800, less a minute for the commit).
function stopClock(root, t, perCheck) {
  let stop = 0;
  return () => {
    t.extra = 0;
    t.runs0 = checkRuns(root);
    const startedAt = T0 + ++stop * 3600000;
    t.clock = () => startedAt + (checkRuns(root) - t.runs0) * perCheck * 1000 + t.extra;
    return t.clock;
  };
}

// Fake checkers that record their calls; `took` is how long each takes, in s of the fake clock.
function checkers(t, took = {}, results = {}) {
  const calls = [];
  const result = (kind) => (typeof results[kind] === "function" ? results[kind](calls.length) : results[kind]);
  const runTester = async (a) => {
    calls.push(`${a.kind}:${a.step.id}${a.steps ? `[${a.steps.map((s) => s.id).join(",")}]` : ""}`);
    t.extra += (took[a.kind] || 0) * 1000;
    return result(a.kind) || { status: "passed", sections: [{ title: `${a.kind}: passed`, body: "ok" }], followUps: [] };
  };
  const runSecurity = async (a) => {
    calls.push(`security:${a.step.id}`);
    t.extra += (took.security || 0) * 1000;
    return result("security") || { status: "passed", sections: [{ title: "Security review: passed", body: "ok" }], findings: [] };
  };
  return { calls, deps: { runTester, runSecurity, restartDevServer: async () => ({ ok: true, reused: false }) } };
}

// Fake checkers that log when each starts and ends. spec[kind]: { waitFor: "<log entry>" (it
// does not end before that entry is logged, or 200 ticks), took (s of the fake clock), result }.
function logged(t, spec = {}) {
  const log = [];
  const one = (kind) => async () => {
    log.push(`start:${kind}`);
    const s = spec[kind] || {};
    if (s.waitFor) for (let i = 0; i < 200 && !log.includes(s.waitFor); i++) await tick();
    t.extra += (s.took || 0) * 1000;
    log.push(`end:${kind}`);
    return s.result || (kind === "security" ? { status: "passed", sections: [{ title: "Security review: passed", body: "ok" }], findings: [] } : { status: "passed", sections: [{ title: `${kind}: passed`, body: "ok" }], followUps: [] });
  };
  return { log, deps: { runTester: (a) => one(a.kind)(a), runSecurity: one("security"), restartDevServer: async () => ({ ok: true, reused: false }) } };
}

function harness(root, took = {}, results = {}, extra = {}, { perCheck = 700 } = {}) {
  const t = { extra: 0 };
  const next = stopClock(root, t, perCheck);
  const c = checkers(t, took, results);
  const stop = (more = {}) => runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, { ...base, ...c.deps, root, clock: next(), ...extra, ...more });
  return { t, calls: c.calls, stop, ready: (id, more) => { writeReady(root, id); return stop(more); } };
}

async function build(h, ids) {
  for (const id of ids) {
    const r = await h.ready(id);
    assert.match(r.reason || "", new RegExp(`^${id.replace(".", "\\.")} built and committed`), JSON.stringify(r.events));
  }
}

test("a verification that does not fit is carried to the next turn, with nothing counted, and the next stop finishes it: one commit, every part run once", async () => {
  const root = scratch();
  // The check takes 700 s and the tester 700 s of the 1740 s: the bug bash (900 s) no longer
  // fits after them. The security review ran alongside the tester.
  const h = harness(root, { tester: 700 });
  await build(h, ["S1.1", "S1.2"]);
  const progressBefore = progressText(root);
  let r = await h.ready("S1.3");
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) goes on in the next turn: check "unit", the browser tester and the security review are done, and the bug bash would not fit in what is left of this stop\. Nothing failed and no attempt was counted\. End your turn now without changing anything/);
  assert.ok(types(r).includes("staged"));
  assert.equal(types(r).includes("passed"), false);
  assert.equal(markers(root), "xxx   ", "the ticks stay for the next stop");
  assert.equal(gitLog(root)[0], "autoclaude(S1.2): Two", "nothing committed yet");
  let s = loadState(root);
  assert.deepEqual([s.verifying.parked, s.verifying.done, s.verifying.turns, s.verifying.pid], [true, ["check:0:unit", "tester", "security"], 1, null]);
  assert.deepEqual([s.attempts["S1.3"] || 0, s.outOfTime["S1.3"] || 0, s.tickedByGate, s.currentStep, s.noProgress], [0, 0, ["S1.1", "S1.2"], "S1.3", 0]);
  assert.match(s.verifying.tree, /^[0-9a-f]{40}$/);
  assert.deepEqual(s.verifying.left, ["bugbash"], "what is left, for status and a builder session started meanwhile");
  assert.equal(snapshot(root).pid, null, "no live gate holds the snapshot between the stops");
  // A builder session started now (a relaunch) is told to end its turn untouched, and
  // `autoclaude status` says where the verification stands.
  const ctx = buildContext({ root, state: s, config: project(root).config, planText: fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), progressText: "", promptTemplate: "" });
  assert.match(ctx, /## Verification in progress: Phase 1 \(Lists\)\n\nThe gate is verifying Phase 1 \(Lists\), at S1\.3, over more than one turn: check "unit", the browser tester and the security review are done, and the bug bash is left\. It carries on when this turn ends\. End your turn now without changing anything/);
  let out = "";
  assert.equal(await runCli(["status"], { cwd: root, stdout: { write: (x) => { out += x; return true; } }, stderr: { write: () => true }, env: { PATH: "" } }), 0);
  assert.match(out, /\n {2}verification: Phase 1 \(Lists\), at S1\.3, carried over to the next turn after 1 stop; the gate carries it on when the builder's turn ends; check "unit", the browser tester and the security review are done, and the bug bash is left\n/);
  const runs = checkRuns(root);

  // The builder ended its turn; the next stop needs no ready.
  r = await h.stop();
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.deepEqual(types(r).filter((x) => /^(verify|verify-continued|integrity-reverted|tester|bugbash|security|passed|staged)$/.test(x)), ["verify-continued", "bugbash", "passed"]);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  assert.equal(checkRuns(root), runs, "the checks are not run again");
  assert.deepEqual(h.calls, ["tester:S1.3[S1.1,S1.2]", "security:S1.3", "bugbash:S1.3"]);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.3\)/.test(l)).length, 1);
  assert.equal(markers(root), "xxx   ");
  const progress = progressText(root);
  assert.ok(progress.startsWith(progressBefore));
  for (const line of ["S1.1 One (attempt 1)", "S1.2 Two (attempt 1)", "S1.3 Three (attempt 1)"]) assert.equal(count(progress, line), 1, line);
  s = loadState(root);
  assert.deepEqual([s.verifying, s.currentStep, s.attempts["S1.3"], s.closing], [null, "S2.1", 0, null]);
  assert.equal(snapshot(root), null);
  const body = git(root, "log", "-1", "--format=%B").stdout;
  assert.match(body, /\nChecks:\n- unit: passed in \d+ s\n- browser tester \(alongside the security review\): passed in \d+ s\n- security review \(alongside the browser tester\): passed in \d+ s\n- bug bash: passed in \d+ s\n/);
  const report = fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.3-1.md"), "utf8");
  assert.match(report, /Spread over turns[\s\S]*ran over 2 stops/);
  assert.ok(treeClean(root));

  // A phase that fits takes one turn, with no extra message.
  const h2 = harness(root);
  await build(h2, ["S2.1"]);
  r = await h2.ready("S2.2");
  assert.match(r.reason, /^Phase 2 \(More\) verified and committed/, JSON.stringify(r.events));
  assert.equal(types(r).includes("staged"), false);
});

test("over three turns with the check times on record: a check fits by its recent time, one that would not waits, each part runs once, and the times of every check that ran are recorded", async () => {
  const root = scratch({ checks: [counting("a"), counting("b"), counting("c", { timeoutSec: 900 }), counting("d", { timeoutSec: 900 })] });
  const recorded = [];
  const times = { c: { recentMs: [380000, 400000, 420000], medianMs: 400000 }, d: { recentMs: [400000], medianMs: 400000 } };
  // Each check takes 570 s. c and d are expected to need 400 s and a quarter, 500 s: c fits in
  // the 600 s left after a and b (its timeoutSec of 900 s would not), d not in the 30 s after c.
  const h = harness(root, { tester: 700 }, {}, { readCheckTimes: () => times, recordCheckTimes: (_root, results) => { recorded.push(results.map((x) => [x.name, typeof x.durationMs])); } }, { perCheck: 570 });
  await build(h, ["S1.1", "S1.2"]);
  const runs = checkRuns(root);
  let r = await h.ready("S1.3");
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) goes on in the next turn: check "a", check "b" and check "c" are done, and check "d", the browser tester, the bug bash and the security review would not fit/, JSON.stringify(r.events));
  assert.equal(checkRuns(root), runs + 3);
  assert.deepEqual(recorded, [[["a", "number"], ["b", "number"], ["c", "number"]]]);
  // Turn 2: d (570 s), then the tester and the security review together (expected to need 100 s
  // and 225 s, 1170 s left); the tester takes 700 s, and the bug bash (525 s: 420 s and a quarter)
  // does not fit in the 470 s left.
  r = await h.stop();
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) goes on in the next turn: check "a", check "b", check "c", check "d", the browser tester and the security review are done, and the bug bash would not fit/, JSON.stringify(r.events));
  assert.equal(checkRuns(root), runs + 4);
  assert.deepEqual(recorded, [[["a", "number"], ["b", "number"], ["c", "number"]], [["d", "number"]]]);
  assert.equal(loadState(root).verifying.turns, 2);
  r = await h.stop();
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(checkRuns(root), runs + 4, "every check ran once");
  assert.deepEqual(h.calls, ["tester:S1.3[S1.1,S1.2]", "security:S1.3", "bugbash:S1.3"]);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.3-1.md"), "utf8"), /ran over 3 stops/);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.3\)/.test(l)).length, 1);
  assert.ok(treeClean(root));
});

test("files changed between the turns start the verification again from its first part, counting nothing; the resume file alone does not; the third change pauses the run", async () => {
  let root = scratch();
  let h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  // The builder changed CONTINUE_HERE.md only: the verification carries on.
  fs.writeFileSync(path.join(root, "CONTINUE_HERE.md"), "# CONTINUE_HERE\n\nWaiting for the verification of Phase 1.\n");
  let r = await h.stop();
  assert.ok(types(r).includes("verify-continued"), JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  assert.match(git(root, "show", "--name-only", "--format=", "HEAD").stdout, /CONTINUE_HERE\.md/);

  // A real change: from the first part again, on the files as they are, in the same stop.
  root = scratch();
  h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  const runs = checkRuns(root);
  fs.writeFileSync(path.join(root, "late.js"), "export const late = 1;\n");
  r = await h.stop({ runTester: checkers(h.t).deps.runTester });
  assert.deepEqual(types(r).filter((x) => /^verify/.test(x)), ["verify-restarted", "verify"], JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  assert.equal(checkRuns(root), runs + 1, "the checks ran again on the changed files");
  assert.match(git(root, "show", "--name-only", "--format=", "HEAD").stdout, /late\.js/);
  for (const line of ["S1.1 One (attempt 1)", "S1.2 Two (attempt 1)", "S1.3 Three (attempt 1)"]) assert.equal(count(progressText(root), line), 1, line);
  let s = loadState(root);
  assert.deepEqual([s.attempts["S1.3"], s.outOfTime["S1.3"] || 0, s.verifying], [0, 0, null]);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /the files changed since the last stop of the verification of Phase 1; it starts again from its first part, and nothing is counted/);

  // Something keeps changing the files between the turns: the third change pauses the run.
  root = scratch();
  h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  for (let n = 1; n <= 2; n++) {
    fs.writeFileSync(path.join(root, `churn-${n}.txt`), `${n}\n`);
    r = await h.stop();
    assert.ok(types(r).includes("verify-restarted") && types(r).includes("staged"), JSON.stringify(r.events));
    assert.equal(loadState(root).verifying.restarts, n);
  }
  fs.writeFileSync(path.join(root, "churn-3.txt"), "3\n");
  const before = sent.length;
  r = await h.stop();
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.verifying, s.attempts["S1.3"] || 0], ["paused", "stuck", null, 0]);
  assert.equal(markers(root), "~~    ", "its ticks came out");
  assert.equal(snapshot(root), null);
  assert.match(sent.slice(before).find((m) => m.priority === "high").message, /the files changed between its stops 3 times/);
});

test("pause --now between two turns: the halt and the resume leave the carried-over verification alone, and the next stop finishes it; an owner's edit starts it again; an owner's untick takes it out", async () => {
  const pauseNow = (root) => saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true });
  let root = scratch();
  let h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  pauseNow(root);
  // The supervisor ends the session, then looks for a cut-off verification: there is none.
  assert.equal(undoCutVerification(root, project(root).config, { unlessGateRunning: true }), null);
  assert.equal(markers(root), "xxx   ");
  const changes = resumeRun(project(root), loadState(root));
  assert.ok(changes.some((c) => /the verification of Phase 1 was carried over between two stops; the next stop carries it on \(3 of its parts are done; left: the bug bash\), or starts it again if the files change before then\. The builder ends its turn without changing anything, so the gate can carry it on$/.test(c)), changes.join("\n"));
  assert.equal(changes.some((c) => /ticked by the owner|unticked by the owner|current step is now/.test(c)), false, changes.join("\n"));
  let s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.tickedByGate, s.verifying && s.verifying.parked, s.haltSession, !!s.phaseBaseCommit], ["running", "S1.3", ["S1.1", "S1.2"], true, false, true]);
  let r = await h.stop();
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.deepEqual(h.calls, ["tester:S1.3[S1.1,S1.2]", "security:S1.3", "bugbash:S1.3"]);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.3\)/.test(l)).length, 1);
  assert.ok(treeClean(root));

  // The owner edits a file during the pause: the next stop starts the verification again, and
  // the owner's edit is in the verified commit.
  root = scratch();
  h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  pauseNow(root);
  fs.writeFileSync(path.join(root, "owner-edit.js"), "export const owner = 1;\n");
  resumeRun(project(root), loadState(root));
  r = await h.stop({ runTester: checkers(h.t).deps.runTester });
  assert.ok(types(r).includes("verify-restarted"), JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  assert.match(git(root, "show", "--name-only", "--format=", "HEAD").stdout, /owner-edit\.js/);

  // The owner unticks S1.2 during the pause: the verification is taken out, like a cut-off one.
  root = scratch();
  h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  pauseNow(root);
  const file = path.join(root, "PLAN.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- [x] **S1.2**", "- [ ] **S1.2**"));
  const dropped = resumeRun(project(root), loadState(root));
  assert.ok(dropped.some((c) => /carried over between two stops, but the owner changed its ticks: it was taken out \(unticked S1\.1, S1\.3\)/.test(c)), dropped.join("\n"));
  assert.equal(markers(root), "~     ");
  s = loadState(root);
  assert.deepEqual([s.verifying, s.currentStep, s.tickedByGate], [null, "S1.2", ["S1.1"]]);
  assert.equal(snapshot(root), null);
  assert.equal(count(progressText(root), "S1.3 Three (attempt 1)"), 0);
});

test("a gate cut off in a later turn of a verification is a cut-off like any other: undone and counted, and the next ready verifies from the start", async () => {
  const root = scratch();
  const h = harness(root, { tester: 1000 });
  await build(h, ["S1.1", "S1.2"]);
  const progressBefore = progressText(root);
  await h.ready("S1.3");
  // Turn 2: the bug bash never returns; the hook's timeout kills the gate (a pid nobody has).
  let reached;
  const at = new Promise((res) => { reached = res; });
  h.stop({ pid: DEAD_PID, runTester: async () => { reached(); return new Promise(() => {}); } });
  await at;
  let s = loadState(root);
  assert.deepEqual([s.verifying.parked, s.verifying.pid, snapshot(root).pid], [false, DEAD_PID, DEAD_PID]);
  // The next stop.
  let r = await h.stop();
  assert.deepEqual(r.events[0], { type: "verify-interrupted", step: "S1.3", count: 1 });
  assert.match(r.reason, /^Continue S1\.3/);
  assert.equal(markers(root), "~~    ");
  assert.equal(progressText(root), progressBefore);
  s = loadState(root);
  assert.deepEqual([s.verifying, s.outOfTime["S1.3"], s.attempts["S1.3"] || 0], [null, 1, 0]);
  assert.equal(snapshot(root), null);
  // Its ready verifies it from the start again.
  r = await h.ready("S1.3");
  assert.ok(types(r).includes("verify") && types(r).includes("staged"), JSON.stringify(r.events));

  // The supervisor's undo after a session died in a later turn: the same, and state.verifying goes.
  const root2 = scratch();
  const h2 = harness(root2, { tester: 1000 });
  await build(h2, ["S1.1", "S1.2"]);
  await h2.ready("S1.3");
  let reached2;
  const at2 = new Promise((res) => { reached2 = res; });
  h2.stop({ pid: DEAD_PID, runTester: async () => { reached2(); return new Promise(() => {}); } });
  await at2;
  const cut = undoCutVerification(root2, project(root2).config, { unlessGateRunning: true });
  assert.deepEqual([cut.step, cut.count], ["S1.3", 1]);
  assert.deepEqual([markers(root2), loadState(root2).verifying], ["~~    ", null]);
});

test("a part stopped at the deadline after another part of its stop is carried over, not counted; the first part of a stop that runs out of time is out of time, and the second time the alert names verify-per-step", async () => {
  const outOfTime = (label) => ({ status: "out-of-time", failed: `${label} ran out of the gate's time (1 try): stopped at the gate's deadline`, sections: [{ title: `${label}: out of time`, body: "x" }], followUps: [], findings: [] });
  let root = scratch();
  let n = 0;
  // The tester runs out of the stop's time the first time (after the check), passes the second.
  let h = harness(root, {}, { tester: () => (++n === 1 ? outOfTime("Browser tester") : null) });
  await build(h, ["S1.1", "S1.2"]);
  let r = await h.ready("S1.3");
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) goes on in the next turn: check "unit" and the security review are done, and the browser tester and the bug bash would not fit/, JSON.stringify(r.events));
  assert.equal(loadState(root).outOfTime["S1.3"] || 0, 0);
  r = await h.stop();
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));

  // The bug bash, first in its stop, runs out of time: the existing out-of-time path, twice.
  root = scratch();
  h = harness(root, { tester: 1000 }, { bugbash: outOfTime("Bug bash") });
  await build(h, ["S1.1", "S1.2"]);
  await h.ready("S1.3");
  r = await h.stop();
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) ran out of time: Bug bash ran out of the gate's time/);
  let s = loadState(root);
  assert.deepEqual([s.outOfTime["S1.3"], s.attempts["S1.3"] || 0, s.verifying], [1, 0, null]);
  assert.equal(markers(root), "~~    ", "the ticks came out");
  await h.ready("S1.3");
  const before = sent.length;
  r = await h.stop();
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.verifying], ["paused", "out-of-time", null]);
  const alert = sent.slice(before).find((m) => m.priority === "high");
  assert.match(alert.title, /S1\.3 does not fit in one verification/);
  assert.match(alert.message, /The quickest way on, with no change to the plan: `[^`]*verify-per-step 1`, then `[^`]*resume`\. Phase 1 is then verified one step at a time\./);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /paused, out of time: .*verify-per-step 1/);
});

test("gate.stepPhases: a listed phase is verified step by step even when verifyAt is phase; the others stay per feature; resume reopens its built steps; the alert does not offer what is already done", async () => {
  let root = scratch({ gate: { verifyAt: "phase", stepPhases: [1] } });
  let h = harness(root);
  let r = await h.ready("S1.1");
  assert.match(r.reason, /^S1\.1 verified and committed/, JSON.stringify(r.events));
  r = await h.ready("S1.2");
  assert.match(r.reason, /^S1\.2 verified and committed/);
  r = await h.ready("S1.3");
  assert.match(r.reason, /^S1\.3 verified and committed/);
  assert.deepEqual(h.calls, ["tester:S1.1", "tester:S1.2", "bugbash:S1.3", "security:S1.3"], "per step: no [steps], the bug bash at the phase end");
  r = await h.ready("S2.1");
  assert.match(r.reason, /^S2\.1 built and committed/, "Phase 2 is still one feature");
  assert.equal(markers(root), "xxx~  ");

  // A phase that ran out of time: `verify-per-step 1` while paused, then resume.
  root = scratch();
  h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "out-of-time", currentStep: "S1.3", outOfTime: { "S1.3": 2 } });
  editConfig(root, (c) => ({ ...c, gate: { ...c.gate, stepPhases: [1] } }));
  const changes = resumeRun(project(root), loadState(root));
  assert.ok(changes.some((c) => /S1\.1: reopened; it was built but not verified, and Phase 1 is now verified step by step \(gate\.stepPhases\)/.test(c)), changes.join("\n"));
  assert.equal(markers(root), "      ");
  let s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate, s.outOfTime["S1.3"]], ["S1.1", [], 0]);
  r = await h.ready("S1.1");
  assert.match(r.reason, /^S1\.1 verified and committed/, JSON.stringify(r.events));

  // Out of time twice in a phase already verified step by step: the alert offers no verify-per-step.
  root = scratch({ gate: { verifyAt: "phase", stepPhases: [1] } });
  h = harness(root, {}, { tester: { status: "out-of-time", failed: "Browser tester ran out of the gate's time", sections: [], followUps: [] } });
  // The check takes the stop's first place, so the tester is carried over; then it is first and runs out.
  await h.ready("S1.1");
  await h.stop();
  await h.ready("S1.1");
  await h.stop();
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "out-of-time"]);
  assert.doesNotMatch(sent.at(-1).message, /verify-per-step/);
});

test("the check times: a missing or failing record never breaks the gate", async () => {
  const root = scratch();
  const h = harness(root, {}, {}, { readCheckTimes: () => { throw new Error("unreadable"); }, recordCheckTimes: () => { throw new Error("disk full"); } });
  await build(h, ["S1.1", "S1.2"]);
  const r = await h.ready("S1.3");
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /could not record the check times: disk full/);
});

// ---------- the security review alongside the browser checks (checkers.parallel) ----------

test("the security review starts with the browser tester and runs alongside it; the bug bash never overlaps the tester; off runs them one after another, all runs the three at once", async () => {
  const run = async (parallel) => {
    const root = scratch({ cfg: parallel ? { checkers: { parallel } } : {} });
    const h = harness(root);
    await build(h, ["S1.1", "S1.2"]);
    // The tester does not end before the security review has started (or 200 ticks went by).
    const f = logged(h.t, { tester: { waitFor: "start:security" } });
    const r = await h.ready("S1.3", f.deps);
    assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
    return { log: f.log, body: git(root, "log", "-1", "--format=%B").stdout };
  };
  let { log, body } = await run(null);
  assert.deepEqual(log, ["start:tester", "start:security", "end:security", "end:tester", "start:bugbash", "end:bugbash"], "the security review began before the tester finished");
  assert.match(body, /\n- unit: passed in \d+ s\n- browser tester \(alongside the security review\): passed in \d+ s\n- bug bash: passed in \d+ s\n- security review \(alongside the browser tester\): passed in \d+ s\n/);
  ({ log, body } = await run("off"));
  assert.deepEqual(log, ["start:tester", "end:tester", "start:bugbash", "end:bugbash", "start:security", "end:security"]);
  assert.match(body, /\n- browser tester: passed in \d+ s\n- bug bash: passed in \d+ s\n- security review: passed in \d+ s\n/);
  ({ log } = await run("all"));
  assert.ok(log.indexOf("start:bugbash") < log.indexOf("end:tester") && log.indexOf("start:security") < log.indexOf("end:tester"), log.join(" "));
});

test("in parallel: a high security finding still fails the feature, the browser checks' findings join the report, two failures are one attempt, and the last one pauses as security", async () => {
  const high = { status: "failed", failed: "security review: high: server.js:3 SQL built from the request", sections: [{ title: "Security review: FAILED", body: "- high: server.js:3 SQL built from the request" }], findings: [] };
  const testerFail = { status: "failed", failed: "browser tester: criterion failed: S1.2: the page shows two", sections: [{ title: "Browser tester: FAILED", body: "- [FAIL] S1.2: the page shows two\n  Evidence: blank" }], followUps: [] };
  let root = scratch();
  let h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  let f = logged(h.t, { tester: { waitFor: "end:security" }, security: { result: high } });
  let r = await h.ready("S1.3", f.deps);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 \(Lists\), verified at S1\.3, attempt 1\/3 failed: security review: high: server\.js:3/);
  assert.equal(f.log.includes("start:bugbash"), false, "nothing new starts once a part has failed");
  assert.equal(markers(root), "~~    ");
  assert.equal(loadState(root).attempts["S1.3"], 1);

  // The tester fails first; the security review, still at work, finishes, and its failure is in
  // the same attempt and the same report. On the last attempt the run pauses as security.
  saveState(root, { ...loadState(root), attempts: { "S1.3": 2 } });
  f = logged(h.t, { tester: { waitFor: "start:security", result: testerFail }, security: { waitFor: "end:tester", result: high } });
  const before = sent.length;
  r = await h.ready("S1.3", f.deps);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.deepEqual(f.log, ["start:tester", "start:security", "end:tester", "end:security"], "the security review was let finish");
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.attempts["S1.3"]], ["paused", "security", 3]);
  assert.match(sent.slice(before).find((m) => m.priority === "high").message, /^browser tester: criterion failed: S1\.2: the page shows two; security review: high: server\.js:3/);
  const report = fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.3-3.md"), "utf8");
  assert.ok(report.indexOf("Browser tester: FAILED") >= 0 && report.indexOf("Browser tester: FAILED") < report.indexOf("Security review: FAILED"), "both, in the fixed order");

  // The tester fails and the security review passes with a low finding: one attempt, browser.
  root = scratch();
  h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  f = logged(h.t, { tester: { result: testerFail }, security: { waitFor: "end:tester" } });
  r = await h.ready("S1.3", f.deps);
  assert.match(r.reason, /attempt 1\/3 failed: browser tester: criterion failed: S1\.2/);
  assert.doesNotMatch(r.reason, /security review: high/);
  assert.ok(f.log.includes("end:security"));
});

test("in parallel: a failed check starts neither; out of time and a checker that cannot run come before a failure", async () => {
  let root = scratch({ checks: [FAIL] });
  let h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  let f = logged(h.t);
  let r = await h.ready("S1.3", f.deps);
  assert.match(r.reason, /attempt 1\/3 failed: check "unit" failed/);
  assert.deepEqual(f.log, [], "neither the tester nor the security review started");

  // No checks, so the tester and the security review are this stop's first parts: one that runs
  // out of time is out of time, whatever the other found; one that cannot run is the machine's.
  const testerFail = { status: "failed", failed: "browser tester: criterion failed: S1.2: the page shows two", sections: [{ title: "Browser tester: FAILED", body: "- [FAIL] S1.2" }], followUps: [] };
  root = scratch({ checks: [] });
  h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  f = logged(h.t, { tester: { result: testerFail }, security: { waitFor: "end:tester", result: { status: "out-of-time", failed: "Security review ran out of the gate's time", sections: [], findings: [] } } });
  r = await h.ready("S1.3", f.deps);
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) ran out of time: Security review ran out of the gate's time/, JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.attempts["S1.3"] || 0, s.outOfTime["S1.3"]], [0, 1]);
  f = logged(h.t, { tester: { result: testerFail }, security: { waitFor: "end:tester", result: { status: "infra", failed: "Security review could not run (2 tries): claude exited", sections: [], findings: [] } } });
  r = await h.ready("S1.3", f.deps);
  assert.match(r.reason, /^The security review could not run: Security review could not run/, JSON.stringify(r.events));
  s = loadState(root);
  assert.deepEqual([s.attempts["S1.3"] || 0, s.infraFailures["S1.3"]], [0, 1]);
  assert.equal(markers(root), "~~    ");
});

test("in parallel: a security review that does not fit carries over with the browser checks done; one still running when the browser chain stops is waited for", async () => {
  // The security review is expected to need 225 s (180 s and a quarter): after the check (1540 s)
  // only 200 s are left. The tester (100 s) and, with tester.maxTurns 10, the bug bash (15 turns
  // of 7 s and a quarter, 132 s) fit.
  let root = scratch({ cfg: { tester: { maxTurns: 10 } } });
  let h = harness(root, {}, {}, {}, { perCheck: 1540 });
  await build(h, ["S1.1", "S1.2"]);
  let f = logged(h.t);
  let r = await h.ready("S1.3", f.deps);
  assert.match(r.reason, /^The verification of Phase 1 \(Lists\) goes on in the next turn: check "unit", the browser tester and the bug bash are done, and the security review would not fit/, JSON.stringify(r.events));
  assert.deepEqual(f.log, ["start:tester", "end:tester", "start:bugbash", "end:bugbash"]);
  assert.deepEqual(loadState(root).verifying.done, ["check:0:unit", "tester", "bugbash"]);
  r = await h.stop(f.deps);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(f.log.filter((x) => x === "start:security").length, 1, "started once, in the next stop");
  assert.equal(f.log.filter((x) => x === "start:tester").length, 1, "the tester is not started twice");

  // The tester leaves no room for the bug bash, and the security review is still at work: the
  // stop waits for it, and it is done when the rest carries over.
  root = scratch();
  h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  f = logged(h.t, { tester: { took: 700, waitFor: "start:security" }, security: { waitFor: "end:tester" } });
  r = await h.ready("S1.3", f.deps);
  assert.match(r.reason, /check "unit", the browser tester and the security review are done, and the bug bash would not fit/, JSON.stringify(r.events));
  assert.deepEqual(f.log, ["start:tester", "start:security", "end:tester", "end:security"]);
  r = await h.stop(f.deps);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.deepEqual(f.log.slice(4), ["start:bugbash", "end:bugbash"], "nothing started twice");
});

test("in parallel: no checker sweeps the project while another lane runs, so an upload under test stays put; the gate sweeps once every lane is done, into one report folder", async () => {
  const root = scratch();
  const h = harness(root);
  await build(h, ["S1.1", "S1.2"]);
  const upload = path.join(root, "uploads", "photo.png");
  const log = [];
  const wait = async (entry) => { for (let i = 0; i < 1000 && !log.includes(entry); i++) await new Promise((r) => setTimeout(r, 10)); };
  // The real security review with a fake reviewer, which answers once the tester has uploaded.
  const run = async () => { log.push("review:start"); await wait("tester:uploaded"); return { ok: true, structured: { verdict: "pass", findings: [], notes: "ok" }, numTurns: 3, durationMs: 1000 }; };
  const runSecurity = async (a) => { const r = await runSecurityReview({ ...a, deadlineMs: Infinity, run }); log.push("security:done"); return r; };
  // The tester uploads a photo while the security review runs (the app writes it into the
  // project), and looks for it once the security review is done.
  const runTester = async (a) => {
    if (a.kind !== "tester") return { status: "passed", sections: [{ title: "Bug bash: passed", body: "ok" }], followUps: [] };
    await wait("review:start");
    fs.mkdirSync(path.dirname(upload), { recursive: true });
    fs.writeFileSync(upload, "png");
    log.push("tester:uploaded");
    await wait("security:done");
    if (fs.existsSync(upload)) return { status: "passed", sections: [{ title: "Browser tester: passed", body: "the photo shows" }], followUps: [] };
    return { status: "failed", failed: "browser tester: criterion failed: S1.2: the photo shows", sections: [{ title: "Browser tester: FAILED", body: "- [FAIL] S1.2: the photo shows\n  Evidence: 404" }], followUps: [] };
  };
  const r = await h.ready("S1.3", { runTester, runSecurity });
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.deepEqual(log, ["review:start", "tester:uploaded", "security:done"]);
  assert.equal(fs.existsSync(upload), false, "swept once every lane was done");
  assert.ok(fs.existsSync(path.join(root, ".autoclaude", "reports", "S1.3-1-checkers", "stray", "uploads", "photo.png")));
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "reports", "S1.3-1-security", "stray")), false, "the security review swept nothing itself");
  assert.doesNotMatch(git(root, "show", "--name-only", "--format=", "HEAD").stdout, /uploads/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.3-1.md"), "utf8"), /## Files the checkers left in the project\n\nMoved to \.autoclaude\/reports\/S1\.3-1-checkers\/stray, so the commit cannot pick them up:\n- uploads\/photo\.png/);
  assert.ok(treeClean(root));
});

// ---------- weighing a checker by what it is expected to need ----------

const SIX = "# Six plan\n\n## Phase 1: Six\n- [ ] **S1.1** One\n  - Accept: one a\n  - Accept: one b\n  - Accept: one c\n  - Tags: ui\n- [ ] **S1.2** Two\n  - Accept: two a\n  - Accept: two b\n  - Accept: two c\n  - Tags: ui\n\n## Phase 2: More\n- [ ] **S2.1** Three\n  - Accept: the page shows three\n  - Tags: ui\n";

test("a checker is weighed by what it is expected to need, not its worst case: six Accept lines and a fast check are verified in one stop, each checker given the stop's real deadline", async () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, "PLAN.md"), SIX);
  git(root, "commit", "-qam", "six Accept lines");
  // The check takes 5 s. The tester's own limit is 1800 s (900 s for every 5 lines), more than
  // the 1735 s left; it is expected to need 175 s (140 s and a quarter), and takes 140 s.
  const h = harness(root, {}, {}, {}, { perCheck: 5 });
  const got = [];
  const runTester = async (a) => {
    got.push([a.kind, a.deadlineMs - h.t.clock()]);
    if (a.kind === "tester") h.t.extra += 140000;
    return { status: "passed", sections: [{ title: `${a.kind}: passed`, body: "ok" }], followUps: [] };
  };
  await build(h, ["S1.1"]);
  const r = await h.ready("S1.2", { runTester });
  assert.match(r.reason, /^Phase 1 \(Six\) verified and committed/, JSON.stringify(r.events));
  assert.equal(types(r).includes("staged"), false);
  assert.deepEqual(got, [["tester", 1735000], ["bugbash", 1595000]], "the checker's run still ends at the stop's deadline");
});

// ---------- the fix-up pass and a step's second run of the checks, staged ----------

// Each check takes 870 s of the fake clock and is on record at 870 s, so it is expected to need
// 1088 s: under the 1218 s a part may need (lint-plan says the phase fits), but no two of them fit
// in the 1740 s of one stop.
const slow = (name) => counting(name, { timeoutSec: 1200 });
const slowTimes = Object.fromEntries(["a", "b", "c"].map((n) => [n, { recentMs: [870000], medianMs: 870000 }]));
const withFollowUp = (title) => ({ status: "passed", sections: [{ title: "Browser tester: passed", body: "ok" }], followUps: [{ severity: "medium", title, actual: "grey on grey", repro: "open /", expected: "readable", foundBy: "tester" }] });
const blockersFile = (root) => path.join(root, project(root).config.docs.blockers);
const fixRows = (root) => fs.writeFileSync(blockersFile(root), fs.readFileSync(blockersFile(root), "utf8").replace(/\| open \|$/gm, "| fixed |"));

test("the fix-up pass's checks are staged like the verification's: one per stop when no two fit, carried over and never out of time, then the feature closes; a phase lint-plan says fits never runs out of time", async () => {
  const root = scratch({ checks: [slow("a"), slow("b"), slow("c")] });
  assert.equal(estimatePlan(parsePlan(FEATURES), { config: project(root).config, checkTimes: slowTimes }).phases[0].fits, true, "lint-plan says Phase 1 fits");
  const h = harness(root, {}, { tester: withFollowUp("the two is hard to read") }, { readCheckTimes: () => slowTimes }, { perCheck: 870 });
  await build(h, ["S1.1", "S1.2"]);
  let r = await h.ready("S1.3");
  for (let i = 0; i < 4 && types(r).includes("staged"); i++) r = await h.stop();
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding/, JSON.stringify(r.events));
  const runs = checkRuns(root);
  fixRows(root);
  r = await h.ready("S1.3");
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The fix-up checks of Phase 1 go on in the next turn: check "a" is done, and check "b" and check "c" would not fit in what is left of this stop\. Nothing failed and no attempt was counted\. End your turn now without changing anything: the next stop carries on from here \(a change to the files starts the fix-up checks again from the beginning\)\.$/);
  let s = loadState(root);
  assert.deepEqual([s.verifying.fixup, s.verifying.parked, s.verifying.done, s.verifying.left, s.fixup.stepId], [true, true, ["check:0:a"], ["check:1:b", "check:2:c"], "S1.3"]);
  assert.deepEqual([s.outOfTime["S1.3"] || 0, s.attempts["S1.3"] || 0, snapshot(root).pid, snapshot(root).fixup], [0, 0, null, true]);
  // A builder session started now ends its turn untouched.
  const ctx = buildContext({ root, state: s, config: project(root).config, planText: fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), progressText: "", promptTemplate: "" });
  assert.match(ctx, /The gate is running the fix-up checks of Phase 1 \(Lists\), at S1\.3, over more than one turn: check "a" is done, and check "b" and check "c" are left\. It carries on when this turn ends\./);
  assert.match(ctx, /## Fix-up pass in progress: Phase 1\n\nThe feature passed its verification with these non-blocking findings\. Its findings are handled and its checks are under way \(see "Verification in progress" above\): end your turn without changing anything\./);
  let out = "";
  assert.equal(await runCli(["status"], { cwd: root, stdout: { write: (x) => { out += x; return true; } }, stderr: { write: () => true }, env: { PATH: "" } }), 0);
  assert.match(out, /\n {2}verification: the fix-up checks of Phase 1 \(Lists\), at S1\.3, carried over to the next turn after 1 stop; the gate carries it on when the builder's turn ends; check "a" is done, and check "b" and check "c" are left\n/);
  r = await h.stop();
  assert.match(r.reason, /^The fix-up checks of Phase 1 go on in the next turn: check "a" and check "b" are done, and check "c" would not fit/, JSON.stringify(r.events));
  assert.ok(types(r).includes("verify-continued"));
  r = await h.stop();
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(checkRuns(root), runs + 3, "each check ran once in the fix-up pass");
  s = loadState(root);
  assert.deepEqual([s.status, s.verifying, s.fixup, s.outOfTime["S1.3"] || 0, s.currentStep], ["running", null, null, 0, "S2.1"]);
  assert.equal(snapshot(root), null);
  assert.match(git(root, "log", "-1", "--format=%B").stdout, /\n- a \(after the fix-up\): passed in \d+ s\n- b \(after the fix-up\): passed in \d+ s\n- c \(after the fix-up\): passed in \d+ s\n/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.3-fixup-1.md"), "utf8"), /The fix-up checks did not fit in one stop of the gate, so they ran over 3 stops/);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.3\)/.test(l)).length, 1);
  assert.ok(treeClean(root));
});

test("a fix-up check that does not fit even as the first part of its stop is out of time; the second time the run pauses, and the alert offers no verify-per-step, which cannot help a fix-up pass", async () => {
  const root = scratch();
  const h = harness(root, {}, { tester: withFollowUp("the one is hard to read") }, {}, { perCheck: 10 });
  await build(h, ["S1.1", "S1.2"]);
  let r = await h.ready("S1.3");
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding/, JSON.stringify(r.events));
  fixRows(root);
  // A stop with 5 s left once it began: too little to start the check, its first part.
  const late = () => { let n = 0; const at = T0 + 900 * 3600000; return () => at + (n++ === 0 ? 0 : 1735000); };
  r = await h.ready("S1.3", { clock: late() });
  assert.match(r.reason, /^The fix-up checks of Phase 1 ran out of time: check "unit" ran out of the gate's time/, JSON.stringify(r.events));
  assert.deepEqual([loadState(root).outOfTime["S1.3"], loadState(root).verifying], [1, null]);
  const before = sent.length;
  r = await h.ready("S1.3", { clock: late() });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.fixup && s.fixup.stepId], ["paused", "out-of-time", "S1.3"]);
  const alert = sent.slice(before).find((m) => m.priority === "high");
  assert.match(alert.title, /S1\.3 does not fit in one verification/);
  assert.doesNotMatch(alert.message, /verify-per-step/);
});

test("a step's second run of the checks with its findings filed is staged too: carried over with the rows kept, never out of time; a change between its stops takes the rows out with the rest, and they are filed once", async () => {
  const root = scratch({ checks: [slow("a"), slow("b")], gate: { verifyAt: "step" } });
  const h = harness(root, {}, { tester: withFollowUp("the one is hard to read") }, { readCheckTimes: () => slowTimes }, { perCheck: 870 });
  const rows = () => { try { return count(fs.readFileSync(blockersFile(root), "utf8"), "the one is hard to read"); } catch { return 0; } };
  let r = await h.ready("S1.1");
  assert.match(r.reason, /^The verification of S1\.1 goes on in the next turn: check "a" is done, and check "b" and the browser tester would not fit/, JSON.stringify(r.events));
  // Stop 2: b and the tester, which files a row; the checks' second run does not fit after them.
  r = await h.stop();
  assert.match(r.reason, /^The verification of S1\.1 goes on in the next turn: check "a", check "b" and the browser tester are done, and check "a" \(run again with the findings filed\) and check "b" \(run again with the findings filed\) would not fit/, JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([rows(), s.verifying.left, s.verifying.rows.filed.length, snapshot(root).rows.length, s.outOfTime["S1.1"] || 0], [1, ["recheck:0:a", "recheck:1:b"], 1, 1, 0]);
  // Stop 3: the rows are part of the tree the stop compares, so it carries on.
  r = await h.stop();
  assert.ok(types(r).includes("verify-continued") && !types(r).includes("verify-restarted"), JSON.stringify(r.events));
  assert.match(r.reason, /check "a" \(run again with the findings filed\) are done, and check "b" \(run again with the findings filed\) would not fit/);
  assert.equal(rows(), 1);
  // A real change before stop 4: the verification starts again, its rows taken out with its ticks.
  fs.writeFileSync(path.join(root, "late.js"), "export const late = 1;\n");
  r = await h.stop();
  assert.deepEqual(types(r).filter((x) => /^verify/.test(x)), ["verify-restarted", "verify"], JSON.stringify(r.events));
  assert.equal(rows(), 0, "the rows came out with the verification");
  for (let i = 0; i < 4 && types(r).includes("staged"); i++) r = await h.stop();
  assert.match(r.reason, /^S1\.1 verified and committed/, JSON.stringify(r.events));
  assert.equal(rows(), 1, "filed once");
  assert.equal(count(progressText(root), "S1.1 One (attempt 1)"), 1);
  s = loadState(root);
  assert.deepEqual([s.verifying, s.outOfTime["S1.1"] || 0, s.attempts["S1.1"] || 0], [null, 0, 0]);
  const shown = git(root, "show", "--name-only", "--format=", "HEAD").stdout;
  assert.match(shown, /docs\/BLOCKERS\.md/);
  assert.match(shown, /late\.js/);
  assert.match(git(root, "log", "-1", "--format=%B").stdout, /\n- a \(with the findings filed\): passed in \d+ s\n- b \(with the findings filed\): passed in \d+ s\n/);
  assert.ok(treeClean(root));
});
