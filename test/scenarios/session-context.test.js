// Scenario: feed the SessionStart hook fake stdin the way Claude Code would.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const script = fileURLToPath(new URL("../../plugins/autoclaude/scripts/session-context.js", import.meta.url));

function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-ctx-"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1 }));
  fs.writeFileSync(path.join(root, "PLAN.md"), "# Demo plan\n\n## Phase 1: One\n- [x] **S1.1** Done already\n  - Accept: a\n- [ ] **S1.2** Build the thing\n  - Accept: /thing shows a list\n  - Accept: the list has 3 items\n  - Tags: ui\n- [ ] **S1.3** Later\n  - Accept: c\n");
  fs.writeFileSync(path.join(root, "PROGRESS.md"), "# Progress\n\n" + Array.from({ length: 14 }, (_, i) => `- line ${i + 1}`).join("\n") + "\n");
  return root;
}

function runHook(cwd, extraEnv = {}, configDir) {
  const env = { ...process.env, ...extraEnv };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete env[k];
  Object.assign(env, extraEnv);
  env.CLAUDE_CONFIG_DIR = configDir || fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-ctx-cfg-"));
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ session_id: "sess-1", cwd, source: "startup", hook_event_name: "SessionStart" }), encoding: "utf8", env });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, configDir: env.CLAUDE_CONFIG_DIR };
}

test("no run active: the hook prints nothing and exits 0", () => {
  const root = project();
  const r = runHook(root);
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
  assert.equal(r.stderr, "");
});

test("outside any project: silent", () => {
  const r = runHook(fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-ctx-none-")));
  assert.equal(r.code, 0);
  assert.equal(r.stdout, "");
});

test("run active: injects the rules, the current step, the progress tail and pending notes", () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.2", attempts: { "S1.2": 1 }, pendingNotes: [{ at: "2026-09-27T01:00:00Z", text: "Use the existing table" }] });
  const r = runHook(root);
  assert.equal(r.code, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  const ctx = out.hookSpecificOutput.additionalContext;
  assert.equal(out.hookSpecificOutput.hookEventName, "SessionStart");
  assert.match(ctx, /AutoClaude run in progress/);
  assert.match(ctx, /(autoclaude|autoclaude\.js") ready S1\.2/);
  assert.match(ctx, /## Current step: S1\.2 Build the thing \(attempt 2 of 3\)/);
  assert.match(ctx, /Accept: the list has 3 items/);
  assert.doesNotMatch(ctx, /S1\.3/);
  assert.match(ctx, /## Recent progress \(last 10 lines of PROGRESS\.md\)/);
  assert.match(ctx, /- line 14/);
  assert.doesNotMatch(ctx, /- line 4\n/);
  assert.match(ctx, /## Owner review notes: act on these first\n\n- \(2026-09-27T01:00:00Z\) Use the existing table/);
  assert.match(ctx, /docs\/DECISIONS\.md as N-###/);
  const state = JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state.json"), "utf8"));
  assert.equal(state.sessionId, "sess-1");
  assert.equal(state.pendingNotes[0].delivered, true, "a note injected here counts as delivered, so the gate clears it when the step passes");
  const again = JSON.parse(runHook(root).stdout).hookSpecificOutput.additionalContext;
  assert.match(again, /Use the existing table/, "still injected after a compaction until the step passes");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "hooks.log"), "utf8"), /SessionStart startup injected/);
});

test("an owner answer to a blocked question is injected first, with its decision id", () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.2", ownerAnswer: { step: "S1.2", question: "Cookies or localStorage?", answer: "Cookies, httpOnly", at: "2026-09-27T04:00:00.000Z", decisionId: "D-008" } });
  const ctx = JSON.parse(runHook(root).stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /## Owner answer: act on this first\n\nYou stopped S1\.2 with this question:\n> Cookies or localStorage\?\n\nThe owner answered \(2026-09-27T04:00:00\.000Z\):\n> Cookies, httpOnly\n\nIt is recorded in docs\/DECISIONS\.md as D-008/);
  assert.match(ctx, /autoclaude:decider/, "the rules name the decider agent");
  assert.match(ctx, /## D-### \(\d{4}-\d\d-\d\d, S1\.2\)/, "the decision entry format carries today's date and the step");
});

test("the hook mirrors plugin notify options into the per-machine file, even with no run", () => {
  const root = project();
  const r = runHook(root, { CLAUDE_PLUGIN_OPTION_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/9/xyz", CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "discord" });
  assert.equal(r.code, 0);
  const file = path.join(r.configDir, "autoclaude", "notify.json");
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { discord_webhook: "https://discord.com/api/webhooks/9/xyz", channel: "discord" });
});

test("the mirror only fills keys notify.json lacks: a value set with notify-setup is never overwritten", () => {
  const root = project();
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-ctx-cfg-"));
  const file = path.join(configDir, "autoclaude", "notify.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ channel: "ntfy", ntfy_url: "https://ntfy.example/set-by-owner", discord_webhook: "" }));
  const r = runHook(root, { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "discord", CLAUDE_PLUGIN_OPTION_NTFY_URL: "https://ntfy.example/from-userconfig", CLAUDE_PLUGIN_OPTION_DISCORD_WEBHOOK: "https://discord.com/api/webhooks/9/xyz" }, configDir);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), { channel: "ntfy", ntfy_url: "https://ntfy.example/set-by-owner", discord_webhook: "https://discord.com/api/webhooks/9/xyz" }, "an empty value counts as missing");
  const before = fs.readFileSync(file, "utf8");
  runHook(root, { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "stdout" }, configDir);
  assert.equal(fs.readFileSync(file, "utf8"), before, "nothing missing: the file is not rewritten");
});

test("under a live supervisor, a session without AUTOCLAUDE_BUILDER gets nothing and is not recorded as the run's session", () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.2" });
  fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(process.pid));
  const other = runHook(root, { AUTOCLAUDE_BUILDER: "" });
  assert.equal(other.stdout, "");
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state.json"), "utf8")).sessionId, null);
  const builder = runHook(root, { AUTOCLAUDE_BUILDER: "1" });
  assert.match(JSON.parse(builder.stdout).hookSpecificOutput.additionalContext, /AutoClaude run in progress/);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "state.json"), "utf8")).sessionId, "sess-1");
});
