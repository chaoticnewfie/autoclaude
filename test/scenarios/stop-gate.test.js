// Scenario tests for the Stop gate: a scratch project built from the fixture, the gate called
// through lib/gate.js with fake hook input, and the state, plan, progress file and git history
// asserted after each call. PLAN.md P3.8.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { writeReady, writeBlocked, bumpHeartbeat } from "../../plugins/autoclaude/lib/protocol.js";
import { parsePlan, stepById } from "../../plugins/autoclaude/lib/plan.js";

// Every gate scenario reads usage from its own empty Claude config dir, never the machine's.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-gate-cfg-"));

const node = JSON.stringify(process.execPath);
const env = gitEnv({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` });
const PASS = [{ name: "unit", command: `${node} -e "process.exit(0)"`, timeoutSec: 60 }];
const FAIL = [{ name: "unit", command: `${node} -e "console.log('boom'); process.exit(1)"`, timeoutSec: 60 }];

// Most scenarios test the per-step path (gate.verifyAt "step"); the per-feature ones, further
// down, ask for "phase", the default since 0.10.0.
function scratch(plan = "happy", checks = PASS, { verifyAt = "step" } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-gate-"));
  prepareFixture({ dest, plan, git: true, checks, devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 10 }, env });
  const cfgFile = path.join(dest, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), gate: { verifyAt } }, null, 2) + "\n");
  spawnSync("git", ["commit", "-qam", `fixture: verify per ${verifyAt}`], { cwd: dest, env });
  saveState(dest, { ...defaultState(), status: "running", currentStep: "S1.1", tickedByGate: [], startedAt: new Date().toISOString() });
  return dest;
}

const sent = [];
// No real checker ever runs in these scenarios: tests that need one inject a fake. Nothing
// touches this machine's Docker: the footprint note and cleanup and the hand-back are off unless
// a test injects a fake.
const deps = { env, notify: async (msg) => { sent.push(msg); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null, noteFootprint: null, finishFootprint: null, writeHandoff: null };
const gate = (root, extra = {}) => runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, { ...deps, root, ...extra });
const gitLog = (root) => spawnSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8", env }).stdout.trim().split("\n");
const gitBody = (root, rev = "HEAD") => spawnSync("git", ["log", "-1", "--format=%B", rev], { cwd: root, encoding: "utf8", env }).stdout.trim().replace(/\r\n/g, "\n");
const gitTags = (root) => spawnSync("git", ["tag"], { cwd: root, encoding: "utf8", env }).stdout.trim();
const planOf = (root) => parsePlan(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"));

test("not running or nested role: allow without side effects", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), status: "idle" });
  let r = await gate(root);
  assert.equal(r.decision, "allow");
  assert.equal(r.events[0].type, "not-running");
  saveState(root, { ...loadState(root), status: "running" });
  r = await gate(root, { env: { ...env, AUTOCLAUDE_ROLE: "tester" } });
  assert.equal(r.decision, "allow");
  assert.equal(r.events[0].type, "nested-role");
});

test("no ready marker: nudge with the step text, then pause as stuck after 3 stops with no progress", async () => {
  const root = scratch();
  let r = await gate(root);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /Continue S1\.1 \(Clear completed todos\)/);
  assert.match(r.reason, /ready S1\.1/);
  assert.match(r.reason, /Accept: the page shows a button labelled "Clear completed"/);
  assert.equal(loadState(root).noProgress, 0, "the first stop records the baseline");
  r = await gate(root);
  assert.equal(loadState(root).noProgress, 1);
  bumpHeartbeat(root);
  r = await gate(root);
  assert.equal(loadState(root).noProgress, 0, "tool use resets the counter");
  await gate(root); await gate(root);
  assert.equal(loadState(root).noProgress, 2);
  r = await gate(root);
  assert.equal(r.decision, "allow");
  const s = loadState(root);
  assert.equal(s.status, "paused");
  assert.equal(s.pauseReason, "stuck");
  assert.match(sent.at(-1).title, /stuck on S1\.1/);
});

test("ready with passing checks: tick, progress line, commit with a body, advance to the next step", async () => {
  const root = scratch();
  fs.appendFileSync(path.join(root, "docs", "DECISIONS.md"), "\n## D-001 (2026-09-28, S1.1) Put the button under the list\n- Question: where\n");
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /S1\.1 verified and committed \([0-9a-f]{7}\)\. Next: S1\.2 Show how many are done/);
  assert.match(r.reason, /Accept: the count line reads/);
  const plan = planOf(root);
  assert.equal(stepById(plan, "S1.1").marker, "x");
  assert.equal(stepById(plan, "S1.2").marker, " ");
  assert.match(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), /S1\.1 Clear completed todos \(attempt 1\)/);
  assert.equal(gitLog(root)[0], "autoclaude(S1.1): Clear completed todos");
  const s = loadState(root);
  assert.equal(s.currentStep, "S1.2");
  assert.deepEqual(s.tickedByGate, ["S1.1"]);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "ready.json")), false);
  const st = spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", env }).stdout.trim();
  assert.equal(st, "", "the tree is clean after the gate commit");
  const body = gitBody(root);
  assert.match(body, /^autoclaude\(S1\.1\): Clear completed todos\n\nVerified S1\.1, attempt 1\.\n\nAccept:\nS1\.1 Clear completed todos\n  - the page shows a button labelled "Clear completed" under the list\n/);
  assert.match(body, /\nChecks:\n- unit: passed in \d+ s\n/);
  assert.match(body, /\nDecisions since the previous gate commit:\n- D-001 \(2026-09-28, S1\.1\) Put the button under the list\n/);
  assert.match(body, /\nFindings filed: 0\.\nReport: \.autoclaude\/reports\/S1\.1-1\.md\.$/);
  assert.ok(fs.existsSync(path.join(root, ".autoclaude", "reports", "S1.1-1.md")), "a pass writes its report too");
  // git.push is on by default since 0.10.0; with no remote the push is skipped, never failed.
  assert.ok(s.pushState === null || (s.pushState.skipped && s.pushState.error === "no git remote is configured"), JSON.stringify(s.pushState));
});

test("step mode: the checks see the plan tick and the PROGRESS line, and a failure takes both out again", async () => {
  const sees = { name: "sees-tick", command: `${node} -e "const f=require('fs');process.exit(f.readFileSync('PLAN.md','utf8').includes('- [x] **S1.1**')&&f.readFileSync('PROGRESS.md','utf8').includes('S1.1 Clear completed todos (attempt 1)')?0:1)"`, timeoutSec: 60 };
  const root = scratch("happy", [sees, ...FAIL]);
  const progressBefore = fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8");
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.match(r.reason, /S1\.1 attempt 1\/3 failed: check "unit" failed/, "sees-tick passed first");
  assert.equal(stepById(planOf(root), "S1.1").marker, " ");
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), progressBefore);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", env }).stdout.trim(), "");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")), false);
});

test("a verification cut off by the hook's timeout is undone on the next stop", async () => {
  const root = scratch();
  const planFile = path.join(root, "PLAN.md");
  const progressFile = path.join(root, "PROGRESS.md");
  const plan = fs.readFileSync(planFile, "utf8");
  const progressText = fs.readFileSync(progressFile, "utf8");
  fs.writeFileSync(path.join(root, ".autoclaude", "verify-pending.json"), JSON.stringify({ step: "S1.1", plan, progress: progressText }));
  fs.writeFileSync(planFile, plan.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  fs.appendFileSync(progressFile, "- 2026-09-28 S1.1 Clear completed todos (attempt 1)\n");
  const r = await gate(root);
  assert.equal(r.events[0].type, "verify-interrupted");
  assert.equal(r.decision, "block");
  assert.match(r.reason, /Continue S1\.1/, "no integrity complaint: the tick was the gate's own");
  assert.equal(fs.readFileSync(planFile, "utf8"), plan);
  assert.equal(fs.readFileSync(progressFile, "utf8"), progressText);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")), false);
});

test("ready with failing checks: attempts count up, reports are written, the third failure pauses with [!]", async () => {
  const root = scratch("happy", FAIL);
  for (let n = 1; n <= 2; n++) {
    writeReady(root, "S1.1");
    const r = await gate(root);
    assert.equal(r.decision, "block");
    assert.match(r.reason, new RegExp(`S1\\.1 attempt ${n}/3 failed: check "unit" failed`));
    assert.match(r.reason, /boom/);
    assert.match(r.reason, new RegExp(`Full report: \\.autoclaude/reports/S1\\.1-${n}\\.md$`));
    assert.ok(fs.existsSync(path.join(root, ".autoclaude", "reports", `S1.1-${n}.md`)));
    assert.equal(loadState(root).attempts["S1.1"], n);
    assert.ok(r.reason.length <= 4000);
  }
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "allow");
  const s = loadState(root);
  assert.equal(s.status, "paused");
  assert.equal(s.pauseReason, "step-failed");
  assert.equal(stepById(planOf(root), "S1.1").marker, "!");
  assert.match(sent.at(-1).title, /S1\.1 failed 3 times/);
  assert.equal(sent.at(-1).priority, "high");
});

test("fail then pass: the step passes on the second attempt and the attempt count is recorded", async () => {
  const root = scratch("happy", FAIL);
  writeReady(root, "S1.1");
  await gate(root);
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
  cfg.checks = PASS;
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify(cfg));
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /S1\.1 verified/);
  assert.match(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), /\(attempt 2\)/);
});

// ---------- flaky checks (P10.14, D62) ----------

// A check scripted by run: it fails on the runs numbered in `fail` (1 is its first run in the
// project), printing "flaky boom on run <n>", and passes on the others. Every run adds one
// character to .autoclaude/runs-<name> (gitignored).
const scripted = (name, fail) => ({ name, command: `${node} -e "const f=require('fs'),p='.autoclaude/runs-${name}';f.appendFileSync(p,'x');const n=f.readFileSync(p,'utf8').length;if([${fail.join(",")}].includes(n)){console.log('flaky boom on run '+n);process.exit(1)}"`, timeoutSec: 60 });
const runsOf = (root, name) => { try { return fs.readFileSync(path.join(root, ".autoclaude", `runs-${name}`), "utf8").length; } catch { return 0; } };
const types = (r) => r.events.map((e) => e.type);
const gateLog = (root) => fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8");

test("a check that fails and then passes when run once more counts as passed: no attempt, flaky in the report, the commit body, gate.log and the run state; only the passing run's time is recorded", async () => {
  const root = scratch("happy", [scripted("unit", [1])]);
  const recorded = [];
  const recordCheckTimes = (_root, results) => { recorded.push(results.map((x) => [x.name, x.ok])); };
  writeReady(root, "S1.1");
  let r = await gate(root, { recordCheckTimes });
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 verified and committed/);
  assert.deepEqual(types(r).filter((t) => /^(check-rerun|check-flaky|failed|passed)$/.test(t)), ["check-rerun", "check-flaky", "passed"]);
  assert.equal(runsOf(root, "unit"), 2, "run once more right away");
  let s = loadState(root);
  assert.equal(s.attempts["S1.1"] || 0, 0);
  assert.deepEqual(s.flakyChecks.map(({ at, ...e }) => e), [{ name: "unit", step: "S1.1", phase: 1, feature: false, stage: "verify", firstReason: "exit code 1" }]);
  assert.ok(s.flakyChecks[0].at >= s.startedAt);
  assert.match(gitBody(root), /\nChecks:\n- unit: passed in \d+ s \(flaky: passed on a rerun\)\n/);
  const report = fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.1-1.md"), "utf8");
  assert.match(report, /\n## Check "unit": passed on a rerun \(FLAKY\)\n\n`[^`]+` in \d+ s\n\nIt failed first \(exit code 1, after \d+ s\), was run once more right away, and passed\. It counts as passed, but the check is flaky: its test should be fixed so it passes every time\.\n\nThe failed run's last lines:\n\n```\nflaky boom on run 1\n```\n/);
  assert.doesNotMatch(report, /run 2/);
  assert.match(gateLog(root), /S1\.1: check "unit" is FLAKY: it failed \(exit code 1\), then passed when run once more \(in \d+ s\); it counts as passed/);
  assert.deepEqual(recorded, [[["unit", true]]], "the check times get the passing run only");

  // The next step's check passes the first time: no rerun, and nothing flaky about it.
  writeReady(root, "S1.2");
  r = await gate(root, { recordCheckTimes });
  assert.match(r.reason, /^S1\.2 verified and committed/, JSON.stringify(r.events));
  assert.equal(types(r).includes("check-rerun"), false);
  assert.equal(runsOf(root, "unit"), 3);
  assert.match(gitBody(root), /\nChecks:\n- unit: passed in \d+ s\n\n/);
  s = loadState(root);
  assert.equal(s.flakyChecks.length, 1, "kept for the hand-back");
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", env }).stdout.trim(), "");
});

test("a check that fails when run once more too is a failure as before: one attempt, and the report says it failed twice; a check that did not run is not run again", async () => {
  const root = scratch("happy", [scripted("unit", [1, 2])]);
  writeReady(root, "S1.1");
  let r = await gate(root);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 attempt 1\/3 failed: check "unit" failed\./);
  assert.match(r.reason, /It failed \(exit code 1\), was run once more right away, and failed again: a real failure, not a flaky check\./);
  assert.match(r.reason, /flaky boom on run 2/, "the rerun's output");
  assert.equal(runsOf(root, "unit"), 2);
  assert.deepEqual(types(r).filter((t) => /^check-/.test(t)), ["check-rerun"]);
  let s = loadState(root);
  assert.equal(s.attempts["S1.1"], 1);
  assert.equal(s.flakyChecks, undefined);
  assert.equal(stepById(planOf(root), "S1.1").marker, " ");
  assert.match(gateLog(root), /S1\.1: check "unit" failed \(exit code 1\), and failed again when run once more \(exit code 1\)/);
  // The next attempt passes on its first run: verified at attempt 2, nothing flaky.
  writeReady(root, "S1.1");
  r = await gate(root);
  assert.match(r.reason, /^S1\.1 verified and committed/, JSON.stringify(r.events));
  assert.equal(runsOf(root, "unit"), 3);
  assert.equal(loadState(root).flakyChecks, undefined);

  // A check that needs the dev server in a project without one did not run: not run again.
  const root2 = scratch("happy", [{ ...scripted("e2e", []), needsDevServer: true }]);
  writeReady(root2, "S1.1");
  r = await gate(root2);
  assert.match(r.reason, /^S1\.1 attempt 1\/3 failed: check "e2e" did not run/, JSON.stringify(r.events));
  assert.equal(types(r).includes("check-rerun"), false);
  assert.equal(runsOf(root2, "e2e"), 0);
});

