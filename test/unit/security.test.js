import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { SECURITY_SCHEMA, SECURITY_TOOLS, securityWanted, securityBase, reviewDiff, evaluateSecurity, securitySection, runSecurityReview } from "../../plugins/autoclaude/lib/security.js";
import { parsePlan, stepById } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";

const env = gitEnv(process.env);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-security-"));
const PLAN = `# Shop plan

## Phase 1: Things
- [x] **S1.1** List things
  - Accept: /things lists 3 items
- [ ] **S1.2** Search things
  - Accept: /search?q=x finds things costing $5.00
  - Tags: ui, security
- [ ] **S1.3** Later
  - Accept: later

## Phase 2: More
- [ ] **S2.1** Only
  - Accept: only
`;
const parsed = parsePlan(PLAN);
const config = mergeConfig({});
const S = (id) => stepById(parsed, id);
const withWhen = (when, extra = {}) => mergeConfig({ security: { when, ...extra } });

function gitRun(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

function fixture() {
  const root = tmp();
  prepareFixture({ dest: root, plan: "happy", git: true, env });
  return root;
}

const low = { severity: "low", file: "lib/a.js", line: 3, issue: "no rate limit on search", fix: "add a limit" };
const medium = { severity: "medium", file: "lib/b.js", line: 0, issue: "error message leaks the query", fix: "log it, return a generic message" };
const high = { severity: "high", file: "src/db.js", line: 12, issue: "SQL built by string concatenation", fix: "use a parameterised query" };
const verdictOf = (findings, word = "pass") => ({ verdict: word, findings, notes: "checked the search route" });

test("the schema requires every field and the tools are read-only", () => {
  assert.deepEqual(SECURITY_SCHEMA.required, ["verdict", "findings", "notes"]);
  assert.deepEqual(SECURITY_SCHEMA.properties.findings.items.required, ["severity", "file", "line", "issue", "fix"]);
  assert.equal(SECURITY_SCHEMA.properties.findings.items.properties.line.type, "integer");
  assert.deepEqual(SECURITY_TOOLS, ["Read", "Glob", "Grep"]);
});

test("securityWanted: phase end, security tag, every step, never, empty list", () => {
  assert.equal(securityWanted(config, S("S1.3"), parsed), true, "last step of the phase");
  assert.equal(securityWanted(config, S("S1.2"), parsed), true, "tagged security");
  assert.equal(securityWanted(config, S("S1.1"), parsed), false, "mid-phase, untagged");
  assert.equal(securityWanted(config, S("S2.1"), parsed), true, "a one-step phase is a phase end");
  assert.equal(securityWanted(withWhen(["every-step"]), S("S1.1"), parsed), true);
  assert.equal(securityWanted(withWhen(["phase-end"]), S("S1.2"), parsed), false, "the tag alone does not count without tag:security");
  assert.equal(securityWanted(withWhen(["tag:security"]), S("S1.3"), parsed), false, "the phase end alone does not count without phase-end");
  assert.equal(securityWanted(withWhen(["never"]), S("S1.3"), parsed), false);
  assert.equal(securityWanted(withWhen(["never", "every-step"]), S("S1.3"), parsed), false, "never wins");
  assert.equal(securityWanted(withWhen([]), S("S1.3"), parsed), false);
});

test("securityBase: nothing, then the run start commit, then the newest reachable ac-phase tag", async () => {
  const root = fixture();
  assert.equal(await securityBase(root, null, env), null);
  assert.equal(await securityBase(root, { baseCommit: null }, env), null);
  assert.equal(await securityBase(root, { baseCommit: "abc1234" }, env), "abc1234");
  gitRun(root, ["tag", "other-tag"]);
  assert.equal(await securityBase(root, { baseCommit: "abc1234" }, env), "abc1234", "only ac-phase-* tags count");
  gitRun(root, ["tag", "ac-phase-1"]);
  assert.equal(await securityBase(root, { baseCommit: "abc1234" }, env), "ac-phase-1");
  fs.writeFileSync(path.join(root, "extra.txt"), "x\n");
  gitRun(root, ["add", "-A"]);
  gitRun(root, ["commit", "-q", "-m", "step"]);
  assert.equal(await securityBase(root, null, env), "ac-phase-1", "an older tag is still reachable from HEAD");
  gitRun(root, ["tag", "ac-phase-2"]);
  assert.equal(await securityBase(root, null, env), "ac-phase-2");
  assert.equal(await securityBase(tmp(), { baseCommit: "def5678" }, env), "def5678", "not a repository");
});

test("reviewDiff: committed and uncommitted changes against the base, untracked files listed", async () => {
  const root = fixture();
  const first = gitRun(root, ["rev-parse", "HEAD"]);
  const todos = path.join(root, "lib", "todos.js");
  fs.appendFileSync(todos, "// committed change\n");
  gitRun(root, ["commit", "-q", "-am", "step one"]);
  fs.appendFileSync(path.join(root, "server.js"), "// uncommitted change\n");
  fs.writeFileSync(path.join(root, "lib", "search.js"), "export const x = 1;\n");

  const text = await reviewDiff(root, first, env);
  assert.match(text, new RegExp(`Diff base: ${first}`));
  assert.match(text, /lib\/todos\.js +\| /, "the stat names the committed change");
  assert.match(text, /server\.js +\| /, "the stat names the uncommitted change");
  assert.match(text, /\+\/\/ committed change/);
  assert.match(text, /\+\/\/ uncommitted change/);
  assert.match(text, /New untracked files[^\n]*\nlib\/search\.js/);
  assert.doesNotMatch(text, /diff truncated/);

  const noBase = await reviewDiff(root, null, env);
  assert.match(noBase, /git diff HEAD/);
  assert.match(noBase, /\+\/\/ uncommitted change/);
  assert.doesNotMatch(noBase, /\+\/\/ committed change/, "without a base only the uncommitted changes show");
});

test("reviewDiff: an oversized diff is truncated with a marker; the stat and the file list stay", async () => {
  const root = fixture();
  const big = Array.from({ length: 400 }, (_, i) => `// filler line ${i} ${"x".repeat(40)}`).join("\n") + "\n";
  fs.appendFileSync(path.join(root, "lib", "todos.js"), big);
  fs.writeFileSync(path.join(root, "lib", "search.js"), "export const x = 1;\n");
  const whole = await reviewDiff(root, null, env);
  assert.ok(whole.length > 20000);
  const text = await reviewDiff(root, null, env, 2000);
  assert.ok(text.length <= 2000, `length ${text.length}`);
  assert.match(text, /lib\/todos\.js \| 400 \+/);
  assert.match(text, /lib\/search\.js/);
  assert.match(text, /\[\.\.\. diff truncated: \d+ of \d+ characters shown\. Read the changed files/);
  assert.doesNotMatch(text, /filler line 399/);
});

test("evaluateSecurity: each blockOn value, the verdict word is informational, malformed input", () => {
  const v = verdictOf([high, medium, low], "fail");
  const counts = (e) => [e.valid, e.passed, e.blocking.length, e.other.length];
  assert.deepEqual(counts(evaluateSecurity(v, "high")), [true, false, 1, 2]);
  assert.deepEqual(counts(evaluateSecurity(v, "medium")), [true, false, 2, 1]);
  assert.deepEqual(counts(evaluateSecurity(v, "low")), [true, false, 3, 0]);
  assert.deepEqual(counts(evaluateSecurity(v, "none")), [true, true, 0, 3]);
  assert.deepEqual(evaluateSecurity(v, "high").blocking, [high]);
  assert.deepEqual(counts(evaluateSecurity(verdictOf([medium, low], "fail"), "high")), [true, true, 0, 2], "a fail word with no blocking finding passes");
  assert.deepEqual(counts(evaluateSecurity(verdictOf([]), "low")), [true, true, 0, 0]);
  for (const bad of [null, undefined, "pass", {}, { verdict: "maybe", findings: [] }, { verdict: "pass" }, { verdict: "pass", findings: "none" }, verdictOf([{ ...high, severity: "critical" }]), verdictOf([null])]) {
    const e = evaluateSecurity(bad, "high");
    assert.equal(e.valid, false, JSON.stringify(bad));
    assert.ok(e.reason);
  }
});

test("securitySection lists every finding with its fix, then notes and the run line", () => {
  const v = verdictOf([high, medium]);
  const s = securitySection(v, evaluateSecurity(v, "high"), { model: "opus", numTurns: 9, durationMs: 61000, tries: 2, blockOn: "high", base: "ac-phase-1", verdictFile: ".autoclaude/reports/S1.2-1-security.json" });
  assert.equal(s.title, "Security review: FAILED");
  assert.match(s.body, /^Findings:\n- high: src\/db\.js:12 SQL built by string concatenation\n  Fix: use a parameterised query\n- medium: lib\/b\.js error message leaks the query\n  Fix: log it, return a generic message/);
  assert.match(s.body, /Notes: checked the search route/);
  assert.match(s.body, /Run: model opus, 9 turns, 61 s, 2 tries, blocks on high, base ac-phase-1, verdict \.autoclaude\/reports\/S1\.2-1-security\.json$/);
  const clean = verdictOf([]);
  const c = securitySection(clean, evaluateSecurity(clean, "high"));
  assert.equal(c.title, "Security review: passed");
  assert.match(c.body, /^No findings\./);
});

function fakeRun(results) {
  const calls = [];
  const run = async (opts) => { calls.push(opts); const r = results[Math.min(calls.length - 1, results.length - 1)]; return typeof r === "function" ? r(opts) : r; };
  return { run, calls };
}
const ok = (v) => ({ ok: true, infra: false, structured: v, numTurns: 6, durationMs: 1000, costUsd: 0.05 });
const infra = (e) => ({ ok: false, infra: true, error: e, durationMs: 500 });

async function review(results, extra = {}) {
  const root = extra.root || tmp();
  const { run, calls } = fakeRun(results);
  const r = await runSecurityReview({ root, config, step: S("S1.2"), parsed, state: null, env, attempt: 1, run, ...extra });
  return { r, calls, root };
}

test("runSecurityReview: a pass with a low finding passes and hands the finding back; the run is read-only with no MCP", async () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, "server.js"), "// search route\n");
  fs.writeFileSync(path.join(root, "lib", "search.js"), "export const x = 1;\n");
  const { r, calls } = await review([ok(verdictOf([low]))], { root });
  assert.equal(r.status, "passed");
  assert.equal(r.failed, null);
  assert.deepEqual(r.findings, [low]);
  assert.deepEqual(r.strays, []);
  assert.equal(calls.length, 1);
  const c = calls[0];
  assert.equal(c.role, "security");
  assert.equal(c.cwd, path.join(root, ".autoclaude", "reports", "S1.2-1-security"), "the reviewer works inside its report folder");
  assert.ok(fs.existsSync(c.cwd));
  assert.equal(c.args[c.args.indexOf("--add-dir") + 1], root, "the project stays readable");
  assert.equal(c.args[c.args.indexOf("--model") + 1], "opus");
  assert.equal(c.args[c.args.indexOf("--max-turns") + 1], "40");
  assert.equal(c.args[c.args.indexOf("--allowedTools") + 1], "Read,Glob,Grep");
  assert.ok(c.args.includes("--strict-mcp-config"));
  assert.ok(!c.args.includes("--mcp-config"), "no MCP server loads");
  assert.deepEqual(JSON.parse(c.args[c.args.indexOf("--json-schema") + 1]), SECURITY_SCHEMA);
  assert.equal(c.timeoutMs, 900000);
  assert.match(c.prompt, /\*\*S1\.2\*\* Search things/);
  assert.match(c.prompt, /costing \$5\.00/);
  assert.match(c.prompt, /\+\/\/ search route/);
  assert.match(c.prompt, /lib\/search\.js/);
  assert.ok(c.prompt.includes(root.replace(/\\/g, "/")), "the prompt names the project root");
  assert.doesNotMatch(c.prompt, /\{\{[A-Z_]+\}\}/, "every placeholder is filled");
  assert.equal(r.sections[0].title, "Security review: passed");
  assert.match(r.sections[0].body, /- low: lib\/a\.js:3 no rate limit on search/);
  assert.equal(r.verdictFile, ".autoclaude/reports/S1.2-1-security.json");
  const saved = JSON.parse(fs.readFileSync(path.join(root, r.verdictFile), "utf8"));
  assert.deepEqual([saved.kind, saved.ok, saved.tries, saved.blockOn, saved.model, saved.verdict.verdict], ["security", true, 1, "high", "opus", "pass"]);
});

