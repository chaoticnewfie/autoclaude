import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { isHealthy, healthUrl, ensureDevServer, stopDevServer, devServerInfo } from "../../plugins/autoclaude/lib/devserver.js";
import { isPidAlive } from "../../plugins/autoclaude/lib/proc.js";

const node = JSON.stringify(process.execPath);
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-devserver-"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function listen(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({ server, port, url: `http://127.0.0.1:${port}` });
    });
  });
}

function close(server) {
  server.closeAllConnections();
  return new Promise((r) => server.close(r));
}

async function freePort() {
  const { server, port } = await listen(() => {});
  await close(server);
  return port;
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return await fn();
}

test("healthUrl joins url and healthPath with exactly one slash", () => {
  assert.equal(healthUrl("http://127.0.0.1:3000", "/"), "http://127.0.0.1:3000/");
  assert.equal(healthUrl("http://127.0.0.1:3000/", "/health"), "http://127.0.0.1:3000/health");
  assert.equal(healthUrl("http://127.0.0.1:3000", "health"), "http://127.0.0.1:3000/health");
  assert.equal(healthUrl("http://127.0.0.1:3000/", ""), "http://127.0.0.1:3000/");
});

test("isHealthy: any status below 500 is up; 500, a closed port and a hang are down", async () => {
  const { server, url, port } = await listen((req, res) => {
    if (req.url === "/broken") { res.statusCode = 500; res.end("boom"); return; }
    if (req.url === "/missing") { res.statusCode = 404; res.end("nope"); return; }
    if (req.url === "/hang") return;
    res.end("ok");
  });
  try {
    assert.equal(await isHealthy(url + "/"), true);
    assert.equal(await isHealthy(url + "/missing"), true);
    assert.equal(await isHealthy(url + "/broken"), false);
    assert.equal(await isHealthy(url + "/hang", { timeoutMs: 300 }), false);
  } finally {
    await close(server);
  }
  assert.equal(await isHealthy(`http://127.0.0.1:${port}/`), false);
});

test("ensureDevServer skips when no command or url is configured; stop and info are safe", async () => {
  const root = tmpDir();
  const r = await ensureDevServer({ command: null, url: null, healthPath: "/", startTimeoutSec: 5 }, { root });
  assert.deepEqual(r, { ok: true, skipped: true });
  assert.equal(devServerInfo({ root }), null);
  assert.deepEqual(stopDevServer({ root }), { stopped: false, pid: null });
  assert.equal(fs.existsSync(path.join(root, ".autoclaude")), false);
});

test("ensureDevServer reuses a server that already answers and records nothing", async () => {
  const root = tmpDir();
  const { server, url } = await listen((req, res) => { res.statusCode = 404; res.end(); });
  try {
    const lines = [];
    const r = await ensureDevServer({ command: "this-would-fail", url, healthPath: "/health", startTimeoutSec: 5 }, { root, log: (l) => lines.push(l) });
    assert.deepEqual(r, { ok: true, reused: true, url });
    assert.equal(devServerInfo({ root }), null);
    assert.equal(fs.existsSync(path.join(root, ".autoclaude")), false);
    assert.ok(lines.some((l) => /reusing/.test(l)), lines.join("\n"));
    assert.deepEqual(stopDevServer({ root }), { stopped: false, pid: null });
  } finally {
    await close(server);
  }
});

test("ensureDevServer starts the command detached, logs it, records devserver.json, and stopDevServer ends it", async () => {
  const root = tmpDir();
  const port = await freePort();
  const script = path.join(root, "server.cjs");
  fs.writeFileSync(script, `console.log('listening on ${port}');\nrequire('http').createServer((q, s) => s.end('ok')).listen(${port}, '127.0.0.1');\n`);
  const url = `http://127.0.0.1:${port}`;
  const lines = [];
  const r = await ensureDevServer({ command: `${node} "${script}"`, url, healthPath: "/", startTimeoutSec: 20 }, { root, log: (l) => lines.push(l) });
  try {
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.equal(r.reused, false);
    assert.ok(r.pid > 0);
    assert.equal(r.url, url);
    assert.ok(lines.some((l) => /started dev server/.test(l)), lines.join("\n"));

    const infoFile = path.join(root, ".autoclaude", "devserver.json");
    const info = devServerInfo({ root });
    assert.equal(info.startedByUs, true);
    assert.equal(info.pid, r.pid);
    assert.equal(info.url, url);
    assert.equal(info.command, `${node} "${script}"`);
    assert.ok(info.startedAt);
    assert.equal(JSON.parse(fs.readFileSync(infoFile, "utf8")).pid, r.pid);

    const again = await ensureDevServer({ command: "not-run", url, healthPath: "/", startTimeoutSec: 5 }, { root });
    assert.deepEqual(again, { ok: true, reused: true, url });

    const logFile = path.join(root, ".autoclaude", "logs", "devserver.log");
    assert.equal(await waitFor(() => /listening on/.test(fs.readFileSync(logFile, "utf8")), 3000), true);

    assert.deepEqual(stopDevServer({ root }), { stopped: true, pid: r.pid });
    assert.equal(devServerInfo({ root }), null);
    assert.equal(fs.existsSync(infoFile), false);
    assert.equal(await waitFor(async () => !(await isHealthy(url)), 5000), true);
    assert.equal(await waitFor(() => !isPidAlive(r.pid), 3000), true);
    assert.deepEqual(stopDevServer({ root }), { stopped: false, pid: null });
  } finally {
    // A failed assertion above must not leave a server running.
    if (devServerInfo({ root })) stopDevServer({ root });
  }
});

test("ensureDevServer gives up after startTimeoutSec, kills the process, and returns the log tail", async () => {
  const root = tmpDir();
  const port = await freePort();
  const script = path.join(root, "never.cjs");
  fs.writeFileSync(script, "console.log('never listening');\nsetTimeout(function () {}, 60000);\n");
  const started = Date.now();
  const r = await ensureDevServer({ command: `${node} "${script}"`, url: `http://127.0.0.1:${port}`, healthPath: "/", startTimeoutSec: 2 }, { root });
  assert.equal(r.ok, false);
  assert.equal(r.error, `dev server did not answer at http://127.0.0.1:${port}/ within 2 s`);
  assert.ok(Date.now() - started < 15000, "timeout was not enforced quickly");
  assert.ok(Array.isArray(r.logTail) && r.logTail.some((l) => /never listening/.test(l)), JSON.stringify(r.logTail));
  assert.equal(devServerInfo({ root }), null);
  assert.equal(fs.existsSync(path.join(root, ".autoclaude", "devserver.json")), false);
  assert.equal(await waitFor(() => !isPidAlive(r.pid), 3000), true);
});

test("ensureDevServer resolves ok false instead of rejecting when the start itself fails", async () => {
  const root = path.join(tmpDir(), "not-a-directory.txt");
  fs.writeFileSync(root, "a file where the project root should be\n");
  const port = await freePort();
  const lines = [];
  const r = await ensureDevServer({ command: "whatever", url: `http://127.0.0.1:${port}`, healthPath: "/", startTimeoutSec: 2 }, { root, log: (l) => lines.push(l) });
  assert.equal(r.ok, false);
  assert.match(r.error, /^could not start dev server: /);
  assert.deepEqual(r.logTail, []);
  assert.ok(lines.some((l) => /could not start/.test(l)), lines.join("\n"));
  assert.equal(devServerInfo({ root }), null);
  assert.deepEqual(stopDevServer({ root }), { stopped: false, pid: null });
});
