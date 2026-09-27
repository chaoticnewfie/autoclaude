import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildPrompt, evaluateVerdict, mcpConfigFor, testChanges, runBrowserCheck, verdictSection, VERDICT_SCHEMA, ALLOWED_TOOLS } from "../../plugins/autoclaude/lib/tester.js";
import { parsePlan, stepById } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-tester-"));
const PLAN = `# Shop plan

## Phase 1: Things
- [x] **S1.1** List things
  - Accept: /things lists 3 items
- [ ] **S1.2** Price things
  - Accept: each item shows a price like $5.00
  - Tags: ui
- [ ] **S1.3** Later
  - Accept: later
`;
const parsed = parsePlan(PLAN);
const config = mergeConfig({ devServer: { command: "npm run dev", url: "http://127.0.0.1:4173" } });
const good = { verdict: "pass", criteria: [{ text: "each item shows a price", result: "pass", evidence: "saw $5.00 on all three" }], bugs: [{ severity: "low", title: "price misaligned", repro: "open /things", expected: "aligned", actual: "2px off" }], consoleErrors: [], testConcerns: ["test for zero price was removed"], notes: "fine" };

test("the verdict schema requires every field and the tools are read-only", () => {
  assert.deepEqual(VERDICT_SCHEMA.required, ["verdict", "criteria", "bugs", "consoleErrors", "testConcerns", "notes"]);
  assert.deepEqual(ALLOWED_TOOLS, ["mcp__playwright", "Read", "Glob", "Grep"]);
});

test("buildPrompt fills the step, the verified neighbours, the phase and keeps $ literal", () => {
  const tpl = "URL={{URL}} STEP={{STEP_ID}}\n{{STEP_TEXT}}\nN:\n{{NEIGHBOURS}}\nF:\n{{FEATURES}}\nP={{PHASE}}\nT={{TEST_CHANGES}}\nS={{SCREENSHOT_DIR}}";
  const out = buildPrompt("tester", { template: tpl, url: "http://x", step: stepById(parsed, "S1.2"), parsed, testChanges: "", screenshotDir: "C:/r/s" });
  assert.match(out, /URL=http:\/\/x STEP=S1\.2/);
  assert.match(out, /Accept: each item shows a price like \$5\.00/);
  assert.match(out, /N:\n- \[x\] \*\*S1\.1\*\* List things/);
  assert.match(out, /F:\n- \[x\] \*\*S1\.1\*\*[\s\S]*\*\*S1\.2\*\*/);
  assert.doesNotMatch(out, /S1\.3/);
  assert.match(out, /P=Phase 1: Things/);
  assert.match(out, /T=\(no test files changed\)/);
  assert.match(out, /S=C:\/r\/s/);
  assert.equal(buildPrompt("tester", { template: "{{NEIGHBOURS}}", url: "u", step: stepById(parsed, "S1.1"), parsed, screenshotDir: "d" }), "(none yet)");
});

test("evaluateVerdict: pass, failing criterion, high bug, medium bug only, malformed, empty criteria", () => {
  assert.equal(evaluateVerdict("tester", good).passed, true);
  assert.equal(evaluateVerdict("tester", { ...good, criteria: [{ text: "a", result: "fail", evidence: "e" }] }).passed, false);
  const high = evaluateVerdict("tester", { ...good, bugs: [{ severity: "high", title: "crash" }] });
  assert.deepEqual([high.passed, high.high.length], [false, 1]);
  const med = evaluateVerdict("bugbash", { ...good, criteria: [], bugs: [{ severity: "medium", title: "m" }] });
  assert.deepEqual([med.valid, med.passed, med.other.length], [true, true, 1]);
  const bbFailWord = evaluateVerdict("bugbash", { ...good, verdict: "fail", bugs: [{ severity: "medium", title: "double click duplicates" }] });
  assert.equal(bbFailWord.passed, true, "the bug bash fails only on a failing criterion or a high bug, not on its verdict word");
  assert.equal(evaluateVerdict("bugbash", { ...good, criteria: [{ text: "S1.1 x: works under normal use", result: "fail", evidence: "e" }] }).passed, false);
  assert.equal(evaluateVerdict("tester", { verdict: "maybe" }).valid, false);
  assert.equal(evaluateVerdict("tester", { ...good, criteria: [] }).valid, false);
  assert.equal(evaluateVerdict("tester", { ...good, verdict: "fail" }).passed, false);
});

