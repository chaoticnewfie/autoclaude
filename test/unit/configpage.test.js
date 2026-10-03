import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import vm from "node:vm";
import { openConfigPage, browserCommand, maskSecret, LOCK_REASON, TOKEN_HEADER, FIELDS, SWEEP_FIELD_PATHS, CRITICAL_ALERTS } from "../../plugins/autoclaude/lib/configpage.js";
import { writeMachineNotify, readMachineNotify } from "../../plugins/autoclaude/lib/notify.js";
import { DEFAULTS, PROJECT_ONLY_KEYS, MAX_SWEEP_CONCURRENCY } from "../../plugins/autoclaude/lib/config.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-configpage-"));
// A throwaway Claude config dir: defaults.json, notify.json and the registry never touch the real ones.
const CFG_DIR = tmpDir();
process.env.CLAUDE_CONFIG_DIR = CFG_DIR;
const MACHINE = path.join(CFG_DIR, "autoclaude");
const DEFAULTS_FILE = path.join(MACHINE, "defaults.json");
const NOTIFY_FILE = path.join(MACHINE, "notify.json");
const REGISTRY_FILE = path.join(MACHINE, "registry.json");

beforeEach(() => fs.rmSync(MACHINE, { recursive: true, force: true }));

function makeProject(extra = {}) {
  const root = tmpDir();
  const cfg = { version: 1, plan: "PLAN.md", checks: [{ name: "unit", command: "npm test" }], usage: { weeklyPauseAtPct: 90 }, ...extra };
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify(cfg, null, 2) + "\n");
  return root;
}
const readProject = (root) => JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
const readDefaults = () => JSON.parse(fs.readFileSync(DEFAULTS_FILE, "utf8"));
function setStatus(root, status) {
  fs.mkdirSync(path.join(root, ".autoclaude"), { recursive: true });
  fs.writeFileSync(path.join(root, ".autoclaude", "state.json"), JSON.stringify({ version: 1, status }));
}

function fakeTasks(log) {
  return {
    watchdog: {
      status: async () => ({ installed: false, status: null }),
      install: async () => { log.push("watchdog install"); return { ok: true, message: "installed" }; },
      uninstall: async () => { log.push("watchdog uninstall"); return { ok: true, message: "removed" }; }
    },
    statusline: {
      status: async () => ({ installed: true }),
      install: async () => { log.push("statusline install"); return { ok: true, message: "already installed" }; },
      uninstall: async () => { log.push("statusline uninstall"); return { ok: true, message: "removed" }; }
    }
  };
}

// Starts the page for real on 127.0.0.1 and returns helpers that talk to it over http.
async function startPage({ root = null, deps = {}, idleMs } = {}) {
  const lines = [];
  const opened = [];
  const taskLog = [];
  let ready;
  const up = new Promise((resolve) => { ready = resolve; });
  const done = openConfigPage({
    root, io: { out: (s) => lines.push(s), env: {} }, openBrowser: (u) => opened.push(u), listen: (info) => ready(info),
    deps: { tasks: fakeTasks(taskLog), ...deps }, ...(idleMs ? { idleMs } : {})
  });
  const info = await up;
  const base = `http://127.0.0.1:${info.port}`;
  const api = async (method, p, body, headers = {}) => {
    const res = await fetch(base + p, {
      method,
      headers: { [TOKEN_HEADER]: info.token, ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, json, text, headers: res.headers };
  };
  const finish = async () => { await api("POST", "/api/done", {}); return done; };
  return { ...info, base, api, done, finish, lines, opened, taskLog };
}

function rawRequest(port, { path: p = "/api/state", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: p, method: "GET", headers }, (res) => {
      let body = "";
      res.on("data", (d) => (body += d));
      res.on("end", () => resolve({ status: res.statusCode, body }));
    });
    req.on("error", reject);
    req.end();
  });
}

