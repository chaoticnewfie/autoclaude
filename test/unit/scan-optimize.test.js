import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as so from "../../plugins/autoclaude/lib/scan-optimize.js";
import { runCommand } from "../../plugins/autoclaude/lib/proc.js";
import { pluginRoot } from "../../plugins/autoclaude/lib/paths.js";

// Every test works in a temp folder; every tool (knip, jscpd, npm, git) is a fake runner. Only the
// per-file timing runs real `node --test` processes, on tiny files written here.

function tmp(prefix = "ac-opt-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function write(root, rel, text) {
  const f = path.join(root, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
}

// The test process's environment without Git Bash's marker, so checksEnv leaves PATH alone.
function cleanEnv() {
  const e = { ...process.env };
  delete e.MSYSTEM;
  return e;
}

// A command runner that answers by the first matching prefix or pattern and records each call.
function fakeRun(handlers) {
  const calls = [];
  const run = async (command, opts) => {
    calls.push({ command, opts });
    for (const [match, handler] of handlers) {
      if (typeof match === "string" ? command.startsWith(match) : match.test(command)) {
        return { code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 5, ...(await handler(command, opts)) };
      }
    }
    return { code: 1, stdout: "", stderr: `unexpected command: ${command}`, timedOut: false, durationMs: 1 };
  };
  run.calls = calls;
  return run;
}

const outputDirOf = (command) => {
  const m = /--output (?:"([^"]+)"|(\S+))/.exec(command);
  return m ? m[1] || m[2] : null;
};

// ---------- commands and test runners ----------

test("tokenize keeps quoted words whole and drops the quotes", () => {
  assert.deepEqual(so.tokenize('node --test "test/a b/*.js" \'x y\' z'), ["node", "--test", "test/a b/*.js", "x y", "z"]);
  assert.deepEqual(so.tokenize('"C:\\Program Files\\nodejs\\node.exe" --test'), ["C:\\Program Files\\nodejs\\node.exe", "--test"]);
});

test("expandCommand replaces npm, yarn and pnpm script calls by the scripts they run", () => {
  const scripts = { test: "node --test test/*.test.js", "test:all": "npm test && npm run e2e", e2e: "playwright test", lint: "eslint ." };
  assert.deepEqual(so.expandCommand("npm test", scripts), ["node --test test/*.test.js"]);
  assert.deepEqual(so.expandCommand("npm t", scripts), ["node --test test/*.test.js"]);
  assert.deepEqual(so.expandCommand("npm run test:all", scripts), ["node --test test/*.test.js", "playwright test"]);
  assert.deepEqual(so.expandCommand("npm run test -- --test-concurrency=1", scripts), ["node --test test/*.test.js --test-concurrency=1"]);
  assert.deepEqual(so.expandCommand("npm ci && npm run lint", scripts), ["npm ci", "eslint ."]);
  assert.deepEqual(so.expandCommand("yarn test", scripts), ["node --test test/*.test.js"]);
  assert.deepEqual(so.expandCommand("pnpm run e2e", scripts), ["playwright test"]);
  assert.deepEqual(so.expandCommand("npm run missing", scripts), ["npm run missing"]);
  // A script that calls itself stops expanding instead of looping.
  assert.ok(so.expandCommand("npm test", { test: "npm test" }).length >= 1);
});

test("parseNodeTestCommand reads env, flags and patterns, and drops reporters and watch", () => {
  const p = so.parseNodeTestCommand('NODE_ENV=test node --import tsx --test-reporter spec --test-concurrency=2 --test --watch "test/a b/*.test.js" test/x.test.js');
  assert.deepEqual(p, { exe: "node", env: { NODE_ENV: "test" }, flags: ["--import", "tsx"], patterns: ["test/a b/*.test.js", "test/x.test.js"], concurrency: 2 });
  const w = so.parseNodeTestCommand('"C:\\Program Files\\nodejs\\node.exe" --test --test-reporter=tap');
  assert.equal(w.exe, "C:\\Program Files\\nodejs\\node.exe");
  assert.deepEqual(w.patterns, []);
  assert.deepEqual(w.flags, []);
  assert.equal(so.parseNodeTestCommand("cross-env CI=1 node --test").env.CI, "1");
  assert.equal(so.parseNodeTestCommand("node server.js"), null);
  assert.equal(so.parseNodeTestCommand("eslint ."), null);
});

test("detectJsonRunner finds vitest and jest and keeps only the arguments that choose tests", () => {
  assert.deepEqual(so.detectJsonRunner("vitest run --reporter=verbose src/ --watch"), { runner: "vitest", args: ["src/"] });
  assert.deepEqual(so.detectJsonRunner("npx jest --coverage --outputFile out.json --json"), { runner: "jest", args: ["--coverage"] });
  assert.equal(so.detectJsonRunner("node --test"), null);
  assert.equal(so.detectJsonRunner("tsc -p vitest.config.ts"), null);
});

test("testSuites finds node --test through npm scripts and treats other test checks as whole suites", () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ scripts: { test: "node --test", e2e: "playwright test", unit: "vitest run src" } }));
  const checks = [
    { name: "unit", command: "npm test" },
    { name: "e2e", command: "npm run e2e" },
    { name: "lint", command: "eslint ." },
    { name: "vitest", command: "npm run unit" },
    { name: "again", command: "npm test" }
  ];
  const suites = so.testSuites(root, checks);
  assert.deepEqual(suites.map((s) => [s.check.name, s.runner]), [["unit", "node"], ["e2e", "other"], ["vitest", "vitest"]]);
  assert.deepEqual(suites[2].args, ["src"]);
});

test("parseTap names nested tests, marks skips and leaves suites out", () => {
  const tap = [
    "TAP version 13",
    "# Subtest: one passes",
    "ok 1 - one passes",
    "  ---",
    "  duration_ms: 1.2",
    "  type: 'test'",
    "  ...",
    "# Subtest: group",
    "    # Subtest: inner ok",
    "    ok 1 - inner ok",
    "      ---",
    "      type: 'test'",
    "      ...",
    "    # Subtest: inner bad",
    "    not ok 2 - inner bad",
    "      ---",
    "      type: 'test'",
    "      ...",
    "    1..2",
    "not ok 2 - group",
    "  ---",
    "  type: 'suite'",
    "  ...",
    "# Subtest: skipped",
    "ok 3 - skipped # SKIP",
    "1..3"
  ].join("\r\n");
  assert.deepEqual(so.parseTap(tap), [
    { name: "one passes", status: "pass" },
    { name: "group > inner ok", status: "pass" },
    { name: "group > inner bad", status: "fail" },
    { name: "skipped", status: "skip" }
  ]);
  assert.deepEqual(so.parseTap(""), []);
});

test("parseJestJson gives each file's time, result and tests", () => {
  const root = path.resolve(tmp());
  const json = {
    testResults: [
      { name: path.join(root, "src", "a.test.ts"), startTime: 1000, endTime: 1250, status: "passed", assertionResults: [{ fullName: "a works", status: "passed" }, { ancestorTitles: ["b"], title: "later", status: "pending" }] },
      { name: "src/b.test.ts", status: "failed", assertionResults: [{ fullName: "b fails", status: "failed", duration: 30 }] }
    ]
  };
  assert.deepEqual(so.parseJestJson(json, root), [
    { file: "src/a.test.ts", ms: 250, ok: true, tests: [{ name: "a works", status: "pass" }, { name: "b > later", status: "skip" }] },
    { file: "src/b.test.ts", ms: 30, ok: false, tests: [{ name: "b fails", status: "fail" }] }
  ]);
  assert.deepEqual(so.parseJestJson(null, root), []);
});

test("nodeTestFiles resolves globs, folders and node's default patterns, never node_modules", () => {
  const root = tmp();
  for (const f of ["test/a.test.mjs", "test/b.test.mjs", "test/helper.mjs", "src/d.test.js", "node_modules/x/test/c.test.js", "src/app.js"]) write(root, f, "");
  assert.deepEqual(so.nodeTestFiles(root, ["test/*.test.mjs"]), ["test/a.test.mjs", "test/b.test.mjs"]);
  assert.deepEqual(so.nodeTestFiles(root, ["src/d.test.js"]), ["src/d.test.js"]);
  assert.deepEqual(so.nodeTestFiles(root, ["test"]), ["test/a.test.mjs", "test/b.test.mjs"]);
  assert.deepEqual(so.nodeTestFiles(root, []), ["src/d.test.js", "test/a.test.mjs", "test/b.test.mjs", "test/helper.mjs"]);
  assert.deepEqual(so.nodeTestFiles(root, ["nothing/*.js"]), []);
});

