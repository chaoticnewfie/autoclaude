// Unit tests for the gate's pure helpers. The gate itself is covered by
// test/scenarios/stop-gate.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { failingAcceptLines, verifyMode } from "../../plugins/autoclaude/lib/gate.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";

const PLAN = "# P plan\n\n## Phase 1: Lists\n- [~] **S1.1** One\n  - Accept: the page shows a button labelled \"Clear completed\"\n  - Test: test/clear.test.js\n- [~] **S1.2** Two\n  - Accept: the count line reads `1 left, 1 done`\n  - Accept: the count updates without a reload\n- [ ] **S1.3** Three\n  - Accept: the store keeps three items\n  - Test: test/store.test.js\n  - Tags: no-ui\n";
const steps = parsePlan(PLAN).phases[0].steps;

test("verifyMode: per feature unless the project asks for per step", () => {
  assert.equal(verifyMode({ gate: { verifyAt: "step" } }), "step");
  assert.equal(verifyMode({ gate: { verifyAt: "phase" } }), "phase");
  assert.equal(verifyMode({ gate: {} }), "phase", "the 0.10.0 default");
  assert.equal(verifyMode({}), "phase");
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
