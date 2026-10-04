// Unit tests for the gate's pure helpers. The gate itself is covered by
// test/scenarios/stop-gate.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { failingAcceptLines, verifyMode, openFixupFindings, expectedCheckMs, expectedCheckerMs, checkerNeedSec, fitLimitSec } from "../../plugins/autoclaude/lib/gate.js";
import * as estimate from "../../plugins/autoclaude/lib/estimate.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";

const PLAN = "# P plan\n\n## Phase 1: Lists\n- [~] **S1.1** One\n  - Accept: the page shows a button labelled \"Clear completed\"\n  - Test: test/clear.test.js\n- [~] **S1.2** Two\n  - Accept: the count line reads `1 left, 1 done`\n  - Accept: the count updates without a reload\n- [ ] **S1.3** Three\n  - Accept: the store keeps three items\n  - Test: test/store.test.js\n  - Tags: no-ui\n";
const steps = parsePlan(PLAN).phases[0].steps;

test("verifyMode: per feature unless the project asks for per step", () => {
  assert.equal(verifyMode({ gate: { verifyAt: "step" } }), "step");
  assert.equal(verifyMode({ gate: { verifyAt: "phase" } }), "phase");
  assert.equal(verifyMode({ gate: {} }), "phase", "the 0.10.0 default");
  assert.equal(verifyMode({}), "phase");
});

test("verifyMode: a phase in gate.stepPhases is verified step by step; the key is read defensively", () => {
  const cfg = { gate: { verifyAt: "phase", stepPhases: [2, "3"] } };
  assert.deepEqual([verifyMode(cfg, 2), verifyMode(cfg, 3), verifyMode(cfg, 1), verifyMode(cfg)], ["step", "step", "phase", "phase"]);
  assert.equal(verifyMode({ gate: { verifyAt: "step", stepPhases: [] } }, 1), "step", "verifyAt step covers every phase");
  for (const stepPhases of ["2", null, { 2: true }, [null, "x", -1]]) assert.equal(verifyMode({ gate: { verifyAt: "phase", stepPhases } }, 2), "phase", JSON.stringify(stepPhases));
});

test("expectedCheckMs: a check's recent time with a quarter on top, else its timeoutSec; capped by its timeout, never under the least a check starts with", () => {
  const unit = { name: "unit", command: "x", timeoutSec: 600 };
  assert.equal(expectedCheckMs(unit, {}), 600000, "nothing on record: its timeoutSec");
  assert.equal(expectedCheckMs({ name: "lint", command: "x" }, {}), 900000, "no timeoutSec: the 900 s default");
  assert.equal(expectedCheckMs(unit, { unit: { recentMs: [100000, 400000, 120000], medianMs: 120000 } }), 150000);
  assert.equal(expectedCheckMs(unit, { unit: { recentMs: [100000, 120000, 400000, 500000] } }), 325000, "no median recorded: the median of the recent times");
  assert.equal(expectedCheckMs(unit, { unit: { medianMs: 590000 } }), 600000, "never more than its timeout");
  assert.equal(expectedCheckMs(unit, { unit: { medianMs: 200 } }), 10000, "never less than the least a check is started with");
  assert.equal(expectedCheckMs(unit, { unit: { medianMs: "soon", recentMs: "x" } }), 600000, "a record that makes no sense counts as none");
  assert.equal(expectedCheckMs(unit, { other: { medianMs: 1000 } }), 600000);
});

test("expectedCheckerMs: a checker is weighed by the estimate's model with a quarter on top, never by its worst case; capped by its own limit and by the most a part may need", () => {
  const cfg = mergeConfig({});
  const lines = (n) => [{ id: "S1.1", tags: ["ui"], accept: Array.from({ length: n }, (_, i) => `line ${i}`) }];
  // Six Accept lines: the tester's own limit is 1800 s (900 s for every 5 lines), more than a
  // stop has; it needs about 50 + 6 x 15 = 140 s, and is weighed at 175 s.
  assert.equal(checkerNeedSec("tester", cfg, { steps: lines(6) }), 140);
  assert.equal(expectedCheckerMs("tester", cfg, { steps: lines(6) }), 175000);
  assert.equal(expectedCheckerMs("tester", cfg, { step: lines(6)[0] }), 175000, "one step, as the gate runs a step verified on its own");
  assert.equal(checkerNeedSec("tester", cfg, { steps: [...lines(6), { id: "S1.2", tags: ["no-ui"], accept: ["x", "y"] }] }), 140, "no-ui steps are left out, as the tester leaves them out");
  // 70 lines: 1100 s, a quarter on top is 1375 s, more than the 1218 s a part may need.
  assert.equal(expectedCheckerMs("tester", cfg, { steps: lines(70) }), fitLimitSec(cfg) * 1000);
  assert.equal(fitLimitSec(cfg), 1218);
  // The bug bash: 60 turns of 7 s; the security review: 180 s; a quarter on top of each.
  assert.equal(expectedCheckerMs("bugbash", cfg, { step: lines(1)[0] }), 525000);
  assert.equal(expectedCheckerMs("security", cfg), 225000);
  // Never more than the checker's own limit, where it is stopped.
  assert.equal(expectedCheckerMs("security", mergeConfig({ security: { timeoutSec: 100 } })), 100000);
  assert.equal(expectedCheckerMs("tester", mergeConfig({ tester: { timeoutSec: 60 } }), { steps: lines(1) }), 60000);
  // lib/estimate.js counts the checkers by the same model and the same limit.
  assert.equal(estimate.fitLimitSec, fitLimitSec);
  const six = parsePlan(`# P plan\n\n## Phase 1: Six\n- [ ] **S1.1** One\n${[1, 2, 3, 4, 5, 6].map((n) => `  - Accept: line ${n}\n`).join("")}  - Tags: ui\n`);
  const e = estimate.estimatePhase(six.phases[0], { config: mergeConfig({ devServer: { command: "x", url: "http://127.0.0.1:1" } }), parsed: six });
  assert.deepEqual(e.parts.filter((p) => p.kind !== "check").map((p) => [p.kind, p.seconds]), [["tester", 140], ["bugbash", 420], ["security", 180]]);
});

