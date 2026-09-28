import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { runCli, nextDecisionId, outsideFences, maskNtfyUrl, COMMANDS, commandHelp } from "../../plugins/autoclaude/lib/cli.js";
import { loadState, saveState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { trustKeyFor } from "../../plugins/autoclaude/lib/paths.js";

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
  assert.equal(s.haltSession, false, "no supervisor is alive, so nobody would act on a halt request");
  assert.match(r.out, /No supervisor is running for this project, so nothing ends the builder session: .*stop it by hand/);
  assert.match(r.out, /On `autoclaude resume`, S1\.1 starts again with fresh attempts/);
  assert.doesNotMatch(r.out, /stays open with its attempts/);

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
  assert.match(decisions, /\n\n## D-008 \(2026-09-27, S1\.1\) Owner answer to a blocked question\n- Question: Cookies or localStorage\?\n- Answer: Use cookies, httpOnly\n- By: owner, with `autoclaude answer`\n$/);
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
  const root = project({ plan: PLAN.replace(/- \[ \]/g, "- [x]") });
  saveState(root, { ...defaultState(), status: "complete" });
  let r = await run(["run"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /the plan is complete; every step in PLAN\.md is verified\. To continue, add steps to PLAN\.md, commit them, then `autoclaude run`/);
  assert.doesNotMatch(r.out, /preflight/);
  r = await run(["resume"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /add steps to PLAN\.md, commit them, then `autoclaude run`/);

  // A complete run whose plan has a new step gets the fresh-run preflight; failing it changes nothing.
  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  r = await run(["run"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL git: /);
  assert.equal(loadState(root).status, "complete", "only a passing preflight turns the finished run into a fresh one");
  r = await run(["resume"], root);
  assert.equal(r.code, 1);
  assert.match(r.out, /the last run finished, and PLAN\.md has new steps\. Commit them, then `autoclaude run` starts a fresh run/);

  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN);
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

test("uninstall removes the watchdog, the status line bridge, the shims and the PATH entry; --purge the machine settings", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-bin-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  await run(["install-cli", "--no-path"], dir, { configDir, env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  assert.ok(fs.existsSync(path.join(dir, "autoclaude-launch.mjs")));
  const machine = path.join(configDir, "autoclaude");
  fs.mkdirSync(machine, { recursive: true });
  fs.writeFileSync(path.join(machine, "notify.json"), "{}");
  const calls = [];
  const deps = {
    uninstallWatchdog: () => { calls.push("watchdog"); return { ok: true, stderr: "", wasInstalled: true }; },
    uninstallStatusline: () => { calls.push("statusline"); return { removed: true, restored: { command: "old" } }; },
    removeFromUserPath: (d) => { calls.push(`path ${d}`); return `removed ${d} from your user PATH`; },
    // The .cmd shim may be the running command, so on Windows it is deleted after exit.
    deleteLater: (file) => { calls.push(`later ${path.basename(file)}`); fs.rmSync(file, { force: true }); }
  };
  let r = await run(["uninstall"], dir, { configDir, deps: { ...deps, isWindows: true }, env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(calls, ["watchdog", "statusline", ...(process.platform === "win32" ? ["later autoclaude.cmd"] : []), `path ${dir}`]);
  assert.match(r.out, /watchdog: removed/);
  assert.match(r.out, /status line bridge: removed; your previous status line is back/);
  assert.match(r.out, new RegExp(`command shims: removed ${process.platform === "win32" ? 4 : 3} file\\(s\\)`));
  assert.equal(fs.existsSync(path.join(dir, "autoclaude")), false);
  assert.match(r.out, /machine settings: kept in/);
  assert.ok(fs.existsSync(path.join(machine, "notify.json")), "kept without --purge");
  assert.match(r.out, /claude plugin uninstall autoclaude@autoclaude/);

  assert.ok(machine.startsWith(os.tmpdir()), "the purge below only ever touches a temp folder");
  r = await run(["uninstall", "--purge"], dir, { configDir, deps: { ...deps, isWindows: true, uninstallWatchdog: () => ({ ok: false, stderr: "Access is denied." }) }, env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  assert.equal(r.code, 1, "a step that failed is reported");
  assert.match(r.out, /watchdog: could not remove it: Access is denied\./);
  assert.match(r.out, /command shims: none found/);
  assert.equal(fs.existsSync(machine), false);
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
  let r = await run(["notify-setup", "--discord", "https://discord.com/api/webhooks/123/abcdefghijklmnop"], os.tmpdir(), { configDir });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /channel: discord\n/);
  assert.match(r.out, /discord_webhook: https:\/\/disc\.\.\.mnop/);
  assert.doesNotMatch(r.out, /abcdefghijklmnop/);
  const stored = JSON.parse(fs.readFileSync(path.join(configDir, "autoclaude", "notify.json"), "utf8"));
  assert.equal(stored.discord_webhook, "https://discord.com/api/webhooks/123/abcdefghijklmnop");
  assert.equal(stored.channel, "discord", "--discord without --channel picks the discord channel");
  assert.doesNotMatch(r.out, /\(auto\)/);

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
  assert.match(r.out, /run \[--check\]/);
  assert.match(r.out, /\n  checks /);
  assert.match(r.out, /guard-test "<command>"/);
  assert.match(r.out, /init \[<folder>\]/);
  r = await run(["bogus"], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command/);
});

test("notify-setup: a URL picks its channel (the last one wins), --channel always wins, and --show masks the ntfy topic", async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  const file = path.join(configDir, "autoclaude", "notify.json");
  const stored = () => JSON.parse(fs.readFileSync(file, "utf8"));
  const NTFY = "https://ntfy.sh/secret-topic-xyz";
  const HOOK = "https://discord.com/api/webhooks/123/abcdefghijklmnop";
  let r = await run(["notify-setup", "--ntfy", NTFY], os.tmpdir(), { configDir });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(stored().channel, "ntfy");
  assert.match(r.out, /channel: ntfy\n/);
  assert.match(r.out, /ntfy_url: https:\/\/ntfy\.sh\/sec\.\.\.\n/);
  assert.doesNotMatch(r.out, /secret-topic/);

  // Adding a webhook later switches to Discord, although auto would still prefer ntfy.
  r = await run(["notify-setup", "--discord", HOOK], os.tmpdir(), { configDir });
  assert.deepEqual([stored().channel, stored().ntfy_url], ["discord", NTFY]);
  assert.match(r.out, /channel: discord\n/);

  r = await run(["notify-setup", "--discord", HOOK, "--ntfy", NTFY], os.tmpdir(), { configDir });
  assert.equal(stored().channel, "ntfy", "the last URL given wins");
  r = await run(["notify-setup", "--ntfy", NTFY, "--discord", HOOK], os.tmpdir(), { configDir });
  assert.equal(stored().channel, "discord");
  r = await run(["notify-setup", "--channel", "stdout", "--ntfy", NTFY], os.tmpdir(), { configDir });
  assert.equal(stored().channel, "stdout", "an explicit --channel always wins");
  assert.match(r.out, /channel: stdout\n/);
  assert.match(r.out, /stdout is chosen/);
  r = await run(["notify-setup", "--ntfy-token", "tk_live_123"], os.tmpdir(), { configDir });
  assert.equal(stored().channel, "stdout", "a token alone leaves the channel alone");

  r = await run(["notify-setup", "--show"], os.tmpdir(), { configDir });
  assert.equal(r.code, 0);
  assert.doesNotMatch(r.out, /secret-topic|abcdefghijklmnop|tk_live_123/);
  assert.match(r.out, /ntfy_token: \(set\)/);

  assert.equal(maskNtfyUrl("http://10.0.0.5:8080/ab"), "http://10.0.0.5:8080/ab...");
  assert.equal(maskNtfyUrl(""), "(not set)");
});

test("decision ids skip fenced code blocks: the template's example is not an entry", () => {
  const tpl = "# DECISIONS\n\n```markdown\n## D-001 (YYYY-MM-DD, S1.2) Example\n```\n\n## Entries\n";
  assert.equal(nextDecisionId(tpl), "D-001");
  assert.equal(nextDecisionId(tpl + "\n## D-004 (2026-09-27, S1.1) real\n"), "D-005");
  assert.equal(nextDecisionId("~~~\n```\nD-009\n```\n~~~\n## D-002 x\n"), "D-003", "a ``` line inside a ~~~ fence does not close it");
  assert.equal(outsideFences("a\n````md\n```\nD-1\n````\nb"), "a\nb");
  assert.equal(nextDecisionId(""), "D-001");
});

test("answer: the first real answer in the template's DECISIONS.md is D-001, in the template's entry format", async () => {
  const root = project({ plan: PLAN.replace("- [ ] **S1.1**", "- [?] **S1.1**") });
  fs.mkdirSync(path.join(root, "docs"));
  const file = path.join(root, "docs", "DECISIONS.md");
  const tpl = "# DECISIONS\n\nIntro.\n\n## Entry format\n\n```markdown\n## D-001 (YYYY-MM-DD, S1.2) Short title of the choice\n- Question: what needed deciding\n\n## N-001 (YYYY-MM-DD, S1.3) Short title of the note\n```\n\n## Entries\n\n(none yet)\n";
  fs.writeFileSync(file, tpl);
  saveState(root, { ...defaultState(), status: "paused", pauseReason: "blocked", currentStep: "S1.1", lastBlockedQuestion: "Postgres or SQLite?" });
  const r = await run(["answer", "SQLite"], root, { now: () => new Date("2026-09-27T04:00:00Z") });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /as D-001;/);
  const text = fs.readFileSync(file, "utf8");
  assert.ok(text.endsWith("## Entries\n\n## D-001 (2026-09-27, S1.1) Owner answer to a blocked question\n- Question: Postgres or SQLite?\n- Answer: SQLite\n- By: owner, with `autoclaude answer`\n"), text);
  assert.doesNotMatch(text, /\(none yet\)/);
  assert.ok(text.includes("```markdown\n## D-001 (YYYY-MM-DD, S1.2) Short title of the choice\n"), "the example is left alone");
  assert.equal(loadState(root).ownerAnswer.decisionId, "D-001");
});

test("status: a plan with no steps says none yet and points at /autoclaude:plan", async () => {
  const root = project({ plan: "# Empty plan\n\nNothing here yet.\n" });
  const r = await run(["status"], root);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /next step: none yet \(the plan has no steps; run \/autoclaude:plan\)/);
  assert.doesNotMatch(r.out, /none left/);
});

test("init takes the folder as a positional argument; an unknown option mentions --dir", async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-init-cli-"));
  const target = path.join(parent, "newproj");
  fs.mkdirSync(target);
  let r = await run(["init", "newproj", "--no-statusline"], parent);
  assert.equal(r.code, 0, r.out + r.err);
  assert.ok(fs.existsSync(path.join(target, "autoclaude.config.json")));
  assert.equal(fs.existsSync(path.join(parent, "autoclaude.config.json")), false);
  r = await run(["init", "--folder", "x"], parent);
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --folder.*--dir/);
  r = await run(["init", "a", "--dir", "b"], parent);
  assert.equal(r.code, 1);
  assert.match(r.err, /one folder/);
});

test("guard-test prints the Bash and PowerShell decisions without a run, and always exits 0", async () => {
  const root = project({ config: { version: 1, guard: { deny: [{ pattern: "ssh\\s+prod", reason: "no production access" }] } } });
  // A plain push is allowed while git.push is on (D49); a force push never is.
  let r = await run(["guard-test", "git push --force origin main"], root);
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\n  Bash: denied: \S.*\n/);
  assert.match(r.out, /\n  PowerShell: (allowed|denied: .+)\n/);
  r = await run(["guard-test", "ssh", "prod-db"], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /Bash: denied: .*no production access/);
  r = await run(["guard-test", "npm test"], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /\n  Bash: allowed\n/);
  assert.match(r.out, /\n  PowerShell: allowed\n/);
  assert.equal(loadState(root).status, "idle", "nothing about the run changes");
  r = await run(["guard-test"], root);
  assert.equal(r.code, 2);
});

test("checks runs the configured checks like the gate: dev server first when needed, one line per check, stop after", async () => {
  const node = JSON.stringify(process.execPath);
  const checks = [
    { name: "lint", command: `${node} -e "process.exit(0)"`, timeoutSec: 60 },
    { name: "e2e", command: `${node} -e "console.log('boom line'); process.exit(3)"`, timeoutSec: 60, needsDevServer: true },
    { name: "late", command: `${node} -e "process.exit(0)"`, timeoutSec: 60 }
  ];
  const root = project({ config: { version: 1, checks, devServer: { command: "npm run dev", url: "http://127.0.0.1:9" } } });
  const calls = [];
  const deps = {
    restartDevServer: async (ds, o) => { calls.push(`start ${ds.url} ${o.root === root}`); return { ok: true, reused: false }; },
    stopDevServer: (o) => { calls.push(`stop ${o.root === root}`); return { stopped: true }; }
  };
  let r = await run(["checks"], root, { deps, env: { ...process.env } });
  assert.equal(r.code, 1, r.out + r.err);
  assert.deepEqual(calls, ["start http://127.0.0.1:9 true", "stop true"]);
  assert.match(r.out, /dev server: started at http:\/\/127\.0\.0\.1:9/);
  assert.match(r.out, /\n  ok   lint \(\d+ s\): /);
  assert.match(r.out, /\n  FAIL e2e \(exit code 3, \d+ s\): /);
  assert.match(r.out, /\n  skip late: not run, an earlier check failed/);
  assert.match(r.out, /boom line/);
  assert.match(r.out, /check "e2e" failed\n$/);

  // All passing, and no check needs the dev server: it is never started.
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, checks: [checks[0], checks[2]] }));
  calls.length = 0;
  r = await run(["checks"], root, { deps, env: { ...process.env } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(calls, []);
  assert.match(r.out, /all 2 check\(s\) passed/);

  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1 }));
  r = await run(["checks"], root);
  assert.equal(r.code, 0);
  assert.match(r.out, /no checks are configured/);
});

