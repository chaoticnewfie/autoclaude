import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPrompt, evaluateVerdict, mcpConfigFor, testChanges, runBrowserCheck, verdictSection, turnScale, acceptCount, VERDICT_SCHEMA, ALLOWED_TOOLS } from "../../plugins/autoclaude/lib/tester.js";
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
  assert.deepEqual(VERDICT_SCHEMA.required, ["verdict", "criteria", "bugs", "consoleErrors", "testConcerns", "notes", "browserUnavailable"]);
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

test("runBrowserCheck: a checker with no working browser could not run: retried, then infra, never a failed attempt; MCP servers get time to start", async () => {
  // The practice run (2026-09-29): Playwright MCP timed out on connect, and the tester failed
  // every Accept line with "not checked", which counted against the feature.
  const noBrowser = { ...good, verdict: "fail", criteria: [{ text: "each item shows a price", result: "fail", evidence: "Not checked: Playwright MCP failed to connect (CONNECT_TIMEOUT)" }], browserUnavailable: true, notes: "Playwright MCP failed to connect (CONNECT_TIMEOUT)" };
  let { r, calls } = await check([ok(noBrowser), ok(good)]);
  assert.deepEqual([r.status, calls.length], ["passed", 2]);
  ({ r, calls } = await check([ok(noBrowser), ok(noBrowser)]));
  assert.deepEqual([r.status, calls.length], ["infra", 2]);
  assert.match(r.failed, /could not run \(2 tries\): it had no working browser: Playwright MCP failed to connect/);
  assert.equal(calls[0].env.MCP_TIMEOUT, "120000");
  assert.equal(calls[0].env.MCP_CONNECT_TIMEOUT_MS, "120000");
  ({ calls } = await check([ok(good)], { env: { ...process.env, MCP_TIMEOUT: "300000" } }));
  assert.equal(calls[0].env.MCP_TIMEOUT, "300000", "the owner's own setting wins");
  // browserUnavailable false (or absent, from an older checker) is an ordinary verdict.
  ({ r } = await check([ok({ ...good, browserUnavailable: false })]));
  assert.equal(r.status, "passed");
});

test("runBrowserCheck: a checker that runs out of turns is asked for its answer, and the prompt states the budget", async () => {
  const limit = { ok: false, infra: true, subtype: "error_max_turns", sessionId: "s-9", error: "claude ended with error_max_turns: ", numTurns: 40, durationMs: 4000 };
  const { r, calls, root } = await check([limit, ok(good)]);
  assert.deepEqual([r.status, calls.length], ["passed", 2]);
  assert.match(calls[0].prompt, /You have 40 turns/);
  assert.deepEqual(calls[1].args.slice(-2), ["--resume", "s-9"]);
  assert.match(r.sections[0].body, /answer given after reaching the turn limit/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, r.verdictFile), "utf8"));
  assert.deepEqual([saved.wrappedUp, saved.tries, saved.numTurns], [true, 1, 45]);
  const bash = await runBrowserCheck({ kind: "bugbash", root: tmp(), config, step: stepById(parsed, "S1.2"), parsed, env: process.env, attempt: 1, run: fakeRun([ok(good)]).run });
  assert.equal(bash.status, "passed");
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

test("runBrowserCheck: stopped by the gate's deadline is out of time, not infra; its own timeout is still infra; a quick crash gets its retry inside a short share", async () => {
  const timedOut = { ok: false, infra: true, error: "timed out after 300 s", timedOut: true, durationMs: 300000 };
  const T = 1_000_000;
  // The gate gave it 5 minutes of its 15.
  let { r, calls } = await check([timedOut], { deadlineMs: T + 300000, now: () => T });
  assert.deepEqual([r.status, calls.length, calls[0].timeoutMs], ["out-of-time", 1, 300000]);
  assert.match(r.failed, /^Browser tester ran out of the gate's time \(1 try\): stopped at the gate's deadline after 300 s \(its own limit is 900 s\)/);
  assert.equal(r.sections[0].title, "Browser tester: out of time");
  // Its own timeout ended it, with the gate's time to spare: the checker itself could not finish.
  ({ r } = await check([{ ...timedOut, error: "timed out after 900 s" }], { deadlineMs: T + 2000000, now: () => T }));
  assert.equal(r.status, "infra");
  // A crash after a few seconds is retried within the share, as long as half of it is left.
  ({ r, calls } = await check([infra("claude ended with error_during_execution"), ok(good)], { deadlineMs: T + 400000, now: () => T + 5000 }));
  assert.deepEqual([r.status, calls.length], ["passed", 2]);
});