test("failingAcceptLines matches the tester's [FAIL] criteria to Accept lines, however the tester quotes them", () => {
  const sections = [{ title: "Browser tester: FAILED", body: [
    "Criteria:",
    "- [pass] S1.1: the page shows a button labelled \"Clear completed\"",
    "  Evidence: seen",
    "- [FAIL] S1.2: The count line reads 1 left, 1 done",
    "  Evidence: it reads 2 left",
    "- [FAIL] the count updates without a reload (it needed F5)",
    "  Evidence: stale"
  ].join("\n") }];
  assert.deepEqual(failingAcceptLines(steps, sections), [
    { step: "S1.2", accept: "the count line reads `1 left, 1 done`", via: "tester" },
    { step: "S1.2", accept: "the count updates without a reload", via: "tester" }
  ]);
});

test("failingAcceptLines falls back to a step id in the criterion, and to Test: files named by a failing check", () => {
  const sections = [{ title: "Browser tester: FAILED", body: "- [FAIL] S1.1 works end to end in the browser\n  Evidence: no" }];
  assert.deepEqual(failingAcceptLines(steps, sections), [{ step: "S1.1", accept: "S1.1 works end to end in the browser", via: "tester" }]);
  const check = { name: "unit", tail: "not ok 3 - keeps three\n  at test/store.test.js:12:3\n# fail 1" };
  assert.deepEqual(failingAcceptLines(steps, [], check), [{ step: "S1.3", accept: "(the failing check's output names its test test/store.test.js)", via: "check" }]);
  assert.deepEqual(failingAcceptLines(steps, [{ title: "Check \"unit\": FAILED", body: "exit code 1" }]), [], "nothing to go on: no guess");
});

test("openFixupFindings: a row is done when fixed or closed, or left for the owner with a reason; open, reasonless or missing rows are listed", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fixup-"));
  fs.mkdirSync(path.join(root, "docs"));
  const row = (what, owner, status) => `| 2026-09-28 | browser tester | S1.3 | ${what} | ${owner} | ${status} |`;
  // A pipe inside a cell is escaped the way the gate writes it.
  const filed = ["medium: a. Actual: x.", "low: b \\| c.", "low: d.", "low: e.", "low: f."].map((w) => row(w, "Claude", "open"));
  const header = "# BLOCKERS\n\n| Date | Found by | Step | What | Owner | Status |\n|---|---|---|---|---|---|\n";
  // The builder changed Owner and Status only, and dropped the last row altogether.
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), header + [
    row("medium: a. Actual: x.", "Claude", "fixed"),
    row("low: b \\| c.", "owner", "left for the owner: needs the brand colours from the owner"),
    row("low: d.", "owner", "left for the owner"),
    row("low: e.", "Claude", "open")
  ].join("\n") + "\n");
  const findings = filed.map((r, i) => ({ source: "browser tester", severity: "low", text: `finding ${i + 1}`, doc: "docs/BLOCKERS.md", row: r }));
  const open = openFixupFindings(root, [...findings, { source: "browser tester", severity: "low", text: "older run", doc: "docs/BLOCKERS.md", row: null }]);
  assert.deepEqual(open.map((f) => [f.text, f.status]), [["finding 3", "left for the owner"], ["finding 4", "open"], ["finding 5", null]]);
});

test("openFixupFindings finds a row whose text the builder added a note to, and never takes one finding's row for another's", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fixup-"));
  fs.mkdirSync(path.join(root, "docs"));
  const row = (what, status) => `| 2026-09-28 | browser tester | S1.3 | ${what} | Claude | ${status} |`;
  // Finding 2's text starts with finding 1's; the builder noted the fix in finding 1's row.
  const filed = [row("low: a.", "open"), row("low: a. Actual: b.", "open")];
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), `# BLOCKERS\n\n${row("low: a. Fixed in app.js.", "fixed")}\n${row("low: a. Actual: b.", "open")}\n`);
  const findings = filed.map((r, i) => ({ source: "browser tester", severity: "low", text: `finding ${i + 1}`, doc: "docs/BLOCKERS.md", row: r }));
  assert.deepEqual(openFixupFindings(root, findings).map((f) => [f.text, f.status]), [["finding 2", "open"]]);
});
