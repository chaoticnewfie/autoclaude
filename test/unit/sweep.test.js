import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  sweepId, normalizeOptions, validateSweepOptions, globToRegExp, planAreas, listTrackedFiles,
  buildInventory, gateDecision, tallyVerdict, estimateSweep, collectCandidates, runPool,
  startSweep, runSweep, sweepStatus, findActiveSweeps, sweepPaths, readSweep, MODULES, STAGES,
  prepareTestUsers, MAP_SCHEMA, browserPlan, browserChecks, proxyRuleFor, requireUnusedProof, unusedProofs,
  findDeadSweeps, sweepLiveness, formatEstimate, SESSION_DISALLOWED, openSweepWindow, sweepsDir, ensureSweepsIgnored, sweepWhen,
  stopSweep, testUserSecrets, maskSecrets, SECRET_MASK, removesWholeFile, browserAutoFix, mapPages
} from "../../plugins/autoclaude/lib/sweep.js";
import { WRAP_UP_PROMPT } from "../../plugins/autoclaude/lib/headless.js";
import { pluginRoot } from "../../plugins/autoclaude/lib/paths.js";
import * as findingsLib from "../../plugins/autoclaude/lib/findings.js";

function tmp(prefix = "ac-sweep-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// A project with a couple of code files in two top-level folders, so planAreas makes two areas.
function makeProject() {
  const root = tmp();
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.mkdirSync(path.join(root, "lib"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const app = 1;\n");
  fs.writeFileSync(path.join(root, "lib", "util.js"), "export const util = 2;\n");
  fs.writeFileSync(path.join(root, "PLAN.md"), "# Demo plan\n\n## Constraints & decisions\n\nThe app listens on 127.0.0.1 only, on purpose.\n\n## Phase 1: One\n- [ ] **S1.1** x\n  - Accept: a\n");
  return root;
}

const TRACKED = ["src/app.js", "lib/util.js", "PLAN.md"];

// A git fake: ls-files returns the tracked set; the mutating calls just record and succeed.
function fakeGit(files = TRACKED, record = {}) {
  record.calls = record.calls || [];
  return {
    git: async (root, args) => {
      record.calls.push(args[0]);
      if (args[0] === "ls-files") return { ok: true, stdout: files.join("\0") };
      return { ok: true, stdout: "" };
    },
    head: async () => "abc1234",
    status: async () => ({ ok: true, clean: record.dirty ? false : true, entries: [] }),
    checkoutBranch: async (root, name) => { record.branch = name; return { ok: true, created: true }; },
    commitAll: async (root, msg) => { record.commitMsg = msg; record.committed = true; return { ok: true, committed: true, sha: "def5678" }; },
    currentBranch: async () => "main"
  };
}

function okResult(structured, extra = {}) {
  return { ok: true, infra: false, structured, rateLimited: false, numTurns: 3, costUsd: 0.01, durationMs: 50, error: null, ...extra };
}

// A headless fake: a map, one candidate per reviewer, and a verdict per verifier (SEC-001/OPT-001
// confirmed, everything else refuted), so the end-to-end flow has one confirmed and one refuted.
function fakeRun(record = {}) {
  record.roles = record.roles || [];
  return async ({ role }) => {
    record.roles.push(role);
    if (role === "sweep-map") return okResult({ entryPoints: ["src/app.js"], routes: [], roles: [], dataStores: ["local dev db"], trustBoundaries: ["src/app.js request handler"], notes: "two areas" });
    if (role.startsWith("verify-")) {
      const confirm = /-001-/.test(role);
      return okResult({ verdict: confirm ? "confirmed" : "refuted", reason: "checked src/app.js:10", severity: "high" });
    }
    // a reviewer
    return okResult({
      findings: [{ category: "injection", severity: "high", file: "src/app.js", line: 10, evidence: "TOP_SECRET_do_not_leak", impact: "command injection", fix: "parameterize", testIdea: "t", confidence: 8 }],
      coverage: { examined: [role], notExamined: [] },
      notes: ""
    });
  };
}

const CONFIG = {
  plan: "PLAN.md", branch: "autoclaude/{planSlug}", builder: { model: "opus" }, checkers: { effort: "xhigh" },
  devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 90 }, checks: [],
  usage: { weeklyPauseAtPct: 85, staleAfterMin: 30 }, supervisor: { rateLimitGraceMin: 10 },
  sweep: { concurrency: 3, depth: "thorough", advisories: true, waitAt5hPct: 90, maxTurnsPerAgent: 40, timeoutSecPerAgent: 900, after: "fix" }
};

// The findings helpers a real findings.js provides; here fakes that keep the shape.
function findingsDeps(alerts) {
  return {
    dedupe: (a) => a,
    loadAccepted: () => [],
    applyAccepted: (f) => ({ kept: f, accepted: [] }),
    numberFindings: (f, kind) => f.map((x, i) => ({ ...x, id: `${kind === "security" ? "SEC" : "OPT"}-${String(i + 1).padStart(3, "0")}`, fingerprint: `fp${i}` })),
    writeReport: (dir, data) => { const rf = path.join(dir, "report.md"); fs.writeFileSync(rf, `confirmed ${data.confirmed.length}\nrefuted ${data.refuted.length}\n`); return { reportFile: rf, jsonFile: path.join(dir, "findings.json") }; },
    notify: async (msg) => { alerts.push(msg); return { ok: true }; }
  };
}

class Sink { constructor() { this.text = ""; } write(s) { this.text += s; return true; } }
function makeIo(root, now = new Date("2026-10-02T09:15:00")) {
  const out = new Sink();
  return { io: { cwd: root, env: { PATH: "" }, out: (s = "") => out.write(s + "\n"), err: () => {}, now: () => now }, out };
}

// ---------- pure helpers ----------

test("sweepId: <yyyymmdd-hhmm>-<kind> in local time", () => {
  assert.equal(sweepId("security", new Date(2026, 9, 2, 9, 5)), "20261002-0905-security");
  assert.equal(sweepId("optimize", new Date(2026, 11, 31, 23, 59)), "20261231-2359-optimize");
});

test("normalizeOptions fills defaults, keeps only known modules, and adds the dev server as the first target", () => {
  const o = normalizeOptions("security", { modules: ["code", "bogus"], depth: "standard" }, { ...CONFIG, devServer: { url: "http://127.0.0.1:3000" } });
  assert.deepEqual(o.modules, ["code"]);
  assert.equal(o.depth, "standard");
  assert.equal(o.after, "fix");
  assert.deepEqual(o.targets[0], { url: "http://127.0.0.1:3000", mode: "readonly" });
  for (const t of ["headers", "idor", "xss"]) assert.equal(o.tests[t], true);
  // A full target with writes allowed keeps mode "full".
  const o2 = normalizeOptions("security", { writesAllowed: true }, { ...CONFIG, devServer: { url: "http://127.0.0.1:3000" } });
  assert.equal(o2.targets[0].mode, "full");
  // optimize defaults to all its modules.
  assert.deepEqual(normalizeOptions("optimize", {}, CONFIG).modules, MODULES.optimize);
});

test("validateSweepOptions flags a bad kind, depth, after and unknown module", () => {
  const errs = validateSweepOptions({ kind: "nope", depth: "deep", after: "maybe", modules: ["x"], targets: [] });
  const paths = errs.map((e) => e.path);
  assert.ok(paths.includes("kind") && paths.includes("depth") && paths.includes("after") && paths.includes("modules"));
  assert.deepEqual(validateSweepOptions(normalizeOptions("security", {}, CONFIG)), []);
});

test("globToRegExp handles *, ** and folder patterns", () => {
  assert.ok(globToRegExp("*.lock").test("package.lock"));
  assert.ok(globToRegExp("dist/**").test("dist/a/b.js"));
  assert.ok(globToRegExp("node_modules/").test("node_modules/x/y.js"));
  assert.ok(!globToRegExp("src/*.js").test("src/a/b.js"));
  assert.ok(globToRegExp("src/*.js").test("src/a.js"));
});

test("planAreas groups code files under a byte budget and names areas by folder", () => {
  const files = [
    { path: "src/a.js", bytes: 100 }, { path: "src/b.js", bytes: 100 }, { path: "src/c.js", bytes: 100 },
    { path: "lib/x.js", bytes: 50 }, { path: "README.md", bytes: 9999 }
  ];
  const areas = planAreas(files, { budget: 150 });
  // README.md is not code, so it is left out; src splits across the 150-byte budget.
  assert.ok(areas.every((a) => a.files.every((f) => !/README/.test(f))));
  assert.ok(areas.length >= 3);
  assert.ok(areas.every((a) => /^area-/.test(a.name)));
  assert.equal(new Set(areas.map((a) => a.name)).size, areas.length, "area names are unique");
});

test("gateDecision: go below thresholds, wait when the 5-hour window is full or rate-limited, pause at the weekly cap", () => {
  const base = { waitAt5hPct: 90, weeklyPauseAtPct: 85, now: 1000, graceMs: 100 };
  assert.equal(gateDecision({ ...base, usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 10 } }, rateLimited: false }).action, "go");
  const full = gateDecision({ ...base, usage: { fiveHour: { pct: 95, resetsAt: 5000 }, sevenDay: { pct: 10 } }, rateLimited: false });
  assert.equal(full.action, "wait");
  assert.equal(full.until, 5100);
  const rl = gateDecision({ ...base, usage: { fiveHour: { pct: 10, resetsAt: 5000 }, sevenDay: { pct: 10 } }, rateLimited: true });
  assert.equal(rl.action, "wait");
  assert.equal(gateDecision({ ...base, usage: { fiveHour: { pct: 10 }, sevenDay: { pct: 90 } }, rateLimited: false }).action, "pause-weekly");
});

test("gateDecision ignores a window that has already reset, and a rate limit with no reset ahead waits a fixed backoff", () => {
  const base = { waitAt5hPct: 90, weeklyPauseAtPct: 85, now: 10000, graceMs: 100, backoffMs: 500 };
  // A full 5-hour reading whose reset is behind us says nothing about the new window.
  assert.equal(gateDecision({ ...base, usage: { fiveHour: { pct: 99, resetsAt: 9000 }, sevenDay: { pct: 10 } }, rateLimited: false }).action, "go");
  // Same for a weekly reading whose week has reset.
  assert.equal(gateDecision({ ...base, usage: { fiveHour: { pct: 5 }, sevenDay: { pct: 99, resetsAt: 9000 } }, rateLimited: false }).action, "go");
  // A full 5-hour reading with no reset time counts only while it is fresh.
  assert.equal(gateDecision({ ...base, usage: { fetchedAt: 10000 - 31 * 60000, fiveHour: { pct: 99 } }, rateLimited: false }).action, "go");
  assert.equal(gateDecision({ ...base, usage: { fetchedAt: 9000, fiveHour: { pct: 99 } }, rateLimited: false }).action, "wait");
  // Rate-limited with the reset already past: now + the backoff, not a deadline that moves.
  const rl = gateDecision({ ...base, usage: { fiveHour: { pct: 10, resetsAt: 9000 } }, rateLimited: true });
  assert.deepEqual(rl, { action: "wait", until: 10500 });
});

// A clock that sleep() moves forward, as the real one does.
function fakeClock(start = Date.UTC(2026, 9, 2, 12, 0, 0)) {
  const c = { t: start, sleeps: 0 };
  c.now = () => c.t;
  c.sleep = async (ms) => { c.sleeps++; c.t += ms; if (c.sleeps > 100000) throw new Error("the pool never stopped waiting"); };
  return c;
}

test("runPool with the real 10-minute grace: a rate-limited agent runs again once the wait passes, and a full window clears at its reset", async () => {
  const graceMs = 10 * 60 * 1000;
  const backoffMs = 15 * 60 * 1000;
  // Rate limited, the reset 30 minutes ahead.
  const c1 = fakeClock();
  const resetsAt = c1.t + 30 * 60 * 1000;
  const waits = [];
  const usage1 = { read: () => ({ fiveHour: { pct: 10, resetsAt }, sevenDay: { pct: 10 } }), now: c1.now, sleep: c1.sleep, waitAt5hPct: 90, weeklyPauseAtPct: 85, graceMs, backoffMs, maxChunkMs: 60 * 1000, onWait: (u) => waits.push(u) };
  const calls = {};
  const launch = async (a) => { calls[a.name] = (calls[a.name] || 0) + 1; return { rateLimited: a.name === "a" && calls.a === 1 }; };
  const r1 = await runPool([{ name: "a" }, { name: "b" }], { concurrency: 1, launch, usage: usage1 });
  assert.equal(r1.paused, null);
  assert.equal(calls.a, 2, "the rate-limited agent runs again");
  assert.equal(calls.b, 1);
  assert.deepEqual(waits, [resetsAt + graceMs], "one wait, to the reset plus the grace");
  assert.ok(c1.t >= resetsAt + graceMs && c1.t < resetsAt + graceMs + 2 * 60 * 1000);

  // Rate limited with no reset known: one backoff, then a retry.
  const c2 = fakeClock();
  const start2 = c2.t;
  const calls2 = {};
  const usage2 = { ...usage1, read: () => ({ source: null }), now: c2.now, sleep: c2.sleep, onWait: () => {} };
  await runPool([{ name: "a" }], { concurrency: 1, launch: async (a) => { calls2[a.name] = (calls2[a.name] || 0) + 1; return { rateLimited: calls2.a === 1 }; }, usage: usage2 });
  assert.equal(calls2.a, 2);
  assert.ok(c2.t - start2 >= backoffMs && c2.t - start2 < backoffMs + 2 * 60 * 1000);

  // The 5-hour window full until its reset: no launch before it, the agent runs after it.
  const c3 = fakeClock();
  const reset3 = c3.t + 20 * 60 * 1000;
  let launchedAt = null;
  const usage3 = { ...usage1, read: () => ({ fiveHour: { pct: 95, resetsAt: reset3 }, sevenDay: { pct: 10 } }), now: c3.now, sleep: c3.sleep, onWait: () => {} };
  const r3 = await runPool([{ name: "x" }], { concurrency: 2, launch: async () => { launchedAt = c3.t; return {}; }, usage: usage3 });
  assert.equal(r3.launched, 1);
  assert.ok(launchedAt >= reset3 + graceMs);
});

