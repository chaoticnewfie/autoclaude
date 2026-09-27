// Scenario tests for the Stop gate: a scratch project built from the fixture, the gate called
// through lib/gate.js with fake hook input, and the state, plan, progress file and git history
// asserted after each call. PLAN.md P3.8.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { writeReady, writeBlocked, bumpHeartbeat } from "../../plugins/autoclaude/lib/protocol.js";
import { parsePlan, stepById } from "../../plugins/autoclaude/lib/plan.js";

const node = JSON.stringify(process.execPath);
const env = gitEnv({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` });
const PASS = [{ name: "unit", command: `${node} -e "process.exit(0)"`, timeoutSec: 60 }];
const FAIL = [{ name: "unit", command: `${node} -e "console.log('boom'); process.exit(1)"`, timeoutSec: 60 }];

function scratch(plan = "happy", checks = PASS) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-gate-"));
  prepareFixture({ dest, plan, git: true, checks, devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 10 }, env });
  saveState(dest, { ...defaultState(), status: "running", currentStep: "S1.1", tickedByGate: [], startedAt: new Date().toISOString() });
  return dest;
}

const sent = [];
const deps = { env, notify: async (msg) => { sent.push(msg); return { ok: true }; }, stdout: { write() {} } };
const gate = (root, extra = {}) => runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, { ...deps, root, ...extra });
const gitLog = (root) => spawnSync("git", ["log", "--format=%s"], { cwd: root, encoding: "utf8", env }).stdout.trim().split("\n");
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

test("ready with passing checks: tick, progress line, commit, advance to the next step", async () => {
  const root = scratch();
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
  assert.match(sent.at(-1).message, /1\/1 steps verified/);
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

test("re-baseline (D33): a current step the owner unticked or removed is re-resolved", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), currentStep: "S9.9" });
  const r = await gate(root);
  assert.equal(r.decision, "block");
  assert.equal(r.events.find((e) => e.type === "rebaselined").step, "S1.1");
  assert.match(r.reason, /Continue S1\.1/);
});