test("flakyReruns defaults to 2, allows 0 and caps at 10", () => {
  assert.equal(so.flakyReruns({}), so.DEFAULT_FLAKY_RERUNS);
  assert.equal(so.DEFAULT_FLAKY_RERUNS, 2);
  assert.equal(so.flakyReruns({ flakyReruns: 0 }), 0);
  assert.equal(so.flakyReruns({ flakyReruns: 50 }), 10);
  assert.equal(so.flakyReruns({ flakyReruns: "3" }), 2);
  assert.equal(so.flakyReruns(null), 2);
});

test("median takes the middle value and ignores what is not a number", () => {
  assert.equal(so.median([3, 1, 2]), 2);
  assert.equal(so.median([4, 1, 2, 3]), 3);
  assert.equal(so.median([5, null, NaN]), 5);
  assert.equal(so.median([]), null);
});

// ---------- packages and the bundle ----------

test("countLockPackages counts the packages each kind of lockfile pins", () => {
  const cases = [
    ["package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": {}, "node_modules/a/node_modules/b": {}, "node_modules/ws": { link: true }, "packages/ws": {} } }), 2],
    ["package-lock.json", JSON.stringify({ lockfileVersion: 1, dependencies: { a: { version: "1.0.0", dependencies: { b: {} } }, c: {} } }), 3],
    ["pnpm-lock.yaml", "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      a:\n\npackages:\n\n  a@1.0.0:\n    resolution: {}\n\n  '@s/b@2.0.0':\n    resolution: {}\n\nsnapshots:\n\n  a@1.0.0: {}\n", 2],
    ["yarn.lock", '# yarn lockfile v1\n\n"a@^1.0.0", "a@^1.1.0":\n  version "1.1.0"\n\nb@^2:\n  version "2.0.0"\n', 2],
    ["Cargo.lock", '[[package]]\nname = "a"\n\n[[package]]\nname = "b"\n', 2],
    ["go.sum", "mod/a v1.0.0 h1:x\nmod/a v1.0.0/go.mod h1:y\nmod/b v0.2.0 h1:z\n", 2],
    ["composer.lock", JSON.stringify({ packages: [{}, {}], "packages-dev": [{}] }), 3]
  ];
  for (const [file, text, count] of cases) {
    const root = tmp();
    write(root, file, text);
    assert.deepEqual(so.countLockPackages(root), { lockfile: file, count }, file);
  }
  assert.equal(so.countLockPackages(tmp()), null);
});

test("measureFolder sums raw and gzip bytes per type, counts maps apart and keeps compressed files at raw size", () => {
  const root = tmp();
  write(root, "dist/assets/app.js", "console.log('hello world');\n".repeat(400));
  write(root, "dist/assets/app.js.map", "12345");
  fs.writeFileSync(path.join(root, "dist", "logo.png"), Buffer.from(Array.from({ length: 300 }, (_, i) => (i * 37) % 256)));
  write(root, "dist/index.html", "<!doctype html><title>x</title>");
  const m = so.measureFolder(path.join(root, "dist"), { root });
  assert.equal(m.dir, "dist");
  assert.equal(m.files, 3);
  assert.equal(m.mapBytes, 5);
  assert.equal(m.byType.js.files, 1);
  assert.ok(m.byType.js.gzipBytes < m.byType.js.rawBytes);
  assert.equal(m.byType.images.gzipBytes, m.byType.images.rawBytes);
  assert.equal(m.rawBytes, m.byType.js.rawBytes + m.byType.images.rawBytes + m.byType.html.rawBytes);
  assert.equal(m.gzipBytes, m.byType.js.gzipBytes + m.byType.images.gzipBytes + m.byType.html.gzipBytes);
  assert.ok(m.largest.some((f) => f.file === "assets/app.js"));
  assert.equal(m.truncated, false);
});

// ---------- recordBaseline ----------

const FLAKY_TEST = [
  'import { test } from "node:test";',
  'import fs from "node:fs";',
  'const f = new URL("../counter.txt", import.meta.url);',
  "let n = 0;",
  'try { n = Number(fs.readFileSync(f, "utf8")) || 0; } catch {}',
  "fs.writeFileSync(f, String(n + 1));",
  'test("sometimes", () => { if (n % 2 === 1) throw new Error("odd run"); });',
  ""
].join("\n");

test("recordBaseline times the checks, each test file over identical runs, finds the flaky test, and measures build, bundle, packages and dev server", async () => {
  const root = tmp();
  const sweepDir = path.join(root, ".autoclaude", "sweeps", "20261002-1200-optimize");
  write(root, "package.json", JSON.stringify({ name: "demo", scripts: { build: "node build.js" } }));
  write(root, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/a": {}, "node_modules/b": {} } }));
  write(root, "test/stable.test.mjs", 'import { test } from "node:test";\ntest("stable", () => {});\n');
  write(root, "test/flaky.test.mjs", FLAKY_TEST);
  const node = JSON.stringify(process.execPath);
  const config = {
    checks: [{ name: "unit", command: `${node} --test test/*.test.mjs`, timeoutSec: 120 }],
    devServer: { command: "npm start", url: "http://127.0.0.1:9", healthPath: "/" }
  };
  let clock = Date.now();
  const run = async (command, opts) => {
    if (command === "npm run build") {
      write(root, "dist/main.js", "export const x = 1;\n".repeat(50));
      return { code: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1234 };
    }
    return runCommand(command, opts);
  };
  const deps = {
    now: () => clock,
    ensureDevServer: async (ds, opts) => { assert.equal(opts.root, root); clock += 700; return { ok: true, reused: false, pid: 1, url: ds.url }; }
  };
  const b = await so.recordBaseline({ root, env: cleanEnv(), config, sweepDir, run, options: { flakyReruns: 2 }, deps });

  assert.deepEqual(JSON.parse(fs.readFileSync(so.baselineFile(sweepDir), "utf8")), JSON.parse(JSON.stringify(b)));
  assert.deepEqual(so.readBaseline(sweepDir), JSON.parse(JSON.stringify(b)));
  assert.equal(b.checks.length, 1);
  assert.equal(b.checks[0].name, "unit");
  assert.equal(b.checks[0].ok, true);
  assert.ok(b.checks[0].ms > 0);
  assert.equal(b.checksGreen, true);
  assert.deepEqual(b.devServer, { url: "http://127.0.0.1:9", ok: true, reused: false, startMs: 700, error: null });
  assert.deepEqual(b.packages, { lockfile: "package-lock.json", count: 2, direct: 0 });

  assert.equal(b.testFiles.length, 1);
  const suite = b.testFiles[0];
  assert.equal(suite.runner, "node");
  assert.equal(suite.rounds, 3);
  assert.deepEqual(suite.files.map((f) => f.file).sort(), ["test/flaky.test.mjs", "test/stable.test.mjs"]);
  for (const f of suite.files) {
    assert.equal(f.samples.length, 3);
    assert.equal(f.tests, 1);
    assert.ok(f.ms > 0);
  }
  assert.equal(suite.files.find((f) => f.file === "test/stable.test.mjs").ok, true);
  // The check run was the counter's run 0 (pass); the three timed runs were 1, 2 and 3.
  assert.deepEqual(b.flaky.tests, [{ check: "unit", file: "test/flaky.test.mjs", name: "sometimes", passed: 1, failed: 2, runs: 3 }]);
  assert.deepEqual(b.flaky.files, []);

  assert.deepEqual(b.build, { command: "npm run build", ok: true, ms: 1234, fromCheck: null, reason: null });
  assert.equal(b.bundle.dir, "dist");
  assert.equal(b.bundle.files, 1);
  assert.ok(b.bundle.gzipBytes > 0 && b.bundle.gzipBytes < b.bundle.rawBytes);
  assert.equal(b.pages, null);
  assert.ok(b.coverage.notExamined.some((s) => s.startsWith("page timings:")));
  assert.ok(b.coverage.examined.some((s) => /test files of "unit": 2 files timed, 3 runs each/.test(s)));
});

test("recordBaseline times vitest files from its JSON report and finds a test that flips", async () => {
  const root = tmp();
  const sweepDir = path.join(root, ".autoclaude", "sweeps", "s");
  write(root, "package.json", JSON.stringify({ scripts: { test: "vitest run src" } }));
  let round = 0;
  const run = fakeRun([
    ["npx --no vitest run src --reporter=json", (command) => {
      const out = /--outputFile=([^"\s]+)/.exec(command)[1];
      const flips = round % 2 === 0 ? "passed" : "failed";
      fs.writeFileSync(out, JSON.stringify({ testResults: [
        { name: path.join(root, "src", "a.test.ts"), startTime: 0, endTime: 300 + round, status: "passed", assertionResults: [{ fullName: "a ok", status: "passed" }] },
        { name: path.join(root, "src", "b.test.ts"), startTime: 0, endTime: 900, status: flips, assertionResults: [{ fullName: "b flips", status: flips }] }
      ] }));
      round++;
      return {};
    }]
  ]);
  const deps = { runChecks: async () => ({ ok: true, results: [{ ok: true, durationMs: 4000 }] }) };
  const b = await so.recordBaseline({ root, env: { ...cleanEnv(), NODE_TEST_CONTEXT: "child-v8" }, config: { checks: [{ name: "unit", command: "npm test" }] }, sweepDir, run, deps });
  assert.equal(run.calls.length, 3);
  assert.ok(run.calls.every((c) => c.opts.env.NODE_TEST_CONTEXT === undefined), "a nested test runner must print its own report");
  const suite = b.testFiles[0];
  assert.equal(suite.runner, "vitest");
  assert.deepEqual(suite.files.map((f) => [f.file, f.ms]), [["src/b.test.ts", 900], ["src/a.test.ts", 301]]);
  assert.deepEqual(b.flaky.tests, [{ check: "unit", file: "src/b.test.ts", name: "b flips", passed: 2, failed: 1, runs: 3 }]);
  assert.equal(fs.readdirSync(path.join(sweepDir, "scanners", "tmp")).length, 0, "the JSON reports are removed");
});

test("recordBaseline reports a runner without a JSON report as not checked", async () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ scripts: { test: "jest" } }));
  const run = fakeRun([["npx --no jest", () => ({ code: 1, stderr: "jest: not found" })]]);
  const deps = { runChecks: async () => ({ ok: true, results: [{ ok: true, durationMs: 10 }] }) };
  const b = await so.recordBaseline({ root, env: cleanEnv(), config: { checks: [{ name: "unit", command: "npm test" }] }, sweepDir: path.join(root, "sw"), run, deps });
  assert.deepEqual(b.testFiles, []);
  assert.ok(b.coverage.notExamined.some((s) => /test files of "unit": not checked \(jest wrote no JSON report: exit code 1: jest: not found\)/.test(s)));
});