test("step mode: the second run of the checks with the findings filed reruns a failed check too; flaky there, it passes, the commit body marks it, and the completion alert names the run's flaky checks", async () => {
  const root = scratch("broken", [scripted("unit", [2])]);
  const { runSecurity } = fakeSecurity([secLow]);
  writeReady(root, "S1.1");
  const r = await gate(root, { runSecurity });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.equal(loadState(root).status, "complete");
  assert.equal(runsOf(root, "unit"), 3, "once, then twice with the findings filed");
  assert.match(gitBody(root), /\nChecks:\n- unit: passed in \d+ s\n- security review: passed in \d+ s\n- unit \(with the findings filed\): passed in \d+ s \(flaky: passed on a rerun\)\n/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.1-1.md"), "utf8"), /\n## Check "unit": passed on a rerun \(FLAKY\) \(with the findings filed\)\n[\s\S]*flaky boom on run 2/);
  assert.deepEqual(loadState(root).flakyChecks.map((e) => [e.name, e.step, e.feature, e.stage]), [["unit", "S1.1", false, "recheck"]]);
  // The flaky check was found in the stop that completed the plan, and still reached the alert.
  assert.match(sent.at(-1).title, /plan complete/);
  assert.match(sent.at(-1).message, /\nFlaky checks: unit: each failed, then passed when run again; fix the tests\.\n/);
});

test("blocked marker: the step is marked [?], the run pauses, the owner is notified with the question", async () => {
  const root = scratch();
  writeBlocked(root, "S1.1", "Should I use cookies or local storage? Options: cookies, localStorage.");
  const r = await gate(root);
  assert.equal(r.decision, "allow");
  const s = loadState(root);
  assert.equal(s.pauseReason, "blocked");
  assert.equal(stepById(planOf(root), "S1.1").marker, "?");
  assert.match(sent.at(-1).message, /cookies or local storage/);
  assert.match(sent.at(-1).message, /answer "<your answer>"/);
});

test("integrity: a box ticked by anyone but the gate is reverted and explained", async () => {
  const root = scratch();
  const file = path.join(root, "PLAN.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- [ ] **S1.2**", "- [x] **S1.2**"));
  const r = await gate(root);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /Only the gate ticks boxes in PLAN\.md\. I reverted S1\.2/);
  assert.equal(stepById(planOf(root), "S1.2").marker, " ");
  assert.equal(r.events[0].type, "integrity-reverted");
});

test("ready for the wrong step is ignored with a message", async () => {
  const root = scratch();
  writeReady(root, "S1.3");
  const r = await gate(root);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /The ready marker named S1\.3, but the current step is S1\.1/);
});

test("last step passes: the plan completes, the run stops, the summary goes out", async () => {
  const root = scratch("broken", PASS);
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  const s = loadState(root);
  assert.equal(s.status, "complete");
  assert.equal(s.currentStep, null);
  assert.match(sent.at(-1).title, /plan complete/);
  assert.match(sent.at(-1).message, /Steps: 1\/1 verified/);
  assert.match(sent.at(-1).message, /push/i, "the push state is stated");
  assert.match(sent.at(-1).message, /Review the commits, docs\/DECISIONS\.md and docs\/BLOCKERS\.md before merging/);
});

test("plan complete: the footprint is cleaned up, the hand-back is written, committed and named in the alert", async () => {
  const root = scratch("broken", PASS);
  const calls = [];
  const finishFootprint = async (r, opts) => { calls.push(["footprint", r, opts]); return { removed: ["volume demo_data"], kept: [], runningCreated: [], secretsCreated: [], errors: [] }; };
  const writeHandoff = async (a) => {
    calls.push(["handoff", a.footprint, a.state.status, a.parsed.steps.length]);
    const file = path.join(a.root, "HANDOFF.md");
    fs.writeFileSync(file, "# Hand-back\n");
    return { path: file, summary: { built: 1, ownerItems: [], secretsCreated: [], openFindings: 0, ownerReviewDecisions: [], runDecisions: 0, push: a.state.pushState, footprint: a.footprint } };
  };
  writeReady(root, "S1.1");
  const r = await gate(root, { finishFootprint, writeHandoff });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.deepEqual([calls[0][0], calls[0][1], calls[0][2].remove, !!calls[0][2].config], ["footprint", root, true, true]);
  assert.deepEqual(calls[1], ["handoff", { removed: ["volume demo_data"], kept: [], runningCreated: [], secretsCreated: [], errors: [] }, "complete", 1]);
  assert.equal(gitLog(root)[0], "autoclaude: hand-back");
  assert.match(spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8", env }).stdout, /HANDOFF\.md/);
  assert.equal(spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", env }).stdout.trim(), "");
  assert.match(sent.at(-1).message, /HANDOFF\.md/, "the alert points at the hand-back");
  assert.equal(loadState(root).status, "complete");

  // A hand-back or footprint module that throws never stops the completion.
  const root2 = scratch("broken", PASS);
  writeReady(root2, "S1.1");
  const r2 = await gate(root2, { finishFootprint: async () => { throw new Error("docker exploded"); }, writeHandoff: async () => { throw new Error("disk full"); } });
  assert.equal(r2.decision, "allow");
  assert.equal(loadState(root2).status, "complete");
  assert.match(sent.at(-1).title, /plan complete/);
  const log = fs.readFileSync(path.join(root2, ".autoclaude", "logs", "gate.log"), "utf8");
  assert.match(log, /footprint cleanup failed: docker exploded/);
  assert.match(log, /hand-back failed: disk full/);
});

test("a step that passes but cannot be committed pauses the run; resume commits it and the plan then completes", async () => {
  const root = scratch("broken", PASS);
  writeReady(root, "S1.1");
  const lock = path.join(root, ".git", "index.lock");
  fs.writeFileSync(lock, "");
  const r = await gate(root);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.currentStep, s.uncommitted], ["paused", "commit-failed", null, ["S1.1"]]);
  assert.match(s.uncommittedMessages["S1.1"], /^autoclaude\(S1\.1\): [^\n]+\n\nVerified S1\.1, attempt 1\.\n/, "the gate's message is kept for the resume");
  assert.match(sent.at(-1).title, /S1\.1 passed but was not committed/);
  assert.equal(sent.at(-1).priority, "high");
  assert.match(sent.at(-1).message, /git said: .*index\.lock/);
  assert.doesNotMatch(sent.at(-1).title, /plan complete/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /S1\.1 verified but NOT committed/);

  const { commitPending, resumeRun } = await import("../../plugins/autoclaude/lib/resume.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  const project = { root, config: mergeConfig(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"))) };
  const stuck = await commitPending(project, s, { env });
  assert.equal(stuck.ok, false, "git is still broken");
  fs.unlinkSync(lock);
  const c = await commitPending(project, loadState(root), { env });
  assert.equal(c.ok, true, c.error);
  assert.match(gitLog(root)[0], /^autoclaude\(S1\.1\): /);
  // The commit carries the body the gate wrote: Accept lines, checks, decisions, findings.
  const body = gitBody(root);
  assert.match(body, /^autoclaude\(S1\.1\): [^\n]+\n\nCommitted by `autoclaude resume`: the gate had verified or built S1\.1, but its own commit failed\.\n\nVerified S1\.1, attempt 1\.\n\nAccept:\nS1\.1 /);
  assert.match(body, /\nChecks:\n- unit: passed in \d+ s\n/);
  assert.match(body, /\nFindings filed: 0\.\nReport: \.autoclaude\/reports\/S1\.1-1\.md\.$/);
  assert.equal(gitTags(root), "ac-phase-1", "S1.1 closed its phase, so resume tags it the way the gate would have");
  s = loadState(root);
  assert.deepEqual([s.uncommitted, s.uncommittedMessages], [[], {}]);
  resumeRun(project, s);
  const done = await gate(root);
  assert.equal(done.decision, "allow");
  assert.equal(loadState(root).status, "complete");
  assert.match(sent.at(-1).title, /plan complete/);
});

