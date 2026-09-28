// Scenario: the plugin installed under a folder whose name has a space and a tilde. The hook
// scripts decide whether they are the entry script by comparing paths; with a URL pathname
// (%20, %7E) that comparison failed and the tool guard silently did nothing. Printed paths (the
// CLI command in hook messages) must come out decoded too.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const pluginSrc = fileURLToPath(new URL("../../plugins/autoclaude", import.meta.url));

function copyPlugin() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "ac plugin ~"));
  const dest = path.join(parent, "auto claude~1");
  fs.cpSync(pluginSrc, dest, { recursive: true });
  return dest;
}

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-space-proj-"));
  // Pushing is on by default since 0.10.0; off here so a plain push is something the guard denies.
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, git: { push: false } }));
  fs.writeFileSync(path.join(root, "PLAN.md"), "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** One\n  - Accept: a\n");
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1" });
  return root;
}

// No autoclaude shim on PATH, so hook messages name the plugin's own bin/autoclaude.js.
function hookEnv() {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-space-cfg-")) };
  for (const k of Object.keys(env)) if (/^path$/i.test(k) || k === "AUTOCLAUDE_ROLE" || k === "AUTOCLAUDE_BUILDER") delete env[k];
  env.PATH = path.dirname(process.execPath);
  return env;
}

test("the tool guard runs from a plugin path with a space and a tilde", () => {
  const plugin = copyPlugin();
  assert.match(plugin, / .*~/);
  const root = project();
  const input = { session_id: "s", cwd: root, hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } };
  const r = spawnSync(process.execPath, [path.join(plugin, "scripts", "tool-guard.js")], { input: JSON.stringify(input), encoding: "utf8", env: hookEnv() });
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.equal(out.hookSpecificOutput.permissionDecision, "deny");
  assert.match(out.hookSpecificOutput.permissionDecisionReason, /Pushing is off/);
});

test("hook messages print the plugin's CLI path decoded, not URL-encoded", () => {
  const plugin = copyPlugin();
  const root = project();
  const input = { session_id: "s", cwd: root, hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "mkdir x" } };
  const r = spawnSync(process.execPath, [path.join(plugin, "scripts", "permission-deny.js")], { input: JSON.stringify(input), encoding: "utf8", env: hookEnv() });
  assert.equal(r.status, 0, r.stderr);
  const message = JSON.parse(r.stdout).hookSpecificOutput.decision.message;
  assert.match(message, /node "[^"]*ac plugin ~[^"]*\/auto claude~1\/bin\/autoclaude\.js" blocked <step>/);
  assert.doesNotMatch(message, /%20|%7E/i);
});