test("tallyVerdict keeps on a majority confirmed, drops on a majority refuted, else uncertain", () => {
  assert.equal(tallyVerdict([{ verdict: "confirmed" }, { verdict: "confirmed" }, { verdict: "refuted" }]), "confirmed");
  assert.equal(tallyVerdict([{ verdict: "refuted" }, { verdict: "refuted" }, { verdict: "confirmed" }]), "refuted");
  assert.equal(tallyVerdict([{ verdict: "confirmed" }, { verdict: "refuted" }]), "uncertain");
  assert.equal(tallyVerdict([]), "uncertain");
});

test("tallyVerdict counts against the planned verifiers: one vote beside failed sessions confirms or refutes nothing", () => {
  // Thorough plans 3: a single answer (the other two sessions failed) is never a majority.
  assert.equal(tallyVerdict([{ verdict: "confirmed" }], 3), "uncertain");
  assert.equal(tallyVerdict([{ verdict: "refuted" }], 3), "uncertain");
  // Two of three agreeing is a majority of the planned three.
  assert.equal(tallyVerdict([{ verdict: "confirmed" }, { verdict: "confirmed" }], 3), "confirmed");
  assert.equal(tallyVerdict([{ verdict: "refuted" }, { verdict: "refuted" }], 3), "refuted");
  assert.equal(tallyVerdict([{ verdict: "confirmed" }, { verdict: "uncertain" }], 3), "uncertain");
  // Standard plans 1: its one vote decides.
  assert.equal(tallyVerdict([{ verdict: "confirmed" }], 1), "confirmed");
});

test("estimateSweep counts the reviewer and verification sessions", () => {
  const inv = { areas: [{ name: "a", files: [], bytes: 0 }, { name: "b", files: [], bytes: 0 }], byExt: {}, stack: {}, fileCount: 2, totalBytes: 0 };
  const est = estimateSweep(normalizeOptions("security", { modules: ["code"], depth: "thorough" }, CONFIG), inv);
  assert.equal(est.areas, 2);
  assert.ok(est.verifiers > 0);
  assert.ok(est.minutes > 0);
});

// ---------- inventory ----------

test("listTrackedFiles reads git ls-files, honours excludes, and buildInventory splits areas", async () => {
  const root = makeProject();
  const files = await listTrackedFiles(root, { exclude: ["*.md"], git: fakeGit() });
  assert.ok(files.some((f) => f.path === "src/app.js"));
  assert.ok(!files.some((f) => f.path === "PLAN.md"), "the *.md exclude drops PLAN.md");
  const inv = await buildInventory(root, normalizeOptions("security", { exclude: ["*.md"] }, CONFIG), { git: fakeGit() });
  assert.ok(inv.areas.length >= 2);
  assert.ok(inv.fileCount >= 2);
});

// ---------- the pool ----------

test("runPool runs every agent under the concurrency cap", async () => {
  const launched = [];
  const usage = { read: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } }), now: () => Date.now(), sleep: async () => {}, waitAt5hPct: 90, weeklyPauseAtPct: 85, graceMs: 0, maxChunkMs: 10, onWait: () => {} };
  const agents = [1, 2, 3, 4, 5].map((n) => ({ name: `a${n}` }));
  const r = await runPool(agents, { concurrency: 2, launch: async (a) => { launched.push(a.name); return { rateLimited: false }; }, usage });
  assert.equal(r.paused, null);
  assert.equal(r.launched, 5);
  assert.deepEqual(launched.sort(), ["a1", "a2", "a3", "a4", "a5"]);
});

test("runPool pauses at the weekly cap without launching", async () => {
  const usage = { read: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 90 } }), now: () => Date.now(), sleep: async () => {}, waitAt5hPct: 90, weeklyPauseAtPct: 85, graceMs: 0, maxChunkMs: 10, onWait: () => {} };
  let launched = 0;
  const r = await runPool([{ name: "a" }], { concurrency: 1, launch: async () => { launched++; return {}; }, usage });
  assert.equal(launched, 0);
  assert.equal(r.paused.reason, "weekly");
});

test("runPool waits out a rate-limited result and re-runs that agent", async () => {
  const calls = {};
  const usage = { read: () => ({ fiveHour: { pct: 10, resetsAt: Date.now() - 1000 }, sevenDay: { pct: 10 } }), now: () => Date.now(), sleep: async () => {}, waitAt5hPct: 90, weeklyPauseAtPct: 85, graceMs: 0, maxChunkMs: 10, onWait: () => {} };
  const launch = async (a) => {
    calls[a.name] = (calls[a.name] || 0) + 1;
    if (a.name === "a" && calls.a === 1) return { rateLimited: true };
    return { rateLimited: false };
  };
  const r = await runPool([{ name: "a" }, { name: "b" }], { concurrency: 1, launch, usage });
  assert.equal(r.paused, null);
  assert.equal(calls.a, 2, "the rate-limited agent runs again after the wait");
  assert.equal(calls.b, 1);
});

// ---------- start ----------

test("startSweep validates, writes sweep.json and inventory.json, prints an estimate, and opens the sweep window", async () => {
  const root = makeProject();
  const { io, out } = makeIo(root);
  const opened = {};
  const r = await startSweep({
    root, kind: "security", options: { modules: ["code"], after: "report", depth: "standard" }, config: CONFIG, io,
    deps: { git: fakeGit(), openConsoleWindow: (o) => { Object.assign(opened, o); return { method: "windows-console", pid: 1 }; }, readUsage: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } }) }
  });
  assert.equal(r.ok, true, r.error);
  assert.match(r.id, /^\d{8}-\d{4}-security$/);
  const sp = sweepPaths(root, r.id);
  const sweep = readSweep(root, r.id);
  assert.equal(sweep.status, "running");
  assert.equal(sweep.stage, "inventory");
  assert.deepEqual(sweep.options.modules, ["code"]);
  assert.ok(fs.existsSync(sp.inventoryFile));
  assert.match(out.text, /sweep: security, depth standard/);
  assert.match(out.text, /rough time: about/);
  assert.equal(opened.title, `ac-sweep-${path.basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`);
  // --auto: a window the engine opens leaves a sweep the owner stopped alone.
  assert.deepEqual(opened.args.slice(-3), ["sweep-run", "--auto", r.id]);
});

test("startSweep refuses an unknown kind, and normalizeOptions coerces a bad depth to the default", async () => {
  const root = makeProject();
  const { io } = makeIo(root);
  const r = await startSweep({ root, kind: "bogus", options: {}, config: CONFIG, io, deps: { git: fakeGit(), openConsoleWindow: () => ({}) } });
  assert.equal(r.ok, false);
  assert.match(r.error, /unknown sweep kind/);
  // A hand-typed bad depth is not fatal: it falls back to the configured default.
  assert.equal(normalizeOptions("security", { depth: "deep" }, CONFIG).depth, "thorough");
});

// ---------- run, end to end ----------

async function runReportSweep(root, after = "report", extraDeps = {}) {
  const { io } = makeIo(root);
  const alerts = [];
  const gitRec = {};
  const git = fakeGit(TRACKED, gitRec);
  const start = await startSweep({ root, kind: "security", options: { modules: ["code"], after, depth: "thorough" }, config: CONFIG, io, deps: { git, openConsoleWindow: () => ({ method: "windows-console" }), readUsage: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } }) } });
  assert.equal(start.ok, true, start.error);
  const runRec = {};
  const deps = {
    config: CONFIG, git, run: fakeRun(runRec),
    readUsage: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } }), sleep: async () => {}, now: () => Date.now(),
    runSecurityScanners: async () => ({ candidates: [], coverage: { examined: ["scanners"], notExamined: [] } }),
    ...findingsDeps(alerts),
    verbose: false, ...extraDeps
  };
  const result = await runSweep({ root, id: start.id, io, deps });
  return { id: start.id, result, alerts, gitRec, runRec, io };
}

test("runSweep report mode: verifies candidates by majority, writes the report, sends the finished alert with counts only", async () => {
  const root = makeProject();
  const { id, result, alerts, runRec } = await runReportSweep(root, "report");
  assert.equal(result.ok, true, result.error);
  assert.equal(result.status, "done");
  const sp = sweepPaths(root, id);
  // The engine's working store (merged.json), apart from the report's own findings.json.
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const byVerdict = (v) => store.findings.filter((f) => f.verdict === v).map((f) => f.id);
  assert.deepEqual(byVerdict("confirmed"), ["SEC-001"]);
  assert.deepEqual(byVerdict("refuted"), ["SEC-002"]);
  assert.deepEqual(store.findings[0].votes, { confirmed: 3, refuted: 0, uncertain: 0, failed: 0 }, "the votes reach the report");
  assert.equal(store.findings[0].verdicts.length, 3);
  assert.ok(fs.existsSync(sp.reportFile));
  // Three verifier sessions per candidate (depth thorough).
  assert.equal(runRec.roles.filter((r) => r.startsWith("verify-SEC-001-")).length, 3);
  // Exactly one finished alert, with counts and a path, never the finding's evidence value.
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /security sweep finished/);
  assert.match(alerts[0].message, /Confirmed: 1 finding \(0 critical, 1 high, 0 medium, 0 low\)/);
  assert.match(alerts[0].message, /Next: read the report/);
  assert.ok(!alerts[0].message.includes("TOP_SECRET_do_not_leak"));
  assert.equal(readSweep(root, id).status, "done");
});

test("runSweep is resumable: an agent whose result file already exists is not run again", async () => {
  const root = makeProject();
  const { io } = makeIo(root);
  const git = fakeGit();
  const start = await startSweep({ root, kind: "security", options: { modules: ["code"], after: "report", depth: "standard" }, config: CONFIG, io, deps: { git, openConsoleWindow: () => ({}), readUsage: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } }) } });
  const sp = sweepPaths(root, start.id);
  const inv = JSON.parse(fs.readFileSync(sp.inventoryFile, "utf8"));
  const firstArea = inv.areas[0].name;
  // Pretend the first area reviewer already finished, and jump the sweep to the review stage.
  fs.mkdirSync(sp.agentsDir, { recursive: true });
  fs.writeFileSync(path.join(sp.agentsDir, `${firstArea}.json`), JSON.stringify({ name: firstArea, ok: true, structured: { findings: [], coverage: { examined: [firstArea], notExamined: [] }, notes: "" } }));
  const sweep = readSweep(root, start.id); sweep.stage = "review"; sweep.agents[firstArea] = "done"; fs.writeFileSync(sp.sweepFile, JSON.stringify(sweep));
  const runRec = {};
  await runSweep({ root, id: start.id, io, deps: { config: CONFIG, git, run: fakeRun(runRec), readUsage: () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } }), sleep: async () => {}, now: () => Date.now(), runSecurityScanners: async () => ({ candidates: [], coverage: {} }), ...findingsDeps([]), verbose: false } });
  assert.ok(!runRec.roles.includes(`sweep-${firstArea}`), "the finished area is not reviewed again");
  assert.ok(runRec.roles.some((r) => r.startsWith("sweep-area")), "the other area is still reviewed");
});

test("runSweep a second time short-circuits a done sweep", async () => {
  const root = makeProject();
  const { id, io } = await runReportSweep(root, "report");
  const again = await runSweep({ root, id, io: makeIo(root).io, deps: { config: CONFIG, git: fakeGit(), ...findingsDeps([]), verbose: false } });
  assert.equal(again.status, "done");
  assert.equal(again.already, true);
});

const FIX_PLAN = "# Security fixes 2026-10-02\n\n## Phase 1: Fixes\n- [ ] **S1.1** Fix the injection\n  - Accept: a regression test covers it\n";

