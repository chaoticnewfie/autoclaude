import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runChecks, tailLines, TAIL_LINES, DEFAULT_CHECK_TIMEOUT_SEC, isGitBashOnlyDir, withoutGitBashDirs, checksEnv, recordRunEnv, readRunEnv, runEnvFile, describeChecksEnv } from "../../plugins/autoclaude/lib/checks.js";

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

test("runChecks caps every check at the gate's deadline: one stopped by it, or not started for lack of time, is out of time", async () => {
  // Its own timeout would allow 10 minutes; the deadline allows about a second and a half.
  const long = { ...slow("long"), timeoutSec: 600 };
  const started = Date.now();
  let r = await runChecks([long, passing("after")], { deadlineMs: Date.now() + 1500, minMs: 500 });
  assert.ok(Date.now() - started < 10000, "the deadline, not the check's own timeout, ended it");
  assert.deepEqual([r.ok, r.failed.name, r.failed.ran, r.failed.timedOut, r.failed.outOfTime], [false, "long", true, true, true]);
  assert.match(r.failed.reason, /^stopped at the gate's deadline after \d+ s \(its own timeoutSec is 600\)$/);
  assert.equal(r.results[1].skipped, true);

  // Too little left to start: not run at all, and still out of time rather than a failure.
  r = await runChecks([passing("late")], { deadlineMs: Date.now() + 2000 });
  assert.deepEqual([r.ok, r.failed.ran, r.failed.outOfTime, r.failed.reason], [false, false, true, "no time left before the gate's deadline"]);

  // A check that times out on its own timeout inside the deadline is a plain failure.
  r = await runChecks([slow()], { deadlineMs: Date.now() + 60000 });
  assert.deepEqual([r.failed.timedOut, r.failed.outOfTime, r.failed.reason], [true, false, "timed out after 1 s"]);
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

test("a check without timeoutSec runs under the 900 s default instead of no limit", async () => {
  assert.equal(DEFAULT_CHECK_TIMEOUT_SEC, 900);
  const { timeoutSec, ...noTimeout } = passing("untimed");
  const r = await runChecks([noTimeout]);
  assert.equal(r.ok, true);
  assert.equal(r.results[0].ran, true);
});

// ---------- the checks' environment (P8.4) ----------

// The PATH a native program sees when started from Git Bash on Windows (seen on the dev VM).
const GIT_BASH_PATH = [
  "C:\\Users\\me\\bin",
  "C:\\Program Files\\Git\\mingw64\\bin",
  "C:\\Program Files\\Git\\usr\\local\\bin",
  "C:\\Program Files\\Git\\usr\\bin",
  "C:\\Windows\\system32",
  "C:\\Program Files\\Git\\cmd",
  "C:\\Program Files\\nodejs",
  "/usr/bin",
  "C:\\Program Files\\Git\\usr\\bin\\vendor_perl",
  "C:\\tools\\clangarm64\\bin"
].join(";");
const STRIPPED = "C:\\Users\\me\\bin;C:\\Windows\\system32;C:\\Program Files\\Git\\cmd;C:\\Program Files\\nodejs";

test("Git Bash's own folders are recognised; Git's cmd folder and everything else stay", () => {
  assert.equal(isGitBashOnlyDir("C:\\Program Files\\Git\\usr\\bin"), true);
  assert.equal(isGitBashOnlyDir("C:\\Program Files\\Git\\mingw64\\bin"), true);
  assert.equal(isGitBashOnlyDir("C:\\Program Files\\Git\\usr\\bin\\core_perl"), true);
  assert.equal(isGitBashOnlyDir("/usr/bin"), true, "a POSIX-form entry");
  assert.equal(isGitBashOnlyDir("/mingw64/bin"), true);
  assert.equal(isGitBashOnlyDir("C:\\Program Files\\Git\\cmd"), false);
  assert.equal(isGitBashOnlyDir("C:\\Program Files\\nodejs"), false);
  assert.equal(isGitBashOnlyDir("C:\\Users\\me\\AppData\\Local\\Programs\\busybin"), false);
  assert.equal(isGitBashOnlyDir("\\\\server\\share\\bin"), false, "a UNC path is not POSIX");
  assert.equal(isGitBashOnlyDir(""), false);
  assert.equal(withoutGitBashDirs(GIT_BASH_PATH, ";"), STRIPPED);
  assert.equal(withoutGitBashDirs("", ";"), "");
});

test("checksEnv: the run's recorded PATH first, else Git Bash's stripped, else the shell's own", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cenv-"));
  const shell = { PATH: GIT_BASH_PATH, MSYSTEM: "MINGW64", HOME: "h" };

  // Git Bash, nothing recorded: Git Bash's own folders go, the rest of the env is kept.
  let ce = checksEnv(root, shell, { delimiter: ";" });
  assert.equal(ce.source, "git-bash");
  assert.equal(ce.env.PATH, STRIPPED);
  assert.equal(ce.env.HOME, "h");
  assert.equal(shell.PATH, GIT_BASH_PATH, "the caller's env is not changed");
  assert.match(describeChecksEnv(ce), /without Git Bash's own folders/);

  // cmd or PowerShell, nothing recorded: the env as it is.
  const cmdEnv = { Path: "C:\\Windows\\system32;C:\\Program Files\\Git\\usr\\bin" };
  ce = checksEnv(root, cmdEnv);
  assert.deepEqual([ce.source, ce.env], ["shell", cmdEnv], "only Git Bash is stripped; a system PATH that has Git's usr\\bin keeps it");

  // Recorded by the run: that PATH, under every spelling the shell had, so a child cannot pick
  // up a stale "Path" next to the new "PATH".
  const recorded = { PATH: "C:\\run\\bin;C:\\Windows\\system32" };
  assert.deepEqual(recordRunEnv(root, recorded, { now: () => new Date("2026-09-28T10:00:00Z") }), { file: runEnvFile(root), changed: true });
  ce = checksEnv(root, { ...shell, Path: "stale" });
  assert.equal(ce.source, "run");
  assert.deepEqual([ce.env.PATH, ce.env.Path, ce.env.MSYSTEM], [recorded.PATH, recorded.PATH, "MINGW64"]);
  assert.match(describeChecksEnv(ce), /the PATH the run recorded at 2026-09-28T10:00:00\.000Z \(the gate's\)/);
  ce = checksEnv(root, { HOME: "h" });
  assert.deepEqual(Object.keys(ce.env).sort(), ["HOME", "PATH"], "no PATH at all: one PATH key");
  assert.equal(checksEnv(null, shell, { delimiter: ";" }).source, "git-bash", "outside a project nothing is recorded");
});

test("recordRunEnv writes only when the PATH changed; readRunEnv takes PATH, then Path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-runenv-"));
  assert.equal(readRunEnv(root), null, "no file");
  const at = (s) => ({ now: () => new Date(s) });
  assert.equal(recordRunEnv(root, { Path: "C:\\a" }, at("2026-09-28T01:00:00Z")).changed, true);
  assert.deepEqual(readRunEnv(root), { PATH: null, Path: "C:\\a", value: "C:\\a", at: "2026-09-28T01:00:00.000Z" });
  assert.equal(recordRunEnv(root, { Path: "C:\\a" }, at("2026-09-28T02:00:00Z")).changed, false, "same PATH: the file is left alone");
  assert.equal(readRunEnv(root).at, "2026-09-28T01:00:00.000Z");
  assert.equal(recordRunEnv(root, { PATH: "C:\\b", Path: "C:\\a" }, at("2026-09-28T03:00:00Z")).changed, true);
  assert.equal(readRunEnv(root).value, "C:\\b");
  fs.writeFileSync(runEnvFile(root), "{ not json");
  assert.equal(readRunEnv(root), null, "a broken file counts as none");
});

