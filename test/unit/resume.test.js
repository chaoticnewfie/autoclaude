// Unit tests for undoing a verification that was cut off (lib/resume.js). The resume and gate
// flows around it are covered by test/scenarios/feature-gate.test.js and stop-gate.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { undoCutVerification, pendingVerifyFile, gateRunning } from "../../plugins/autoclaude/lib/resume.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";

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
  assert.deepEqual(undoCutVerification(root, config), { step: "S1.2", ids: ["S1.1", "S1.2"] });
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

test("a corrupt snapshot is dropped without touching the plan", () => {
  const root = project();
  fs.writeFileSync(pendingVerifyFile(root), "{ half written");
  const plan = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
  assert.deepEqual(undoCutVerification(root, config), { step: null, ids: [] });
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), plan);
  assert.equal(fs.existsSync(pendingVerifyFile(root)), false);
});