test("pause --now with a live supervisor asks it to end the session and stops the dev server the gate started", async () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1", attempts: { "S1.1": 2 } });
  const rt = path.join(root, ".autoclaude");
  fs.writeFileSync(path.join(rt, "supervisor.pid"), String(process.pid));
  const server = spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
  const exited = new Promise((resolve) => server.on("exit", resolve));
  fs.writeFileSync(path.join(rt, "devserver.json"), JSON.stringify({ pid: server.pid, url: "http://127.0.0.1:9", command: "x", startedByUs: true }));
  const r = await run(["pause", "--now"], root);
  assert.equal(r.code, 0, r.out + r.err);
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseReason, s.haltSession, s.pauseRequested], ["paused", "review", true, false]);
  assert.match(r.out, /paused now for review; the dev server is stopped\./);
  assert.match(r.out, /The supervisor \(pid \d+\) ends the builder session on its next check, within 60 s/);
  assert.match(r.out, /S1\.1 starts again with fresh attempts/);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error("the dev server was not stopped")), 10000))]);
  assert.equal(fs.existsSync(path.join(rt, "devserver.json")), false);

  // Resumed before the supervisor's next poll: the request must not end the resumed session later.
  const again = await run(["resume"], root);
  assert.equal(again.code, 0, again.out);
  assert.deepEqual([loadState(root).status, loadState(root).haltSession, loadState(root).attempts["S1.1"]], ["running", false, 0]);
});

