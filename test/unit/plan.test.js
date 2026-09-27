import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlan, lintPlan, nextStep, firstUnfinished, isPhaseEnd, setMarker, stepText, progress, planSlug, stepById, formatLint } from "../../plugins/autoclaude/lib/plan.js";

const EXAMPLE = `# Shop plan

## Goal
Sell things.

## Constraints & decisions
- Stack: whatever
- Don't: guess

## Phase 1: Accounts
- [ ] **S1.1** User can sign up with email and password
  - Accept: /signup shows a form with email, password, confirm
  - Accept: valid submit creates the user and lands on /dashboard showing the email
  - Accept: a duplicate email shows "Email already registered"
  - Test: e2e/signup.spec.ts
  - Tags: ui, security
- [ ] **S1.2** User can log in
  - Accept: /login works
  - Test: e2e/login.spec.ts, e2e/session.spec.ts
  - Depends: S1.1

Some prose between steps that should be ignored.

## Phase 2: Catalogue
- [x] **S2.1** Products list
  - Accept: /products lists 3 seeded items
    - a nested bullet under the accept line
  - Test: test/products.test.js
  - Tags: no-ui
- [!] **S2.2** Product page
  - Accept: /products/1 shows the name
`;

test("parses phases, steps, fields and markers from the section 4.8.1 shape", () => {
  const p = parsePlan(EXAMPLE);
  assert.equal(p.title, "Shop plan");
  assert.deepEqual(p.phases.map((ph) => [ph.num, ph.title, ph.steps.length]), [[1, "Accounts", 2], [2, "Catalogue", 2]]);
  assert.deepEqual(p.steps.map((s) => s.id), ["S1.1", "S1.2", "S2.1", "S2.2"]);
  const s11 = stepById(p, "S1.1");
  assert.equal(s11.title, "User can sign up with email and password");
  assert.equal(s11.accept.length, 3);
  assert.deepEqual(s11.test, ["e2e/signup.spec.ts"]);
  assert.deepEqual(s11.tags, ["ui", "security"]);
  assert.deepEqual(stepById(p, "S1.2").test, ["e2e/login.spec.ts", "e2e/session.spec.ts"]);
  assert.deepEqual(stepById(p, "S1.2").depends, ["S1.1"]);
  assert.equal(stepById(p, "S2.1").marker, "x");
  assert.equal(stepById(p, "S2.2").marker, "!");
  assert.deepEqual(lintPlan(p), []);
  assert.deepEqual(progress(p), { total: 4, done: 1, todo: 2, failed: 1, blocked: 0 });
  assert.equal(planSlug(p), "shop");
});

test("nextStep, firstUnfinished, isPhaseEnd and stepText", () => {
  const p = parsePlan(EXAMPLE);
  assert.equal(nextStep(p).id, "S1.1");
  assert.equal(firstUnfinished(p).id, "S1.1");
  assert.equal(isPhaseEnd(p, "S1.1"), false);
  assert.equal(isPhaseEnd(p, "S1.2"), true);
  assert.equal(isPhaseEnd(p, "S2.2"), true);
  assert.equal(isPhaseEnd(p, "nope"), false);
  const text = stepText(p, stepById(p, "S2.1"));
  assert.equal(text.split("\n").length, 5);
  assert.match(text, /a nested bullet under the accept line/);
  assert.match(text, /Tags: no-ui/);
  assert.doesNotMatch(text, /S2\.2/);
});

test("setMarker changes exactly one byte and keeps CRLF line endings and a BOM", () => {
  const crlf = "﻿" + EXAMPLE.replace(/\n/g, "\r\n");
  const out = setMarker(crlf, "S1.1", "x");
  assert.equal(out.length, crlf.length);
  const diffs = [];
  for (let i = 0; i < crlf.length; i++) if (crlf[i] !== out[i]) diffs.push(i);
  assert.equal(diffs.length, 1);
  assert.equal(out[diffs[0]], "x");
  assert.equal(crlf[diffs[0]], " ");
  assert.ok(out.startsWith("﻿# Shop plan\r\n"));
  const p = parsePlan(out);
  assert.equal(stepById(p, "S1.1").marker, "x");
  assert.equal(stepById(p, "S1.1").accept.length, 3);
  assert.equal(nextStep(p).id, "S1.2");
});

test("setMarker handles mixed line endings byte-for-byte and rejects bad input", () => {
  const mixed = "# P plan\r\n\n## Phase 1: A\n- [ ] **S1.1** One\r\n  - Accept: yes\n- [ ] **S1.2** Two\n  - Accept: yes\r\n";
  const out = setMarker(mixed, "S1.2", "!");
  assert.equal(out.replace("- [!] **S1.2**", "- [ ] **S1.2**"), mixed);
  assert.throws(() => setMarker(mixed, "S9.9", "x"), /no step with id S9\.9/);
  assert.throws(() => setMarker(mixed, "S1.1", "X"), /invalid marker/);
});

