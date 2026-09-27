import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readUsage, formatUsage } from "../../plugins/autoclaude/lib/usage.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-usage-"));
const NOW = Date.parse("2026-09-27T00:10:00Z");

test("no sources: unknown and stale", () => {
  const dir = tmpDir();
  const u = readUsage({ usageFile: path.join(dir, "usage.json"), userConfigFile: path.join(dir, "none.json"), now: NOW });
  assert.equal(u.source, null);
  assert.equal(u.stale, true);
  assert.match(formatUsage(u), /unknown/);
});

test("statusline file is read and formatted", () => {
  const dir = tmpDir();
  const usageFile = path.join(dir, "usage.json");
  fs.writeFileSync(usageFile, JSON.stringify({ updatedAt: "2026-09-27T00:05:00Z", rate_limits: { five_hour: { used_percentage: 12, resets_at: 1790479800 }, seven_day: { used_percentage: 7, resets_at: 1790776800 } } }));
  const u = readUsage({ usageFile, userConfigFile: path.join(dir, "none.json"), now: NOW, staleAfterMin: 30 });
  assert.equal(u.source, "statusline");
  assert.equal(u.fiveHour.pct, 12);
  assert.equal(u.sevenDay.pct, 7);
  assert.equal(u.fiveHour.resetsAt, 1790479800000);
  assert.equal(Math.round(u.ageMin), 5);
  assert.equal(u.stale, false);
  assert.match(formatUsage(u, NOW), /^usage: 5h 12%.*\| 7d 7%.*\[statusline, 5 min old\]$/);
});

test("the fresher of statusline and cached wins, and old data is stale", () => {
  const dir = tmpDir();
  const usageFile = path.join(dir, "usage.json");
  const cfg = path.join(dir, ".claude.json");
  fs.writeFileSync(usageFile, JSON.stringify({ updatedAt: "2026-09-26T20:00:00Z", rate_limits: { five_hour: { used_percentage: 40, resets_at: 1790479800 } } }));
  fs.writeFileSync(cfg, JSON.stringify({ cachedUsageUtilization: { fetchedAtMs: Date.parse("2026-09-27T00:00:00Z"), utilization: { five_hour: { utilization: 13, resets_at: "2026-09-27T02:30:00+00:00" }, seven_day: { utilization: 8, resets_at: "2026-09-30T14:00:00+00:00" } } } }));
  const u = readUsage({ usageFile, userConfigFile: cfg, now: NOW, staleAfterMin: 30 });
  assert.equal(u.source, "cached");
  assert.equal(u.fiveHour.pct, 13);
  assert.equal(u.sevenDay.pct, 8);
  assert.equal(u.fiveHour.resetsAt, Date.parse("2026-09-27T02:30:00Z"));
  assert.equal(u.stale, false);

  const old = readUsage({ usageFile, userConfigFile: path.join(dir, "none.json"), now: NOW, staleAfterMin: 30 });
  assert.equal(old.source, "statusline");
  assert.equal(old.stale, true);
  assert.match(formatUsage(old, NOW), /stale\]$/);
});

test("a broken cached file is ignored rather than thrown", () => {
  const dir = tmpDir();
  const cfg = path.join(dir, ".claude.json");
  fs.writeFileSync(cfg, "{ nope");
  assert.equal(readUsage({ usageFile: path.join(dir, "u.json"), userConfigFile: cfg, now: NOW }).source, null);
});