test("pause requested: pauses for review after the verified commit, with the next step recorded", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), pauseRequested: true });
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "allow");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.pauseRequested, s.currentStep], ["paused", "review", false, "S1.2"]);
  assert.equal(stepById(planOf(root), "S1.1").marker, "x");
  assert.match(sent.at(-1).title, /paused for review/);
});

test("review.pauseAt phase-end pauses after the last step of a phase and tags it", async () => {
  const root = scratch();
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
  cfg.review = { pauseAt: "phase-end" };
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify(cfg));
  saveState(root, { ...loadState(root), currentStep: "S1.3", tickedByGate: ["S1.1", "S1.2"] });
  const file = path.join(root, "PLAN.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- [ ] **S1.1**", "- [x] **S1.1**").replace("- [ ] **S1.2**", "- [x] **S1.2**"));
  writeReady(root, "S1.3");
  const r = await gate(root);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.equal(loadState(root).status, "complete", "S1.3 was the last step, so complete wins over the phase-end pause");
  const tags = spawnSync("git", ["tag"], { cwd: root, encoding: "utf8", env }).stdout.trim();
  assert.equal(tags, "ac-phase-1");
});

// ---------- Phase 4: the browser tester and the bug bash, with an injected fake checker ----------

function scratchUi(plan = "happy") {
  const root = scratch(plan);
  const cfgFile = path.join(root, "autoclaude.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.devServer = { command: "npm run dev", url: "http://127.0.0.1:4173", healthPath: "/health", startTimeoutSec: 10 };
  fs.writeFileSync(cfgFile, JSON.stringify(cfg));
  spawnSync("git", ["commit", "-qam", "fixture: dev server config"], { cwd: root, env });
  return root;
}

function fakeBrowser(byKind) {
  const calls = [];
  const runTester = async ({ kind, step, steps }) => {
    calls.push(`${kind}:${step.id}${steps ? `[${steps.map((s) => s.id).join(",")}]` : ""}`);
    const r = typeof byKind[kind] === "function" ? byKind[kind](calls.length) : byKind[kind];
    return r || { status: "passed", sections: [{ title: `${kind}: passed`, body: "ok" }], followUps: [] };
  };
  return { calls, deps: { runTester, restartDevServer: async () => ({ ok: true, reused: false }) } };
}

const testerFail = { status: "failed", failed: "browser tester: criterion failed: the page shows a button labelled \"Clear completed\"", sections: [{ title: "Browser tester: FAILED", body: "- [FAIL] the page shows a button labelled \"Clear completed\"\n  Evidence: no such button in the list footer" }], followUps: [] };

test("tester failure counts as an attempt and its evidence reaches the builder", async () => {
  const root = scratchUi();
  const { calls, deps: b } = fakeBrowser({ tester: testerFail });
  writeReady(root, "S1.1");
  const r = await gate(root, b);
  assert.equal(r.decision, "block");
  assert.deepEqual(calls, ["tester:S1.1"]);
  assert.match(r.reason, /S1\.1 attempt 1\/3 failed: browser tester: criterion failed/);
  assert.match(r.reason, /Evidence: no such button in the list footer/);
  assert.equal(loadState(root).attempts["S1.1"], 1);
  assert.equal(stepById(planOf(root), "S1.1").marker, " ");
});

test("tester pass with minor bugs: verified, and the follow-ups land in BLOCKERS.md inside the step commit", async () => {
  const root = scratchUi();
  const { deps: b } = fakeBrowser({ tester: { status: "passed", sections: [{ title: "Browser tester: passed", body: "all good" }], followUps: [{ severity: "medium", title: "button hard to see", actual: "grey on grey.", repro: "open /", expected: "contrast.", foundBy: "tester" }] } });
  writeReady(root, "S1.1");
  const r = await gate(root, b);
  assert.match(r.reason, /S1\.1 verified and committed/);
  const blockers = fs.readFileSync(path.join(root, "docs", "BLOCKERS.md"), "utf8");
  assert.match(blockers, /\| \d{4}-\d\d-\d\d \| browser tester \| S1\.1 \| medium: button hard to see\. Actual: grey on grey\. Expected: contrast\. Repro: open \/\. \| Claude \| open \|/);
  assert.doesNotMatch(blockers, /\.\./, "no doubled periods when the model already ended a sentence");
  const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8", env }).stdout;
  assert.match(files, /docs\/BLOCKERS\.md/);
});

test("pause --now during a verification is kept: a pass is committed but the run stays paused; a failure pauses without blocking", async () => {
  const pauseDuring = (result) => ({ tester: () => { saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true }); return result; } });
  let root = scratchUi();
  let { deps: b } = fakeBrowser(pauseDuring(null));
  writeReady(root, "S1.1");
  let r = await gate(root, b);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.currentStep, s.haltSession], ["paused", "review", "S1.2", true]);
  assert.equal(stepById(planOf(root), "S1.1").marker, "x");
  assert.match(gitLog(root)[0], /^autoclaude\(S1\.1\)/);

  root = scratchUi();
  ({ deps: b } = fakeBrowser(pauseDuring(testerFail)));
  writeReady(root, "S1.1");
  r = await gate(root, b);
  assert.equal(r.decision, "allow");
  s = loadState(root);
  assert.deepEqual([s.status, s.attempts["S1.1"]], ["paused", 1]);
});

test("tester infrastructure failure: not an attempt the first time, a pause the second time", async () => {
  const root = scratchUi();
  const infra = { status: "infra", failed: "Browser tester could not run (2 tries): timed out; timed out", sections: [{ title: "Browser tester: could not run", body: "x" }], followUps: [] };
  const { deps: b } = fakeBrowser({ tester: infra });
  writeReady(root, "S1.1");
  let r = await gate(root, b);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /did not count as an attempt/);
  let s = loadState(root);
  assert.equal(s.attempts["S1.1"] || 0, 0);
  assert.equal(s.infraFailures["S1.1"], 1);
  assert.ok(fs.existsSync(path.join(root, ".autoclaude", "reports", "S1.1-1-infra1.md")));
  writeReady(root, "S1.1");
  r = await gate(root, b);
  assert.equal(r.decision, "allow");
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "infra"]);
  assert.equal(sent.at(-1).priority, "high");
  assert.match(sent.at(-1).title, /browser tester cannot run/);
});

test("a no-ui step, in a phase with no UI step, runs no browser check at all", async () => {
  const root = scratchUi("broken");
  const { calls, deps: b } = fakeBrowser({});
  writeReady(root, "S1.1");
  const r = await gate(root, b);
  assert.equal(r.decision, "allow");
  assert.deepEqual(calls, []);
  assert.equal(loadState(root).status, "complete");
});

test("the last step of a phase gets the tester and then the bug bash; a high bug fails the step", async () => {
  const root = scratchUi();
  saveState(root, { ...loadState(root), currentStep: "S1.3", tickedByGate: ["S1.1", "S1.2"] });
  const file = path.join(root, "PLAN.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- [ ] **S1.1**", "- [x] **S1.1**").replace("- [ ] **S1.2**", "- [x] **S1.2**"));
  const bugbashFail = { status: "failed", failed: "bug bash: high bug: editing to an empty text deletes the todo", sections: [{ title: "Bug bash: FAILED", body: "- high: editing to an empty text deletes the todo" }], followUps: [] };
  const { calls, deps: b } = fakeBrowser({ bugbash: bugbashFail });
  writeReady(root, "S1.3");
  const r = await gate(root, b);
  assert.deepEqual(calls, ["tester:S1.3", "bugbash:S1.3"]);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /S1\.3 attempt 1\/3 failed: bug bash: high bug: editing to an empty text deletes the todo/);
});

test("a dev server that will not start fails the attempt with its log", async () => {
  const root = scratchUi();
  const { calls, deps: b } = fakeBrowser({});
  writeReady(root, "S1.1");
  const r = await gate(root, { ...b, restartDevServer: async () => ({ ok: false, error: "dev server did not answer at http://127.0.0.1:4173/health within 10 s", logTail: ["Error: listen EADDRINUSE"] }) });
  assert.equal(r.decision, "block");
  assert.deepEqual(calls, []);
  assert.match(r.reason, /failed: the dev server did not start: dev server did not answer/);
  assert.match(r.reason, /EADDRINUSE/);
});