test("verdictSection lists criteria with evidence, bugs, concerns and screenshots", () => {
  const s = verdictSection("tester", good, evaluateVerdict("tester", good), { screenshots: [".autoclaude/reports/x/a.png"], numTurns: 7, durationMs: 42000, model: "sonnet" });
  assert.equal(s.title, "Browser tester: passed");
  assert.match(s.body, /- \[pass\] each item shows a price\n  Evidence: saw \$5\.00 on all three/);
  assert.match(s.body, /- low: price misaligned/);
  assert.match(s.body, /Test concerns:\n- test for zero price was removed/);
  assert.match(s.body, /Screenshots:\n- \.autoclaude\/reports\/x\/a\.png/);
  assert.match(s.body, /Run: model sonnet, 7 turns, 42 s/);
});

test("mcpConfigFor keeps the project's server, adds headless, isolated and the output dir", () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, ".autoclaude"));
  fs.writeFileSync(path.join(root, ".autoclaude", "mcp.playwright.json"), JSON.stringify({ mcpServers: { pw: { command: "cmd", args: ["/c", "npx", "-y", "@playwright/mcp@latest", "--headless", "--viewport-size", "1280x800"] } } }));
  const file = mcpConfigFor(root, "C:/r/shots");
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.deepEqual(Object.keys(cfg.mcpServers), ["playwright"]);
  assert.deepEqual(cfg.mcpServers.playwright.args, ["/c", "npx", "-y", "@playwright/mcp@latest", "--headless", "--viewport-size", "1280x800", "--isolated", "--output-dir", "C:/r/shots"]);
  const bare = tmp();
  const cfg2 = JSON.parse(fs.readFileSync(mcpConfigFor(bare, "d"), "utf8"));
  assert.ok(cfg2.mcpServers.playwright.args.includes("@playwright/mcp@latest"));
});

test("testChanges shows changed and new test files with the diff of tracked ones", async () => {
  const env = gitEnv(process.env);
  const root = tmp();
  prepareFixture({ dest: root, plan: "happy", git: true, env });
  const t = path.join(root, "test", "todos.test.js");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace(/  assert\.throws\(\(\) => s\.toggle\(9\), \/no todo\/\);\n/, ""));
  fs.writeFileSync(path.join(root, "test", "new.test.js"), "// new\n");
  const text = await testChanges(root, env);
  assert.match(text, /M test\/todos\.test\.js/);
  assert.match(text, /\?\? test\/new\.test\.js/);
  assert.match(text, /-  assert\.throws\(\(\) => s\.toggle\(9\)/);
  assert.equal(await testChanges(tmp(), env), "(could not read git status)");
});

function fakeRun(results) {
  const calls = [];
  const run = async (opts) => { calls.push(opts); const r = results[Math.min(calls.length - 1, results.length - 1)]; return typeof r === "function" ? r(opts) : r; };
  return { run, calls };
}
const ok = (v) => ({ ok: true, infra: false, structured: v, numTurns: 5, durationMs: 1000, costUsd: 0.02 });
const infra = (e) => ({ ok: false, infra: true, error: e, durationMs: 500 });

async function check(results, extra = {}) {
  const root = tmp();
  const { run, calls } = fakeRun(results);
  const r = await runBrowserCheck({ kind: "tester", root, config, step: stepById(parsed, "S1.2"), parsed, env: process.env, attempt: 1, run, ...extra });
  return { r, calls, root };
}

