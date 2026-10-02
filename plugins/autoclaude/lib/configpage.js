// The settings page behind `autoclaude config` and /autoclaude:config (PLAN.md P8.7, D49).
// A local http server on 127.0.0.1, a random port and a random token in the URL; the page is
// templates/configpage.html (inline CSS and JS, nothing external). Node built-ins only.
//
// The JSON API wants the token in a header on every request, refuses other origins and host
// names (a web page elsewhere cannot drive it), and hands out a secret only through its own
// request, when the owner clicks Show.
import http from "node:http";
import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import {
  DEFAULTS, PROJECT_ONLY_KEYS, EFFORTS, isSafeLiveKey, loadLayers, readMachineDefaults, readProjectConfig,
  writeProjectConfig, writeMachineDefaults, validateConfig, mergeLayers, settingPathOf, getPath, setPath,
  deletePath, machineDefaultsFile, cleanMachineDefaults
} from "./config.js";
import { readMachineNotify, writeMachineNotify, resolveChannel, notify, SWITCHABLE_EVENTS } from "./notify.js";
import { loadState } from "./state.js";
import { loadRegistry } from "./registry.js";
import { machinePaths, pluginRoot } from "./paths.js";
import { readText, readJson } from "./fsatomic.js";

export const IDLE_MS = 30 * 60 * 1000;
export const LOCK_REASON = "changes how steps are built or checked; pause the run to change it";
export const TOKEN_HEADER = "x-autoclaude-token";
export const SECRET_KEYS = Object.freeze(["discord_webhook", "ntfy_url", "ntfy_token"]);
const CHANNELS = ["auto", "ntfy", "discord", "stdout"];
const MAX_BODY = 1024 * 1024;

// Shown on the page as always on: every alert that is not in SWITCHABLE_EVENTS.
export const CRITICAL_ALERTS = Object.freeze([
  "The run is blocked on a question for you",
  "A step or feature failed all its attempts and the run paused",
  "The run looks stuck, or keeps being denied",
  "A checker (browser tester, bug bash, security review) could not run",
  "Verified work could not be committed, or a push failed",
  "Paused for your review, for a security finding, or at the weekly usage limit",
  "The session is waiting for a person",
  "The plan is complete"
]);

