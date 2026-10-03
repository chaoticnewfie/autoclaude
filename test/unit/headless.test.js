import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildArgs, interpret, isRateLimit, runHeadless, hitTurnLimit, wrapUpArgs, runWithWrapUp, WRAP_UP_PROMPT, agentBody, buildDeciderPrompt, validDecision, runDecider, DECIDER_SCHEMA, DECIDER_TIMEOUT_MS } from "../../plugins/autoclaude/lib/headless.js";

const fake = fileURLToPath(new URL("../fixtures/fake-claude.mjs", import.meta.url));
const run = (mode, extra = {}) => runHeadless({ prompt: "check the page", args: ["-p", "--x"], bin: process.execPath, binArgs: [fake], env: { ...process.env, FAKE_CLAUDE_MODE: mode }, role: "tester", timeoutMs: 20000, ...extra });

test("buildArgs: hooks off, no prompts, strict MCP, schema, tools", () => {
  const a = buildArgs({ model: "sonnet", maxTurns: 40, schema: { type: "object" }, mcpConfig: "C:/p/.autoclaude/mcp.json", allowedTools: ["mcp__playwright", "Read"] });
  const at = (flag) => a[a.indexOf(flag) + 1];
  assert.equal(a[0], "-p");
  assert.equal(at("--output-format"), "json");
  assert.equal(at("--settings"), '{"disableAllHooks":true}');
  assert.equal(at("--permission-mode"), "dontAsk");
  assert.ok(a.includes("--strict-mcp-config"));
  assert.equal(at("--mcp-config"), "C:/p/.autoclaude/mcp.json");
  assert.equal(at("--model"), "sonnet");
  assert.equal(at("--max-turns"), "40");
  assert.equal(at("--json-schema"), '{"type":"object"}');
  assert.equal(at("--allowedTools"), "mcp__playwright,Read");
  assert.ok(!a.includes("--bare"), "--bare breaks subscription auth (VERIFY.md P0.4)");
});

test("interpret: good, error result, missing verdict, garbage, timeout, spawn error", () => {
  let r = interpret({ stdout: JSON.stringify({ is_error: false, structured_output: { verdict: "pass" }, num_turns: 4, total_cost_usd: 0.1 }) });
  assert.deepEqual([r.ok, r.infra, r.structured.verdict, r.numTurns, r.costUsd], [true, false, "pass", 4, 0.1]);
  r = interpret({ stdout: JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "x" }) });
  assert.deepEqual([r.ok, r.infra], [false, true]);
  assert.match(r.error, /error_max_turns/);
  r = interpret({ stdout: JSON.stringify({ is_error: false, result: "hi" }) });
  assert.match(r.error, /without a structured verdict/);
  r = interpret({ stdout: "nope", stderr: "boom", code: 1 });
  assert.match(r.error, /unreadable output \(exit 1\): boom/);
  r = interpret({ timedOut: true, durationMs: 5000 });
  assert.match(r.error, /timed out after 5 s/);
  r = interpret({ spawnError: "ENOENT" });
  assert.match(r.error, /could not start claude: ENOENT/);
});

test("interpret flags a usage-limit result as rateLimited, and nothing else (P10.1)", () => {
  // A good result and ordinary failures are never rate-limited.
  let r = interpret({ stdout: JSON.stringify({ is_error: false, structured_output: { verdict: "pass" } }) });
  assert.equal(r.rateLimited, false);
  r = interpret({ stdout: JSON.stringify({ is_error: true, subtype: "error_max_turns", result: "ran out of turns" }) });
  assert.equal(r.rateLimited, false);
  r = interpret({ timedOut: true, durationMs: 1000 });
  assert.equal(r.rateLimited, false);
  r = interpret({ spawnError: "ENOENT" });
  assert.equal(r.rateLimited, false);
  // The known forms of a usage limit in the JSON output.
  for (const out of [
    { is_error: true, subtype: "error_usage_limit", result: "" },
    { is_error: true, subtype: "error_during_execution", result: "5-hour limit reached; resets at 1790479800" },
    { is_error: true, terminal_reason: "rate_limit", result: "" },
    { is_error: true, result: "Too many requests (429); your weekly limit will reset" }
  ]) {
    r = interpret({ stdout: JSON.stringify(out) });
    assert.equal(r.ok, false);
    assert.equal(r.infra, true);
    assert.equal(r.rateLimited, true, JSON.stringify(out));
  }
});

