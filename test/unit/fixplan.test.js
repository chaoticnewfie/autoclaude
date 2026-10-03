import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  generateFixPlan, copyConstraints, fixPlanTitle, needsOwner, FIX_PLAN_FILES, MAX_STEPS_PER_PHASE, CHARACTERIZATION_DIR,
  setRunPlan, clearRunPlan, runPlanOverride, PINNED_TAG, isPinnedStep, stepPrefix, STEP_PREFIX
} from "../../plugins/autoclaude/lib/fixplan.js";
import { normalizeFinding, numberFindings, dedupe } from "../../plugins/autoclaude/lib/findings.js";
import { parsePlan, lintPlan, planSlug, stepText, TAGS } from "../../plugins/autoclaude/lib/plan.js";
import { parseNpmAudit, scanHistoryText, scanTree } from "../../plugins/autoclaude/lib/scan-security.js";
import { checkSecurityHeaders, checkCookies, checkCors } from "../../plugins/autoclaude/lib/probe.js";
import { afterRunSection, afterRunItems } from "../../plugins/autoclaude/lib/summary.js";

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fixplan-cfg-"));
const REPORT = ".autoclaude/sweeps/20261002-1430-security/report.md";
const TEMPLATE = fs.readFileSync(new URL("../../plugins/autoclaude/project-template/PLAN.md", import.meta.url), "utf8");

const MAIN_PLAN = [
  "# Todo app plan",
  "",
  "## Goal",
  "",
  "A todo list.",
  "",
  "## Constraints & decisions",
  "",
  "### Security",
  "",
  "No login: the app listens on 127.0.0.1 only (owner's choice).",
  "",
  "```markdown",
  "## Not a heading inside a fence",
  "```",
  "",
  "### Data",
  "",
  "SQLite in data/todos.db.",
  "",
  "## Phase 1: Todos",
  "- [x] **S1.1** Add a todo",
  "  - Accept: it shows",
  ""
].join("\n");

// Details that must never reach the committed plan.
const SECRET_DETAIL = ["SQL injection in the search box", "' OR 1=1 --", "Attackers read every table", "use a bound parameter", "type a quote into the search box", "CWE-89", "injection"];

function securityFindings() {
  return numberFindings([
    { category: "injection", title: "SQL injection in the search box", severity: "critical", cwe: "CWE-89", file: "src/api/search.js", line: 12, evidence: "db.query(\"... ' OR 1=1 --\")",
      impact: "Attackers read every table", reproduce: "type a quote into the search box", fix: "use a bound parameter", testIdea: "a quote finds nothing", autoFixSafe: true, confidence: 9 },
    { category: "secrets", title: "A key in the config", severity: "high", file: "config/keys.js", line: 3, autoFixSafe: true, ownerAction: "Rotate the key at its provider", confidence: 9 },
    { category: "dependencies", title: "An old library", severity: "high", file: "package-lock.json", fixedVersion: "4.17.21", autoFixSafe: true, confidence: 10 },
    { category: "access-control", title: "An admin route", severity: "medium", file: "src/api/admin.js", line: 4, autoFixSafe: false, confidence: 8 },
    ...Array.from({ length: 6 }, (_, i) => ({ category: "headers", title: `Header ${i}`, severity: "low", file: "src/api/server.js", line: 10 * i + 1, autoFixSafe: true, confidence: 7 }))
  ].map((f) => normalizeFinding(f, { kind: "security" })), "security");
}

