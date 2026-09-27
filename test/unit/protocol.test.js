import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeReady, readReady, clearReady, writeBlocked, readBlocked, clearBlocked, bumpHeartbeat, readHeartbeat } from "../../plugins/autoclaude/lib/protocol.js";

test("ready and blocked markers round-trip and clear", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-proto-"));
  assert.equal(readReady(root), null);
  writeReady(root, "S1.1", { now: new Date("2026-09-27T00:00:00Z") });
  assert.deepEqual(readReady(root), { step: "S1.1", at: "2026-09-27T00:00:00.000Z" });
  assert.equal(clearReady(root), true);
  assert.equal(clearReady(root), false);
  writeBlocked(root, "S1.1", "Which db?", { now: new Date("2026-09-27T00:00:00Z") });
  assert.equal(readBlocked(root).question, "Which db?");
  assert.equal(clearBlocked(root), true);
  assert.equal(readBlocked(root), null);
});

test("heartbeat counts up and survives a corrupt file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-proto-"));
  assert.deepEqual(readHeartbeat(root), { count: 0, at: null });
  bumpHeartbeat(root);
  bumpHeartbeat(root);
  assert.equal(readHeartbeat(root).count, 2);
  fs.writeFileSync(path.join(root, ".autoclaude", "heartbeat"), "garbage");
  assert.equal(readHeartbeat(root).count, 0);
  assert.equal(bumpHeartbeat(root).count, 1);
});