test("uninstall on Linux and macOS keeps ~/.local/bin and the PATH, and removes only AutoClaude's files", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-bin-"));
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  await run(["install-cli", "--no-path"], dir, { configDir, env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  fs.writeFileSync(path.join(dir, "other-tool"), "#!/bin/sh\n");
  const calls = [];
  const deps = {
    isWindows: false,
    uninstallWatchdog: () => ({ ok: true, stderr: "", wasInstalled: false }),
    uninstallStatusline: () => ({ removed: false }),
    removeFromUserPath: (d) => { calls.push(d); return "removed"; }
  };
  let r = await run(["uninstall"], dir, { configDir, deps, env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(calls, [], "the PATH is not touched");
  assert.match(r.out, /PATH: unchanged \(.* is shared with other tools, so it stays\)/);
  assert.doesNotMatch(r.out, /remove .* from PATH/);
  assert.equal(fs.existsSync(path.join(dir, "autoclaude")), false);
  assert.ok(fs.existsSync(path.join(dir, "other-tool")), "another tool's file stays");
  // Even an empty bin folder stays: it is not AutoClaude's.
  fs.rmSync(path.join(dir, "other-tool"));
  r = await run(["uninstall"], dir, { configDir, deps, env: { AUTOCLAUDE_BIN_DIR: dir, PATH: "" } });
  assert.equal(r.code, 0, r.out);
  assert.ok(fs.existsSync(dir));
});

// ---------- run with a passing preflight: a real git repository, a trusted folder ----------

function gitAvailable() {
  return spawnSync("git", ["--version"], { stdio: "ignore" }).status === 0;
}

function trustedRepo({ plan, configDir }) {
  const root = project({ plan, config: { version: 1, tester: { enabled: false } } });
  fs.writeFileSync(path.join(root, ".gitignore"), ".autoclaude/\n");
  const g = (...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: root, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); };
  g("init", "-q");
  g("add", "-A");
  g("commit", "-q", "-m", "init");
  const top = fs.realpathSync.native(root);
  fs.writeFileSync(path.join(configDir, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, projects: { [trustKeyFor(top)]: { hasTrustDialogAccepted: true } } }));
  return root;
}

function runEnv() {
  const env = { ...process.env, AUTOCLAUDE_CLAUDE_BIN: process.execPath };
  delete env.CLAUDE_CONFIG_DIR;
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_PLUGIN_OPTION_")) delete env[k];
  return env;
}

test("run continues a finished plan that has new steps: --check only prints, then a fresh run opens the window", { skip: !gitAvailable() && "git is not installed" }, async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  const root = trustedRepo({ plan: PLAN.replace("- [ ] **S1.1**", "- [x] **S1.1**"), configDir });
  saveState(root, { ...defaultState(), status: "complete", builderSessionId: "old-id", tickedByGate: ["S1.1"] });
  const opened = [];
  const deps = { openConsoleWindow: (o) => { opened.push(o); return { method: "windows-console", pid: 1 }; } };

  let r = await run(["run", "--check"], root, { configDir, deps, env: runEnv() });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /ok   plan: 2 steps, next S1\.2/);
  assert.match(r.out, /preflight passed; `autoclaude run` would continue the finished plan with its new steps/);
  assert.deepEqual(opened, [], "--check opens no window");
  assert.equal(loadState(root).status, "complete", "--check changes nothing");
  const runEnvFile = path.join(root, ".autoclaude", "run-env.json");
  assert.equal(fs.existsSync(runEnvFile), false, "--check records nothing");

  r = await run(["run"], root, { configDir, deps, env: { ...runEnv(), PATH: `${runEnv().PATH || runEnv().Path}${path.delimiter}marker-dir` } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(opened.length, 1);
  assert.match(JSON.parse(fs.readFileSync(runEnvFile, "utf8")).PATH, /marker-dir$/, "the terminal's PATH is recorded for the checks");
  assert.deepEqual(opened[0].args.slice(-1), ["supervise"]);
  assert.match(r.out, /continuing the finished plan with its new steps in a new window, ac-/);
  const s = loadState(root);
  assert.deepEqual([s.status, s.builderSessionId, s.currentStep], ["idle", null, null], "idle, so the supervisor launches /autoclaude:start");

  // A tmux that cannot start the session is an error, not a success.
  r = await run(["run"], root, { configDir, deps: { openConsoleWindow: () => ({ method: "tmux", ok: false, stderr: "no server running on /tmp/tmux-0/default\n" }) }, env: runEnv() });
  assert.equal(r.code, 1);
  assert.match(r.out, /could not start the tmux session ac-[^:]+: no server running/);
  assert.doesNotMatch(r.out, /in a new window/);

  // --check on a failing preflight exits 1, still without a window.
  fs.writeFileSync(path.join(root, "stray.txt"), "dirty");
  r = await run(["run", "--check"], root, { configDir, deps, env: runEnv() });
  assert.equal(r.code, 1);
  assert.match(r.out, /FAIL git: the working tree has 1 uncommitted change/);
  assert.match(r.out, /preflight failed/);
  assert.equal(opened.length, 1);
  r = await run(["run", "--bogus"], root, { configDir, deps, env: runEnv() });
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --bogus/);
});