test("a security plan: lint-clean, its own H1 and branch, a Goal pointing at the report, the main plan's constraints copied", () => {
  const r = generateFixPlan({ kind: "security", confirmed: securityFindings(), uncertain: [{ id: "SEC-099", severity: "low" }], mainPlanText: MAIN_PLAN, reportRel: REPORT, date: "2026-10-02" });
  assert.equal(r.file, "SECURITY_PLAN.md");
  assert.deepEqual(r.problems, [], r.text);
  const parsed = parsePlan(r.text);
  assert.deepEqual(lintPlan(parsed), []);
  assert.equal(parsed.title, "Security fixes 2026-10-02");
  assert.equal(planSlug(parsed), "security-fixes-2026-10-02", "the run branch follows the H1");
  assert.match(r.text, /## Goal\n\nFix the confirmed findings of the security sweep, each with a regression test[^\n]*`\.autoclaude\/sweeps\/20261002-1430-security\/report\.md` \(gitignored\)/);
  assert.match(r.text, /## Constraints & decisions\n\n### Security\n\nNo login: the app listens on 127\.0\.0\.1 only \(owner's choice\)\./);
  assert.match(r.text, /### Data\n\nSQLite in data\/todos\.db\./);
  assert.match(r.text, /- Fix only what each step names\./);
  assert.match(r.text, /critical findings are treated as high \(D58\)/);
  assert.equal(r.text.includes("Add a todo"), false, "the main plan's steps are not copied");
});

test("a security plan: phases by area then severity, at most 5 steps each, every step tagged and tested, neutral wording", () => {
  const confirmed = securityFindings();
  const r = generateFixPlan({ kind: "security", confirmed, mainPlanText: MAIN_PLAN, reportRel: REPORT, date: "2026-10-02" });
  const parsed = parsePlan(r.text);
  assert.ok(parsed.phases.every((p) => p.steps.length <= MAX_STEPS_PER_PHASE));
  assert.deepEqual(r.phases.map((p) => p.title), [
    "Security fixes in src/api (high, low)",
    "Security fixes in src/api (low), part 2",
    "Security fixes in the project root (high)",
    "Security fixes in config (high)"
  ]);
  assert.deepEqual(r.phases[0].findings, ["SEC-001", "SEC-005", "SEC-006", "SEC-007", "SEC-008"], "most severe first within the area");
  assert.equal(r.stepCount, 9, "every confirmed finding the run may fix is a step; SEC-004 needs the owner");
  for (const s of parsed.steps) {
    assert.deepEqual(s.tags, ["no-ui", "security"], s.id);
    assert.equal(s.test.length, 1, s.id);
    assert.ok(s.accept.some((a) => /regression test named for SEC-\d{3}/.test(a)), `${s.id} has a regression-test Accept line`);
    assert.match(stepText(parsed, s), /- Note: Finding SEC-\d{3} \((high|medium|low)\), details in `\.autoclaude\/sweeps\/20261002-1430-security\/report\.md`/);
  }
  assert.match(r.text, /- \[ \] \*\*SF1\.1\*\* Resolve finding SEC-001 in `src\/api\/search\.js`/);
  assert.match(r.text, /Note: Finding SEC-001 \(high\)/, "critical is written as high");
  assert.equal(/critical\)/.test(r.text), false);
  assert.match(r.text, /\*\*SF3\.1\*\* Update the dependency named in finding SEC-002\n  - Accept: the dependency finding SEC-002 names is upgraded the way its report entry says \(to the fixed version it gives, or later; inside the allowed range when it gives none\)/);
  assert.match(r.text, /Test: test\/sec-001\.test\.js/);
  for (const detail of SECRET_DETAIL) assert.equal(r.text.toLowerCase().includes(detail.toLowerCase()), false, `the plan leaks "${detail}"`);
});

test("a security plan: what needs the owner and the uncertain findings go under After the run, which the hand-back reads", () => {
  const r = generateFixPlan({ kind: "security", confirmed: securityFindings(), uncertain: [{ id: "SEC-012", severity: "low" }, { id: "SEC-011", severity: "high" }], mainPlanText: MAIN_PLAN, reportRel: REPORT, date: "2026-10-02" });
  assert.deepEqual(r.ownerItems, ["SEC-004"]);
  assert.equal(/\*\* Resolve finding SEC-004/.test(r.text), false, "a finding for the owner is not a step");
  const items = afterRunItems(afterRunSection(r.text));
  assert.equal(items.length, 4, items.join("\n"));
  assert.match(items[0], /^Review the run branch, then merge it/);
  assert.match(items[1], /^SEC-004 \(medium\) needs you: see its entry in `\.autoclaude\/sweeps\//);
  assert.match(items[2], /^SEC-003 is fixed by this plan and also needs something only you can do/);
  assert.match(items[3], /^Not fixed because no session could confirm or refute them: SEC-011, SEC-012\./);
  assert.equal(r.text.includes("Rotate the key"), false, "what the owner must do stays in the report");
});

test("an optimize plan: tier A is one step, tier B pins behaviour first, tier C is left for the owner", () => {
  const confirmed = numberFindings([
    { category: "unused-code", title: "Remove the unused helper formatDate and its TODO note", severity: "low", file: "src/utils/date.ts", tier: "A", autoFixSafe: true },
    { category: "duplicates", title: "Merge the two copies of the price calculation", severity: "medium", file: "src/cart/price.ts", tier: "B", autoFixSafe: true },
    { category: "rebuild", title: "Rebuild the settings form handling", severity: "medium", file: "src/pages/settings.tsx", tier: "B", autoFixSafe: true },
    { category: "performance", title: "Load the cart items in one query", severity: "high", file: "src/cart/load.ts", tier: "A", autoFixSafe: true },
    { category: "bug", title: "Totals round the wrong way", severity: "medium", file: "src/cart/total.ts", tier: "A", autoFixSafe: true },
    { category: "dependencies", title: "Upgrade the UI library to its next major", severity: "low", file: "package.json", tier: "C", autoFixSafe: true }
  ].map((f) => normalizeFinding(f, { kind: "optimize" })), "optimize");
  const r = generateFixPlan({ kind: "optimize", confirmed, mainPlanText: "", reportRel: ".autoclaude/sweeps/x-optimize/report.md", date: "2026-10-02" });
  assert.equal(r.file, "OPTIMIZE_PLAN.md");
  assert.deepEqual(r.problems, [], r.text);
  const parsed = parsePlan(r.text);
  assert.equal(parsed.title, "Optimization 2026-10-02");
  assert.ok(parsed.steps.every((s) => /^OF\d+\.\d+$/.test(s.id)));
  assert.ok(parsed.steps.every((s) => !s.tags.includes("security")));
  const byFinding = (id) => parsed.steps.filter((s) => stepText(parsed, s).includes(`Finding ${id},`));

  // Tier B: a pin step, then the change that depends on it and may not touch the pinned tests.
  const dup = confirmed.find((f) => f.category === "duplicates").id;
  const [pin, change] = byFinding(dup);
  assert.match(pin.title, new RegExp(`^Pin the current behaviour around finding ${dup}`));
  const pinned = `${CHARACTERIZATION_DIR}/${dup.toLowerCase()}.test.ts`;
  assert.deepEqual(pin.test, [pinned]);
  assert.ok(pin.accept.some((a) => a.includes(`characterization tests in \`${pinned}\``) && /pass on the code as it is before the change/.test(a)));
  assert.deepEqual(change.depends, [pin.id]);
  assert.ok(change.accept.some((a) => a.startsWith(`\`${pinned}\` is unchanged since the pin step's commit`)), change.accept.join("\n"));
  assert.ok(change.tags.includes("no-ui"));
  assert.equal(pin.phase, change.phase, "a pin step and its change share a phase");
  // The tool guard knows the change step by its tag, which plan.js lists (so the plan still lints
  // clean), or by its shape; the pin step itself writes the tests, so it is not pinned.
  assert.ok(TAGS.includes(PINNED_TAG), "lint knows the pinned tag");
  assert.ok(change.tags.includes(PINNED_TAG), "the change step is tagged pinned");
  assert.equal(pin.tags.includes(PINNED_TAG), false);
  assert.equal(isPinnedStep(change), true);
  assert.equal(isPinnedStep(pin), false);

  // A rebuild is checked in the browser too.
  const [, rebuild] = byFinding(confirmed.find((f) => f.category === "rebuild").id);
  assert.equal(rebuild.tags.includes("no-ui"), false);
  assert.ok(rebuild.accept.some((a) => /same content and work the same as in the sweep's baseline/.test(a)));

  // Tier A: one step, with a measured improvement for performance and a logged behaviour change for a bug.
  const perf = byFinding(confirmed.find((f) => f.category === "performance").id);
  assert.equal(perf.length, 1);
  assert.ok(perf[0].accept.some((a) => /improves by more than the noise/.test(a)));
  const bug = byFinding(confirmed.find((f) => f.category === "bug").id);
  assert.ok(bug[0].accept.some((a) => /Owner review: yes/.test(a)));
  assert.ok(bug[0].accept.some((a) => /regression test .* fails on the code from before this step/.test(a)));
  const unused = byFinding(confirmed.find((f) => f.category === "unused-code").id);
  assert.match(unused[0].title, /formatDate and its todo note/, "an uppercase TODO would fail lint");

  // Tier C: not a step, listed for the owner.
  const major = confirmed.find((f) => f.tier === "C").id;
  assert.deepEqual(r.ownerItems, [major]);
  assert.equal(byFinding(major).length, 0);
  assert.match(afterRunSection(r.text), new RegExp(`${major} \\(Upgrade the UI library to its next major\\) is left for your decision`));
  // With no main plan, default constraints and the optimize rules.
  assert.match(r.text, /no "Constraints & decisions" section, so these defaults apply/);
  assert.match(r.text, /are never edited afterwards/);
});

test("an optimize bug of tier B (the scanner's floor for bugs) is one step with a regression test, never pinned first", () => {
  const confirmed = numberFindings([
    { category: "bug", title: "Saving twice loses the second edit", severity: "high", file: "src/notes/save.js", tier: "B", autoFixSafe: false }
  ].map((f) => normalizeFinding(f, { kind: "optimize" })), "optimize");
  const r = generateFixPlan({ kind: "optimize", confirmed, mainPlanText: "", reportRel: ".autoclaude/sweeps/x-optimize/report.md", date: "2026-10-02" });
  assert.deepEqual(r.problems, [], r.text);
  const parsed = parsePlan(r.text);
  assert.equal(parsed.steps.length, 1, "pinning would pin the bug");
  assert.doesNotMatch(r.text, /Pin the current behaviour/);
  assert.ok(parsed.steps[0].accept.some((a) => /fails on the code from before this step/.test(a)));
  assert.ok(parsed.steps[0].accept.some((a) => /Owner review: yes/.test(a)), "listed in the hand-back as a behaviour change");
});

test("copyConstraints: the whole section, fences respected, steps and phase headings defused, template placeholders dropped", () => {
  assert.equal(copyConstraints("# P\n\n## Goal\n\nx\n"), "");
  const text = copyConstraints(MAIN_PLAN);
  assert.match(text, /^### Security\n\nNo login/);
  assert.match(text, /```markdown\n## Not a heading inside a fence\n```/);
  assert.match(text, /SQLite in data\/todos\.db\.$/);
  const tricky = copyConstraints([
    "## Constraints & decisions", "", "### Phase 3: kept as text", "- [x] **P2.1** an old step mentioned here", "  - Accept: old", "", "## Next section", "- [ ] **S1.1** real step"
  ].join("\n"));
  assert.match(tricky, /^\*\*Phase 3: kept as text\*\*\n- P2\.1: an old step mentioned here/);
  assert.equal(tricky.includes("real step"), false);
  const fromTemplate = copyConstraints(TEMPLATE);
  for (const ph of ["Not written yet.", "Nothing decided yet."]) assert.equal(fromTemplate.includes(ph), false);
  assert.equal(/### Data\n\n### /.test(fromTemplate), false, "a subsection left empty loses its heading");
  assert.match(fromTemplate, /### When something is unclear/);
  // The template's own sections still make a plan that lints clean.
  const r = generateFixPlan({ kind: "security", confirmed: securityFindings().slice(0, 1), mainPlanText: TEMPLATE, reportRel: REPORT, date: "2026-10-02" });
  assert.deepEqual(r.problems, []);
});

test("generateFixPlan: ids are given when missing, nothing to fix gives no steps, an unknown kind throws", () => {
  const bare = [{ category: "xss", severity: "high", file: "src/view.js", autoFixSafe: true }, { category: "csrf", severity: "low", file: "src/form.js", autoFixSafe: true }];
  const r = generateFixPlan({ kind: "security", confirmed: bare, reportRel: REPORT, date: "2026-10-02" });
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.phases.flatMap((p) => p.findings), ["SEC-001", "SEC-002"]);
  const none = generateFixPlan({ kind: "security", confirmed: [{ id: "SEC-001", category: "x", severity: "high", file: "a.js", autoFixSafe: false }], reportRel: REPORT, date: "2026-10-02" });
  assert.equal(none.stepCount, 0);
  assert.deepEqual(none.ownerItems, ["SEC-001"]);
  assert.ok(none.problems.some((p) => /no steps found/.test(p.message)), "an empty plan is never run");
  assert.throws(() => generateFixPlan({ kind: "speed", confirmed: [] }), /unknown kind/);
  assert.deepEqual(FIX_PLAN_FILES, { security: "SECURITY_PLAN.md", optimize: "OPTIMIZE_PLAN.md" });
  assert.equal(fixPlanTitle("optimize", "2026-10-02"), "Optimization 2026-10-02");
  // Python projects get Python test names.
  const py = generateFixPlan({ kind: "security", confirmed: [{ id: "SEC-001", category: "x", severity: "high", file: "app/views.py", autoFixSafe: true }], reportRel: REPORT, date: "2026-10-02", testDir: "tests" });
  assert.match(py.text, /Test: tests\/test_sec_001\.py/);
});

test("needsOwner: a security finding marked unsafe to fix, an optimize finding of tier C or of no known tier", () => {
  assert.equal(needsOwner({ autoFixSafe: true }, "security"), false);
  assert.equal(needsOwner({ autoFixSafe: false }, "security"), true);
  assert.equal(needsOwner({ autoFixSafe: true, tier: "A" }, "optimize"), false);
  assert.equal(needsOwner({ autoFixSafe: true, tier: "b" }, "optimize"), false);
  assert.equal(needsOwner({ autoFixSafe: true, tier: "C" }, "optimize"), true);
  assert.equal(needsOwner({ autoFixSafe: true }, "optimize"), true);
  // For optimize the tier decides: tier B is never autoFixSafe (scan-optimize) and is still fixed
  // behind pinned tests; a tier A stale TODO the builder must judge is still the run's.
  assert.equal(needsOwner({ autoFixSafe: false, tier: "B" }, "optimize"), false);
  assert.equal(needsOwner({ autoFixSafe: false, tier: "A" }, "optimize"), false);
  assert.equal(needsOwner({ autoFixSafe: false, tier: "C" }, "optimize"), true);
});

test("step ids never collide with the project's own plan or PROGRESS.md; a stamp makes the title and branch unique", () => {
  assert.deepEqual(STEP_PREFIX, { security: "SF", optimize: "OF" }, "not the template's S");
  const one = securityFindings().slice(0, 1);
  const plain = generateFixPlan({ kind: "security", confirmed: one, mainPlanText: MAIN_PLAN, reportRel: REPORT, date: "2026-10-02" });
  assert.deepEqual(parsePlan(plain.text).steps.map((s) => s.id), ["SF1.1"], "the project's own S1.1 is never reused");
  // A project whose own plan uses SF, and a PROGRESS.md that already records an earlier fix run.
  const ownSf = MAIN_PLAN.replace("**S1.1**", "**SF1.1**");
  const progress = "# Progress\n\n- 2026-09-30 S1.1 Add a todo (attempt 1)\n- 2026-10-01 SFB1.1 Resolve finding SEC-001 in `src/a.js` (attempt 1)\n";
  assert.equal(stepPrefix("security", [1], { mainPlanText: ownSf }), "SFB");
  assert.equal(stepPrefix("security", [1], { progressText: progress }), "SF", "SF1.1 is not in PROGRESS.md");
  assert.equal(stepPrefix("security", [1], { mainPlanText: ownSf, progressText: progress }), "SFC");
  assert.equal(stepPrefix("optimize", [2, 1], { progressText: "- OF2.1 x" }), "OFB", "every id the plan would write is checked");
  const r = generateFixPlan({ kind: "security", confirmed: one, mainPlanText: ownSf, progressText: progress, reportRel: REPORT, date: "2026-10-02" });
  assert.deepEqual(r.problems, [], r.text);
  const ids = parsePlan(r.text).steps.map((s) => s.id);
  assert.deepEqual(ids, ["SFC1.1"]);
  for (const id of ids) assert.equal(new RegExp(`\\b${id}\\b`).test(progress + ownSf), false, id);
  // The stamp: one sweep, one title, one branch.
  assert.equal(fixPlanTitle("security", "2026-10-02", "1430"), "Security fixes 2026-10-02 1430");
  const stamped = generateFixPlan({ kind: "security", confirmed: one, reportRel: REPORT, date: "2026-10-02", stamp: "1430" });
  assert.equal(planSlug(parsePlan(stamped.text)), "security-fixes-2026-10-02-1430");
  assert.equal(planSlug(parsePlan(plain.text)), "security-fixes-2026-10-02", "no stamp: the title as before");
});

test("a pinned change step is known by its tag or by its shape", () => {
  const plan = parsePlan([
    "# P", "", "## Phase 1: A",
    "- [ ] **OF1.1** Pin", "  - Accept: a", `  - Test: ${CHARACTERIZATION_DIR}/opt-001.test.js`,
    "- [ ] **OF1.2** Change", "  - Accept: b", `  - Test: ./${CHARACTERIZATION_DIR}/opt-001.test.js`, "  - Depends: OF1.1",
    "- [ ] **OF1.3** Other", "  - Accept: c", "  - Test: test/other.test.js", "  - Depends: OF1.1",
    ""
  ].join("\n"));
  assert.deepEqual(plan.steps.map(isPinnedStep), [false, true, false]);
  assert.equal(isPinnedStep({ tags: [PINNED_TAG], depends: [], test: [] }), true);
  assert.equal(isPinnedStep(null), false);
});

test("fix right away, fed with real scanner and probe output: code-level fixes become steps, what needs the owner does not", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fixplan-real-"));
  fs.writeFileSync(path.join(root, "config.js"), `const key = "${"AKIA" + "IOSFODNN7EXAMPLE"}";\n`);
  const mark = (t) => t;
  const audit = JSON.stringify({ vulnerabilities: {
    lodash: { severity: "high", range: "<4.17.21", fixAvailable: { name: "lodash", version: "4.17.21", isSemVerMajor: false }, via: [{ title: "Prototype pollution" }] },
    express: { severity: "critical", range: "<5.0.0", fixAvailable: { name: "express", version: "5.0.0", isSemVerMajor: true }, via: [{ title: "x" }] }
  } });
  const res = { headers: { get: (n) => (n === "set-cookie" ? "s=1; Path=/" : n === "access-control-allow-origin" ? "*" : n === "access-control-allow-credentials" ? "true" : null), getSetCookie: () => ["s=1; Path=/"] } };
  const raw = [
    ...parseNpmAudit(audit, mark).candidates,
    ...scanTree({ root, files: ["config.js"], redact: mark }).candidates,
    ...scanHistoryText(["@@C abc1234", "+++ b/old.js", `+const key = "${"AKIA" + "IOSFODNN7EXAMPLE"}";`].join("\n"), mark).candidates,
    ...checkSecurityHeaders(res, "http://127.0.0.1:4173/", false, mark),
    ...checkCookies(res, "http://127.0.0.1:4173/", false, mark),
    ...checkCors(res, "http://127.0.0.1:4173/", "https://evil.test", mark)
  ];
  const confirmed = numberFindings(dedupe(raw, { kind: "security", root }), "security");
  const r = generateFixPlan({ kind: "security", confirmed, mainPlanText: MAIN_PLAN, reportRel: REPORT, date: "2026-10-02" });
  assert.deepEqual(r.problems, [], r.text);
  const id = (pred) => confirmed.find(pred).id;
  const lodash = id((f) => /lodash/.test(f.evidence));
  const express = id((f) => /express/.test(f.evidence));
  const treeKey = id((f) => f.file === "config.js");
  const history = id((f) => /history/.test(f.evidence));
  assert.match(r.text, new RegExp(`Update the dependency named in finding ${lodash}`), "the dependency step template is used for a real advisory");
  assert.deepEqual(r.ownerItems.sort(), [express, history].sort(), "a major upgrade and a secret in the history are the owner's");
  assert.match(r.text, new RegExp(`Resolve finding ${treeKey} in \`config\\.js\``), "the key is moved out of the code by the run");
  assert.match(afterRunSection(r.text), new RegExp(`${treeKey} is fixed by this plan and also needs something only you can do`), "and the owner rotates it");
  for (const f of confirmed.filter((x) => ["headers", "cookies", "cors"].includes(x.category))) assert.match(r.text, new RegExp(`Resolve finding ${f.id} in`), f.category);
  assert.equal(r.text.includes("IOSFODNN7EXAMPLE"), false);
});

test("the run-plan override is reachable from fixplan.js", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fixplan-"));
  assert.equal(runPlanOverride(root), null);
  assert.equal(setRunPlan(root, "SECURITY_PLAN.md"), "SECURITY_PLAN.md");
  assert.equal(runPlanOverride(root), "SECURITY_PLAN.md");
  assert.equal(clearRunPlan(root), true);
  assert.equal(runPlanOverride(root), null);
});
