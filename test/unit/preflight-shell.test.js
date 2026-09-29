import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { preflight, checkRunnable, isWslBash, gitBashPath, wslBashProblem } from "../../plugins/autoclaude/lib/preflight.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { gitEnv } from "../fixtures/prepare.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
// An empty stand-in for a program, under both spellings findOnPath may look for (bash.exe on
// Windows, bash elsewhere), so these tests read the same on every OS.
const program = (dir, name) => { fs.mkdirSync(dir, { recursive: true }); for (const n of [name, `${name}.exe`]) fs.writeFileSync(path.join(dir, n), ""); };

// A fake Windows: System32 with WSL's bash.exe launcher, and a Git for Windows install whose cmd
// folder is on PATH (what the Git installer does) with its bash in bin.
function fakeMachine({ git = true } = {}) {
  const base = tmp("autoclaude-pfsh-");
  const sysRoot = path.join(base, "Windows");
  const system32 = path.join(sysRoot, "System32");
  program(system32, "bash");
  const gitRoot = path.join(base, "Git");
  if (git) { program(path.join(gitRoot, "cmd"), "git"); program(path.join(gitRoot, "bin"), "bash"); }
  const env = { PATH: [system32, ...(git ? [path.join(gitRoot, "cmd")] : [])].join(path.delimiter), PATHEXT: ".EXE;.CMD", SystemRoot: sysRoot };
  return { base, sysRoot, system32, gitRoot, env };
}

test("isWslBash: bash.exe in Windows' System32 or next to wsl.exe is WSL's launcher; Git's bash is not", () => {
  const m = fakeMachine();
  assert.equal(isWslBash(path.join(m.system32, "bash.exe"), m.env), true);
  assert.equal(isWslBash(path.join(m.sysRoot, "system32", "BASH.EXE"), m.env), true, "any case");
  assert.equal(isWslBash(path.join(m.system32, "cmd.exe"), m.env), false, "only bash");
  assert.equal(isWslBash(path.join(m.gitRoot, "bin", "bash.exe"), m.env), false);
  const wslDir = path.join(m.base, "WSL");
  program(wslDir, "bash");
  program(wslDir, "wsl");
  assert.equal(isWslBash(path.join(wslDir, "bash.exe"), {}), true, "a bash.exe that ships beside wsl.exe");
  assert.equal(gitBashPath(m.env), path.join(m.gitRoot, "bin", "bash.exe"), "found from git on PATH");
});

test("checkRunnable: a check starting with `bash` that resolves to WSL's launcher FAILs with the fix; Git's bash, a written-out path and other systems pass", () => {
  const root = tmp("autoclaude-pfsh-root-");
  const m = fakeMachine();
  const r = checkRunnable("bash scripts/test.sh", root, m.env, { platform: "win32" });
  assert.equal(r.ok, false);
  const wslBash = path.join(m.system32, process.platform === "win32" ? "bash.exe" : "bash");
  assert.ok(r.detail.startsWith(`\`bash\` here is ${wslBash}, Windows' WSL launcher, not Git Bash: the command would run inside WSL`), r.detail);
  const gitBash = path.join(m.gitRoot, "bin", "bash.exe");
  assert.ok(r.detail.includes(`start the command with "${gitBash.replace(/\\/g, "/")}" instead of \`bash\`, or put ${path.dirname(gitBash)} before ${m.system32} on PATH`), r.detail);
  assert.match(r.detail, /To use WSL on purpose, start the command with `wsl`$/);
  assert.equal(checkRunnable("bash.exe -c true", root, m.env, { platform: "win32" }).ok, false, "bash.exe spelled out is the same program");

  // Git Bash's own folder first on PATH (a run started from Git Bash): bash is Git's.
  const gitFirst = { ...m.env, PATH: [path.join(m.gitRoot, "bin"), m.env.PATH].join(path.delimiter) };
  assert.deepEqual(checkRunnable("bash scripts/test.sh", root, gitFirst, { platform: "win32" }), { ok: true });
  // A path written out says the owner means that program, WSL or not.
  assert.deepEqual(checkRunnable(`"${path.join(m.system32, "bash.exe")}" scripts/test.sh`, root, m.env, { platform: "win32" }), { ok: true });
  // Linux and macOS have no WSL launcher.
  assert.deepEqual(checkRunnable("bash scripts/test.sh", root, m.env, { platform: "linux" }), { ok: true });
  // Other commands are not affected.
  assert.equal(wslBashProblem("git status", m.env, "win32"), null);

  // No Git for Windows at all: the fix says to install it.
  const bare = fakeMachine({ git: false });
  assert.match(checkRunnable("bash x.sh", root, bare.env, { platform: "win32" }).detail, /To fix it, install Git for Windows and start the command with its bash\.exe \(by default "C:\/Program Files\/Git\/bin\/bash\.exe"\) instead of `bash`\./);
});

test("preflight: a check or the dev server starting with WSL's bash FAILs by name, and the dev server is not started", async () => {
  const m = fakeMachine();
  const root = tmp("autoclaude-pfsh-proj-");
  fs.writeFileSync(path.join(root, "PLAN.md"), "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** Page\n  - Accept: a\n  - Tags: ui\n");
  // A dev server that would take 60 s to be declared dead if preflight started it.
  const config = mergeConfig({ checks: [{ name: "unit", command: "bash scripts/test.sh" }], devServer: { command: "bash scripts/dev.sh", url: "http://127.0.0.1:9", healthPath: "/", startTimeoutSec: 60 } });
  const userConfigFile = path.join(tmp("autoclaude-pfsh-cfg-"), ".claude.json");
  const skip = ["usage", "notify", "trust", "git", "git-cli", "node", "claude", "playwright"];
  const began = Date.now();
  const r = await preflight({ root, config }, { env: gitEnv(process.env), checksEnv: m.env, userConfigFile, skip, platform: "win32" });
  const items = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(r.ok, false);
  assert.equal(items.checks.status, "fail");
  assert.match(items.checks.detail, /^unit: `bash` here is .*, Windows' WSL launcher, not Git Bash/);
  assert.equal(items["dev server"].status, "fail");
  assert.match(items["dev server"].detail, /^devServer\.command: `bash` here is .*, Windows' WSL launcher, not Git Bash/);
  assert.ok(Date.now() - began < 30000, "the dev server was not started and waited for");

  // The same project where bash is Git's: both pass this test (the dev server is not started).
  const gitFirst = { ...m.env, PATH: [path.join(m.gitRoot, "bin"), m.env.PATH].join(path.delimiter) };
  const ok = await preflight({ root, config }, { env: gitEnv(process.env), checksEnv: gitFirst, userConfigFile, skip, devServer: false, platform: "win32" });
  const okItems = Object.fromEntries(ok.items.map((i) => [i.name, i]));
  assert.deepEqual([okItems.checks.status, okItems["dev server"]], ["ok", undefined]);
});