test("lint: duplicate ids, missing Accept, unknown marker, step outside a phase, bad Depends, phase mismatch", () => {
  const bad = `# Bad plan

- [ ] **S0.1** Orphan before any phase
  - Accept: something

## Phase 1: One
- [ ] **S1.1** Fine
  - Accept: ok
- [ ] **S1.1** Duplicate
  - Accept: ok
- [X] **S1.2** Uppercase marker
  - Accept: ok
- [ ] **S1.3** No accept line
  - Test: x.spec.ts
- [ ] **S2.9** Wrong phase number
  - Accept: ok
  - Depends: S7.7
`;
  const problems = lintPlan(parsePlan(bad));
  const messages = problems.map((p) => `${p.id}: ${p.message}`);
  const expect = (re) => assert.ok(messages.some((m) => re.test(m)), `expected ${re}, got:\n${messages.join("\n")}`);
  expect(/S0\.1: step is not under/);
  expect(/S1\.1: duplicate step id/);
  expect(/S1\.2: unknown marker "\[X\]"/);
  expect(/S1\.3: step has no `- Accept:` line/);
  expect(/S2\.9: step id S2\.9 does not match its phase number 1/);
  expect(/S2\.9: Depends refers to unknown step S7\.7/);
  assert.equal(problems.length, 6);
  assert.match(formatLint(problems), /line 3 \(S0\.1\)/);
});

test("lint: tags, no-ui without Test, id and phase order, repeated and empty phases, placeholders, TBD and TODO", () => {
  const bad = `# Rules plan

## Goal

Not written yet.

\`\`\`
Not written yet. (inside a fence: fine)
- [ ] **S9.1** not a step either
\`\`\`

Mentioning \`Nothing decided yet.\` in inline code is fine.

## Phase 1: One
- [ ] **S1.2** Second first
  - Accept: a
  - Tags: UI, fancy
- [ ] **S1.1** First second
  - Accept: b
  - Tags: ui, no-ui
- [ ] **S1.3** Pure logic
  - Accept: c
  - Tags: no-ui, db
- [ ] **S1.10** Ten after three is fine
  - Accept: d
  - Test: test/ten.test.js
  - Tags: no-ui, security

## Phase 3: Three
- [ ] **S3.1** Pick a library TBD
  - Accept: works with the TODO list app, see \`TODO\` and TODO.md
  - Test: test/three.test.js
  - Tags: no-ui
- [ ] **S3.2** Fine
  - Accept: the page still says TODO somewhere

## Phase 2: Two, out of order
- [ ] **S2.1** Fine
  - Accept: e

## Phase 3: Three again

### Constraints

Nothing decided yet.
`;
  const problems = lintPlan(parsePlan(bad));
  const messages = problems.map((p) => `${p.line} ${p.id}: ${p.message}`);
  const expect = (re) => assert.ok(messages.some((m) => re.test(m)), `expected ${re}, got:\n${messages.join("\n")}`);
  expect(/^5 null: template placeholder "Not written yet\." is still in the plan/);
  expect(/^45 null: template placeholder "Nothing decided yet\." is still in the plan/);
  expect(/S1\.2: unknown tag "fancy" \(use ui, no-ui, security or db\)/);
  expect(/S1\.1: step id S1\.1 comes after S1\.2; step ids must be in ascending order within a phase/);
  expect(/S1\.1: step is tagged both ui and no-ui/);
  expect(/S1\.1: a no-ui step needs a `- Test:` line/);
  expect(/S1\.3: a no-ui step needs a `- Test:` line/);
  expect(/S3\.1: step still says TBD/);
  expect(/S3\.2: step still says TODO/);
  expect(/null: Phase 2 comes after Phase 3; phases must be in ascending order/);
  expect(/null: phase number 3 is used twice \(first at line 29\)/);
  expect(/null: Phase 3 has no steps/);
  assert.equal(problems.length, 12, messages.join("\n"));
  assert.deepEqual(problems.map((p) => p.line), [...problems.map((p) => p.line)].sort((a, b) => a - b), "problems come in line order");

  // "todo" in a todo app, a TODO.md file name and TODO inside inline code are not markers.
  const fine = "# T plan\n\n## Phase 1: A\n- [ ] **S1.1** Edit a todo's text\n  - Accept: `TODO` stays, TODO.md is read\n  - Test: test/todo.test.js\n  - Tags: no-ui, db\n";
  assert.deepEqual(lintPlan(parsePlan(fine)), []);
});

test("a plan with no steps lints as unusable, and headings end a step", () => {
  assert.equal(lintPlan(parsePlan("# Empty\n\nJust prose.\n")).length, 1);
  const p = parsePlan("## Phase 1: A\n- [ ] **S1.1** One\n  - Accept: a\n### Notes\n  - Accept: this belongs to the heading, not the step\n");
  assert.equal(stepById(p, "S1.1").accept.length, 1);
});

test("the tool's own plan parses and lints clean", async () => {
  const fs = await import("node:fs");
  const text = fs.readFileSync(new URL("../../PLAN.md", import.meta.url), "utf8");
  const p = parsePlan(text);
  const problems = lintPlan(p);
  assert.deepEqual(problems, []);
  assert.ok(p.steps.length > 40);
  assert.equal(p.phases[0].num, 0);
  assert.equal(stepById(p, "P0.2").marker, "x");
});