test("runSweep plan mode: the generated plan stays in the sweep folder, never the project tree, and the result gives the command that runs it", async () => {
  const root = makeProject();
  const { id, result, alerts, gitRec } = await runReportSweep(root, "plan", { generateFixPlan: () => ({ text: FIX_PLAN, file: "SECURITY_PLAN.md" }) });
  assert.equal(result.status, "done");
  assert.equal(result.after, "plan");
  const rel = `.autoclaude/sweeps/${id}/SECURITY_PLAN.md`;
  assert.equal(result.planFile, rel);
  assert.equal(result.runCommand, `autoclaude run --plan ${rel}`);
  assert.equal(fs.readFileSync(path.join(root, rel), "utf8"), FIX_PLAN);
  assert.equal(fs.existsSync(path.join(root, "SECURITY_PLAN.md")), false, "nothing is written into the project tree");
  assert.ok(!gitRec.committed && !gitRec.branch);
  assert.equal(readSweep(root, id).result.planFile, rel);
  // The alert names that path in the command to run later.
  assert.match(alerts[0].message, new RegExp(`autoclaude run --plan ${rel.replace(/[.]/g, "[.]")}`));
});

test("runSweep fix mode: hands the sweep folder's plan to `run --plan` (which makes the branch and the commit) and makes no branch or commit itself", async () => {
  const root = makeProject();
  const { id, result, gitRec } = await runReportSweep(root, "fix", { generateFixPlan: () => ({ text: FIX_PLAN, file: "SECURITY_PLAN.md" }) });
  assert.equal(result.after, "fix");
  assert.equal(result.startRun, true);
  assert.equal(result.planFile, `.autoclaude/sweeps/${id}/SECURITY_PLAN.md`);
  assert.equal(result.runCommand, `autoclaude run --plan .autoclaude/sweeps/${id}/SECURITY_PLAN.md`);
  assert.equal(result.branch, undefined);
  assert.ok(!gitRec.committed, "the sweep commits nothing");
  assert.ok(!gitRec.branch, "the sweep checks out no branch");
  assert.equal(fs.existsSync(path.join(root, "SECURITY_PLAN.md")), false);
});

test("runSweep fix mode is refused while a run is active: it behaves like plan, and the live run's plan file and tree are left alone", async () => {
  const root = makeProject();
  // A fix run in progress on a SECURITY_PLAN.md from an earlier sweep, one step ticked.
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), JSON.stringify({ version: 1, status: "running", currentStep: "S1.2" }));
  const live = "# Security fixes 2026-10-01\n\n## Phase 1: Fixes\n- [x] **S1.1** Done\n  - Accept: a\n- [ ] **S1.2** In progress\n  - Accept: b\n";
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), live);
  const { id, result, gitRec } = await runReportSweep(root, "fix", { generateFixPlan: () => ({ text: FIX_PLAN, file: "SECURITY_PLAN.md" }) });
  assert.equal(result.after, "plan");
  assert.match(result.fixRefused, /running/);
  assert.ok(!gitRec.committed, "nothing is committed when fix is refused");
  assert.equal(fs.readFileSync(path.join(root, "SECURITY_PLAN.md"), "utf8"), live, "the live run's plan is not replaced");
  assert.equal(fs.readFileSync(path.join(sweepPaths(root, id).dir, "SECURITY_PLAN.md"), "utf8"), FIX_PLAN);
  // after: "plan" never touches the tree either.
  const root2 = makeProject();
  fs.mkdirSync(path.join(root2, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root2, ".autoclaude", "state.json"), JSON.stringify({ version: 1, status: "paused" }));
  await runReportSweep(root2, "plan", { generateFixPlan: () => ({ text: FIX_PLAN, file: "SECURITY_PLAN.md" }) });
  assert.equal(fs.existsSync(path.join(root2, "SECURITY_PLAN.md")), false);
});

// ---------- status ----------

test("sweepStatus and findActiveSweeps list the project's sweeps", async () => {
  const root = makeProject();
  const { id } = await runReportSweep(root, "report");
  const all = sweepStatus(root).sweeps;
  assert.equal(all.length, 1);
  assert.equal(all[0].id, id);
  assert.equal(all[0].status, "done");
  // A done sweep is not "active".
  assert.equal(findActiveSweeps(root).length, 0);
  // A running one shows up.
  const sp = sweepPaths(root, id);
  const s = readSweep(root, id); s.status = "running"; s.stage = "review"; fs.writeFileSync(sp.sweepFile, JSON.stringify(s));
  const active = findActiveSweeps(root);
  assert.equal(active.length, 1);
  assert.equal(active[0].stage, "review");
});

test("collectCandidates gathers candidates and coverage from scanners and agents, skipping the map", () => {
  const root = makeProject();
  const sp = sweepPaths(root, "x-y-security");
  fs.mkdirSync(sp.scannersDir, { recursive: true });
  fs.mkdirSync(sp.agentsDir, { recursive: true });
  fs.writeFileSync(path.join(sp.scannersDir, "security.json"), JSON.stringify({ candidates: [{ category: "secret", file: "a" }], coverage: { examined: ["scan"], notExamined: ["git history"] } }));
  fs.writeFileSync(path.join(sp.agentsDir, "map.json"), JSON.stringify({ structured: { entryPoints: ["x"] } }));
  fs.writeFileSync(path.join(sp.agentsDir, "area-src.json"), JSON.stringify({ structured: { findings: [{ category: "xss", file: "b" }], coverage: { examined: ["area-src"], notExamined: [] } } }));
  const { candidates, coverage } = collectCandidates(sp);
  assert.equal(candidates.length, 2);
  assert.ok(coverage.examined.includes("scan") && coverage.examined.includes("area-src"));
  assert.ok(coverage.notExamined.includes("git history"));
});

// ---------- integration fixes (P10 integration) ----------

test("collectCandidates reads only the engine's scanner results, skips verifiers, tags sources, and reports a failed session as not reviewed", () => {
  const root = makeProject();
  const sp = sweepPaths(root, "x-y-security");
  fs.mkdirSync(sp.scannersDir, { recursive: true });
  fs.mkdirSync(sp.agentsDir, { recursive: true });
  fs.writeFileSync(path.join(sp.scannersDir, "security.json"), JSON.stringify({ candidates: [{ category: "secrets", file: "a" }], coverage: { examined: [], notExamined: [] } }));
  // A scanner's raw side file is not a result, even when it holds a candidates list.
  fs.writeFileSync(path.join(sp.scannersDir, "knip.json"), JSON.stringify({ candidates: [{ category: "unused-file", file: "z" }] }));
  fs.writeFileSync(path.join(sp.scannersDir, "baseline.json"), JSON.stringify({ coverage: { examined: ["checks timed"], notExamined: ["build: not checked"] } }));
  fs.writeFileSync(path.join(sp.agentsDir, "verify-SEC-001-1.json"), JSON.stringify({ structured: { findings: [{ category: "x", file: "v" }] } }));
  fs.writeFileSync(path.join(sp.agentsDir, "area-lib.json"), JSON.stringify({ name: "area-lib", ok: false, error: "timed out", structured: null }));
  const { candidates, coverage } = collectCandidates(sp);
  assert.deepEqual(candidates.map((c) => [c.file, c.source]), [["a", "scanner security"]]);
  assert.ok(coverage.examined.includes("checks timed") && coverage.notExamined.includes("build: not checked"), "the baseline's coverage is kept");
  assert.ok(coverage.notExamined.some((n) => /^area-lib: not reviewed \(the session failed: timed out\)/.test(n)));
});

test("validateSweepOptions refuses a target that is not an http(s) URL and a users file outside the project; signUp needs writes", () => {
  const bad = normalizeOptions("security", { targets: [{ url: "ftp://x" }, { url: "127.0.0.1:3000" }], testUsers: { file: "../elsewhere.json" } }, CONFIG);
  const errs = validateSweepOptions(bad).map((e) => e.path);
  assert.ok(errs.includes("targets[0].url") && errs.includes("targets[1].url") && errs.includes("testUsers.file"), errs.join(", "));
  assert.deepEqual(normalizeOptions("security", { testUsers: { file: "secrets/u.json", signUp: true } }, CONFIG).testUsers, { file: "secrets/u.json" }, "no sign-up without writes");
  assert.deepEqual(normalizeOptions("security", { writesAllowed: true, testUsers: { file: "secrets/u.json", signUp: true } }, CONFIG).testUsers, { file: "secrets/u.json", signUp: true });
  assert.equal(normalizeOptions("security", { testUsers: {} }, CONFIG).testUsers, null);
  assert.equal(normalizeOptions("optimize", { flakyReruns: 40 }, CONFIG).flakyReruns, 10);
});

test("prepareTestUsers: labels and usernames for the prompt, passwords only in the dotenv file for Playwright's --secrets", () => {
  const root = makeProject();
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "u.json"), JSON.stringify({ loginUrl: "/login", users: [{ label: "user A", username: "a@example.com", password: "it's-a-secret" }, { username: "b@example.com", password: "plain-pass" }] }));
  const envFile = path.join(root, ".autoclaude", "sweeps", "s", "sweep-users.env");
  const r = prepareTestUsers(root, { testUsers: { file: "secrets/u.json" } }, envFile);
  assert.equal(r.envFile, envFile);
  assert.match(r.text, /^Sign in at \/login\./);
  assert.match(r.text, /- user A: username a@example\.com; for the password, type exactly SWEEP_USER_A_PASSWORD/);
  assert.match(r.text, /- user B: username b@example\.com; .*SWEEP_USER_B_PASSWORD/);
  assert.ok(!r.text.includes("secret") && !r.text.includes("plain-pass"), "no password in the prompt text");
  assert.equal(fs.readFileSync(envFile, "utf8"), "SWEEP_USER_A_PASSWORD=\"it's-a-secret\"\nSWEEP_USER_B_PASSWORD='plain-pass'\n");
  // No file, an unreadable one, and sign-up mode hand over nothing.
  assert.equal(prepareTestUsers(root, { testUsers: null }, envFile).envFile, null);
  assert.match(prepareTestUsers(root, { testUsers: { file: "secrets/none.json" } }, envFile).text, /could not be read/);
  assert.match(prepareTestUsers(root, { testUsers: { file: "secrets/u.json", signUp: true } }, envFile).text, /Sign up two throwaway/);
  assert.ok(MAP_SCHEMA.required.includes("protectedRoutes") && MAP_SCHEMA.required.includes("loginPath"));
});

test("startSweep with estimateOnly prints the estimate and writes nothing", async () => {
  const root = makeProject();
  const { io, out } = makeIo(root);
  let opened = 0;
  const r = await startSweep({ root, kind: "optimize", options: {}, config: { ...CONFIG, sweep: { ...CONFIG.sweep, concurrency: 2 } }, io, estimateOnly: true, deps: { git: fakeGit(), openConsoleWindow: () => { opened++; return {}; } } });
  assert.equal(r.ok, true);
  assert.equal(r.estimate.concurrency, 2);
  assert.match(out.text, /estimate \(nothing started\)/);
  assert.match(out.text, /at 2 at a time/);
  assert.equal(opened, 0);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "sweeps")), false);
});

test("runSweep fix mode: every confirmed finding needing the owner writes no plan and reads as report only in the alert", async () => {
  const root = makeProject();
  const generateFixPlan = () => ({ text: "# Security fixes\n\n## After the run\n\n- SEC-001 needs you\n", file: "SECURITY_PLAN.md", stepCount: 0, problems: [{ message: "no phases" }] });
  const { result, alerts, gitRec } = await runReportSweep(root, "fix", { generateFixPlan });
  assert.equal(result.after, "report");
  assert.equal(result.ownerOnly, true);
  assert.ok(!fs.existsSync(path.join(root, "SECURITY_PLAN.md")));
  assert.ok(!gitRec.committed);
  assert.match(alerts[0].message, /Next: read the report/);
});

test("runSweep fix mode is refused when the project moved on during the sweep; the alert says so after the after-stage", async () => {
  const root = makeProject();
  const plan = "# Security fixes 2026-10-02\n\n## Phase 1: Fixes\n- [ ] **S1.1** Fix the injection\n  - Accept: a regression test covers it\n";
  const moved = { ...fakeGit(TRACKED), head: async () => "fff0000" };
  const { result, alerts } = await runReportSweep(root, "fix", { generateFixPlan: () => ({ text: plan, file: "SECURITY_PLAN.md", stepCount: 1, problems: [] }), git: moved });
  assert.equal(result.after, "plan");
  assert.match(result.fixRefused, /moved on during the sweep \(abc1234 to fff0000\)/);
  assert.match(alerts[0].message, /Next: the fix run did not start \(the project moved on during the sweep/);
});

test("runSweep that fails sends the alert as stopped, without the error text", async () => {
  const root = makeProject();
  const { result, alerts } = await runReportSweep(root, "plan", { generateFixPlan: () => { throw new Error("TOP_SECRET_do_not_leak in the generator"); } });
  assert.equal(result.ok, false);
  assert.equal(result.status, "failed");
  assert.equal(alerts.length, 1);
  assert.match(alerts[0].title, /security sweep stopped/);
  assert.ok(!JSON.stringify(alerts).includes("TOP_SECRET"));
});

test("a live module with no target URL is reported as not checked, never as clean", async () => {
  const root = makeProject();
  const { io } = makeIo(root);
  const git = fakeGit();
  const usage = () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } });
  const start = await startSweep({ root, kind: "security", options: { modules: ["live"], after: "report", depth: "quick" }, config: CONFIG, io, deps: { git, openConsoleWindow: () => ({}), readUsage: usage } });
  assert.equal(start.ok, true, start.error);
  const writes = [];
  const r = await runSweep({ root, id: start.id, io, deps: { config: CONFIG, git, run: fakeRun({}), readUsage: usage, sleep: async () => {}, runSecurityScanners: async () => ({ candidates: [], coverage: {} }), ...findingsDeps([]), writeReport: (dir, data) => { writes.push(data); return { reportFile: path.join(dir, "report.md"), jsonFile: path.join(dir, "findings.json") }; }, verbose: false } });
  assert.equal(r.status, "done", r.error);
  assert.ok(writes[0].coverage.notExamined.some((n) => /^live checks of the running app: not checked \(no target URL/.test(n)), JSON.stringify(writes[0].coverage));
});

