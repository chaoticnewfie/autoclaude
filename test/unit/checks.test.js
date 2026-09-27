import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { runChecks, tailLines, TAIL_LINES } from "../../plugins/autoclaude/lib/checks.js";

const node = JSON.stringify(process.execPath);
const passing = (name = "pass") => ({ name, command: `${node} -e "console.log('ok from ${name}')"`, timeoutSec: 60 });
const failing = (name = "fail") => ({ name, command: `${node} -e "console.log('before'); console.error('boom'); process.exit(2)"`, timeoutSec: 60 });
const slow = (name = "slow") => ({ name, command: `${node} -e "setTimeout(()=>{}, 20000)"`, timeoutSec: 1 });

test("tailLines keeps the last n lines, normalises CRLF and ignores trailing newlines", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n") + "\n";
  const tail = tailLines(text);
  const lines = tail.split("\n");
  assert.equal(lines.length, TAIL_LINES);
  assert.equal(lines[0], "line 51");
  assert.equal(lines[lines.length - 1], "line 200");
  assert.equal(tailLines("a\r\nb\r\nc\r\n", 2), "b\nc");
  assert.equal(tailLines("a\nb", 10), "a\nb");
  assert.equal(tailLines("", 5), "");
  assert.equal(tailLines(null, 5), "");
  assert.equal(tailLines("a\nb\nc", 0), "");
});

test("runChecks runs every check in order and reports a pass", async () => {
  const seen = [];
  const r = await runChecks([passing("one"), passing("two")], { cwd: process.cwd(), onProgress: (res) => seen.push(res.name) });
  assert.equal(r.ok, true);
  assert.equal(r.failed, null);
  assert.deepEqual(seen, ["one", "two"]);
  assert.deepEqual(r.results.map((x) => x.name), ["one", "two"]);
  for (const res of r.results) {
    assert.equal(res.ran, true);
    assert.equal(res.ok, true);
    assert.equal(res.code, 0);
    assert.equal(res.timedOut, false);
    assert.equal(res.skipped, false);
    assert.equal(res.reason, null);
    assert.ok(res.durationMs >= 0);
    assert.match(res.stdout, new RegExp(`ok from ${res.name}`));
    assert.equal(res.tail, `ok from ${res.name}`);
  }
});

test("runChecks stops at the first failure and marks the rest skipped", async () => {
  const seen = [];
  const r = await runChecks([passing("first"), failing("second"), passing("third")], { onProgress: (res) => seen.push(res.name) });
  assert.equal(r.ok, false);
  assert.ok(r.failed);
  assert.equal(r.failed.name, "second");
  assert.equal(r.failed.ran, true);
  assert.equal(r.failed.ok, false);
  assert.equal(r.failed.code, 2);
  assert.equal(r.failed.timedOut, false);
  assert.equal(r.failed.reason, "exit code 2");
  assert.match(r.failed.stderr, /boom/);
  assert.match(r.failed.tail, /before/);
  assert.match(r.failed.tail, /boom/);
  assert.deepEqual(seen, ["first", "second"]);
  assert.equal(r.results.length, 3);
  const third = r.results[2];
  assert.equal(third.name, "third");
  assert.equal(third.skipped, true);
  assert.equal(third.ran, false);
  assert.equal(third.ok, false);
  assert.equal(third.code, null);
  assert.equal(third.command, passing("third").command);
});

test("runChecks enforces the per-check timeout and reports timedOut", async () => {
  const started = Date.now();
  const r = await runChecks([slow()]);
  assert.ok(Date.now() - started < 10000, "timeout was not enforced quickly");
  assert.equal(r.ok, false);
  assert.equal(r.failed.name, "slow");
  assert.equal(r.failed.ran, true);
  assert.equal(r.failed.timedOut, true);
  assert.equal(r.failed.reason, "timed out after 1 s");
});

test("a check that needs the dev server fails without running when it is not ready", async () => {
  const seen = [];
  const check = { ...passing("e2e"), needsDevServer: true };
  const r = await runChecks([passing("unit"), check, passing("after")], { devServerReady: false, onProgress: (res) => seen.push(res) });
  assert.equal(r.ok, false);
  assert.equal(r.failed.name, "e2e");
  assert.equal(r.failed.ran, false);
  assert.equal(r.failed.reason, "dev server not available");
  assert.equal(r.failed.code, null);
  assert.equal(r.failed.stdout, "");
  assert.equal(r.failed.tail, "");
  assert.equal(r.results[2].skipped, true);
  assert.deepEqual(seen.map((x) => x.name), ["unit", "e2e"]);
  assert.deepEqual(seen.map((x) => x.ran), [true, false]);

  const ready = await runChecks([check], { devServerReady: true });
  assert.equal(ready.ok, true);
  assert.equal(ready.results[0].ran, true);
  assert.equal(ready.results[0].code, 0);
});

test("a command that cannot start becomes a failed result instead of a throw", async () => {
  const missing = path.join(os.tmpdir(), "autoclaude-definitely-missing-dir-" + process.pid);
  const r = await runChecks([passing("nocwd")], { cwd: missing });
  assert.equal(r.ok, false);
  assert.equal(r.failed.name, "nocwd");
  assert.equal(r.failed.ran, false);
  assert.equal(typeof r.failed.reason, "string");
  assert.match(r.failed.reason, /could not start/);
});

test("runChecks with no checks passes with an empty result list", async () => {
  const r = await runChecks([]);
  assert.deepEqual(r, { ok: true, results: [], failed: null });
  const r2 = await runChecks(undefined);
  assert.equal(r2.ok, true);
});
