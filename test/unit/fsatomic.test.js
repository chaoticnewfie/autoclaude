import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { writeFileAtomic, writeJsonAtomic, readJson, appendLine, touch, ageMs, removeIfExists } from "../../plugins/autoclaude/lib/fsatomic.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fsatomic-"));

test("writeFileAtomic writes the content and leaves no temp file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "nested", "a.txt");
  const r = writeFileAtomic(file, "hello");
  assert.equal(fs.readFileSync(file, "utf8"), "hello");
  assert.equal(r.attempts, 1);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["a.txt"]);
});

test("a crash before the rename leaves the old content and no temp file", () => {
  const dir = tmpDir();
  const file = path.join(dir, "state.json");
  fs.writeFileSync(file, "old");
  assert.throws(() => writeFileAtomic(file, "new", { beforeRename: () => { throw new Error("simulated crash"); } }), /simulated crash/);
  assert.equal(fs.readFileSync(file, "utf8"), "old");
  assert.deepEqual(fs.readdirSync(dir), ["state.json"]);
});

test("writeJsonAtomic and readJson round-trip, and readJson falls back when missing", () => {
  const dir = tmpDir();
  const file = path.join(dir, "x.json");
  writeJsonAtomic(file, { a: 1, b: [1, 2] });
  assert.deepEqual(readJson(file), { a: 1, b: [1, 2] });
  assert.equal(readJson(path.join(dir, "missing.json"), "fallback"), "fallback");
});

test("appendLine adds exactly one newline per line and creates the directory", () => {
  const dir = tmpDir();
  const file = path.join(dir, "logs", "x.log");
  appendLine(file, "one");
  appendLine(file, "two\n");
  assert.equal(fs.readFileSync(file, "utf8"), "one\ntwo\n");
});

test("touch creates or bumps a file, and ageMs measures it", () => {
  const dir = tmpDir();
  const file = path.join(dir, "heartbeat");
  assert.equal(ageMs(file), null);
  touch(file);
  const age = ageMs(file);
  assert.ok(age !== null && age > -100 && age < 5000, `age was ${age}`);
  assert.equal(removeIfExists(file), true);
  assert.equal(removeIfExists(file), false);
});

test("rename over a file locked by another process is retried until the lock drops", { skip: process.platform !== "win32" ? "Windows-only lock semantics" : false }, async () => {
  const dir = tmpDir();
  const file = path.join(dir, "locked.json");
  fs.writeFileSync(file, "{\"v\":1}");
  const script = "$f=[System.IO.File]::Open('" + file.replace(/\\/g, "\\\\") + "','Open','Read','None'); Start-Sleep -Milliseconds 2500; $f.Close()";
  const locker = spawn("powershell.exe", ["-NoProfile", "-Command", script], { stdio: "ignore" });
  // Wait until the lock is really held (PowerShell startup time varies): opening for write fails then.
  // PowerShell can take well over 8 s to start while the full suite runs in parallel.
  const deadline = Date.now() + 30000;
  let locked = false;
  while (Date.now() < deadline) {
    try {
      fs.closeSync(fs.openSync(file, "r+"));
      await new Promise((r) => setTimeout(r, 50));
    } catch {
      locked = true;
      break;
    }
  }
  assert.ok(locked, "the locker process never took the lock");
  const started = Date.now();
  const r = writeFileAtomic(file, "{\"v\":2}");
  const waited = Date.now() - started;
  assert.ok(r.attempts > 1, `expected retries, got ${r.attempts}`);
  assert.ok(waited >= 500 && waited < 15000, `waited ${waited} ms`);
  assert.equal(fs.readFileSync(file, "utf8"), "{\"v\":2}");
  await new Promise((r) => locker.on("exit", r));
});