test("recordBaseline reruns other test checks as a whole and reports a check that flips", async () => {
  const root = tmp();
  const outcomes = [true, false, true];
  const seen = [];
  const deps = {
    runChecks: async (checks, opts) => {
      seen.push(checks[0].name);
      assert.equal(opts.cwd, root);
      const ok = outcomes.shift();
      return { ok, results: [{ ok, durationMs: 50, reason: ok ? null : "exit code 1" }] };
    }
  };
  const b = await so.recordBaseline({ root, env: cleanEnv(), config: { checks: [{ name: "e2e", command: "pytest -q" }] }, sweepDir: path.join(root, "sw"), run: fakeRun([]), deps });
  assert.deepEqual(seen, ["e2e", "e2e", "e2e"]);
  assert.deepEqual(b.flaky.suites, [{ check: "e2e", command: "pytest -q", passed: 2, runs: 3 }]);
  assert.ok(b.coverage.notExamined.some((s) => s.startsWith('per-file times of "e2e": not checked')));
  assert.ok(b.coverage.notExamined.includes("dev-server start time: not checked (no dev server is configured)"));
  assert.ok(b.coverage.notExamined.includes("build time and bundle size: not checked (no build script)"));
});

test("recordBaseline skips test timing when the tests module is off, and says what it did not measure", async () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ scripts: { build: "vite build" }, dependencies: { a: "1" }, devDependencies: { b: "1" } }));
  write(root, "pnpm-lock.yaml", "packages:\n\n  a@1.0.0:\n    resolution: {}\n");
  let reruns = 0;
  const deps = { runChecks: async () => { reruns++; return { ok: false, results: [{ ok: false, durationMs: 20, reason: "exit code 2" }] }; } };
  const run = fakeRun([["pnpm run build", () => ({ code: 2, stderr: "build broke" })]]);
  const b = await so.recordBaseline({ root, env: cleanEnv(), config: { checks: [{ name: "unit", command: "npm test" }] }, sweepDir: path.join(root, "sw"), run, options: { modules: ["unused"] }, deps });
  assert.equal(reruns, 1, "each check runs once for its time, no reruns");
  assert.equal(b.checksGreen, false);
  assert.deepEqual(b.checks, [{ name: "unit", command: "npm test", ok: false, ms: 20, reason: "exit code 2" }]);
  assert.equal(b.flaky, null);
  assert.ok(b.coverage.notExamined.includes("test files and flaky tests: not checked (the tests module is off)"));
  assert.deepEqual(b.packages, { lockfile: "pnpm-lock.yaml", count: 1, direct: 2 });
  assert.equal(b.build.ok, false);
  assert.equal(b.bundle, null);
  assert.ok(b.coverage.notExamined.some((s) => /build time and bundle size: not checked \(the build failed: exit code 2: build broke\)/.test(s)));
});

test("recordBaseline takes the build time from a build check instead of building twice, and never measures a stale output folder", async () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ scripts: { build: "node build.js" } }));
  write(root, "dist/old.js", "x");
  const old = new Date(Date.now() - 3600 * 1000);
  fs.utimesSync(path.join(root, "dist", "old.js"), old, old);
  const run = fakeRun([]);
  const deps = { runChecks: async () => ({ ok: true, results: [{ ok: true, durationMs: 777 }] }) };
  const b = await so.recordBaseline({ root, env: cleanEnv(), config: { checks: [{ name: "build", command: "npm run build" }] }, sweepDir: path.join(root, "sw"), run, deps });
  assert.equal(run.calls.length, 0);
  assert.deepEqual(b.build, { command: "npm run build", ok: true, ms: 777, fromCheck: "build", reason: null });
  assert.equal(b.bundle, null);
  assert.ok(b.coverage.notExamined.some((s) => s.startsWith("bundle size: not checked (the build wrote none of")));
});

test("recordBaseline notes a dev server it could not time (already running, or not starting)", async () => {
  const root = tmp();
  const config = { devServer: { command: "npm start", url: "http://127.0.0.1:9" } };
  const reused = await so.recordBaseline({ root, env: cleanEnv(), config, sweepDir: path.join(root, "a"), run: fakeRun([]), deps: { ensureDevServer: async () => ({ ok: true, reused: true }) } });
  assert.equal(reused.devServer.startMs, null);
  assert.ok(reused.coverage.notExamined.includes("dev-server start time: not checked (a server was already answering at its URL)"));
  const failed = await so.recordBaseline({ root, env: cleanEnv(), config, sweepDir: path.join(root, "b"), run: fakeRun([]), deps: { ensureDevServer: async () => ({ ok: false, error: "port in use" }) } });
  assert.equal(failed.devServer.ok, false);
  assert.equal(failed.devServer.error, "port in use");
  assert.ok(failed.coverage.notExamined.some((s) => /did not start: port in use/.test(s)));
});

test("recordBrowserBaseline adds the measured pages to the baseline and replaces the pending note", async () => {
  const root = tmp();
  const sweepDir = path.join(root, "sw");
  await so.recordBaseline({ root, env: cleanEnv(), config: {}, sweepDir, run: fakeRun([]) });
  const b = so.recordBrowserBaseline(sweepDir, {
    pages: [
      { url: "/", loads: 5, loadMsMedian: 420, loadMsMin: 400, loadMsMax: 480, requests: 23, transferKb: 310, duplicateApiCalls: ["GET /api/me"], heavyAssets: [], consoleErrors: 0 },
      { title: "no url" }
    ],
    browserUnavailable: false
  }, { now: () => Date.UTC(2026, 9, 2) });
  assert.equal(b.pages.length, 1);
  assert.equal(b.pages[0].loadMsMedian, 420);
  assert.deepEqual(b.pages[0].duplicateApiCalls, ["GET /api/me"]);
  assert.equal(b.pagesAt, "2026-10-02T00:00:00.000Z");
  assert.ok(!b.coverage.notExamined.some((s) => s.startsWith("page timings:")));
  assert.ok(b.coverage.examined.includes("page timings: 1 page measured by the browser walk"));
  assert.deepEqual(so.readBaseline(sweepDir).pages, b.pages);

  const none = so.recordBrowserBaseline(path.join(root, "other"), { pages: [], browserUnavailable: true });
  assert.deepEqual(none.pages, []);
  assert.ok(none.coverage.notExamined.includes("page timings: not checked (no browser was available)"));
});

