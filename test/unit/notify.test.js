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

// ---------- the sweep-finished alert (P10.1, D58) ----------

// Findings whose details must never reach an alert: text, file, evidence, fix.
const DETAILED = [
  { severity: "critical", category: "secrets", file: "src/config/keys.js", line: 12, evidence: ["sk", "live", "ABCDEF0123456789"].join("_"), impact: "full account takeover", fix: "move it to the environment" },
  { severity: "high", category: "access-control", file: "src/routes/lists.js", line: 40, evidence: "GET /api/lists/:id has no owner check", impact: "reads other users' lists", fix: "check req.user.id" },
  { severity: "high", category: "xss", file: "src/views/item.html", line: 7, evidence: "innerHTML = name", impact: "script runs", fix: "textContent" },
  { severity: "low", category: "headers", file: "server.js", line: 3, evidence: "no CSP", impact: "weaker defence", fix: "add a CSP" },
  { severity: "bogus", file: "ignored.js" }
];

test("sweepFinishedAlert: title, counts by severity, the report path and what happens next, never a finding's details", async () => {
  const { sweepFinishedAlert, severityCounts } = await import("../../plugins/autoclaude/lib/notify.js");
  const root = path.join(os.tmpdir(), "my-app");
  const a = sweepFinishedAlert({
    kind: "security", project: "my-app", root, counts: DETAILED, uncertain: 2, refuted: [{}, {}, {}], accepted: 1,
    reportFile: path.join(root, ".autoclaude", "sweeps", "20261002-1430-security", "report.md"), after: "fix", durationMs: 72 * 60000
  });
  assert.equal(a.title, "AutoClaude: security sweep finished (my-app)");
  assert.equal(a.priority, "high", "critical or high security findings are urgent");
  assert.deepEqual(a.tags, ["lock"]);
  assert.match(a.message, /^The security sweep finished in 1 h 12 min\.$/m);
  assert.match(a.message, /^Confirmed: 4 findings \(1 critical, 2 high, 0 medium, 1 low\)\.$/m);
  assert.match(a.message, /^Also: 2 uncertain \(never fixed automatically\), 3 disproved, 1 accepted earlier\.$/m);
  assert.match(a.message, /^Report: \.autoclaude\/sweeps\/20261002-1430-security\/report\.md \(not committed\)\.$/m);
  assert.match(a.message, /^Next: the fix run starts on its own branch in a new window, working through SECURITY_PLAN\.md; its own alerts follow\.$/m);
  for (const f of DETAILED) {
    for (const v of [f.file, f.evidence, f.impact, f.fix, f.category]) if (v) assert.ok(!a.message.includes(v) && !a.title.includes(v), `"${v}" leaked into the alert`);
  }
  assert.deepEqual(severityCounts(DETAILED), { critical: 1, high: 2, medium: 0, low: 1 });
  assert.deepEqual(severityCounts({ critical: 2, high: "1", medium: -3, low: "x", extra: 9 }), { critical: 2, high: 1, medium: 0, low: 0 });
  assert.deepEqual(severityCounts(null), { critical: 0, high: 0, medium: 0, low: 0 });
});

