import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadRegistry, registerProject, unregisterProject } from "../../plugins/autoclaude/lib/registry.js";

test("register, dedupe case-insensitively, list and unregister", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-reg-"));
  const file = path.join(dir, "registry.json");
  assert.deepEqual(loadRegistry(file), { projects: [] });
  const a = registerProject(path.join(dir, "ProjA"), { file, now: new Date("2026-09-27T00:00:00Z") });
  assert.equal(a.added, true);
  assert.equal(a.entry.name, "ProjA");
  const again = registerProject(path.join(dir, "proja"), { file });
  assert.equal(again.added, process.platform === "win32" ? false : true);
  registerProject(path.join(dir, "ProjB"), { file });
  const reg = loadRegistry(file);
  assert.ok(reg.projects.some((p) => p.name === "ProjB"));
  assert.equal(unregisterProject(path.join(dir, "ProjA"), { file }), true);
  assert.equal(unregisterProject(path.join(dir, "ProjA"), { file }), false);
  assert.ok(!loadRegistry(file).projects.some((p) => p.name === "ProjA"));
});

test("a corrupt registry reads as empty", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-reg-"));
  const file = path.join(dir, "registry.json");
  fs.writeFileSync(file, "nope");
  assert.deepEqual(loadRegistry(file), { projects: [] });
});