test("a check that needs the dev server in a project without one is reported NOT RUN, and the builder is told why", async () => {
  const checks = [...PASS, { name: "e2e", command: `${node} -e "process.exit(0)"`, timeoutSec: 60, needsDevServer: true }];
  const root = scratch("happy", checks);
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "block");
  assert.match(r.reason, /S1\.1 attempt 1\/3 failed: check "e2e" did not run: it needs the dev server \(needsDevServer\), but devServer\.command and devServer\.url are not both set in autoclaude\.config\.json/);
  assert.doesNotMatch(r.reason, /check "e2e" failed/);
  assert.match(r.reason, /## Check "e2e": NOT RUN/, "the section reaches the builder");
  const report = fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.1-1.md"), "utf8");
  assert.match(report, /## Check "unit": passed/);
  assert.match(report, /## Check "e2e": NOT RUN\n\n`[^`]+` did not run: it needs the dev server[^\n]*blocked S1\.1/);
});

// ---------- Phase 5: security reviewer ----------

function fakeSecurity(results) {
  const calls = [];
  const runSecurity = async ({ step, state, attempt }) => {
    calls.push(`${step.id}#${attempt}`);
    const r = results[Math.min(calls.length - 1, results.length - 1)];
    return r;
  };
  return { calls, runSecurity };
}
const secHigh = { status: "failed", failed: "security review: high: lib/search.js:7 SQL built from the request parameter q", sections: [{ title: "Security review: FAILED", body: "- high: lib/search.js:7 SQL built from the request parameter q\n  Fix: use a parameterised query" }], findings: [] };
const secLow = { status: "passed", sections: [{ title: "Security review: passed", body: "- low: server.js:3 no rate limit" }], findings: [{ severity: "low", file: "server.js", line: 3, issue: "no rate limit on POST /api/todos", fix: "add a simple limiter" }] };

test("security review at a phase end: a high finding fails the attempt; three failures pause as security", async () => {
  const root = scratch("broken", PASS);
  const { calls, runSecurity } = fakeSecurity([secHigh]);
  for (let n = 1; n <= 2; n++) {
    writeReady(root, "S1.1");
    const r = await gate(root, { runSecurity });
    assert.equal(r.decision, "block");
    assert.match(r.reason, new RegExp(`S1\\.1 attempt ${n}/3 failed: security review: high: lib/search\\.js:7`));
    assert.match(r.reason, /Fix: use a parameterised query/);
  }
  writeReady(root, "S1.1");
  const r = await gate(root, { runSecurity });
  assert.equal(r.decision, "allow");
  assert.deepEqual(calls, ["S1.1#1", "S1.1#2", "S1.1#3"]);
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "security"]);
});

test("security review passing with low findings files them in the private findings file, kept out of the step commit", async () => {
  const root = scratch("broken", PASS);
  const { runSecurity } = fakeSecurity([secLow]);
  writeReady(root, "S1.1");
  const r = await gate(root, { runSecurity });
  assert.equal(r.decision, "allow");
  assert.equal(loadState(root).status, "complete");
  // The default findings file is docs/private/SECURITY-FINDINGS.md: gitignored, never committed
  // (P10.10).
  const text = fs.readFileSync(path.join(root, "docs", "private", "SECURITY-FINDINGS.md"), "utf8");
  assert.match(text, /\| \d{4}-\d\d-\d\d \| low \| server\.js:3 \| no rate limit on POST \/api\/todos \(found at S1\.1\) \| add a simple limiter \| open \|/);
  const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8", env }).stdout;
  assert.match(files, /PLAN\.md/, "the step commit itself is there");
  assert.doesNotMatch(files, /SECURITY-FINDINGS/i, "the findings stay out of the commit");
  const tracked = spawnSync("git", ["ls-files"], { cwd: root, encoding: "utf8", env }).stdout;
  assert.doesNotMatch(tracked, /docs\/private/i);
  assert.ok(treeClean(root), "gitignored, so the tree stays clean");
});

test("security runs mid-phase only for a step tagged security, and its infra failure is not an attempt", async () => {
  const root = scratch();
  const planFile = path.join(root, "PLAN.md");
  fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace("  - Tags: ui\n", "  - Tags: ui, security\n"));
  spawnSync("git", ["commit", "-qam", "tag S1.1 security"], { cwd: root, env });
  const infra = { status: "infra", failed: "Security review could not run (2 tries): timed out; timed out", sections: [{ title: "Security review: could not run", body: "x" }], findings: [] };
  const { calls, runSecurity } = fakeSecurity([infra]);
  writeReady(root, "S1.1");
  let r = await gate(root, { runSecurity });
  assert.equal(calls.length, 1, "S1.1 is now tagged security");
  assert.match(r.reason, /The security review could not run.*did not count as an attempt/s);
  assert.equal(loadState(root).attempts["S1.1"] || 0, 0);
  // S1.2 is not tagged security and is not a phase end: no review.
  saveState(root, { ...loadState(root), currentStep: "S1.2", tickedByGate: ["S1.1"] });
  const file = path.join(root, "PLAN.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  writeReady(root, "S1.2");
  r = await gate(root, { runSecurity });
  assert.equal(calls.length, 1);
  assert.match(r.reason, /S1\.2 verified/);
});

// ---------- Phase 5: owner input, usage gate, review pauses ----------

function writeUsage(pct, { minutesAgo = 1 } = {}) {
  const dir = path.join(process.env.CLAUDE_CONFIG_DIR, "autoclaude");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "usage.json"), JSON.stringify({ updatedAt: new Date(Date.now() - minutesAgo * 60000).toISOString(), rate_limits: { five_hour: { used_percentage: 20, resets_at: 1790479800 }, seven_day: { used_percentage: pct, resets_at: 1790776800 } } }));
}
function clearUsage() {
  fs.rmSync(path.join(process.env.CLAUDE_CONFIG_DIR, "autoclaude", "usage.json"), { force: true });
}

test("owner notes and an owner answer reach the builder in the gate's next message, once, then clear when the step passes", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), pendingNotes: [{ at: "2026-09-27T04:00:00Z", text: "Keep the button grey" }], ownerAnswer: { step: "S1.1", question: "Cookies or localStorage?", answer: "Cookies", at: "t", decisionId: "D-008" } });
  let r = await gate(root);
  assert.match(r.reason, /^OWNER ANSWER to your blocked question "Cookies or localStorage\?": Cookies \(recorded as D-008\)/);
  assert.match(r.reason, /OWNER REVIEW NOTES[\s\S]*- Keep the button grey/);
  assert.match(r.reason, /Continue S1\.1/);
  r = await gate(root);
  assert.doesNotMatch(r.reason, /OWNER/, "delivered once");
  writeReady(root, "S1.1");
  r = await gate(root);
  assert.match(r.reason, /S1\.1 verified/);
  const s = loadState(root);
  assert.deepEqual([s.pendingNotes, s.ownerAnswer], [[], null]);
});

test("a note injected at session start (delivered) is cleared when its step passes", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), pendingNotes: [{ at: "t", text: "Make the done count bold", delivered: true }] });
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.match(r.reason, /S1\.1 verified/);
  assert.doesNotMatch(r.reason, /OWNER/, "not repeated: the builder already had it");
  assert.deepEqual(loadState(root).pendingNotes, []);
});

test("a note left while the builder finishes a step arrives with the next step", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), pendingNotes: [{ at: "t", text: "Use the existing table" }] });
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.match(r.reason, /^OWNER REVIEW NOTES[\s\S]*Use the existing table[\s\S]*S1\.1 verified and committed/);
  assert.equal(loadState(root).pendingNotes.length, 1, "kept (delivered) until S1.2 passes");
});

test("weekly usage at the threshold pauses after the verified commit and names the reset", async () => {
  const root = scratch();
  writeUsage(86);
  try {
    writeReady(root, "S1.1");
    const r = await gate(root);
    assert.equal(r.decision, "allow");
    const s = loadState(root);
    assert.deepEqual([s.status, s.pauseReason, s.currentStep], ["paused", "weekly-limit", "S1.2"]);
    assert.equal(stepById(planOf(root), "S1.1").marker, "x", "the step was committed first");
    assert.match(sent.at(-1).message, /7-day usage is 86% \(threshold 85%\)\. Resets /);
  } finally { clearUsage(); }
});

test("stale usage data never pauses and is logged once", async () => {
  const root = scratch();
  writeUsage(99, { minutesAgo: 120 });
  try {
    writeReady(root, "S1.1");
    let r = await gate(root);
    assert.equal(r.decision, "block", "stale data: no pause");
    writeReady(root, "S1.2");
    r = await gate(root);
    assert.equal(r.decision, "block");
    const warnings = fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8").split("\n").filter((l) => /WARNING usage data/.test(l));
    assert.equal(warnings.length, 1);
  } finally { clearUsage(); }
});

const TWO_PHASES = "# Two plan\n\n## Phase 1: A\n- [ ] **S1.1** One\n  - Accept: a\n  - Tags: no-ui\n- [ ] **S1.2** Two\n  - Accept: b\n  - Tags: no-ui\n\n## Phase 2: B\n- [ ] **S2.1** Three\n  - Accept: c\n  - Tags: no-ui\n";

function twoPhase(pauseAt) {
  const root = scratch();
  fs.writeFileSync(path.join(root, "PLAN.md"), TWO_PHASES);
  const cfgFile = path.join(root, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), review: { pauseAt } }));
  spawnSync("git", ["commit", "-qam", "two-phase plan"], { cwd: root, env });
  return root;
}

test("review.pauseAt: never keeps going, every-step pauses after each step, phase-end after a phase's last step", async () => {
  let root = twoPhase("never");
  writeReady(root, "S1.1");
  assert.equal((await gate(root)).decision, "block");

  root = twoPhase("every-step");
  writeReady(root, "S1.1");
  assert.equal((await gate(root)).decision, "allow");
  assert.deepEqual([loadState(root).pauseReason, loadState(root).currentStep], ["review", "S1.2"]);

  root = twoPhase("phase-end");
  writeReady(root, "S1.1");
  assert.equal((await gate(root)).decision, "block", "not a phase end");
  writeReady(root, "S1.2");
  assert.equal((await gate(root)).decision, "allow");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.currentStep], ["paused", "review", "S2.1"]);
  assert.match(sent.at(-1).message, /Verified S1\.2 Two\. Next: S2\.1 Three/);
});

test("re-baseline (D33): a current step the owner unticked or removed is re-resolved", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), currentStep: "S9.9" });
  const r = await gate(root);
  assert.equal(r.decision, "block");
  assert.equal(r.events.find((e) => e.type === "rebaselined").step, "S1.1");
  assert.match(r.reason, /Continue S1\.1/);
});

// ---------- Phase 8: verify once per feature (gate.verifyAt "phase", D49) ----------

const FEATURES = "# Features plan\n\n## Phase 1: Lists\n- [ ] **S1.1** One\n  - Accept: the page shows one\n  - Tags: ui\n- [ ] **S1.2** Two\n  - Accept: the page shows two\n  - Accept: two stays after a reload\n  - Tags: ui\n- [ ] **S1.3** Three\n  - Accept: the store counts three\n  - Test: test/todos.test.js\n  - Tags: no-ui\n\n## Phase 2: More\n- [ ] **S2.1** Four\n  - Accept: the page shows four\n  - Tags: ui\n";
// Every run of this check adds one character to .autoclaude/check-runs (gitignored).
const COUNT = { name: "unit", command: `${node} -e "require('fs').appendFileSync('.autoclaude/check-runs','x')"`, timeoutSec: 60 };
const checkRuns = (root) => { try { return fs.readFileSync(path.join(root, ".autoclaude", "check-runs"), "utf8").length; } catch { return 0; } };
const rev = (cwd, ref) => spawnSync("git", ["rev-parse", "--verify", "-q", ref], { cwd, encoding: "utf8", env }).stdout.trim();
const treeClean = (root) => spawnSync("git", ["status", "--porcelain"], { cwd: root, encoding: "utf8", env }).stdout.trim() === "";