test("start on a continued plan: an old run branch already merged here moves forward; an unmerged one without the new step refuses", { skip: !gitAvailable() && "git is not installed" }, async () => {
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cfg-"));
  const g = (root, ...a) => { const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...a], { cwd: root, encoding: "utf8" }); assert.equal(r.status, 0, r.stderr); return r.stdout.trim(); };
  const onePlan = PLAN.replace(/- \[ \] \*\*S1\.2\*\* Second\n  - Accept: b\n/, "");
  const setUp = () => {
    const root = trustedRepo({ plan: onePlan, configDir });
    const base = g(root, "rev-parse", "--abbrev-ref", "HEAD");
    // The last run: its branch ticked S1.1.
    g(root, "checkout", "-q", "-b", "autoclaude/demo");
    fs.writeFileSync(path.join(root, "PLAN.md"), onePlan.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
    g(root, "commit", "-q", "-am", "autoclaude(S1.1): First");
    g(root, "checkout", "-q", base);
    return { root, base };
  };

  // Merged into the base branch, then a new step added there: the run branch catches up.
  let { root, base } = setUp();
  g(root, "merge", "-q", "--ff-only", "autoclaude/demo");
  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  g(root, "commit", "-q", "-am", "plan: add S1.2");
  const tip = g(root, "rev-parse", "HEAD");
  // The footprint and the alert are fakes: a test never asks the real Docker engine anything.
  const seen = [];
  const deps = {
    recordFootprintStart: async (at, o) => { seen.push(["footprint", at === root, JSON.stringify(o)]); return {}; },
    notifyEvent: async (at, config, event, message) => { seen.push([event, at === root, message.title, message.message]); return { sent: false }; }
  };
  let r = await run(["start", "--no-preflight"], root, { configDir, env: runEnv(), deps });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /running on branch autoclaude\/demo\. First step: S1\.2 Second/);
  assert.deepEqual([g(root, "rev-parse", "--abbrev-ref", "HEAD"), g(root, "rev-parse", "HEAD")], ["autoclaude/demo", tip]);
  assert.deepEqual(seen, [
    ["footprint", true, "{}"],
    ["runStarted", true, `AutoClaude started: ${path.basename(root)}`, "Running on branch autoclaude/demo, 1 step(s) to do. First: S1.2 Second."]
  ], "the Docker state is recorded before the run touches it, then the run-started alert");

  // Not merged, and the new step went onto the base branch only: refuse, and stay put.
  ({ root, base } = setUp());
  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  g(root, "commit", "-q", "-am", "plan: add S1.2");
  r = await run(["start", "--no-preflight"], root, { configDir, env: runEnv(), deps });
  assert.equal(r.code, 1);
  assert.match(r.out, new RegExp(`the run branch autoclaude/demo is left from an earlier run, and its PLAN\\.md does not have S1\\.2 to do\\. Merge ${base} into autoclaude/demo`));
  assert.equal(g(root, "rev-parse", "--abbrev-ref", "HEAD"), base);
  assert.equal(loadState(root).status, "idle");
});