// ---------- verification once per feature (D49) ----------

const PHASE_PLAN = `# Shop plan

## Phase 1: Things
- [~] **S1.1** List things
  - Accept: /things lists 3 items
  - Accept: each item shows its name
- [~] **S1.2** Count things
  - Accept: GET /api/count returns 3
  - Test: test/count.test.js
  - Tags: no-ui
- [ ] **S1.3** Price things
${Array.from({ length: 10 }, (_, i) => `  - Accept: price rule ${i + 1} costs $${i}.00`).join("\n")}
  - Note: log in as demo / demo

## Phase 2: Later
- [ ] **S2.1** Only
  - Accept: only
`;
const phased = parsePlan(PHASE_PLAN);
const phaseSteps = phased.phases[0].steps;
const realTemplate = (name) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "autoclaude", "prompts", name), "utf8");

test("turnScale: tester.maxTurns per 5 Accept lines, at least 1x, at most 4x; acceptCount sums the steps", () => {
  assert.deepEqual([0, 1, 5, 6, 10, 11, 20, 21, 90].map(turnScale), [1, 1, 1, 2, 2, 3, 4, 4, 4]);
  assert.equal(acceptCount(phaseSteps), 13);
});

test("buildPrompt, phase mode: every step with its Accept lines, the count, no smoke check, nothing left unfilled", () => {
  const out = buildPrompt("tester", { template: realTemplate("tester.md"), url: "http://x", step: phaseSteps[2], steps: phaseSteps, parsed: phased, testChanges: "", screenshotDir: "d", turns: 120 });
  assert.match(out, /## The feature under test: Phase 1: Things \(steps S1\.1, S1\.2, S1\.3\)/);
  for (const s of phaseSteps) assert.ok(out.includes(`**${s.id}** ${s.title}`), s.id);
  assert.match(out, /price rule 10 costs \$9\.00/, "$ stays literal");
  assert.match(out, /check EVERY `Accept:` line above \(13 in all\): one criterion per Accept line, in the order they appear/);
  assert.match(out, /for example "S1\.1: <the Accept text>"/);
  assert.match(out, /nothing else to smoke-check/);
  assert.doesNotMatch(out, /Features already verified in this phase|Smoke-check the features/);
  assert.match(out, /## Test changes in this feature/);
  assert.match(out, /You have 120 turns/);
  assert.doesNotMatch(out, /\{\{[A-Z_]+\}\}/);

  const one = buildPrompt("tester", { template: realTemplate("tester.md"), url: "http://x", step: stepById(parsed, "S1.2"), parsed, screenshotDir: "d" });
  assert.match(one, /## The step under test: S1\.2/);
  assert.match(one, /## Features already verified in this phase\n\n- \[x\] \*\*S1\.1\*\* List things/);
  assert.match(one, /Smoke-check the features that were already verified/);
  assert.match(one, /\(1 in all\)/);
  assert.doesNotMatch(one, /\{\{[A-Z_]+\}\}/);
});

test("buildPrompt, bug bash: the phase's steps in phase mode, and built [~] steps count as features without it", () => {
  const withSteps = buildPrompt("bugbash", { template: "{{FEATURES}}|{{PHASE}}", url: "u", step: phaseSteps[2], steps: phaseSteps, parsed: phased, screenshotDir: "d" });
  assert.ok(["S1.1", "S1.2", "S1.3"].every((id) => withSteps.includes(`**${id}**`)));
  assert.match(withSteps, /\|Phase 1: Things$/);
  const without = buildPrompt("bugbash", { template: "{{FEATURES}}", url: "u", step: phaseSteps[2], parsed: phased, screenshotDir: "d" });
  assert.ok(["S1.1", "S1.2", "S1.3"].every((id) => without.includes(`**${id}**`)), "built steps are part of the feature");
  assert.doesNotMatch(without, /S2\.1/);
  assert.doesNotMatch(buildPrompt("bugbash", { template: realTemplate("bugbash.md"), url: "u", steps: phaseSteps, parsed: phased, screenshotDir: "d" }), /\{\{[A-Z_]+\}\}/);
});

test("runBrowserCheck, phase mode: no-ui steps left out, turns and timeout scale with the Accept lines, coverage noted", async () => {
  const root = tmp();
  const { run, calls } = fakeRun([ok({ ...good, criteria: [{ text: "S1.1: /things lists 3 items", result: "pass", evidence: "3 rows" }] })]);
  const r = await runBrowserCheck({ kind: "tester", root, config, step: phaseSteps[2], steps: phaseSteps, parsed: phased, state: { phaseBaseCommit: null }, env: process.env, attempt: 2, run });
  assert.equal(r.status, "passed");
  const c = calls[0];
  assert.doesNotMatch(c.prompt, /\*\*S1\.2\*\*/, "the no-ui step is verified by its tests, not the browser");
  assert.match(c.prompt, /\(12 in all\)/);
  assert.equal(c.args[c.args.indexOf("--max-turns") + 1], "120", "12 lines: 3 x 40 turns");
  assert.equal(c.timeoutMs, 3 * 900 * 1000);
  assert.equal(c.cwd, path.join(root, ".autoclaude", "reports", "S1.3-2-tester"));
  assert.match(r.sections[0].body, /Coverage: 1 criteria reported for 12 Accept lines/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, r.verdictFile), "utf8"));
  assert.deepEqual([saved.step, saved.steps, saved.acceptLines, saved.maxTurns], ["S1.3", ["S1.1", "S1.3"], 12, 120]);

  // The deadline still caps the scaled timeout; the bug bash keeps its own budget.
  const bb = fakeRun([ok(good)]);
  await runBrowserCheck({ kind: "bugbash", root: tmp(), config, steps: phaseSteps, parsed: phased, env: process.env, run: bb.run, deadlineMs: Date.now() + 100000 });
  assert.equal(bb.calls[0].args[bb.calls[0].args.indexOf("--max-turns") + 1], "60");
  assert.ok(bb.calls[0].timeoutMs <= 100000);
  assert.match(bb.calls[0].prompt, /\*\*S1\.2\*\*/, "the bug bash reads every step of the phase");

  const cap = parsePlan(`# P\n\n## Phase 1: A\n- [ ] **S1.1** Big\n${Array.from({ length: 30 }, (_, i) => `  - Accept: line ${i}`).join("\n")}\n`);
  const capped = fakeRun([ok(good)]);
  await runBrowserCheck({ kind: "tester", root: tmp(), config, steps: cap.steps, parsed: cap, state: {}, run: capped.run });
  assert.equal(capped.calls[0].args[capped.calls[0].args.indexOf("--max-turns") + 1], "160", "capped at 4x");
});

test("runBrowserCheck, phase mode: a feature of no-ui steps only is skipped without a browser", async () => {
  const noUi = parsePlan("# P\n\n## Phase 1: A\n- [~] **S1.1** Logic\n  - Accept: a\n  - Test: t.js\n  - Tags: no-ui\n");
  const { run, calls } = fakeRun([ok(good)]);
  const r = await runBrowserCheck({ kind: "tester", root: tmp(), config, steps: noUi.steps, parsed: noUi, state: {}, run });
  assert.deepEqual([r.status, calls.length, r.sections[0].title], ["passed", 0, "Browser tester: skipped"]);
});

test("testChanges from the feature's first commit shows committed and uncommitted test changes; runBrowserCheck reads the base from the run state", async () => {
  const env = gitEnv(process.env);
  const root = tmp();
  prepareFixture({ dest: root, plan: "happy", git: true, env });
  const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", env }).stdout.trim();
  const base = git(["rev-parse", "HEAD"]);
  const t = path.join(root, "test", "todos.test.js");
  fs.writeFileSync(t, fs.readFileSync(t, "utf8").replace(/  assert\.throws\(\(\) => s\.toggle\(9\), \/no todo\/\);\n/, ""));
  git(["commit", "-q", "-am", "autoclaude(S1.1): built"]);
  fs.writeFileSync(path.join(root, "test", "new.test.js"), "// new\n");

  const since = await testChanges(root, env, 6000, base);
  assert.match(since, /M +test\/todos\.test\.js/);
  assert.match(since, /\?\? test\/new\.test\.js/);
  assert.match(since, /-  assert\.throws\(\(\) => s\.toggle\(9\)/, "the committed weakening is visible");
  assert.match(since, new RegExp(`against the commit this feature started from \\(${base.slice(0, 7)}\\)`));
  const last = await testChanges(root, env);
  assert.doesNotMatch(last, /todos\.test\.js/, "without a base only the uncommitted changes show");
  assert.match(await testChanges(root, env, 6000, "no-such-commit"), /against the last verified commit/, "an unknown base falls back");

  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), JSON.stringify({ status: "running", phaseBaseCommit: base }));
  const { run, calls } = fakeRun([ok(good)]);
  await runBrowserCheck({ kind: "tester", root, config, steps: phaseSteps, parsed: phased, env, run });
  assert.match(calls[0].prompt, /-  assert\.throws\(\(\) => s\.toggle\(9\)/);
});