test("optimizeBrowserSchema adds the pages and the browser flag to the candidates schema", () => {
  const base = { type: "object", properties: { findings: { type: "array" }, notes: { type: "string" } }, required: ["findings", "notes"] };
  const s = so.optimizeBrowserSchema(base);
  assert.deepEqual(s.required, ["findings", "notes", "pages", "browserUnavailable"]);
  assert.equal(s.properties.pages.items, so.PAGE_SCHEMA);
  assert.deepEqual(s.properties.browserUnavailable, { type: "boolean" });
  assert.deepEqual(base.required, ["findings", "notes"], "the shared schema is not changed");
  assert.deepEqual(so.optimizeBrowserSchema(null).required, ["pages", "browserUnavailable"]);
});

// ---------- tiers and conventions ----------

test("applyTierRules never makes a finding safer and keeps schema, migration and auth code report-only", () => {
  const t = (c) => so.applyTierRules({ autoFixSafe: true, file: "src/x.js", ...c });
  assert.deepEqual([t({ category: "unused-file", tier: "A" }).tier, t({ category: "unused-file", tier: "A" }).autoFixSafe], ["A", true]);
  assert.deepEqual([t({ category: "duplicate", tier: "A" }).tier, t({ category: "duplicate", tier: "A" }).autoFixSafe], ["B", false]);
  assert.equal(t({ category: "major-upgrade", tier: "A" }).tier, "C");
  assert.equal(t({ category: "made-up", tier: "A" }).tier, "C");
  assert.equal(t({ category: "rebuild", tier: "C" }).tier, "C");
  assert.equal(t({ category: "unused-file", tier: "A", file: "db/migrations/001_init.js" }).tier, "C");
  assert.equal(t({ category: "unused-file", tier: "A", file: "schema.prisma" }).tier, "C");
  assert.equal(t({ category: "performance", tier: "B", file: "src/auth/login.js" }).tier, "C");
  assert.equal(t({ category: "duplicate", tier: "B", file: "src/session.ts" }).tier, "C");
  assert.equal(t({ category: "duplicate", tier: "B", file: "lib/sessions/store.js" }).tier, "C");
  assert.equal(t({ category: "duplicate", tier: "B", file: "scripts/session-context.js" }).tier, "B", "a session that is not a login session");
  assert.equal(t({ category: "flaky-test", tier: "B", file: "test/auth.test.js" }).tier, "B");
  assert.equal(t({ category: "leftover", tier: "bogus" }).tier, "A");
  const todo = t({ category: "stale-todo", tier: "A", autoFixSafe: false });
  assert.deepEqual([todo.tier, todo.autoFixSafe], ["A", false]);
  for (const c of so.OPTIMIZE_CATEGORIES) assert.ok(["A", "B", "C"].includes(so.TIER_FLOOR[c]), c);
});

test("entryPointFile and entryPointDependency know the stack conventions", () => {
  assert.equal(so.entryPointFile("pages/index.tsx"), "file-system pages");
  assert.equal(so.entryPointFile("src/app/orders/page.tsx"), "app router file");
  assert.equal(so.entryPointFile("db/migrations/001.js"), "migrations and seeds");
  assert.equal(so.entryPointFile("vite.config.ts"), "tool config file");
  assert.equal(so.entryPointFile("scripts/stop-gate.js"), "CLI and scripts");
  assert.equal(so.entryPointFile("project-template/x.js"), "template copied by path");
  assert.equal(so.entryPointFile("src/main.ts"), "application entry point");
  assert.equal(so.entryPointFile("lib/dist/x.js", new Set(["lib/dist/x.js"])), "a package.json entry (main, exports or bin)");
  assert.equal(so.entryPointFile("src/lib/helper.js"), null);
  assert.equal(so.entryPointFile("src/app/helper.js"), null);
  assert.equal(so.entryPointDependency("@types/node"), "type definitions");
  assert.equal(so.entryPointDependency("eslint-plugin-react"), "lint configuration");
  assert.equal(so.entryPointDependency("@babel/preset-env"), "Babel preset or plugin");
  assert.equal(so.entryPointDependency("typescript"), "compiler or runtime helper");
  assert.equal(so.entryPointDependency("lodash"), null);
});

test("packageMatcher and fileMatchers match real references and not look-alikes", () => {
  const pm = (name, text) => so.packageMatcher(name).re.test(text);
  assert.ok(pm("react", 'import x from "react"'));
  assert.ok(pm("react", 'import x from "react/jsx-runtime"'));
  assert.ok(pm("lodash", "uses lodash."));
  assert.ok(!pm("react", 'import x from "react-dom"'));
  assert.ok(!pm("react", '"@types/react"'));
  assert.ok(!pm("lodash", 'require("lodash.debounce")'));
  assert.ok(pm("@scope/pkg", 'from "@scope/pkg"'));
  const fm = (rel, text) => so.fileMatchers(rel).some((m) => text.includes(m.needle) && m.re.test(text));
  assert.ok(fm("scripts/stop-gate.js", '"command": "node ${ROOT}/scripts/stop-gate.js"'));
  assert.ok(fm("lib/footprint.js", 'lazyExport("./footprint.js", "x")'));
  assert.ok(fm("lib/footprint.js", 'import("./footprint")'));
  assert.ok(fm("src/components/index.js", 'import { A } from "./components"'));
  assert.ok(fm("app/helpers.py", "from app import helpers"));
  assert.ok(!fm("lib/footprint.js", "the footprint of a run"));
  assert.ok(!fm("lib/gate.js", "gate.json and gates"));
  const im = so.identifierMatcher("helper");
  assert.ok(im.re.test("x = helper();"));
  assert.ok(!im.re.test("x = helpers();"));
});

test("isExcluded matches the owner's globs below folders and by file name", () => {
  assert.ok(so.isExcluded("legacy/a/b.js", ["legacy/**"]));
  assert.ok(so.isExcluded("legacy/a/b.js", ["legacy"]));
  assert.ok(so.isExcluded("src/vendor/x.min.js", ["*.min.js"]));
  assert.ok(!so.isExcluded("src/a.js", ["legacy/**", "*.min.js"]));
  assert.ok(!so.isExcluded("src/a.js", []));
});

// ---------- leftovers, blame, churn, outdated ----------

test("findCommentedOutBlocks finds code left in comments and leaves prose alone", () => {
  const js = [
    "// Returns the total of the order.",
    "// It ignores refunds, see below.",
    "// and the tax.",
    "function total(o) {",
    "  // const old = compute(o);",
    "  // if (old > 0) {",
    "  //   return old;",
    "  // }",
    "  return 1;",
    "}"
  ].join("\n");
  assert.deepEqual(so.findCommentedOutBlocks(js, "js"), [{ start: 5, end: 8 }]);
  assert.deepEqual(so.findCommentedOutBlocks("#!/usr/bin/env python\n# x = load()\n# print(x)\n# return x\n", "py"), [{ start: 2, end: 4 }]);
  assert.deepEqual(so.findCommentedOutBlocks("// if the user is logged in\n// we show the menu\n// and the name\n", "js"), []);
  assert.deepEqual(so.findCommentedOutBlocks("// a = 1;\n// b = 2;\n", "js"), [], "two lines are not a block");
  assert.deepEqual(so.findCommentedOutBlocks("x", "md"), []);
  assert.equal(so.looksLikeCode(" return x;"), true);
  assert.equal(so.looksLikeCode(" return the first match"), false);
});

test("findTodoLines reads TODO, FIXME and HACK comments only, not tags inside strings or names", () => {
  const text = [
    "// TODO: remove this",
    "const s = 'TODO';",
    "# FIXME later",
    "/* HACK (bob) */",
    "<!-- TODO move -->",
    'const t = "// TODO not a comment";',
    "y = a * TODO_COUNT;",
    "x = 1  # XXX: check",
    " * TODO in a doc block"
  ].join("\n");
  assert.deepEqual(so.findTodoLines(text), [
    { line: 1, tag: "TODO", text: "remove this" },
    { line: 3, tag: "FIXME", text: "later" },
    { line: 4, tag: "HACK", text: "bob)" },
    { line: 5, tag: "TODO", text: "move" },
    { line: 8, tag: "XXX", text: "check" },
    { line: 9, tag: "TODO", text: "in a doc block" }
  ]);
});