// ---------- Phase 8: --help everywhere, config, decide, the checks' PATH, owner alerts ----------

test("--help and -h on every command print that command's usage and do nothing else", async () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1" });
  for (const cmd of COMMANDS.filter((c) => c !== "help")) {
    for (const flag of ["--help", "-h"]) {
      const r = await run([cmd, flag], root);
      assert.equal(r.code, 0, `${cmd} ${flag}: ${r.out}${r.err}`);
      assert.match(r.out, new RegExp(`^Usage: autoclaude ${cmd} \\.\\.\\.\\n\\n  ${cmd}\\b`), `${cmd} ${flag}`);
      assert.doesNotMatch(r.out, /Machine commands:/, `${cmd}: only its own entry`);
    }
  }
  assert.equal(commandHelp("bogus"), null);
  assert.match(commandHelp("notify-setup"), /\[--discord <webhook url>\] \[--show\] \[--clear\]\n/, "an entry's wrapped option line comes along");
  assert.match(commandHelp("decide"), /owner_review/);
  // Nothing ran: the state is as it was, no note was taken, no window opened.
  const s = loadState(root);
  assert.deepEqual([s.status, s.pauseRequested, s.pendingNotes.length], ["running", false, 0]);
  let r = await run(["run", "--check", "--help"], root);
  assert.match(r.out, /^Usage: autoclaude run/);
  // Free-text commands: only a first argument asks for help, so a note may mention -h.
  r = await run(["note", "the", "-h", "flag", "is", "fine"], root);
  assert.equal(r.code, 0);
  assert.deepEqual(loadState(root).pendingNotes.map((n) => n.text), ["the -h flag is fine"]);
  r = await run(["help", "--help"], root);
  assert.match(r.out, /Machine commands:/, "help --help is the whole help");
});