test("isRateLimit matches the usage-limit wording in any of subtype, terminal_reason or result", () => {
  assert.equal(isRateLimit({ subtype: "error_rate_limit" }), true);
  assert.equal(isRateLimit({ result: "usage limit reached" }), true);
  assert.equal(isRateLimit({ terminal_reason: "quota_exhausted" }), true);
  assert.equal(isRateLimit({ subtype: "error_max_turns", result: "done" }), false);
  assert.equal(isRateLimit({}), false);
});

test("runHeadless sends the prompt on stdin, sets AUTOCLAUDE_ROLE and parses the result", async () => {
  const r = await run("ok");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.structured.prompt, "check the page");
  assert.equal(r.structured.role, "tester");
  assert.deepEqual(r.structured.args, ["-p", "--x"]);
  assert.equal(r.costUsd, 0.012);
});

test("runHeadless drops an inherited CLAUDE_EFFORT, so a checker uses the owner's own effort", async () => {
  // The DB project's second run: the gate inherited the builder's CLAUDE_EFFORT ("ultracode") and
  // every checker ran at high instead of the owner's xhigh (D54).
  const r = await run("ok", { env: { ...process.env, FAKE_CLAUDE_MODE: "ok", CLAUDE_EFFORT: "ultracode" } });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.structured.effort, null);
  assert.equal(r.structured.role, "tester");
});

// An npm install of Claude Code is a claude.cmd, which Node will not spawn without a shell
// (a synchronous EINVAL); every checker and `autoclaude decide` failed as infra with it.
test("runHeadless runs a .cmd claude (an npm install) through cmd.exe, arguments and stdin intact", { skip: process.platform !== "win32" && "Windows only" }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude headless "));
  const shim = path.join(dir, "claude.cmd");
  fs.writeFileSync(shim, `@"${process.execPath}" "${fake}" %*\r\n`);
  const args = ["-p", "--json-schema", '{"type":"object","properties":{"a b":{"type":"string"}}}', "--mcp-config", path.join(dir, "mcp.json"), "a & b | c (d) ^e <f> 100%", "trail\\"];
  const r = await runHeadless({ prompt: "check the page", args, bin: shim, env: { ...process.env, FAKE_CLAUDE_MODE: "ok" }, role: "tester", timeoutMs: 20000 });
  assert.equal(r.ok, true, r.error);
  assert.equal(r.structured.prompt, "check the page");
  assert.equal(r.structured.role, "tester");
  assert.deepEqual(r.structured.args, args);
});

test("runHeadless finds the JSON line among other output", async () => {
  const r = await run("noise");
  assert.equal(r.ok, true, r.error);
  assert.deepEqual(r.structured, { ok: true });
});

test("runHeadless reports infra failures instead of throwing", async () => {
  for (const [mode, re] of [["garbage", /unreadable output/], ["error", /error_max_turns/], ["nostruct", /structured verdict/]]) {
    const r = await run(mode);
    assert.equal(r.ok, false, mode);
    assert.equal(r.infra, true, mode);
    assert.match(r.error, re, mode);
  }
  const missing = await runHeadless({ prompt: "x", args: [], bin: "C:/definitely/not/here/claude.exe", timeoutMs: 5000 });
  assert.equal(missing.infra, true);
  assert.match(missing.error, /could not start claude/);
});

test("runHeadless kills a run that exceeds its timeout", async () => {
  const started = Date.now();
  const r = await run("sleep", { timeoutMs: 1500 });
  assert.equal(r.timedOut, true);
  assert.match(r.error, /timed out/);
  assert.ok(Date.now() - started < 15000);
});

