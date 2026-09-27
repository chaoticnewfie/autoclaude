// Scenarios for the Phase 6 hooks: Notification (idle and input prompts), StopFailure, and the
// gate's "verifying" marker. Each script is fed the JSON Claude Code would send.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { failureType } from "../../plugins/autoclaude/scripts/stop-failure.js";

const script = (name) => fileURLToPath(new URL(`../../plugins/autoclaude/scripts/${name}`, import.meta.url));

function project(status = "running") {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-p6-"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(root, "PLAN.md"), "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** One\n  - Accept: a\n");
  if (status) saveState(root, { ...defaultState(), status, currentStep: "S1.1" });
  return root;
}

function run(name, root, input) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-p6-cfg-")) };
  delete env.AUTOCLAUDE_ROLE;
  return spawnSync(process.execPath, [script(name)], { input: JSON.stringify({ cwd: root, session_id: "s", ...input }), encoding: "utf8", env });
}

test("idle_prompt only leaves a marker for the supervisor; no page", () => {
  const root = project();
  const r = run("notify-idle.js", root, { hook_event_name: "Notification", notification_type: "idle_prompt", message: "Claude is waiting for your input" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout, "");
  const idle = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "idle"), "utf8"));
  assert.equal(idle.type, "idle_prompt");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "logs", "notify.log")), false);
});

test("a permission or input prompt pages the owner once per 30 minutes", () => {
  const root = project();
  run("notify-idle.js", root, { hook_event_name: "Notification", notification_type: "permission_prompt", message: "Claude needs your permission to use Bash" });
  run("notify-idle.js", root, { hook_event_name: "Notification", notification_type: "agent_needs_input", message: "again" });
  const log = fs.readFileSync(path.join(root, ".autoclaude", "logs", "notify.log"), "utf8").trim().split("\n");
  assert.equal(log.length, 1, "throttled");
  assert.match(log[0], /\[high\] stdout AutoClaude: the session is waiting for a person: .*permission_prompt/);
});

test("no run, or a nested checker: the Notification hook does nothing", () => {
  const root = project(null);
  run("notify-idle.js", root, { notification_type: "permission_prompt" });
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "idle")), false);
});

test("StopFailure writes failure.json with the error type and logs the raw input", () => {
  const root = project();
  const r = run("stop-failure.js", root, { hook_event_name: "StopFailure", error_type: "rate_limit", message: "limit" });
  assert.equal(r.status, 0);
  const f = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "failure.json"), "utf8"));
  assert.equal(f.type, "rate_limit");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "stopfailure.log"), "utf8"), /rate_limit .*"error_type":"rate_limit"/);
  assert.equal(failureType({ error: { type: "overloaded" } }), "overloaded");
  assert.equal(failureType({ error: "server_error" }), "server_error");
  assert.equal(failureType({}), "unknown");
});

test("the Stop hook removes its verifying marker when it is done", () => {
  const root = project();
  const r = run("stop-gate.js", root, { hook_event_name: "Stop", stop_hook_active: false });
  assert.equal(r.status, 0);
  const out = JSON.parse(r.stdout);
  assert.equal(out.decision, "block", "no ready marker: the gate nudges");
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "gate.json")), false);
});