// Every setting the page shows, in page order. section: run | alerts | project. type drives the
// control: bool, int, enum, enum-null, model, time-null, string, string-null, path, strings,
// multi, rows. Explanations are plain words for the owner; defaults come from DEFAULTS.
const f = (p, section, type, label, help, extra = {}) => ({ path: p, section, type, label, help, ...extra });
export const FIELDS = Object.freeze([
  f("gate.verifyAt", "run", "enum", "When to verify", "phase: each step is committed as it is built, and the full verification (checks, browser tester, bug bash, security review) runs once when the step that closes the feature is ready. step: all of it after every step, which is slower.", { options: ["phase", "step"] }),
  f("review.pauseAt", "run", "enum", "Pause for your review", "phase-end: stop after each verified feature so you can look and leave notes; every-step: after every step; never: run to the end.", { options: ["never", "phase-end", "every-step"] }),
  f("retries.maxAttemptsPerStep", "run", "int", "Attempts before it pauses", "How many times a step, or a whole feature when verifying per feature, may fail verification before the run pauses and alerts you."),
  f("retries.maxNoProgressStops", "run", "int", "Stops without progress", "How many times in a row the session may stop without using a tool or committing before the run counts as stuck."),
  f("builder.model", "run", "model", "Builder model", "The model that writes the code. opus or sonnet always mean the newest of each; a full claude-opus-* or claude-sonnet-* id pins one. Haiku is not allowed."),
  f("builder.effort", "run", "enum-null", "Builder effort", "Reasoning effort for the builder. Left on your Claude Code default, the builder works the way your own sessions do. ultracode runs at xhigh: a run never uses its multi-agent workflows. The tester, bug bash and security review always use your Claude Code default.", { options: [...EFFORTS], nullLabel: "Your Claude Code default" }),
  f("tester.enabled", "run", "bool", "Browser tester", "Open the app in a headless browser and check the feature's Accept lines. Needs the dev server below."),
  f("tester.model", "run", "model", "Browser tester model", "The model that drives the browser checks."),
  f("tester.maxTurns", "run", "int", "Browser tester turns", "Turns the tester may take for every 5 Accept lines (at most 4 times this for a big feature)."),
  f("tester.timeoutSec", "run", "int", "Browser tester time limit (seconds)", "How long one browser check may take."),
  f("bugBash.atPhaseEnd", "run", "bool", "Bug bash", "After a feature passes, a short exploratory hunt for bugs in the browser."),
  f("security.when", "run", "multi", "Security review runs", "phase-end: when each feature is verified; tag:security: on steps tagged security; every-step: after every step; never: not at all.", { options: ["phase-end", "tag:security", "every-step", "never"] }),
  f("security.blockOn", "run", "enum", "Security findings that fail the feature", "The lowest severity that fails verification. Lower findings are logged and get a fix-up pass; none: a finding never fails it.", { options: ["high", "medium", "low", "none"] }),
  f("security.model", "run", "model", "Security review model", "The model that reviews the changes for security problems."),
  f("security.timeoutSec", "run", "int", "Security review time limit (seconds)", "How long one security review may take."),
  f("usage.weeklyPauseAtPct", "run", "int", "Pause at weekly usage (%)", "Pause the run when your 7-day Claude usage reaches this percent, so some is left for you. From 1 to 100."),
  f("usage.autoResumeAfterWeeklyReset", "run", "bool", "Resume after the weekly reset", "After a weekly-limit pause, carry on by itself once the 7-day window resets."),
  f("usage.staleAfterMin", "run", "int", "Usage numbers count as old after (minutes)", "Older usage numbers are not trusted, and the weekly pause waits for fresh ones (any Claude Code session with the status line bridge refreshes them)."),
  f("git.commitEachStep", "run", "bool", "Commit each step", "The gate commits every step it accepts on the run branch. Off: the work is left uncommitted for you."),
  f("git.push", "run", "bool", "Push after each feature", "Push the run branch and the feature's tag after each verified feature, retrying once. A failed push is alerted and listed in HANDOFF.md."),
  f("git.tagPhaseEnds", "run", "bool", "Tag each finished feature", "Tag the commit that completes a feature."),
  f("footprint.docker", "run", "bool", "Clean up Docker at the end", "When the plan is complete, remove stopped containers, unused volumes and unused networks the run created for this project. Anything new it cannot tie to this project is left alone and listed in HANDOFF.md; nothing that was there before the run is touched."),
  f("gate.timeoutSec", "run", "int", "Verification time limit (seconds)", "How long one verification may take, at most 1800 (Claude Code's limit for the Stop hook).", { group: "Advanced" }),
  f("supervisor.pollSec", "run", "int", "Supervisor check interval (seconds)", "How often the supervisor looks at the builder session.", { group: "Advanced" }),
  f("supervisor.idleRelaunchMin", "run", "int", "Restart an idle session after (minutes)", "A builder session that sits waiting this long is restarted.", { group: "Advanced" }),
  f("supervisor.stallMin", "run", "int", "Count a silent session as stalled after (minutes)", "No activity for this long and the session is restarted.", { group: "Advanced" }),
  f("supervisor.resumeGraceMin", "run", "int", "Grace after a resume (minutes)", "How long a resumed session gets to show activity before it is restarted.", { group: "Advanced" }),
  f("supervisor.rateLimitGraceMin", "run", "int", "Wait past a rate-limit reset (minutes)", "After a rate limit, how long past the reset time the supervisor waits before it relaunches.", { group: "Advanced" }),
  f("supervisor.maxRecoveries", "run", "int", "Restarts before it counts as stuck", "Restarts without progress before the run pauses as stuck and alerts you.", { group: "Advanced" }),

  f("notify.events.featureVerified", "alerts", "bool", "A feature is verified", "One alert each time a whole feature passes its checks."),
  f("notify.events.stepVerified", "alerts", "bool", "Each step is accepted", "One alert for every step the gate accepts (with per-feature verification, when it is committed)."),
  f("notify.events.runStarted", "alerts", "bool", "A run starts", "When autoclaude run or /autoclaude:start begins a run."),
  f("notify.events.runResumed", "alerts", "bool", "A run resumes", "When a paused run is resumed."),
  f("notify.events.pausedByOwner", "alerts", "bool", "You pause the run", "A confirmation when you run autoclaude pause: at once for --now, and when the pause is requested for the plain form (the run then pauses after the current step is committed)."),
  f("notify.morningSummaryAt", "alerts", "time-null", "Morning summary", "A short summary once a day at this local time while a run is going. Empty: none."),

  f("plan", "project", "path", "Plan file", "The plan the run works through, relative to the project folder."),
  f("branch", "project", "string", "Run branch", "The branch the run commits to. {planSlug} is replaced with the plan's name."),
  f("devServer.command", "project", "string-null", "Dev server command", "Starts the app for the browser tester, for example npm run dev. Set both this and the URL, or neither."),
  f("devServer.url", "project", "string-null", "Dev server URL", "Where the app answers once started, for example http://127.0.0.1:3000."),
  f("devServer.healthPath", "project", "string", "Health path", "The path that must answer before the app counts as up."),
  f("devServer.startTimeoutSec", "project", "int", "Dev server start time limit (seconds)", "How long the app may take to come up."),
  f("checks", "project", "rows", "Checks", "Commands the gate runs to verify, in order; a check fails when its command exits non-zero. Requires: a command the preflight runs first, for example docker version.", {
    columns: [
      { key: "name", label: "Name", type: "string", required: true },
      { key: "command", label: "Command", type: "string", required: true },
      { key: "timeoutSec", label: "Time limit (s)", type: "int" },
      { key: "needsDevServer", label: "Needs dev server", type: "bool" },
      { key: "requires", label: "Requires", type: "string" }
    ]
  }),
  f("guard.deny", "project", "rows", "Deny rules", "Bash commands the run may never execute in this project, on top of the built-in list. A pattern is a case-insensitive regular expression.", {
    columns: [
      { key: "pattern", label: "Pattern", type: "string", required: true },
      { key: "reason", label: "Reason", type: "string" }
    ]
  }),
  f("permissions.allow", "project", "strings", "Pre-approved actions", "Claude Code permission rules for what the plan allows, one per line, for example Bash(ssh buildhost *). The builder runs them without asking, and auto mode does not second-guess them (protected paths aside)."),
  f("permissions.environment", "project", "strings", "Trusted infrastructure for auto mode", "Plain sentences that tell auto mode what this project may reach, one per line, for example: The build server buildhost.lan is ours to deploy to."),
  ...Object.keys(DEFAULTS.docs).map((k) => f(`docs.${k}`, "project", "path", `Doc file: ${k}`, "Relative to the project folder.", { group: "Doc files" }))
]);