test("the page opens on 127.0.0.1 behind a random token, prints the link and closes on Done", async () => {
  const root = makeProject();
  const pg = await startPage({ root });
  assert.match(pg.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=[0-9a-f]{48}$/);
  assert.deepEqual(pg.opened, [pg.url]);
  assert.ok(pg.lines.some((l) => l.includes(pg.url)), pg.lines.join("\n"));

  // The page itself: token in the query, a nonce'd inline script, nothing external.
  assert.equal((await fetch(pg.base + "/")).status, 403);
  assert.equal((await fetch(pg.base + "/?token=" + "0".repeat(48))).status, 403);
  const res = await fetch(pg.url);
  assert.equal(res.status, 200);
  const html = await res.text();
  const csp = res.headers.get("content-security-policy");
  const nonce = csp.match(/'nonce-([^']+)'/)[1];
  assert.match(csp, /default-src 'none'/);
  const script = html.match(/<script nonce="([^"]+)">([\s\S]*?)<\/script>/);
  assert.equal(script[1], nonce);
  assert.ok(!html.includes("__NONCE__"));
  assert.ok(!/<script[^>]+src=|<link[^>]+href=|@import|https?:\/\/(?!127\.0\.0\.1)[a-z]/i.test(html.replace(/placeholder: "[^"]*"|help: "[^"]*"|text: "[^"]*"/g, "")), "no external scripts, styles or fonts");
  new vm.Script(script[2], { filename: "configpage.html" }); // the page's script compiles
  for (const id of ["run", "alerts", "project", "computer", "tasks"]) assert.ok(html.includes(`#${id}`), id);
  assert.match(html, /prefers-color-scheme: dark/);

  const r = await pg.finish();
  assert.deepEqual([r.reason, r.url, r.saves], ["done", pg.url, 0]);
  await assert.rejects(fetch(pg.base + "/api/state"));
  assert.ok(pg.lines.some((l) => /settings page closed/.test(l)));
});

