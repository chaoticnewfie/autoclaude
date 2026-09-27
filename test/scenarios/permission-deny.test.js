// Scenario: the PermissionRequest hook fed the input Claude Code sends (shape from VERIFY.md P0.6).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const script = fileURLToPath(new URL("../../plugins/autoclaude/scripts/permission-deny.js", import.meta.url));

function project(status) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-perm-"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1 }));
  if (status) saveState(root, { ...defaultState(), status, currentStep: "S1.1" });
  return root;
}

function run(root, extraEnv = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-perm-cfg-")), ...extraEnv };
  delete env.AUTOCLAUDE_ROLE;
  Object.assign(env, extraEnv);
  const input = { session_id: "s", cwd: root, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "mkdir x", description: "Create a dir" }, permission_mode: "default" };
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify(input), encoding: "utf8", env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

test("while a run is active every permission prompt is denied with guidance and logged", () => {
  const root = project("running");
  const r = run(root);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.hookEventName, "PermissionRequest");
  assert.equal(out.hookSpecificOutput.decision.behavior, "deny");
  assert.match(out.hookSpecificOutput.decision.message, /No human is available to approve Bash.*blocked <step>/s);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "denials.log"), "utf8"), /permission Bash .*mkdir x/);
});

test("the 11th denial in an hour notifies without corrupting the hook's JSON answer", () => {
  const root = project("running");
  let last;
  for (let i = 0; i < 11; i++) last = run(root);
  const out = JSON.parse(last.stdout);
  assert.equal(out.hookSpecificOutput.decision.behavior, "deny", "stdout is exactly one JSON object");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "notify.log"), "utf8"), /\[high\] stdout AutoClaude: 11 denials in the last hour/);
});

test("no run, a paused run, or a nested checker: silent, so the normal prompt appears", () => {
  for (const [root, env] of [[project(null), {}], [project("paused"), {}], [project("running"), { AUTOCLAUDE_ROLE: "tester" }]]) {
    const r = run(root, env);
    assert.equal(r.code, 0);
    assert.equal(r.stdout, "");
  }
});