const FIELD_BY_PATH = new Map(FIELDS.map((x) => [x.path, x]));
const isProjectOnly = (p) => PROJECT_ONLY_KEYS.includes(String(p).split(".")[0]);
const samePath = (a, b) => path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();

// "https://discord.com/api/webhooks/1/abc" -> "https://discord.com/...": the host only, never the secret part.
export function maskSecret(name, value) {
  if (!value) return "";
  if (name === "ntfy_token") return "********";
  const m = String(value).match(/^(https?:\/\/[^/]+\/)/i);
  return m ? `${m[1]}...` : "********";
}

// Which runs a change could reach: this project's (a project setting) and every running
// project on this computer that takes the value from the computer layer (a computer default).
function runContext(root) {
  const here = root ? loadState(root) : null;
  const running = !!here && here.status === "running";
  const runs = running ? [{ root, raw: readProjectConfig(root).raw }] : [];
  for (const p of loadRegistry().projects) {
    if (!p || typeof p.root !== "string" || (root && samePath(p.root, root))) continue;
    let st;
    try { st = loadState(p.root); } catch { continue; }
    if (st.status === "running") runs.push({ root: p.root, raw: readProjectConfig(p.root).raw });
  }
  return { running, status: here ? here.status : null, runs };
}

export function lockReasonFor(layer, dotted, ctx) {
  if (isSafeLiveKey(dotted)) return null;
  if (layer === "project") return ctx.running ? LOCK_REASON : null;
  const users = ctx.runs.filter((r) => getPath(r.raw, dotted) === undefined);
  return users.length ? `${LOCK_REASON} (the run in ${users.map((u) => path.basename(u.root)).join(", ")} uses this computer's value)` : null;
}

