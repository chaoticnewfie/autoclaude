import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { isBuilderSession, liveSupervisorPid } from "../../plugins/autoclaude/lib/builder.js";

function root(pidText) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-builder-"));
  if (pidText !== undefined) {
    fs.mkdirSync(path.join(dir, ".autoclaude"));
    fs.writeFileSync(path.join(dir, ".autoclaude", "supervisor.pid"), pidText);
  }
  return dir;
}

test("AUTOCLAUDE_BUILDER=1 is always the builder, even under a live supervisor", () => {
  assert.equal(isBuilderSession(root(String(process.pid)), { AUTOCLAUDE_BUILDER: "1" }), true);
  assert.equal(isBuilderSession(root(), { AUTOCLAUDE_BUILDER: "1" }), true);
});

test("without the marker: a live supervisor means someone else's session; none means a hand-started run", () => {
  assert.equal(isBuilderSession(root(String(process.pid)), {}), false);
  assert.equal(isBuilderSession(root(`${process.pid}\n`), { AUTOCLAUDE_BUILDER: "0" }), false, "only the value 1 counts");
  assert.equal(liveSupervisorPid(root(String(process.pid))), process.pid);
  assert.equal(isBuilderSession(root(), {}), true, "no supervisor.pid");
  assert.equal(isBuilderSession(root("not a pid"), {}), true);
  assert.equal(isBuilderSession(root(""), {}), true);
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  assert.equal(isBuilderSession(root(String(dead)), {}), true, "a supervisor that has exited");
  assert.equal(liveSupervisorPid(root(String(dead))), null);
});
