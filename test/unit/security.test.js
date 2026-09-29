import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { SECURITY_SCHEMA, SECURITY_TOOLS, securityWanted, securityBase, reviewDiff, evaluateSecurity, securitySection, runSecurityReview, constraintsSection, buildSecurityPrompt, reviewedSteps, CONSTRAINTS_MAX_CHARS } from "../../plugins/autoclaude/lib/security.js";
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

test("runSecurityReview: stopped by the gate's deadline is out of time, not infra", async () => {
  const T = 1_000_000;
  const timedOut = { ok: false, infra: true, error: "timed out after 120 s", timedOut: true, durationMs: 120000 };
  let { r, calls } = await review([timedOut], { deadlineMs: T + 120000, now: () => T });
  assert.deepEqual([r.status, calls.length, calls[0].timeoutMs], ["out-of-time", 1, 120000]);
  assert.match(r.failed, /^Security review ran out of the gate's time \(1 try\): stopped at the gate's deadline after 120 s \(its own limit is 900 s\)/);
  assert.equal(r.sections[0].title, "Security review: out of time");
  ({ r } = await review([{ ...timedOut, error: "timed out after 900 s" }], { deadlineMs: T + 2000000, now: () => T }));
  assert.equal(r.status, "infra", "its own timeout, with time to spare, is the checker's problem");
});

const DECIDED = `# Kiosk plan

## Goal

A kiosk.

## Constraints & decisions

- No login: the kiosk is on a trusted LAN and anyone at the screen may use it.
- The server listens on 127.0.0.1 only.

### Data

- SQLite file in data/.

\`\`\`
## not a heading inside a fence
\`\`\`

## Phase 1: Things
- [ ] **S1.1** List things
  - Accept: /things lists 3 items
`;