// ---------- review fixes (P10 review) ----------

const USAGE_OK = () => ({ fiveHour: { pct: 5 }, sevenDay: { pct: 5 } });

// Starts a sweep (window faked) and runs it with the given fakes. `run` defaults to fakeRun.
async function startAndRun(root, kind, options, deps = {}, { config = CONFIG } = {}) {
  const { io } = makeIo(root);
  const git = deps.git || fakeGit();
  const start = await startSweep({ root, kind, options, config, io, deps: { git, openConsoleWindow: () => ({ method: "windows-console" }), readUsage: USAGE_OK, isPidAlive: deps.isPidAlive } });
  assert.equal(start.ok, true, start.error);
  const alerts = [];
  const result = await runSweep({
    root, id: start.id, io,
    deps: {
      config, git, run: fakeRun({}), readUsage: USAGE_OK, sleep: async () => {}, now: () => Date.now(),
      runSecurityScanners: async () => ({ candidates: [], coverage: { examined: [], notExamined: [] } }),
      ...findingsDeps(alerts), verbose: false, ...deps
    }
  });
  return { id: start.id, result, alerts, sp: sweepPaths(root, start.id) };
}

// A fake headless runner that records every call (role, prompt, args) and answers through `answer`.
function recordingRun(rec, answer = null) {
  rec.calls = [];
  const base = fakeRun({});
  return async (opts) => {
    rec.calls.push(opts);
    return (answer && (await answer(opts))) || base(opts);
  };
}

// The live-stage fakes: proxy, Playwright config, the probe and the browser environment.
function liveDeps(rec) {
  rec.proxies = [];
  rec.mcp = [];
  return {
    startAllowListProxy: async (o) => { rec.proxies.push(o); return { url: "http://127.0.0.1:1", close: async () => { rec.closed = (rec.closed || 0) + 1; } }; },
    mcpConfigFor: (root, outDir, o) => { rec.mcp.push(o); return path.join(outDir, "mcp.json"); },
    playwrightDisallowed: ["mcp__playwright__browser_run_code_unsafe", "mcp__playwright__browser_run_code"],
    checkerEnv: (e) => e,
    runHttpProbe: async (a) => { rec.probe = a; return { candidates: [], coverage: { examined: ["probe"], notExamined: [] } }; }
  };
}