function applyChanges(raw, changes) {
  const next = structuredClone(raw || {});
  for (const p of changes.reset) deletePath(next, p);
  for (const [p, v] of Object.entries(changes.set)) setPath(next, p, v);
  return next;
}

// An error at "checks[1].name" belongs to the setting "checks"; "devServer" to "devServer.url".
function relatedSetting(errorPath, changed) {
  const e = settingPathOf(errorPath);
  return changed.find((c) => e === c || e.startsWith(c + ".") || c.startsWith(e + ".")) || null;
}

function normalizeChanges(x) {
  if (x === undefined || x === null) return { set: {}, reset: [] };
  if (typeof x !== "object" || Array.isArray(x)) throw new Error("expected { set, reset }");
  const set = x.set && typeof x.set === "object" && !Array.isArray(x.set) ? x.set : {};
  const reset = Array.isArray(x.reset) ? x.reset.map(String) : [];
  return { set, reset };
}

function defaultTasks(env) {
  const message = (e) => String(e && e.message ? e.message : e);
  return {
    watchdog: {
      async status() { const w = await import("./watchdog.js"); return w.watchdogStatus({ env }); },
      async install() {
        const w = await import("./watchdog.js");
        const r = w.installWatchdog({ env });
        return { ok: r.ok, message: r.ok ? "installed" : `${String(r.stderr || r.error || "failed").trim()}${r.cronLine ? ` Add this line with crontab -e: ${r.cronLine}` : ""}` };
      },
      async uninstall() {
        const w = await import("./watchdog.js");
        const r = w.uninstallWatchdog({ env });
        return { ok: r.ok, message: r.ok ? `${r.wasInstalled === false ? "was not installed" : "removed"}${r.manual ? `. ${r.manual}` : ""}` : String(r.stderr || "failed").trim() };
      }
    },
    statusline: {
      async status() {
        const s = await import("./statusline.js");
        try {
          const cur = readJson(s.settingsFile(), null);
          return { installed: !!(cur && cur.statusLine && s.isBridgeCommand(cur.statusLine.command)) };
        } catch (e) { return { installed: false, error: `settings.json could not be read: ${message(e)}` }; }
      },
      async install() {
        const s = await import("./statusline.js");
        try {
          const r = s.installStatusline();
          return { ok: true, message: r.alreadyInstalled ? "already installed" : `installed${r.chained ? "; your previous status line still shows" : ""}` };
        } catch (e) { return { ok: false, message: message(e) }; }
      },
      async uninstall() {
        const s = await import("./statusline.js");
        try {
          const r = s.uninstallStatusline();
          return { ok: true, message: r.removed ? (r.restored ? "removed; your previous status line is back" : "removed") : "was not installed" };
        } catch (e) { return { ok: false, message: message(e) }; }
      }
    }
  };
}

