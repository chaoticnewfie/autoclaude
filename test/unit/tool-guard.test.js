import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { decide } from "../../plugins/autoclaude/scripts/tool-guard.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";

const root = process.platform === "win32" ? "C:\\proj" : "/proj";
const ctx = { root, config: mergeConfig({}) };
const d = (tool_name, tool_input) => decide({ tool_name, tool_input }, ctx);

test("AskUserQuestion is denied with the decide-it-yourself guidance", () => {
  assert.match(d("AskUserQuestion", { questions: [] }), /No human is available/);
});

test("edits to the plan, the config and .autoclaude are denied; other files are fine", () => {
  assert.match(d("Edit", { file_path: path.join(root, "PLAN.md") }), /managed by the gate/);
  assert.match(d("Write", { file_path: path.join(root, "autoclaude.config.json") }), /managed by the gate/);
  assert.match(d("Write", { file_path: path.join(root, ".autoclaude", "state.json") }), /managed by the gate/);
  assert.equal(d("Edit", { file_path: path.join(root, "src", "app.js") }), null);
  assert.equal(d("Edit", { file_path: path.join(root, "docs", "PLAN.md") }), null, "a differently located file with the same name is not the plan");
});

test("bash: force push, push when off, reset --hard, commits, recursive deletes and plan rewrites are denied", () => {
  assert.match(d("Bash", { command: "git push --force origin main" }), /Force pushes/);
  assert.match(d("Bash", { command: "git push -f" }), /Force pushes/);
  assert.match(d("Bash", { command: "git push origin HEAD" }), /Pushing is off/);
  assert.match(d("Bash", { command: "git reset --hard HEAD~1" }), /reset --hard/);
  assert.match(d("Bash", { command: "git commit -m x" }), /gate commits/);
  assert.match(d("Bash", { command: "rm -rf /" }), /Recursive deletes/);
  assert.match(d("Bash", { command: "rm -rf C:\\Users" }), /Recursive deletes/);
  assert.match(d("Bash", { command: "rm -rf ../other" }), /Recursive deletes/);
  assert.match(d("Bash", { command: "echo x > PLAN.md" }), /Shell writes to PLAN\.md/);
  assert.match(d("Bash", { command: "sed -i s/a/b/ PLAN.md" }), /Shell writes to PLAN\.md/);
  assert.match(d("Bash", { command: "cat x | tee .autoclaude/state.json" }), /gate's state/);
  assert.equal(d("Bash", { command: "rm -rf node_modules" }), null, "deleting inside the project is allowed");
  assert.equal(d("Bash", { command: "git status" }), null);
  assert.equal(d("Bash", { command: "grep ready PLAN.md" }), null, "reading the plan is fine");
  assert.equal(d("Bash", { command: "npm test" }), null);
});

test("reads of protected files are allowed even with redirects elsewhere on the line (live-run false positives)", () => {
  assert.equal(d("Bash", { command: "ls -la && cat CONTINUE_HERE.md 2>/dev/null; cat autoclaude.config.json; ls test 2>/dev/null" }), null);
  assert.equal(d("Bash", { command: "cat .autoclaude/state.json | head -40" }), null);
  assert.equal(d("Bash", { command: "ls .autoclaude 2>/dev/null; cat PLAN.md" }), null);
  assert.equal(d("Bash", { command: "node -e \"console.log(1)\" > out.txt 2>&1; cat PLAN.md" }), null);
  assert.match(d("Bash", { command: "cat x > .autoclaude/state.json" }), /gate's state/);
  assert.match(d("Bash", { command: "rm .autoclaude/ready.json" }), /gate's state/);
  assert.match(d("Bash", { command: "mv PLAN.md PLAN.old" }), /Shell writes to PLAN\.md/);
  assert.match(d("Bash", { command: "cp other.md autoclaude.config.json" }), /read-only/);
  assert.match(d("Bash", { command: "Set-Content -Path PLAN.md -Value x" }), /Shell writes to PLAN\.md/);
});

test("guard.deny: project rules block matching commands, case-insensitively, with their reason", () => {
  const rules = { root, config: mergeConfig({ guard: { deny: [
    { pattern: "\\bssh\\b|\\bscp\\b", reason: "this machine holds keys to other hosts" },
    { pattern: "\\b(qm|pct|zpool|zfs)\\b", reason: "no infrastructure commands" },
    { pattern: "[(" , reason: "a broken pattern is skipped, not fatal" }
  ] } }) };
  const g = (command) => decide({ tool_name: "Bash", tool_input: { command } }, rules);
  assert.match(g("ssh root@10.0.0.2 uptime"), /does not allow that command.*keys to other hosts/);
  assert.match(g("SCP file host:/tmp"), /keys to other hosts/);
  assert.match(g("zpool create tank /dev/sdb"), /no infrastructure commands/);
  assert.equal(g("npm test"), null);
  assert.equal(g("echo sshd_config is a file name"), null, "word boundaries keep near misses out");
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: path.join(root, "ssh.js") } }, rules), null, "rules apply to shell commands only");
});

test("push is allowed when the config says so", () => {
  const allowPush = { root, config: mergeConfig({ git: { push: true } }) };
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "git push origin HEAD" } }, allowPush), null);
});