function withUsers(root) {
  fs.mkdirSync(path.join(root, "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, "secrets", "u.json"), JSON.stringify({ loginUrl: "/login", users: [{ label: "user A", username: "a@example.com", password: "Pw-unit-7781" }, { label: "user B", username: "b@example.com", password: "Pw-unit-7782" }] }));
  return { file: "secrets/u.json" };
}

const argAfter = (args, flag) => args[args.indexOf(flag) + 1];

test("a read-only target gets no full browser session: a read-only browse behind a GET/HEAD proxy over http, the probe alone over https; logins go to full targets only", async () => {
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec);
  const options = {
    modules: ["live"], depth: "quick", after: "report", writesAllowed: true, testUsers: withUsers(root),
    targets: [{ url: "http://127.0.0.1:4100", mode: "readonly" }, { url: "https://prod.example.com", mode: "readonly" }, { url: "http://staging.example.com:8080", mode: "full" }]
  };
  const { result, sp } = await startAndRun(root, "security", options, { run, ...liveDeps(rec) });
  assert.equal(result.status, "done", result.error);
  // The probe checks every target (GET and HEAD only on the read-only ones, in probe.js).
  assert.deepEqual(rec.probe.targets.map((t) => t.url), options.targets.map((t) => t.url));
  const browserRoles = rec.calls.filter((c) => /^sweep-browser-/.test(c.role)).map((c) => c.role);
  assert.deepEqual(browserRoles.sort(), ["sweep-browser-0", "sweep-browser-2"], "no session on the read-only https target");
  // Each session gets its own proxy for its own target: GET/HEAD on the read-only one.
  const byOrigin = (list, key) => [...list].sort((a, b) => JSON.stringify(key(a)).localeCompare(JSON.stringify(key(b))));
  assert.deepEqual(byOrigin(rec.proxies, (p) => p.allow).map((p) => p.allow), [[{ origin: "http://127.0.0.1:4100", methods: ["GET", "HEAD"] }], [{ origin: "http://staging.example.com:8080", methods: "*" }]]);
  const mcp = byOrigin(rec.mcp, (m) => m.allowedOrigins);
  assert.deepEqual(mcp.map((m) => m.allowedOrigins), [["http://127.0.0.1:4100"], ["http://staging.example.com:8080"]]);
  // The passwords reach only the full target's browser.
  assert.equal(mcp[0].secretsFile, null);
  assert.equal(mcp[1].secretsFile, sp.usersEnvFile);
  assert.equal(proxyRuleFor({ target: { url: "http://x.example" }, mode: "readonly" }).methods.join(","), "GET,HEAD");
  // A "full" target without writes allowed is read-only too, as the proxy and the probe treat it.
  const noWrites = browserPlan(normalizeOptions("security", { modules: ["live"], targets: [{ url: "http://staging.example.com:8080", mode: "full" }] }, CONFIG));
  assert.equal(noWrites.sessions[0].mode, "readonly");
  assert.deepEqual(proxyRuleFor(noWrites.sessions[0]), { origin: "http://staging.example.com:8080", methods: ["GET", "HEAD"] });
  const ro = rec.calls.find((c) => c.role === "sweep-browser-0").prompt;
  const full = rec.calls.find((c) => c.role === "sweep-browser-2").prompt;
  assert.match(ro, /A read-only browse of this target/);
  assert.match(ro, /- `idor`: it needs a login/);
  assert.match(ro, /- `csrf`: it submits forms/);
  assert.doesNotMatch(ro, /SWEEP_USER_A_PASSWORD|a@example\.com/);
  assert.doesNotMatch(ro, /staging\.example\.com/, "a session sees only its own target");
  assert.match(full, /A full session on this target/);
  assert.match(full, /username a@example\.com; for the password, type exactly SWEEP_USER_A_PASSWORD/);
  assert.match(full, /Run only these kinds of check: `idor`, `xss`, `csrf`, `redirects`\./);
  // The https target is reported as not checked by the browser, with the reason.
  const skipped = JSON.parse(fs.readFileSync(path.join(sp.agentsDir, "browser-1.json"), "utf8"));
  assert.equal(skipped.skipped, true);
  assert.match(skipped.structured.coverage.notExamined[0], /^browser checks on https:\/\/prod\.example\.com: not run \(a read-only https target/);
  assert.equal(fs.existsSync(sp.usersEnvFile), false);
});

test("options.tests reach the browser: switched-off kinds are named as not to run, and with all four off no browser session starts", async () => {
  const opts = (tests) => normalizeOptions("security", { modules: ["live"], writesAllowed: true, tests, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, CONFIG);
  const some = browserChecks(opts({ xss: false, csrf: false }), { url: "http://127.0.0.1:4100", mode: "full" });
  assert.deepEqual(some.run, ["idor", "redirects"]);
  assert.deepEqual(some.skip.map((s) => [s.kind, s.why]), [["xss", "switched off by the owner"], ["csrf", "switched off by the owner"]]);
  const none = browserPlan(opts({ idor: false, xss: false, csrf: false, redirects: false }));
  assert.equal(none.sessions.length, 0);
  assert.match(none.skipped[0].why, /^browser checks on http:\/\/127\.0\.0\.1:4100: not run \(idor: switched off by the owner; xss/);
  // verboseErrors is a test kind too, so the probe's switch for it can be turned off.
  assert.equal(normalizeOptions("security", { tests: { verboseErrors: false } }, CONFIG).tests.verboseErrors, false);

  // End to end: the prompt says what not to run; the probe gets the switches.
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec);
  const { result } = await startAndRun(root, "security", { modules: ["live"], depth: "quick", after: "report", writesAllowed: true, testUsers: withUsers(root), tests: { xss: false, csrf: false, verboseErrors: false }, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, { run, ...liveDeps(rec) });
  assert.equal(result.status, "done", result.error);
  const prompt = rec.calls.find((c) => c.role === "sweep-browser-0").prompt;
  assert.match(prompt, /Run only these kinds of check: `idor`, `redirects`\./);
  assert.match(prompt, /- `xss`: switched off by the owner\.\n- `csrf`: switched off by the owner\./);
  assert.equal(rec.probe.tests.verboseErrors, false);
  // All four off: no browser at all.
  const root2 = makeProject();
  const rec2 = {};
  const run2 = recordingRun(rec2);
  const r2 = await startAndRun(root2, "security", { modules: ["live"], depth: "quick", after: "report", tests: { idor: false, xss: false, csrf: false, redirects: false }, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, { run: run2, ...liveDeps(rec2) });
  assert.equal(r2.result.status, "done", r2.result.error);
  assert.ok(!rec2.calls.some((c) => /^sweep-browser-/.test(c.role)));
  assert.equal(rec2.proxies.length, 0);
});

test("every map, reviewer, verifier and browser session denies the tools that write, run commands or reach the network", async () => {
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec);
  const { result } = await startAndRun(root, "security", { modules: ["code", "live"], depth: "standard", after: "report", writesAllowed: true, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, { run, ...liveDeps(rec) });
  assert.equal(result.status, "done", result.error);
  const kinds = new Set();
  for (const c of rec.calls) {
    const denied = argAfter(c.args, "--disallowedTools").split(",");
    for (const t of ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]) assert.ok(denied.includes(t), `${c.role} denies ${t}`);
    if (c.role.startsWith("sweep-browser-")) {
      assert.ok(denied.includes("mcp__playwright__browser_run_code_unsafe") && denied.includes("mcp__playwright__browser_evaluate"), c.role);
      kinds.add("browser");
    } else kinds.add(c.role === "sweep-map" ? "map" : c.role.startsWith("verify-") ? "verify" : "review");
  }
  assert.deepEqual([...kinds].sort(), ["browser", "map", "review", "verify"]);
  assert.deepEqual(SESSION_DISALLOWED.slice(), ["Bash", "PowerShell", "Write", "Edit", "MultiEdit", "NotebookEdit", "WebFetch", "WebSearch"]);
});

// Built at runtime so no key-shaped literal sits in the source (GitHub push protection).
const PLANTED = ["sk", "live", "Zq81mXvT0pLr5WcY3nKd7HsB2e"].join("_");

test("agents/*.json, the log and the store keep no secret a session quoted, its error text included", async () => {
  const root = makeProject();
  const rec = {};
  let failedOnce = false;
  const run = recordingRun(rec, async ({ role }) => {
    if (role === "sweep-area-src") return okResult({ findings: [{ category: "secrets", severity: "high", file: "src/app.js", line: 1, evidence: `const KEY = "${PLANTED}"`, impact: "a key", fix: "move it", testIdea: "t", confidence: 8 }], coverage: { examined: ["src"], notExamined: [] }, notes: `the token is ${PLANTED}` });
    if (role.startsWith("verify-")) return okResult({ verdict: "confirmed", reason: `the value ${PLANTED} is live`, severity: "high" });
    if (role === "sweep-area-lib" && !failedOnce) { failedOnce = true; return { ok: false, infra: true, rateLimited: false, structured: null, error: `claude ended with error: saw ${PLANTED}` }; }
    return null;
  });
  const { result, sp } = await startAndRun(root, "security", { modules: ["code"], depth: "standard", after: "report" }, { run });
  assert.equal(result.status, "done", result.error);
  let text = "";
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else text += fs.readFileSync(p, "utf8"); } };
  walk(sp.dir);
  assert.ok(text.includes("sk_l"), "the masked form is kept");
  assert.ok(!text.includes(PLANTED), "no file in the sweep folder holds the raw value");
});

test("a failed session is retried once at once, and a failed one saved earlier runs again on resume", async () => {
  const root = makeProject();
  const rec = {};
  const tries = {};
  const run = recordingRun(rec, async ({ role }) => {
    tries[role] = (tries[role] || 0) + 1;
    if (role === "sweep-area-src" && tries[role] === 1) return { ok: false, infra: true, rateLimited: false, structured: null, error: "API overloaded" };
    return null;
  });
  const { result, sp } = await startAndRun(root, "security", { modules: ["code"], depth: "quick", after: "report" }, { run });
  assert.equal(result.status, "done", result.error);
  assert.equal(tries["sweep-area-src"], 2);
  const saved = JSON.parse(fs.readFileSync(path.join(sp.agentsDir, "area-src.json"), "utf8"));
  assert.deepEqual([saved.ok, saved.attempts], [true, 2]);

  // Resume: a reviewer saved as failed by an earlier pass is run again; a finished one is not.
  const root2 = makeProject();
  const { io } = makeIo(root2);
  const git = fakeGit();
  const start = await startSweep({ root: root2, kind: "security", options: { modules: ["code"], after: "report", depth: "quick" }, config: CONFIG, io, deps: { git, openConsoleWindow: () => ({}), readUsage: USAGE_OK } });
  const sp2 = sweepPaths(root2, start.id);
  fs.writeFileSync(path.join(sp2.agentsDir, "area-lib.json"), JSON.stringify({ name: "area-lib", ok: false, error: "timed out after 900 s", structured: null }));
  fs.writeFileSync(path.join(sp2.agentsDir, "area-src.json"), JSON.stringify({ name: "area-src", ok: true, structured: { findings: [], coverage: { examined: ["src"], notExamined: [] }, notes: "" } }));
  const s = readSweep(root2, start.id); s.stage = "review"; fs.writeFileSync(sp2.sweepFile, JSON.stringify(s));
  const rec2 = {};
  await runSweep({ root: root2, id: start.id, io, deps: { config: CONFIG, git, run: recordingRun(rec2), readUsage: USAGE_OK, sleep: async () => {}, ...findingsDeps([]), verbose: false } });
  const roles = rec2.calls.map((c) => c.role);
  assert.ok(roles.includes("sweep-area-lib"), "the failed reviewer runs again");
  assert.ok(!roles.includes("sweep-area-src"), "the finished one does not");
});

test("thorough verification: a finding with one vote and two failed verifiers is uncertain, never confirmed", async () => {
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec, async ({ role }) => {
    if (/^verify-SEC-001-[23]$/.test(role)) return { ok: false, infra: true, rateLimited: false, structured: null, error: "timed out after 900 s" };
    return null;
  });
  const { result, sp } = await startAndRun(root, "security", { modules: ["code"], depth: "thorough", after: "report" }, { run });
  assert.equal(result.status, "done", result.error);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const f = store.findings.find((x) => x.id === "SEC-001");
  assert.deepEqual(f.votes, { confirmed: 1, refuted: 0, uncertain: 0, failed: 2 });
  assert.equal(f.verdict, "uncertain");
  // Each failed verifier was tried twice.
  assert.equal(rec.calls.filter((c) => c.role === "verify-SEC-001-2").length, 2);
});

test("liveness: sweep.json carries the driver's pid and heartbeat; sweep-run refuses a sweep whose driver is alive; a dead one shows as stopped and is found for the watchdog", async () => {
  const root = makeProject();
  const rec = {};
  const seen = [];
  const run = recordingRun(rec, async ({ role }) => {
    if (role === "sweep-map") { const s = readSweep(root, sweepsList(root)[0]); seen.push([s.pid, typeof s.heartbeatAt]); }
    return null;
  });
  const { id, result } = await startAndRun(root, "security", { modules: ["code"], depth: "quick", after: "report" }, { run });
  assert.equal(result.status, "done", result.error);
  assert.deepEqual(seen, [[process.pid, "string"]]);
  assert.equal(readSweep(root, id).pid, null, "the pid is cleared when the driver ends");

  // A sweep another live process drives is refused, and nothing runs.
  const root2 = makeProject();
  const { io } = makeIo(root2);
  const start = await startSweep({ root: root2, kind: "security", options: { modules: ["code"], after: "report", depth: "quick" }, config: CONFIG, io, deps: { git: fakeGit(), openConsoleWindow: () => ({}), readUsage: USAGE_OK } });
  const sp2 = sweepPaths(root2, start.id);
  const s2 = readSweep(root2, start.id); s2.pid = 4242; s2.heartbeatAt = new Date().toISOString(); fs.writeFileSync(sp2.sweepFile, JSON.stringify(s2));
  const rec2 = {};
  const r2 = await runSweep({ root: root2, id: start.id, io, deps: { config: CONFIG, git: fakeGit(), run: recordingRun(rec2), isPidAlive: (pid) => pid === 4242, ...findingsDeps([]), verbose: false } });
  assert.equal(r2.ok, false);
  assert.match(r2.error, /already being driven by process 4242/);
  assert.equal(rec2.calls.length, 0);
  assert.equal(readSweep(root2, start.id).pid, 4242, "the owner's record is left alone");
  // A second sweep of the same kind is refused while that one is alive.
  const again = await startSweep({ root: root2, kind: "security", options: { modules: ["code"], after: "report" }, config: CONFIG, io: makeIo(root2, new Date("2026-10-02T10:00:00")).io, deps: { git: fakeGit(), openConsoleWindow: () => ({}), isPidAlive: (pid) => pid === 4242 } });
  assert.equal(again.ok, false);
  assert.match(again.error, /already running/);

  // Liveness of hand-made records.
  const root3 = makeProject();
  const now = Date.parse("2026-10-02T12:00:00Z");
  const iso = (msAgo) => new Date(now - msAgo).toISOString();
  const put = (id, s) => { const sp = sweepPaths(root3, id); fs.mkdirSync(sp.dir, { recursive: true }); fs.writeFileSync(sp.sweepFile, JSON.stringify({ id, kind: "security", startedAt: iso(3600000), ...s })); };
  put("a-dead", { status: "running", pid: 1111, heartbeatAt: iso(10 * 60000), updatedAt: iso(10 * 60000) });
  put("b-alive", { status: "waiting", pid: 2222, heartbeatAt: iso(30000), updatedAt: iso(30000) });
  put("c-starting", { status: "running", startedAt: iso(30000), updatedAt: iso(30000) });
  put("d-stale", { status: "running", pid: 3333, heartbeatAt: iso(2 * 86400000), updatedAt: iso(2 * 86400000), startedAt: iso(2 * 86400000) });
  put("e-paused", { status: "paused", pid: null, updatedAt: iso(60000) });
  put("f-reused-pid", { status: "running", pid: 2222, heartbeatAt: iso(40 * 60000), updatedAt: iso(40 * 60000) });
  ensureSweepsIgnored(root3);
  const isAlive = (pid) => pid === 2222;
  // The watchdog's contract: whole records (id, status, pid, heartbeatAt), not bare ids.
  const dead = findDeadSweeps(root3, { now, isAlive });
  assert.deepEqual(dead.map((s) => s.id).sort(), ["a-dead", "f-reused-pid"]);
  const a = dead.find((s) => s.id === "a-dead");
  assert.deepEqual([a.status, a.pid, a.heartbeatAt, a.liveness], ["running", 1111, iso(10 * 60000), "dead"]);
  const byId = Object.fromEntries(sweepStatus(root3, { now, isAlive }).sweeps.map((s) => [s.id, s]));
  assert.equal(byId["a-dead"].displayStatus, "stopped (window gone)");
  assert.equal(byId["a-dead"].resumeCommand, "autoclaude sweep-run a-dead");
  assert.equal(byId["b-alive"].displayStatus, "waiting");
  assert.equal(byId["c-starting"].liveness, "starting");
  assert.equal(byId["e-paused"].resumeCommand, "autoclaude sweep-run e-paused");
  assert.equal(sweepLiveness(byId["e-paused"], { now, isAlive }), null);
  assert.ok(findActiveSweeps(root3, { now, isAlive }).some((s) => s.id === "a-dead" && s.displayStatus === "stopped (window gone)"));
  // The watchdog relaunches a dead one with the same window the start opened.
  const opened = [];
  const w = openSweepWindow({ root: root3, id: "a-dead", env: {}, open: (o) => { opened.push(o); return { method: "windows-console" }; } });
  assert.match(w.title, /^ac-sweep-/);
  assert.deepEqual(opened[0].args.slice(-3), ["sweep-run", "--auto", "a-dead"]);
});

function sweepsList(root) {
  return fs.readdirSync(sweepsDir(root), { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
}

test("the sweeps folder carries its own .gitignore, so exploit details stay out of git even when the project's .gitignore lost .autoclaude/", async () => {
  const root = makeProject();
  const { io } = makeIo(root);
  const r = await startSweep({ root, kind: "security", options: { modules: ["code"], after: "report" }, config: CONFIG, io, deps: { git: fakeGit(), openConsoleWindow: () => ({}), readUsage: USAGE_OK } });
  assert.equal(r.ok, true, r.error);
  assert.match(fs.readFileSync(path.join(sweepsDir(root), ".gitignore"), "utf8"), /^\*$/m);
  // With real git, nothing under the sweeps folder shows up as untracked.
  const { spawnSync } = await import("node:child_process");
  if (spawnSync("git", ["--version"], { stdio: "ignore" }).status !== 0) return;
  spawnSync("git", ["init", "-q"], { cwd: root });
  fs.writeFileSync(path.join(sweepPaths(root, r.id).dir, "report.md"), "how to reproduce: ...\n");
  const st = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" });
  assert.equal(st.status, 0);
  assert.doesNotMatch(st.stdout, /sweeps/);
});

test("the three-proof rule binds session candidates: an unused file or package no tool flagged is report only (tier C); one the scanner proved keeps tier A", async () => {
  const proofs = { files: new Set(["lib/util.js"]), deps: [{ manifest: "package.json", name: "left-pad" }] };
  const s = (f) => ({ source: "session area-src", tier: "A", autoFixSafe: true, ...f });
  assert.equal(requireUnusedProof(s({ category: "unused-file", file: "src/app.js" }), proofs).tier, "C");
  assert.equal(requireUnusedProof(s({ category: "unused-file", file: "./lib/util.js" }), proofs).tier, "A");
  assert.equal(requireUnusedProof(s({ category: "unused-dependency", file: "package.json", title: "left-pad is never imported" }), proofs).tier, "A");
  assert.equal(requireUnusedProof(s({ category: "unused-dependency", file: "package.json", title: "left-padding is never imported" }), proofs).tier, "C");
  assert.equal(requireUnusedProof(s({ category: "unused-dependency", file: "package.json", evidence: "lodash is declared but unused" }), proofs).tier, "C");
  // Scanner candidates carry their proof; other categories are untouched.
  assert.equal(requireUnusedProof({ source: "scanner optimize", category: "unused-file", file: "x.js", tier: "A" }, proofs).tier, "A");
  assert.equal(requireUnusedProof(s({ category: "commented-out", file: "src/app.js" }), proofs).tier, "A");

  // End to end on an optimize sweep: the merge applies it.
  const root = makeProject();
  const run = recordingRun({}, async ({ role }) => {
    if (role === "sweep-area-src") {
      return okResult({ findings: [
        { category: "unused-file", severity: "low", file: "src/app.js", line: 0, evidence: "no import found by grep", impact: "dead", fix: "delete it", testIdea: "t", confidence: 8, tier: "A" },
        { category: "unused-file", severity: "low", file: "lib/util.js", line: 0, evidence: "knip flags it", impact: "dead", fix: "delete it", testIdea: "t", confidence: 8, tier: "A" }
      ], coverage: { examined: ["src"], notExamined: [] }, notes: "" });
    }
    if (/^sweep-area-/.test(role)) return okResult({ findings: [], coverage: { examined: [role], notExamined: [] }, notes: "" });
    return null;
  });
  const { result, sp } = await startAndRun(root, "optimize", { modules: ["unused"], depth: "quick", after: "report" }, {
    run,
    recordBaseline: async () => ({ version: 1, checksGreen: true, coverage: { examined: [], notExamined: [] } }),
    runOptimizeScanners: async ({ sweepDir }) => {
      fs.writeFileSync(path.join(sweepDir, "scanners", "unused.json"), JSON.stringify({ files: { kept: ["lib/util.js"], dropped: [] }, exports: { kept: [], dropped: [] }, dependencies: { kept: [], dropped: [] } }));
      return { candidates: [], coverage: { examined: [], notExamined: [] }, leads: [] };
    }
  });
  assert.equal(result.status, "done", result.error);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const tierOf = (file) => store.findings.find((f) => f.file === file).tier;
  assert.equal(tierOf("src/app.js"), "C");
  assert.equal(tierOf("lib/util.js"), "A");
  assert.ok(store.coverage.notExamined.some((n) => /^1 unused file or package candidate from the review sessions: not deleted automatically/.test(n)));
  assert.deepEqual(unusedProofs(sp).files, new Set(["lib/util.js"]));
});

// P10.14: the live proof listed lib/legacy.js twice (knip's whole-file hit and a reviewer's line
// 1) and the formatList copy twice (once from each end). The merge stage, with the real findings
// helpers, makes each one finding.
test("the merge stage makes a whole-file scanner hit and a reviewer's line in that file one finding, and a copy seen from both ends one finding naming both", async () => {
  const root = makeProject();
  const run = recordingRun({}, async ({ role }) => {
    if (role === "sweep-area-src") {
      return okResult({ findings: [
        { category: "unused-file", title: "Delete unused lib/util.js", severity: "low", file: "lib/util.js", line: 1, evidence: "export const util = 2; is imported nowhere", impact: "dead", fix: "git rm lib/util.js", testIdea: "t", confidence: 9, tier: "A" },
        { category: "duplicate", title: "src/app.js repeats the constant of lib/util.js", severity: "low", file: "src/app.js", line: 1, evidence: "src/app.js:1 has the same constant as lib/util.js:1", impact: "i", fix: "f", testIdea: "t", confidence: 6, tier: "B" },
        { category: "duplicate", title: "lib/util.js is copied in src/app.js", severity: "low", file: "lib/util.js", line: 1, evidence: "lib/util.js:1 is repeated at src/app.js:1", impact: "i", fix: "f", testIdea: "t", confidence: 6, tier: "B" }
      ], coverage: { examined: ["src"], notExamined: [] }, notes: "" });
    }
    if (/^sweep-area-/.test(role)) return okResult({ findings: [], coverage: { examined: [role], notExamined: [] }, notes: "" });
    return null;
  });
  const knipHit = { kind: "optimize", title: "lib/util.js is not used anywhere", category: "unused-file", severity: "low", confidence: 7, file: "lib/util.js", line: 0, tier: "A", autoFixSafe: true, tool: "knip 6.39.0 + reference search",
    evidence: "knip flags the file as unused; a search of the whole repository finds no reference to it, and it matches no entry-point convention.", impact: "1 line read for nothing.", fix: "Delete the file (git keeps the history).", testIdea: "t" };
  const { result, sp } = await startAndRun(root, "optimize", { modules: ["unused", "duplicates"], depth: "quick", after: "report" }, {
    run,
    dedupe: findingsLib.dedupe, loadAccepted: findingsLib.loadAccepted, applyAccepted: findingsLib.applyAccepted, numberFindings: findingsLib.numberFindings,
    recordBaseline: async () => ({ version: 1, checksGreen: true, coverage: { examined: [], notExamined: [] } }),
    runOptimizeScanners: async ({ sweepDir }) => {
      fs.writeFileSync(path.join(sweepDir, "scanners", "unused.json"), JSON.stringify({ files: { kept: ["lib/util.js"], dropped: [] }, exports: { kept: [], dropped: [] }, dependencies: { kept: [], dropped: [] } }));
      return { candidates: [knipHit], coverage: { examined: [], notExamined: [] }, leads: [] };
    }
  });
  assert.equal(result.status, "done", result.error);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  assert.equal(store.findings.length, 2, JSON.stringify(store.findings.map((f) => [f.id, f.category, f.file, f.line])));
  const unused = store.findings.find((f) => f.category === "unused-file");
  assert.deepEqual([unused.file, unused.line, unused.title, unused.tier], ["lib/util.js", 1, "Delete unused lib/util.js", "A"]);
  assert.deepEqual(unused.sources.sort(), ["scanner optimize", "session area-src"]);
  assert.equal(unused.fingerprints.length, 2);
  const copy = store.findings.find((f) => f.category === "duplicate");
  assert.deepEqual(copy.locations, [{ file: "lib/util.js", line: 1 }, { file: "src/app.js", line: 1 }]);
  assert.equal(copy.fingerprints.length, 2);
  assert.match(fs.readFileSync(path.join(sp.dir, "sweep.log"), "utf8"), /merge: 4 candidate\(s\) -> 2 after dedupe/);
});

test("fix right away with a check that needs the dev server: the sweep starts it for the green-baseline test, or leaves only that check out with a note", async () => {
  const cfg = (extra = {}) => ({ ...CONFIG, devServer: { command: "node server.js", url: "http://127.0.0.1:4555", healthPath: "/", startTimeoutSec: 5 }, checks: [{ name: "unit", command: "x" }, { name: "e2e", command: "y", needsDevServer: true }], ...extra });
  const runIt = async (ensure) => {
    const root = makeProject();
    const checkCalls = [];
    const { result } = await startAndRun(root, "security", { modules: ["code"], depth: "quick", after: "fix" }, {
      generateFixPlan: () => ({ text: FIX_PLAN, file: "SECURITY_PLAN.md", stepCount: 1, problems: [] }),
      ensureDevServer: ensure, devServerInfo: () => null, stopDevServer: () => ({ stopped: true }),
      runChecks: async (checks, o) => { checkCalls.push({ names: checks.map((c) => c.name), devServerReady: o.devServerReady }); return { ok: true, results: [], failed: null }; }
    }, { config: cfg() });
    return { result, checkCalls };
  };
  const up = await runIt(async () => ({ ok: true, reused: false, pid: 777, url: "http://127.0.0.1:4555" }));
  assert.equal(up.result.after, "fix", up.result.fixRefused);
  assert.equal(up.result.startRun, true);
  assert.deepEqual(up.checkCalls, [{ names: ["unit", "e2e"], devServerReady: true }]);
  const down = await runIt(async () => ({ ok: false, error: "did not answer within 5 s" }));
  assert.equal(down.result.after, "fix", down.result.fixRefused);
  assert.deepEqual(down.checkCalls, [{ names: ["unit"], devServerReady: false }]);
  assert.match(down.result.checksNote, /^e2e not judged before the fix run: it needs the dev server, which did not start \(did not answer within 5 s\)/);
});

test("the sweep stops only a dev server it started itself, and never one a run uses or has restarted", async () => {
  const DEV = "http://127.0.0.1:4777";
  const config = { ...CONFIG, devServer: { command: "node server.js", url: DEV, healthPath: "/", startTimeoutSec: 5 } };
  const variant = async ({ ensureResult, infoAfter, runState = null }) => {
    const root = makeProject();
    if (runState) { fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true }); fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), JSON.stringify({ version: 1, status: runState })); }
    const rec = { stops: 0, ensured: false };
    const r = await startAndRun(root, "security", { modules: ["live"], depth: "quick", after: "report", targets: [{ url: DEV, mode: "readonly" }], tests: { idor: false, xss: false, csrf: false, redirects: false } }, {
      ...liveDeps(rec),
      ensureDevServer: async () => { rec.ensured = true; return ensureResult; },
      devServerInfo: () => (rec.ensured ? infoAfter : null),
      stopDevServer: () => { rec.stops++; return { stopped: true }; }
    }, { config });
    assert.equal(r.result.status, "done", r.result.error);
    assert.equal(rec.ensured, true);
    return rec.stops;
  };
  // Started by this sweep, still the one running, no run about: stopped.
  assert.equal(await variant({ ensureResult: { ok: true, reused: false, pid: 777, url: DEV }, infoAfter: { pid: 777, startedByUs: true } }), 1);
  // Found answering (the run's gate started it after the sweep began): left alone.
  assert.equal(await variant({ ensureResult: { ok: true, reused: true, url: DEV }, infoAfter: { pid: 555, startedByUs: true } }), 0);
  // Started by the sweep, but a run's gate restarted it since (another pid): the run's now.
  assert.equal(await variant({ ensureResult: { ok: true, reused: false, pid: 777, url: DEV }, infoAfter: { pid: 888, startedByUs: true } }), 0);
  // Started by the sweep while a run is running: the run may be using it.
  assert.equal(await variant({ ensureResult: { ok: true, reused: false, pid: 777, url: DEV }, infoAfter: { pid: 777, startedByUs: true }, runState: "running" }), 0);
});

