import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { runCommand, killTree, isPidAlive, findOnPath, buildStartLine, cmdQuote } from "../../plugins/autoclaude/lib/proc.js";

const node = JSON.stringify(process.execPath);

test("runCommand captures stdout, stderr, exit code and streams lines", async () => {
  const lines = [];
  const r = await runCommand(`${node} -e "console.log('out1'); console.error('err1'); console.log('out2'); process.exit(3)"`, { onLine: (l, s) => lines.push(`${s}:${l}`) });
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
  assert.match(r.stdout, /out1\r?\nout2/);
  assert.match(r.stderr, /err1/);
  assert.ok(lines.includes("out:out1") && lines.includes("out:out2") && lines.includes("err:err1"), lines.join(","));
  assert.ok(r.durationMs >= 0);
});

test("runCommand resolves npm-style shims through the shell and passes cwd", async () => {
  const r = await runCommand(process.platform === "win32" ? "cd" : "pwd", { cwd: process.cwd() });
  assert.equal(r.code, 0);
  assert.match(r.stdout.trim().toLowerCase(), new RegExp(process.cwd().slice(-8).toLowerCase().replace(/\\/g, "[\\\\/]")));
});

test("runCommand kills the process tree on timeout and reports timedOut", async () => {
  const started = Date.now();
  const r = await runCommand(`${node} -e "setTimeout(()=>{}, 20000)"`, { timeoutMs: 800 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - started < 10000, "timeout was not enforced quickly");
});

test("isPidAlive and killTree", async () => {
  assert.equal(isPidAlive(process.pid), true);
  assert.equal(isPidAlive(999999999), false);
  const child = spawn(process.execPath, ["-e", "setTimeout(()=>{}, 20000)"], { stdio: "ignore", detached: process.platform !== "win32" });
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(isPidAlive(child.pid), true);
  assert.equal(killTree(child.pid), true);
  await new Promise((r) => child.on("exit", r));
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(isPidAlive(child.pid), false);
});

test("findOnPath finds node on a PATH that contains it, and not nonsense", async () => {
  const path = await import("node:path");
  const env = { PATH: path.dirname(process.execPath), PATHEXT: process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD" };
  const found = findOnPath("node", env);
  assert.ok(found && /node(\.exe)?$/i.test(found), String(found));
  assert.equal(findOnPath("definitely-not-a-real-program-xyz", env), null);
  assert.equal(findOnPath("node", { PATH: "" }), null);
});

test("buildStartLine quotes the title always and the rest only when needed", () => {
  const line = buildStartLine({ title: "ac-my app", cwd: "C:\\Code\\my app", program: "C:\\Program Files\\nodejs\\node.exe", args: ["supervise.js", "80000", "a b"] });
  assert.equal(line, 'start "ac-my app" /D "C:\\Code\\my app" "C:\\Program Files\\nodejs\\node.exe" supervise.js 80000 "a b"');
  assert.equal(cmdQuote("plain"), "plain");
  assert.equal(cmdQuote("has space"), '"has space"');
  assert.equal(cmdQuote("a>b"), '"a>b"');
});