// The request handler and everything it needs; openConfigPage puts it behind a server.
// deps: { notify, tasks: { watchdog, statusline }, machineFile, notifyFile } (tests).
export function createConfigApp({ root = null, env = process.env, deps = {}, token = crypto.randomBytes(24).toString("hex"), onDone = () => {} } = {}) {
  const machineFile = deps.machineFile || machineDefaultsFile();
  const notifyFile = deps.notifyFile || machinePaths().notifyFile;
  const tasks = { ...defaultTasks(env), ...(deps.tasks || {}) };
  const send = deps.notify || notify;
  const tokenBuf = Buffer.from(token);
  const nonce = crypto.randomBytes(16).toString("base64");
  let port = null;
  let saves = 0;

  const tokenOk = (v) => {
    if (typeof v !== "string") return false;
    const b = Buffer.from(v);
    return b.length === tokenBuf.length && crypto.timingSafeEqual(b, tokenBuf);
  };

  function statePayload() {
    const layers = loadLayers(root, { machineFile });
    const ctx = runContext(root);
    const computerMerged = mergeLayers(layers.machine);
    const sources = { project: {}, computer: {} };
    const locked = { project: {}, computer: {} };
    for (const x of FIELDS) {
      if (root) {
        sources.project[x.path] = layers.sourceOf(x.path);
        const l = lockReasonFor("project", x.path, ctx);
        if (l) locked.project[x.path] = l;
      }
      if (!isProjectOnly(x.path)) {
        sources.computer[x.path] = getPath(layers.machine, x.path) !== undefined ? "computer" : "built-in";
        const l = lockReasonFor("computer", x.path, ctx);
        if (l) locked.computer[x.path] = l;
      }
    }
    const stored = readMachineNotify(notifyFile);
    const secrets = {};
    for (const k of SECRET_KEYS) secrets[k] = { set: !!stored[k], masked: maskSecret(k, stored[k]) };
    return {
      root, projectName: root ? path.basename(root) : null, projectExists: layers.projectExists, projectFile: layers.projectFile,
      machineFile, running: ctx.running, runStatus: ctx.status, lockReason: LOCK_REASON,
      fields: FIELDS, projectOnlyKeys: PROJECT_ONLY_KEYS,
      builtin: layers.builtin, computer: layers.machine, project: layers.project, merged: layers.merged, computerMerged,
      sources, locked, errors: layers.errors,
      alerts: {
        switchable: SWITCHABLE_EVENTS, critical: CRITICAL_ALERTS, notifyFile,
        channel: stored.channel || "auto", resolvedChannel: resolveChannel({}, {}, notifyFile).channel, secrets
      }
    };
  }

  function save(body) {
    const ctx = runContext(root);
    const errors = [];
    const changes = {};
    for (const layer of ["project", "computer"]) {
      try { changes[layer] = normalizeChanges(body[layer]); } catch (e) { errors.push({ layer, path: "", message: e.message }); continue; }
      const c = changes[layer];
      for (const p of [...Object.keys(c.set), ...c.reset]) {
        const err = (message, extra = {}) => errors.push({ layer, path: p, setting: p, message, ...extra });
        if (!FIELD_BY_PATH.has(p)) { err("is not a setting this page can change"); continue; }
        if (layer === "computer" && isProjectOnly(p)) { err("belongs to a project; it cannot be a computer default"); continue; }
        if (layer === "project" && !root) { err("there is no project here; open the page from inside a project"); continue; }
        const lock = lockReasonFor(layer, p, ctx);
        if (lock) err(lock, { locked: true });
      }
    }
    if (errors.length) return { status: errors.some((e) => e.locked) ? 409 : 400, body: { ok: false, errors } };

    const touched = (c) => Object.keys(c.set).length + c.reset.length > 0;
    const m = readMachineDefaults(machineFile);
    // Writing over a file that does not parse would lose whatever the owner had in it.
    if (touched(changes.computer) && m.broken) return { status: 400, body: { ok: false, errors: [{ layer: "computer", path: "", message: `${machineFile} is not valid JSON; fix or delete it first` }] } };
    const nextMachineRaw = applyChanges(m.raw, changes.computer);
    const machineChanged = [...Object.keys(changes.computer.set), ...changes.computer.reset];
    const cleaned = cleanMachineDefaults(nextMachineRaw);
    // Only problems with what is being changed block the save; older ones are shown, not fatal.
    for (const e of cleaned.problems) {
      const s = relatedSetting(e.path, machineChanged);
      if (s) errors.push({ layer: "computer", path: e.path, setting: s, message: e.message.replace(/; ignored$/, "") });
    }
    let nextProjectRaw = null;
    if (touched(changes.project)) {
      const pr = readProjectConfig(root);
      if (!pr.exists) errors.push({ layer: "project", path: "", message: "this project has no autoclaude.config.json yet; run autoclaude init first" });
      else if (pr.error) errors.push({ layer: "project", path: "", message: `autoclaude.config.json ${pr.error}; fix it by hand first` });
      else {
        nextProjectRaw = applyChanges(pr.raw, changes.project);
        const projectChanged = [...Object.keys(changes.project.set), ...changes.project.reset];
        for (const e of validateConfig(mergeLayers(cleaned.values, nextProjectRaw))) {
          const s = relatedSetting(e.path, projectChanged);
          if (s) errors.push({ layer: "project", path: e.path, setting: s, message: e.message });
        }
      }
    }
    if (errors.length) return { status: 400, body: { ok: false, errors } };

    const written = [];
    if (touched(changes.computer)) written.push(writeMachineDefaults(nextMachineRaw, machineFile));
    if (nextProjectRaw) written.push(writeProjectConfig(root, nextProjectRaw));
    if (written.length) saves++;
    return { status: 200, body: { ok: true, written } };
  }

  function saveNotify(body) {
    const values = {};
    const errors = [];
    const bad = (p, message) => errors.push({ layer: "alerts", path: p, setting: p, message });
    if (Object.hasOwn(body, "channel")) {
      const c = String(body.channel ?? "auto").trim().toLowerCase() || "auto";
      if (!CHANNELS.includes(c)) bad("channel", `expected one of ${CHANNELS.join(", ")}`);
      else values.channel = c === "auto" ? null : c;
    }
    for (const k of SECRET_KEYS) {
      if (!Object.hasOwn(body, k)) continue;
      const v = body[k];
      if (v === null || v === "") { values[k] = null; continue; }
      if (typeof v !== "string") { bad(k, "expected text"); continue; }
      values[k] = v.trim();
    }
    if (values.ntfy_url && !/^https?:\/\/\S+$/i.test(values.ntfy_url)) bad("ntfy_url", "needs a full topic URL such as https://ntfy.sh/your-topic");
    if (values.discord_webhook && !/^https:\/\/(discord\.com|discordapp\.com)\/api\/webhooks\/\S+$/i.test(values.discord_webhook)) bad("discord_webhook", "needs a Discord webhook URL (https://discord.com/api/webhooks/...)");
    if (values.ntfy_token && /\s/.test(values.ntfy_token)) bad("ntfy_token", "a token has no spaces");
    if (errors.length) return { status: 400, body: { ok: false, errors } };
    if (Object.keys(values).length) { writeMachineNotify(values, notifyFile); saves++; }
    return { status: 200, body: { ok: true, written: Object.keys(values).length ? [notifyFile] : [] } };
  }

  async function testAlert() {
    const host = env.COMPUTERNAME || env.HOSTNAME || os.hostname();
    const quiet = { write() { return true; } };
    const r = await send(
      { title: "AutoClaude test", message: `Test alert from the settings page on ${host} at ${new Date().toISOString()}`, priority: "default", tags: ["white_check_mark"] },
      { logFile: path.join(machinePaths().logsDir, "notify.log"), stdout: quiet, env: {}, machineFile: notifyFile }
    );
    return { status: 200, body: { ok: !!(r && r.ok && !r.fallback), channel: r && r.channel, status: r && r.status, error: r && r.error, fallback: !!(r && r.fallback) } };
  }

  async function taskStatus() {
    const out = {};
    for (const name of ["watchdog", "statusline"]) {
      try { out[name] = await tasks[name].status(); } catch (e) { out[name] = { installed: false, error: String(e && e.message ? e.message : e) }; }
    }
    return { status: 200, body: out };
  }

  async function runTask(body) {
    const t = tasks[body.task];
    if (!t || !["install", "uninstall"].includes(body.action)) return { status: 400, body: { ok: false, error: "task must be watchdog or statusline, action install or uninstall" } };
    try {
      const r = await t[body.action]();
      return { status: 200, body: { ok: !!(r && r.ok), message: r && r.message } };
    } catch (e) {
      return { status: 200, body: { ok: false, message: String(e && e.message ? e.message : e) } };
    }
  }

  function page() {
    const html = readText(path.join(pluginRoot(), "templates", "configpage.html"), null);
    if (html === null) return "<!doctype html><title>AutoClaude settings</title><p>The page template is missing from the plugin (templates/configpage.html).</p>";
    return html.replace(/__NONCE__/g, nonce);
  }

  const baseHeaders = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY" };
  const reply = (res, status, body) => {
    const text = JSON.stringify(body);
    res.writeHead(status, { ...baseHeaders, "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text) });
    res.end(text);
  };
  const plain = (res, status, text) => {
    res.writeHead(status, { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" });
    res.end(text);
  };

  function readBody(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (d) => {
        size += d.length;
        if (size > MAX_BODY) { reject(new Error("request too large")); req.destroy(); return; }
        chunks.push(d);
      });
      req.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        if (!text.trim()) return resolve({});
        try {
          const j = JSON.parse(text);
          resolve(j && typeof j === "object" && !Array.isArray(j) ? j : {});
        } catch { reject(new Error("the request body is not valid JSON")); }
      });
      req.on("error", reject);
    });
  }

  async function handle(req, res) {
    const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    // A page on another site, or a DNS name rebound to 127.0.0.1, gets nothing.
    if (!hosts.includes(String(req.headers.host || ""))) return plain(res, 403, "Forbidden host.");
    const origin = req.headers.origin;
    if (origin && !hosts.map((h) => `http://${h}`).includes(origin)) return plain(res, 403, "Forbidden origin.");
    const site = req.headers["sec-fetch-site"];
    const url = new URL(req.url, `http://127.0.0.1:${port}`);

    if (url.pathname === "/" && req.method === "GET") {
      if (!tokenOk(url.searchParams.get("token"))) return plain(res, 403, "This page needs the link that autoclaude config printed.");
      const html = page();
      res.writeHead(200, {
        ...baseHeaders,
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`
      });
      return res.end(html);
    }
    if (!url.pathname.startsWith("/api/")) return plain(res, 404, "Not found.");
    if (site && site !== "same-origin" && site !== "none") return reply(res, 403, { ok: false, error: "cross-site requests are refused" });
    if (!tokenOk(req.headers[TOKEN_HEADER])) return reply(res, 401, { ok: false, error: "missing or wrong token" });

    let body = {};
    if (req.method === "POST") {
      if (!/^application\/json\b/i.test(String(req.headers["content-type"] || ""))) return reply(res, 415, { ok: false, error: "send JSON" });
      try { body = await readBody(req); } catch (e) { return reply(res, 400, { ok: false, error: e.message }); }
    }
    const route = `${req.method} ${url.pathname}`;
    let out;
    switch (route) {
      case "GET /api/state": out = { status: 200, body: statePayload() }; break;
      case "GET /api/secret": {
        const name = url.searchParams.get("name");
        if (!SECRET_KEYS.includes(name)) { out = { status: 400, body: { ok: false, error: `name must be one of ${SECRET_KEYS.join(", ")}` } }; break; }
        out = { status: 200, body: { name, value: readMachineNotify(notifyFile)[name] || "" } };
        break;
      }
      case "POST /api/save": out = save(body); break;
      case "POST /api/notify": out = saveNotify(body); break;
      case "POST /api/test-alert": out = await testAlert(); break;
      case "GET /api/tasks": out = await taskStatus(); break;
      case "POST /api/task": out = await runTask(body); break;
      case "POST /api/done":
        reply(res, 200, { ok: true });
        setImmediate(() => onDone("done"));
        return;
      default: out = { status: 404, body: { ok: false, error: "no such API" } };
    }
    return reply(res, out.status, out.body);
  }

  return {
    token,
    handle: (req, res) => handle(req, res).catch((e) => { try { reply(res, 500, { ok: false, error: String(e && e.message ? e.message : e) }); } catch {} }),
    setPort(p) { port = p; },
    get saves() { return saves; }
  };
}

// Opens the default browser on the URL. Windows: start through cmd with the URL quoted, as
// Node's own shell spawns do (the whole command wrapped in quotes that /s strips).
export function browserCommand(url, platform = process.platform) {
  const options = { detached: true, stdio: "ignore", windowsHide: true };
  if (platform === "win32") return { command: "cmd.exe", args: ["/d", "/s", "/c", `"start "" "${url}""`], options: { ...options, windowsVerbatimArguments: true } };
  if (platform === "darwin") return { command: "open", args: [url], options };
  return { command: "xdg-open", args: [url], options };
}

export function defaultOpenBrowser(url, platform = process.platform) {
  const { command, args, options } = browserCommand(url, platform);
  const child = spawn(command, args, options);
  child.on("error", () => {});
  child.unref();
  return true;
}

// Starts the page and resolves when the owner clicks Done, or after IDLE_MS without a request:
// { url, reason: "done" | "idle", saves }. openBrowser(url) is injectable; listen, when a
// function, is called with { url, port, token, close } once the server is up (tests, callers
// that want the address before the page closes).
export async function openConfigPage({ root = null, io = {}, openBrowser = null, listen = null, deps = {}, idleMs = IDLE_MS } = {}) {
  const out = (s) => (io && typeof io.out === "function" ? io.out(s) : process.stdout.write(s + "\n"));
  const env = (io && io.env) || process.env;
  const open = openBrowser || (io && io.deps && io.deps.openBrowser) || defaultOpenBrowser;
  let finish;
  const finished = new Promise((resolve) => { finish = resolve; });
  const app = createConfigApp({ root, env, deps, onDone: (reason) => close(reason) });
  const server = http.createServer(app.handle);
  let timer = null;
  let closed = false;
  const arm = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => close("idle"), idleMs);
    timer.unref();
  };
  server.on("request", arm);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = server.address().port;
  app.setPort(port);
  const url = `http://127.0.0.1:${port}/?token=${app.token}`;
  function close(reason) {
    if (closed) return;
    closed = true;
    if (timer) clearTimeout(timer);
    server.close();
    server.closeAllConnections();
    out(`autoclaude: settings page closed (${reason === "done" ? "you clicked Done" : `no use for ${Math.round(idleMs / 60000)} minutes`}).`);
    finish({ url, reason, saves: app.saves });
  }
  arm();
  out(`autoclaude: settings page for ${root ? path.basename(root) : "this computer"} at ${url}`);
  out(`  Only this computer can open it, and only with this link. Click Done on the page when you are finished; it also closes after ${Math.round(idleMs / 60000)} minutes without use.`);
  try { open(url); } catch (e) { out(`  (could not open a browser: ${e && e.message ? e.message : e}; open the link above yourself)`); }
  if (typeof listen === "function") listen({ url, port, token: app.token, close: () => close("done") });
  return finished;
}