test("config opens the settings page for this project, or for the computer outside one", async () => {
  const root = project();
  const calls = [];
  const openConfigPage = async (o) => { calls.push(o); return { url: "http://127.0.0.1:1/?token=x", reason: "done", saves: 1 }; };
  let r = await run(["config"], root, { deps: { openConfigPage } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.equal(calls[0].root, root);
  assert.equal(typeof calls[0].io.out, "function", "the page writes through the CLI's output");
  const bare = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-cli-bare-"));
  fs.mkdirSync(path.join(bare, ".git"));
  r = await run(["config"], bare, { deps: { openConfigPage } });
  assert.equal(r.code, 0);
  assert.equal(calls[1].root, null, "a git repository AutoClaude was never set up in gets the computer's page");
  r = await run(["config"], root, { deps: { openConfigPage: async () => 3 } });
  assert.equal(r.code, 3);
  r = await run(["config"], root, { deps: { openConfigPage: async () => ({ ok: false }) } });
  assert.equal(r.code, 1);
  r = await run(["config"], root, { deps: { configPageFile: "./definitely-missing-configpage.js" } });
  assert.equal(r.code, 1);
  assert.match(r.err, /the config page is not in this install/);
  r = await run(["config", "--port", "1"], root, { deps: { openConfigPage } });
  assert.equal(r.code, 1);
  assert.match(r.err, /unknown option --port/);
});

test("decide runs the decider synchronously and prints its JSON; exit 1 only when it could not run", async () => {
  const root = project({ config: { version: 1, builder: { model: "sonnet" } } });
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.2" });
  const calls = [];
  const answer = { classification: "routine", recommendation: "Use port 8080", reasoning: "The plan's Stack names 8080.", question_for_owner: "", owner_review: true };
  const runHeadless = async (o) => { calls.push(o); return { ok: true, structured: answer, durationMs: 30000, costUsd: 0.2 }; };
  let r = await run(["decide", "Which", "port? Options: 8080 or 3000"], root, { deps: { runHeadless }, env: { PATH: "", AUTOCLAUDE_BUILDER: "1" }, now: () => new Date("2026-09-28T12:00:00Z") });
  assert.equal(r.code, 0, r.out + r.err);
  assert.deepEqual(JSON.parse(r.out), answer);
  const o = calls[0];
  const at = (flag) => o.args[o.args.indexOf(flag) + 1];
  assert.deepEqual([o.cwd, o.role, at("--model"), at("--allowedTools")], [root, "decider", "sonnet", "Read,Glob,Grep"]);
  assert.equal(o.env.AUTOCLAUDE_BUILDER, undefined);
  assert.match(o.prompt, /^You are the decider/);
  assert.ok(o.prompt.includes(`- The plan: ${path.join(root, "PLAN.md")}`), o.prompt);
  assert.ok(o.prompt.includes(`- The decisions log: ${path.join(root, "docs", "DECISIONS.md")}`));
  assert.match(o.prompt, /- The step being worked on: S1\.2 Second\n/);
  assert.match(o.prompt, /The builder asks:\n\nWhich port\? Options: 8080 or 3000\n/);
  const log = fs.readFileSync(path.join(root, ".autoclaude", "logs", "decide.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.deepEqual([log[0].at, log[0].step, log[0].ok, log[0].decision.owner_review], ["2026-09-28T12:00:00.000Z", "S1.2", true, true]);

  r = await run(["decide", "Which port?"], root, { deps: { runHeadless: async () => ({ ok: false, error: "timed out after 540 s" }) } });
  assert.equal(r.code, 1);
  assert.equal(r.out, "", "no JSON when there is no answer");
  assert.match(r.err, /the decider could not answer: timed out after 540 s/);
  assert.match(r.err, /autoclaude:decider agent with the Agent tool/);
  r = await run(["decide"], root);
  assert.equal(r.code, 2);
  assert.match(r.err, /usage: autoclaude decide/);
});

test("checks runs with the PATH the run recorded, else a Git Bash PATH without Git Bash's own folders", async () => {
  const node = JSON.stringify(process.execPath);
  const marker = path.join(os.tmpdir(), "autoclaude-marker-bin");
  const fakeGit = path.join(os.tmpdir(), "FakeGitRoot", "usr", "bin");
  // Each check exits 0 only when the PATH it was given is the one expected.
  const checks = [{ name: "path", command: `${node} -e "process.exit(process.env.PATH.includes('autoclaude-marker-bin') ? 0 : 5)"`, timeoutSec: 60 }];
  const root = project({ config: { version: 1, checks } });
  const shellEnv = { ...process.env };
  for (const k of Object.keys(shellEnv)) if (k.toUpperCase() === "PATH") delete shellEnv[k];
  delete shellEnv.MSYSTEM;
  const basePath = process.env.PATH || process.env.Path || "";
  let r = await run(["checks"], root, { env: { ...shellEnv, PATH: basePath } });
  assert.equal(r.code, 1, "the marker is only in the run's PATH");
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autoclaude", "run-env.json"), JSON.stringify({ PATH: `${marker}${path.delimiter}${basePath}`, Path: null, at: "2026-09-28T09:00:00.000Z" }));
  r = await run(["checks"], root, { env: { ...shellEnv, PATH: basePath } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\n  PATH: the PATH the run recorded at 2026-09-28T09:00:00\.000Z \(the gate's\)\n/);

  // No run yet, in Git Bash: Git Bash's own folders are dropped before the checks run.
  fs.rmSync(path.join(root, ".autoclaude", "run-env.json"));
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, checks: [{ name: "no-git-bash", command: `${node} -e "process.exit(process.env.PATH.includes('FakeGitRoot') ? 6 : 0)"`, timeoutSec: 60 }] }));
  r = await run(["checks"], root, { env: { ...shellEnv, MSYSTEM: "MINGW64", PATH: `${fakeGit}${path.delimiter}${basePath}` } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /PATH: this shell's PATH without Git Bash's own folders/);
  r = await run(["checks"], root, { env: { ...shellEnv, PATH: `${fakeGit}${path.delimiter}${basePath}` } });
  assert.equal(r.code, 1, "outside Git Bash the PATH is used as it is");
});

test("pause, pause --now and resume send the owner's switchable alerts; off by default, they are only logged", async () => {
  const root = project();
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1" });
  const events = [];
  const deps = { notifyEvent: async (at, config, event, message, opts) => { events.push([event, message.title, typeof opts.env]); } };
  let r = await run(["pause"], root, { deps });
  assert.equal(r.code, 0, r.out);
  r = await run(["resume"], root, { deps });
  assert.match(r.out, /withdrawn/);
  r = await run(["pause", "--now"], root, { deps });
  assert.equal(r.code, 0, r.out);
  r = await run(["resume"], root, { deps });
  assert.equal(r.code, 0, r.out);
  const name = path.basename(root);
  assert.deepEqual(events, [
    ["pausedByOwner", `AutoClaude pause requested: ${name}`, "object"],
    ["pausedByOwner", `AutoClaude paused: ${name}`, "object"],
    ["runResumed", `AutoClaude resumed: ${name}`, "object"]
  ], "withdrawing a pause request is not a resume");

  // With the real notifier and the events off by default: nothing is sent, the log says so.
  r = await run(["pause", "--now"], root);
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /AutoClaude paused/, "never printed as an alert");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "notify.log"), "utf8"), /pausedByOwner/);
});