test("a run that hits the turn limit is resumed once for its answer; anything else runs once", async () => {
  const limit = interpret({ stdout: JSON.stringify({ is_error: true, subtype: "error_max_turns", session_id: "s-1", num_turns: 61, total_cost_usd: 0.5 }), code: 1 });
  assert.equal(limit.subtype, "error_max_turns");
  assert.equal(hitTurnLimit(limit), true);
  assert.equal(hitTurnLimit({ ...limit, sessionId: null }), false, "nothing to resume");
  assert.equal(hitTurnLimit(interpret({ timedOut: true, durationMs: 5 })), false);
  const args = buildArgs({ maxTurns: 60, schema: { type: "object" } });
  const w = wrapUpArgs(args, "s-1");
  assert.deepEqual(w.slice(-4), ["--max-turns", "4", "--resume", "s-1"]);
  assert.equal(w.filter((a) => a === "--max-turns").length, 1);
  assert.ok(w.includes("--json-schema"), "the wrap-up keeps the schema");

  const calls = [];
  const good = { ok: true, infra: false, structured: { verdict: "pass" }, numTurns: 2, durationMs: 1000, costUsd: 0.1 };
  const fake = (seq) => async (o) => { calls.push(o); return seq[calls.length - 1]; };
  let r = await runWithWrapUp(fake([{ ...limit, durationMs: 9000 }, good]), { prompt: "explore", args, timeoutMs: 900000 });
  assert.deepEqual([r.ok, r.wrappedUp, r.numTurns, r.durationMs, calls.length], [true, true, 63, 10000, 2]);
  assert.equal(r.costUsd, 0.6);
  assert.equal(calls[1].prompt, WRAP_UP_PROMPT);
  assert.equal(calls[1].timeoutMs, 300000);
  calls.length = 0;
  r = await runWithWrapUp(fake([limit, { ...limit, sessionId: "s-2" }]), { prompt: "explore", args });
  assert.deepEqual([r.ok, r.wrappedUp, calls.length], [false, false, 2]);
  assert.match(r.error, /error_max_turns.*; the wrap-up also failed: claude ended with error_max_turns/);
  calls.length = 0;
  r = await runWithWrapUp(fake([good]), { prompt: "check", args });
  assert.deepEqual([r.ok, r.wrappedUp, calls.length], [true, undefined, 1]);
  // A deadline (the gate's, or the decide call's) caps the wrap-up too, never below 20 s.
  calls.length = 0;
  await runWithWrapUp(fake([limit, good]), { prompt: "explore", args, timeoutMs: 900000, deadlineMs: Date.now() + 60000 });
  assert.ok(calls[1].timeoutMs <= 60000 && calls[1].timeoutMs >= 50000, String(calls[1].timeoutMs));
  calls.length = 0;
  await runWithWrapUp(fake([limit, good]), { prompt: "explore", args, timeoutMs: 900000, deadlineMs: Date.now() - 1000 });
  assert.equal(calls[1].timeoutMs, 20000);
});

// ---------- the decider (`autoclaude decide`) ----------

const DECIDER_MD = fileURLToPath(new URL("../../plugins/autoclaude/agents/decider.md", import.meta.url));
const ROUTINE = { classification: "routine", recommendation: "Use SQLite", reasoning: "The plan's Stack says SQLite. Undo: swap the driver.", question_for_owner: "", owner_review: false };

test("the decider's prompt: the agent's body without its front matter, then the question and the files to read", () => {
  assert.equal(agentBody("---\nname: x\ntools: Read\n---\n\nYou decide.\n"), "You decide.");
  assert.equal(agentBody("\uFEFF---\r\nname: x\r\n---\r\nBody"), "Body");
  assert.equal(agentBody("No front matter"), "No front matter");
  const template = fs.readFileSync(DECIDER_MD, "utf8");
  const step = { id: "S2.1", title: "Store sessions" };
  const p = buildDeciderPrompt({ template, question: "Cookies or localStorage? Options: A cookies, B localStorage", root: "C:/proj", planFile: "C:/proj/PLAN.md", decisionsFile: "C:/proj/docs/DECISIONS.md", step, stepText: "- [ ] **S2.1** Store sessions\n  - Accept: a" });
  assert.ok(p.startsWith("You are the decider"), "the body comes first");
  assert.doesNotMatch(p, /^name: decider/m, "no front matter");
  assert.match(p, /- The plan: C:\/proj\/PLAN\.md\n- The decisions log: C:\/proj\/docs\/DECISIONS\.md\n- The step being worked on: S2\.1 Store sessions/);
  assert.match(p, /The builder asks:\n\nCookies or localStorage\? Options: A cookies, B localStorage\n/);
  assert.match(p, /- Accept: a/);
  assert.match(p, /`owner_review`: true when the recommendation accepts a security or privacy risk/);
  assert.doesNotMatch(buildDeciderPrompt({ question: "q", root: "r", planFile: "p", decisionsFile: "d" }), /step being worked on/, "no step outside a run");
});

test("validDecision accepts a complete answer and fills the optional fields; anything else is no answer", () => {
  assert.deepEqual(validDecision(ROUTINE), ROUTINE);
  assert.deepEqual(validDecision({ classification: "critical", recommendation: "B", reasoning: "r" }), { classification: "critical", recommendation: "B", reasoning: "r", question_for_owner: "", owner_review: false });
  assert.equal(validDecision({ ...ROUTINE, owner_review: "yes" }).owner_review, false, "only a real true flags the owner");
  assert.equal(validDecision({ ...ROUTINE, classification: "maybe" }), null);
  assert.equal(validDecision({ ...ROUTINE, recommendation: " " }), null);
  assert.equal(validDecision(null), null);
  assert.deepEqual(DECIDER_SCHEMA.required, ["classification", "recommendation", "reasoning", "question_for_owner", "owner_review"]);
  assert.deepEqual(DECIDER_SCHEMA.properties.classification.enum, ["routine", "critical"]);
  assert.equal(DECIDER_SCHEMA.properties.owner_review.type, "boolean");
});

