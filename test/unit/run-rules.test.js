// The run rules as the builder receives them: prompts/context.md through the SessionStart hook.
// P8.2 to P8.4 rest on sentences in those rules, so an edit that drops or reverses one fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

const script = fileURLToPath(new URL("../../plugins/autoclaude/scripts/session-context.js", import.meta.url));

// A project with a running state, fed to the real hook with a throwaway Claude config folder.
function injectedRules(config = { version: 1 }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-rules-"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, "PLAN.md"), "# Rules plan\n\n## Phase 1: One\n- [ ] **S1.1** First\n  - Accept: a\n- [ ] **S1.2** Second\n  - Accept: b\n");
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1" });
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-rules-cfg-")) };
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_") || k === "AUTOCLAUDE_ROLE") delete env[k];
  const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ session_id: "sess-rules", cwd: root, source: "startup", hook_event_name: "SessionStart" }), encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout).hookSpecificOutput.additionalContext;
}

let defaults = null;
const rules = () => (defaults ??= injectedRules());

test("P8.2: the builder runs only the tests for what it changed; the full suite is the gate's", () => {
  const ctx = rules();
  assert.match(ctx, /Test what you changed: write real tests for the step's Accept lines and run only the tests that cover the code you touched/);
  assert.match(ctx, /Never run the full suite or the whole check list yourself; the gate runs every check once per feature\./);
});

test("P8.3: CONTINUE_HERE is rewritten before every ready; the other doc duties once per feature", () => {
  const ctx = rules();
  assert.match(ctx, /When the step's Accept lines hold, rewrite `CONTINUE_HERE\.md` \([^)]*a fresh session must be able to pick up from it alone\) and run with the Bash tool:\n {3}`[^`\n]*ready S1\.1`/);
  assert.match(ctx, /The step that closes the feature[^\n]*: before `ready`, do the project's other doc duties from its `CLAUDE\.md` \(session log, deferred work, facts worth keeping\) once for the whole feature\./);
  assert.match(ctx, /Log each decision in `docs\/DECISIONS\.md` when you make it \(below\)\. Other paperwork waits for the step that closes the feature\./);
  // The file names come from the project's config.
  const custom = injectedRules({ version: 1, docs: { continueHere: "docs/RESUME.md", decisions: "docs/CHOICES.md" } });
  assert.match(custom, /rewrite `docs\/RESUME\.md`/);
  assert.match(custom, /Log each decision in `docs\/CHOICES\.md`/);
  assert.doesNotMatch(custom, /CONTINUE_HERE\.md|\{\{/);
});

test("P8.4: every D-### says who decided, and a choice that accepts a security risk is marked for owner review", () => {
  const ctx = rules();
  const rule = (ctx.match(/^3\. \*\*routine\*\*[^]*?(?=^4\. \*\*critical\*\*)/m) || [])[0];
  assert.ok(rule, "the routine-decision rule is injected");
  assert.match(rule, /`## D-### \(\d{4}-\d\d-\d\d, S1\.1\) <short title>`/);
  assert.match(rule, /`- By: decider` \(`- By: builder` when you settled a choice between real alternatives from the plan yourself\)/);
  assert.match(rule, /When `owner_review` is true, or the choice accepts a security risk \([^)]*\), add `- Owner review: yes`/);
  assert.match(rule, /The number is one above the highest D-### already in the file\./);
});

test("P8.4: autoclaude decide runs in the foreground with the Bash tool's longest timeout", () => {
  const ctx = rules();
  const rule = ctx.split("\n").find((l) => l.includes("It runs the `autoclaude:decider` agent"));
  assert.ok(rule, "the decide rule is injected");
  assert.match(ctx, /Otherwise run, with the Bash tool and in the foreground:\n {3}`[^`\n]*decide "<the question/);
  assert.match(rule, /give that Bash call the tool's longest timeout \(600000 ms\)/);
  assert.match(rule, /Never run it in the background and never end your turn to wait for an answer\./);
});

// The run-start record can wait up to 4 minutes for a Docker engine that Resource Saver stopped
// (footprint.js ENGINE_WAIT_MS), longer than the Bash tool's default 2 minutes.
test("the start skill gives `autoclaude start` the Bash tool's longest timeout", () => {
  const skill = fs.readFileSync(fileURLToPath(new URL("../../plugins/autoclaude/skills/start/SKILL.md", import.meta.url)), "utf8");
  const step = skill.split(/\n(?=\d+\. )/).find((s) => s.includes("autoclaude.js\" start"));
  assert.ok(step, "step 1 runs autoclaude start");
  assert.match(step, /in the foreground and with the tool's longest timeout \(600000 ms\)/);
});