test("constraintsSection: from the heading to the next ## heading, subsections kept, bounded", () => {
  const text = constraintsSection(DECIDED);
  assert.match(text, /^- No login: the kiosk is on a trusted LAN/);
  assert.match(text, /### Data\n\n- SQLite file in data\//, "### subsections belong to the section");
  assert.match(text, /## not a heading inside a fence/, "a ## line inside a code fence does not end it");
  assert.doesNotMatch(text, /Phase 1|Goal/);
  assert.equal(constraintsSection(PLAN), "", "no section");
  assert.equal(constraintsSection(DECIDED.replace(/\n/g, "\r\n")).includes("\r"), false, "CRLF plans work");
  const long = `## Constraints & decisions\n\n${Array.from({ length: 400 }, (_, i) => `- decision ${i} ${"x".repeat(30)}`).join("\n")}\n\n## Phase 1: A\n`;
  const cut = constraintsSection(long);
  assert.ok(cut.length <= CONSTRAINTS_MAX_CHARS, `length ${cut.length}`);
  assert.match(cut, /^- decision 0 /);
  assert.match(cut, /\[\.\.\. cut here; Read the rest of this section in the plan \.\.\.\]$/);
});

test("the security prompt shows the plan's Constraints & decisions and says how to treat them", () => {
  const template = fs.readFileSync(fileURLToPath(new URL("../../plugins/autoclaude/prompts/security.md", import.meta.url)), "utf8");
  const p = parsePlan(DECIDED);
  const prompt = buildSecurityPrompt({ template, step: stepById(p, "S1.1"), parsed: p, base: "ac-phase-1", diff: "(diff)", root: "/proj", planFile: "PLAN.md" });
  assert.match(prompt, /## The owner's decisions \(the "Constraints & decisions" section of PLAN\.md\)\n\n- No login: the kiosk is on a trusted LAN/);
  assert.match(prompt, /The server listens on 127\.0\.0\.1 only\./);
  assert.match(prompt, /Decisions recorded here are the owner's choices/);
  assert.match(prompt, /Report a finding against one only when it is unsafe in a way the decision does not account for, and never rate a documented decision high just for existing\./);
  assert.ok(prompt.indexOf("owner's decisions") < prompt.indexOf("(diff)"), "the decisions come before the diff");
  assert.doesNotMatch(prompt, /\{\{[A-Z_]+\}\}/);
  const none = buildSecurityPrompt({ template, step: S("S1.2"), parsed, base: null, diff: "(diff)", root: "/proj" });
  assert.match(none, /\(The plan has no "Constraints & decisions" section\.\)/);
});

test("securityBase: the feature's first commit wins over tags and the run start", async () => {
  const root = fixture();
  gitRun(root, ["tag", "ac-phase-1"]);
  assert.equal(await securityBase(root, { baseCommit: "abc1234", phaseBaseCommit: "fea7123" }, env), "fea7123");
  assert.equal(await securityBase(root, { baseCommit: "abc1234", phaseBaseCommit: null }, env), "ac-phase-1");
});

test("reviewedSteps: the given list, else the phase up to this step when the diff runs from the feature's start, else the step", () => {
  assert.deepEqual(reviewedSteps(S("S1.3"), { phaseBaseCommit: "x" }).map((s) => s.id), ["S1.1", "S1.2", "S1.3"]);
  assert.deepEqual(reviewedSteps(S("S1.2"), { phaseBaseCommit: "x" }).map((s) => s.id), ["S1.1", "S1.2"]);
  assert.deepEqual(reviewedSteps(S("S1.3"), { phaseBaseCommit: null }).map((s) => s.id), ["S1.3"]);
  assert.deepEqual(reviewedSteps(S("S1.3"), null, [S("S1.2")]).map((s) => s.id), ["S1.2"]);
});

test("runSecurityReview with a feature base: the diff holds the whole feature and the prompt lists its steps", async () => {
  const root = fixture();
  fs.appendFileSync(path.join(root, "lib", "todos.js"), "// before the feature\n");
  gitRun(root, ["commit", "-q", "-am", "an earlier feature"]);
  const featureBase = gitRun(root, ["rev-parse", "HEAD"]);
  fs.appendFileSync(path.join(root, "server.js"), "// S1.1 built and committed\n");
  gitRun(root, ["commit", "-q", "-am", "autoclaude(S1.1): built"]);
  fs.appendFileSync(path.join(root, "server.js"), "// S1.3 uncommitted\n");
  const { run, calls } = fakeRun([ok(verdictOf([]))]);
  const r = await runSecurityReview({ root, config, step: S("S1.3"), parsed, state: { baseCommit: null, phaseBaseCommit: featureBase }, env, attempt: 1, run });
  assert.equal(r.status, "passed");
  const prompt = calls[0].prompt;
  assert.match(prompt, /\+\/\/ S1\.1 built and committed/);
  assert.match(prompt, /\+\/\/ S1\.3 uncommitted/);
  assert.doesNotMatch(prompt, /before the feature/, "an earlier feature is not reviewed again");
  assert.match(prompt, /## What is being verified: Phase 1: Things \(steps S1\.1, S1\.2, S1\.3\)/);
  assert.ok(["S1.1", "S1.2", "S1.3"].every((id) => prompt.includes(`**${id}**`)));
  assert.match(prompt, /they form one feature and the diff below holds all of their changes/);
  const saved = JSON.parse(fs.readFileSync(path.join(root, r.verdictFile), "utf8"));
  assert.deepEqual([saved.base, saved.steps], [featureBase, ["S1.1", "S1.2", "S1.3"]]);
});

test("runSecurityReview passes the fixture plan's decisions to the reviewer", async () => {
  const root = fixture();
  const planText = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
  const p = parsePlan(planText);
  const { run, calls } = fakeRun([ok(verdictOf([]))]);
  await runSecurityReview({ root, config, step: p.steps[0], parsed: p, state: null, env, attempt: 1, run });
  assert.match(calls[0].prompt, /## The owner's decisions[^\n]*\n\n- Stack: Node 24 built-ins only/);
});