test("runBrowserCheck: a pass writes the verdict file, the section and the follow-ups", async () => {
  const { r, calls, root } = await check([ok(good)]);
  assert.equal(r.status, "passed");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].role, "tester");
  assert.match(calls[0].prompt, /\*\*S1\.2\*\* Price things/);
  assert.ok(calls[0].args.includes("--mcp-config"));
  assert.equal(calls[0].cwd, path.join(root, ".autoclaude", "reports", "S1.2-1-tester"), "the checker works inside its report folder");
  assert.equal(calls[0].args[calls[0].args.indexOf("--add-dir") + 1], root, "the project stays readable");
  assert.equal(r.sections[0].title, "Browser tester: passed");
  assert.deepEqual(r.followUps.map((f) => [f.severity, f.title, f.foundBy]), [["low", "price misaligned", "tester"], ["low", "possible weakened or skipped test", "tester"]]);
  const saved = JSON.parse(fs.readFileSync(path.join(root, r.verdictFile), "utf8"));
  assert.deepEqual([saved.ok, saved.tries, saved.verdict.verdict], [true, 1, "pass"]);
});

test("runBrowserCheck: a failing verdict is a failure that names the criterion", async () => {
  const { r } = await check([ok({ ...good, verdict: "fail", criteria: [{ text: "each item shows a price", result: "fail", evidence: "no prices at all" }] })]);
  assert.equal(r.status, "failed");
  assert.match(r.failed, /browser tester: criterion failed: each item shows a price/);
  assert.equal(r.sections[0].title, "Browser tester: FAILED");
  assert.match(r.sections[0].body, /\[FAIL\] each item shows a price\n  Evidence: no prices at all/);
});

test("runBrowserCheck: one infra failure is retried; two are reported as infra", async () => {
  let { r, calls } = await check([infra("timed out after 900 s"), ok(good)]);
  assert.deepEqual([r.status, calls.length], ["passed", 2]);
  ({ r, calls } = await check([infra("timed out"), infra("unreadable output")]));
  assert.deepEqual([r.status, calls.length], ["infra", 2]);
  assert.match(r.failed, /could not run \(2 tries\): timed out; unreadable output/);
  ({ r, calls } = await check([ok({ ...good, criteria: [] })]));
  assert.equal(r.status, "infra", "an answer with no criteria is not a verdict");
  assert.match(r.failed, /no criteria/);
});

test("runBrowserCheck moves files the checker created in the project into its report folder", async () => {
  const env = gitEnv(process.env);
  const root = tmp();
  prepareFixture({ dest: root, plan: "happy", git: true, env });
  fs.writeFileSync(path.join(root, "builder-notes.txt"), "the builder's own untracked file\n");
  const run = async () => {
    fs.writeFileSync(path.join(root, "S1.2-final.png"), "png");
    fs.mkdirSync(path.join(root, "shots"), { recursive: true });
    fs.writeFileSync(path.join(root, "shots", "bug.png"), "png");
    return ok(good);
  };
  const r = await runBrowserCheck({ kind: "tester", root, config, step: stepById(parsed, "S1.2"), parsed, env, attempt: 1, run });
  assert.equal(r.status, "passed");
  assert.equal(fs.existsSync(path.join(root, "S1.2-final.png")), false);
  assert.equal(fs.existsSync(path.join(root, "shots", "bug.png")), false);
  assert.ok(fs.existsSync(path.join(root, "builder-notes.txt")), "files that existed before the check stay");
  const stray = path.join(root, ".autoclaude", "reports", "S1.2-1-tester", "stray");
  assert.ok(fs.existsSync(path.join(stray, "S1.2-final.png")));
  assert.ok(fs.existsSync(path.join(stray, "shots", "bug.png")));
  assert.deepEqual(r.screenshots.sort(), [".autoclaude/reports/S1.2-1-tester/stray/S1.2-final.png", ".autoclaude/reports/S1.2-1-tester/stray/shots/bug.png"]);
});

test("runBrowserCheck: no retry when the gate deadline is too close", async () => {
  let t = 0;
  const { r, calls } = await check([infra("timed out")], { deadlineMs: 1000, now: () => (t += 10) });
  assert.deepEqual([r.status, calls.length], ["infra", 1]);
  assert.match(r.failed, /no time left for a retry/);
});
