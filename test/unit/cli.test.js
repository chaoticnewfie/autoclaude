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

async function run(argv, cwd, extra = {}) {
  const stdout = new Sink();
  const stderr = new Sink();
  const code = await runCli(argv, { cwd, stdout, stderr, env: { PATH: "", ...extra.env }, ...extra });
  return { code, out: stdout.text, err: stderr.text };
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
  assert.match(r.out, /resumed with 1 review note/);
  assert.equal(loadState(root).status, "running");
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
  const shim = path.join(dir, process.platform === "win32" ? "autoclaude.cmd" : "autoclaude");
  assert.ok(fs.existsSync(shim));
  const body = fs.readFileSync(shim, "utf8");
  assert.match(body, /autoclaude\.js/);
  assert.match(r.out, /add .* to your PATH/);
});

test("notify-test with no channel prints to stdout and reports it", async () => {
  const r = await run(["notify-test", "hello"], os.tmpdir(), { env: { PATH: "" } });
  assert.equal(r.code, 0, r.out + r.err);
  assert.match(r.out, /\[autoclaude default\] AutoClaude test\nhello/);
  assert.match(r.out, /no channel is configured/);
});

test("help and unknown commands", async () => {
  let r = await run(["help"], os.tmpdir());
  assert.equal(r.code, 0);
  assert.match(r.out, /Usage: autoclaude/);
  r = await run(["bogus"], os.tmpdir());
  assert.equal(r.code, 2);
  assert.match(r.err, /unknown command/);
});
