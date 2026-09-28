import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { notify, resolveChannel } from "../../plugins/autoclaude/lib/notify.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-notify-"));

class FakeOut { constructor() { this.text = ""; } write(s) { this.text += s; return true; } }

function startServer(status = 200) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        requests.push({ method: req.method, url: req.url, headers: req.headers, body });
        res.writeHead(status);
        res.end("ok");
      });
    });
    server.listen(0, "127.0.0.1", () => resolve({ server, requests, url: `http://127.0.0.1:${server.address().port}` }));
  });
}

const NO_FILE = path.join(os.tmpdir(), "autoclaude-no-such-notify.json");

test("resolveChannel: explicit options, env fallback, auto selection and downgrade to stdout", () => {
  assert.equal(resolveChannel({}, {}, NO_FILE).channel, "stdout");
  assert.equal(resolveChannel({ ntfyUrl: "https://ntfy.sh/x" }, {}, NO_FILE).channel, "ntfy");
  assert.equal(resolveChannel({ discordWebhook: "https://discord/x" }, {}, NO_FILE).channel, "discord");
  assert.equal(resolveChannel({ ntfyUrl: "https://ntfy.sh/x", discordWebhook: "https://d/x" }, {}, NO_FILE).channel, "ntfy");
  assert.equal(resolveChannel({ channel: "discord", ntfyUrl: "https://ntfy.sh/x", discordWebhook: "https://d/x" }, {}, NO_FILE).channel, "discord");
  assert.equal(resolveChannel({ channel: "ntfy" }, {}, NO_FILE).channel, "stdout");
  const fromEnv = resolveChannel({}, { CLAUDE_PLUGIN_OPTION_NTFY_URL: "https://ntfy.sh/topic", CLAUDE_PLUGIN_OPTION_NTFY_TOKEN: "tk" }, NO_FILE);
  assert.deepEqual([fromEnv.channel, fromEnv.ntfyUrl, fromEnv.ntfyToken], ["ntfy", "https://ntfy.sh/topic", "tk"]);
});

test("the per-machine notify file is read last, and writeMachineNotify merges and clears keys", async () => {
  const { writeMachineNotify, readMachineNotify } = await import("../../plugins/autoclaude/lib/notify.js");
  const file = path.join(tmpDir(), "autoclaude", "notify.json");
  writeMachineNotify({ discord_webhook: "https://discord.com/api/webhooks/1/abc", channel: "discord" }, file);
  assert.deepEqual(readMachineNotify(file), { discord_webhook: "https://discord.com/api/webhooks/1/abc", channel: "discord" });
  let r = resolveChannel({}, {}, file);
  assert.deepEqual([r.channel, r.discordWebhook], ["discord", "https://discord.com/api/webhooks/1/abc"]);
  r = resolveChannel({}, { CLAUDE_PLUGIN_OPTION_NTFY_URL: "https://ntfy.sh/t", CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "ntfy" }, file);
  assert.equal(r.channel, "ntfy");
  writeMachineNotify({ discord_webhook: null, ntfy_url: "https://ntfy.sh/mine" }, file);
  assert.deepEqual(readMachineNotify(file), { channel: "discord", ntfy_url: "https://ntfy.sh/mine" });
  assert.equal(resolveChannel({}, {}, file).channel, "stdout", "discord chosen but no webhook falls back to stdout");
  assert.deepEqual(readMachineNotify(path.join(tmpDir(), "missing.json")), {});
});

test("resolveChannel: a stored channel beats the auto choice, and a userConfig left on auto does not overrule it", () => {
  const file = path.join(tmpDir(), "notify.json");
  const both = { ntfy_url: "https://ntfy.sh/t", discord_webhook: "https://discord.com/api/webhooks/1/a" };
  fs.writeFileSync(file, JSON.stringify({ channel: "discord", ...both }));
  assert.equal(resolveChannel({}, {}, file).channel, "discord", "auto would have picked ntfy");
  assert.equal(resolveChannel({}, { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "auto" }, file).channel, "discord");
  assert.equal(resolveChannel({}, { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: " " }, file).channel, "discord");
  assert.equal(resolveChannel({ channel: "auto" }, {}, file).channel, "discord");
  assert.equal(resolveChannel({}, { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "ntfy" }, file).channel, "ntfy", "a userConfig that names a channel still wins");
  assert.equal(resolveChannel({ channel: "stdout" }, {}, file).channel, "stdout");
  fs.writeFileSync(file, JSON.stringify({ channel: "auto", ...both }));
  assert.equal(resolveChannel({}, {}, file).channel, "ntfy", "nothing named anywhere: auto prefers ntfy");
});