test("parseBlameTimes maps each final line to its commit's author time", () => {
  const a = "a".repeat(40);
  const b = "b".repeat(40);
  const out = [`${a} 12 12 1`, "author A", "author-time 1600000000", "\t// TODO x", `${b} 40 40 1`, "author-time 1700000000", "\t// FIXME y", `${a} 50 55 1`, "\t// TODO z"].join("\n");
  assert.deepEqual([...so.parseBlameTimes(out)].sort((x, y) => x[0] - y[0]), [[12, 1600000000], [40, 1700000000], [55, 1600000000]]);
});

test("parseChurn counts commits, fix commits and changed lines per file, renames under the new name", () => {
  const out = ["@@@fix: crash on empty list", "3\t1\tsrc/a.js", "-\t-\tlogo.png", "@@@feat: add b", "10\t0\tsrc/{old => new}/b.js", "5\t2\tsrc/a.js", "@@@rename", "0\t0\tlib/x.js => lib/y.js"].join("\n");
  const m = so.parseChurn(out);
  assert.deepEqual(m.get("src/a.js"), { commits: 2, fixes: 1, changed: 11 });
  assert.deepEqual(m.get("src/new/b.js"), { commits: 1, fixes: 0, changed: 10 });
  assert.deepEqual(m.get("lib/y.js"), { commits: 1, fixes: 0, changed: 0 });
  assert.deepEqual(m.get("logo.png"), { commits: 1, fixes: 1, changed: 0 });
});

test("parseJscpd keeps the places, drops the code and the embedded-format suffix", () => {
  const d = so.parseJscpd({ duplicates: [
    { format: "markdown", lines: 16, tokens: 90, fragment: "secret", firstFile: { name: "test\\plans\\a.md:markdown", startLoc: { line: 16 }, endLoc: { line: 31 } }, secondFile: { name: "./b.md", start: 20, end: 35 } },
    { lines: 3, firstFile: { name: "" }, secondFile: { name: "x.js" } }
  ] });
  assert.deepEqual(d, [{ lines: 16, tokens: 90, format: "markdown", a: { file: "test/plans/a.md", start: 16, end: 31 }, b: { file: "b.md", start: 20, end: 35 } }]);
  assert.deepEqual(so.parseJscpd(null), []);
});

test("isMajorJump follows semver, including 0.x", () => {
  assert.equal(so.isMajorJump("1.2.3", "2.0.0"), true);
  assert.equal(so.isMajorJump("1.2.3", "1.9.0"), false);
  assert.equal(so.isMajorJump("0.3.1", "0.4.0"), true);
  assert.equal(so.isMajorJump("0.3.1", "0.3.9"), false);
  assert.equal(so.isMajorJump("0.0.3", "0.0.4"), true);
  assert.equal(so.isMajorJump("x", "1.0.0"), false);
});

test("outdatedCandidates makes patch and minor upgrades tier A and reports a new major as tier C", () => {
  const manifest = '{\n  "dependencies": {\n    "a": "^1.2.0",\n    "b": "1.0.0",\n    "c": "^0.3.1",\n    "d": "^1.0.0"\n  }\n}\n';
  const entries = so.parseOutdated({
    a: { current: "1.2.0", wanted: "1.3.0", latest: "2.0.0" },
    b: { current: "1.0.0", wanted: "1.0.0", latest: "1.4.2" },
    c: [{ current: "0.3.1", wanted: "0.3.1", latest: "0.4.0" }],
    d: { wanted: "1.0.0", latest: "1.0.0" }
  });
  assert.equal(entries.length, 4);
  const got = so.outdatedCandidates(entries, manifest).map((c) => [c.category, c.evidence.split(" ")[0], c.fixedVersion, c.tier, c.line]);
  assert.deepEqual(got, [
    ["outdated", "a", "1.3.0", "A", 3],
    ["major-upgrade", "a", "2.0.0", "C", 3],
    ["outdated", "b", "1.4.2", "A", 4],
    ["major-upgrade", "c", "0.4.0", "C", 5]
  ]);
});

test("testCandidates turns flaky tests and the slowest files into tier B findings", () => {
  const baseline = {
    flaky: { rounds: 3, tests: [{ check: "unit", file: "test/a.test.js", name: "x", passed: 1, failed: 2, runs: 3 }], files: [{ check: "unit", file: "test/c.test.js", passed: 2, runs: 3 }], suites: [{ check: "e2e", command: "pytest", passed: 2, runs: 3 }] },
    testFiles: [{ check: "unit", runner: "node", rounds: 3, files: [{ file: "test/slow.test.js", ms: 20000, samples: [20000, 21000, 19000] }, { file: "test/a.test.js", ms: 1000, samples: [1000] }, { file: "test/b.test.js", ms: 800, samples: [800] }] }]
  };
  const c = so.testCandidates(baseline);
  assert.deepEqual(c.map((x) => [x.category, x.file, x.severity, x.tier]), [
    ["flaky-test", "test/a.test.js", "medium", "B"],
    ["flaky-test", "test/c.test.js", "medium", "B"],
    ["flaky-test", "", "medium", "B"],
    ["slow-test", "test/slow.test.js", "medium", "B"]
  ]);
  assert.match(c[0].fix, /Never skip it/);
  assert.match(c[3].evidence, /median 20\.0 s over 3 runs, 92%/);
  assert.deepEqual(so.testCandidates(null), []);
});

// ---------- listing and the corpus ----------

test("listProjectFiles uses git's list and leaves node_modules and .autoclaude out, or walks the folder without git", async () => {
  const run = fakeRun([["git ls-files", () => ({ stdout: "b.js\0node_modules/x/i.js\0.autoclaude/s.json\0src\\a.js\0" })]]);
  assert.deepEqual(await so.listProjectFiles("/p", { run }), { files: ["b.js", "src/a.js"], source: "git" });
  assert.equal(run.calls[0].opts.env.GIT_TERMINAL_PROMPT, "0");
  const root = tmp();
  for (const f of ["a.js", "src/b.js", "node_modules/x/c.js", "dist/d.js", ".autoclaude/e.json"]) write(root, f, "x");
  const walked = await so.listProjectFiles(root, { run: fakeRun([]) });
  assert.deepEqual(walked, { files: ["a.js", "src/b.js"], source: "folder" });
});

test("loadCorpus skips lockfiles, binaries, generated plans and big files, and strips package.json's dependency blocks", () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "x", scripts: { lint: "eslint ." }, dependencies: { "left-pad": "1" } }));
  write(root, "package-lock.json", "{}");
  write(root, "OPTIMIZE_PLAN.md", "src/dead.js");
  write(root, "src/a.js", "a");
  fs.writeFileSync(path.join(root, "src", "bin.dat"), Buffer.from([1, 0, 2]));
  write(root, "big.txt", "x".repeat(1024 * 1024 + 10));
  write(root, "logo.png", "not really");
  const corpus = so.loadCorpus(root, ["package.json", "package-lock.json", "OPTIMIZE_PLAN.md", "src/a.js", "src/bin.dat", "big.txt", "logo.png", "missing.js"]);
  assert.deepEqual([...corpus.keys()], ["package.json", "src/a.js"]);
  assert.ok(corpus.get("package.json").includes("eslint ."));
  assert.ok(!corpus.get("package.json").includes("left-pad"));
});

// ---------- runOptimizeScanners ----------

const DAY = 86400;

// A small project with one of each problem the scanners look for, and look-alikes they must keep.
function demoProject() {
  const root = tmp();
  write(root, "package.json", JSON.stringify({
    name: "demo",
    main: "src/index.js",
    scripts: { start: "node src/index.js", lint: "eslint ." },
    dependencies: { lodash: "^4.17.20", "left-pad": "^1.3.0" },
    devDependencies: { "@types/node": "^20.0.0", eslint: "^8.57.0", typescript: "^5.0.0" }
  }, null, 2));
  write(root, "package-lock.json", JSON.stringify({ lockfileVersion: 3, packages: { "": {} } }));
  write(root, "src/index.js", 'import _ from "lodash";\nimport { helper, shared } from "./util.js";\nconsole.log(_.chunk([1], 1), helper(), shared);\nimport chalk from "chalk";\n');
  write(root, "src/util.js", [
    "export function helper() { return internalOnly() + 1; }",
    "export function internalOnly() { return 1; }",
    "export function usedInTest() { return 2; }",
    "export const shared = 3;",
    "// const legacy = compute();",
    "// if (legacy) {",
    "//   run(legacy);",
    "// }",
    ""
  ].join("\n"));
  write(root, "test/util.test.js", 'import { usedInTest } from "../src/util.js";\n');
  write(root, "src/dead.js", "export const nothing = 1;\n");
  write(root, "lib/gate-helper.js", "module.exports = 1;\n");
  write(root, "config/loader.json", JSON.stringify({ plugins: ["./lib/gate-helper.js"] }));
  write(root, "scripts/hook.js", "console.log(1);\n");
  write(root, "legacy/old.js", "x\n");
  write(root, "src/auth/session-old.js", "export const s = 1;\n");
  write(root, "src/todo.js", "// TODO: rewrite this parser\nexport const x = 1;\n");
  write(root, "README.md", "Run npm start.\n");
  return root;
}