test("runDecider: read-only tools, the project's model, the project folder, a schema; failures are answers with ok false", async () => {
  const calls = [];
  const fake = (result) => async (o) => { calls.push(o); return result; };
  let r = await runDecider({ root: "C:/proj", question: "Which port?", planFile: "C:/proj/PLAN.md", decisionsFile: "C:/proj/docs/DECISIONS.md", model: "opus", env: { PATH: "p", AUTOCLAUDE_BUILDER: "1" }, run: fake({ ok: true, structured: { ...ROUTINE, reverse: "extra fields are dropped" }, durationMs: 42000, costUsd: 0.3, numTurns: 5 }) });
  assert.deepEqual(r, { ok: true, decision: ROUTINE, error: null, durationMs: 42000, costUsd: 0.3, numTurns: 5 });
  const o = calls[0];
  const at = (flag) => o.args[o.args.indexOf(flag) + 1];
  assert.deepEqual([o.cwd, o.role, o.timeoutMs], ["C:/proj", "decider", DECIDER_TIMEOUT_MS]);
  assert.ok(DECIDER_TIMEOUT_MS < 10 * 60 * 1000, "inside the Bash tool's 10-minute ceiling");
  assert.ok(o.deadlineMs > Date.now() && o.deadlineMs <= Date.now() + DECIDER_TIMEOUT_MS + 30000 && DECIDER_TIMEOUT_MS + 30000 < 10 * 60 * 1000, "a wrap-up also ends inside the Bash call");
  assert.deepEqual([at("--model"), at("--allowedTools"), at("--permission-mode"), at("--max-turns")], ["opus", "Read,Glob,Grep", "dontAsk", "30"]);
  assert.deepEqual(JSON.parse(at("--json-schema")), DECIDER_SCHEMA);
  assert.equal(at("--settings"), '{"disableAllHooks":true}');
  assert.ok(!o.args.includes("--mcp-config"), "no MCP servers");
  assert.deepEqual(o.env, { PATH: "p" }, "the child is not marked as the builder");
  assert.match(o.prompt, /Which port\?/);

  r = await runDecider({ root: "r", question: "q", planFile: "p", decisionsFile: "d", run: fake({ ok: false, error: "timed out after 540 s", durationMs: 540000 }) });
  assert.deepEqual([r.ok, r.decision, r.error], [false, null, "timed out after 540 s"]);
  r = await runDecider({ root: "r", question: "q", planFile: "p", decisionsFile: "d", run: fake({ ok: true, structured: { classification: "routine" } }) });
  assert.equal(r.ok, false);
  assert.match(r.error, /the decider's answer is incomplete/);
  r = await runDecider({ root: "r", question: "q", planFile: "p", decisionsFile: "d", run: async () => { throw new Error("boom"); } });
  assert.deepEqual([r.ok, r.error], [false, "boom"]);

  // Out of turns: resumed once for the answer.
  calls.length = 0;
  const seq = [{ ok: false, subtype: "error_max_turns", sessionId: "s-9", error: "claude ended with error_max_turns: x", durationMs: 1000 }, { ok: true, structured: ROUTINE, durationMs: 500 }];
  r = await runDecider({ root: "r", question: "q", planFile: "p", decisionsFile: "d", run: async (x) => { calls.push(x); return seq[calls.length - 1]; } });
  assert.deepEqual([r.ok, r.decision, calls.length, calls[1].prompt], [true, ROUTINE, 2, WRAP_UP_PROMPT]);
});

test("runDecider passes its effort as --effort, and none when it is null (D55)", async () => {
  const calls = [];
  const run = async (o) => { calls.push(o); return { ok: true, structured: ROUTINE, durationMs: 1 }; };
  const base = { root: "C:/proj", question: "Which port?", planFile: "C:/proj/PLAN.md", decisionsFile: "C:/proj/docs/DECISIONS.md", env: { PATH: "p" }, run };
  await runDecider({ ...base, effort: "xhigh" });
  await runDecider(base);
  assert.equal(calls[0].args[calls[0].args.indexOf("--effort") + 1], "xhigh");
  assert.equal(calls[1].args.includes("--effort"), false);
  assert.equal(buildArgs({ effort: "max" }).includes("--effort"), true);
});
