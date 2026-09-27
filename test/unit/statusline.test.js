import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { installStatusline, uninstallStatusline, isBridgeCommand } from "../../plugins/autoclaude/lib/statusline.js";
import { saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const bridgeTemplate = new URL("../../plugins/autoclaude/templates/statusline-bridge.js", import.meta.url);

function machine(dir) {
  return { dir, usageFile: path.join(dir, "usage.json"), registryFile: path.join(dir, "registry.json"), notifyFile: path.join(dir, "notify.json"), statuslineScript: path.join(dir, "statusline.js"), logsDir: path.join(dir, "logs") };
}

function runBridge(script, input) {
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: "utf8" });
  return r.stdout;
}

test("install chains an existing status line, backs up settings, and is idempotent; uninstall restores", () => {
  const cfg = tmp("autoclaude-sl-");
  const settings = path.join(cfg, "settings.json");
  fs.writeFileSync(settings, JSON.stringify({ model: "x", hooks: { Stop: [] }, statusLine: { type: "command", command: "echo old-line" } }, null, 2));
  const m = machine(path.join(cfg, "autoclaude"));
  const r = installStatusline({ settings, machine: m, now: new Date("2026-09-27T00:00:00Z") });
  assert.equal(r.installed, true);
  assert.deepEqual(r.chained, { command: "echo old-line", args: undefined });
  assert.ok(fs.existsSync(r.backup));
  assert.ok(fs.existsSync(m.statuslineScript));
  const after = JSON.parse(fs.readFileSync(settings, "utf8"));
  assert.equal(after.model, "x");
  assert.deepEqual(after.hooks, { Stop: [] });
  assert.ok(isBridgeCommand(after.statusLine.command));
  assert.equal(JSON.parse(fs.readFileSync(path.join(m.dir, "statusline.json"), "utf8")).chain.command, "echo old-line");

  const r2 = installStatusline({ settings, machine: m });
  assert.equal(r2.alreadyInstalled, true);

  const u = uninstallStatusline({ settings, machine: m });
  assert.equal(u.removed, true);
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine.command, "echo old-line");
});

test("install with no settings file or no status line, then uninstall removes ours", () => {
  const cfg = tmp("autoclaude-sl-");
  const settings = path.join(cfg, "settings.json");
  const m = machine(path.join(cfg, "autoclaude"));
  const r = installStatusline({ settings, machine: m });
  assert.equal(r.installed, true);
  assert.equal(r.chained, null);
  assert.equal(r.backup, null);
  uninstallStatusline({ settings, machine: m });
  assert.equal(JSON.parse(fs.readFileSync(settings, "utf8")).statusLine, undefined);
});

test("the bridge writes usage.json, shows usage when idle, and the AC line when a run is active", () => {
  const cfg = tmp("autoclaude-sl-");
  const m = machine(path.join(cfg, "autoclaude"));
  fs.mkdirSync(m.dir, { recursive: true });
  fs.copyFileSync(bridgeTemplate, m.statuslineScript);
  fs.writeFileSync(path.join(m.dir, "statusline.json"), JSON.stringify({ chain: null }));
  const project = tmp("autoclaude-sl-proj-");
  fs.writeFileSync(path.join(project, "autoclaude.config.json"), "{\"version\":1}");
  const input = { session_id: "s1", cwd: project, rate_limits: { five_hour: { used_percentage: 12.4, resets_at: 1790479800 }, seven_day: { used_percentage: 7, resets_at: 1790776800 } } };

  let out = runBridge(m.statuslineScript, input);
  assert.equal(out, "5h 12% | 7d 7%");
  const usage = JSON.parse(fs.readFileSync(m.usageFile, "utf8"));
  assert.equal(usage.rate_limits.five_hour.used_percentage, 12.4);
  assert.equal(usage.session_id, "s1");

  saveState(project, { ...defaultState(), status: "running", currentStep: "S2.3" });
  out = runBridge(m.statuslineScript, input);
  assert.equal(out, "AC S2.3 > running | 5h 12% | 7d 7%");

  saveState(project, { ...defaultState(), status: "paused", pauseReason: "review", currentStep: "S2.3" });
  out = runBridge(m.statuslineScript, input);
  assert.equal(out, "AC S2.3 > paused (review) | 5h 12% | 7d 7%");

  fs.writeFileSync(path.join(m.dir, "statusline.json"), JSON.stringify({ chain: { command: process.execPath, args: ["-e", "process.stdout.write('[chained]')"] } }));
  saveState(project, { ...defaultState(), status: "idle" });
  out = runBridge(m.statuslineScript, { ...input, rate_limits: undefined });
  assert.equal(out, "[chained]");
});
