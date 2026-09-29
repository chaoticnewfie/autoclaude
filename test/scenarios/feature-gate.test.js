// Adversarial scenarios for the per-feature gate (gate.verifyAt "phase", D49): restarts in the
// middle of a feature, owner edits between runs, fix-up passes that keep failing, pushes that
// hang or are rejected, and the run state after each path. The gate runs through lib/gate.js
// with fake checkers on a scratch copy of the fixture; nothing here touches this machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { resumeRun } from "../../plugins/autoclaude/lib/resume.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { writeReady } from "../../plugins/autoclaude/lib/protocol.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";

process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-cfg-"));

const node = JSON.stringify(process.execPath);
const env = gitEnv({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ""}` });
const COUNT = { name: "unit", command: `${node} -e "require('fs').appendFileSync('.autoclaude/check-runs','x')"`, timeoutSec: 60 };
const FAIL = [{ name: "unit", command: `${node} -e "console.log('boom'); process.exit(1)"`, timeoutSec: 60 }];

const FEATURES = "# Features plan\n\n## Phase 1: Lists\n- [ ] **S1.1** One\n  - Accept: the page shows one\n  - Tags: ui\n- [ ] **S1.2** Two\n  - Accept: the page shows two\n  - Tags: ui\n- [ ] **S1.3** Three\n  - Accept: the store counts three\n  - Test: test/todos.test.js\n  - Tags: no-ui\n\n## Phase 2: More\n- [ ] **S2.1** Four\n  - Accept: the page shows four\n  - Tags: ui\n- [ ] **S2.2** Five\n  - Accept: the page shows five\n  - Tags: ui\n\n## Phase 3: Store\n- [ ] **S3.1** Six\n  - Accept: the store keeps six\n  - Test: test/todos.test.js\n  - Tags: no-ui\n";
const NO_UI = "# Backend plan\n\n## Phase 1: Store\n- [ ] **S1.1** Save\n  - Accept: the store saves\n  - Test: test/todos.test.js\n  - Tags: no-ui\n- [ ] **S1.2** Load\n  - Accept: the store loads\n  - Test: test/todos.test.js\n  - Tags: no-ui\n\n## Phase 2: Export\n- [ ] **S2.1** Export\n  - Accept: the store exports JSON\n  - Test: test/todos.test.js\n  - Tags: no-ui\n";

const sent = [];
const deps = { env, notify: async (msg) => { sent.push(msg); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null, noteFootprint: null, finishFootprint: null, writeHandoff: null };
// A pid no live process has: a gate that ran as it was killed with its session.
const DEAD_PID = 2 ** 30;
const gate = (root, extra = {}) => runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, { ...deps, root, ...extra });
const git = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8", env });
const gitLog = (root) => git(root, "log", "--format=%s").stdout.trim().split("\n");
const gitTags = (root) => git(root, "tag").stdout.trim().split(/\r?\n/).filter(Boolean);
const rev = (cwd, ref) => git(cwd, "rev-parse", "--verify", "-q", ref).stdout.trim();
const treeClean = (root) => git(root, "status", "--porcelain").stdout.trim() === "";
const markers = (root) => parsePlan(fs.readFileSync(path.join(root, "PLAN.md"), "utf8")).steps.map((s) => s.marker).join("");
const progressText = (root) => fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8");
const count = (text, needle) => text.split(needle).length - 1;
const tick = () => new Promise((r) => setImmediate(r));

function scratch({ plan = FEATURES, checks = [COUNT], cfg = {} } = {}) {
  const dest = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-"));
  prepareFixture({ dest, plan: "happy", git: true, checks, devServer: { command: "npm run dev", url: "http://127.0.0.1:4173", healthPath: "/health", startTimeoutSec: 10 }, env });
  fs.writeFileSync(path.join(dest, "PLAN.md"), plan);
  const cfgFile = path.join(dest, "autoclaude.config.json");
  const base = JSON.parse(fs.readFileSync(cfgFile, "utf8"));
  fs.writeFileSync(cfgFile, JSON.stringify({ ...base, gate: { verifyAt: "phase" }, ...cfg }, null, 2) + "\n");
  git(dest, "commit", "-qam", "fixture: features plan");
  saveState(dest, { ...defaultState(), status: "running", currentStep: "S1.1", tickedByGate: [], startedAt: new Date().toISOString() });
  return dest;
}

function editConfig(root, change) {
  const cfgFile = path.join(root, "autoclaude.config.json");
  const next = change(JSON.parse(fs.readFileSync(cfgFile, "utf8")));
  fs.writeFileSync(cfgFile, JSON.stringify(next, null, 2) + "\n");
}

function project(root) {
  return { root, config: mergeConfig(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"))) };
}

function editPlan(root, from, to) {
  const file = path.join(root, "PLAN.md");
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.includes(from), `the plan has ${from}`);
  fs.writeFileSync(file, text.replace(from, to));
}

function fakeBrowser(byKind = {}) {
  const calls = [];
  const runTester = async ({ kind, step, steps }) => {
    calls.push(`${kind}:${step.id}${steps ? `[${steps.map((s) => s.id).join(",")}]` : ""}`);
    const r = typeof byKind[kind] === "function" ? byKind[kind](calls.length) : byKind[kind];
    return r || { status: "passed", sections: [{ title: `${kind}: passed`, body: "ok" }], followUps: [] };
  };
  return { calls, deps: { runTester, restartDevServer: async () => ({ ok: true, reused: false }) } };
}

async function ready(root, id, d) {
  writeReady(root, id);
  return gate(root, d);
}

async function build(root, ids, d) {
  for (const id of ids) {
    const r = await ready(root, id, d);
    assert.match(r.reason || "", new RegExp(`^${id.replace(".", "\\.")} built and committed`), JSON.stringify(r.events));
  }
}

const withFollowUp = { status: "passed", sections: [{ title: "Browser tester: passed", body: "ok" }], followUps: [{ severity: "medium", title: "the two is hard to read", actual: "grey on grey", repro: "open /", expected: "contrast", foundBy: "tester" }] };

// A checker that never returns: the gate stops there, the way a gate killed mid-verification
// (by `pause --now` through the supervisor, or by the hook's timeout) leaves things. `pid` is
// the process its snapshot names: a dead one for a gate that was killed.
function hangingAt(kind, pid = DEAD_PID) {
  let reached;
  const at = new Promise((r) => { reached = r; });
  const { deps: b } = fakeBrowser({});
  const runTester = async (a) => { if (a.kind === kind) { reached(); return new Promise(() => {}); } return b.runTester(a); };
  return { at, deps: { ...b, runTester, pid } };
}

// The builder's side of a fix-up pass: every open findings row gets an outcome.
function settleFindings(root, status = "fixed") {
  for (const rel of ["docs/BLOCKERS.md", "docs/SECURITY-FINDINGS.md"]) {
    const file = path.join(root, rel);
    if (fs.existsSync(file)) fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace(/\| open \|$/gm, `| ${status} |`));
  }
}

test("pause --now in the middle of a feature's verification: resume takes the cut-off ticks and PROGRESS lines out, keeps the owner's own edits, and the feature is verified again", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  const progressBefore = progressText(root);
  const hang = hangingAt("tester");
  writeReady(root, "S1.3");
  gate(root, hang.deps);
  await hang.at;
  assert.equal(markers(root), "xxx   ", "the verification wrote its ticks before the checkers ran");
  // The owner's `pause --now`; the supervisor ends the session and the gate with it.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true });
  const changes = resumeRun(project(root), loadState(root));
  assert.equal(changes.some((c) => /ticked by the owner/.test(c)), false, changes.join("\n"));
  assert.ok(changes.some((c) => /verification of S1\.3 was cut off/.test(c)), changes.join("\n"));
  assert.equal(markers(root), "~~    ");
  assert.equal(progressText(root), progressBefore);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")), false);
  let s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.tickedByGate, s.haltSession], ["running", "S1.3", ["S1.1", "S1.2"], false]);
  const r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(markers(root), "xxx   ");
  const progress = progressText(root);
  for (const line of ["S1.1 One (attempt 1)", "S1.2 Two (attempt 1)", "S1.3 Three (attempt 1)"]) assert.equal(count(progress, line), 1, line);
  assert.ok(treeClean(root));

  // During the pause the owner unticks S1.2, which the cut-off verification had shown as [x]:
  // only the gate's own ticks come out, so S1.2 stays [ ] and is done again.
  const root2 = scratch();
  await build(root2, ["S1.1", "S1.2"], b);
  const hang2 = hangingAt("tester");
  writeReady(root2, "S1.3");
  gate(root2, hang2.deps);
  await hang2.at;
  saveState(root2, { ...loadState(root2), status: "paused", pauseReason: "review", haltSession: true });
  editPlan(root2, "- [x] **S1.2**", "- [ ] **S1.2**");
  resumeRun(project(root2), loadState(root2));
  assert.equal(markers(root2), "~     ");
  s = loadState(root2);
  assert.deepEqual([s.currentStep, s.tickedByGate], ["S1.2", ["S1.1"]]);
});

test("a verification cut off while a live gate still holds gate.json is left to that gate", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  const hang = hangingAt("tester");
  writeReady(root, "S1.3");
  gate(root, hang.deps);
  await hang.at;
  // `pause --now` then `resume` before the supervisor's next poll: the gate is still at work.
  fs.writeFileSync(path.join(root, ".autoclaude", "gate.json"), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true });
  resumeRun(project(root), loadState(root));
  assert.equal(markers(root), "xxx   ", "the live gate's ticks are not touched");
  assert.ok(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")));
});

test("a gate cut off after its commit (the hook's timeout during a slow push) leaves a state the next stop carries on from, with the tag queued for the next push", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  let reached;
  const at = new Promise((r) => { reached = r; });
  const hungPush = async () => { reached(); return new Promise(() => {}); };
  writeReady(root, "S1.3");
  gate(root, { ...b, pushRun: hungPush });
  await at;
  assert.equal(gitLog(root)[0], "autoclaude(S1.3): Three", "committed before the push");
  let s = loadState(root);
  assert.deepEqual([s.tickedByGate, s.fixup, s.attempts["S1.3"] || 0, s.phaseBaseCommit, s.headAtLastGate], [["S1.1", "S1.2", "S1.3"], null, 0, null, rev(root, "HEAD")]);
  assert.deepEqual(s.pushState && s.pushState.unpushedTags, ["ac-phase-1"]);
  // The hook was killed; the builder's next stop.
  const r = await gate(root, b);
  assert.equal(r.events.some((e) => e.type === "integrity-reverted"), false, JSON.stringify(r.events));
  assert.match(r.reason, /^Continue S2\.1/);
  assert.equal(markers(root), "xxx   ");
  assert.ok(treeClean(root));
  // The next feature pushes the tag it could not push then.
  const pushes = [];
  const okPush = async (_root, opts) => { pushes.push(opts.tags); return { ok: true, skipped: false, remote: "origin", branch: "main", unpushedCommits: 0, unpushedTags: [] }; };
  await build(root, ["S2.1"], { ...b, pushRun: okPush });
  const r2 = await ready(root, "S2.2", { ...b, pushRun: okPush });
  assert.match(r2.reason, /^Phase 2 \(More\) verified and committed/);
  assert.deepEqual(pushes, [["ac-phase-1", "ac-phase-2"]]);
  s = loadState(root);
  assert.deepEqual([s.pushState.ok, s.pushState.unpushedTags], [true, []]);
});

test("the push's git timeout is bounded by what is left of the gate's time", async () => {
  const seen = [];
  const push = async (_root, opts) => { seen.push(opts.timeoutMs); return { ok: true, skipped: false, remote: "origin", branch: "main", unpushedCommits: 0, unpushedTags: [] }; };
  const { deps: b } = fakeBrowser({});
  let root = scratch({ plan: NO_UI });
  await build(root, ["S1.1"], b);
  await ready(root, "S1.2", { ...b, pushRun: push });
  assert.equal(seen[0], 120000, "plenty of time: git's usual two minutes");
  root = scratch({ plan: NO_UI, cfg: { gate: { verifyAt: "phase", timeoutSec: 60 } } });
  await build(root, ["S1.1"], b);
  await ready(root, "S1.2", { ...b, pushRun: push });
  assert.ok(seen[1] >= 5000 && seen[1] <= 12500, `a short gate budget gives a short push timeout, got ${seen[1]}`);
});

test("the owner ticks the step that would have closed a feature: resume reopens its last built step, so the feature is still verified, and a plan never completes with a built step", async () => {
  const root = scratch();
  const { calls, deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  editPlan(root, "- [ ] **S1.3**", "- [x] **S1.3**");
  const changes = resumeRun(project(root), loadState(root));
  assert.ok(changes.some((c) => /S1\.2: reopened/.test(c)), changes.join("\n"));
  assert.equal(markers(root), "~ x   ");
  let s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate], ["S1.2", ["S1.1", "S1.3"]]);
  const r = await ready(root, "S1.2", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.deepEqual(calls, ["tester:S1.2[S1.1,S1.2]", "bugbash:S1.2"]);
  assert.equal(markers(root), "xxx   ");
  assert.ok(treeClean(root));

  // The safety net: a plan that reaches its end with a stranded built step (here from a start
  // that skipped it) reopens it instead of completing.
  const root2 = scratch({ plan: NO_UI });
  editPlan(root2, "- [ ] **S1.1**", "- [~] **S1.1**");
  editPlan(root2, "- [ ] **S1.2**", "- [x] **S1.2**");
  git(root2, "commit", "-qam", "an earlier run built S1.1; the owner ticked S1.2");
  saveState(root2, { ...loadState(root2), currentStep: "S2.1", tickedByGate: ["S1.1", "S1.2"] });
  const r2 = await ready(root2, "S2.1", b);
  assert.equal(r2.decision, "block", JSON.stringify(r2.events));
  assert.match(r2.reason, /S1\.1 was built but Phase 1 \(Store\) was never verified/);
  assert.match(r2.reason, /ready S1\.1/);
  assert.equal(markers(root2), " xx");
  s = loadState(root2);
  assert.deepEqual([s.status, s.currentStep, s.tickedByGate.includes("S1.1")], ["running", "S1.1", false]);
  const r3 = await ready(root2, "S1.1", b);
  assert.equal(r3.decision, "allow", JSON.stringify(r3.events));
  assert.equal(loadState(root2).status, "complete");
  assert.equal(markers(root2), "xxx");
});

test("verifyAt switched to step while paused: resume reopens the built steps, and each is verified on its own ready", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1"], b);
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  editConfig(root, (c) => ({ ...c, gate: { verifyAt: "step" } }));
  const changes = resumeRun(project(root), loadState(root));
  assert.ok(changes.some((c) => /S1\.1: reopened/.test(c)), changes.join("\n"));
  assert.equal(markers(root), "      ");
  assert.equal(loadState(root).currentStep, "S1.1");
  const r = await ready(root, "S1.1", b);
  assert.match(r.reason, /^S1\.1 verified and committed/, JSON.stringify(r.events));
  assert.equal(markers(root), "x     ");
});

test("a checker that cannot run keeps an owner pause made while it ran", async () => {
  const root = scratch();
  const infra = { status: "infra", failed: "Browser tester could not run (2 tries): timed out", sections: [{ title: "Browser tester: could not run", body: "x" }], followUps: [] };
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  const { deps: pausing } = fakeBrowser({ tester: () => { saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", haltSession: true }); return infra; } });
  const r = await ready(root, "S1.3", pausing);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.haltSession, s.infraFailures["S1.3"], s.attempts["S1.3"] || 0], ["paused", "review", true, 1, 0]);
  assert.equal(markers(root), "~~    ", "the ticks came out again");
  assert.ok(treeClean(root));
});

test("a fresh-session request with no live supervisor to act on it is dropped, and the session carries on", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), freshSession: true });
  const r = await gate(root);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "fresh-session-dropped"));
  assert.match(r.reason, /^Continue S1\.1/);
  assert.equal(loadState(root).freshSession, false);
});

test("step mode: the feature alert at a phase end counts the phase's steps", async () => {
  const root = scratch({ plan: NO_UI, cfg: { gate: { verifyAt: "step" } } });
  await ready(root, "S1.1");
  const before = sent.length;
  const r = await ready(root, "S1.2");
  assert.match(r.reason, /^S1\.2 verified and committed/);
  const alert = sent.slice(before).find((m) => /Phase 1 verified/.test(m.title));
  assert.ok(alert);
  assert.match(alert.message, /^Phase 1 Store: 2 steps verified/);
});

test("phaseBaseCommit: a feature re-verified out of order does not cut short the diff of the feature still being built; resume drops a stale one", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  const bases = [];
  const runSecurity = async ({ step, state }) => { bases.push([step.id, state.phaseBaseCommit]); return { status: "passed", sections: [], findings: [] }; };
  const d = { ...b, runSecurity };
  const b1 = rev(root, "HEAD");
  await build(root, ["S1.1", "S1.2"], d);
  await ready(root, "S1.3", d);
  const b2 = rev(root, "HEAD");
  await build(root, ["S2.1"], d);
  assert.equal(loadState(root).phaseBaseCommit, b2);
  // The owner reopens S1.1 of the verified Phase 1 while Phase 2 is half built.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  editPlan(root, "- [x] **S1.1**", "- [ ] **S1.1**");
  resumeRun(project(root), loadState(root));
  assert.deepEqual([loadState(root).currentStep, loadState(root).phaseBaseCommit], ["S1.1", b2]);
  const r = await ready(root, "S1.1", d);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(loadState(root).phaseBaseCommit, b2, "S2.1 is still built, so its feature keeps its base");
  const r2 = await ready(root, "S2.2", d);
  assert.match(r2.reason, /^Phase 2 \(More\) verified and committed/, JSON.stringify(r2.events));
  assert.deepEqual(bases, [["S1.3", b1], ["S1.1", b2], ["S2.2", b2]], "Phase 2's review covers S2.1");
  assert.equal(loadState(root).phaseBaseCommit, null);

  // A base left behind with nothing built (a gate killed at the wrong moment) is dropped on resume.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review", phaseBaseCommit: b1, phaseStartedAt: "2026-09-28T00:00:00.000Z" });
  resumeRun(project(root), loadState(root));
  assert.deepEqual([loadState(root).phaseBaseCommit, loadState(root).phaseStartedAt], [null, null]);
});

test("a fix-up pass whose checks fail three times pauses in the pass; resume carries on in it and the feature then closes", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({ tester: withFollowUp });
  await build(root, ["S1.1", "S1.2"], b);
  let r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding/);
  settleFindings(root);
  const head = rev(root, "HEAD");
  editConfig(root, (c) => ({ ...c, checks: FAIL }));
  for (let n = 1; n <= 2; n++) {
    r = await ready(root, "S1.3", b);
    assert.match(r.reason, new RegExp(`^The fix-up checks of Phase 1 \\(attempt ${n}/3\\) failed`));
  }
  r = await ready(root, "S1.3", b);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.fixup && s.fixup.stepId, s.attempts["S1.3"], s.currentStep], ["paused", "step-failed", "S1.3", 3, "S1.3"]);
  assert.equal(markers(root), "xxx   ", "the feature passed; its ticks stay, uncommitted");
  assert.equal(rev(root, "HEAD"), head, "nothing committed");
  assert.match(sent.at(-1).title, /fix-up checks of Phase 1 failed 3 times/);
  editConfig(root, (c) => ({ ...c, checks: [COUNT] }));
  const changes = resumeRun(project(root), loadState(root));
  assert.ok(changes.some((c) => /resuming the fix-up pass of S1\.3/.test(c)), changes.join("\n"));
  s = loadState(root);
  assert.deepEqual([s.status, s.attempts["S1.3"], s.fixup && s.fixup.stepId], ["running", 0, "S1.3"]);
  r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.deepEqual(gitTags(root), ["ac-phase-1"]);
  s = loadState(root);
  assert.deepEqual([s.fixup, s.currentStep, s.attempts["S1.3"]], [null, "S2.1", 0]);
  assert.ok(treeClean(root));
});

test("a plan of no-ui features: no browser check, the security review gets the whole phase, a one-step last phase completes with the hand-back and the footprint", async () => {
  const root = scratch({ plan: NO_UI });
  const { calls, deps: b } = fakeBrowser({});
  const reviews = [];
  const runSecurity = async ({ step, steps }) => { reviews.push(`${step.id}[${(steps || []).map((s) => s.id).join(",")}]`); return { status: "passed", sections: [], findings: [] }; };
  const done = [];
  const finishFootprint = async (_root, opts) => { done.push(["footprint", opts.remove]); return { removed: [], kept: [], runningCreated: [], secretsCreated: [], errors: [] }; };
  const writeHandoff = async (a) => { done.push(["handoff", a.state.status]); const file = path.join(a.root, "HANDOFF.md"); fs.writeFileSync(file, "# Hand-back\n"); return { path: file, summary: { built: 3, ownerItems: [], secretsCreated: [], openFindings: 0, ownerReviewDecisions: [], runDecisions: 0, push: null, footprint: null } }; };
  const d = { ...b, runSecurity, finishFootprint, writeHandoff };
  const sentBefore = sent.length;
  await build(root, ["S1.1"], d);
  let r = await ready(root, "S1.2", d);
  assert.match(r.reason, /^Phase 1 \(Store\) verified and committed/, JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "tester-skipped"));
  r = await ready(root, "S2.1", d);
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.deepEqual(calls, [], "no browser check for no-ui steps");
  assert.deepEqual(reviews, ["S1.2[S1.1,S1.2]", "S2.1[S2.1]"]);
  assert.deepEqual(done, [["footprint", true], ["handoff", "complete"]]);
  const s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.fixup, s.freshSession, s.phaseBaseCommit, s.phaseStartedAt], ["complete", null, null, false, null, null]);
  assert.deepEqual([s.pushState.ok, s.pushState.skipped, s.pushState.error], [false, true, "no git remote is configured"], "no remote: skipped, never failed");
  assert.equal(sent.slice(sentBefore).some((m) => /push failed/.test(m.title)), false);
  assert.equal(markers(root), "xxx");
  assert.deepEqual(gitTags(root), ["ac-phase-1", "ac-phase-2"]);
  assert.deepEqual(gitLog(root).slice(0, 4), ["autoclaude: hand-back", "autoclaude(S2.1): Export", "autoclaude(S1.2): Load", "autoclaude(S1.1): Save"]);
  assert.equal(rev(root, "ac-phase-2"), rev(root, "HEAD~1"));
  assert.ok(treeClean(root));
  assert.match(sent.at(-1).title, /plan complete/);
});

test("a push the remote rejects is alerted, the run goes on, and the next feature tries again with both tags", async () => {
  const root = scratch();
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-remote-")), "origin.git");
  git(os.tmpdir(), "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  git(root, "push", "-q", "origin", "main");
  // Someone else pushes to the same branch: the run's push is no longer a fast-forward.
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-other-"));
  git(os.tmpdir(), "clone", "-q", bare, other);
  fs.writeFileSync(path.join(other, "theirs.txt"), "theirs\n");
  git(other, "add", "-A");
  git(other, "-c", "user.name=Other", "-c", "user.email=other@localhost", "commit", "-qm", "theirs");
  git(other, "push", "-q", "origin", "main");
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  const before = sent.length;
  const r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.pushState.ok, s.pushState.skipped, s.pushState.remote, s.pushState.unpushedTags, s.currentStep], [false, false, "origin", ["ac-phase-1"], "S2.1"]);
  assert.ok(s.pushState.unpushedCommits >= 1);
  assert.ok(s.pushState.error);
  const mine = sent.slice(before);
  assert.ok(mine.some((m) => /push failed/.test(m.title) && m.priority === "default"));
  assert.match(mine.find((m) => /Phase 1 verified/.test(m.title)).message, /Push FAILED/);
  await build(root, ["S2.1"], b);
  await ready(root, "S2.2", b);
  s = loadState(root);
  assert.deepEqual([s.pushState.ok, s.pushState.unpushedTags], [false, ["ac-phase-1", "ac-phase-2"]]);
  assert.equal(rev(bare, "refs/tags/ac-phase-1"), "", "a tag never reaches the remote without its commits");
});

test("a phase verified again keeps the tag of its first verification, so the pushes after it never fail on that tag", async () => {
  const root = scratch();
  saveState(root, { ...loadState(root), baseCommit: rev(root, "HEAD") });
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-remote-")), "origin.git");
  git(os.tmpdir(), "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1", "S1.2"], b);
  await ready(root, "S1.3", b);
  const first = rev(root, "ac-phase-1");
  assert.equal(rev(bare, "refs/tags/ac-phase-1"), first);
  assert.equal(loadState(root).pushState.ok, true);
  // The owner reopens S1.2 of the pushed Phase 1.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  editPlan(root, "- [x] **S1.2**", "- [ ] **S1.2**");
  resumeRun(project(root), loadState(root));
  const r = await ready(root, "S1.2", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  const s = loadState(root);
  assert.deepEqual([s.pushState.ok, s.pushState.error, s.pushState.unpushedTags], [true, null, []]);
  assert.equal(rev(root, "ac-phase-1"), first);
  assert.equal(rev(bare, "refs/heads/main"), rev(root, "HEAD"));
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /ac-phase-1 already marks an earlier verification of Phase 1; left where it is/);
});

test("the owner unticks a built step between runs: it is built again and verified with its feature, with one PROGRESS line per verified step", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1"], b);
  saveState(root, { ...loadState(root), pauseRequested: true });
  const r0 = await ready(root, "S1.2", b);
  assert.equal(r0.decision, "allow", JSON.stringify(r0.events));
  const base = loadState(root).phaseBaseCommit;
  assert.ok(base);
  editPlan(root, "- [~] **S1.1**", "- [ ] **S1.1**");
  const changes = resumeRun(project(root), loadState(root));
  assert.ok(changes.some((c) => /S1\.1: unticked by the owner/.test(c)), changes.join("\n"));
  let s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate, s.phaseBaseCommit], ["S1.1", ["S1.2"], base]);
  await build(root, ["S1.1"], b);
  assert.equal(loadState(root).currentStep, "S1.3", "the next unfinished step, not S1.2 again");
  const r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  const progress = progressText(root);
  for (const line of ["S1.1 One (attempt 1)", "S1.2 Two (attempt 1)", "S1.3 Three (attempt 1)"]) assert.equal(count(progress, line), 1, line);
  s = loadState(root);
  assert.deepEqual([s.currentStep, [...s.tickedByGate].sort(), s.phaseBaseCommit], ["S2.1", ["S1.1", "S1.2", "S1.3"], null]);
  assert.ok(treeClean(root));
});

test("`autoclaude pause` and `autoclaude note` while a feature is verified are kept: the run pauses after the commit, and the note waits for the builder", async () => {
  const { updateState } = await import("../../plugins/autoclaude/lib/state.js");
  const { deps: b } = fakeBrowser({});
  const owner = (root, text, result = null) => fakeBrowser({ tester: () => { updateState(root, (s) => { s.pauseRequested = true; s.pendingNotes.push({ at: "2026-09-28T01:00:00Z", text }); }); return result; } }).deps;
  const root = scratch();
  await build(root, ["S1.1", "S1.2"], b);
  const r = await ready(root, "S1.3", owner(root, "Use a table"));
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.pauseRequested, s.currentStep], ["paused", "review", false, "S2.1"]);
  assert.deepEqual(s.pendingNotes.map((n) => [n.text, !!n.delivered]), [["Use a table", false]]);
  assert.equal(markers(root), "xxx   ");

  // A failed verification keeps both too: the note reaches the builder later, the pause comes
  // after the next commit.
  const root2 = scratch();
  await build(root2, ["S1.1", "S1.2"], b);
  const fail = { status: "failed", failed: "browser tester: criterion failed: S1.2: the page shows two", sections: [{ title: "Browser tester: FAILED", body: "- [FAIL] S1.2: the page shows two" }], followUps: [] };
  const r2 = await ready(root2, "S1.3", owner(root2, "Smaller font", fail));
  assert.equal(r2.decision, "block");
  s = loadState(root2);
  assert.deepEqual([s.status, s.pauseRequested, s.pendingNotes.map((n) => n.text)], ["running", true, ["Smaller font"]]);
  const r3 = await gate(root2, b);
  assert.match(r3.reason, /OWNER REVIEW NOTES[\s\S]*Smaller font/);
});

test("state.json after each per-feature path: built, failed, passed with findings, closed", async () => {
  const root = scratch();
  const fail = { status: "failed", failed: "browser tester: criterion failed: S1.2: the page shows two", sections: [{ title: "Browser tester: FAILED", body: "- [FAIL] S1.2: the page shows two\n  Evidence: blank" }], followUps: [] };
  let n = 0;
  const { deps: b } = fakeBrowser({ tester: () => (++n === 1 ? fail : withFollowUp) });
  await build(root, ["S1.1"], b);
  let s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.tickedByGate, s.attempts["S1.1"], s.fixup, s.freshSession], ["running", "S1.2", ["S1.1"], 0, null, false]);
  assert.ok(s.phaseBaseCommit && s.phaseStartedAt);
  await build(root, ["S1.2"], b);
  let r = await ready(root, "S1.3", b);
  assert.match(r.reason, /attempt 1\/3 failed/);
  s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.tickedByGate, s.attempts["S1.3"], s.fixup], ["running", "S1.3", ["S1.1", "S1.2"], 1, null]);
  assert.equal(markers(root), "~~    ");
  r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 passed its verification/);
  s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate, s.attempts["S1.3"], s.fixup.attempt, s.fixup.findings.length], ["S1.3", ["S1.1", "S1.2", "S1.3"], 0, 2, 1]);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "verify-pending.json")), false);
  settleFindings(root);
  r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  s = loadState(root);
  assert.deepEqual([s.currentStep, s.fixup, s.phaseBaseCommit, s.phaseStartedAt, s.attempts["S1.3"], s.headAtLastGate], ["S2.1", null, null, null, 0, rev(root, "HEAD")]);
  assert.match(git(root, "log", "-1", "--format=%B").stdout, /attempt 2, then a fix-up pass/);
  assert.ok(treeClean(root));
});

// ---------- the gate's time, fix-up outcomes, tags of an earlier plan, resume in the builder ----------

const T0 = Date.parse("2026-09-28T10:00:00Z");
const checkRuns = (root) => { try { return fs.readFileSync(path.join(root, ".autoclaude", "check-runs"), "utf8").length; } catch { return 0; } };

test("the checkers share the gate's time: each keeps a reserve for those after it, and one stopped at its share is out of time, not a machine fault", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({});
  const got = [];
  const runTester = async (a) => { got.push([a.kind, a.deadlineMs - T0]); return b.runTester(a); };
  const runSecurity = async (a) => { got.push(["security", a.deadlineMs - T0]); return { status: "passed", sections: [], findings: [] }; };
  await build(root, ["S1.1", "S1.2"], b);
  let r = await ready(root, "S1.3", { ...b, runTester, runSecurity, clock: () => T0 });
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  // 1740 s for the checks and checkers (the stop's 1800 less a minute for the commit); each of
  // the three allows itself 900 s, so each keeps half a fair share for every one after it.
  assert.deepEqual(got, [["tester", 1160000], ["bugbash", 1305000], ["security", 1740000]]);

  // The security review stopped at its share: out of time, not an attempt, no machine blamed.
  await build(root, ["S2.1"], b);
  const cut = { status: "out-of-time", failed: "Security review ran out of the gate's time (1 try): stopped at the gate's deadline after 435 s (its own limit is 900 s)", sections: [{ title: "Security review: out of time", body: "x" }], findings: [] };
  r = await ready(root, "S2.2", { ...b, runSecurity: async () => cut });
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The verification of Phase 2 \(More\) ran out of time: Security review ran out of the gate's time/);
  assert.doesNotMatch(r.reason, /problem on this machine/);
  let s = loadState(root);
  assert.deepEqual([s.attempts["S2.2"] || 0, s.infraFailures["S2.2"] || 0, s.outOfTime["S2.2"]], [0, 0, 1]);
  assert.equal(markers(root), "xxx~  ", "the ticks came out again");
  const before = sent.length;
  r = await ready(root, "S2.2", { ...b, runSecurity: async () => cut });
  assert.equal(r.decision, "allow");
  s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason], ["paused", "out-of-time"]);
  const alert = sent.slice(before).find((m) => m.priority === "high");
  assert.match(alert.title, /S2\.2 does not fit in one verification/);
  assert.match(alert.message, /The feature is too big for one verification/);
  assert.doesNotMatch(alert.message, /Playwright|claude CLI/);

  // Too little of the gate's time left to start a checker at all: out of time without running it.
  const root2 = scratch();
  await build(root2, ["S1.1", "S1.2"], b);
  const started = [];
  const late = () => { let n = 0; return () => T0 + (n++ === 0 ? 0 : 1700000); };
  r = await ready(root2, "S1.3", { ...b, runTester: async (a) => { started.push(a.kind); return b.runTester(a); }, clock: late() });
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /ran out of time: the browser tester had \d+ s of the gate's time left, too little to start it/);
  assert.deepEqual(started, []);
});

test("a fix-up pass closes only when every finding has an outcome; a ready without one is an attempt, and the third pauses", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({ tester: withFollowUp });
  await build(root, ["S1.1", "S1.2"], b);
  let r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding/);
  const runs = checkRuns(root);
  for (let n = 1; n <= 2; n++) {
    r = await ready(root, "S1.3", b);
    assert.equal(r.decision, "block", JSON.stringify(r.events));
    assert.match(r.reason, new RegExp(`^The fix-up pass of Phase 1 is not finished \\(attempt ${n}/3\\): 1 finding still has no outcome\\.`));
    assert.match(r.reason, /1\. \[browser tester, medium\] the two is hard to read \(docs\/BLOCKERS\.md\): status "open"/);
  }
  assert.equal(checkRuns(root), runs, "no checks for a pass that is not finished");
  // Handing a finding over needs the reason.
  settleFindings(root, "left for the owner");
  r = await ready(root, "S1.3", b);
  assert.equal(r.decision, "allow");
  let s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.fixup && s.fixup.stepId, s.attempts["S1.3"]], ["paused", "step-failed", "S1.3", 3]);
  assert.match(sent.at(-1).title, /fix-up pass of Phase 1 left findings open 3 times/);
  assert.equal(gitLog(root)[0], "autoclaude(S1.2): Two", "nothing committed");
  // The owner gives the reason and resumes: the pass is over, and the feature closes.
  const file = path.join(root, "docs", "BLOCKERS.md");
  fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("| left for the owner |", "| left for the owner: the contrast is a brand decision |"));
  resumeRun(project(root), loadState(root));
  r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  s = loadState(root);
  assert.deepEqual([s.fixup, s.currentStep], [null, "S2.1"]);
  assert.ok(treeClean(root));
});

test("a findings row the builder deleted in the fix-up pass is put back, left for the owner, so the feature still closes", async () => {
  const blockersRow = (root) => fs.readFileSync(path.join(root, "docs", "BLOCKERS.md"), "utf8").split("\n").find((l) => /hard to read/.test(l));
  const deleteRow = (root) => {
    const file = path.join(root, "docs", "BLOCKERS.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").split("\n").filter((l) => !/hard to read/.test(l)).join("\n"));
  };
  const root = scratch();
  const { deps: b } = fakeBrowser({ tester: withFollowUp });
  await build(root, ["S1.1", "S1.2"], b);
  let r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding/);
  const row = blockersRow(root);
  // The builder fixes it and deletes the row instead of setting its status.
  deleteRow(root);
  r = await ready(root, "S1.3", b);
  assert.match(r.reason || "", /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "fixup-rows-restored" && e.rows === 1), JSON.stringify(r.events));
  const back = git(root, "show", "HEAD:docs/BLOCKERS.md").stdout.split(/\r?\n/).filter((l) => /hard to read/.test(l));
  assert.equal(back.length, 1, "committed with the feature, once");
  assert.equal(back[0].split("|").slice(1, 5).join("|"), row.split("|").slice(1, 5).join("|"), "the row as the gate wrote it");
  assert.match(back[0], /\| owner \| left for the owner: its row was deleted during the fix-up pass instead of given a status, so the gate put it back; check whether it was fixed \|$/);
  let s = loadState(root);
  assert.deepEqual([s.fixup, s.currentStep], [null, "S2.1"]);
  assert.ok(treeClean(root));

  // With another finding still open, the ready is an attempt, and the builder is told what came back.
  const two = { ...withFollowUp, followUps: [...withFollowUp.followUps, { severity: "low", title: "the four is misaligned", actual: "off by 2px", repro: "open /", expected: "aligned", foundBy: "tester" }] };
  const root2 = scratch();
  const { deps: b2 } = fakeBrowser({ tester: two });
  await build(root2, ["S1.1", "S1.2"], b2);
  await ready(root2, "S1.3", b2);
  deleteRow(root2);
  r = await ready(root2, "S1.3", b2);
  assert.equal(r.decision, "block", JSON.stringify(r.events));
  assert.match(r.reason, /^The row of "the two is hard to read" was deleted; I put it back, left for the owner\. Never delete a findings row: set its Status instead\.\n\nThe fix-up pass of Phase 1 is not finished \(attempt 1\/3\): 1 finding still has no outcome\./);
  assert.match(r.reason, /1\. \[browser tester, low\] the four is misaligned \(docs\/BLOCKERS\.md\): status "open"/);
  assert.doesNotMatch(r.reason, /no longer in the file/);
  settleFindings(root2);
  r = await ready(root2, "S1.3", b2);
  assert.match(r.reason || "", /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  assert.equal(git(root2, "show", "HEAD:docs/BLOCKERS.md").stdout.split(/\r?\n/).filter((l) => /hard to read/.test(l)).length, 1);
});

test("a feature close cut off after its fix-up pass, with the files changed since, runs the fix-up checks again before it commits", async () => {
  const root = scratch();
  const { deps: b } = fakeBrowser({ tester: withFollowUp });
  await build(root, ["S1.1", "S1.2"], b);
  let r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 passed its verification, with 1 non-blocking finding/);
  settleFindings(root);
  const hook = path.join(root, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hook, "#!/bin/sh\ncp .autoclaude/state.json .autoclaude/state-at-commit.json\nexit 0\n");
  fs.chmodSync(hook, 0o755);
  r = await ready(root, "S1.3", b);
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/, JSON.stringify(r.events));
  const atCommit = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state-at-commit.json"), "utf8"));
  assert.deepEqual([atCommit.closing.fixupDone, atCommit.fixup && atCommit.fixup.stepId, /^[0-9a-f]{40}$/.test(atCommit.closing.tree)], [true, "S1.3", true]);

  // Cut off in the commit; the builder changes a file and readies again before the next stop.
  git(root, "reset", "-q", "--soft", "HEAD~1");
  saveState(root, atCommit);
  fs.writeFileSync(path.join(root, "late.js"), "export const late = 1;\n");
  const runs = checkRuns(root);
  r = await ready(root, "S1.3", b);
  const types = r.events.map((e) => e.type);
  assert.ok(types.includes("close-changed") && !types.includes("close-resumed"), JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "verify" && e.fixup), JSON.stringify(r.events));
  assert.match(r.reason, /^Phase 1 \(Lists\) verified and committed/);
  assert.equal(checkRuns(root), runs + 1, "the checks ran on the changed files");
  assert.match(git(root, "show", "--name-only", "--format=", "HEAD").stdout, /late\.js/);
  assert.equal(gitLog(root).filter((l) => /^autoclaude\(S1\.3\)/.test(l)).length, 1);
  assert.equal(markers(root), "xxx   ");
  const s = loadState(root);
  assert.deepEqual([s.closing, s.fixup, s.currentStep], [null, null, "S2.1"]);
  assert.ok(treeClean(root));
});

test("a new plan with the same title as the last one (every plan is named after the project) is told apart by where the run started: its Phase 1 gets its own tag, kept when verified again", async () => {
  const root = scratch({ plan: NO_UI });
  fs.writeFileSync(path.join(root, "PLAN.md"), "# Backend plan\n\n## Phase 1: Old\n- [x] **S1.1** Old\n  - Accept: old\n");
  git(root, "commit", "-qam", "the last plan, finished");
  git(root, "tag", "ac-phase-1");
  const old = rev(root, "ac-phase-1");
  fs.writeFileSync(path.join(root, "PLAN.md"), NO_UI);
  git(root, "commit", "-qam", "a new plan, same title");
  // `autoclaude start` records the commit the run starts from.
  const base = rev(root, "HEAD");
  saveState(root, { ...loadState(root), currentStep: "S1.1", tickedByGate: [], baseCommit: base });
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-remote-")), "origin.git");
  git(os.tmpdir(), "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1"], b);
  let r = await ready(root, "S1.2", b);
  assert.match(r.reason, /^Phase 1 \(Store\) verified and committed/, JSON.stringify(r.events));
  const mine = `ac-phase-1-${base.slice(0, 7)}`;
  const first = rev(root, "HEAD");
  assert.equal(rev(root, "ac-phase-1"), old, "the last plan's tag stays where it is");
  assert.equal(rev(root, mine), first);
  assert.equal(rev(bare, `refs/tags/${mine}`), first, "and this run's is pushed");
  assert.equal(loadState(root).pushState.ok, true);
  const log = () => fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8");
  assert.match(log(), new RegExp(`ac-phase-1 marks Phase 1 of an earlier run, not of this run; this run's Phase 1 is tagged ${mine}`));

  // The owner reopens S1.2 in the same run: the phase keeps this run's first tag.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  editPlan(root, "- [x] **S1.2**", "- [ ] **S1.2**");
  resumeRun(project(root), loadState(root));
  r = await ready(root, "S1.2", b);
  assert.match(r.reason, /^Phase 1 \(Store\) verified and committed/, JSON.stringify(r.events));
  assert.notEqual(rev(root, "HEAD"), first);
  assert.deepEqual([rev(root, mine), rev(root, "ac-phase-1")], [first, old]);
  assert.match(log(), new RegExp(`${mine} already marks an earlier verification of Phase 1; left where it is`));
  assert.deepEqual([loadState(root).pushState.ok, gitTags(root).sort()], [true, ["ac-phase-1", mine].sort()]);
});

