import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCli } from "../../plugins/autoclaude/lib/cli.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";

class Sink { constructor() { this.text = ""; } write(s) { this.text += s; return true; } }

const PLAN = `# Demo plan

## Phase 1: One
- [ ] **S1.1** First
  - Accept: a
- [ ] **S1.2** Second
  - Accept: b
`;

function project({ plan = PLAN, config = { version: 1 } } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cli-"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify(config));
  fs.writeFileSync(path.join(root, "PLAN.md"), plan);
  return root;
}

// Every CLI test runs against its own empty Claude config dir, so nothing on the developer's
// machine (usage data, the notify.json channel file, the registry) leaks into a test or gets
// written by one, and a test can never send a real notification.
async function run(argv, cwd, extra = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = extra.configDir || fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  try {
    const code = await runCli(argv, { cwd, stdout, stderr, env: { PATH: "", ...extra.env }, ...extra });
    return { code, out: stdout.text, err: stderr.text };
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

test("status: not initialized, then initialized with plan progress", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cli-empty-"));
  let r = await run(["status"], empty);
  assert.equal(r.code, 1);
  assert.match(r.out, /not initialized/);

  const root = project();
  r = await run(["status"], root);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /autoclaude: idle/);
  assert.match(r.out, /plan: PLAN\.md, 0\/2 steps verified/);
  assert.match(r.out, /next step: S1\.1 First/);
  assert.match(r.out, /last progress: never/);
  assert.match(r.out, /usage:/);
});

test("status reports config problems instead of running", async () => {
  const root = project({ config: { version: 1, review: { pauseAt: "later" } } });
  const r = await run(["status"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /review\.pauseAt: expected one of/);
});

test("pause, note and resume move the state correctly", async () => {
  const root = project();
  let r = await run(["pause"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing to pause/);

  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1" });
  r = await run(["pause"], root);
  assert.equal(r.code, 0);
  assert.equal(loadState(root).pauseRequested, true);
  assert.match(r.out, /pause requested/);

  r = await run(["resume"], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /withdrawn/);
  assert.equal(loadState(root).pauseRequested, false);

  r = await run(["pause", "--now"], root);
  assert.equal(r.code, 0);
  let s = loadState(root);
  assert.equal(s.status, "paused");
  assert.equal(s.pauseReason, "review");

  r = await run(["note", "Use", "the", "existing", "table"], root, { now: () => new Date("2026-09-27T01:02:03Z") });
  assert.equal(r.code, 0);
  s = loadState(root);
  assert.deepEqual(s.pendingNotes, [{ at: "2026-09-27T01:02:03.000Z", text: "Use the existing table" }]);
  const notes = fs.readFileSync(path.join(root, "docs", "REVIEW_NOTES.md"), "utf8");
  assert.match(notes, /^# Review notes/);
  assert.match(notes, /## 2026-09-27T01:02:03\.000Z\n\nUse the existing table\n/);

  r = await run(["status"], root);
  assert.match(r.out, /paused \(review\)/);
  assert.match(r.out, /review notes waiting: 1/);

  r = await run(["resume"], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /resumed on S1\.1 with 1 review note/);
  assert.equal(loadState(root).status, "running");
});

test("answer: records the owner's answer as the next D-###, resets [?], resumes, and hands the answer to Claude", async () => {
  const root = project({ plan: PLAN.replace("- [ ] **S1.1**", "- [?] **S1.1**") });
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), "# DECISIONS\n\n## D-007 (2026-09-26, S0.1) older\n");
  let r = await run(["answer", "use cookies"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /nothing is waiting for an answer/);

  saveState(root, { ...defaultState(), status: "paused", pauseReason: "blocked", currentStep: "S1.1", lastBlockedQuestion: "Cookies or localStorage?", attempts: { "S1.1": 2 } });
  r = await run(["answer", "Use", "cookies,", "httpOnly"], root, { now: () => new Date("2026-09-27T04:00:00Z") });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /recorded in docs\/DECISIONS\.md as D-008/);
  const decisions = fs.readFileSync(path.join(root, "docs", "DECISIONS.md"), "utf8");
  assert.match(decisions, /## D-008 \(2026-09-27, S1\.1\) Owner answer to a blocked question\n\n- Question: Cookies or localStorage\?\n- Answer: Use cookies, httpOnly\n/);
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.currentStep, s.attempts["S1.1"], s.lastBlockedQuestion], ["running", null, "S1.1", 0, null]);
  assert.deepEqual({ ...s.ownerAnswer }, { step: "S1.1", question: "Cookies or localStorage?", answer: "Use cookies, httpOnly", at: "2026-09-27T04:00:00.000Z", decisionId: "D-008" });
  assert.match(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), /- \[ \] \*\*S1\.1\*\*/);
});

