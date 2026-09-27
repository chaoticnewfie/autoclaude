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

// Every gate scenario reads usage from its own empty Claude config dir, never the machine's.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-gate-cfg-"));

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
// No real checker ever runs in these scenarios: tests that need one inject a fake.
const deps = { env, notify: async (msg) => { sent.push(msg); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null };
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
  const runTester = async ({ kind, step }) => {
    calls.push(`${kind}:${step.id}`);
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

test("security review passing with low findings files them in SECURITY-FINDINGS.md inside the step commit", async () => {
  const root = scratch("broken", PASS);
  const { runSecurity } = fakeSecurity([secLow]);
  writeReady(root, "S1.1");
  const r = await gate(root, { runSecurity });
  assert.equal(r.decision, "allow");
  assert.equal(loadState(root).status, "complete");
  const text = fs.readFileSync(path.join(root, "docs", "SECURITY-FINDINGS.md"), "utf8");
  assert.match(text, /\| \d{4}-\d\d-\d\d \| low \| server\.js:3 \| no rate limit on POST \/api\/todos \(found at S1\.1\) \| add a simple limiter \| open \|/);
  const files = spawnSync("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: root, encoding: "utf8", env }).stdout;
  assert.match(files, /docs\/SECURITY-FINDINGS\.md/);
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