test("a new plan whose Phase 1 meets an earlier plan's ac-phase-1, in a state without the run's start commit: the plan's title tells them apart, and the log says why", async () => {
  const root = scratch({ plan: NO_UI });
  // An earlier plan finished its Phase 1 and tagged it.
  fs.writeFileSync(path.join(root, "PLAN.md"), "# First plan\n\n## Phase 1: Old\n- [x] **S1.1** Old\n  - Accept: old\n");
  git(root, "commit", "-qam", "the first plan");
  git(root, "tag", "ac-phase-1");
  const old = rev(root, "ac-phase-1");
  fs.writeFileSync(path.join(root, "PLAN.md"), NO_UI);
  git(root, "commit", "-qam", "a new plan");
  saveState(root, { ...loadState(root), currentStep: "S1.1", tickedByGate: [] });
  const bare = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fgate-remote-")), "origin.git");
  git(os.tmpdir(), "init", "-q", "--bare", bare);
  git(root, "remote", "add", "origin", bare);
  const { deps: b } = fakeBrowser({});
  await build(root, ["S1.1"], b);
  const r = await ready(root, "S1.2", b);
  assert.match(r.reason, /^Phase 1 \(Store\) verified and committed/, JSON.stringify(r.events));
  assert.equal(rev(root, "ac-phase-1"), old, "the earlier plan's tag stays where it is");
  assert.equal(rev(root, "ac-phase-1-backend"), rev(root, "HEAD"));
  assert.equal(rev(bare, "refs/tags/ac-phase-1-backend"), rev(root, "HEAD"), "and it is pushed");
  assert.equal(loadState(root).pushState.ok, true);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /ac-phase-1 marks Phase 1 of first, not of this run; this run's Phase 1 is tagged ac-phase-1-backend/);
});