const KNIP_JSON = {
  issues: [
    { file: "src/dead.js", files: [{ name: "src/dead.js" }], exports: [], types: [], dependencies: [], devDependencies: [], unlisted: [] },
    { file: "lib/gate-helper.js", files: [{ name: "lib/gate-helper.js" }] },
    { file: "scripts/hook.js", files: [{ name: "scripts/hook.js" }] },
    { file: "legacy/old.js", files: [{ name: "legacy/old.js" }] },
    { file: "src/auth/session-old.js", files: [{ name: "src/auth/session-old.js" }] },
    { file: "src/util.js", exports: [{ name: "internalOnly", line: 2 }, { name: "usedInTest", line: 3 }] },
    { file: "package.json", dependencies: [{ name: "left-pad", line: 9 }] },
    { file: "src/index.js", unlisted: [{ name: "chalk", line: 4 }] }
  ]
};

function demoRun(root, overrides = []) {
  const now = Date.UTC(2026, 9, 2) / 1000;
  return fakeRun([
    ...overrides,
    ["git ls-files", () => ({ code: 128, stderr: "not a git repository" })],
    [/^npx -y knip@/, () => ({ stdout: JSON.stringify(KNIP_JSON) })],
    [/^npx -y jscpd@/, (command) => {
      const out = outputDirOf(command);
      fs.mkdirSync(out, { recursive: true });
      fs.writeFileSync(path.join(out, "jscpd-report.json"), JSON.stringify({
        statistics: { total: { clones: 3 } },
        duplicates: [
          { format: "javascript", lines: 14, tokens: 120, fragment: "const SECRET_VALUE = 1;", firstFile: { name: "src\\a.js", startLoc: { line: 1 }, endLoc: { line: 14 } }, secondFile: { name: "src/b.js", start: 3, end: 16 } },
          { format: "javascript", lines: 4, tokens: 40, fragment: "x", firstFile: { name: "src/c.js", start: 1, end: 4 }, secondFile: { name: "src/d.js", start: 1, end: 4 } },
          { format: "javascript", lines: 20, tokens: 200, fragment: "y", firstFile: { name: "legacy/old.js", start: 1, end: 20 }, secondFile: { name: "src/e.js", start: 1, end: 20 } },
          { format: "markdown", lines: 16, tokens: 90, fragment: "z", firstFile: { name: "docs/a.md:markdown", start: 1, end: 16 }, secondFile: { name: "docs/b.md:markdown", start: 1, end: 16 } }
        ]
      }));
      return {};
    }],
    ["npm outdated --json", () => ({ code: 1, stdout: JSON.stringify({ lodash: { current: "4.17.20", wanted: "4.17.21", latest: "4.17.21" }, eslint: { current: "8.57.0", wanted: "8.57.0", latest: "9.10.0" } }) })],
    ["git log", () => ({ stdout: ["@@@fix: util crash", "3\t1\tsrc/util.js", "@@@fix: again", "1\t1\tsrc/util.js", "@@@feat", "2\t0\tsrc/util.js", "4\t0\tsrc/index.js", "@@@tests", "1\t1\ttest/util.test.js", "@@@tests 2", "1\t1\ttest/util.test.js"].join("\n") })],
    ["git blame", (command) => {
      assert.match(command, /-L 1,1 -- src\/todo\.js$/);
      return { stdout: [`${"c".repeat(40)} 1 1 1`, `author-time ${now - 400 * DAY}`, "\t// TODO: rewrite this parser"].join("\n") };
    }]
  ]);
}

const DEMO_BASELINE = {
  flaky: { rounds: 3, tests: [{ check: "unit", file: "test/util.test.js", name: "x", passed: 1, failed: 2, runs: 3 }], files: [], suites: [] },
  testFiles: [{ check: "unit", runner: "node", rounds: 3, files: [{ file: "test/slow.test.js", ms: 20000, samples: [20000] }, { file: "test/util.test.js", ms: 900, samples: [900] }] }]
};

const which = (name) => (name === "npx" || name === "npm" ? `/fake/${name}` : null);
const now = () => Date.UTC(2026, 9, 2);

test("runOptimizeScanners finds what is provably unused, duplicated, outdated, left over, slow or flaky, with tiers, and keeps the look-alikes", async () => {
  const root = demoProject();
  const sweepDir = path.join(root, ".autoclaude", "sweeps", "20261002-1200-optimize");
  const run = demoRun(root);
  const r = await so.runOptimizeScanners({ root, env: cleanEnv(), options: { exclude: ["legacy/**"] }, sweepDir, run, baseline: DEMO_BASELINE, which, now });
  const find = (cat, file) => r.candidates.filter((c) => c.category === cat && (file === undefined || c.file === file));

  // unused files: three proofs. gate-helper is named in a JSON config, hook.js sits in scripts/,
  // legacy/ is excluded; the auth file is report-only.
  assert.deepEqual(find("unused-file").map((c) => [c.file, c.tier, c.autoFixSafe]).sort(), [["src/auth/session-old.js", "C", false], ["src/dead.js", "A", true]]);
  const unused = JSON.parse(fs.readFileSync(path.join(sweepDir, "scanners", "unused.json"), "utf8"));
  assert.deepEqual(unused.files.dropped, [{ name: "lib/gate-helper.js", reason: "referenced in config/loader.json" }, { name: "scripts/hook.js", reason: "entry-point convention: CLI and scripts" }]);
  // unused exports: an export used only in its own file loses the keyword; one a test imports stays.
  assert.deepEqual(find("unused-export").map((c) => [c.file, c.line, c.tier]), [["src/util.js", 2, "B"]]);
  assert.match(find("unused-export")[0].fix, /Drop the `export` keyword from `internalOnly`/);
  assert.ok(unused.exports.dropped.some((d) => d.name === "src/util.js export usedInTest" && /test\/util\.test\.js/.test(d.reason)));
  // unused packages: lodash is imported, eslint is a script command, @types/node and typescript are conventions.
  assert.deepEqual(find("unused-dependency").map((c) => [c.file, c.evidence.split(" ")[0], c.tier, c.tool]), [["package.json", '"left-pad"', "A", `knip ${so.KNIP_VERSION} + reference search`]]);
  assert.ok(find("unused-dependency")[0].line > 0);
  assert.deepEqual(find("unlisted-dependency").map((c) => [c.file, c.line]), [["src/index.js", 4]]);
  // duplicates: the short one and the one touching an excluded folder are left out, fragments never saved.
  assert.deepEqual(find("duplicate").map((c) => [c.file, c.line, c.tier]), [["src/a.js", 1, "B"]]);
  const jscpd = fs.readFileSync(path.join(sweepDir, "scanners", "jscpd.json"), "utf8");
  assert.ok(!jscpd.includes("SECRET_VALUE") && !jscpd.includes("fragment"));
  assert.equal(fs.existsSync(path.join(sweepDir, "scanners", "jscpd-raw")), false);
  // upgrades
  assert.deepEqual(find("outdated").map((c) => [c.fixedVersion, c.tier]), [["4.17.21", "A"]]);
  assert.deepEqual(find("major-upgrade").map((c) => [c.fixedVersion, c.tier]), [["9.10.0", "C"]]);
  // leftovers
  assert.deepEqual(find("commented-out").map((c) => [c.file, c.line, c.tier]), [["src/util.js", 5, "A"]]);
  const todo = find("stale-todo");
  assert.deepEqual(todo.map((c) => [c.file, c.line, c.tier, c.autoFixSafe]), [["src/todo.js", 1, "A", false]]);
  assert.match(todo[0].evidence, /400 days old: "rewrite this parser"/);
  // tests, from the baseline
  assert.deepEqual(find("flaky-test").map((c) => c.file), ["test/util.test.js"]);
  assert.deepEqual(find("slow-test").map((c) => c.file), ["test/slow.test.js"]);
  // hotspots are leads, not findings; tests are not hotspots
  assert.deepEqual(r.leads.map((l) => [l.file, l.commits, l.fixCommits]), [["src/util.js", 3, 2]]);

  for (const c of r.candidates) {
    assert.equal(c.kind, "optimize");
    assert.ok(so.OPTIMIZE_CATEGORIES.includes(c.category), c.category);
    assert.ok(["A", "B", "C"].includes(c.tier));
    assert.ok(["critical", "high", "medium", "low"].includes(c.severity));
    assert.equal(c.cwe, null);
    assert.equal(c.cvss, null);
    for (const k of ["file", "evidence", "impact", "fix", "testIdea"]) assert.equal(typeof c[k], "string", k);
    assert.ok(c.evidence && c.fix && c.testIdea);
    assert.ok(Number.isInteger(c.line) && c.confidence >= 0 && c.confidence <= 10);
    assert.equal(c.autoFixSafe, c.tier === "A" && !(c.category === "stale-todo"));
    assert.ok(!("id" in c) && !("fingerprint" in c));
  }

  const commands = run.calls.map((c) => c.command);
  assert.ok(commands.some((c) => c.startsWith(`npx -y knip@${so.KNIP_VERSION} --reporter json --no-exit-code`)));
  assert.ok(commands.some((c) => c.startsWith(`npx -y jscpd@${so.JSCPD_VERSION} . --reporters json`)));
  for (const f of ["knip.json", "unused.json", "jscpd.json", "outdated.json", "leftovers.json", "churn.json", "optimize.json"]) assert.ok(fs.existsSync(path.join(sweepDir, "scanners", f)), f);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(sweepDir, "scanners", "optimize.json"), "utf8")).candidates.length, r.candidates.length);
  assert.ok(r.coverage.examined.some((s) => s.startsWith(`knip ${so.KNIP_VERSION}: flagged 5 files`)));
  assert.ok(!r.coverage.notExamined.some((s) => /knip|jscpd|outdated|churn/.test(s)), r.coverage.notExamined.join("\n"));
  assert.ok(fs.existsSync(path.join(root, "src", "dead.js")), "nothing in the project is changed");
});

