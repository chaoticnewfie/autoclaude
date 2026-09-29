// Unit tests for undoing a verification that was cut off (lib/resume.js). The resume and gate
// flows around it are covered by test/scenarios/feature-gate.test.js and stop-gate.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { undoCutVerification, undoVerification, pendingVerifyFile, gateRunning, liveOtherGate, pendingCommitMessage } from "../../plugins/autoclaude/lib/resume.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const config = mergeConfig({});
const PLAN = "# P plan\r\n\r\n## Phase 1: A\r\n- [~] **S1.1** One\r\n  - Accept: a\r\n- [ ] **S1.2** Two\r\n  - Accept: b\r\n- [ ] **S1.3** Three\r\n  - Accept: c\r\n";

function project({ progress = "# Progress\n" } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-resume-"));
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  const added = "- 2026-09-28 S1.1 One (attempt 1)\n- 2026-09-28 S1.2 Two (attempt 1)\n";
  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN.replace("- [~] **S1.1**", "- [x] **S1.1**").replace("- [ ] **S1.2**", "- [x] **S1.2**"));
  fs.writeFileSync(path.join(root, "PROGRESS.md"), (progress || "") + added);
  fs.writeFileSync(pendingVerifyFile(root), JSON.stringify({ step: "S1.2", plan: PLAN, progress, ticked: ["S1.1", "S1.2"], added }));
  return root;
}

test("undoCutVerification puts back exactly what the verification wrote, byte for byte", () => {
  const root = project();
  assert.deepEqual(undoCutVerification(root, config), { step: "S1.2", ids: ["S1.1", "S1.2"], fixup: false, count: 0 });
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), PLAN, "CRLF and the built marker kept");
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), "# Progress\n");
  assert.equal(fs.existsSync(pendingVerifyFile(root)), false);
  assert.equal(undoCutVerification(root, config), null, "nothing left to undo");
});

test("undoCutVerification keeps the owner's own edits and later lines, and removes a PROGRESS file the verification created", () => {
  let root = project();
  const planFile = path.join(root, "PLAN.md");
  // During the pause the owner unticked S1.2 and added a line of their own to PROGRESS.md.
  fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace("- [x] **S1.2**", "- [ ] **S1.2**"));
  fs.appendFileSync(path.join(root, "PROGRESS.md"), "- owner: looked at S1.1\n");
  assert.deepEqual(undoCutVerification(root, config).ids, ["S1.1"]);
  assert.match(fs.readFileSync(planFile, "utf8"), /- \[~\] \*\*S1\.1\*\*[\s\S]*- \[ \] \*\*S1\.2\*\*/);
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), "# Progress\n- owner: looked at S1.1\n");

  root = project({ progress: null });
  undoCutVerification(root, config);
  assert.equal(fs.existsSync(path.join(root, "PROGRESS.md")), false);
});

test("undoCutVerification leaves a verification to a gate that is still alive, when asked to", () => {
  const root = project();
  const marker = path.join(root, ".autoclaude", "gate.json");
  fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  assert.equal(gateRunning(root), true);
  assert.equal(undoCutVerification(root, config, { unlessGateRunning: true }), null);
  assert.ok(fs.existsSync(pendingVerifyFile(root)));
  // A marker left by a gate that died does not count.
  fs.writeFileSync(marker, JSON.stringify({ pid: 2 ** 30, at: new Date().toISOString() }));
  assert.equal(gateRunning(root), false);
  assert.deepEqual(undoCutVerification(root, config, { unlessGateRunning: true }).ids, ["S1.1", "S1.2"]);
});

test("undoCutVerification takes the findings rows out too, and removes a findings file the verification created", () => {
  const root = project();
  const blockers = path.join(root, "docs", "BLOCKERS.md");
  fs.mkdirSync(path.dirname(blockers), { recursive: true });
  fs.writeFileSync(blockers, "# BLOCKERS\n\n| a | b |\n|---|---|\n| owner | row |\n");
  const row = "| 2026-09-28 | browser tester | S1.2 | medium: x. | Claude | open |\n";
  fs.appendFileSync(blockers, row);
  const created = "# SECURITY-FINDINGS\n\n| h |\n|---|\n| 2026-09-28 | low | a.js | y (found at S1.2) | z | open |\n";
  fs.writeFileSync(path.join(root, "docs", "SECURITY-FINDINGS.md"), created);
  const snap = JSON.parse(fs.readFileSync(pendingVerifyFile(root), "utf8"));
  fs.writeFileSync(pendingVerifyFile(root), JSON.stringify({ ...snap, rows: [{ file: "docs/BLOCKERS.md", text: row, created: false }, { file: "docs/SECURITY-FINDINGS.md", text: created, created: true }] }));
  undoCutVerification(root, config);
  assert.equal(fs.readFileSync(blockers, "utf8"), "# BLOCKERS\n\n| a | b |\n|---|---|\n| owner | row |\n");
  assert.equal(fs.existsSync(path.join(root, "docs", "SECURITY-FINDINGS.md")), false);
});