test("the estimate counts the probe's hits on live targets and says that every scanner hit adds verifier sessions; the merge records the real count", async () => {
  const inv = { areas: [{ name: "a", files: [], bytes: 0 }], byExt: {}, stack: {}, fileCount: 1, totalBytes: 0 };
  const codeOnly = estimateSweep(normalizeOptions("security", { modules: ["code"], depth: "thorough" }, CONFIG), inv);
  const live = estimateSweep(normalizeOptions("security", { modules: ["code", "live"], depth: "thorough", targets: [{ url: "http://a.example" }, { url: "http://b.example" }] }, CONFIG), inv);
  assert.equal(live.verifiers - codeOnly.verifiers, 2 * 4 * 3, "four usual probe hits per target, three verifiers each");
  const text = formatEstimate(live, normalizeOptions("security", { depth: "thorough" }, CONFIG));
  assert.match(text, /plus 3 verification sessions for every scanner hit \(package advisories, secrets, probe findings\)/);
  const known = estimateSweep(normalizeOptions("security", { modules: ["code"], depth: "thorough" }, CONFIG), inv, CONFIG, { deterministic: 10 });
  assert.equal(known.verifiers, (codeOnly.candidates - codeOnly.deterministicCandidates + 10) * 3);
  assert.doesNotMatch(formatEstimate(known, normalizeOptions("security", {}, CONFIG)), /plus \d+ verification/);
  // After the merge the sweep knows: scanner hits included.
  const root = makeProject();
  const { id, result } = await startAndRun(root, "security", { modules: ["code", "secrets"], depth: "thorough", after: "report" }, {
    runSecurityScanners: async () => ({ candidates: [{ category: "secrets", severity: "high", file: "src/app.js", line: 1, evidence: "a key", confidence: 8 }, { category: "dependencies", severity: "medium", file: "package.json", line: 0, evidence: "advisory", confidence: 8 }], coverage: { examined: [], notExamined: [] } })
  });
  assert.equal(result.status, "done", result.error);
  // Two scanner hits plus one candidate from each of the two area reviewers, three verifiers each.
  assert.equal(readSweep(root, id).verifySessions, 4 * 3);
});

test("a weekly pause records pauseReason, pausedAt and the weekly reset in sweep.json for the watchdog; the resume clears them", async () => {
  const root = makeProject();
  const now = Date.parse("2026-10-03T12:00:00Z");
  const resetsAt = Date.parse("2026-10-09T12:00:00Z");
  let pct = 91;
  const readUsage = () => ({ fiveHour: { pct: 5 }, sevenDay: { pct, resetsAt } });
  assert.deepEqual(gateDecision({ usage: readUsage(), waitAt5hPct: 90, weeklyPauseAtPct: 85, rateLimited: false, now, graceMs: 0 }), { action: "pause-weekly", pct: 91, resetsAt });
  const { id, result } = await startAndRun(root, "security", { modules: ["code"], depth: "quick", after: "report" }, { readUsage, now: () => now });
  assert.equal(result.status, "paused", result.error);
  const s = readSweep(root, id);
  assert.equal(s.status, "paused");
  assert.equal(s.pauseReason, "weekly-limit");
  assert.equal(s.weeklyResetsAt, new Date(resetsAt).toISOString());
  assert.ok(Number.isFinite(Date.parse(s.pausedAt)));
  assert.match(s.error, /weekly usage limit reached \(91%\)/);
  // The watchdog reads exactly that.
  const { isWeeklyPause, weeklyResetPassed } = await import("../../plugins/autoclaude/lib/watchdog.js");
  assert.equal(isWeeklyPause(s), true);
  assert.equal(weeklyResetPassed(s, null, { nowMs: resetsAt + 11 * 60000, graceMs: 10 * 60000, pauseAtPct: 85 }).passed, true);
  // Resumed after the reset: the pause record is gone and the sweep finishes.
  pct = 10;
  const again = await runSweep({ root, id, io: makeIo(root).io, deps: { config: CONFIG, git: fakeGit(), run: fakeRun({}), readUsage, sleep: async () => {}, now: () => now, runSecurityScanners: async () => ({ candidates: [], coverage: {} }), ...findingsDeps([]), verbose: false } });
  assert.equal(again.status, "done", again.error);
  const s2 = readSweep(root, id);
  assert.deepEqual([s2.pauseReason, s2.pausedAt, s2.weeklyResetsAt], [null, null, null]);
});

test("--no-browser (options.browser false): no browser session and no dev server for it, while optimize keeps its performance review", async () => {
  const dev = { ...CONFIG, devServer: { command: "node server.js", url: "http://127.0.0.1:3000", healthPath: "/", startTimeoutSec: 5 } };
  const o = normalizeOptions("optimize", { browser: false }, dev);
  assert.equal(o.browser, false);
  assert.ok(o.modules.includes("performance"), "the code-level performance review stays on");
  assert.equal(normalizeOptions("optimize", {}, dev).browser, undefined, "the browser is on unless switched off");
  const plan = browserPlan(o);
  assert.equal(plan.sessions.length, 0);
  assert.match(plan.skipped[0].why, /page timings on http:\/\/127\.0\.0\.1:3000: not run \(the browser was switched off for this sweep\)/);
  assert.equal(browserPlan(normalizeOptions("optimize", {}, dev)).sessions.length, 1);
  const inv = { areas: [{ name: "a", files: [], bytes: 0 }], byExt: {}, stack: {}, fileCount: 1, totalBytes: 0 };
  assert.equal(estimateSweep(o, inv, dev).browser, 0);

  // End to end: the performance module still reaches the reviewers, no browser runs, and the dev
  // server is never started for a walk that does not happen.
  const root = makeProject();
  const rec = {};
  let ensured = 0;
  const { result, sp } = await startAndRun(root, "optimize", { modules: ["performance"], depth: "quick", after: "report", browser: false }, {
    run: recordingRun(rec),
    ...liveDeps({}),
    ensureDevServer: async () => { ensured++; return { ok: true, reused: true }; },
    recordBaseline: async () => ({ version: 1, checksGreen: true, coverage: { examined: [], notExamined: [] } }),
    runOptimizeScanners: async () => ({ candidates: [], coverage: { examined: [], notExamined: [] }, leads: [] })
  }, { config: dev });
  assert.equal(result.status, "done", result.error);
  assert.equal(ensured, 0);
  assert.ok(!rec.calls.some((c) => /^sweep-browser-/.test(c.role)));
  assert.ok(rec.calls.some((c) => /^sweep-area-/.test(c.role)), "the code review runs");
  assert.equal(readSweep(root, sweepsList(root)[0]).options.browser, false);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  assert.ok(store.coverage.notExamined.some((n) => /the browser was switched off/.test(n)));
});