test("ntfy: posts title, priority, tags and bearer token, and logs the delivery", async () => {
  const { server, requests, url } = await startServer();
  const dir = tmpDir();
  const log = path.join(dir, "notify.log");
  const r = await notify({ title: "Step failed", message: "S1.2 failed 3 times\nsee report", priority: "high", tags: ["warning"] }, { ntfyUrl: url + "/topic", ntfyToken: "secret", logFile: log, stdout: new FakeOut(), machineFile: NO_FILE });
  server.close();
  assert.deepEqual([r.channel, r.ok, r.status, r.fallback], ["ntfy", true, 200, false]);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, "/topic");
  assert.equal(requests[0].headers.title, "Step failed");
  assert.equal(requests[0].headers.priority, "5");
  assert.equal(requests[0].headers.tags, "warning");
  assert.equal(requests[0].headers.authorization, "Bearer secret");
  assert.equal(requests[0].body, "S1.2 failed 3 times\nsee report");
  const logged = fs.readFileSync(log, "utf8");
  assert.match(logged, /\[high\] ntfy Step failed: S1\.2 failed 3 times \| see report -> 200/);
});

test("discord: posts a JSON content field with the title in bold", async () => {
  const { server, requests, url } = await startServer(204);
  const r = await notify({ title: "Plan complete", message: "12 steps" }, { discordWebhook: url + "/hook", stdout: new FakeOut(), machineFile: NO_FILE });
  server.close();
  assert.deepEqual([r.channel, r.ok, r.status], ["discord", true, 204]);
  assert.deepEqual(JSON.parse(requests[0].body), { content: "**Plan complete**\n12 steps" });
  assert.equal(requests[0].headers["content-type"], "application/json");
});

test("stdout channel prints and logs; a failing server falls back to stdout without throwing", async () => {
  const dir = tmpDir();
  const log = path.join(dir, "notify.log");
  const out = new FakeOut();
  const r1 = await notify({ title: "Hello", message: "world" }, { logFile: log, stdout: out, machineFile: NO_FILE });
  assert.deepEqual([r1.channel, r1.ok], ["stdout", true]);
  assert.match(out.text, /\[autoclaude default\] Hello\nworld\n/);

  const { server, url } = await startServer(500);
  const out2 = new FakeOut();
  const r2 = await notify({ title: "Oops", message: "x" }, { ntfyUrl: url + "/t", logFile: log, stdout: out2, machineFile: NO_FILE });
  server.close();
  assert.deepEqual([r2.channel, r2.ok, r2.fallback], ["ntfy", false, true]);
  assert.match(r2.error, /ntfy responded 500/);
  assert.match(out2.text, /delivery through ntfy failed/);
  assert.match(fs.readFileSync(log, "utf8"), /FAILED: ntfy responded 500/);
});

// ---------- configurable alerts (P8.6) ----------

test("SWITCHABLE_EVENTS are exactly the notify.events keys of the config defaults", async () => {
  const { SWITCHABLE_EVENTS } = await import("../../plugins/autoclaude/lib/notify.js");
  const { DEFAULTS } = await import("../../plugins/autoclaude/lib/config.js");
  assert.deepEqual([...SWITCHABLE_EVENTS], ["featureVerified", "stepVerified", "runStarted", "runResumed", "pausedByOwner"]);
  assert.deepEqual(Object.keys(DEFAULTS.notify.events), [...SWITCHABLE_EVENTS]);
});

