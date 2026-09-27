import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultState, loadState, saveState, updateState, isRunning, describeState, STATUS } from "../../plugins/autoclaude/lib/state.js";

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

test("a corrupt state file reads as defaults instead of throwing", () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, ".autoclaude"));
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), "{ half written");
  assert.equal(loadState(root).status, STATUS.idle);
});

test("describeState reads well", () => {
  assert.equal(describeState({ ...defaultState(), status: "paused", pauseReason: "review" }), "paused (review)");
  assert.equal(describeState({ ...defaultState(), status: "running", pauseRequested: true }), "running, pause requested after the next verified commit");
  assert.equal(describeState({ ...defaultState(), status: "complete" }), "complete");
});