test("the fix plan is generated with the project's progress file and the sweep's start date and time, so its ids and title are its own", async () => {
  assert.deepEqual(sweepWhen("20261002-1430-security"), { date: "2026-10-02", stamp: "1430" });
  assert.deepEqual(sweepWhen("odd"), { date: null, stamp: null });
  const root = makeProject();
  fs.writeFileSync(path.join(root, "PROGRESS.md"), "- 2026-10-01 SF1.1 an earlier fix run (attempt 1)\n");
  let args = null;
  const { id, result } = await runReportSweep(root, "plan", { generateFixPlan: (a) => { args = a; return { text: FIX_PLAN, file: "SECURITY_PLAN.md" }; }, config: { ...CONFIG, docs: { progress: "PROGRESS.md" } } });
  assert.equal(result.after, "plan", result.error);
  assert.match(args.progressText, /SF1\.1 an earlier fix run/);
  assert.match(args.mainPlanText, /The app listens on 127\.0\.0\.1 only/);
  const when = sweepWhen(id);
  assert.deepEqual([args.date, args.stamp], [when.date, when.stamp]);
});

// ---------- the owner's stop, resumable sweeps, known passwords, leftovers, browser fixes, wrap-up ----------

// A started sweep (window faked) whose sweep.json is then given the `patch` fields.
async function startedSweep(root, kind = "security", { at = new Date("2026-10-02T09:15:00"), patch = {} } = {}) {
  const r = await startSweep({ root, kind, options: { modules: ["code"], after: "report", depth: "quick" }, config: CONFIG, io: makeIo(root, at).io, deps: { git: fakeGit(), openConsoleWindow: () => ({ method: "windows-console" }), readUsage: USAGE_OK, isPidAlive: () => false } });
  assert.equal(r.ok, true, r.error);
  const sp = sweepPaths(root, r.id);
  fs.writeFileSync(sp.sweepFile, JSON.stringify({ ...readSweep(root, r.id), ...patch }));
  return { id: r.id, sp };
}

const runDeps = (config, extra = {}) => ({ config, git: fakeGit(), readUsage: USAGE_OK, sleep: async () => {}, runSecurityScanners: async () => ({ candidates: [], coverage: {} }), ...findingsDeps([]), verbose: false, ...extra });

test("sweep-stop: marked stopped by the owner, its driver's process tree ended and its leftovers cleaned; the watchdog's lookups skip it, an engine-opened window leaves it alone, the owner's sweep-run resumes it", async () => {
  const root = makeProject();
  const beat = new Date().toISOString();
  const { id, sp } = await startedSweep(root, "security", { patch: { stage: "review", pid: 4242, heartbeatAt: beat, updatedAt: beat, devServerPid: 777 } });
  fs.writeFileSync(sp.usersEnvFile, "SWEEP_USER_A_PASSWORD='x'\n");
  const killed = [];
  let devStops = 0;
  const deps = { isPidAlive: (pid) => pid === 4242, killTree: (pid) => { killed.push(pid); return true; }, devServerInfo: () => ({ pid: 777 }), stopDevServer: () => { devStops++; return { stopped: true }; } };
  // Without an id: the sweep that is running.
  const r = stopSweep({ root, deps });
  assert.deepEqual([r.ok, r.id, r.from, r.stage, r.pid, r.killed, r.devServerStopped], [true, id, "running", "review", 4242, true, true]);
  assert.deepEqual(killed, [4242], "the driver's whole tree: the window, its sessions, browsers and proxies");
  assert.equal(devStops, 1, "the dev server the sweep started");
  assert.equal(fs.existsSync(sp.usersEnvFile), false, "the passwords' dotenv file the driver would have removed");
  const s = readSweep(root, id);
  assert.deepEqual([s.status, s.stoppedBy, s.stoppedFrom, s.pid, s.devServerPid], ["stopped", "owner", "running", null, null]);
  // The watchdog's lookups: neither dead nor going, so it is never opened again.
  const gone = { isAlive: () => false };
  assert.deepEqual(findDeadSweeps(root, gone), []);
  assert.deepEqual(findActiveSweeps(root, gone), []);
  const shown = sweepStatus(root, gone).sweeps[0];
  assert.deepEqual([shown.displayStatus, shown.resumeCommand, shown.stopCommand], ["stopped (by the owner)", `autoclaude sweep-run ${id}`, null]);
  assert.equal(stopSweep({ root, id, deps }).already, true);
  // A window the engine opened (sweep-run --auto) leaves it alone and runs nothing.
  const rec = {};
  const auto = await runSweep({ root, id, io: makeIo(root).io, deps: runDeps(CONFIG, { run: recordingRun(rec) }), auto: true });
  assert.deepEqual([auto.ok, auto.status, auto.already], [true, "stopped", true]);
  assert.equal(rec.calls.length, 0);
  assert.equal(readSweep(root, id).status, "stopped");
  // The owner's own sweep-run resumes it where it stopped, on purpose.
  const resumed = await runSweep({ root, id, io: makeIo(root).io, deps: runDeps(CONFIG, { run: recordingRun(rec) }) });
  assert.equal(resumed.status, "done", resumed.error);
  assert.ok(rec.calls.some((c) => /^sweep-area-/.test(c.role)));
  const after = readSweep(root, id);
  assert.deepEqual([after.status, after.stoppedAt, after.stoppedBy], ["done", null, null]);

  // Without an id and two going, it asks which; a finished one has nothing to stop.
  const root2 = makeProject();
  const a = await startedSweep(root2, "security");
  const b = await startedSweep(root2, "optimize");
  const two = stopSweep({ root: root2, deps: { isPidAlive: () => false } });
  assert.equal(two.ok, false);
  assert.deepEqual(two.choices.sort(), [a.id, b.id].sort());
  assert.match(two.error, /name the one to stop: `autoclaude sweep-stop <id>`/);
  fs.writeFileSync(a.sp.sweepFile, JSON.stringify({ ...readSweep(root2, a.id), status: "done" }));
  assert.match(stopSweep({ root: root2, id: a.id }).error, /has already finished; there is nothing to stop/);
  assert.match(stopSweep({ root: root2, id: "nope" }).error, /no sweep nope in this project/);
  assert.equal(stopSweep({ root: makeProject() }).ok, false);
});

test("a stop while the sweep runs ends its driver at the next check: the session under way is kept, nothing more is launched, no verdict comes from part of the votes, and the owner's resume carries on", async () => {
  const config = { ...CONFIG, sweep: { ...CONFIG.sweep, concurrency: 1 } };
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec, async ({ role }) => {
    if (/^sweep-area-/.test(role) && !rec.stoppedAt) {
      rec.stoppedAt = role;
      // The driver is this very process, so its tree is not ended: the driver must stop itself.
      const r = stopSweep({ root, deps: { killTree: (pid) => { rec.killed = pid; return true; } } });
      assert.equal(r.ok, true, r.error);
    }
    return null;
  });
  const { id, result, sp } = await startAndRun(root, "security", { modules: ["code"], depth: "standard", after: "report" }, { run }, { config });
  assert.equal(result.status, "stopped", result.error);
  assert.equal(rec.killed, undefined, "the driver's own process is never ended from inside");
  assert.deepEqual(rec.calls.map((c) => c.role), ["sweep-map", rec.stoppedAt], "nothing is launched after the stop");
  assert.ok(fs.existsSync(path.join(sp.agentsDir, `${rec.stoppedAt.replace(/^sweep-/, "")}.json`)), "the session under way is kept");
  const s = readSweep(root, id);
  assert.deepEqual([s.status, s.stage, s.pid], ["stopped", "review", null]);
  const rec2 = {};
  const again = await runSweep({ root, id, io: makeIo(root).io, deps: runDeps(config, { run: recordingRun(rec2) }) });
  assert.equal(again.status, "done", again.error);
  const roles = rec2.calls.map((c) => c.role);
  assert.ok(!roles.includes(rec.stoppedAt) && !roles.includes("sweep-map"), "finished sessions are not run again");
  assert.ok(roles.some((r) => /^sweep-area-/.test(r)) && roles.some((r) => r.startsWith("verify-")));

  // Stopped while the verifiers run (three per finding): no finding gets a verdict from one vote.
  const root2 = makeProject();
  const rec3 = {};
  const run3 = recordingRun(rec3, async ({ role }) => {
    if (role === "verify-SEC-001-1") stopSweep({ root: root2 });
    return null;
  });
  const r3 = await startAndRun(root2, "security", { modules: ["code"], depth: "thorough", after: "report" }, { run: run3 }, { config });
  assert.equal(r3.result.status, "stopped", r3.result.error);
  const store = JSON.parse(fs.readFileSync(r3.sp.storeFile, "utf8"));
  assert.ok(store.findings.length && store.findings.every((f) => f.verdict === null), JSON.stringify(store.findings.map((f) => f.verdict)));
  assert.equal(rec3.calls.filter((c) => c.role.startsWith("verify-")).length, 1);
});

test("a new sweep of a kind is refused beside a resumable one of that kind (window gone, or paused), naming sweep-run and sweep-stop; once given up, a new one starts", async () => {
  const root = makeProject();
  const old = new Date(Date.now() - 10 * 60000).toISOString();
  const { id } = await startedSweep(root, "security", { patch: { stage: "review", pid: 1111, heartbeatAt: old, updatedAt: old } });
  const later = (min) => makeIo(root, new Date(`2026-10-02T10:${String(min).padStart(2, "0")}:00`)).io;
  const deps = { git: fakeGit(), openConsoleWindow: () => ({ method: "windows-console" }), readUsage: USAGE_OK, isPidAlive: () => false };
  const opts = { modules: ["code"], after: "report", depth: "quick" };
  let r = await startSweep({ root, kind: "security", options: opts, config: CONFIG, io: later(1), deps });
  assert.equal(r.ok, false);
  assert.ok(r.error.startsWith(`a security sweep (${id}) stopped at stage review when its window closed`), r.error);
  assert.ok(r.error.includes(`carry it on with \`autoclaude sweep-run ${id}\``) && r.error.includes(`give it up with \`autoclaude sweep-stop ${id}\``), r.error);
  assert.deepEqual(sweepsList(root), [id], "nothing new was written");
  // Another kind is not held up.
  assert.equal((await startSweep({ root, kind: "optimize", options: opts, config: CONFIG, io: later(2), deps })).ok, true);
  // A paused one holds it up too.
  fs.writeFileSync(sweepPaths(root, id).sweepFile, JSON.stringify({ ...readSweep(root, id), status: "paused", pid: null, error: "weekly usage limit reached (91%)" }));
  r = await startSweep({ root, kind: "security", options: opts, config: CONFIG, io: later(3), deps });
  assert.ok(r.error.startsWith(`a security sweep (${id}) is paused at stage review (weekly usage limit reached (91%)); carry it on with`), r.error);
  // Given up with sweep-stop: a new one starts.
  assert.equal(stopSweep({ root, id, deps: { isPidAlive: () => false } }).ok, true);
  r = await startSweep({ root, kind: "security", options: opts, config: CONFIG, io: later(4), deps });
  assert.equal(r.ok, true, r.error);
});