test("runSecurityReview: a high finding fails the step and names file:line; the rest are handed back", async () => {
  const { r } = await review([ok(verdictOf([high, low], "fail"))]);
  assert.equal(r.status, "failed");
  assert.equal(r.failed, "security review: high: src/db.js:12 SQL built by string concatenation");
  assert.deepEqual(r.findings, [low]);
  assert.equal(r.sections[0].title, "Security review: FAILED");
  const many = [1, 2, 3, 4].map((n) => ({ ...high, line: n }));
  const { r: r2 } = await review([ok(verdictOf(many, "fail"))]);
  assert.match(r2.failed, /src\/db\.js:3 SQL built by string concatenation \(\+1 more\)$/);
});

test("runSecurityReview: blockOn from config, and absolute paths become project-relative", async () => {
  const root = tmp();
  const abs = { ...medium, file: path.join(root, "lib", "b.js") };
  const { r } = await review([ok(verdictOf([abs]))], { root, config: mergeConfig({ security: { blockOn: "medium" } }) });
  assert.equal(r.status, "failed");
  assert.equal(r.failed, "security review: medium: lib/b.js error message leaks the query");
});

test("runSecurityReview: one infra failure is retried; two are infra; a malformed answer is infra", async () => {
  let { r, calls } = await review([infra("timed out after 900 s"), ok(verdictOf([low]))]);
  assert.deepEqual([r.status, calls.length], ["passed", 2]);
  assert.match(r.sections[0].body, /2 tries/);
  ({ r, calls } = await review([infra("timed out"), infra("unreadable output")]));
  assert.deepEqual([r.status, calls.length, r.findings], ["infra", 2, []]);
  assert.match(r.failed, /^Security review could not run \(2 tries\): timed out; unreadable output$/);
  assert.equal(r.sections[0].title, "Security review: could not run");
  ({ r, calls } = await review([ok({ verdict: "pass" })]));
  assert.deepEqual([r.status, calls.length], ["infra", 2]);
  assert.match(r.failed, /malformed/);
});

test("runSecurityReview: no retry when the gate deadline is too close", async () => {
  let t = 0;
  const { r, calls } = await review([infra("timed out")], { deadlineMs: 1000, now: () => (t += 10) });
  assert.deepEqual([r.status, calls.length], ["infra", 1]);
  assert.match(r.failed, /no time left for a retry/);
});