test("resume re-baselines on the plan the owner left (D33): failed steps get fresh attempts, owner ticks count", async () => {
  const root = project({ plan: PLAN.replace("- [ ] **S1.1**", "- [!] **S1.1**") });
  saveState(root, { ...defaultState(), status: "paused", pauseReason: "step-failed", currentStep: "S1.1", attempts: { "S1.1": 3 }, tickedByGate: [] });
  let r = await run(["resume"], root);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /S1\.1: \[!\] reset to \[ \] with fresh attempts/);
  let s = loadState(root);
  assert.deepEqual([s.status, s.currentStep, s.attempts["S1.1"]], ["running", "S1.1", 0]);

  // Owner pauses, ticks S1.1 by hand ("skip it") and resumes: accepted, the run moves to S1.2.
  saveState(root, { ...s, status: "paused", pauseReason: "review" });
  const planFile = path.join(root, "PLAN.md");
  fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  r = await run(["resume"], root);
  assert.match(r.out, /S1\.1: ticked by the owner, accepted as done/);
  assert.match(r.out, /current step is now S1\.2/);
  s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate], ["S1.2", ["S1.1"]]);

  // Owner unticks S1.1 again to have it redone.
  saveState(root, { ...s, status: "paused", pauseReason: "review" });
  fs.writeFileSync(planFile, fs.readFileSync(planFile, "utf8").replace("- [x] **S1.1**", "- [ ] **S1.1**"));
  r = await run(["resume"], root);
  assert.match(r.out, /S1\.1: unticked by the owner, will be done again/);
  assert.match(r.out, /current step is now S1\.1/);
  s = loadState(root);
  assert.deepEqual([s.currentStep, s.tickedByGate], ["S1.1", []], "the run goes back to the first unfinished step");
});

test("run refuses before opening any window: complete plan, a live supervisor, a failing preflight", async () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "complete" });
  let r = await run(["run"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /the plan is complete/);
  saveState(root, { ...defaultState(), status: "idle" });
  fs.writeFileSync(path.join(root, ".autoclaude", "supervisor.pid"), String(process.pid));
  r = await run(["run"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /already has a supervisor \(pid \d+/);
  fs.unlinkSync(path.join(root, ".autoclaude", "supervisor.pid"));
  r = await run(["run"], root);
  assert.equal(r.code, 1);
  // The test environment has no PATH, so git itself is missing; with git it would say "not a git repository".
  assert.match(r.out, /FAIL git: (not a git repository|`git` is not on PATH)/);
  assert.match(r.out, /FAIL trust: Claude Code has not been opened here yet/);
  assert.match(r.out, /not starting; fix the FAIL lines above/);
});

test("resume refuses when the plan fails lint", async () => {
  const root = project({ plan: "# X\n\n## Phase 1: A\n- [ ] **S1.1** no accept\n" });
  saveState(root, { ...defaultState(), status: "paused", pauseReason: "review" });
  const r = await run(["resume"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /not resuming/);
  assert.match(r.out, /no `- Accept:` line/);
  assert.equal(loadState(root).status, "paused");
});

test("lint-plan reports ok and problems, for the project plan and for a given file", async () => {
  const root = project();
  let r = await run(["lint-plan"], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /ok: 2 steps in 1 phases/);
  fs.writeFileSync(path.join(root, "bad.md"), "# B\n\n## Phase 1: A\n- [ ] **S1.1** a\n  - Accept: x\n- [ ] **S1.1** dup\n  - Accept: y\n");
  r = await run(["lint-plan", "bad.md"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /duplicate step id S1\.1/);
});

test("install-cli writes a shim into the given bin dir", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-bin-"));
  const r = await run(["install-cli", "--no-path"], dir, { env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  assert.equal(r.code, 0, r.out + r.err);
  const sh = path.join(dir, "autoclaude");
  assert.ok(fs.existsSync(sh), "the extensionless sh shim exists on every OS");
  // The shims run the launcher, which finds the current plugin install each time (D42).
  assert.match(fs.readFileSync(sh, "utf8"), /^#!\/bin\/sh\nexec ".*node(\.exe)?" ".*autoclaude-launch\.mjs" "\$@"\n$/);
  assert.ok(fs.existsSync(path.join(dir, "autoclaude-launch.mjs")), "the launcher sits next to the shims");
  if (process.platform === "win32") {
    const cmd = path.join(dir, "autoclaude.cmd");
    assert.ok(fs.existsSync(cmd));
    assert.match(fs.readFileSync(cmd, "utf8"), /autoclaude-launch\.mjs/);
  }
  assert.match(r.out, /add .* to your PATH/);
});

test("notify-test with no channel prints to stdout and reports it", async () => {
  const r = await run(["notify-test", "hello"], os.tmpdir(), { env: { PATH: "" } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\[autoclaude default\] AutoClaude test\nhello/);
  assert.match(r.out, /no channel is configured/);
});

test("notify-setup stores the channel per machine, masks the webhook, validates input and clears", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  let r = await run(["notify-setup", "--discord", "https://discord.com/api/webhooks/123/abcdefghijklmnop", "--channel", "discord"], os.tmpdir(), { configDir });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /channel: discord\n/);
  assert.match(r.out, /discord_webhook: https:\/\/disc\.\.\.mnop/);
  assert.doesNotMatch(r.out, /abcdefghijklmnop/);
  const stored = JSON.parse(fs.readFileSync(path.join(configDir, "autoclaude", "notify.json"), "utf8"));
  assert.equal(stored.discord_webhook, "https://discord.com/api/webhooks/123/abcdefghijklmnop");

  r = await run(["notify-setup", "--show"], os.tmpdir(), { configDir });
  assert.match(r.out, /channel: discord/);

  r = await run(["notify-setup", "--discord", "https://example.com/not-a-webhook"], os.tmpdir(), { configDir });
  assert.equal(r.code, 1);
  assert.match(r.err, /Discord webhook URL/);

  r = await run(["notify-setup", "--clear"], os.tmpdir(), { configDir });
  assert.equal(r.code, 0);
  assert.match(r.out, /channel: stdout \(auto\)/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, "autoclaude", "notify.json"), "utf8")), {});
});

test("help and unknown commands", async () => {
  let r = await run(["help"], os.tmpdir());
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: autoclaude/);
  r = await run(["bogus"], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command/);
});