test("undoVerification takes out a verified close from its undo record: the earlier markers, the PROGRESS lines, a PROGRESS file it created, its rows", () => {
  let root = project();
  fs.rmSync(pendingVerifyFile(root));
  const planFile = path.join(root, "PLAN.md");
  const row = "| 2026-09-28 | browser tester | S1.2 | medium: x. | Claude | open |\n";
  const blockers = path.join(root, "docs", "BLOCKERS.md");
  fs.mkdirSync(path.dirname(blockers), { recursive: true });
  fs.writeFileSync(blockers, row);
  const added = "- 2026-09-28 S1.1 One (attempt 1)\n- 2026-09-28 S1.2 Two (attempt 1)\n";
  const undo = { ticked: ["S1.1", "S1.2"], markers: { "S1.1": "~", "S1.2": " " }, added, progressCreated: false, rows: [{ file: "docs/BLOCKERS.md", text: row, created: true }] };
  assert.deepEqual(undoVerification(root, config, undo), ["S1.1", "S1.2"]);
  assert.equal(fs.readFileSync(planFile, "utf8"), PLAN);
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), "# Progress\n");
  assert.equal(fs.existsSync(blockers), false);
  // PROGRESS.md was there before, empty: it stays. One the verification created goes.
  root = project({ progress: "" });
  undoVerification(root, config, { ...undo, rows: [] });
  assert.equal(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), "");
  root = project({ progress: "" });
  undoVerification(root, config, { ...undo, rows: [], progressCreated: true });
  assert.equal(fs.existsSync(path.join(root, "PROGRESS.md")), false);
});

test("a snapshot whose outcome the run state already records is only removed; a cut-off while running counts as out of time", () => {
  let root = project();
  const snap = JSON.parse(fs.readFileSync(pendingVerifyFile(root), "utf8"));
  fs.writeFileSync(pendingVerifyFile(root), JSON.stringify({ ...snap, id: "v-1" }));
  const ticked = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
  // The gate recorded the pass (state.closing) and was cut off before it removed the snapshot.
  saveState(root, { ...defaultState(), status: "running", closing: { verifyId: "v-1", stepId: "S1.2" } });
  assert.equal(undoCutVerification(root, config, { unlessGateRunning: true }), null);
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), ticked, "its ticks stand");
  assert.equal(fs.existsSync(pendingVerifyFile(root)), false);

  // Cut off while running: counted, the second time for the same step too.
  root = project();
  saveState(root, { ...defaultState(), status: "running" });
  assert.equal(undoCutVerification(root, config).count, 1);
  fs.writeFileSync(pendingVerifyFile(root), JSON.stringify({ step: "S1.2", ticked: [], added: "" }));
  assert.equal(undoCutVerification(root, config).count, 2);
  assert.deepEqual(loadState(root).outOfTime, { "S1.2": 2 });
  // Ended by the owner's pause, or the gate's own undo after a failure: not counted.
  root = project();
  saveState(root, { ...defaultState(), status: "paused", pauseReason: "review" });
  assert.equal(undoCutVerification(root, config).count, 0);
  root = project();
  saveState(root, { ...defaultState(), status: "running" });
  assert.equal(undoCutVerification(root, config, { own: true }).count, 0);
  assert.deepEqual(loadState(root).outOfTime, {});
});

test("a verification whose gate is still alive is left to it, even when gate.json names another gate", async () => {
  const root = project();
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  try {
    const snap = JSON.parse(fs.readFileSync(pendingVerifyFile(root), "utf8"));
    fs.writeFileSync(pendingVerifyFile(root), JSON.stringify({ ...snap, pid: child.pid, at: new Date().toISOString() }));
    assert.equal(liveOtherGate(root, config, process.pid), true);
    assert.equal(liveOtherGate(root, config, child.pid), false, "a gate is never busy with its own verification");
    assert.equal(undoCutVerification(root, config, { unlessGateRunning: true, self: process.pid }), null);
    assert.ok(fs.existsSync(pendingVerifyFile(root)));
    // A snapshot older than any gate can run names a pid that has been reused.
    fs.writeFileSync(pendingVerifyFile(root), JSON.stringify({ ...snap, pid: child.pid, at: new Date(Date.now() - 3 * 3600 * 1000).toISOString() }));
    assert.equal(liveOtherGate(root, config, process.pid), false);
    assert.deepEqual(undoCutVerification(root, config, { unlessGateRunning: true, self: process.pid }).ids, ["S1.1", "S1.2"]);
  } finally {
    child.kill();
  }
});

test("pendingCommitMessage keeps the gate's own message under its subject, with who committed it", () => {
  const gate = "autoclaude(S1.2): Two\n\nVerified S1.2, attempt 1.\n\nAccept:\nS1.2 Two\n  - b\n\nChecks:\n- unit: passed in 3 s\n";
  const one = pendingCommitMessage(["S1.2"], ["Two"], { "S1.2": gate });
  assert.equal(one, "autoclaude(S1.2): Two\n\nCommitted by `autoclaude resume`: the gate had verified or built S1.2, but its own commit failed.\n\nVerified S1.2, attempt 1.\n\nAccept:\nS1.2 Two\n  - b\n\nChecks:\n- unit: passed in 3 s\n");
  assert.equal(pendingCommitMessage(["S1.2"], ["Two"], {}), "autoclaude(S1.2): Two\n\nCommitted by `autoclaude resume`: the gate had verified or built S1.2, but its own commit failed.\n", "no message kept (an older run)");
  assert.match(pendingCommitMessage(["S1.1", "S1.2"], ["One", "Two"], { "S1.2": gate }), /^autoclaude\(S1\.1, S1\.2\): One; Two\n\nCommitted by[^\n]*\n\nVerified S1\.2, attempt 1\./);
});

test("a corrupt snapshot is dropped without touching the plan", () => {
  const root = project();
  fs.writeFileSync(pendingVerifyFile(root), "{ half written");
  const plan = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
  assert.deepEqual(undoCutVerification(root, config), { step: null, ids: [], fixup: false, count: 0 });
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), plan);
  assert.equal(fs.existsSync(pendingVerifyFile(root)), false);
});
