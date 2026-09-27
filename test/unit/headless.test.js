import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildArgs, interpret, runHeadless } from "../../plugins/autoclaude/lib/headless.js";

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

test("runHeadless sends the prompt on stdin, sets AUTOCLAUDE_ROLE and parses the result", async () => {
  const r = await run("ok");
  assert.equal(r.ok, true, r.error);
  assert.equal(r.structured.prompt, "check the page");
  assert.equal(r.structured.role, "tester");
  assert.deepEqual(r.structured.args, ["-p", "--x"]);
  assert.equal(r.costUsd, 0.012);
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