// P10.14: the live proof's scanner findings OPT-011, 013, 016 and 017 reached the report untitled.
test("every optimize scanner candidate has a plain title naming the problem and the place", async () => {
  const root = demoProject();
  const r = await so.runOptimizeScanners({ root, env: cleanEnv(), options: { exclude: ["legacy/**"] }, sweepDir: path.join(root, ".autoclaude", "sweeps", "t"), run: demoRun(root), baseline: DEMO_BASELINE, which, now });
  const titles = Object.fromEntries(r.candidates.map((c) => [`${c.category} ${c.file}`, c.title]));
  assert.deepEqual(titles, {
    "unused-file src/dead.js": "src/dead.js is not used anywhere",
    "unused-file src/auth/session-old.js": "src/auth/session-old.js is not used anywhere",
    "unused-export src/util.js": "The export internalOnly in src/util.js is used only inside its own file",
    "unlisted-dependency src/index.js": "src/index.js imports chalk, which no package.json declares",
    "unused-dependency package.json": "left-pad is declared in package.json but never used",
    "outdated package.json": "lodash 4.17.20 can be updated to 4.17.21",
    "major-upgrade package.json": "eslint has a new major version (8.57.0 to 9.10.0)",
    "duplicate src/a.js": "14 lines repeated in src/a.js and src/b.js",
    "commented-out src/util.js": "A block of commented-out code in src/util.js",
    "stale-todo src/todo.js": `A TODO comment over ${so.STALE_TODO_DAYS} days old in src/todo.js`,
    "flaky-test test/util.test.js": "The test \"x\" in test/util.test.js passed some identical runs and failed others",
    "slow-test test/slow.test.js": "test/slow.test.js is one of the slowest test files: 20.0 s, 96% of the time of \"unit\""
  });
  // The proof's OPT-011: test/sec-015.test.js, 6.5 s of the 35.3 s the unit files take together.
  const proof = so.testCandidates({ flaky: { rounds: 3, tests: [], files: [{ check: "unit", file: "test/x.test.js", passed: 2, runs: 3 }], suites: [{ check: "e2e", command: "npx playwright test", passed: 1, runs: 3 }] },
    testFiles: [{ check: "unit", runner: "node", rounds: 3, files: [{ file: "test/sec-015.test.js", ms: 6532, samples: [6532, 6738, 6471] }, { file: "test/rest.test.js", ms: 28768, samples: [28768] }] }] });
  assert.deepEqual(proof.map((c) => c.title), [
    "test/x.test.js passed some identical runs and failed others",
    "The check \"e2e\" passed some identical runs and failed others",
    "test/rest.test.js is one of the slowest test files: 28.8 s, 81% of the time of \"unit\"",
    "test/sec-015.test.js is one of the slowest test files: 6.5 s, 19% of the time of \"unit\""
  ]);
  for (const c of [...r.candidates, ...proof]) assert.ok(typeof c.title === "string" && c.title.length > 10, JSON.stringify(c));
});

test("runOptimizeScanners reports missing or failing tools as not checked, never as clean", async () => {
  const root = demoProject();
  const sweepDir = path.join(root, "sw");
  const noNpx = demoRun(root);
  const r = await so.runOptimizeScanners({ root, env: cleanEnv(), options: {}, sweepDir, run: noNpx, which: () => null, now });
  assert.ok(r.coverage.notExamined.includes(`unused files, exports and dependencies (knip ${so.KNIP_VERSION}): not checked (npx is not on PATH)`));
  assert.ok(r.coverage.notExamined.includes(`duplicated code (jscpd ${so.JSCPD_VERSION}): not checked (npx is not on PATH)`));
  assert.ok(r.coverage.notExamined.includes("outdated packages (npm outdated): not checked (npm is not on PATH)"));
  assert.ok(!noNpx.calls.some((c) => c.command.startsWith("npx") || c.command.startsWith("npm")));
  // The reference search still finds the unused package on its own.
  assert.deepEqual(r.candidates.filter((c) => c.category === "unused-dependency").map((c) => c.tool), ["reference search"]);
  assert.equal(r.candidates.filter((c) => c.category === "unused-file").length, 0);
  assert.ok(r.coverage.notExamined.includes("slow and flaky tests: not checked (no baseline was recorded)"));

  const failing = demoRun(root, [
    [/^npx -y knip@/, () => ({ code: 2, stderr: "boom: cannot load vite.config.ts" })],
    [/^npx -y jscpd@/, () => ({ code: 0 })],
    ["npm outdated", () => ({ code: 1, timedOut: true })],
    ["git log", () => ({ code: 128, stderr: "fatal: not a git repository" })],
    ["git blame", () => ({ code: 128, stderr: "fatal" })]
  ]);
  const f = await so.runOptimizeScanners({ root, env: cleanEnv(), options: {}, sweepDir: path.join(root, "sw2"), run: failing, which, now });
  const ne = f.coverage.notExamined.join("\n");
  assert.match(ne, new RegExp(`knip ${so.KNIP_VERSION.replace(/\./g, "\\.")}\\): not checked \\(exit code 2: boom: cannot load vite\\.config\\.ts\\)`));
  assert.match(ne, /jscpd 5\.4\.0\): not checked \(it wrote no JSON report\)/);
  assert.match(ne, /outdated packages \(npm outdated\): not checked \(timed out/);
  assert.match(ne, /churn hotspots \(git log\): not checked \(exit code 128: fatal: not a git repository\)/);
  assert.match(ne, /stale TODO\/FIXME comments: not checked \(git blame did not work: exit code 128: fatal; 1 file has such comments\)/);
  assert.deepEqual(f.leads, []);
});