test("the test users' passwords are masked as written in everything the sweep saves, beside the pattern masking", async () => {
  // Whole values, the longest first; a short one only where it stands alone, and never in a path field.
  assert.equal(maskSecrets("signed in with Hunter2Hunter2-b and Hunter2Hunter2", ["Hunter2Hunter2-b", "Hunter2Hunter2"]), `signed in with ${SECRET_MASK} and ${SECRET_MASK}`);
  assert.equal(maskSecrets("typed qwer, not qwerty", ["qwer"]), `typed ${SECRET_MASK}, not qwerty`);
  assert.equal(maskSecrets("src/qwer.js", ["qwer"], { structural: true }), "src/qwer.js");
  const root = makeProject();
  const users = withUsers(root);
  assert.deepEqual(testUserSecrets(root, { testUsers: users }).sort(), ["Pw-unit-7781", "Pw-unit-7782"]);
  assert.deepEqual(testUserSecrets(root, { testUsers: null }), []);
  // End to end: a browser session, a verifier and a failed reviewer all write them in plain words.
  const [pwA, pwB] = ["Pw-unit-7781", "Pw-unit-7782"];
  let failed = false;
  const run = recordingRun({}, async ({ role }) => {
    if (role === "sweep-browser-0") {
      return okResult({
        findings: [{ kind: "security", category: "idor", title: "user A reads user B's order", severity: "high", file: "/orders/2", line: 0, evidence: `signed in as user A with ${pwA}, opened /orders/2`, impact: "i", reproduce: `log in as a@example.com / ${pwA}`, fix: "check the owner", testIdea: "t", confidence: 8, autoFixSafe: true }],
        coverage: { examined: [`user B (${pwB})`], notExamined: [] },
        notes: `Signed in as user A (alice) with ${pwA}, then as user B with ${pwB}`
      });
    }
    if (role.startsWith("verify-")) return okResult({ verdict: "confirmed", reason: `logged in with ${pwA} and saw it`, severity: "high" });
    if (role === "sweep-area-src" && !failed) { failed = true; return { ok: false, infra: true, rateLimited: false, structured: null, error: `claude ended with error: typed ${pwB}` }; }
    return null;
  });
  const { result, sp } = await startAndRun(root, "security", { modules: ["code", "live"], depth: "standard", after: "report", writesAllowed: true, testUsers: users, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, { run, ...liveDeps({}) });
  assert.equal(result.status, "done", result.error);
  let text = "";
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else text += fs.readFileSync(p, "utf8"); } };
  walk(sp.dir);
  assert.ok(text.includes(SECRET_MASK), "the masked form is kept");
  assert.ok(!text.includes("Pw-unit-778"), "no file in the sweep folder holds a test password");
});

test("a session's leftover that deletes a whole file needs the same proof as an unused file: tier C without it", async () => {
  const proofs = { files: new Set(["lib/old.js"]), deps: [] };
  const s = (f) => ({ source: "session area-src", category: "leftover", tier: "A", autoFixSafe: true, file: "src/reports/legacy.js", line: 12, title: "Leftover of the reports feature", fix: "remove the debug log", ...f });
  assert.equal(removesWholeFile(s({ line: 0 })), true, "line 0 is the whole file");
  assert.equal(removesWholeFile(s({ fix: "Remove src/reports/legacy.js, the remains of the removed reports feature" })), true);
  assert.equal(removesWholeFile(s({ fix: "Delete `legacy.js`" })), true);
  assert.equal(removesWholeFile(s({ fix: "delete the whole file" })), true);
  assert.equal(removesWholeFile(s({ fix: "git rm it" })), true);
  assert.equal(removesWholeFile(s({ fix: "Remove the debug console.log on this line" })), false);
  assert.equal(removesWholeFile(s({ fix: "Remove the unused key legacyMode from src/reports/legacy.json" })), false);
  assert.equal(requireUnusedProof(s({ line: 0 }), proofs).tier, "C");
  assert.deepEqual(Object.values((({ tier, autoFixSafe }) => ({ tier, autoFixSafe }))(requireUnusedProof(s({ fix: "Remove src/reports/legacy.js" }), proofs))), ["C", false]);
  assert.equal(requireUnusedProof(s({}), proofs).tier, "A", "a leftover line keeps its tier");
  assert.equal(requireUnusedProof(s({ file: "lib/old.js", line: 0 }), proofs).tier, "A", "the scanner proved the file unused");
  assert.equal(requireUnusedProof({ ...s({ line: 0 }), source: "scanner optimize" }, proofs).tier, "A");

  // End to end on an optimize sweep.
  const root = makeProject();
  const run = recordingRun({}, async ({ role }) => {
    if (role === "sweep-area-src") {
      return okResult({ findings: [
        { category: "leftover", severity: "low", file: "src/app.js", line: 0, evidence: "the reports feature was removed", impact: "dead", fix: "Remove src/app.js, the remains of the removed reports feature", testIdea: "t", confidence: 8, tier: "A" },
        { category: "leftover", severity: "low", file: "src/app.js", line: 3, evidence: "console.log(debug)", impact: "noise", fix: "remove the debug log", testIdea: "t", confidence: 8, tier: "A" }
      ], coverage: { examined: ["src"], notExamined: [] }, notes: "" });
    }
    if (/^sweep-area-/.test(role)) return okResult({ findings: [], coverage: { examined: [role], notExamined: [] }, notes: "" });
    return null;
  });
  const { result, sp } = await startAndRun(root, "optimize", { modules: ["duplicates"], depth: "quick", after: "report" }, {
    run,
    recordBaseline: async () => ({ version: 1, checksGreen: true, coverage: { examined: [], notExamined: [] } }),
    runOptimizeScanners: async () => ({ candidates: [], coverage: { examined: [], notExamined: [] }, leads: [] })
  });
  assert.equal(result.status, "done", result.error);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const at = (line) => store.findings.find((f) => f.line === line);
  assert.deepEqual([at(0).tier, at(0).autoFixSafe], ["C", false]);
  assert.equal(at(3).tier, "A");
  assert.ok(store.coverage.notExamined.some((n) => /^1 leftover candidate from the review sessions that deletes a whole file: not deleted automatically/.test(n)), JSON.stringify(store.coverage.notExamined));
});

test("a browser-confirmed security finding with a code fix is fixed right away; one needing the owner, or with no fix, stays with the owner", async () => {
  const b = (f) => ({ source: "session browser-0", category: "idor", fix: "check the order belongs to the user", autoFixSafe: true, ...f });
  assert.equal(browserAutoFix(b({})).autoFixSafe, true);
  assert.equal(browserAutoFix(b({ fix: "  " })).autoFixSafe, false);
  assert.equal(browserAutoFix(b({ autoFixSafe: false })).autoFixSafe, false);
  const reviewer = { source: "session area-src", fix: "", autoFixSafe: true };
  assert.equal(browserAutoFix(reviewer), reviewer, "other sources are left as they are");
  // The prompt lets the session say so, by the same rule as the area reviewers.
  const prompt = fs.readFileSync(path.join(pluginRoot(), "prompts", "sweep-security-browser.md"), "utf8");
  assert.doesNotMatch(prompt, /`autoFixSafe` false;/);
  assert.match(prompt, /`autoFixSafe` \(true when a change to the app's own code fixes it, as it does for an IDOR, XSS, CSRF or open redirect in the app/);
  assert.match(prompt, /false when the fix needs the owner/);
  // End to end: what the merge stores.
  const root = makeProject();
  const run = recordingRun({}, async ({ role }) => {
    if (role === "sweep-browser-0") {
      return okResult({ findings: [
        { kind: "security", category: "idor", title: "user A reads user B's order", severity: "high", file: "/orders/2", line: 0, evidence: "e", impact: "i", fix: "check the order belongs to the signed-in user", testIdea: "t", confidence: 8, autoFixSafe: true },
        { kind: "security", category: "session", title: "sessions survive sign-out in production", severity: "medium", file: "/logout", line: 0, evidence: "e", impact: "i", fix: "", testIdea: "t", confidence: 7, autoFixSafe: true, ownerAction: "invalidate the sessions" }
      ], coverage: { examined: [], notExamined: [] }, notes: "" });
    }
    return null;
  });
  const { result, sp } = await startAndRun(root, "security", { modules: ["live"], depth: "quick", after: "report", writesAllowed: true, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, { run, ...liveDeps({}) });
  assert.equal(result.status, "done", result.error);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const by = (cat) => store.findings.find((f) => f.category === cat);
  assert.equal(by("idor").autoFixSafe, true);
  assert.equal(by("session").autoFixSafe, false);
});

test("browser sessions get no --add-dir: they work from the map in their prompt, while the map, reviewers and verifiers keep reading the project", async () => {
  const MAP = { entryPoints: ["src/app.js"], routes: ["GET /orders -> src/app.js", "GET /orders/:id"], protectedRoutes: ["/account"], loginPath: "/login", roles: [], dataStores: [], trustBoundaries: [], notes: "" };
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec, async ({ role }) => (role === "sweep-map" ? okResult(MAP) : null));
  const { result } = await startAndRun(root, "security", { modules: ["code", "live"], depth: "standard", after: "report", writesAllowed: true, targets: [{ url: "http://127.0.0.1:4100", mode: "full" }] }, { run, ...liveDeps({}) });
  assert.equal(result.status, "done", result.error);
  for (const c of rec.calls) {
    if (c.role.startsWith("sweep-browser-")) assert.ok(!c.args.includes("--add-dir"), `${c.role} cannot read the project`);
    else assert.equal(argAfter(c.args, "--add-dir"), root, `${c.role} reads the project`);
  }
  const sec = rec.calls.find((c) => c.role === "sweep-browser-0").prompt;
  assert.doesNotMatch(sec, /Read, Glob and Grep on files under/);
  assert.match(sec, /You cannot read the project's files: work from the app map below/);
  assert.match(sec, /GET \/orders\/:id/, "the map is in the prompt");

  // Optimize: the walker's page list is the map's routes.
  assert.deepEqual(mapPages(MAP), ["GET /orders -> src/app.js", "GET /orders/:id", "/account"]);
  assert.deepEqual(mapPages(null), []);
  const root2 = makeProject();
  const rec2 = {};
  const run2 = recordingRun(rec2, async ({ role }) => (role === "sweep-map" ? okResult(MAP) : null));
  const r2 = await startAndRun(root2, "optimize", { modules: ["performance"], depth: "quick", after: "report", targets: [{ url: "http://127.0.0.1:4100", mode: "readonly" }] }, {
    run: run2, ...liveDeps({}),
    recordBaseline: async () => ({ version: 1, checksGreen: true, coverage: { examined: [], notExamined: [] } }),
    runOptimizeScanners: async () => ({ candidates: [], coverage: { examined: [], notExamined: [] }, leads: [] })
  });
  assert.equal(r2.result.status, "done", r2.result.error);
  const walk = rec2.calls.find((c) => c.role === "sweep-browser-0");
  assert.ok(!walk.args.includes("--add-dir"));
  assert.match(walk.prompt, /- GET \/orders\/:id\n- \/account/);
  assert.doesNotMatch(walk.prompt, /Grep the route definitions|files under/);
});

test("a sweep session that used all its turns gets the checkers' resumed wrap-up instead of failing; a failed wrap-up is not rerun, a rate-limited one is waited out", async () => {
  const maxed = (sessionId) => ({ ok: false, infra: true, rateLimited: false, structured: null, subtype: "error_max_turns", sessionId, numTurns: 40, costUsd: 0.5, error: "claude ended with error_max_turns: " });
  const root = makeProject();
  const rec = {};
  const run = recordingRun(rec, async ({ role, prompt }) => {
    const wrap = prompt === WRAP_UP_PROMPT;
    if (role === "sweep-area-src") return wrap ? okResult({ findings: [], coverage: { examined: ["src/app.js"], notExamined: ["the rest: out of turns"] }, notes: "wrapped up" }, { numTurns: 2 }) : maxed("sess-src");
    if (role === "sweep-area-lib") return wrap ? { ok: false, infra: true, rateLimited: false, structured: null, error: "claude ended with error: no answer" } : maxed("sess-lib");
    return null;
  });
  const { result, sp } = await startAndRun(root, "security", { modules: ["code"], depth: "quick", after: "report" }, { run });
  assert.equal(result.status, "done", result.error);
  const src = JSON.parse(fs.readFileSync(path.join(sp.agentsDir, "area-src.json"), "utf8"));
  assert.deepEqual([src.ok, src.attempts, src.structured.notes, src.numTurns], [true, 1, "wrapped up", 42]);
  const srcCalls = rec.calls.filter((c) => c.role === "sweep-area-src");
  assert.equal(srcCalls.length, 2);
  assert.deepEqual([argAfter(srcCalls[1].args, "--resume"), argAfter(srcCalls[1].args, "--max-turns")], ["sess-src", "4"]);
  const lib = JSON.parse(fs.readFileSync(path.join(sp.agentsDir, "area-lib.json"), "utf8"));
  assert.equal(lib.ok, false);
  assert.match(lib.error, /the wrap-up also failed/);
  assert.equal(rec.calls.filter((c) => c.role === "sweep-area-lib").length, 2, "used all its turns: no second full run");

  // A wrap-up stopped by a usage limit goes back to the pool, which waits and runs the agent again.
  const root2 = makeProject();
  const rec2 = {};
  let t = Date.parse("2026-10-02T12:00:00Z");
  let wraps = 0;
  const run2 = recordingRun(rec2, async ({ role, prompt }) => {
    if (role !== "sweep-area-src") return null;
    if (prompt !== WRAP_UP_PROMPT) return maxed("sess-2");
    wraps++;
    return wraps === 1 ? { ok: false, infra: true, rateLimited: true, structured: null, error: "claude ended with error: usage limit reached" } : okResult({ findings: [], coverage: { examined: ["src"], notExamined: [] }, notes: "" });
  });
  const r2 = await startAndRun(root2, "security", { modules: ["code"], depth: "quick", after: "report" }, { run: run2, now: () => t, sleep: async (ms) => { t += ms; } });
  assert.equal(r2.result.status, "done", r2.result.error);
  assert.equal(rec2.calls.filter((c) => c.role === "sweep-area-src").length, 4, "the full run and its wrap-up, twice");
  assert.equal(JSON.parse(fs.readFileSync(path.join(r2.sp.agentsDir, "area-src.json"), "utf8")).ok, true);
});