test("the API wants the token on every request and refuses other origins, host names and cross-site fetches", async () => {
  const pg = await startPage({ root: makeProject() });
  assert.equal((await pg.api("GET", "/api/state", undefined, { [TOKEN_HEADER]: "" })).status, 401);
  assert.equal((await pg.api("GET", "/api/state", undefined, { [TOKEN_HEADER]: "f".repeat(48) })).status, 401);
  assert.equal((await pg.api("GET", "/api/state", undefined, { [TOKEN_HEADER]: "short" })).status, 401);
  assert.equal((await fetch(pg.base + "/api/state?token=" + pg.token)).status, 401, "a token in the query is not enough for the API");
  assert.equal((await pg.api("GET", "/api/state", undefined, { Origin: "http://evil.example" })).status, 403);
  assert.equal((await pg.api("GET", "/api/state", undefined, { Origin: pg.base })).status, 200);
  assert.equal((await pg.api("GET", "/api/state", undefined, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await rawRequest(pg.port, { headers: { Host: `rebound.example:${pg.port}`, [TOKEN_HEADER]: pg.token } })).status, 403);
  assert.equal((await rawRequest(pg.port, { headers: { Host: `localhost:${pg.port}`, [TOKEN_HEADER]: pg.token } })).status, 200);
  assert.equal((await pg.api("POST", "/api/save", undefined, { "Content-Type": "text/plain" })).status, 415);
  assert.equal((await pg.api("GET", "/api/nothing")).status, 404);
  assert.equal((await pg.api("POST", "/api/done", {}, { [TOKEN_HEADER]: "nope" })).status, 401, "a stranger cannot close it either");
  await pg.finish();
});

test("state: every field with its value and source across the three layers", async () => {
  const root = makeProject();
  fs.mkdirSync(MACHINE, { recursive: true });
  fs.writeFileSync(DEFAULTS_FILE, JSON.stringify({ builder: { effort: "ultracode" }, checks: [] }));
  const pg = await startPage({ root });
  const { status, json: s } = await pg.api("GET", "/api/state");
  assert.equal(status, 200);
  assert.equal(s.root, root);
  assert.equal(s.running, false);
  assert.equal(s.merged.builder.effort, "ultracode");
  assert.equal(s.merged.usage.weeklyPauseAtPct, 90);
  assert.equal(s.sources.project["builder.effort"], "computer");
  assert.equal(s.sources.project["usage.weeklyPauseAtPct"], "project");
  assert.equal(s.sources.project["tester.model"], "built-in");
  assert.equal(s.sources.project["checks"], "project");
  assert.equal(s.sources.computer["builder.effort"], "computer");
  assert.equal(s.sources.computer["checks"], undefined, "project-only keys have no computer value");
  assert.ok(s.errors.some((e) => e.layer === "computer" && e.path === "checks"), "a project-only key in defaults.json is reported");
  assert.equal(s.builtin.gate.verifyAt, "phase");
  // Every setting of the config is on the page, apart from the version and the unused per-step minutes.
  const shown = new Set(FIELDS.map((f) => f.path));
  const leaves = [];
  const walk = (o, pre) => { for (const [k, v] of Object.entries(o)) { const p = pre ? `${pre}.${k}` : k; if (v && typeof v === "object" && !Array.isArray(v)) walk(v, p); else leaves.push(p); } };
  walk(DEFAULTS, "");
  const missing = leaves.filter((p) => !shown.has(p) && !["version", "retries.maxMinutesPerStep"].includes(p));
  assert.deepEqual(missing, []);
  assert.ok(FIELDS.filter((f) => f.section === "project").every((f) => PROJECT_ONLY_KEYS.includes(f.path.split(".")[0])));
  await pg.finish();
});

test("saving writes only the changed keys, to the right layer; reset removes a key", async () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8");
  const pg = await startPage({ root });

  let r = await pg.api("POST", "/api/save", { computer: { set: { "builder.effort": "ultracode", "notify.events.stepVerified": true } } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(readDefaults(), { builder: { effort: "ultracode" }, notify: { events: { stepVerified: true } } });
  assert.equal(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"), before, "the project file is untouched");

  r = await pg.api("POST", "/api/save", { project: { set: { "gate.verifyAt": "step", "notify.events.featureVerified": false }, reset: ["usage.weeklyPauseAtPct"] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(readProject(root), { version: 1, plan: "PLAN.md", checks: [{ name: "unit", command: "npm test" }], gate: { verifyAt: "step" }, notify: { events: { featureVerified: false } } });

  const s = (await pg.api("GET", "/api/state")).json;
  assert.equal(s.sources.project["gate.verifyAt"], "project");
  assert.equal(s.sources.project["usage.weeklyPauseAtPct"], "built-in");
  assert.equal(s.merged.usage.weeklyPauseAtPct, 85);
  assert.equal(s.sources.project["notify.events.stepVerified"], "computer");

  // Project-only lists are saved whole.
  r = await pg.api("POST", "/api/save", { project: { set: { checks: [{ name: "unit", command: "npm test" }, { name: "db", command: "npm run db:test", requires: "docker version" }], "permissions.allow": ["Bash(docker compose *)"] } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(readProject(root).checks[1].requires, "docker version");
  assert.deepEqual(readProject(root).permissions, { allow: ["Bash(docker compose *)"] });

  // Reset prunes the objects it empties.
  r = await pg.api("POST", "/api/save", { computer: { reset: ["builder.effort", "notify.events.stepVerified"] } });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(readDefaults(), {});
  const result = await pg.finish();
  assert.equal(result.saves, 4);
});

test("saving validates first and writes nothing when anything changed is wrong", async () => {
  const root = makeProject();
  const before = fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8");
  const pg = await startPage({ root });
  const bad = async (body, setting, re) => {
    const r = await pg.api("POST", "/api/save", body);
    assert.equal(r.status, 400, r.text);
    assert.equal(r.json.ok, false);
    const e = r.json.errors.find((x) => x.setting === setting);
    assert.ok(e, `no error for ${setting}: ${r.text}`);
    if (re) assert.match(e.message, re);
  };
  await bad({ project: { set: { "builder.effort": "turbo" } } }, "builder.effort", /ultracode/);
  await bad({ project: { set: { "tester.model": "haiku" } } }, "tester.model", /Haiku/);
  await bad({ project: { set: { checks: [{ name: "", command: "x" }] } } }, "checks", /must not be empty/);
  await bad({ project: { set: { "devServer.command": "npm run dev" } } }, "devServer.command", /both be set/);
  await bad({ project: { set: { "permissions.allow": ["ssh pve"] } } }, "permissions.allow", /permission rule/);
  await bad({ computer: { set: { checks: [] } } }, "checks", /belongs to a project/);
  await bad({ computer: { set: { "usage.weeklyPauseAtPct": 150 } } }, "usage.weeklyPauseAtPct", /1 to 100/);
  await bad({ project: { set: { "no.such.setting": 1 } } }, "no.such.setting", /not a setting/);
  // One bad change stops the good one in the same save.
  await bad({ project: { set: { "gate.verifyAt": "step" } }, computer: { set: { "notify.morningSummaryAt": "7am" } } }, "notify.morningSummaryAt", /07:30/);
  assert.equal(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"), before);
  assert.equal(fs.existsSync(DEFAULTS_FILE), false);
  await pg.finish();
});

test("during a run, settings outside the safe list are locked with the reason; safe ones save at once", async () => {
  const root = makeProject({ builder: { model: "opus" } });
  setStatus(root, "running");
  const pg = await startPage({ root });
  const s = (await pg.api("GET", "/api/state")).json;
  assert.equal(s.running, true);
  assert.equal(s.locked.project["tester.model"], LOCK_REASON);
  assert.equal(s.locked.project["checks"], LOCK_REASON);
  assert.equal(s.locked.project["notify.events.stepVerified"], undefined);
  assert.equal(s.locked.project["usage.weeklyPauseAtPct"], undefined);
  assert.match(s.locked.computer["tester.model"], /uses this computer's value/);
  assert.equal(s.locked.computer["builder.model"], undefined, "the project sets its own builder.model, so the computer default does not reach it");

  const before = fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8");
  let r = await pg.api("POST", "/api/save", { project: { set: { "tester.model": "sonnet" } } });
  assert.equal(r.status, 409);
  assert.equal(r.json.errors[0].message, LOCK_REASON);
  assert.equal(r.json.errors[0].locked, true);
  r = await pg.api("POST", "/api/save", { project: { reset: ["checks"] } });
  assert.equal(r.status, 409);
  r = await pg.api("POST", "/api/save", { computer: { set: { "tester.model": "sonnet" } } });
  assert.equal(r.status, 409);
  assert.equal(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"), before);

  r = await pg.api("POST", "/api/save", { project: { set: { "notify.events.stepVerified": true, "usage.weeklyPauseAtPct": 80, "review.pauseAt": "phase-end", "git.push": false } } });
  assert.equal(r.status, 200, r.text);
  assert.equal(readProject(root).usage.weeklyPauseAtPct, 80);
  r = await pg.api("POST", "/api/save", { computer: { set: { "builder.model": "sonnet", "usage.staleAfterMin": 20 } } });
  assert.equal(r.status, 200, r.text);

  // Paused: everything unlocks.
  setStatus(root, "paused");
  r = await pg.api("POST", "/api/save", { project: { set: { "tester.model": "sonnet" } } });
  assert.equal(r.status, 200, r.text);
  await pg.finish();
});

test("a computer default is locked while another registered project's run uses it", async () => {
  const other = makeProject();
  setStatus(other, "running");
  fs.mkdirSync(MACHINE, { recursive: true });
  fs.writeFileSync(REGISTRY_FILE, JSON.stringify({ projects: [{ root: other, name: path.basename(other) }, { root: path.join(other, "gone") }] }));
  const root = makeProject();
  const pg = await startPage({ root });
  let r = await pg.api("POST", "/api/save", { computer: { set: { "gate.verifyAt": "step" } } });
  assert.equal(r.status, 409);
  assert.ok(r.json.errors[0].message.startsWith(LOCK_REASON));
  assert.ok(r.json.errors[0].message.includes(path.basename(other)));
  r = await pg.api("POST", "/api/save", { project: { set: { "gate.verifyAt": "step" } } });
  assert.equal(r.status, 200, "this project is not running, so its own settings are free");
  await pg.finish();
});

test("alert channel: secrets are masked, Show fetches one, saving validates, and the test alert really goes out", async () => {
  const secret = "https://discord.com/api/webhooks/123/SECRETPART";
  writeMachineNotify({ channel: "discord", discord_webhook: secret, ntfy_token: "tk_SECRETTOKEN" }, NOTIFY_FILE);
  const pg = await startPage({ root: makeProject() });
  const st = await pg.api("GET", "/api/state");
  assert.ok(!st.text.includes("SECRETPART") && !st.text.includes("tk_SECRETTOKEN"), "the state never carries a secret");
  const a = st.json.alerts;
  assert.equal(a.channel, "discord");
  assert.equal(a.resolvedChannel, "discord");
  assert.deepEqual(a.secrets.discord_webhook, { set: true, masked: "https://discord.com/..." });
  assert.deepEqual(a.secrets.ntfy_token, { set: true, masked: "********" });
  assert.deepEqual(a.secrets.ntfy_url, { set: false, masked: "" });
  assert.deepEqual(a.switchable, ["featureVerified", "stepVerified", "runStarted", "runResumed", "pausedByOwner"]);
  assert.ok(a.critical.length >= 5);

  const shown = await pg.api("GET", "/api/secret?name=discord_webhook");
  assert.deepEqual(shown.json, { name: "discord_webhook", value: secret });
  assert.equal((await pg.api("GET", "/api/secret?name=channel")).status, 400);
  assert.equal((await pg.api("GET", "/api/secret?name=discord_webhook", undefined, { [TOKEN_HEADER]: "x" })).status, 401);

  let r = await pg.api("POST", "/api/notify", { discord_webhook: "https://example.com/hook" });
  assert.equal(r.status, 400);
  assert.equal(r.json.errors[0].setting, "discord_webhook");
  r = await pg.api("POST", "/api/notify", { channel: "pigeon" });
  assert.equal(r.status, 400);

  // Point the channel at a local ntfy endpoint and send the test through it for real.
  const got = [];
  const srv = http.createServer((req, res) => { let b = ""; req.on("data", (d) => (b += d)); req.on("end", () => { got.push({ headers: req.headers, body: b }); res.end("ok"); }); });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  const ntfyUrl = `http://127.0.0.1:${srv.address().port}/topic`;
  r = await pg.api("POST", "/api/notify", { channel: "ntfy", ntfy_url: ntfyUrl, ntfy_token: null });
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(readMachineNotify(NOTIFY_FILE), { channel: "ntfy", discord_webhook: secret, ntfy_url: ntfyUrl });
  r = await pg.api("POST", "/api/test-alert", {});
  srv.close();
  assert.deepEqual([r.json.ok, r.json.channel, r.json.status], [true, "ntfy", 200]);
  assert.equal(got.length, 1);
  assert.equal(got[0].headers.title, "AutoClaude test");
  assert.match(got[0].body, /Test alert from the settings page/);

  r = await pg.api("POST", "/api/notify", { channel: "auto", discord_webhook: "" });
  assert.equal(r.status, 200);
  assert.deepEqual(readMachineNotify(NOTIFY_FILE), { ntfy_url: ntfyUrl });
  await pg.finish();
});

// ---------- sweeps (P10.6, D58) ----------

test("the Sweeps group lists every sweep setting with plain help, ahead of Advanced, with the contract's choices", () => {
  const byPath = new Map(FIELDS.map((f) => [f.path, f]));
  assert.deepEqual([...SWEEP_FIELD_PATHS], ["sweep.depth", "sweep.after", "sweep.concurrency", "sweep.advisories", "sweep.waitAt5hPct", "sweep.maxTurnsPerAgent", "sweep.timeoutSecPerAgent"]);
  const sweeps = FIELDS.filter((f) => f.group === "Sweeps");
  assert.deepEqual(sweeps.map((f) => f.path), [...SWEEP_FIELD_PATHS], "the group holds exactly the sweep settings, in page order");
  for (const p of SWEEP_FIELD_PATHS) {
    const f = byPath.get(p);
    assert.equal(f.section, "run", p);
    assert.ok(f.label && f.help.length > 60, `${p} has a label and plain help`);
    assert.ok(!/\b(TODO|TBD)\b/.test(f.help), p);
  }
  assert.deepEqual([byPath.get("sweep.depth").type, [...byPath.get("sweep.depth").options].sort()], ["enum", ["quick", "standard", "thorough"]]);
  assert.equal(byPath.get("sweep.depth").options[0], "thorough", "the recommended depth comes first");
  assert.deepEqual([byPath.get("sweep.after").type, byPath.get("sweep.after").options], ["enum", ["fix", "plan", "report"]]);
  assert.equal(byPath.get("sweep.advisories").type, "bool");
  for (const p of ["sweep.concurrency", "sweep.waitAt5hPct", "sweep.maxTurnsPerAgent", "sweep.timeoutSecPerAgent"]) assert.equal(byPath.get(p).type, "int", p);
  assert.match(byPath.get("sweep.concurrency").help, new RegExp(`from 1 to ${MAX_SWEEP_CONCURRENCY}\\b`), "the help names the limit the config enforces");
  assert.match(byPath.get("sweep.advisories").help, /npm/);
  assert.match(byPath.get("sweep.advisories").help, /OSV/);
  // The page lists "sweep finished" among the alerts that are always sent.
  assert.equal(CRITICAL_ALERTS.filter((c) => /sweep finished/i.test(c)).length, 1);
  assert.match(CRITICAL_ALERTS.find((c) => /sweep finished/i.test(c)), /never the findings/);
  // Groups render in the order they first appear: Sweeps before Advanced.
  const order = [...new Set(FIELDS.filter((f) => f.section === "run" && f.group).map((f) => f.group))];
  assert.deepEqual(order, ["Sweeps", "Advanced"]);
  // The page's sweep settings are the config's, no more and no fewer.
  assert.deepEqual(Object.keys(DEFAULTS.sweep || {}).map((k) => `sweep.${k}`).sort(), [...SWEEP_FIELD_PATHS].sort());
  // Planning moves a committed findings file to a gitignored default (D58).
  assert.ok(byPath.has("docs.security"));
});

// Closes the page even when an assertion fails, so a failure never leaves the server up for
// its idle time (which would hold the whole test file open).
async function withPage(opts, body) {
  const pg = await startPage(opts);
  try { await body(pg); } finally { await pg.finish(); }
}

test("sweep settings show their values and save to the project and to this computer, validated like the rest", async () => {
  const root = makeProject();
  await withPage({ root }, async (pg) => {
    let s = (await pg.api("GET", "/api/state")).json;
    assert.deepEqual(
      SWEEP_FIELD_PATHS.map((p) => s.sources.project[p]),
      SWEEP_FIELD_PATHS.map(() => "built-in")
    );
    assert.equal(s.merged.sweep.depth, "thorough");
    assert.equal(s.merged.sweep.after, "fix");
    assert.equal(s.merged.sweep.concurrency, 3);
    assert.equal(s.merged.sweep.advisories, true);
    assert.ok(s.fields.some((f) => f.path === "sweep.depth" && f.group === "Sweeps"));
    // "sweep finished" is listed as always on, and it is not one of the switches.
    assert.ok(s.alerts.critical.some((c) => /sweep finished/i.test(c)), s.alerts.critical.join("; "));
    assert.ok(!s.alerts.switchable.includes("sweepFinished"));

    let r = await pg.api("POST", "/api/save", { project: { set: { "sweep.depth": "standard", "sweep.after": "report" } }, computer: { set: { "sweep.concurrency": 2, "sweep.advisories": false } } });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(readProject(root).sweep, { depth: "standard", after: "report" });
    assert.deepEqual(readDefaults(), { sweep: { concurrency: 2, advisories: false } });
    s = (await pg.api("GET", "/api/state")).json;
    assert.deepEqual(["sweep.depth", "sweep.concurrency", "sweep.waitAt5hPct"].map((p) => s.sources.project[p]), ["project", "computer", "built-in"]);
    assert.deepEqual([s.merged.sweep.depth, s.merged.sweep.concurrency, s.merged.sweep.advisories], ["standard", 2, false]);

    const before = fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8");
    for (const [p, v] of [["sweep.depth", "deep"], ["sweep.after", "later"], ["sweep.concurrency", 0], ["sweep.waitAt5hPct", 150], ["sweep.advisories", "yes"]]) {
      r = await pg.api("POST", "/api/save", { project: { set: { [p]: v } } });
      assert.equal(r.status, 400, `${p}=${JSON.stringify(v)}: ${r.text}`);
      assert.ok(r.json.errors.some((e) => e.setting === p), r.text);
    }
    assert.equal(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"), before, "nothing written by a refused save");

    r = await pg.api("POST", "/api/save", { project: { reset: ["sweep.depth", "sweep.after"] }, computer: { reset: ["sweep.concurrency", "sweep.advisories"] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(readProject(root).sweep, undefined);
    assert.deepEqual(readDefaults(), {});
  });
});

test("sweep settings stay editable during a run: they never change how a step is built or checked", async () => {
  const root = makeProject();
  setStatus(root, "running");
  await withPage({ root }, async (pg) => {
    const s = (await pg.api("GET", "/api/state")).json;
    for (const p of SWEEP_FIELD_PATHS) {
      assert.equal(s.locked.project[p], undefined, p);
      assert.equal(s.locked.computer[p], undefined, p);
    }
    const r = await pg.api("POST", "/api/save", { project: { set: { "sweep.concurrency": 1 } } });
    assert.equal(r.status, 200, r.text);
    assert.equal(readProject(root).sweep.concurrency, 1);
  });
});

test("computer tasks go through the injected watchdog and status line helpers", async () => {
  const pg = await startPage({ root: makeProject() });
  const t = await pg.api("GET", "/api/tasks");
  assert.deepEqual(t.json, { watchdog: { installed: false, status: null }, statusline: { installed: true } });
  let r = await pg.api("POST", "/api/task", { task: "watchdog", action: "install" });
  assert.deepEqual(r.json, { ok: true, message: "installed" });
  r = await pg.api("POST", "/api/task", { task: "statusline", action: "uninstall" });
  assert.equal(r.json.ok, true);
  assert.deepEqual(pg.taskLog, ["watchdog install", "statusline uninstall"]);
  assert.equal((await pg.api("POST", "/api/task", { task: "registry", action: "install" })).status, 400);
  assert.equal((await pg.api("POST", "/api/task", { task: "watchdog", action: "explode" })).status, 400);
  await pg.finish();
});

test("outside a project the page offers this computer's settings only", async () => {
  const pg = await startPage({ root: null });
  const s = (await pg.api("GET", "/api/state")).json;
  assert.equal(s.root, null);
  assert.deepEqual(s.sources.project, {});
  assert.ok(pg.lines.some((l) => /this computer/.test(l)));
  let r = await pg.api("POST", "/api/save", { project: { set: { "gate.verifyAt": "step" } } });
  assert.equal(r.status, 400);
  r = await pg.api("POST", "/api/save", { computer: { set: { "gate.verifyAt": "step" } } });
  assert.equal(r.status, 200);
  assert.deepEqual(readDefaults(), { gate: { verifyAt: "step" } });
  await pg.finish();
});

test("the page closes by itself after the idle time", async () => {
  const pg = await startPage({ root: makeProject(), idleMs: 150 });
  const r = await pg.done;
  assert.equal(r.reason, "idle");
  await assert.rejects(fetch(pg.base + "/api/state"));
});

test("browserCommand quotes the URL for cmd start on Windows and uses open or xdg-open elsewhere", () => {
  const url = "http://127.0.0.1:5123/?token=abc";
  const w = browserCommand(url, "win32");
  assert.equal(w.command, "cmd.exe");
  assert.deepEqual(w.args, ["/d", "/s", "/c", `"start "" "${url}""`]);
  assert.equal(w.options.windowsVerbatimArguments, true);
  assert.deepEqual([browserCommand(url, "darwin").command, browserCommand(url, "darwin").args], ["open", [url]]);
  assert.deepEqual([browserCommand(url, "linux").command, browserCommand(url, "linux").args], ["xdg-open", [url]]);
  assert.equal(maskSecret("discord_webhook", "https://discord.com/api/webhooks/1/abc"), "https://discord.com/...");
  assert.equal(maskSecret("ntfy_url", "https://ntfy.sh/my-topic"), "https://ntfy.sh/...");
  assert.equal(maskSecret("ntfy_url", ""), "");
});
