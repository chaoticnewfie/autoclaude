// Scenario tests for the security and optimize sweeps (PLAN.md P10.1 to P10.10), end to end on a
// scratch git project: `autoclaude security|optimize --options` opens the sweep window (faked),
// `autoclaude sweep-run <id>` drives every stage with the real scanners, probe, allow-list proxy,
// findings, report and fix-plan code, and "fix" sets the run-plan override and opens the run's
// window (faked). No real claude session (a fake headless runner answers per role), no Docker, no
// network (the probe gets a fake fetch; the proxy listens on 127.0.0.1 only), no notification
// (a fake sender), no remote, and this machine's Claude config is never read.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import { gitEnv } from "../fixtures/prepare.js";
import { runCli } from "../../plugins/autoclaude/lib/cli.js";
import { sweepPaths, readSweep, sweepStatus, sweepWhen } from "../../plugins/autoclaude/lib/sweep.js";
import { runSecurityScanners } from "../../plugins/autoclaude/lib/scan-security.js";
import { runOptimizeScanners, recordBaseline } from "../../plugins/autoclaude/lib/scan-optimize.js";
import { runHttpProbe } from "../../plugins/autoclaude/lib/probe.js";
import { parsePlan, lintPlan } from "../../plugins/autoclaude/lib/plan.js";
import { runPlanOverride } from "../../plugins/autoclaude/lib/config.js";
import { STEP_PREFIX } from "../../plugins/autoclaude/lib/fixplan.js";
import { loadState, saveState, defaultState, readMainStateKept } from "../../plugins/autoclaude/lib/state.js";
import { trustKeyFor } from "../../plugins/autoclaude/lib/paths.js";
import { PLAYWRIGHT_DISALLOWED } from "../../plugins/autoclaude/lib/tester.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { writeReady } from "../../plugins/autoclaude/lib/protocol.js";

const gitOk = spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
const skip = !gitOk && "git is not installed";

const node = JSON.stringify(process.execPath);
// The planted secret (in the git history only) and a test user's password: neither may appear in
// any file the sweep writes, in a prompt, or in an alert.
// Built at runtime so no key-shaped literal sits in the source (GitHub push protection).
const PLANTED = ["sk", "live", "Zq81mXvT0pLr5WcY3nKd7HsB2e"].join("_");
const PASSWORD = "Pw-planted-7781-zebra";
// The security fix plan's step id letters, whatever fixplan.js names them.
const SEC = STEP_PREFIX.security;
const DEV_URL = "http://127.0.0.1:4999";

const PLAN = `# Notes app

## Goal

A small notes app.

## Constraints & decisions

- The app listens on 127.0.0.1 only, on purpose.

## Phase 1: Notes
- [x] **P1.1** List notes
  - Accept: GET /api/notes lists the notes
`;

const APP = `import http from "node:http";
import { query } from "../lib/util.js";
export const server = http.createServer((req, res) => res.end(query("SELECT * FROM notes WHERE id = " + req.url)));
`;
const UTIL = `export function query(sql) { return sql; }
export function total(items) { return items.reduce((n, x) => n + x, 0); }
// const old = total([1, 2, 3]);
// if (old > 2) { console.log(old); }
// return old + query("x");
// console.log(total([4, 5]));
`;

function g(root, args, extraEnv = {}) {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, encoding: "utf8", env: { ...gitEnv(), ...extraEnv } });
  assert.equal(r.status, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

// A scratch project: a committed secret removed in the next commit (so only the history has it),
// two code areas, a passing check, a dev server (never really started by the sweep), gitignored
// secrets/ with two test users, and a trusted folder in a throwaway Claude config. The check's
// `requires` command runs in every preflight (and only there): it records, outside the project,
// what the preflight found (a run-plan override, the kept main state, the branch), one JSON line
// per preflight in preflightLog.
function makeProject(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `ac-sweep-${name}-`));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "ac-sweep-cfg-"));
  const preflightLog = path.join(configDir, "preflight.log");
  const recorder = path.join(configDir, "record-preflight.cjs");
  fs.writeFileSync(recorder, [
    "const fs = require(\"fs\");",
    "const path = require(\"path\");",
    "const at = (...p) => path.join(process.cwd(), ...p);",
    "let head = \"\";",
    "try { head = fs.readFileSync(at(\".git\", \"HEAD\"), \"utf8\").trim(); } catch {}",
    `fs.appendFileSync(${JSON.stringify(preflightLog)}, JSON.stringify({ override: fs.existsSync(at(".autoclaude", "run-plan.json")), mainKept: fs.existsSync(at(".autoclaude", "state.main.json")), head }) + "\\n");`
  ].join("\n") + "\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.mkdirSync(path.join(root, "lib"));
  fs.mkdirSync(path.join(root, "test"));
  fs.writeFileSync(path.join(root, ".gitignore"), ".autoclaude/\nsecrets/\ndocs/private/\nnode_modules/\n");
  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "notes", version: "1.0.0", type: "module" }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({
    version: 1,
    checks: [{ name: "unit", command: `${node} -e "process.exit(0)"`, requires: `${node} ${JSON.stringify(recorder)}`, timeoutSec: 60 }],
    // A command that never answers: the sweep's dev-server start is faked, and the fix run's
    // preflight gives up on it after a second (a warning, since every fix step is no-ui).
    devServer: { command: `${node} -e "process.exit(1)"`, url: DEV_URL, healthPath: "/", startTimeoutSec: 1 },
    tester: { enabled: false }
  }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "src", "app.js"), APP + `const STRIPE_KEY = "${PLANTED}";\n`);
  fs.writeFileSync(path.join(root, "lib", "util.js"), UTIL);
  fs.writeFileSync(path.join(root, "test", "app.test.js"), "export {};\n");
  g(root, ["init", "-q", "-b", "main"]);
  g(root, ["add", "-A"]);
  g(root, ["commit", "-q", "-m", "init"]);
  fs.writeFileSync(path.join(root, "src", "app.js"), APP);
  g(root, ["commit", "-qam", "move the key out"]);
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "sweep-users.json"), JSON.stringify({ loginUrl: "/login", users: [{ label: "user A", username: "alice@example.com", password: PASSWORD }, { label: "user B", username: "bob@example.com", password: `${PASSWORD}-b` }] }));
  const top = fs.realpathSync.native(root);
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [trustKeyFor(top)]: { hasTrustDialogAccepted: true } } }));
  return { root, configDir, preflightLog };
}