test("runOptimizeScanners keeps package names to itself when advisories are off, and runs only the modules asked for", async () => {
  const root = demoProject();
  const run = demoRun(root);
  const r = await so.runOptimizeScanners({ root, env: cleanEnv(), options: { advisories: false, modules: ["unused"] }, sweepDir: path.join(root, "sw"), run, baseline: DEMO_BASELINE, which, now });
  assert.ok(!run.calls.some((c) => c.command.startsWith("npm outdated")));
  assert.ok(r.coverage.notExamined.some((s) => /not checked \(sweep\.advisories is off/.test(s)));
  assert.ok(!run.calls.some((c) => /jscpd|^git log|^git blame/.test(c.command)));
  assert.deepEqual([...new Set(r.candidates.map((c) => c.category))].sort(), ["unlisted-dependency", "unused-dependency", "unused-export", "unused-file"]);

  const run2 = demoRun(root);
  const d = await so.runOptimizeScanners({ root, env: cleanEnv(), options: { modules: ["duplicates"] }, sweepDir: path.join(root, "sw2"), run: run2, baseline: DEMO_BASELINE, which, now });
  assert.ok(!run2.calls.some((c) => /knip|npm outdated|^git log/.test(c.command)));
  assert.deepEqual([...new Set(d.candidates.map((c) => c.category))].sort(), ["commented-out", "duplicate", "stale-todo"]);
  assert.deepEqual(d.leads, []);
});

test("runOptimizeScanners leaves outdated packages unchecked in a pnpm, yarn or bun project", async () => {
  const root = demoProject();
  fs.rmSync(path.join(root, "package-lock.json"));
  write(root, "pnpm-lock.yaml", "packages:\n");
  const run = demoRun(root);
  const r = await so.runOptimizeScanners({ root, env: cleanEnv(), options: { modules: ["unused"] }, sweepDir: path.join(root, "sw"), run, which, now });
  assert.ok(r.coverage.notExamined.includes("outdated packages (npm outdated): not checked (the project uses pnpm; only npm is supported)"));
  assert.ok(!run.calls.some((c) => c.command.startsWith("npm outdated")));
});

test("runOptimizeScanners hands on at most MAX_PER_CATEGORY candidates of a category and says how many it cut", async () => {
  const root = tmp();
  write(root, "package.json", JSON.stringify({ name: "x" }));
  for (let i = 0; i < so.MAX_PER_CATEGORY + 5; i++) write(root, `src/f${i}.js`, "// const a = b();\n// if (a) {\n//   go(a);\n// }\n");
  const run = fakeRun([["git ls-files", () => ({ code: 128 })], ["git", () => ({ code: 128 })]]);
  const r = await so.runOptimizeScanners({ root, env: cleanEnv(), options: { modules: ["duplicates"] }, sweepDir: path.join(root, ".autoclaude", "sw"), run, which: () => null, now });
  assert.equal(r.candidates.filter((c) => c.category === "commented-out").length, so.MAX_PER_CATEGORY);
  assert.ok(r.coverage.notExamined.includes(`commented-out: 5 more candidates beyond the first ${so.MAX_PER_CATEGORY} were not handed on`));
});

// ---------- the prompts ----------

const AREA_TEMPLATE = fs.readFileSync(path.join(pluginRoot(), "prompts", "sweep-optimize-area.md"), "utf8");
const BROWSER_TEMPLATE = fs.readFileSync(path.join(pluginRoot(), "prompts", "sweep-optimize-browser.md"), "utf8");

test("buildOptimizeAreaPrompt fills every placeholder and narrows the hits and hotspots to the area", () => {
  const candidates = [
    { category: "unused-file", tier: "A", file: "src/dead.js", line: 0, evidence: "knip flags it", tool: "knip" },
    { category: "duplicate", tier: "B", file: "lib/other.js", line: 3, evidence: "OUTSIDE", tool: "jscpd" }
  ];
  const leads = [{ file: "src/util.js", commits: 9, fixCommits: 4, linesChanged: 120, lines: 300 }, { file: "lib/far-away.js", commits: 2, fixCommits: 0, linesChanged: 5, lines: 10 }];
  const baseline = { checks: [{ name: "unit", ms: 12000, ok: true }], flaky: { rounds: 3, tests: [], files: [], suites: [] }, coverage: { notExamined: ["bundle size: not checked (no build script)"] } };
  const p = so.buildOptimizeAreaPrompt({ template: AREA_TEMPLATE, root: "C:\\proj", area: { name: "src", files: ["src/dead.js", "src/util.js"] }, candidates, leads, baseline, options: { modules: ["unused", "tests"], exclude: ["legacy/**"] }, constraints: "", planFile: "PLAN.md", turns: 33 });
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p), "every placeholder is filled");
  assert.match(p, /Your area: src/);
  assert.match(p, /- src\/dead\.js\n- src\/util\.js/);
  assert.match(p, /unused-file, tier A, src\/dead\.js: knip flags it \(found by knip\)/);
  assert.ok(!p.includes("OUTSIDE"));
  assert.match(p, /src\/util\.js: 9 commits \(4 fixes\)/);
  assert.ok(!p.includes("lib/far-away.js"));
  assert.match(p, /Checks: unit 12\.0 s \(passed\)/);
  assert.match(p, /Flaky tests: none in 3 identical runs/);
  assert.match(p, /Not measured: bundle size: not checked/);
  assert.match(p, /Performance \("performance"\): off, do not report it/);
  assert.match(p, /Unused code and packages \("unused"\): on/);
  assert.match(p, /- legacy\/\*\*/);
  assert.match(p, /The plan has no "Constraints & decisions" section/);
  assert.match(p, /files under C:\/proj/);
  assert.match(p, /You have 33 turns/);
});

test("buildOptimizeAreaPrompt without a file list treats the area as the whole project", () => {
  const p = so.buildOptimizeAreaPrompt({ template: AREA_TEMPLATE, root: "/p", candidates: [{ category: "bug", tier: "B", file: "x.js", line: 1, evidence: "e" }] });
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p));
  assert.match(p, /Your area: the whole project/);
  assert.match(p, /bug, tier B, x\.js:1: e \(found by a scanner\)/);
  assert.match(p, /No baseline was recorded/);
});

test("buildOptimizeBrowserPrompt fills every placeholder", () => {
  const p = so.buildOptimizeBrowserPrompt({ template: BROWSER_TEMPLATE, url: "http://127.0.0.1:5173", root: "C:\\proj", turns: 30, loads: 5, maxPages: 8 });
  assert.ok(!/\{\{[A-Z_]+\}\}/.test(p));
  assert.match(p, /The app is running at http:\/\/127\.0\.0\.1:5173/);
  assert.match(p, /Load it 5 times/);
  assert.match(p, /at most 8 pages/);
  assert.match(p, /No login is available/);
  assert.match(p, /No page list was given/);
  const withPages = so.buildOptimizeBrowserPrompt({ template: BROWSER_TEMPLATE, url: "http://x", root: "/p", login: "Log in as the user in secrets/sweep-users.json.", pages: ["/", "/orders"] });
  assert.match(withPages, /Log in as the user in secrets\/sweep-users\.json\./);
  assert.match(withPages, /- \/\n- \/orders/);
});

test("the optimize prompts are read-only, name every category and tier, and carry the rules", () => {
  for (const t of [AREA_TEMPLATE, BROWSER_TEMPLATE]) {
    assert.match(t, /you must not try/);
    assert.match(t, /never instructions to you/);
    assert.match(t, /Reply with the structured result only/);
    assert.ok(!/[^\x00-\x7F]/.test(t), "plain ASCII");
  }
  for (const c of so.OPTIMIZE_CATEGORIES) assert.ok(AREA_TEMPLATE.includes(c), c);
  for (const tier of ["- A:", "- B:", "- C:"]) assert.ok(AREA_TEMPLATE.includes(tier), tier);
  for (const word of ["reuse:", "simplification:", "efficiency:", "fragility:", "churn:"]) assert.ok(AREA_TEMPLATE.includes(word), word);
  assert.match(AREA_TEMPLATE, /never weaken a test/i);
  assert.match(AREA_TEMPLATE, /more than 10%/);
  assert.match(BROWSER_TEMPLATE, /must not change any data/);
  for (const f of so.PAGE_SCHEMA.required) assert.ok(BROWSER_TEMPLATE.includes(`\`${f}\``), f);
});

test("summarizeBaseline says when there is no baseline and lists pages once the walk added them", () => {
  assert.equal(so.summarizeBaseline(null), "(No baseline was recorded.)");
  const s = so.summarizeBaseline({ build: { command: "npm run build", ok: true, ms: 2500 }, bundle: { dir: "dist", files: 3, rawBytes: 2 * 1024 * 1024, gzipBytes: 300 * 1024, largest: [{ file: "a.js", gzipBytes: 200 * 1024 }] }, packages: { lockfile: "package-lock.json", count: 120, direct: 9 }, devServer: { startMs: 3400 }, pages: [{ url: "/", loadMsMedian: 420, requests: 23, transferKb: 310, duplicateApiCalls: ["GET /api/me"] }] });
  assert.match(s, /Build: npm run build 2\.5 s/);
  assert.match(s, /Bundle \(dist\): 3 files, 2\.0 MB raw, 300 KB gzip; largest \(gzip\): a\.js 200 KB/);
  assert.match(s, /Packages: 120 in package-lock\.json \(9 declared directly\)/);
  assert.match(s, /Dev server: ready in 3\.4 s/);
  assert.match(s, /Page \/: 420 ms median load, 23 requests, 310 KB, repeated calls: GET \/api\/me/);
});