test("a resume typed in the builder's own session at a feature's end does not ask for a fresh session, which would end it mid-work", async () => {
  const root = scratch();
  fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(process.pid));
  const inBuilder = { ...env, AUTOCLAUDE_BUILDER: "1" };
  const { deps: b } = fakeBrowser({});
  const d = { ...b, env: inBuilder };
  await build(root, ["S1.1", "S1.2"], d);
  saveState(root, { ...loadState(root), pauseRequested: true });
  await ready(root, "S1.3", d);
  assert.deepEqual([loadState(root).status, loadState(root).currentStep], ["paused", "S2.1"]);
  const changes = resumeRun(project(root), loadState(root), {}, { env: inBuilder });
  assert.ok(changes.some((c) => /S2\.1 starts a new feature; this is the builder's own session, so it carries on here/.test(c)), changes.join("\n"));
  assert.deepEqual([loadState(root).status, loadState(root).freshSession], ["running", false]);
  // From the owner's own terminal the next feature still gets its fresh session.
  saveState(root, { ...loadState(root), status: "paused", pauseReason: "review" });
  const { AUTOCLAUDE_BUILDER, ...terminal } = inBuilder;
  resumeRun(project(root), loadState(root), {}, { env: terminal });
  assert.equal(loadState(root).freshSession, true);
});