// What every preflight so far recorded (makeProject's check requirement).
function preflights(preflightLog) {
  try { return fs.readFileSync(preflightLog, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
}

// Every file in the project outside .git and .autoclaude, with its content: what "nothing in the
// project tree changed" compares.
function treeOf(root) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (d === root && (e.name === ".git" || e.name === ".autoclaude")) continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else out[path.relative(root, p).split(path.sep).join("/")] = fs.readFileSync(p, "utf8");
    }
  };
  walk(root);
  return out;
}

// The run files a refused or failed `run --plan` must leave exactly as they were.
const runFiles = (root) => ["run-plan.json", "state.json", "state.main.json"].map((f) => {
  try { return fs.readFileSync(path.join(root, ".autoclaude", f), "utf8"); } catch { return null; }
});

const branches = (root) => g(root, ["branch", "--format=%(refname:short)"]).split("\n").filter(Boolean).sort();

// The fix plan's title, and so its branch, carry the sweep's start date and time.
const fixBranch = (kind, id) => { const w = sweepWhen(id); return `autoclaude/${kind === "security" ? "security-fixes" : "optimization"}-${w.date}-${w.stamp}`; };

function runEnv() {
  const env = gitEnv({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || process.env.Path || ""}`, AUTOCLAUDE_CLAUDE_BIN: process.execPath });
  delete env.CLAUDE_CONFIG_DIR;
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete env[k];
  return env;
}

// A command runner for the security scanners: real git (local), nothing else (no npm, no
// Docker), so nothing is fetched and no daemon is touched.
async function gitOnly(exe, args = [], { cwd, env } = {}) {
  if (exe !== "git") return { ok: false, code: null, stdout: "", stderr: `${exe} is not available in this test`, timedOut: false };
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return { ok: r.status === 0, code: r.status, stdout: r.stdout || "", stderr: r.stderr || "", timedOut: false };
}

const ok = (structured) => ({ ok: true, infra: false, structured, rateLimited: false, numTurns: 4, costUsd: 0.05, durationMs: 20, error: null });

const finding = (f) => ({
  cwe: "", cvss: "", fixedVersion: "", confidence: 8, line: 0, evidence: "", impact: "it matters", reproduce: "do this, then that",
  fix: "change it", testIdea: "a test that fails now", tier: "A", autoFixSafe: true, ownerAction: "", ...f
});

// The fake headless runner: a map, findings per reviewer, the browser's, and verdicts. Every
// verifier confirms, except a candidate whose category is "refute-me" (refuted) or "unsure"
// (uncertain). It records every call.
function fakeHeadless(kind, rec) {
  rec.calls = [];
  return async ({ prompt, args, cwd, env, role }) => {
    rec.calls.push({ role, prompt, args, cwd, env });
    if (role === "sweep-map") {
      return ok({ entryPoints: ["src/app.js http server"], routes: ["GET /api/notes"], protectedRoutes: ["/api/notes"], loginPath: "/api/login", roles: ["user"], dataStores: ["sqlite file"], trustBoundaries: ["src/app.js request handler"], notes: "" });
    }
    if (role.startsWith("verify-")) {
      const cat = (prompt.match(/^Category: (.+)$/m) || [])[1] || "";
      const verdict = cat === "refute-me" ? "refuted" : cat === "unsure" ? "uncertain" : "confirmed";
      return ok({ verdict, reason: `checked it in the code (${cat})`, severity: (prompt.match(/^Proposed severity: (.+)$/m) || [])[1] || "medium" });
    }
    if (role === "sweep-browser-0") {
      if (kind === "security") {
        return ok({ findings: [finding({ kind: "security", category: "idor", title: "One user reads another user's note", severity: "high", cwe: "CWE-639", file: "src/app.js", line: 3, evidence: "signed in as user A (alice@example.com), /api/notes/2 showed user B's note; screenshot idor.png", autoFixSafe: true })], coverage: { examined: ["two users"], notExamined: [] }, notes: "" });
      }
      return ok({
        findings: [finding({ kind: "optimize", category: "performance", title: "The notes page calls the list API twice", severity: "medium", file: "src/app.js", line: 3, evidence: "GET /api/notes twice per load", tier: "B", autoFixSafe: false })],
        coverage: { examined: ["/"], notExamined: [] }, notes: "",
        pages: [{ url: `${DEV_URL}/`, loads: 5, loadMsMedian: 120, loadMsMin: 100, loadMsMax: 160, domContentLoadedMs: 80, requests: 6, transferKb: 40, failedRequests: 0, duplicateApiCalls: ["GET /api/notes"], heavyAssets: [], consoleErrors: 0 }],
        browserUnavailable: false
      });
    }
    // Reviewers. src: one real finding; lib: one the verifiers refute and one they cannot settle.
    if (kind === "security") {
      if (role === "sweep-area-src") return ok({ findings: [finding({ kind: "security", category: "injection", title: "SQL built from the request URL", severity: "critical", cwe: "CWE-89", file: "src/app.js", line: 3, evidence: "query(\"SELECT ... \" + req.url)" })], coverage: { examined: ["src/app.js"], notExamined: [] }, notes: "" });
      if (role === "sweep-area-lib") return ok({ findings: [finding({ kind: "security", category: "refute-me", title: "A claim that does not hold", severity: "low", file: "lib/util.js", line: 1 }), finding({ kind: "security", category: "unsure", title: "Hard to tell", severity: "low", file: "lib/util.js", line: 2 })], coverage: { examined: ["lib/util.js"], notExamined: [] }, notes: "" });
      return ok({ findings: [], coverage: { examined: [role], notExamined: [] }, notes: "" });
    }
    if (role === "sweep-area-src") return ok({ findings: [finding({ kind: "optimize", category: "duplicate", title: "Two copies of the query helper", severity: "medium", file: "src/app.js", line: 2, tier: "A", evidence: "same body as lib/util.js:1" })], coverage: { examined: ["src/app.js"], notExamined: [] }, notes: "" });
    if (role === "sweep-area-lib") {
      return ok({ findings: [
        finding({ kind: "optimize", category: "unused-export", title: "total is never imported", severity: "low", file: "lib/util.js", line: 2, tier: "A" }),
        finding({ kind: "optimize", category: "major-upgrade", title: "Move to the next major of the HTTP layer", severity: "low", file: "package.json", line: 0, tier: "A", fixedVersion: "2.0.0" }),
        finding({ kind: "optimize", category: "refute-me", title: "A claim that does not hold", severity: "low", file: "lib/util.js", line: 1 })
      ], coverage: { examined: ["lib/util.js"], notExamined: [] }, notes: "" });
    }
    return ok({ findings: [], coverage: { examined: [role], notExamined: [] }, notes: "" });
  };
}

// The probe's fake fetch: the main page answers without security headers; everything else 404s.
function fakeFetch(rec) {
  rec.urls = [];
  return async (url, init = {}) => {
    rec.urls.push(`${init.method || "GET"} ${url}`);
    const u = new URL(url);
    if (u.pathname === "/") return new Response("<html>notes</html>", { status: 200, headers: { "content-type": "text/html" } });
    if (u.pathname === "/api/notes") return new Response("[]", { status: 401 });
    return new Response("not found", { status: 404 });
  };
}

async function cli(argv, root, { configDir, deps = {} }) {
  let out = "";
  let err = "";
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    const code = await runCli(argv, { cwd: root, env: runEnv(), stdout: { write: (s) => { out += s; return true; } }, stderr: { write: (s) => { err += s; return true; } }, deps });
    return { code, out, err };
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

// One sweep from the CLI: start (the window faked), then the window's own `sweep-run <id>` with
// the engine's fakes; in fix mode that same call opens the run's window (faked).
async function sweep(kind, after, { override = {}, trusted = true, wrapRun = null, beforeRun = null } = {}) {
  const { root, configDir, preflightLog } = makeProject(`${kind}-${after}`);
  if (!trusted) fs.rmSync(path.join(configDir, ".claude.json"));
  const options = {
    ...(kind === "security"
      ? { kind, modules: ["code", "secrets", "deps", "config", "live"], depth: "thorough", targets: [], tests: {}, writesAllowed: false, resetCommand: null, testUsers: { file: "secrets/sweep-users.json" }, exclude: [], after, advisories: true }
      : { kind, modules: ["unused", "duplicates", "performance", "rebuild", "tests"], depth: "standard", targets: [], writesAllowed: false, resetCommand: null, testUsers: null, exclude: [], after, advisories: false, flakyReruns: 0 }),
    ...override
  };
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  const optionsFile = path.join(root, ".autoclaude", `sweep-options-${kind}.json`);
  fs.writeFileSync(optionsFile, JSON.stringify(options, null, 2));
  const treeBefore = treeOf(root);
  const windows = [];
  const openConsoleWindow = (o) => { windows.push(o); return { method: "windows-console", pid: 1 }; };
  const usage = () => ({ source: "test", fiveHour: { pct: 10 }, sevenDay: { pct: 10 } });

  // --estimate first: it prints and starts nothing.
  const est = await cli([kind, "--options", optionsFile, "--estimate"], root, { configDir, deps: { openConsoleWindow, readUsage: usage } });
  assert.equal(est.code, 0, est.out + est.err);
  assert.match(est.out, /sessions about \d+/);
  assert.equal(windows.length, 0, "an estimate opens no window");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "sweeps")), false, "and writes no sweep");

  const start = await cli([kind, "--options", optionsFile], root, { configDir, deps: { openConsoleWindow, readUsage: usage } });
  assert.equal(start.code, 0, start.out + start.err);
  assert.equal(windows.length, 1);
  const id = windows[0].args[windows[0].args.length - 1];
  // --auto: the window leaves a sweep the owner stopped alone.
  assert.deepEqual(windows[0].args.slice(-3), ["sweep-run", "--auto", id]);
  assert.match(windows[0].title, /^ac-sweep-/);
  assert.match(id, new RegExp(`^\\d{8}-\\d{4}-${kind}$`));

  const rec = { alerts: [], fetch: {}, devServer: [] };
  const deps = {
    run: wrapRun ? wrapRun(fakeHeadless(kind, rec)) : fakeHeadless(kind, rec),
    ensureDevServer: async (ds) => { rec.devServer.push(ds.url); return { ok: true, reused: true, url: ds.url }; },
    readUsage: usage, sleep: async () => {}, now: () => Date.now(),
    notify: async (msg) => { rec.alerts.push(msg); return { ok: true }; },
    openConsoleWindow,
    runSecurityScanners: (a) => runSecurityScanners({ ...a, run: gitOnly, fetchImpl: async () => { throw new Error("no network in tests"); } }),
    runHttpProbe: (a) => { rec.probeArgs = a; return runHttpProbe({ ...a, fetchImpl: fakeFetch(rec.fetch) }); },
    recordBaseline: (a) => recordBaseline({ ...a, deps: { ensureDevServer: async () => ({ ok: true, skipped: true }) } }),
    runOptimizeScanners: (a) => runOptimizeScanners({ ...a, which: () => null }),
    verbose: false
  };
  const before = beforeRun ? await beforeRun({ root, id }) : null;
  const run = await cli(["sweep-run", id], root, { configDir, deps });
  return { root, configDir, preflightLog, id, run, rec, windows, sp: sweepPaths(root, id), treeBefore, before, openConsoleWindow };
}

// Every file the sweep wrote, as one string, for the leak checks.
function everything(dir) {
  let text = "";
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else if (!/\.png$/i.test(e.name)) text += `\n${fs.readFileSync(p, "utf8")}`;
    }
  };
  walk(dir);
  return text;
}

function assertNoLeak(t, label) {
  assert.ok(!t.includes(PLANTED), `${label}: the planted secret`);
  assert.ok(!t.includes(PASSWORD), `${label}: a test user's password`);
}

test("security sweep, report and fix plan: every stage runs, findings are verified by majority, the plan is lint-clean, nothing leaks", { skip }, async () => {
  const { root, id, run, rec, sp, treeBefore, preflightLog } = await sweep("security", "plan");
  assert.equal(run.code, 0, run.out + run.err);
  const s = readSweep(root, id);
  assert.deepEqual([s.status, s.stage], ["done", "after"]);
  assert.equal(s.result.after, "plan");
  const planRel = `.autoclaude/sweeps/${id}/SECURITY_PLAN.md`;
  assert.equal(s.result.planFile, planRel, "the plan stays in the sweep folder");

  // The sessions: one map, two areas and two cross-cutting reviewers, one browser, and three
  // verifiers per candidate (depth thorough); all read-only, on Opus.
  const roles = rec.calls.map((c) => c.role);
  for (const r of ["sweep-map", "sweep-area-src", "sweep-area-lib", "sweep-crosscut-authz", "sweep-crosscut-infra", "sweep-browser-0"]) assert.equal(roles.filter((x) => x === r).length, 1, r);
  for (const c of rec.calls) {
    const tools = c.args[c.args.indexOf("--allowedTools") + 1];
    assert.ok(!/Bash|Edit|Write/.test(tools), `${c.role} is read-only: ${tools}`);
    assert.equal(c.args[c.args.indexOf("--model") + 1], "opus");
    // Denied outright, so the owner's own allow rules cannot widen a session.
    const denied = c.args[c.args.indexOf("--disallowedTools") + 1].split(",");
    for (const t of ["Bash", "PowerShell", "Write", "Edit", "WebFetch", "WebSearch"]) assert.ok(denied.includes(t), `${c.role} denies ${t}`);
  }
  // The browser: Playwright behind the allow-list proxy, without the arbitrary-code tool. Writes
  // are not allowed, so the dev server is a read-only target: a read-only browse with no login,
  // and no password handed over at all.
  const browser = rec.calls.find((c) => c.role === "sweep-browser-0");
  const denied = browser.args[browser.args.indexOf("--disallowedTools") + 1].split(",");
  for (const t of PLAYWRIGHT_DISALLOWED) assert.ok(denied.includes(t), t);
  assert.ok(Number(browser.env.MCP_TIMEOUT) >= 120000, "Playwright MCP gets time to start, like the tester's");
  const mcp = JSON.parse(fs.readFileSync(browser.args[browser.args.indexOf("--mcp-config") + 1], "utf8"));
  const mcpArgs = mcp.mcpServers.playwright.args;
  assert.match(mcpArgs[mcpArgs.indexOf("--proxy-server") + 1], /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(mcpArgs[mcpArgs.indexOf("--allowed-origins") + 1], DEV_URL);
  assert.ok(!mcpArgs.includes("--secrets"), "no login on a read-only target");
  assert.ok(!mcpArgs.some((a) => /@latest/.test(a)), "Playwright MCP is pinned");
  assert.match(browser.prompt, /A read-only browse of this target/);
  assert.doesNotMatch(browser.prompt, /alice@example\.com|SWEEP_USER_A_PASSWORD/);
  assert.equal(fs.existsSync(sp.usersEnvFile), false, "no dotenv file is written for a read-only browse");
  // The dev server is made sure of before the live checks (here faked).
  assert.deepEqual(rec.devServer, [DEV_URL]);
  // The map's protected routes and login path reach the HTTP probe; every probe request stayed
  // on the target.
  assert.deepEqual(rec.probeArgs.map, { protectedRoutes: ["/api/notes"], loginPath: "/api/login" });
  assert.ok(rec.fetch.urls.length > 3);
  for (const u of rec.fetch.urls) assert.ok(u.split(" ")[1].startsWith(`${DEV_URL}/`), u);
  assert.ok(!rec.fetch.urls.some((u) => u.startsWith("POST")), "read-only: no write probe");
  const proxyLog = fs.readFileSync(sp.proxyLog, "utf8");
  assert.match(proxyLog, /ALLOW/);
  assert.doesNotMatch(proxyLog, /REFUSE/);
  // The owner's constraints reach the reviewers.
  assert.match(rec.calls.find((c) => c.role === "sweep-area-src").prompt, /listens on 127\.0\.0\.1 only, on purpose/);
  assert.match(rec.calls.find((c) => c.role === "sweep-area-src").prompt, /- src\/app\.js/, "the area's files");

  // Findings: the secret in the history (scanner), the injection (reviewer), the IDOR (browser)
  // and the missing headers (probe) are confirmed; one refuted, one uncertain.
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const by = (v) => store.findings.filter((f) => f.verdict === v);
  const cats = by("confirmed").map((f) => f.category);
  for (const c of ["secrets", "injection", "idor", "headers"]) assert.ok(cats.includes(c), `${c} in ${cats.join(", ")}`);
  assert.deepEqual(by("refuted").map((f) => f.category), ["refute-me"]);
  assert.deepEqual(by("uncertain").map((f) => f.category), ["unsure"]);
  const sqli = by("confirmed").find((f) => f.category === "injection");
  assert.equal(sqli.id, "SEC-001", "most severe first");
  assert.deepEqual(sqli.votes, { confirmed: 3, refuted: 0, uncertain: 0, failed: 0 });
  assert.equal(rec.calls.filter((c) => c.role.startsWith(`verify-${sqli.id}-`)).length, 3);
  const secret = by("confirmed").find((f) => f.category === "secrets" && /history/.test(f.evidence));
  assert.ok(secret, "the secret in the git history is found");
  assert.match(secret.evidence, /sk_l\[redacted, \d+ chars\]/);

  // The report: dated folder, coverage, every finding with its fix; findings.json for tools.
  const report = fs.readFileSync(sp.reportFile, "utf8");
  assert.match(report, /^# Security sweep report/);
  assert.match(report, /## Coverage/);
  assert.match(report, /### Not examined/);
  assert.match(report, /package advisories \(no lockfile found\)/, "a missing lockfile is not checked, never clean");
  assert.match(report, /### SEC-001 · critical · SQL built from the request URL/);
  assert.match(report, /confirmed by 3 of 3 sessions/);
  assert.match(report, /## Appendix: refuted[\s\S]*A claim that does not hold/);
  assert.match(report, /## Uncertain[\s\S]*Hard to tell/);
  // Scanner and probe findings carry a plain title too (P10.14), the key's value never in it.
  assert.match(report, /### SEC-\d{3} · \w+ · A Stripe-style secret key in the git history of src\/app\.js \(commit [0-9a-f]{12}\)\n/);
  assert.match(report, /### SEC-\d{3} · \w+ · No Content-Security-Policy header\n/);
  for (const f of store.findings) assert.ok(typeof f.title === "string" && f.title.trim(), `${f.id} ${f.category} has a title`);
  const json = JSON.parse(fs.readFileSync(sp.findingsFile, "utf8"));
  assert.equal(json.schemaVersion, 1);
  assert.equal(json.counts.uncertain, 1);

  // The plan: lint-clean, neutral, in the gitignored sweep folder and nowhere in the project tree;
  // the project's own plan untouched; the secret's rotation left for the owner; the uncertain one
  // listed, never fixed.
  assert.equal(fs.existsSync(path.join(root, "SECURITY_PLAN.md")), false);
  const planText = fs.readFileSync(path.join(root, planRel), "utf8");
  const parsed = parsePlan(planText);
  assert.deepEqual(lintPlan(parsed), []);
  const when = sweepWhen(id);
  assert.equal(parsed.title, `Security fixes ${when.date} ${when.stamp}`, "the title names this sweep");
  assert.ok(parsed.steps.every((st) => new RegExp(`^${SEC}\\d+\\.\\d+$`).test(st.id)), "step ids of its own, never the project's S or P ids");
  assert.match(planText, /for `autoclaude run --plan`, which commits it as `SECURITY_PLAN\.md` on a new branch/);
  assert.ok(parsed.steps.every((st) => st.tags.includes("security")));
  assert.match(planText, /The app listens on 127\.0\.0\.1 only, on purpose\./, "the main plan's constraints are copied");
  assert.doesNotMatch(planText, /SELECT|req\.url|alice|idor\.png/, "no exploit detail in a file that gets committed");
  assert.match(planText, new RegExp(`${by("uncertain")[0].id}`));
  assert.match(planText, new RegExp(`${secret.id} \\(high\\) needs you`));
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), PLAN);
  assert.equal(spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8", env: gitEnv() }).stdout, "", "plan mode leaves the tree clean");
  // Nothing in the project tree changed, ignored folders (secrets/) included, and no branch,
  // commit, override, kept state or preflight happened.
  assert.deepEqual(treeOf(root), treeBefore, "plan mode writes nothing outside .autoclaude/");
  assert.equal(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.deepEqual(branches(root), ["main"]);
  assert.equal(g(root, ["rev-list", "--count", "HEAD"]), "2");
  assert.equal(runPlanOverride(root), null, "plan mode starts no run");
  assert.equal(readMainStateKept(root), null);
  assert.deepEqual(preflights(preflightLog), []);
  assert.match(run.out, new RegExp(`autoclaude run --plan ${planRel.replace(/[.]/g, "[.]")}`), "the window says how to run it");

  // The alert: once, counts and the report path, never a finding's details.
  assert.equal(rec.alerts.length, 1);
  const a = rec.alerts[0];
  assert.equal(a.title, `AutoClaude: security sweep finished (${path.basename(root)})`);
  assert.match(a.message, /Confirmed: \d+ findings \(2 critical, /, "the injection and the secret");
  assert.equal(a.priority, "high");
  assert.match(a.message, new RegExp(`Report: \\.autoclaude/sweeps/${id}/report\\.md \\(not committed\\)`));
  const planRe = planRel.replace(/[.]/g, "[.]");
  assert.match(a.message, new RegExp(`Next: review ${planRe}, then \`autoclaude run --plan ${planRe}\``), "the exact command to run it later");
  assert.doesNotMatch(a.message, /SQL|src\/app\.js|alice|history/);

  // Nothing the sweep wrote, no prompt and no alert holds the secret or a password.
  assertNoLeak(everything(sp.dir), "the sweep folder");
  assertNoLeak(rec.calls.map((c) => c.prompt).join("\n"), "the prompts");
  assertNoLeak(JSON.stringify(rec.alerts), "the alert");
  assertNoLeak(planText, "the plan");
  assert.equal(sweepStatus(root).sweeps[0].status, "done");
});

test("security sweep, fix right away: the sweep hands its folder's plan to run --plan, which commits it on a new branch and starts the run", { skip }, async () => {
  // A branch of that name is left from an earlier run (on the first commit): the fix run never
  // reuses an old branch tip.
  const beforeRun = ({ root, id }) => {
    g(root, ["branch", fixBranch("security", id), "HEAD~1"]);
    return { main: g(root, ["rev-parse", "HEAD"]), stale: g(root, ["rev-parse", "HEAD~1"]), runFiles: runFiles(root) };
  };
  const { root, id, run, rec, windows, before, preflightLog } = await sweep("security", "fix", { beforeRun });
  assert.equal(run.code, 0, run.out + run.err);
  const planRel = `.autoclaude/sweeps/${id}/SECURITY_PLAN.md`;
  assert.match(run.out, new RegExp(`starting the fix run on ${planRel.replace(/[.]/g, "[.]")}`));
  // The run's window (faked): the supervisor, after a passing preflight.
  assert.equal(windows.length, 2, run.out);
  assert.deepEqual(windows[1].args.slice(-1), ["supervise"]);
  assert.match(windows[1].title, /^ac-/);
  // The preflight (one, from run --plan) judged the project as it was: on main, no override, no
  // state kept aside. The branch, the commit, the kept state and the override all came after it.
  assert.deepEqual(preflights(preflightLog), [{ override: false, mainKept: false, head: "ref: refs/heads/main" }]);
  assert.equal(runPlanOverride(root), "SECURITY_PLAN.md");
  assert.equal(loadState(root).status, "idle", "the supervisor's /autoclaude:start takes it from here");
  assert.ok(readMainStateKept(root), "the project's own state is kept aside");
  // On its own new branch from main's tip (the stale one is left alone), one commit with the plan
  // only (made by run --plan, not by the sweep), worded neutrally; the tree is clean; the
  // committed plan is the sweep's, word for word.
  const branch = `${fixBranch("security", id)}-2`;
  assert.equal(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  assert.equal(g(root, ["rev-parse", "HEAD~1"]), before.main, "branched from the commit the sweep looked at");
  assert.equal(g(root, ["rev-parse", fixBranch("security", id)]), before.stale, "the old branch is untouched");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "run-plan.json"), "utf8")).branch, branch);
  assert.equal(g(root, ["show", "--name-only", "--format=", "HEAD"]), "SECURITY_PLAN.md");
  assert.match(g(root, ["log", "-1", "--format=%B"]), new RegExp(id));
  assert.equal(g(root, ["status", "--porcelain"]), "");
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), PLAN, "the project's own plan is left alone");
  const committed = fs.readFileSync(path.join(root, "SECURITY_PLAN.md"), "utf8");
  assert.equal(committed, fs.readFileSync(path.join(root, planRel), "utf8"));
  assert.deepEqual(lintPlan(parsePlan(committed)), []);
  const s = readSweep(root, id);
  assert.deepEqual([s.status, s.result.after, s.result.planFile, s.result.startRun], ["done", "fix", planRel, true]);
  assert.equal(rec.alerts.length, 1);
  assert.match(rec.alerts[0].message, /Next: the fix run starts on its own branch in a new window, working through \S*SECURITY_PLAN\.md/);
  assertNoLeak(g(root, ["log", "-p", "-1"]), "the plan commit");
});

test("security sweep, fix right away whose run cannot start (an untrusted folder): a second alert says so, without the reason, and nothing is left behind", { skip }, async () => {
  const beforeRun = ({ root }) => ({ runFiles: runFiles(root), branches: branches(root) });
  const { root, id, run, rec, windows, before, treeBefore } = await sweep("security", "fix", { override: { modules: ["code"], depth: "quick" }, trusted: false, beforeRun });
  assert.equal(run.code, 1, run.out);
  assert.match(run.out, /FAIL trust/);
  // The refused run --plan left no override, no kept state, no branch and no file behind.
  assert.equal(runPlanOverride(root), null);
  assert.equal(readMainStateKept(root), null);
  assert.deepEqual(runFiles(root), before.runFiles);
  assert.deepEqual(branches(root), before.branches);
  assert.deepEqual(treeOf(root), treeBefore);
  assert.equal(windows.length, 1, "only the sweep's own window");
  assert.equal(rec.alerts.length, 2);
  assert.match(rec.alerts[0].title, /security sweep finished/);
  assert.equal(rec.alerts[1].title, `AutoClaude: the fix run did not start (${path.basename(root)})`);
  const planRel = `.autoclaude/sweeps/${id}/SECURITY_PLAN.md`;
  assert.match(rec.alerts[1].message, new RegExp(`\`autoclaude run --plan ${planRel.replace(/[.]/g, "[.]")}\` stopped`));
  assert.doesNotMatch(rec.alerts[1].message, /trust|SQL|src\/app\.js/);
  // The plan waits in the sweep folder; the project is as it was.
  assert.ok(fs.existsSync(path.join(root, planRel)));
  assert.equal(fs.existsSync(path.join(root, "SECURITY_PLAN.md")), false);
  assert.equal(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]), "main");
  assert.equal(g(root, ["status", "--porcelain"]), "");
});

test("the whole chain: a plan-mode sweep, run --plan refused while the project's own run goes and changing nothing with --check, then the fix run on its own branch, which the gate completes with HANDOFF-SECURITY.md and hands the project back to its own plan and state", { skip }, async () => {
  const { root, configDir, preflightLog, id, run } = await sweep("security", "plan", { override: { modules: ["code", "secrets"], depth: "quick" } });
  assert.equal(run.code, 0, run.out + run.err);
  const planRel = `.autoclaude/sweeps/${id}/SECURITY_PLAN.md`;
  const mainTip = g(root, ["rev-parse", "HEAD"]);
  const opened = [];
  const openConsoleWindow = (o) => { opened.push(o); return { method: "windows-console", pid: 1 }; };

  // The project's own run: finished earlier, with an owner note waiting for its next run.
  const own = { ...defaultState(), status: "complete", pendingNotes: [{ at: "2026-10-01T00:00:00Z", text: "keep the table" }], tickedByGate: ["P1.1"], startedAt: "2026-10-01T08:00:00.000Z" };

  // 1. While that run is running, run --plan is refused before anything is judged or written.
  saveState(root, { ...own, status: "running", currentStep: "P1.1" });
  let files = runFiles(root);
  let r = await cli(["run", "--plan", planRel], root, { configDir, deps: { openConsoleWindow } });
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /a run of the project's own plan is running in this project/);
  assert.deepEqual(runFiles(root), files);
  assert.deepEqual(branches(root), ["main"]);
  assert.deepEqual(preflights(preflightLog), [], "refused before the preflight");

  // 2. --check judges it and changes nothing.
  saveState(root, own);
  files = runFiles(root);
  r = await cli(["run", "--plan", planRel, "--check"], root, { configDir, deps: { openConsoleWindow } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /preflight passed; `autoclaude run --plan \S+` would create a new branch from this commit/);
  assert.deepEqual(runFiles(root), files);
  assert.deepEqual(branches(root), ["main"]);
  assert.equal(opened.length, 0);

  // 3. The real start: the preflight on main with nothing set, then the branch, the committed
  // plan, the project's own state kept aside, a fresh state for the fix run, and the override.
  r = await cli(["run", "--plan", planRel], root, { configDir, deps: { openConsoleWindow } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Its hand-back is HANDOFF-SECURITY\.md/);
  assert.deepEqual(preflights(preflightLog).map((p) => [p.override, p.mainKept, p.head]), [[false, false, "ref: refs/heads/main"], [false, false, "ref: refs/heads/main"]]);
  assert.deepEqual(opened.map((o) => o.args.at(-1)), ["supervise"]);
  const branch = fixBranch("security", id);
  assert.equal(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  assert.equal(g(root, ["rev-parse", "HEAD~1"]), mainTip);
  assert.equal(runPlanOverride(root), "SECURITY_PLAN.md");
  assert.equal(readMainStateKept(root).status, "complete");
  assert.equal(readMainStateKept(root).pendingNotes[0].text, "keep the table");
  assert.deepEqual([loadState(root).status, loadState(root).pendingNotes], ["idle", []], "the fix run starts from a fresh state");

  // 4. What the supervisor's /autoclaude:start does: the run starts on that branch, with the rules
  // naming the run's own hand-back.
  r = await cli(["start", "--no-preflight"], root, { configDir, deps: { recordFootprintStart: async () => {}, notifyEvent: async () => ({ sent: false }) } });
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, new RegExp(`running on branch ${branch.replace(/[.]/g, "[.]")}( \\(created\\))?\\. First step: ${SEC}1\\.1`));
  assert.match(r.out, /the run's hand-back, `HANDOFF-SECURITY\.md`, gathers these rows/);

  // 5. The builder works each step; the gate verifies and commits it, and completes the plan.
  const sent = [];
  const gateDeps = { env: runEnv(), root, notify: async (m) => { sent.push(m); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null, noteFootprint: null, finishFootprint: null };
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    for (let i = 0; i < 30 && loadState(root).status === "running"; i++) {
      writeReady(root, loadState(root).currentStep);
      const gr = await runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, gateDeps);
      assert.notEqual(loadState(root).status, "paused", JSON.stringify(gr.events));
    }
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
  const done = parsePlan(fs.readFileSync(path.join(root, "SECURITY_PLAN.md"), "utf8"));
  assert.ok(done.steps.length > 0 && done.steps.every((s) => s.marker === "x"), "every fix step is verified");
  assert.match(sent.at(-1).title, /plan complete/);
  assert.match(sent.at(-1).message, /HANDOFF-SECURITY\.md/);

  // 6. Handed back: the hand-back under the run's own name, committed on the fix branch; the
  // project's own plan, HANDOFF.md and state as they were, with the fix run recorded; no override.
  assert.equal(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]), branch);
  assert.equal(g(root, ["log", "-1", "--format=%s"]), "autoclaude: hand-back");
  assert.equal(g(root, ["show", "--name-only", "--format=", "HEAD"]), "HANDOFF-SECURITY.md");
  assert.equal(fs.existsSync(path.join(root, "HANDOFF.md")), false);
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), PLAN);
  assert.match(fs.readFileSync(path.join(root, "PROGRESS.md"), "utf8"), new RegExp(`${SEC}1\\.1 `));
  assert.equal(g(root, ["status", "--porcelain"]), "");
  assert.equal(runPlanOverride(root), null);
  assert.equal(readMainStateKept(root), null, "the kept copy is gone once it is back");
  const back = loadState(root);
  assert.equal(back.status, "complete");
  assert.deepEqual(back.pendingNotes.map((n) => n.text), ["keep the table"]);
  assert.deepEqual(back.tickedByGate, ["P1.1"]);
  assert.deepEqual([back.lastRunPlan.plan, back.lastRunPlan.branch, back.lastRunPlan.sweepId], ["SECURITY_PLAN.md", branch, id]);
  const st = await cli(["status"], root, { configDir });
  assert.match(st.out, /plan: PLAN\.md, 1\/1 steps verified/);
  assert.match(st.out, new RegExp(`last run on a generated plan: SECURITY_PLAN\\.md on ${branch.replace(/[.]/g, "[.]")}, completed .*; its hand-back is HANDOFF-SECURITY\\.md`));
  assert.doesNotMatch(st.out, /run plan override/);
  // A plain `autoclaude run` works the project's own plan again (complete, so nothing to do).
  r = await cli(["run", "--check"], root, { configDir });
  assert.match(r.out, /every step in PLAN\.md is verified/);
});

test("optimize sweep, report and fix plan: baseline with page timings, tier rules, pin-then-change steps, majors for the owner", { skip }, async () => {
  const { root, id, run, rec, sp } = await sweep("optimize", "plan");
  assert.equal(run.code, 0, run.out + run.err);
  const planRel = `.autoclaude/sweeps/${id}/OPTIMIZE_PLAN.md`;
  assert.equal(readSweep(root, id).result.planFile, planRel);
  assert.equal(fs.existsSync(path.join(root, "OPTIMIZE_PLAN.md")), false, "nothing in the project tree");
  // No security probe and no cross-cutting security reviewers in an optimize sweep; one browser
  // walk of the dev server, and one verifier per candidate (depth standard).
  assert.equal(rec.probeArgs, undefined);
  const roles = rec.calls.map((c) => c.role);
  assert.ok(!roles.some((r) => /crosscut/.test(r)));
  assert.equal(roles.filter((r) => r === "sweep-browser-0").length, 1);
  assert.ok(roles.filter((r) => r.startsWith("verify-")).every((r) => /-1$/.test(r)));
  // The browser walk is measured into the baseline, next to the checks' timing.
  const baseline = JSON.parse(fs.readFileSync(path.join(sp.scannersDir, "baseline.json"), "utf8"));
  assert.equal(baseline.checksGreen, true);
  assert.equal(baseline.pages[0].loadMsMedian, 120);
  assert.ok(baseline.checks.some((c) => c.name === "unit"));
  // The scanner's leftover (the commented-out block) reached the area reviewer and the findings.
  assert.match(rec.calls.find((c) => c.role === "sweep-area-lib").prompt, /commented-out/);
  const store = JSON.parse(fs.readFileSync(sp.storeFile, "utf8"));
  const conf = store.findings.filter((f) => f.verdict === "confirmed");
  const cat = (c) => conf.find((f) => f.category === c);
  for (const c of ["commented-out", "duplicate", "unused-export", "performance", "major-upgrade"]) assert.ok(cat(c), `${c} in ${conf.map((f) => f.category).join(", ")}`);
  // The tier rules apply to what a session proposed: a duplicate is never tier A, a major
  // upgrade is the owner's.
  assert.equal(cat("duplicate").tier, "B");
  assert.equal(cat("unused-export").tier, "B");
  assert.equal(cat("major-upgrade").tier, "C");
  assert.equal(cat("commented-out").tier, "A");

  const planText = fs.readFileSync(path.join(root, planRel), "utf8");
  const parsed = parsePlan(planText);
  assert.deepEqual(lintPlan(parsed), [], planText);
  assert.ok(parsed.steps.some((s) => /^Pin the current behaviour around finding OPT-\d{3}/.test(s.title)), "tier B pins first");
  assert.match(planText, new RegExp(`${cat("major-upgrade").id} \\(Move to the next major of the HTTP layer\\) is left for your decision`));
  assert.match(planText, /improves by more than the noise/);
  const report = fs.readFileSync(sp.reportFile, "utf8");
  assert.match(report, /^# Optimization sweep report/);
  assert.match(report, /## Baseline/);
  assert.match(report, /unused files, exports and dependencies \(knip [\d.]+\): not checked \(no package\.json|npx is not on PATH/);
  assert.match(report, /outdated packages \(npm outdated\): not checked/);
  assert.equal(rec.alerts.length, 1);
  assert.match(rec.alerts[0].title, /optimize sweep finished/);
  assert.match(rec.alerts[0].message, new RegExp(`Next: review ${planRel.replace(/[.]/g, "[.]")}`));
  // The page walk of the read-only dev server: GET and HEAD only, no login.
  const walk = rec.calls.find((c) => c.role === "sweep-browser-0");
  const walkMcp = JSON.parse(fs.readFileSync(walk.args[walk.args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.playwright.args;
  assert.ok(!walkMcp.includes("--secrets"));
  assertNoLeak(everything(sp.dir), "the optimize sweep folder");
});

test("optimize sweep, fix right away: refused when the project moved on during the sweep, started when it did not", { skip }, async () => {
  const { root, id, run, windows, rec } = await sweep("optimize", "fix");
  assert.equal(run.code, 0, run.out + run.err);
  assert.equal(windows.length, 2, run.out);
  assert.deepEqual(windows[1].args.slice(-1), ["supervise"]);
  assert.equal(runPlanOverride(root), "OPTIMIZE_PLAN.md");
  assert.equal(g(root, ["rev-parse", "--abbrev-ref", "HEAD"]), fixBranch("optimize", id));
  assert.equal(readSweep(root, id).result.after, "fix");
  assert.match(rec.alerts[0].message, /OPTIMIZE_PLAN\.md/);

  // A second project where a commit lands while the sweep runs: fix is refused and the plan is
  // written for review instead, and the alert says why.
  const { root: root2, configDir } = makeProject("optimize-moved");
  const optionsFile = path.join(root2, ".autoclaude", "o.json");
  fs.mkdirSync(path.dirname(optionsFile), { recursive: true });
  fs.writeFileSync(optionsFile, JSON.stringify({ kind: "optimize", modules: ["duplicates"], depth: "quick", after: "fix", advisories: false, flakyReruns: 0 }));
  const w = [];
  const openConsoleWindow = (o) => { w.push(o); return { method: "windows-console", pid: 1 }; };
  const usage = () => ({ source: "test", fiveHour: { pct: 10 }, sevenDay: { pct: 10 } });
  await cli(["optimize", "--options", optionsFile], root2, { configDir, deps: { openConsoleWindow, readUsage: usage } });
  const id2 = w[0].args[w[0].args.length - 1];
  const rec2 = { alerts: [] };
  const run2 = fakeHeadless("optimize", rec2);
  let moved = false;
  const deps = {
    run: async (a) => {
      if (!moved) { moved = true; fs.writeFileSync(path.join(root2, "lib", "more.js"), "export const more = 1;\n"); g(root2, ["add", "-A"]); g(root2, ["commit", "-qm", "owner: more"]); }
      return run2(a);
    },
    readUsage: usage, sleep: async () => {}, notify: async (m) => { rec2.alerts.push(m); return { ok: true }; }, openConsoleWindow,
    recordBaseline: (a) => recordBaseline({ ...a, deps: { ensureDevServer: async () => ({ ok: true, skipped: true }) } }),
    runOptimizeScanners: (a) => runOptimizeScanners({ ...a, which: () => null }),
    verbose: false
  };
  const r2 = await cli(["sweep-run", id2], root2, { configDir, deps });
  assert.equal(r2.code, 0, r2.out + r2.err);
  assert.equal(w.length, 1, "no run window");
  const s2 = readSweep(root2, id2);
  assert.equal(s2.result.after, "plan");
  assert.match(s2.result.fixRefused, /moved on during the sweep/);
  assert.ok(fs.existsSync(path.join(root2, ".autoclaude", "sweeps", id2, "OPTIMIZE_PLAN.md")));
  assert.equal(fs.existsSync(path.join(root2, "OPTIMIZE_PLAN.md")), false);
  assert.equal(runPlanOverride(root2), null);
  assert.match(rec2.alerts[0].message, /Next: the fix run did not start \(the project moved on during the sweep/);
});

// One request through a browser session's own proxy, the way Chromium sends it (absolute URL).
function viaProxy(proxyUrl, method, url) {
  const p = new URL(proxyUrl);
  const u = new URL(url);
  return new Promise((resolve) => {
    const req = http.request({ host: p.hostname, port: p.port, method, path: url, headers: { host: u.host, "content-type": "application/json" } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode)); });
    req.on("error", () => resolve(null));
    req.end(method === "GET" || method === "HEAD" ? undefined : "{}");
  });
}

test("live checks through the real allow-list proxy: a read-only target's browser gets GET only and no login, a full target with writes allowed takes a POST and gets the login", { skip }, async () => {
  const hits = { ro: [], full: [] };
  const upstream = (list) => http.createServer((req, res) => { list.push(`${req.method} ${req.url}`); req.resume(); res.end("ok"); });
  const ro = upstream(hits.ro);
  const full = upstream(hits.full);
  await Promise.all([ro, full].map((s) => new Promise((r) => s.listen(0, "127.0.0.1", r))));
  const roUrl = `http://127.0.0.1:${ro.address().port}`;
  const fullUrl = `http://127.0.0.1:${full.address().port}`;
  const seen = {};
  try {
    // The fake browser session sends a GET and a POST to its own target through its own proxy.
    const wrapRun = (inner) => async (o) => {
      if (/^sweep-browser-/.test(o.role)) {
        const mcpArgs = JSON.parse(fs.readFileSync(o.args[o.args.indexOf("--mcp-config") + 1], "utf8")).mcpServers.playwright.args;
        const proxy = mcpArgs[mcpArgs.indexOf("--proxy-server") + 1];
        const origin = mcpArgs[mcpArgs.indexOf("--allowed-origins") + 1];
        seen[origin] = { get: await viaProxy(proxy, "GET", `${origin}/page`), post: await viaProxy(proxy, "POST", `${origin}/api/write`), other: await viaProxy(proxy, "GET", `${origin === roUrl ? fullUrl : roUrl}/page`), secrets: mcpArgs.includes("--secrets"), prompt: o.prompt };
      }
      return inner(o);
    };
    const { run, sp } = await sweep("security", "report", { wrapRun, override: { modules: ["live"], depth: "quick", writesAllowed: true, targets: [{ url: roUrl, mode: "readonly" }, { url: fullUrl, mode: "full" }] } });
    assert.equal(run.code, 0, run.out + run.err);
    // Read-only: the GET reaches the app, the POST never does, and no password is handed over.
    assert.deepEqual([seen[roUrl].get, seen[roUrl].post, seen[roUrl].secrets], [200, 403, false]);
    assert.deepEqual(hits.ro, ["GET /page"]);
    assert.match(seen[roUrl].prompt, /A read-only browse of this target/);
    // Full, writes allowed: the POST goes through, and the session signs in.
    assert.deepEqual([seen[fullUrl].get, seen[fullUrl].post, seen[fullUrl].secrets], [200, 200, true]);
    assert.deepEqual(hits.full, ["GET /page", "POST /api/write"]);
    assert.match(seen[fullUrl].prompt, /username alice@example\.com; for the password, type exactly SWEEP_USER_A_PASSWORD/);
    // Each session's proxy lets through its own target only.
    assert.equal(seen[roUrl].other, 403);
    assert.equal(seen[fullUrl].other, 403);
    const log = fs.readFileSync(sp.proxyLog, "utf8");
    assert.match(log, new RegExp(`REFUSE POST 127\\.0\\.0\\.1:${ro.address().port}`));
    assert.equal(fs.existsSync(sp.usersEnvFile), false, "the passwords are gone once the browser is done");
    assertNoLeak(everything(sp.dir), "the sweep folder");
  } finally {
    await Promise.all([ro, full].map((s) => new Promise((r) => s.close(r))));
  }
});
