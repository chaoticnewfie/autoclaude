import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultState, loadState, saveState, updateState, isRunning, describeState, STATUS, PAUSE_REASONS,
  keepMainState, restoreMainState, hasMainStateKept, readMainStateKept, mainStateFile, beginRunPlan, finishRunPlan
} from "../../plugins/autoclaude/lib/state.js";
import { loadConfig, readRunPlan, runPlanFile } from "../../plugins/autoclaude/lib/config.js";

// loadConfig reads this computer's defaults: never the real one.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-state-cfg-"));

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-state-"));

test("loadState on a fresh project returns the defaults and writes nothing", () => {
  const root = tmpDir();
  const s = loadState(root);
  assert.equal(s.status, STATUS.idle);
  assert.deepEqual(s.attempts, {});
  assert.equal(fs.existsSync(path.join(root, ".autoclaude")), false);
});

test("saveState creates .autoclaude, stamps updatedAt, and loadState reads it back", () => {
  const root = tmpDir();
  const saved = saveState(root, { ...defaultState(), status: STATUS.running, currentStep: "S1.1" });
  assert.ok(saved.updatedAt);
  const loaded = loadState(root);
  assert.equal(loaded.status, "running");
  assert.equal(loaded.currentStep, "S1.1");
  assert.equal(isRunning(loaded), true);
  assert.deepEqual(fs.readdirSync(path.join(root, ".autoclaude")), ["state.json"]);
});

test("updateState mutates in place and keeps unknown keys", () => {
  const root = tmpDir();
  saveState(root, { ...defaultState(), futureKey: "kept" });
  const s = updateState(root, (st) => { st.attempts["S1.1"] = 2; st.noProgress += 1; });
  assert.equal(s.attempts["S1.1"], 2);
  assert.equal(s.noProgress, 1);
  assert.equal(loadState(root).futureKey, "kept");
});

test("a state file from before 0.10.0 gets the new keys filled in", () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".autoclaude"));
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), JSON.stringify({ version: 1, status: "paused", currentStep: "S2.1" }));
  const s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.fixup, s.freshSession, s.pushState], ["paused", "S2.1", null, false, null]);
});

test("a corrupt state file reads as defaults instead of throwing", () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".autoclaude"));
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), "{ half written");
  assert.equal(loadState(root).status, STATUS.idle);
});

test("describeState reads well", () => {
  assert.equal(describeState({ ...defaultState(), status: "paused", pauseReason: "review" }), "paused (review)");
  assert.equal(describeState({ ...defaultState(), status: "running", pauseRequested: true }), "running, pause requested after the next committed step");
  assert.equal(describeState({ ...defaultState(), status: "complete" }), "complete");
});

test("defaults carry the builder session fields, and PAUSE_REASONS lists the reasons really set", () => {
  const s = defaultState();
  assert.equal(s.builderSessionId, null);
  assert.equal(s.haltSession, false);
  assert.deepEqual([s.fixup, s.freshSession, s.phaseBaseCommit, s.phaseStartedAt, s.pushState], [null, false, null, null, null]);
  // What a gate cut off by the hook's timeout leaves for the next stop, and what resume needs.
  assert.deepEqual([s.outOfTime, s.closing, s.completing, s.uncommittedMessages, s.decisionsAtStart], [{}, null, null, {}, null]);
  assert.deepEqual([...PAUSE_REASONS].sort(), ["blocked", "commit-failed", "infra", "out-of-time", "review", "security", "step-failed", "stuck", "weekly-limit"]);
  assert.equal(s.lastRunPlan, null);
});

// ---------- a run on a generated plan keeps the project's own state aside (P10.7) ----------

test("beginRunPlan keeps the project's own state aside, gives the run a fresh idle state and sets the override", () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), "# Security fixes\n");
  const main = saveState(root, { ...defaultState(), status: STATUS.complete, pendingNotes: [{ at: "x", text: "keep the table" }], tickedByGate: ["S1.1"], futureKey: "kept" });
  assert.equal(beginRunPlan(root, "SECURITY_PLAN.md", { branch: "autoclaude/security-fixes-2026-10-02", sweepId: "s1" }, { now: new Date("2026-10-02T10:00:00Z") }), "SECURITY_PLAN.md");
  assert.deepEqual(JSON.parse(fs.readFileSync(mainStateFile(root), "utf8")), main, "kept byte for byte, unknown keys included");
  const s = loadState(root);
  assert.deepEqual([s.status, s.pendingNotes, s.tickedByGate, s.futureKey], ["idle", [], [], undefined]);
  assert.deepEqual([readRunPlan(root).plan, readRunPlan(root).branch, readRunPlan(root).sweepId], ["SECURITY_PLAN.md", "autoclaude/security-fixes-2026-10-02", "s1"]);
  assert.equal(loadConfig(root).config.plan, "SECURITY_PLAN.md");
  // A second begin (an earlier generated-plan run's state is in state.json now) keeps the first copy.
  saveState(root, { ...defaultState(), status: STATUS.complete, currentStep: null, tickedByGate: ["SEC1.1"] });
  assert.equal(keepMainState(root), false);
  beginRunPlan(root, "SECURITY_PLAN.md");
  assert.deepEqual(readMainStateKept(root).pendingNotes, [{ at: "x", text: "keep the table" }]);
});

test("finishRunPlan puts the project's own state back with lastRunPlan, clears the override, and touches nothing without one", () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), "# Security fixes\n");
  saveState(root, { ...defaultState(), status: STATUS.idle, pendingNotes: [{ at: "x", text: "n" }] });
  beginRunPlan(root, "SECURITY_PLAN.md", { branch: "autoclaude/security-fixes-2026-10-02" }, { now: new Date("2026-10-02T10:00:00Z") });
  saveState(root, { ...defaultState(), status: STATUS.complete, tickedByGate: ["SEC1.1"] });
  const r = finishRunPlan(root, { completed: true, now: new Date("2026-10-02T12:00:00Z") });
  assert.deepEqual(r, { plan: "SECURITY_PLAN.md", restored: true, cleared: true });
  const s = loadState(root);
  assert.deepEqual([s.status, s.pendingNotes.length, s.tickedByGate], ["idle", 1, []]);
  assert.deepEqual({ ...s.lastRunPlan }, { plan: "SECURITY_PLAN.md", branch: "autoclaude/security-fixes-2026-10-02", sweepId: null, since: "2026-10-02T10:00:00.000Z", completedAt: "2026-10-02T12:00:00.000Z" });
  assert.equal(hasMainStateKept(root), false);
  assert.equal(fs.existsSync(runPlanFile(root)), false);
  assert.equal(loadConfig(root).config.plan, "PLAN.md");
  // No override: a plain run's completion leaves its state (and any kept copy) alone.
  saveState(root, { ...defaultState(), status: STATUS.complete });
  fs.writeFileSync(mainStateFile(root), JSON.stringify({ ...defaultState(), status: STATUS.idle }));
  assert.deepEqual(finishRunPlan(root, { completed: true }), { plan: null, restored: false, cleared: false });
  assert.equal(loadState(root).status, "complete");
  // restoreMainState on its own (an override deleted by hand), and a copy that cannot be read stays.
  assert.equal(restoreMainState(root), true);
  assert.equal(loadState(root).status, "idle");
  assert.equal(restoreMainState(root), false);
  fs.writeFileSync(mainStateFile(root), "{ half");
  assert.equal(restoreMainState(root), false);
  assert.ok(fs.existsSync(mainStateFile(root)), "left for the owner");
});