test("eventEnabled: switchable events follow the config, falling back to the defaults; critical events are always on", async () => {
  const { eventEnabled } = await import("../../plugins/autoclaude/lib/notify.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  const defaults = mergeConfig({});
  assert.equal(eventEnabled(defaults, "featureVerified"), true);
  assert.equal(eventEnabled(defaults, "stepVerified"), false);
  assert.equal(eventEnabled(defaults, "runStarted"), false);
  const cfg = mergeConfig({ notify: { events: { featureVerified: false, stepVerified: true, runResumed: true } } });
  assert.deepEqual(["featureVerified", "stepVerified", "runResumed", "pausedByOwner"].map((e) => eventEnabled(cfg, e)), [false, true, true, false]);
  // Critical alerts cannot be switched off, even by a config that names them.
  const silenced = { notify: { events: { planComplete: false, blocked: false, stepFailed: false } } };
  for (const e of ["planComplete", "blocked", "stepFailed", "pushFailed", "anythingElse"]) assert.equal(eventEnabled(silenced, e), true, e);
  // No config at all: the built-in defaults.
  assert.equal(eventEnabled(null, "featureVerified"), true);
  assert.equal(eventEnabled({}, "pausedByOwner"), false);
});

test("notifyEvent: an event that is on is sent and logged in the project; one that is off is only logged as skipped", async () => {
  const { notifyEvent } = await import("../../plugins/autoclaude/lib/notify.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  const root = tmpDir();
  const log = path.join(root, ".autoclaude", "logs", "notify.log");
  const cfg = mergeConfig({});
  const out = new FakeOut();
  const r1 = await notifyEvent(root, cfg, "featureVerified", "Phase 2 (Admin page) passed: 5 steps, 14 Accept lines", { env: {}, machineFile: NO_FILE, stdout: out });
  assert.deepEqual([r1.event, r1.sent, r1.skipped, r1.channel, r1.ok], ["featureVerified", true, false, "stdout", true]);
  assert.match(out.text, /AutoClaude: feature verified\nPhase 2 \(Admin page\) passed/);
  assert.match(fs.readFileSync(log, "utf8"), /\[default\] stdout AutoClaude: feature verified: Phase 2 \(Admin page\) passed/);

  const calls = [];
  const fake = async (msg, opts) => { calls.push({ msg, opts }); return { channel: "ntfy", ok: true, status: 200, error: null, fallback: false }; };
  const r2 = await notifyEvent(root, cfg, "stepVerified", "S2.3 committed", { notify: fake });
  assert.deepEqual([r2.sent, r2.skipped], [false, true]);
  assert.equal(calls.length, 0, "a switched-off event is never sent");
  assert.match(fs.readFileSync(log, "utf8"), /skipped: event stepVerified is off/);

  // A critical event goes out even when every switchable one is off; message objects keep their fields.
  const allOff = mergeConfig({ notify: { events: { featureVerified: false, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false } } });
  const r3 = await notifyEvent(root, allOff, "planComplete", { title: "AutoClaude: plan complete", message: "28 of 28", priority: "high" }, { notify: fake, env: { X: "1" } });
  assert.equal(r3.sent, true);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].msg, { title: "AutoClaude: plan complete", message: "28 of 28", priority: "high" });
  assert.equal(calls[0].opts.logFile, log);
  assert.deepEqual(calls[0].opts.env, { X: "1" });
  assert.equal(calls[0].opts.notify, undefined, "the sender itself is not passed on");

  // Switched on by the owner: runStarted goes out; a sender that throws never breaks the caller.
  const on = mergeConfig({ notify: { events: { runStarted: true } } });
  const r4 = await notifyEvent(root, on, "runStarted", "Starting P1.1", { notify: async () => { throw new Error("boom"); } });
  assert.deepEqual([r4.sent, r4.ok, r4.error], [false, false, "boom"]);
  assert.match(fs.readFileSync(log, "utf8"), /event runStarted FAILED: boom/);
});

test("notifyEvent delivers a feature alert through a real ntfy endpoint", async () => {
  const { notifyEvent } = await import("../../plugins/autoclaude/lib/notify.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  const { server, requests, url } = await startServer();
  const root = tmpDir();
  const r = await notifyEvent(root, mergeConfig({}), "featureVerified", "Phase 1 passed", { ntfyUrl: url + "/topic", env: {}, machineFile: NO_FILE, stdout: new FakeOut() });
  server.close();
  assert.deepEqual([r.sent, r.channel, r.status], [true, "ntfy", 200]);
  assert.equal(requests[0].headers.title, "AutoClaude: feature verified");
  assert.equal(requests[0].body, "Phase 1 passed");
});
