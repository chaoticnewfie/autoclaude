import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordDenial } from "../../plugins/autoclaude/lib/denials.js";

test("denials are logged, counted per hour, and notify once per hour past the limit", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-denials-"));
  const t0 = Date.parse("2026-09-27T03:00:00Z");
  let r;
  for (let i = 0; i < 10; i++) {
    r = recordDenial(root, { kind: "permission", tool: "Bash", detail: `cmd ${i}` }, { limit: 10, now: t0 + i * 1000 });
    assert.equal(r.notify, false, `denial ${i + 1} is within the limit`);
  }
  assert.equal(r.count, 10);
  r = recordDenial(root, { kind: "guard", tool: "Bash" }, { limit: 10, now: t0 + 11000 });
  assert.deepEqual([r.count, r.notify], [11, true], "the 11th within an hour notifies");
  r = recordDenial(root, { kind: "guard", tool: "Bash" }, { limit: 10, now: t0 + 12000 });
  assert.equal(r.notify, false, "only once per hour");
  r = recordDenial(root, { kind: "guard", tool: "Bash" }, { limit: 10, now: t0 + 2 * 3600 * 1000 });
  assert.deepEqual([r.count, r.notify], [1, false], "old denials age out");
  const log = fs.readFileSync(path.join(root, ".autoclaude", "logs", "denials.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 13);
  assert.match(log[0], /permission Bash cmd 0/);
});