function scratchFeatures({ checks = [COUNT], git = null } = {}) {
  const root = scratch("happy", checks, { verifyAt: "phase" });
  fs.writeFileSync(path.join(root, "PLAN.md"), FEATURES);
  const cfgFile = path.join(root, "autoclaude.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  cfg.devServer = { command: "npm run dev", url: "http://127.0.0.1:4173", healthPath: "/health", startTimeoutSec: 10 };
  if (git) cfg.git = git;
  fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
  spawnSync("git", ["commit", "-qam", "fixture: features plan"], { cwd: root, env });
  return root;
}

function setChecks(root, checks) {
  const cfgFile = path.join(root, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), checks }, null, 2) + "\n");
}

async function buildFirstTwo(root, d) {
  for (const id of ["S1.1", "S1.2"]) {
    writeReady(root, id);
    const r = await gate(root, d);
    assert.match(r.reason, new RegExp(`^${id.replace(".", "\\.")} built and committed`), JSON.stringify(r.events));
  }
}

const withFollowUp = { status: "passed", sections: [{ title: "Browser tester: passed", body: "ok" }], followUps: [{ severity: "medium", title: "the two is hard to read", actual: "grey on grey", repro: "open /", expected: "contrast", foundBy: "tester" }] };

// The builder's side of a fix-up pass: every open findings row gets an outcome.
function settleFindings(root, status = "fixed") {
  for (const rel of ["docs/BLOCKERS.md", "docs/private/SECURITY-FINDINGS.md"]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\| open \|$/gm, `| ${status} |`));
  }
}

test("verifyAt phase: with the phase's last step ticked by the owner, the built step's messages name the step that closes the phase", async () => {
  const root = scratchFeatures();
  fs.writeFileSync(path.join(root, "PLAN.md"), FEATURES.replace("- [ ] **S1.3**", "- [x] **S1.3**"));
  spawnSync("git", ["commit", "-qam", "owner: S1.3 is done"], { cwd: root, env });
  saveState(root, { ...loadState(root), tickedByGate: ["S1.3"] });
  const { deps: b } = fakeBrowser({});
  writeReady(root, "S1.1");
  const r = await gate(root, b);
  assert.match(r.reason, /^S1\.1 built and committed \([0-9a-f]{7}\); Phase 1 is verified as a whole when S1\.2, the step that closes the phase, is ready/, JSON.stringify(r.events));
  assert.match(gitBody(root), /Built, not verified yet: S1\.1 is verified with Phase 1 \(Lists\), all of it at once, when S1\.2, the step that closes the phase, is ready\./);
});

test("verifyAt phase: two steps are built without checks, the third verifies the whole phase once, ticks it and tags it", async () => {
  const root = scratchFeatures();
  const base = rev(root, "HEAD");
  const seen = [];
  const { calls, deps: b } = fakeBrowser({ tester: () => { seen.push({ plan: planOf(root).steps.map((s) => s.marker).join(""), progress: fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8") }); return null; } });
  writeReady(root, "S1.1");
  let r = await gate(root, b);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 built and committed \([0-9a-f]{7}\); Phase 1 is verified as a whole when S1\.3, the step that closes the phase, is ready, so run only the tests for what you change\. Next: S1\.2 Two\./);
  assert.equal(r.events.some((e) => e.type === "verify"), false, "no verification for a built step");
  assert.equal(checkRuns(root), 0);
  assert.deepEqual(calls, []);
  assert.equal(stepById(planOf(root), "S1.1").marker, "~");
  assert.equal(gitLog(root)[0], "autoclaude(S1.1): One");
  assert.match(gitBody(root), /\n\nBuilt, not verified yet: S1\.1 is verified with Phase 1 \(Lists\), all of it at once, when S1\.3, the step that closes the phase, is ready\.\n\nAccept:\nS1\.1 One\n  - the page shows one\n\nChecks: none at this step\.\n/);
  assert.match(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), /S1\.1 One \(built; verified with Phase 1\)/);
  let s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate, s.phaseBaseCommit], ["S1.2", ["S1.1"], base]);
  assert.ok(s.phaseStartedAt);
  assert.ok(r.events.some((e) => e.type === "alert-skipped" && e.event === "stepVerified"), "step alerts are off by default");
  assert.ok(treeClean(root));
  // An ordinary stop between steps: the [~] is the gate's own tick, so no integrity complaint.
  r = await gate(root, b);
  assert.match(r.reason, /^Continue S1\.2/);

  writeReady(root, "S1.2");
  r = await gate(root, b);
  assert.match(r.reason, /^S1\.2 built and committed/);
  assert.equal(loadState(root).phaseBaseCommit, base, "set once, at the phase's first step");

  const sentBefore = sent.length;
  writeReady(root, "S1.3");
  r = await gate(root, b);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.equal(checkRuns(root), 1, "the checks ran once for the whole phase");
  assert.deepEqual(calls, ["tester:S1.3[S1.1,S1.2]", "bugbash:S1.3"], "the tester gets every UI step of the phase");
  assert.equal(seen[0].plan, "xxx ", "the tester saw the phase ticked, as it is committed");
  assert.match(seen[0].progress, /S1\.1 One \(attempt 1\)\n- \d{4}-\d\d-\d\d S1\.2 Two \(attempt 1\)\n- \d{4}-\d\d-\d\d S1\.3 Three \(attempt 1\)\n$/);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed \([0-9a-f]{7}\)\. Next: S2\.1 Four\./);
  assert.deepEqual(planOf(root).steps.map((x) => x.marker), ["x", "x", "x", " "]);
  assert.deepEqual(gitLog(root).slice(0, 3), ["autoclaude(S1.3): Three", "autoclaude(S1.2): Two", "autoclaude(S1.1): One"]);
  const body = gitBody(root);
  assert.match(body, /\n\nVerified Phase 1 \(Lists\) as one feature: S1\.1, S1\.2, S1\.3, attempt 1\.\n\nAccept:\nS1\.1 One\n  - the page shows one\nS1\.2 Two\n  - the page shows two\n  - two stays after a reload\nS1\.3 Three\n  - the store counts three\n/);
  assert.match(body, /\nChecks:\n- unit: passed in \d+ s\n- browser tester: passed in \d+ s\n- bug bash: passed in \d+ s\n/);
  assert.match(body, /Report: \.autoclaude\/reports\/S1\.3-1\.md\.$/);
  assert.equal(gitTags(root), "ac-phase-1");
  assert.equal(rev(root, "ac-phase-1"), rev(root, "HEAD"));
  s = loadState(root);
  assert.deepEqual([s.currentStep, s.phaseBaseCommit, s.phaseStartedAt, s.fixup, s.freshSession], ["S2.1", null, null, null, false]);
  assert.deepEqual(s.tickedByGate, ["S1.1", "S1.2", "S1.3"]);
  const alert = sent.slice(sentBefore).find((m) => /Phase 1 verified/.test(m.title));
  assert.ok(alert, "the feature alert is on by default");
  assert.match(alert.message, /^Phase 1 Lists: 3 steps verified in \d+ min\. Next: S2\.1 Four\.$/);
  assert.ok(treeClean(root));
});

test("verifyAt phase: a failing feature verification takes the ticks out again, counts an attempt against the last step, and names the failing Accept lines", async () => {
  const root = scratchFeatures();
  const fail = { status: "failed", failed: "browser tester: criterion failed: S1.2: two stays after a reload", sections: [{ title: "Browser tester: FAILED", body: "Criteria:\n- [pass] S1.1: the page shows one\n  Evidence: ok\n- [FAIL] S1.2: two stays after a reload\n  Evidence: gone after F5" }], followUps: [] };
  const { calls, deps: b } = fakeBrowser({ tester: fail });
  await buildFirstTwo(root, b);
  const planBefore = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
  const progressBefore = fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8");
  for (let n = 1; n <= 2; n++) {
    writeReady(root, "S1.3");
    const r = await gate(root, b);
    assert.equal(r.decision, "block");
    assert.match(r.reason, new RegExp(`^Phase 1 \\(Lists\\), verified at S1\\.3, attempt ${n}/3 failed: browser tester: criterion failed: S1\\.2: two stays after a reload\\. The failing Accept lines belong to S1\\.2\\.`));
    assert.match(r.reason, /## Failing Accept lines\n- S1\.2: two stays after a reload/);
    assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), planBefore, "the ticks came out again");
    assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), progressBefore);
    assert.equal(loadState(root).attempts["S1.3"], n);
    assert.ok(treeClean(root));
  }
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "reports", "S1.3-1.md"), "utf8"), /## Failing Accept lines\n\n- S1\.2: two stays after a reload/);
  writeReady(root, "S1.3");
  const r = await gate(root, b);
  assert.equal(r.decision, "allow");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "step-failed"]);
  assert.deepEqual(planOf(root).steps.map((x) => x.marker), ["~", "~", "!", " "]);
  assert.match(sent.at(-1).title, /Phase 1, verified at S1\.3, failed 3 times/);
  assert.equal(gitLog(root)[0], "autoclaude(S1.2): Two");
  assert.equal(calls.length, 3);
  assert.equal(gitTags(root), "");
});