test("sweepFinishedAlert: plan, report only, nothing found, an optimize sweep and paths outside the project", async () => {
  const { sweepFinishedAlert } = await import("../../plugins/autoclaude/lib/notify.js");
  const plan = sweepFinishedAlert({ kind: "optimize", project: "shop", counts: { medium: 3, low: 2 }, reportFile: ".autoclaude/sweeps/20261002-0900-optimize/report.md", after: "plan", durationMs: 45 * 60000 });
  assert.equal(plan.title, "AutoClaude: optimize sweep finished (shop)");
  assert.equal(plan.priority, "default");
  assert.deepEqual(plan.tags, ["white_check_mark"]);
  assert.match(plan.message, /finished in 45 min\./);
  assert.match(plan.message, /Confirmed: 5 findings \(0 critical, 0 high, 3 medium, 2 low\)\./);
  assert.match(plan.message, /^Next: review OPTIMIZE_PLAN\.md, then `autoclaude run --plan OPTIMIZE_PLAN\.md` to fix the findings\.$/m);
  assert.ok(!/Also:/.test(plan.message), "no line for zero uncertain, disproved or accepted findings");

  // A high optimize finding is not an emergency; a named CLI and plan file are used as given.
  const named = sweepFinishedAlert({ kind: "optimize", project: "shop", counts: { high: 1 }, after: "plan", planFile: "plans/OPT.md", cli: "node autoclaude.js" });
  assert.equal(named.priority, "default");
  assert.match(named.message, /review plans\/OPT\.md, then `node autoclaude\.js run --plan plans\/OPT\.md`/);
  assert.ok(!/Report:/.test(named.message), "no report line without a report");

  const report = sweepFinishedAlert({ kind: "security", project: "shop", counts: { low: 1 }, after: "report" });
  assert.equal(report.priority, "default", "low findings only");
  assert.match(report.message, /^Next: read the report\. Nothing in the project was changed\.$/m);

  // "fix" that could not start the run says why, in one line, and how to start it later.
  const refused = sweepFinishedAlert({ kind: "security", project: "shop", counts: { high: 1 }, after: "fix", planFile: "SECURITY_PLAN.md", fixRefused: "the checks are not green\n(unit)" });
  assert.match(refused.message, /^Next: the fix run did not start \(the checks are not green \(unit\)\)\. Review SECURITY_PLAN\.md, then `autoclaude run --plan SECURITY_PLAN\.md`\.$/m);
  assert.ok(!/fix run starts/.test(refused.message));
  assert.ok(sweepFinishedAlert({ kind: "security", counts: { low: 1 }, after: "fix", fixRefused: "x".repeat(500) }).message.length < 600, "a long reason is cut short");

  for (const after of ["fix", "plan"]) {
    const none = sweepFinishedAlert({ kind: "security", project: "shop", counts: {}, after });
    assert.match(none.message, /^Confirmed: no findings\.$/m);
    assert.match(none.message, /Next: nothing to fix/);
  }
  assert.match(sweepFinishedAlert({ kind: "security", counts: { low: 1 } }).message, /Confirmed: 1 finding \(/);

  // Project-relative with forward slashes; a file outside the project keeps its own path.
  const root = path.join(os.tmpdir(), "shop");
  const outside = path.join(os.tmpdir(), "elsewhere", "report.md");
  assert.ok(sweepFinishedAlert({ kind: "security", root, reportFile: outside }).message.includes(`Report: ${outside} (not committed).`));
  assert.match(sweepFinishedAlert({ kind: "security", root, reportFile: path.join(root, "out", "r.md") }).message, /Report: out\/r\.md /);
  assert.match(sweepFinishedAlert({ kind: "security", root, reportFile: path.join(root, "..x", "r.md") }).message, /Report: \.\.x\/r\.md /, "a folder whose name starts with two dots is still inside");
  assert.equal(sweepFinishedAlert({ kind: "security", root }).title, "AutoClaude: security sweep finished (shop)", "the project name falls back to the folder name");
});

test("sweepFinishedAlert: a sweep that stopped says so, urgently, without its error text", async () => {
  const { sweepFinishedAlert } = await import("../../plugins/autoclaude/lib/notify.js");
  const a = sweepFinishedAlert({ kind: "optimize", project: "shop", status: "failed", error: "agent area-3 quoted " + ["sk", "live", "ABCDEF0123456789"].join("_"), counts: DETAILED, durationMs: 10 * 60000, reportFile: ".autoclaude/sweeps/x/report.md" });
  assert.equal(a.title, "AutoClaude: optimize sweep stopped (shop)");
  assert.equal(a.priority, "high");
  assert.deepEqual(a.tags, ["warning"]);
  assert.match(a.message, /^The optimize sweep stopped before it finished, after 10 min\.$/m);
  assert.match(a.message, /What it found so far: \.autoclaude\/sweeps\/x\/report\.md\./);
  assert.match(a.message, /`autoclaude status` shows where it stopped/);
  assert.ok(!a.message.includes("sk_live") && !a.message.includes("area-3"), "the error text never reaches an alert");
  assert.ok(!/Confirmed:/.test(a.message), "no counts from an unfinished sweep");
});

test("notifySweepFinished: always sent, even with every switchable alert off, and logged in the project", async () => {
  const { notifySweepFinished, SWEEP_FINISHED_EVENT, SWITCHABLE_EVENTS, eventEnabled } = await import("../../plugins/autoclaude/lib/notify.js");
  const { mergeConfig } = await import("../../plugins/autoclaude/lib/config.js");
  assert.equal(SWEEP_FINISHED_EVENT, "sweepFinished");
  assert.ok(!SWITCHABLE_EVENTS.includes(SWEEP_FINISHED_EVENT));
  const allOff = mergeConfig({ notify: { events: { featureVerified: false, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false } } });
  assert.equal(eventEnabled(allOff, SWEEP_FINISHED_EVENT), true);
  assert.equal(eventEnabled({ notify: { events: { sweepFinished: false } } }, SWEEP_FINISHED_EVENT), true, "a config cannot switch it off");

  const root = path.join(tmpDir(), "proj");
  fs.mkdirSync(root);
  const calls = [];
  const fake = async (msg, opts) => { calls.push({ msg, opts }); return { channel: "discord", ok: true, status: 204, error: null, fallback: false }; };
  const r = await notifySweepFinished(root, allOff, { kind: "security", counts: { medium: 1 }, reportFile: path.join(root, ".autoclaude", "sweeps", "s", "report.md"), after: "report" }, { notify: fake });
  assert.deepEqual([r.event, r.sent, r.skipped, r.channel], ["sweepFinished", true, false, "discord"]);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].msg.title, "AutoClaude: security sweep finished (proj)");
  assert.match(calls[0].msg.message, /Report: \.autoclaude\/sweeps\/s\/report\.md/);
  assert.equal(calls[0].opts.logFile, path.join(root, ".autoclaude", "logs", "notify.log"));

  // Through the real sender on the stdout channel: printed and logged, nothing thrown.
  const out = new FakeOut();
  const r2 = await notifySweepFinished(root, allOff, { kind: "optimize", project: "proj", counts: {}, after: "fix" }, { env: {}, machineFile: NO_FILE, stdout: out });
  assert.deepEqual([r2.sent, r2.channel, r2.ok], [true, "stdout", true]);
  assert.match(out.text, /AutoClaude: optimize sweep finished \(proj\)\nThe optimize sweep finished\./);
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "notify.log"), "utf8"), /stdout AutoClaude: optimize sweep finished \(proj\): .*Confirmed: no findings/);
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
