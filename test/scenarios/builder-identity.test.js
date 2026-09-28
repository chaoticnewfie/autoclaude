// Scenario: a person opens their own Claude Code session in a project while a supervised run is
// going. Every hook must leave that session alone (no rules injected, no gate, no guard, no
// heartbeats, no idle or failure markers, no denials), and still act for the builder, whose
// environment carries AUTOCLAUDE_BUILDER=1, and for a run started by hand with no supervisor.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveState, loadState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const script = (name) => fileURLToPath(new URL(`../../plugins/autoclaude/scripts/${name}`, import.meta.url));

// supervisor: "live" records this test process as the supervisor (alive for the whole test),
// "none" records nothing.
function project(supervisor) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-who-"));
  // Pushing is on by default since 0.10.0; off here so a plain push is something the guard denies.
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, git: { push: false } }));
  fs.writeFileSync(path.join(root, "PLAN.md"), "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** One\n  - Accept: a\n");
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1" });
  if (supervisor === "live") fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(process.pid));
  return root;
}

function run(name, root, input, { builder = false } = {}) {
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-who-cfg-")) };
  for (const k of Object.keys(env)) if (k === "AUTOCLAUDE_ROLE" || k === "AUTOCLAUDE_BUILDER" || k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete env[k];
  if (builder) env.AUTOCLAUDE_BUILDER = "1";
  const r = spawnSync(process.execPath, [script(name)], { input: JSON.stringify({ cwd: root, session_id: "sess-other", ...input }), encoding: "utf8", env, timeout: 60000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const exists = (root, ...parts) => fs.existsSync(path.join(root, ".autoclaude", ...parts));

// Each hook: the input it gets, and a check that says whether it acted.
const HOOKS = [
  {
    name: "session-context.js",
    input: { hook_event_name: "SessionStart", source: "startup" },
    acted: (root, r) => r.stdout.includes("additionalContext") && loadState(root).sessionId === "sess-other"
  },
  {
    name: "stop-gate.js",
    input: { hook_event_name: "Stop", stop_hook_active: false },
    acted: (root, r) => r.stdout.includes("\"decision\":\"block\"") && loadState(root).toolCallsAtLastGate !== undefined
  },
  {
    name: "tool-guard.js",
    input: { hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push" } },
    acted: (root, r) => r.stdout.includes("\"permissionDecision\":\"deny\"") && exists(root, "logs", "denials.log")
  },
  {
    name: "permission-deny.js",
    input: { hook_event_name: "PermissionRequest", tool_name: "Bash", tool_input: { command: "mkdir x" } },
    acted: (root, r) => r.stdout.includes("\"behavior\":\"deny\"") && exists(root, "logs", "denials.log")
  },
  {
    name: "heartbeat.js",
    input: { hook_event_name: "PostToolUse", tool_name: "Bash", tool_input: { command: "ls" } },
    acted: (root) => exists(root, "heartbeat")
  },
  {
    name: "notify-idle.js",
    input: { hook_event_name: "Notification", notification_type: "idle_prompt", message: "waiting" },
    acted: (root) => exists(root, "idle")
  },
  {
    name: "stop-failure.js",
    input: { hook_event_name: "StopFailure", error_type: "server_error" },
    acted: (root) => exists(root, "failure.json")
  }
];

test("a person's own session during a supervised run: every hook stays silent and writes nothing", () => {
  for (const h of HOOKS) {
    const root = project("live");
    const before = fs.readFileSync(path.join(root, ".autoclaude", "state.json"), "utf8");
    const r = run(h.name, root, h.input);
    assert.equal(r.code, 0, `${h.name}: ${r.stderr}`);
    assert.equal(r.stdout, "", `${h.name} printed for someone else's session`);
    assert.equal(h.acted(root, r), false, `${h.name} acted for someone else's session`);
    assert.equal(fs.readFileSync(path.join(root, ".autoclaude", "state.json"), "utf8"), before, `${h.name} changed state.json`);
    for (const f of ["heartbeat", "idle", "failure.json", "gate.json", path.join("logs", "denials.log"), path.join("logs", "hooks.log")]) {
      assert.equal(exists(root, f), false, `${h.name} wrote ${f}`);
    }
  }
});

test("the builder (AUTOCLAUDE_BUILDER=1) under a live supervisor: every hook acts", () => {
  for (const h of HOOKS) {
    const root = project("live");
    const r = run(h.name, root, h.input, { builder: true });
    assert.equal(r.code, 0, `${h.name}: ${r.stderr}`);
    assert.equal(h.acted(root, r), true, `${h.name} did nothing for the builder: ${r.stdout} ${r.stderr}`);
  }
});

test("a run started by hand with no supervisor recorded: every hook acts, as before", () => {
  for (const h of HOOKS) {
    const root = project("none");
    const r = run(h.name, root, h.input);
    assert.equal(r.code, 0, `${h.name}: ${r.stderr}`);
    assert.equal(h.acted(root, r), true, `${h.name} did nothing for a hand-started run: ${r.stdout} ${r.stderr}`);
  }
});

test("a supervisor.pid left by a supervisor that has exited does not hide the session", () => {
  const root = project("none");
  const dead = spawnSync(process.execPath, ["-e", ""]).pid;
  fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(dead));
  const r = run("tool-guard.js", root, HOOKS[2].input);
  assert.match(r.stdout, /"permissionDecision":"deny"/);
});