test("verifyAt phase: non-blocking findings get a fix-up pass; the next ready runs the checks only and closes the feature", async () => {
  const root = scratchFeatures();
  const { calls, deps: b } = fakeBrowser({ tester: withFollowUp });
  const { calls: secCalls, runSecurity } = fakeSecurity([secLow]);
  const d = { ...b, runSecurity };
  await buildFirstTwo(root, d);
  assert.deepEqual(secCalls, [], "no security review for a built step");
  writeReady(root, "S1.3");
  let r = await gate(root, d);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 passed its verification, with 2 non-blocking findings to handle before the feature closes\./);
  assert.match(r.reason, /1\. \[browser tester, medium\] the two is hard to read \(docs\/BLOCKERS\.md\)\n2\. \[security review, low\] server\.js:3: no rate limit on POST \/api\/todos \(docs\/private\/SECURITY-FINDINGS\.md\)/);
  assert.match(r.reason, /ready S1\.3`: the checks run once more/);
  assert.deepEqual(secCalls, ["S1.3#1"]);
  assert.equal(gitLog(root)[0], "autoclaude(S1.2): Two", "not committed yet");
  let s = loadState(root);
  assert.deepEqual([s.fixup.phase, s.fixup.stepId, s.fixup.findings.length, s.currentStep], [1, "S1.3", 2, "S1.3"]);
  assert.deepEqual(planOf(root).steps.map((x) => x.marker), ["x", "x", "x", " "]);
  assert.match(fs.readFileSync(path.join(root, "docs", "BLOCKERS.md"), "utf8"), /the two is hard to read/);
  // A stop without ready repeats the fix-up list, not the step, and the ticks stand.
  r = await gate(root, d);
  assert.match(r.reason, /^Phase 1 passed its verification/);
  assert.equal(r.events.some((e) => e.type === "integrity-reverted"), false);
  settleFindings(root);
  // A fix-up that breaks a check is an attempt, and the pass goes on.
  setChecks(root, FAIL);
  writeReady(root, "S1.3");
  r = await gate(root, d);
  assert.match(r.reason, /^The fix-up checks of Phase 1 \(attempt 1\/3\) failed: check "unit" failed\./);
  assert.equal(loadState(root).fixup.stepId, "S1.3", "still in the fix-up pass");
  setChecks(root, [COUNT]);
  const runsBefore = checkRuns(root);
  writeReady(root, "S1.3");
  r = await gate(root, d);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  assert.equal(checkRuns(root), runsBefore + 1);
  assert.deepEqual(calls, ["tester:S1.3[S1.1,S1.2]", "bugbash:S1.3"], "no browser check in the fix-up pass");
  assert.deepEqual(secCalls, ["S1.3#1"]);
  const body = gitBody(root);
  assert.match(body, /as one feature: S1\.1, S1\.2, S1\.3, attempt 1, then a fix-up pass\./);
  // The security review ran alongside the browser checks (checkers.parallel "security").
  assert.match(body, /\n- unit: passed in \d+ s\n- browser tester \(alongside the security review\): passed in \d+ s\n- bug bash( \(alongside the security review\))?: passed in \d+ s\n- security review \(alongside the browser tester( and the bug bash)?\): passed in \d+ s\n- unit \(after the fix-up\): passed in \d+ s\n/);
  assert.match(body, /Findings filed: 2\.\nReport: \.autoclaude\/reports\/S1\.3-1\.md and \.autoclaude\/reports\/S1\.3-fixup-2\.md\.$/);
  assert.equal(gitTags(root), "ac-phase-1");
  s = loadState(root);
  assert.deepEqual([s.fixup, s.currentStep], [null, "S2.1"]);
  assert.ok(treeClean(root));
});

test("git.push: the branch and the phase tag reach the remote after the feature, never after a built step; pushState records it", async () => {
  const root = scratchFeatures({ git: { commitEachStep: true, tagPhaseEnds: true, push: true } });
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-remote-")), "origin.git");
  spawnSync("git", ["init", "-q", "--bare", bare], { env });
  spawnSync("git", ["remote", "add", "origin", bare], { cwd: root, env });
  const { deps: b } = fakeBrowser({});
  writeReady(root, "S1.1");
  await gate(root, b);
  assert.equal(loadState(root).pushState, null, "a built step is not pushed");
  assert.equal(rev(bare, "refs/heads/main"), "");
  writeReady(root, "S1.2");
  await gate(root, b);
  const before = sent.length;
  writeReady(root, "S1.3");
  const r = await gate(root, b);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  const ps = loadState(root).pushState;
  assert.deepEqual([ps.ok, ps.skipped, ps.remote, ps.branch, ps.unpushedCommits, ps.unpushedTags, ps.error], [true, false, "origin", "main", 0, [], null]);
  assert.ok(ps.at);
  assert.equal(rev(bare, "refs/heads/main"), rev(root, "HEAD"));
  assert.equal(rev(bare, "refs/tags/ac-phase-1"), rev(root, "HEAD"));
  assert.match(sent.slice(before).find((m) => /Phase 1 verified/.test(m.title)).message, /Pushed to origin\./);
});

test("step mode pushes after every verified step; a failed push is alerted and the run goes on", async () => {
  const root = scratch();
  const cfgFile = path.join(root, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), git: { commitEachStep: true, tagPhaseEnds: true, push: true } }));
  spawnSync("git", ["commit", "-qam", "push on"], { cwd: root, env });
  spawnSync("git", ["remote", "add", "origin", path.join(os.tmpdir(), "autoclaude-no-such-remote", "gone.git")], { cwd: root, env });
  const before = sent.length;
  writeReady(root, "S1.1");
  const r = await gate(root);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /S1\.1 verified and committed/);
  const s = loadState(root);
  assert.deepEqual([s.pushState.ok, s.pushState.skipped, s.pushState.remote, s.pushState.branch, s.currentStep], [false, false, "origin", "main", "S1.2"]);
  assert.ok(s.pushState.error);
  const alert = sent.slice(before).find((m) => /push failed/.test(m.title));
  assert.ok(alert, "the push failure is alerted");
  assert.equal(alert.priority, "default");
  assert.match(alert.message, /git push -u origin main/);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /push FAILED to origin/);
});

test("a verified feature with a live supervisor sets freshSession and lets the session stop; its next stop is let go too", async () => {
  const root = scratchFeatures();
  fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(process.pid));
  const { deps: b } = fakeBrowser({});
  const d = { ...b, env: { ...env, AUTOCLAUDE_BUILDER: "1" } };
  await buildFirstTwo(root, d);
  writeReady(root, "S1.3");
  let r = await gate(root, d);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.equal(r.events.find((e) => e.type === "fresh-session").next, "S2.1");
  const s = loadState(root);
  assert.deepEqual([s.status, s.freshSession, s.currentStep], ["running", true, "S2.1"]);
  assert.ok(s.stepStartedAt);
  r = await gate(root, d);
  assert.deepEqual([r.decision, r.events.at(-1).type], ["allow", "fresh-session-pending"]);
});

test("a review pause at a feature's end: under a live supervisor the resume asks for a fresh session; mid-feature and after an answer it does not", async () => {
  const root = scratchFeatures();
  fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(process.pid));
  const { deps: b } = fakeBrowser({});
  const d = { ...b, env: { ...env, AUTOCLAUDE_BUILDER: "1" } };
  const { resumeRun } = await import("../../plugins/autoclaude/lib/resume.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  const project = { root, config: mergeConfig(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"))) };
  // Mid-feature: S1.2 continues in the resumed session.
  saveState(root, { ...loadState(root), pauseRequested: true });
  writeReady(root, "S1.1");
  await gate(root, d);
  resumeRun(project, loadState(root));
  assert.equal(loadState(root).freshSession, false);
  writeReady(root, "S1.2");
  await gate(root, d);
  // The feature closes into a review pause: the next feature needs a fresh session.
  saveState(root, { ...loadState(root), pauseRequested: true });
  writeReady(root, "S1.3");
  const r = await gate(root, d);
  assert.deepEqual([loadState(root).status, loadState(root).currentStep], ["paused", "S2.1"], JSON.stringify(r.events));
  const changes = resumeRun(project, loadState(root));
  assert.ok(changes.some((c) => /S2\.1 starts a new feature/.test(c)), changes.join("\n"));
  assert.deepEqual([loadState(root).status, loadState(root).freshSession], ["running", true]);
  // A blocked question at a feature's first step is answered into the session that asked it.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "blocked", freshSession: false });
  resumeRun(project, loadState(root));
  assert.equal(loadState(root).freshSession, false);
  // Without a live supervisor nothing would start a fresh session, so none is asked for.
  fs.rmSync(path.join(root, ".autoclaude", "supervisor.pid"));
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  resumeRun(project, loadState(root));
  assert.equal(loadState(root).freshSession, false);
});

test("resume after a pause in the middle of a phase keeps the built steps, and a paused fix-up pass resumes in it", async () => {
  const root = scratchFeatures();
  const { deps: b } = fakeBrowser({});
  const { resumeRun } = await import("../../plugins/autoclaude/lib/resume.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  const project = { root, config: mergeConfig(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"))) };
  saveState(root, { ...loadState(root), pauseRequested: true });
  writeReady(root, "S1.1");
  let r = await gate(root, b);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.currentStep], ["paused", "review", "S1.2"]);
  assert.match(sent.at(-1).message, /^Built S1\.1 One \(verified with Phase 1\)\. Next: S1\.2 Two\./);
  assert.deepEqual(resumeRun(project, s), [], "nothing to report: S1.1 stays built");
  s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.tickedByGate], ["running", "S1.2", ["S1.1"]]);
  assert.equal(stepById(planOf(root), "S1.1").marker, "~");
  writeReady(root, "S1.2");
  r = await gate(root, b);
  assert.match(r.reason, /^S1\.2 built and committed/);

  // The owner pauses (pause --now) during the fix-up pass, then resumes.
  writeReady(root, "S1.3");
  r = await gate(root, { ...b, runTester: fakeBrowser({ tester: withFollowUp }).deps.runTester });
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding to handle/);
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true });
  const changes = resumeRun(project, loadState(root));
  assert.ok(changes.some((c) => /resuming the fix-up pass of S1\.3/.test(c)), changes.join("\n"));
  s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.fixup && s.fixup.stepId, s.haltSession], ["running", "S1.3", "S1.3", false]);
  settleFindings(root, "left for the owner: the colours are the owner's call");
  writeReady(root, "S1.3");
  r = await gate(root, b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(gitTags(root), "ac-phase-1");

  // A fix-up pass whose phase the owner unticked while paused is dropped; the phase is verified again.
  const root2 = scratchFeatures();
  const project2 = { root: root2, config: project.config };
  await buildFirstTwo(root2, b);
  writeReady(root2, "S1.3");
  await gate(root2, { ...b, runTester: fakeBrowser({ tester: withFollowUp }).deps.runTester });
  saveState(root2, { ...loadState(root2), status: "paused", pauseReason: "review" });
  const planFile = path.join(root2, "PLAN.md");
  fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace("- [x] **S1.2**", "- [ ] **S1.2**"));
  const dropped = resumeRun(project2, loadState(root2));
  assert.ok(dropped.some((c) => /fix-up pass of S1\.3 is dropped/.test(c)), dropped.join("\n"));
  s = loadState(root2);
  assert.deepEqual([s.fixup, s.currentStep], [null, "S1.2"]);
});

// ---------- the gate's time, gates cut off by the hook, and the end of the run ----------

const T0 = Date.parse("2026-09-28T10:00:00Z");
const projectOf = async (root) => {
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  return { root, config: mergeConfig(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"))) };
};
const setGate = (root, gateCfg) => {
  const cfgFile = path.join(root, "autoclaude.config.json");
  const cfg = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, gate: { ...cfg.gate, ...gateCfg } }, null, 2) + "\n");
  spawnSync("git", ["commit", "-qam", "gate settings"], { cwd: root, env });
};

test("a verification cut off twice by the hook's timeout pauses the run as out of time; a cut-off the supervisor undid counts too", async () => {
  const root = scratch();
  const planFile = path.join(root, "PLAN.md");
  const plan = fs.readFileSync(planFile, "utf8");
  // What a gate killed in the middle of its checks leaves: its ticks and the snapshot.
  const cut = () => {
    fs.writeFileSync(path.join(root, ".autoclaude", "verify-pending.json"), JSON.stringify({ step: "S1.1", plan, progress: fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), ticked: ["S1.1"], added: "" }));
    fs.writeFileSync(planFile, plan.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  };
  cut();
  let r = await gate(root);
  assert.deepEqual(r.events[0], { type: "verify-interrupted", step: "S1.1", count: 1 });
  assert.match(r.reason, /^Continue S1\.1/);
  const before = sent.length;
  cut();
  r = await gate(root);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.outOfTime["S1.1"]], ["paused", "out-of-time", 2]);
  const alert = sent.slice(before).find((m) => /S1\.1 does not fit in one verification/.test(m.title));
  assert.ok(alert, "the owner is paged");
  assert.equal(alert.priority, "high");
  assert.match(alert.message, /cut off 2 times by the Stop hook's timeout/);
  assert.match(alert.message, /gate\.timeoutSec is 1800 s, and it cannot go above the Stop hook's 1800 s/);
  assert.match(alert.message, /split its phase into smaller ones, make the checks faster/);
  assert.equal(stepById(planOf(root), "S1.1").marker, " ");

  // resume starts the count again. Under a supervisor it is the relaunch that finds a cut-off
  // first; two of those, and the gate does not start a third verification.
  const { resumeRun, undoCutVerification } = await import("../../plugins/autoclaude/lib/resume.js");
  const project = await projectOf(root);
  resumeRun(project, loadState(root));
  assert.equal(loadState(root).outOfTime["S1.1"], 0);
  for (let i = 0; i < 2; i++) { cut(); undoCutVerification(root, project.config, { unlessGateRunning: true }); }
  writeReady(root, "S1.1");
  r = await gate(root);
  assert.equal(r.decision, "allow");
  assert.equal(r.events.some((e) => e.type === "verify"), false, "no third verification");
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "out-of-time"]);
  assert.match(sent.at(-1).message, /ran out of time 2 times before it finished/);
});

test("a check that would outlive the gate is stopped at the gate's deadline: out of time, never an attempt, and the second time a pause", async () => {
  const root = scratch();
  setGate(root, { timeoutSec: 60 });
  // The gate starts at T0; by the time its checks start, 115 of its 120 s for them are gone.
  const clock = () => { let n = 0; return () => T0 + (n++ === 0 ? 0 : 115000); };
  const progressBefore = fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8");
  writeReady(root, "S1.1");
  let r = await gate(root, { clock: clock() });
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The verification of S1\.1 ran out of time: check "unit" ran out of the gate's time: no time left before the gate's deadline\. The gate's time ran out before the verification finished: that is not a failure of S1\.1, and it did not count as an attempt\./);
  let s = loadState(root);
  assert.deepEqual([s.attempts["S1.1"] || 0, s.outOfTime["S1.1"]], [0, 1]);
  assert.equal(stepById(planOf(root), "S1.1").marker, " ", "the ticks came out");
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), progressBefore);
  writeReady(root, "S1.1");
  r = await gate(root, { clock: clock() });
  assert.equal(r.decision, "allow");
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.attempts["S1.1"] || 0], ["paused", "out-of-time", 0]);
  assert.equal(sent.at(-1).priority, "high");
  assert.match(sent.at(-1).message, /Report: \.autoclaude\/reports\/S1\.1-1-time2\.md/);
});

test("the pass is recorded before the commit: a gate cut off in the commit is finished by the next stop, once, with nothing verified again", async () => {
  const root = scratch();
  // A pre-commit hook keeps what the state and the snapshot were while git committed.
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\ncp .autoclaude/state.json .autoclaude/state-at-commit.json\nif [ -f .autoclaude/verify-pending.json ]; then echo yes > .autoclaude/pending-at-commit; fi\nexit 0\n");
  fs.chmodSync(hook, 0o755);
  const fixtureHead = rev(root, "HEAD");
  writeReady(root, "S1.1");
  let r = await gate(root);
  assert.match(r.reason, /S1\.1 verified and committed/);
  const atCommit = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state-at-commit.json"), "utf8"));
  assert.deepEqual([atCommit.closing && atCommit.closing.stepId, atCommit.closing && atCommit.closing.headBefore, atCommit.tickedByGate], ["S1.1", fixtureHead, ["S1.1"]], "the pass was in the state before git ran");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "pending-at-commit")), false, "and only then the snapshot went");
  assert.equal(loadState(root).closing, null);

  // The hook's timeout at that moment: the state as it was then, the ticks not committed.
  spawnSync("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd: root, env });
  saveState(root, atCommit);
  const count = (re) => gitLog(root).filter((l) => re.test(l)).length;
  r = await gate(root);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "close-resumed"));
  assert.equal(r.events.some((e) => e.type === "integrity-reverted" || e.type === "verify"), false, JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 verified and committed \([0-9a-f]{7}\)\. Next: S1\.2/);
  assert.equal(count(/^autoclaude\(S1\.1\)/), 1);
  assert.match(gitBody(root), /Verified S1\.1, attempt 1\.\n\nAccept:\n/);
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8").split("S1.1 Clear completed todos (attempt 1)").length - 1, 1);
  let s = loadState(root);
  assert.deepEqual([s.currentStep, s.closing, s.tickedByGate], ["S1.2", null, ["S1.1"]]);

  // Cut off after its commit, before the state recorded it: the next stop does not commit again.
  saveState(root, atCommit);
  r = await gate(root);
  assert.match(r.reason, /^S1\.1 verified and committed/);
  assert.equal(count(/^autoclaude\(S1\.1\)/), 1);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /S1\.1 was committed \([0-9a-f]{7}\) before its gate was cut off/);
  s = loadState(root);
  assert.deepEqual([s.currentStep, s.closing], ["S1.2", null]);
  assert.ok(treeClean(root));
});

test("a close cut off before its commit, with the files changed after the checks passed, is verified again instead of committed as verified", async () => {
  const root = scratch();
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\ncp .autoclaude/state.json .autoclaude/state-at-commit.json\nexit 0\n");
  fs.chmodSync(hook, 0o755);
  writeReady(root, "S1.1");
  let r = await gate(root);
  assert.match(r.reason, /S1\.1 verified and committed/);
  const atCommit = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state-at-commit.json"), "utf8"));
  assert.match(atCommit.closing.tree, /^[0-9a-f]{40}$/, "the verified tree is recorded");
  const lines = () => fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8").split("S1.1 Clear completed todos (attempt 1)").length - 1;

  // The hook's timeout in the commit; the relaunched builder changes a file before its next stop.
  spawnSync("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd: root, env });
  saveState(root, atCommit);
  fs.writeFileSync(path.join(root, "unverified.js"), "export const late = 1;\n");
  r = await gate(root);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "close-changed"), JSON.stringify(r.events));
  assert.equal(r.events.some((e) => e.type === "close-resumed" || e.type === "passed" || e.type === "integrity-reverted"), false, JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 passed its verification, but its commit was cut off and the files changed after the checks passed, so it is verified again: its plan ticks and PROGRESS lines were taken out\. .*run `.*ready S1\.1`/);
  assert.equal(gitLog(root)[0], "fixture: verify per step", "nothing committed as verified");
  assert.equal(stepById(planOf(root), "S1.1").marker, " ");
  assert.equal(lines(), 0);
  let s = loadState(root);
  assert.deepEqual([s.closing, s.tickedByGate, s.currentStep], [null, [], "S1.1"]);

  // Its ready verifies it again, with the new file, and only then commits.
  writeReady(root, "S1.1");
  r = await gate(root);
  assert.ok(r.events.some((e) => e.type === "verify"), JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 verified and committed/);
  assert.match(spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8", env }).stdout, /unverified\.js/);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.1\)/.test(l)).length, 1);
  assert.equal(lines(), 1);
  s = loadState(root);
  assert.deepEqual([s.closing, s.currentStep], [null, "S1.2"]);
  assert.ok(treeClean(root));

  // A change to CONTINUE_HERE.md alone (what a relaunched builder writes before its ready) is
  // committed with the close, not verified again.
  const root3 = scratch();
  fs.writeFileSync(path.join(root3, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncp .autoclaude/state.json .autoclaude/state-at-commit.json\nexit 0\n");
  fs.chmodSync(path.join(root3, ".git", "hooks", "pre-commit"), 0o755);
  writeReady(root3, "S1.1");
  await gate(root3);
  const cut3 = JSON.parse(fs.readFileSync(path.join(root3, ".autoclaude", "state-at-commit.json"), "utf8"));
  spawnSync("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd: root3, env });
  saveState(root3, cut3);
  fs.writeFileSync(path.join(root3, "CONTINUE_HERE.md"), "# Continue here\n\nS1.1 was handed in; its commit was cut off.\n");
  r = await gate(root3);
  assert.ok(r.events.some((e) => e.type === "close-resumed"), JSON.stringify(r.events));
  assert.equal(r.events.some((e) => e.type === "close-changed" || e.type === "verify"), false, JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 verified and committed/);
  assert.match(spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root3, encoding: "utf8", env }).stdout, /CONTINUE_HERE\.md/);

  // The same cut-off, then a pause in which the owner edits a file. The resume moves past the
  // ticked S1.1; the first stop after it takes S1.1 back and makes it the current step again.
  const root2 = scratch();
  fs.writeFileSync(path.join(root2, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncp .autoclaude/state.json .autoclaude/state-at-commit.json\nexit 0\n");
  fs.chmodSync(path.join(root2, ".git", "hooks", "pre-commit"), 0o755);
  writeReady(root2, "S1.1");
  await gate(root2);
  const cut = JSON.parse(fs.readFileSync(path.join(root2, ".autoclaude", "state-at-commit.json"), "utf8"));
  spawnSync("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd: root2, env });
  saveState(root2, { ...cut, status: "paused", pauseReason: "review" });
  fs.writeFileSync(path.join(root2, "owner-edit.js"), "export const owner = 1;\n");
  const { resumeRun } = await import("../../plugins/autoclaude/lib/resume.js");
  resumeRun(await projectOf(root2), loadState(root2));
  assert.equal(loadState(root2).currentStep, "S1.2");
  r = await gate(root2);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 passed its verification, but its commit was cut off and the files changed after the checks passed, so it is verified again/);
  assert.match(r.reason, /run `.*ready S1\.1`/);
  s = loadState(root2);
  assert.deepEqual([s.closing, s.currentStep, stepById(planOf(root2), "S1.1").marker], [null, "S1.1", " "]);
  writeReady(root2, "S1.1");
  r = await gate(root2);
  assert.match(r.reason, /^S1\.1 verified and committed/, JSON.stringify(r.events));
  assert.match(spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root2, encoding: "utf8", env }).stdout, /owner-edit\.js/);
});

test("a close cut off twice with the files changed each time pauses as out of time, with an alert, instead of verifying again all night", async () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, ".git", "hooks", "pre-commit"), "#!/bin/sh\ncp .autoclaude/state.json .autoclaude/state-at-commit.json\nexit 0\n");
  fs.chmodSync(path.join(root, ".git", "hooks", "pre-commit"), 0o755);
  const cutOff = (n) => {
    const at = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state-at-commit.json"), "utf8"));
    spawnSync("git", ["reset", "-q", "--soft", "HEAD~1"], { cwd: root, env });
    saveState(root, at);
    fs.writeFileSync(path.join(root, `late-${n}.js`), `export const late = ${n};\n`);
  };
  writeReady(root, "S1.1");
  let r = await gate(root);
  assert.match(r.reason, /S1\.1 verified and committed/);
  cutOff(1);
  r = await gate(root);
  assert.ok(r.events.some((e) => e.type === "close-changed"), JSON.stringify(r.events));
  assert.equal(loadState(root).outOfTime["close:S1.1"], 1);
  // Verified again and committed; that commit is cut off too, with another change after it.
  writeReady(root, "S1.1");
  r = await gate(root);
  assert.match(r.reason, /S1\.1 verified and committed/);
  cutOff(2);
  const alerts = sent.length;
  r = await gate(root);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "out-of-time"]);
  assert.equal(sent.length, alerts + 1);
  assert.equal(sent.at(-1).priority, "high");
  assert.match(sent.at(-1).message, /cut off 2 times after its verification passed/);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.1\)/.test(l)).length, 0, "nothing committed as verified");
  // resume clears the count, and the next verification commits.
  const { resumeRun } = await import("../../plugins/autoclaude/lib/resume.js");
  const { loadConfig } = await import("../../plugins/autoclaude/lib/config.js");
  resumeRun({ root, config: loadConfig(root).config }, loadState(root), {}, { env });
  assert.equal(loadState(root).outOfTime["close:S1.1"], undefined);
});

test("a second gate while another is verifying stands down: it leaves that verification, its ticks and its snapshot alone", async () => {
  const root = scratchUi();
  const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
  try {
    let reached;
    const at = new Promise((res) => { reached = res; });
    const hang = { runTester: async () => { reached(); return new Promise(() => {}); }, restartDevServer: async () => ({ ok: true, reused: false }), pid: other.pid };
    writeReady(root, "S1.1");
    gate(root, hang);
    await at;
    const plan = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
    assert.equal(stepById(planOf(root), "S1.1").marker, "x");
    // Another session's stop, in a run started by hand (every session there is a builder).
    const r = await gate(root);
    assert.deepEqual([r.decision, r.events.map((e) => e.type)], ["allow", ["gate-busy"]]);
    assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), plan);
    assert.ok(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")));
  } finally {
    other.kill();
  }
});

test("the last failed attempt marks [!] on the plan as it is now, keeping what the owner changed during the verification", async () => {
  const root = scratchUi();
  saveState(root, { ...loadState(root), attempts: { "S1.1": 2 } });
  const file = path.join(root, "PLAN.md");
  // The owner paused with --now and added a step while the tester was still at work.
  const { deps: b } = fakeBrowser({ tester: () => { fs.appendFileSync(file, "\n- [ ] **S1.4** Owner's new step\n  - Accept: added during the verification\n"); return testerFail; } });
  writeReady(root, "S1.1");
  const r = await gate(root, b);
  assert.equal(r.decision, "allow");
  assert.equal(loadState(root).pauseReason, "step-failed");
  const plan = planOf(root);
  assert.equal(stepById(plan, "S1.1").marker, "!");
  assert.ok(stepById(plan, "S1.4"), "the owner's step is still there");
});

test("step mode: findings filed after the checks are checked again before the commit; a failure takes the rows out with the ticks", async () => {
  const noFindings = { name: "docs-lint", command: `${node} -e "process.exit(require('fs').existsSync('docs/private/SECURITY-FINDINGS.md') ? 1 : 0)"`, timeoutSec: 60 };
  const root = scratch("broken", [noFindings]);
  const { runSecurity } = fakeSecurity([secLow]);
  writeReady(root, "S1.1");
  const r = await gate(root, { runSecurity });
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^S1\.1 attempt 1\/3 failed: check "docs-lint" failed once the findings were filed in docs\/private\/SECURITY-FINDINGS\.md\./);
  assert.equal(fs.existsSync(path.join(root, "docs", "private", "SECURITY-FINDINGS.md")), false, "the rows came out with the ticks");
  assert.equal(stepById(planOf(root), "S1.1").marker, " ");
  assert.equal(loadState(root).attempts["S1.1"], 1);
  assert.equal(gitLog(root)[0], "fixture: verify per step", "nothing committed");
  assert.ok(treeClean(root));
});

test("the end of the run: a stop short of time hands it to the next stop, a gate killed on the way loses nothing, and the run is complete only once the hand-back is committed", async () => {
  const calls = [];
  const finishFootprint = async () => { calls.push("footprint"); return { removed: [], kept: [], runningCreated: [], secretsCreated: [], errors: [] }; };
  const writeHandoff = async (a) => {
    calls.push(`handoff:${a.state.status}`);
    const file = path.join(a.root, "HANDOFF.md");
    fs.writeFileSync(file, "# Hand-back\n");
    return { path: file, summary: { built: 1, ownerItems: [], secretsCreated: [], openFindings: 0, ownerReviewDecisions: [], runDecisions: 0, push: null, footprint: null } };
  };
  const root = scratch("broken", PASS);
  let now = T0;
  // The last feature's security review ends 10 s before the stop's time is up.
  const runSecurity = async () => { now = T0 + 1790000; return { status: "passed", sections: [], findings: [] }; };
  const before = sent.length;
  writeReady(root, "S1.1");
  let r = await gate(root, { clock: () => now, runSecurity, finishFootprint, writeHandoff });
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The plan is complete, and the gate is finishing the run \(the machine clean-up and the hand-back\) but this stop is out of time\. End your turn now/);
  assert.deepEqual(calls, []);
  let s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, !!s.completing], ["running", null, true]);
  assert.equal(sent.slice(before).some((m) => /plan complete/.test(m.title)), false, "no completion alert yet");
  assert.match(gitLog(root)[0], /^autoclaude\(S1\.1\)/);
  // The builder ended its turn; the next stop has its whole time.
  r = await gate(root, { finishFootprint, writeHandoff });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.deepEqual(calls, ["footprint", "handoff:complete"]);
  s = loadState(root);
  assert.deepEqual([s.status, s.completing], ["complete", null]);
  assert.equal(gitLog(root)[0], "autoclaude: hand-back");
  assert.match(sent.at(-1).title, /plan complete/);
  assert.equal(sent.slice(before).filter((m) => /plan complete/.test(m.title)).length, 1);

  // A gate killed in the middle of the clean-up: the run stays running, and the next stop does
  // the rest.
  const root2 = scratch("broken", PASS);
  let reached;
  const at = new Promise((res) => { reached = res; });
  writeReady(root2, "S1.1");
  gate(root2, { finishFootprint: async () => { reached(); return new Promise(() => {}); }, writeHandoff });
  await at;
  s = loadState(root2);
  assert.deepEqual([s.status, !!s.completing, !!(s.completing && s.completing.footprintDone)], ["running", true, false]);
  assert.equal(fs.existsSync(path.join(root2, "HANDOFF.md")), false);
  r = await gate(root2, { finishFootprint, writeHandoff });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.equal(loadState(root2).status, "complete");
  assert.equal(gitLog(root2)[0], "autoclaude: hand-back");
  assert.match(sent.at(-1).title, /plan complete/);
});

test("a hand-back committed just before its gate was cut off is still pushed, and the completion alert gives that push's own result", async () => {
  const root = scratch("broken", PASS);
  // The state as it was once the hand-back commit landed, before the gate recorded it.
  const hook = path.join(root, ".git", "hooks", "post-commit");
  fs.writeFileSync(hook, "#!/bin/sh\nif git log -1 --format=%s | grep -q '^autoclaude: hand-back'; then cp .autoclaude/state.json .autoclaude/state-at-handback.json; fi\nexit 0\n");
  fs.chmodSync(hook, 0o755);
  const writeHandoff = async (a) => {
    const file = path.join(a.root, "HANDOFF.md");
    fs.writeFileSync(file, "# Hand-back\n");
    return { path: file, summary: { built: 1, ownerItems: [], secretsCreated: [], openFindings: 0, ownerReviewDecisions: [], runDecisions: 0, push: a.state.pushState, footprint: null } };
  };
  const pushes = [];
  const pushRun = (result) => async (_root, opts) => { pushes.push(opts.tags); return { skipped: false, remote: "origin", branch: "main", unpushedTags: [], ...result }; };
  writeReady(root, "S1.1");
  let r = await gate(root, { writeHandoff, pushRun: pushRun({ ok: true, unpushedCommits: 0 }) });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.equal(gitLog(root)[0], "autoclaude: hand-back");
  assert.equal(pushes.length, 2, "the step's push and the hand-back's");
  const cut = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state-at-handback.json"), "utf8"));
  assert.deepEqual([cut.status, cut.completing.handoffDone, !!cut.completing.committed, cut.pushState.ok], ["running", true, false, true]);

  // The gate was cut off right there: the hand-back is committed, not pushed. The next stop
  // pushes it, and this push fails.
  saveState(root, cut);
  const before = sent.length;
  r = await gate(root, { writeHandoff, pushRun: pushRun({ ok: false, error: "the remote hung up", unpushedCommits: 1 }) });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "complete-resumed"), JSON.stringify(r.events));
  assert.equal(pushes.length, 3, "the hand-back commit goes out with a push");
  assert.equal(gitLog(root).filter((l) => l === "autoclaude: hand-back").length, 1, "and is not made twice");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pushState.ok, s.pushState.error], ["complete", false, "the remote hung up"]);
  const alert = sent.slice(before).find((m) => /plan complete/.test(m.title));
  assert.match(alert.message, /Push FAILED for main .*: the remote hung up\. Not on the remote: 1 commit\./);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /the hand-back was committed \([0-9a-f]{7}\) before its gate was cut off/);
});
