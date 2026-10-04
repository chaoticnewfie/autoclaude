// autoclaude.config.json: defaults, layers, merge, validation. Node built-ins only.
// The shape is PLAN.md section 4.8.2. Secrets never live here (they are plugin userConfig or
// notify.json). Settings resolve in layers (D49): the built-in DEFAULTS, then this computer's
// defaults file (<claude config dir>/autoclaude/defaults.json), then the project's file. A run
// on a generated plan (`run --plan`, P10.7) overrides `plan` from .autoclaude/run-plan.json,
// applied in loadConfig only, so every reader of config.plan follows it.
import path from "node:path";
import { readText, writeJsonAtomic, ensureDir, removeIfExists } from "./fsatomic.js";
import { CONFIG_FILE, RUNTIME_DIR, machinePaths } from "./paths.js";

export const DEFAULTS = Object.freeze({
  version: 1,
  plan: "PLAN.md",
  branch: "autoclaude/{planSlug}",
  // Models (D44): Opus is the main model and the ceiling, Sonnet the floor, never Haiku. The
  // aliases always mean the newest model of that family. effort null = the owner's own Claude
  // Code default (D49).
  builder: { model: "opus", effort: null },
  devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 90 },
  checks: [],
  tester: { enabled: true, model: "opus", maxTurns: 40, timeoutSec: 900 },
  security: { when: ["phase-end", "tag:security"], blockOn: "high", model: "opus", timeoutSec: 900 },
  bugBash: { atPhaseEnd: true },
  // Reasoning effort for the browser tester, bug bash, security reviewer and decider: one level
  // for all of them; null = the owner's own Claude Code default (D55). parallel: which checkers
  // of a verification run at the same time (D61): "security" the security review alongside the
  // browser tester and then the bug bash, "off" one after another, "all" all three at once.
  checkers: { effort: "xhigh", parallel: "security" },
  retries: { maxAttemptsPerStep: 3, maxNoProgressStops: 3, maxMinutesPerStep: 120 },
  usage: { weeklyPauseAtPct: 85, autoResumeAfterWeeklyReset: false, staleAfterMin: 30 },
  git: { commitEachStep: true, tagPhaseEnds: true, push: true },
  // verifyAt "phase": verify once per feature; "step": the old verification after every step (D49).
  // fitPct: the share of a stop's time for its parts (timeoutSec less a minute for the commit,
  // lib/gate.js stopPartsSec) the largest single part of a verification (one check, the browser
  // tester, the bug bash, the security review) may need before lint-plan, the preflight and
  // planning call its phase too big (D60). stepPhases: phase numbers verified step by step
  // although verifyAt is "phase", for a plan already running out of time (`verify-per-step`).
  gate: { timeoutSec: 1800, verifyAt: "phase", fitPct: 70, stepPhases: [] },
  // Informational alerts the owner can switch (D49); critical alerts are always sent.
  notify: { morningSummaryAt: null, events: { featureVerified: true, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false } },
  review: { pauseAt: "never" },
  // The supervisor that keeps the builder session alive (PLAN.md P6.4, D18). Minutes unless noted.
  supervisor: { pollSec: 60, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 2 },
  // Remove unused Docker things the run created, at plan completion (P8.5).
  footprint: { docker: true },
  // Security and optimize sweeps (P10, D58): read-only headless sessions, at most `concurrency`
  // at a time, on Opus at checkers.effort. depth "thorough" has every finding checked by three
  // independent sessions, "standard" by one. advisories: package names and versions may go to
  // npm and OSV. The sweep waits for the 5-hour reset above waitAt5hPct. after: what follows the
  // report: "report" only, a fix "plan" to review, or "fix" right away.
  sweep: { concurrency: 3, depth: "thorough", advisories: true, waitAt5hPct: 90, maxTurnsPerAgent: 40, timeoutSecPerAgent: 900, after: "fix" },
  // Extra Bash commands a run may never execute in this project, on top of the built-in list
  // (D37). Each rule: { "pattern": "<regular expression, case-insensitive>", "reason": "..." }.
  guard: { deny: [] },
  // Written by planning for what the plan allows (D47, D49): Claude Code permission allow rules
  // such as "Bash(ssh pve *)", and plain-language trusted-infrastructure lines for auto mode.
  permissions: { allow: [], environment: [] },
  docs: {
    progress: "PROGRESS.md",
    continueHere: "CONTINUE_HERE.md",
    decisions: "docs/DECISIONS.md",
    blockers: "docs/BLOCKERS.md",
    // Gitignored by init and never staged by git.commitAll (P10.10, D58): security findings
    // stay out of commits and pushes. Older projects keep the committed path their file names.
    security: "docs/private/SECURITY-FINDINGS.md",
    reviewNotes: "docs/REVIEW_NOTES.md",
    sessionLog: "docs/SESSION_LOG.md"
  }
});

// Settings that describe one project and mean nothing as a computer-wide default (D49).
export const PROJECT_ONLY_KEYS = Object.freeze(["plan", "branch", "devServer", "checks", "guard", "docs", "permissions"]);
// The same for single settings inside a shared group: phase numbers name one plan's phases.
export const PROJECT_ONLY_PATHS = Object.freeze(["gate.stepPhases"]);
// The range of gate.fitPct: below 30 nearly every phase is "too big", above 95 nothing is left
// for the dev server's start and a slow day.
export const FIT_PCT_RANGE = Object.freeze([30, 95]);

// Dotted-path prefixes that may change while a run is going: none of them changes how a step
// is built or checked. Everything else is locked until the run is paused (P8.7). A run never
// reads the sweep settings, and a running sweep keeps its options in its own sweep.json.
export const SAFE_LIVE_KEYS = Object.freeze(["notify", "usage", "review.pauseAt", "supervisor", "git.push", "git.tagPhaseEnds", "footprint", "sweep"]);

export function isSafeLiveKey(dotted) {
  return SAFE_LIVE_KEYS.some((k) => dotted === k || dotted.startsWith(k + "."));
}

export const EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max", "ultracode"]);
export const VERIFY_AT = Object.freeze(["phase", "step"]);
// The checkers' levels: ultracode's orchestration has no place in a headless check (D54, D55).
export const CHECKER_EFFORTS = Object.freeze(["low", "medium", "high", "xhigh", "max"]);
// Which checkers run at the same time (checkers.parallel): the tester and the bug bash share one
// dev server, so "all" is only for an app whose test data can take both at once.
export const CHECKER_PARALLEL = Object.freeze(["security", "off", "all"]);
const PAUSE_AT = ["never", "phase-end", "every-step"];
// The Stop hook's own timeout in hooks.json. Claude Code kills the gate after this many seconds,
// so a longer gate.timeoutSec would never be honoured.
export const MAX_GATE_TIMEOUT_SEC = 1800;
const BLOCK_ON = ["high", "medium", "low", "none"];
const SECURITY_WHEN = ["phase-end", "tag:security", "every-step", "never"];
export const SWEEP_DEPTHS = Object.freeze(["thorough", "standard", "quick"]);
export const SWEEP_AFTER = Object.freeze(["report", "plan", "fix"]);
export const MAX_SWEEP_CONCURRENCY = 8;
// The owner's committed list of accepted risks and false alarms from sweeps (P10.2): fingerprints
// and reasons only. Read-only for a run's builder (scripts/tool-guard.js); lib/findings.js reads
// and writes it.
export const ACCEPTED_FILE = "autoclaude.accepted.json";
// A Claude Code permission rule: a tool name, optionally with a specifier in parentheses.
const PERMISSION_RULE = /^[A-Za-z_][A-Za-z0-9_-]*(\(.+\))?$/s;

export function machineDefaultsFile() {
  return machinePaths().defaultsFile;
}

// Opus or Sonnet only: the aliases (optionally with the [1m] context suffix) or a full id.
export function allowedModel(v) {
  return typeof v === "string" && (/^(opus|sonnet)(\[1m\])?$/i.test(v.trim()) || /^claude-(opus|sonnet)-/i.test(v.trim()));
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Deep merge of `over` onto `base`. Arrays replace, objects merge.
function mergeInto(base, over) {
  const out = {};
  const o = isPlainObject(over) ? over : {};
  for (const k of Object.keys(base)) out[k] = isPlainObject(base[k]) ? mergeInto(base[k], isPlainObject(o[k]) ? o[k] : {}) : base[k];
  for (const k of Object.keys(o)) {
    if (isPlainObject(base[k]) && isPlainObject(o[k])) continue; // already merged
    out[k] = o[k];
  }
  return out;
}

// Deep merge of user values over the defaults. Arrays replace, objects merge.
export function mergeConfig(user = {}) {
  return mergeInto(DEFAULTS, user);
}

// The built-in defaults, then each layer in order (later wins).
export function mergeLayers(...layers) {
  return layers.reduce((acc, layer) => mergeInto(acc, layer), mergeInto(DEFAULTS, {}));
}

// Returns a list of { path, message }. Empty means valid.
export function validateConfig(cfg) {
  const errors = [];
  const err = (p, m) => errors.push({ path: p, message: m });
  const expect = (p, v, type, extra = "") => {
    const ok = type === "array" ? Array.isArray(v) : type === "object" ? isPlainObject(v) : typeof v === type;
    if (!ok) err(p, `expected ${type}${extra}, got ${Array.isArray(v) ? "array" : v === null ? "null" : typeof v}`);
    return ok;
  };
  const positive = (p, v) => {
    if (typeof v !== "number" || !(v > 0)) err(p, `expected a positive number, got ${JSON.stringify(v)}`);
  };
  const oneOf = (p, v, list) => {
    if (!list.includes(v)) err(p, `expected one of ${list.join(", ")}, got ${JSON.stringify(v)}`);
  };
  const nonEmptyStrings = (p, v) => {
    if (!expect(p, v, "array")) return;
    v.forEach((s, i) => {
      if (typeof s !== "string" || s.trim() === "") err(`${p}[${i}]`, `expected a non-empty string, got ${JSON.stringify(s)}`);
    });
  };

  if (!isPlainObject(cfg)) return [{ path: "", message: "config must be a JSON object" }];
  if (cfg.version !== 1) err("version", `expected 1, got ${JSON.stringify(cfg.version)}`);
  if (expect("plan", cfg.plan, "string") && cfg.plan.trim() === "") err("plan", "must not be empty");
  expect("branch", cfg.branch, "string");

  if (expect("devServer", cfg.devServer, "object")) {
    const d = cfg.devServer;
    if (d.command !== null) expect("devServer.command", d.command, "string", " or null");
    if (d.url !== null) expect("devServer.url", d.url, "string", " or null");
    expect("devServer.healthPath", d.healthPath, "string");
    positive("devServer.startTimeoutSec", d.startTimeoutSec);
    if ((d.command === null) !== (d.url === null)) err("devServer", "command and url must both be set or both be null");
  }

  if (expect("checks", cfg.checks, "array")) {
    const names = new Set();
    cfg.checks.forEach((c, i) => {
      const p = `checks[${i}]`;
      if (!expect(p, c, "object")) return;
      if (expect(`${p}.name`, c.name, "string")) {
        if (c.name.trim() === "") err(`${p}.name`, "must not be empty");
        else if (names.has(c.name)) err(`${p}.name`, `duplicate check name "${c.name}"`);
        names.add(c.name);
      }
      if (expect(`${p}.command`, c.command, "string") && c.command.trim() === "") err(`${p}.command`, "must not be empty");
      // Optional: lib/checks.js runs a check without one under its default timeout.
      if (c.timeoutSec !== undefined) positive(`${p}.timeoutSec`, c.timeoutSec);
      if (c.needsDevServer !== undefined) expect(`${p}.needsDevServer`, c.needsDevServer, "boolean");
      // Optional: a command the preflight runs first, such as "docker version" (P8.4).
      if (c.requires !== undefined && expect(`${p}.requires`, c.requires, "string") && c.requires.trim() === "") err(`${p}.requires`, "must not be empty (leave it out instead)");
    });
  }

  const model = (p, v) => {
    if (expect(p, v, "string") && !allowedModel(v)) err(p, `"${v}" is not allowed: use opus (the default) or sonnet, which always mean the newest of each, or a full claude-opus-* or claude-sonnet-* id. Haiku is below AutoClaude's floor`);
  };
  if (expect("builder", cfg.builder, "object")) {
    model("builder.model", cfg.builder.model);
    const e = cfg.builder.effort;
    if (e !== null && e !== undefined && !EFFORTS.includes(e)) err("builder.effort", `expected null (your Claude Code default) or one of ${EFFORTS.join(", ")}, got ${JSON.stringify(e)}`);
  }
  if (expect("checkers", cfg.checkers, "object")) {
    const e = cfg.checkers.effort;
    if (e !== null && e !== undefined && !CHECKER_EFFORTS.includes(e)) err("checkers.effort", `expected null (your Claude Code default) or one of ${CHECKER_EFFORTS.join(", ")}, got ${JSON.stringify(e)}`);
    oneOf("checkers.parallel", cfg.checkers.parallel, CHECKER_PARALLEL);
  }
  if (expect("tester", cfg.tester, "object")) {
    expect("tester.enabled", cfg.tester.enabled, "boolean");
    model("tester.model", cfg.tester.model);
    positive("tester.maxTurns", cfg.tester.maxTurns);
    positive("tester.timeoutSec", cfg.tester.timeoutSec);
  }
  if (expect("security", cfg.security, "object")) {
    if (expect("security.when", cfg.security.when, "array")) cfg.security.when.forEach((w, i) => oneOf(`security.when[${i}]`, w, SECURITY_WHEN));
    oneOf("security.blockOn", cfg.security.blockOn, BLOCK_ON);
    model("security.model", cfg.security.model);
    positive("security.timeoutSec", cfg.security.timeoutSec);
  }
  if (expect("bugBash", cfg.bugBash, "object")) expect("bugBash.atPhaseEnd", cfg.bugBash.atPhaseEnd, "boolean");
  if (expect("retries", cfg.retries, "object")) {
    positive("retries.maxAttemptsPerStep", cfg.retries.maxAttemptsPerStep);
    positive("retries.maxNoProgressStops", cfg.retries.maxNoProgressStops);
    positive("retries.maxMinutesPerStep", cfg.retries.maxMinutesPerStep);
  }
  if (expect("usage", cfg.usage, "object")) {
    const u = cfg.usage;
    if (typeof u.weeklyPauseAtPct !== "number" || u.weeklyPauseAtPct < 1 || u.weeklyPauseAtPct > 100) err("usage.weeklyPauseAtPct", "expected a number from 1 to 100");
    expect("usage.autoResumeAfterWeeklyReset", u.autoResumeAfterWeeklyReset, "boolean");
    positive("usage.staleAfterMin", u.staleAfterMin);
  }
  if (expect("git", cfg.git, "object")) {
    expect("git.commitEachStep", cfg.git.commitEachStep, "boolean");
    expect("git.tagPhaseEnds", cfg.git.tagPhaseEnds, "boolean");
    expect("git.push", cfg.git.push, "boolean");
  }
  if (expect("gate", cfg.gate, "object")) {
    positive("gate.timeoutSec", cfg.gate.timeoutSec);
    if (typeof cfg.gate.timeoutSec === "number" && cfg.gate.timeoutSec > MAX_GATE_TIMEOUT_SEC) err("gate.timeoutSec", `at most ${MAX_GATE_TIMEOUT_SEC} (the Stop hook's timeout in hooks.json), got ${cfg.gate.timeoutSec}`);
    oneOf("gate.verifyAt", cfg.gate.verifyAt, VERIFY_AT);
    const [lo, hi] = FIT_PCT_RANGE;
    if (typeof cfg.gate.fitPct !== "number" || !(cfg.gate.fitPct >= lo && cfg.gate.fitPct <= hi)) err("gate.fitPct", `expected a number from ${lo} to ${hi}, got ${JSON.stringify(cfg.gate.fitPct)}`);
    if (expect("gate.stepPhases", cfg.gate.stepPhases, "array")) {
      cfg.gate.stepPhases.forEach((n, i) => {
        if (!Number.isInteger(n) || n < 1) err(`gate.stepPhases[${i}]`, `expected a phase number (a whole number from 1), got ${JSON.stringify(n)}`);
      });
    }
  }
  if (expect("notify", cfg.notify, "object")) {
    if (cfg.notify.morningSummaryAt !== null && (typeof cfg.notify.morningSummaryAt !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.notify.morningSummaryAt))) err("notify.morningSummaryAt", "expected null or a time like 07:30");
    if (expect("notify.events", cfg.notify.events, "object")) {
      const known = Object.keys(DEFAULTS.notify.events);
      for (const [k, v] of Object.entries(cfg.notify.events)) {
        if (!known.includes(k)) err(`notify.events.${k}`, `not a switchable alert; the switchable ones are ${known.join(", ")} (critical alerts cannot be switched off)`);
        else expect(`notify.events.${k}`, v, "boolean");
      }
    }
  }
  if (expect("review", cfg.review, "object")) oneOf("review.pauseAt", cfg.review.pauseAt, PAUSE_AT);
  if (expect("supervisor", cfg.supervisor, "object")) {
    for (const k of ["pollSec", "idleRelaunchMin", "stallMin", "resumeGraceMin", "rateLimitGraceMin", "maxRecoveries"]) positive(`supervisor.${k}`, cfg.supervisor[k]);
  }
  if (expect("footprint", cfg.footprint, "object")) expect("footprint.docker", cfg.footprint.docker, "boolean");
  if (expect("sweep", cfg.sweep, "object")) {
    const s = cfg.sweep;
    if (!Number.isInteger(s.concurrency) || s.concurrency < 1 || s.concurrency > MAX_SWEEP_CONCURRENCY) err("sweep.concurrency", `expected a whole number from 1 to ${MAX_SWEEP_CONCURRENCY}, got ${JSON.stringify(s.concurrency)}`);
    oneOf("sweep.depth", s.depth, SWEEP_DEPTHS);
    expect("sweep.advisories", s.advisories, "boolean");
    if (typeof s.waitAt5hPct !== "number" || s.waitAt5hPct < 1 || s.waitAt5hPct > 100) err("sweep.waitAt5hPct", `expected a number from 1 to 100, got ${JSON.stringify(s.waitAt5hPct)}`);
    positive("sweep.maxTurnsPerAgent", s.maxTurnsPerAgent);
    positive("sweep.timeoutSecPerAgent", s.timeoutSecPerAgent);
    oneOf("sweep.after", s.after, SWEEP_AFTER);
  }
  if (expect("guard", cfg.guard, "object") && expect("guard.deny", cfg.guard.deny, "array")) {
    cfg.guard.deny.forEach((rule, i) => {
      const p = `guard.deny[${i}]`;
      if (!expect(p, rule, "object")) return;
      if (expect(`${p}.pattern`, rule.pattern, "string")) {
        // An empty pattern matches every command, which would deny all of Bash.
        if (rule.pattern.trim() === "") err(`${p}.pattern`, "must not be empty");
        else try { new RegExp(rule.pattern, "i"); } catch (e) { err(`${p}.pattern`, `not a valid regular expression: ${e.message}`); }
      }
      if (rule.reason !== undefined) expect(`${p}.reason`, rule.reason, "string");
    });
  }
  if (expect("permissions", cfg.permissions, "object")) {
    nonEmptyStrings("permissions.allow", cfg.permissions.allow);
    if (Array.isArray(cfg.permissions.allow)) {
      cfg.permissions.allow.forEach((r, i) => {
        if (typeof r === "string" && r.trim() && !PERMISSION_RULE.test(r.trim())) err(`permissions.allow[${i}]`, `"${r}" is not a Claude Code permission rule; write it as Tool or Tool(specifier), for example Bash(ssh pve *)`);
      });
    }
    nonEmptyStrings("permissions.environment", cfg.permissions.environment);
  }
  if (expect("docs", cfg.docs, "object")) {
    for (const k of Object.keys(DEFAULTS.docs)) {
      if (expect(`docs.${k}`, cfg.docs[k], "string") && path.isAbsolute(cfg.docs[k])) err(`docs.${k}`, "must be a path relative to the project root");
    }
  }
  return errors;
}

// ---------- layers ----------

// "checks[1].name" -> "checks.name": error paths compared with setting paths.
export function settingPathOf(errorPath) {
  return String(errorPath || "").replace(/\[\d+\]/g, "");
}

function hasPath(obj, parts) {
  let o = obj;
  for (const p of parts) {
    if (!isPlainObject(o) || !Object.hasOwn(o, p)) return false;
    o = o[p];
  }
  return true;
}

export function getPath(obj, dotted) {
  let o = obj;
  for (const p of String(dotted).split(".")) {
    if (!isPlainObject(o) || !Object.hasOwn(o, p)) return undefined;
    o = o[p];
  }
  return o;
}

// Sets a dotted path, creating objects on the way.
export function setPath(obj, dotted, value) {
  const parts = String(dotted).split(".");
  let o = obj;
  for (const p of parts.slice(0, -1)) {
    if (!isPlainObject(o[p])) o[p] = {};
    o = o[p];
  }
  o[parts[parts.length - 1]] = value;
  return obj;
}

// Deletes a dotted path and any object it leaves empty, so a reset leaves no `{}` behind.
export function deletePath(obj, dotted) {
  const parts = String(dotted).split(".");
  const walk = (o, i) => {
    if (!isPlainObject(o) || !Object.hasOwn(o, parts[i])) return;
    if (i === parts.length - 1) { delete o[parts[i]]; return; }
    walk(o[parts[i]], i + 1);
    if (isPlainObject(o[parts[i]]) && Object.keys(o[parts[i]]).length === 0) delete o[parts[i]];
  };
  walk(obj, 0);
  return obj;
}

// Reads this computer's defaults file. Never throws. Project-only keys, unknown keys and invalid
// values are reported and ignored, so a hand-edit mistake there never stops a project's run.
// Returns { exists, broken, file, raw, values, problems: [{ path, message, layer: "computer" }] }.
export function readMachineDefaults(file = machineDefaultsFile()) {
  const problems = [];
  const problem = (p, m) => problems.push({ path: p, message: m, layer: "computer" });
  let text = null;
  try { text = readText(file, null); } catch (e) { problem("", `${file} could not be read (${e.message}); this computer's defaults are ignored`); }
  if (text === null) return { exists: false, file, raw: {}, values: {}, problems };
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    problem("", `${file} is not valid JSON (${e.message}); this computer's defaults are ignored`);
    return { exists: true, broken: true, file, raw: {}, values: {}, problems };
  }
  if (!isPlainObject(raw)) {
    problem("", `${file} must hold a JSON object; this computer's defaults are ignored`);
    return { exists: true, broken: true, file, raw: {}, values: {}, problems };
  }
  const cleaned = cleanMachineDefaults(raw);
  return { exists: true, broken: false, file, raw, values: cleaned.values, problems: [...problems, ...cleaned.problems] };
}

// The usable part of a computer defaults object: { values, problems }. Never throws.
export function cleanMachineDefaults(raw) {
  const problems = [];
  const problem = (p, m) => problems.push({ path: p, message: m, layer: "computer" });
  const values = {};
  if (!isPlainObject(raw)) return { values, problems };
  for (const k of Object.keys(raw)) {
    if (k === "version") continue;
    if (PROJECT_ONLY_KEYS.includes(k)) problem(k, `belongs to a project's ${CONFIG_FILE}, not to this computer's defaults; ignored`);
    else if (!Object.hasOwn(DEFAULTS, k)) problem(k, "is not an AutoClaude setting; ignored");
    else values[k] = structuredClone(raw[k]);
  }
  for (const p of PROJECT_ONLY_PATHS) {
    if (!hasPath(values, p.split("."))) continue;
    problem(p, `belongs to a project's ${CONFIG_FILE}, not to this computer's defaults; ignored`);
    deletePath(values, p);
  }
  // Drop whatever fails validation, one setting at a time, and say so.
  for (let pass = 0; pass < 3; pass++) {
    const errs = validateConfig(mergeInto(DEFAULTS, values));
    if (!errs.length) break;
    for (const e of errs) {
      const p = settingPathOf(e.path);
      if (!p) continue;
      if (hasPath(values, p.split("."))) {
        problem(e.path, `${e.message}; ignored`);
        deletePath(values, p);
      } else if (pass === 2) {
        // An error no single key explains: drop the whole top-level setting.
        delete values[p.split(".")[0]];
      }
    }
  }
  return { values, problems };
}

// Reads the project's autoclaude.config.json as written. Returns { exists, file, raw, error }.
export function readProjectConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  let text;
  try { text = readText(file, null); } catch (e) { return { exists: true, file, raw: {}, error: `could not be read: ${e.message}` }; }
  if (text === null) return { exists: false, file, raw: {}, error: null };
  try {
    const raw = JSON.parse(text);
    return { exists: true, file, raw: isPlainObject(raw) ? raw : {}, error: isPlainObject(raw) ? null : "config must be a JSON object" };
  } catch (e) {
    return { exists: true, file, raw: {}, error: `not valid JSON: ${e.message}` };
  }
}

// All three layers of one project (root may be null: the computer's view only).
// Returns { builtin, machine, project, merged, errors, sourceOf(dottedPath), machineFile,
// projectFile, projectExists, machineExists }. machine is the usable part of defaults.json.
// errors: [{ path, message, layer: "computer" | "project" }].
export function loadLayers(root, { machineFile = machineDefaultsFile() } = {}) {
  const builtin = structuredClone(mergeInto(DEFAULTS, {}));
  const m = readMachineDefaults(machineFile);
  const p = root ? readProjectConfig(root) : { exists: false, file: null, raw: {}, error: null };
  const merged = mergeLayers(m.values, p.raw);
  const errors = [...m.problems];
  if (p.error) errors.push({ path: "", message: p.error, layer: "project" });
  else for (const e of validateConfig(merged)) errors.push({ ...e, layer: "project" });
  const sourceOf = (dotted) => {
    const parts = String(dotted).split(".");
    if (hasPath(p.raw, parts)) return "project";
    if (hasPath(m.values, parts)) return "computer";
    return "built-in";
  };
  return {
    builtin, machine: m.values, machineRaw: m.raw, project: p.raw, merged, errors, sourceOf,
    machineFile, projectFile: p.file, machineExists: m.exists, projectExists: p.exists
  };
}

// Reads <root>/autoclaude.config.json over this computer's defaults. Never throws for a missing or
// broken file: { exists, file, config (merged, or the lower layers when broken), errors[],
// warnings[], mainPlan, runPlan }. errors are the project's own problems (the shape callers have
// always had); warnings are problems in this computer's defaults file, which are ignored.
// With a run-plan override (.autoclaude/run-plan.json, P10.7) config.plan is the override's file
// and config.docs.continueHere the run's own resume file (continueHereFor: CONTINUE_HERE.md ->
// CONTINUE_HERE-SECURITY.md, D59), so the project's resume file is left alone; mainPlan and
// mainContinueHere are always the files the project's config names, and runPlan the override or
// null. A broken override is an error with the path RUN_PLAN_ERROR_PATH, and config.plan stays
// the main plan, so nothing ever acts on a plan nobody chose.
export function loadConfig(root, { machineFile = machineDefaultsFile() } = {}) {
  const file = path.join(root, CONFIG_FILE);
  const m = readMachineDefaults(machineFile);
  const warnings = m.problems.map(({ path: p, message }) => ({ path: p, message: `${machineFile}: ${message}` }));
  const p = readProjectConfig(root);
  const over = readRunPlan(root);
  const withOverride = (config, errors) => {
    const mainPlan = config.plan;
    const docs = isPlainObject(config.docs) ? config.docs : null;
    const mainContinueHere = docs ? docs.continueHere : undefined;
    if (over.error) return { config, errors: [...errors, { path: RUN_PLAN_ERROR_PATH, message: over.error }], mainPlan, mainContinueHere, runPlan: null };
    if (!over.plan) return { config, errors, mainPlan, mainContinueHere, runPlan: null };
    const resume = docs && typeof docs.continueHere === "string" ? { docs: { ...docs, continueHere: continueHereFor(docs.continueHere, over.plan) } } : {};
    return { config: { ...config, plan: over.plan, ...resume }, errors, mainPlan, mainContinueHere, runPlan: over.plan };
  };
  if (!p.exists) return { exists: false, file, ...withOverride(mergeLayers(m.values), []), warnings };
  if (p.error) return { exists: true, file, ...withOverride(mergeLayers(m.values), [{ path: "", message: p.error }]), warnings };
  const config = mergeLayers(m.values, p.raw);
  return { exists: true, file, ...withOverride(config, validateConfig(config)), warnings };
}

// ---------- the run-plan override (P10.7) ----------

export const RUN_PLAN_FILE = "run-plan.json";
// The error path loadConfig gives a broken override, so a reader can tell it from config errors.
export const RUN_PLAN_ERROR_PATH = `${RUNTIME_DIR}/${RUN_PLAN_FILE}`;

export function runPlanFile(root) {
  return path.join(root, RUNTIME_DIR, RUN_PLAN_FILE);
}

// The name a run on a generated plan gives its own files: SECURITY_PLAN.md -> "SECURITY",
// OPTIMIZE_PLAN.md -> "OPTIMIZE", anything without a name left -> "RUN" (the same rule as
// summary.handoffFileFor, which names HANDOFF-SECURITY.md).
export function runPlanTag(planFile) {
  const base = path.posix.basename(String(planFile || "").replace(/\\/g, "/")).replace(/[.]md$/i, "").replace(/[-_. ]?plan$/i, "");
  return base.toUpperCase().replace(/[^A-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "RUN";
}

// The builder's resume file during a run on planFile: the project's own (docs.continueHere) with
// the plan's tag added, in the same folder. CONTINUE_HERE.md -> CONTINUE_HERE-SECURITY.md,
// docs/RESUME.md -> docs/RESUME-OPTIMIZE.md. Project-relative, forward slashes.
export function continueHereFor(continueHere, planFile) {
  const rel = String(continueHere || DEFAULTS.docs.continueHere).trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
  const dir = path.posix.dirname(rel);
  const ext = path.posix.extname(rel);
  const name = `${path.posix.basename(rel, ext)}-${runPlanTag(planFile)}${ext || ".md"}`;
  return dir === "." ? name : `${dir}/${name}`;
}

// A plan file the override may name, as a project-relative path with forward slashes: inside the
// project and outside .autoclaude/ (the gate commits plan ticks, and that folder is never
// committed). { rel, error }.
function planPathIn(root, file) {
  if (typeof file !== "string" || file.trim() === "") return { rel: null, error: "names no plan file" };
  const abs = path.resolve(root, file.trim());
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { rel: null, error: `${file} is not inside the project` };
  const posix = rel.split(path.sep).join("/");
  if (posix.toLowerCase() === RUNTIME_DIR || posix.toLowerCase().startsWith(`${RUNTIME_DIR}/`)) return { rel: null, error: `${file} is inside ${RUNTIME_DIR}/, which is never committed; put the plan in the project` };
  return { rel: posix, error: null };
}

// Where `autoclaude run --plan <file>` takes its plan from, and where the run works it: a plan a
// sweep left in its gitignored folder (.autoclaude/sweeps/<id>/<NAME>.md) is copied to the
// project root under its own name and committed there; any other plan in the project is worked
// where it is. { source, target, sweepId, error }: source and target project-relative with
// forward slashes, sweepId the sweep's id or null. Never throws.
export function resolveRunPlanSource(root, file) {
  const none = { source: null, target: null, sweepId: null };
  if (typeof file !== "string" || file.trim() === "") return { ...none, error: "names no plan file" };
  const abs = path.resolve(root, file.trim());
  const rel = path.relative(path.resolve(root), abs);
  if (!rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return { ...none, error: `${file} is not inside the project` };
  const posix = rel.split(path.sep).join("/");
  const m = posix.match(new RegExp(`^${RUNTIME_DIR.replace(/[.]/g, "[.]")}/sweeps/([^/]+)/([^/]+[.]md)$`, "i"));
  if (m) return { source: posix, target: m[2], sweepId: m[1], error: null };
  const { rel: target, error } = planPathIn(root, file);
  if (error) return { ...none, error: `${error} (only a plan a sweep wrote in ${RUNTIME_DIR}/sweeps/<id>/ is taken from there)` };
  return { source: target, target, sweepId: null, error: null };
}

const strOrNull = (v) => (typeof v === "string" && v.trim() ? v : null);

// The override as written: { exists, plan (project-relative) or null, since, branch, source,
// sweepId, error }. branch is the run branch `run --plan` made for it, source where the plan was
// taken from (a sweep's folder, or the plan itself), sweepId the sweep's id; each null when not
// recorded. Never throws.
export function readRunPlan(root) {
  const file = runPlanFile(root);
  const empty = { plan: null, since: null, branch: null, source: null, sweepId: null };
  let text;
  try { text = readText(file, null); } catch (e) { return { exists: true, ...empty, error: `${RUN_PLAN_ERROR_PATH} could not be read: ${e.message}` }; }
  if (text === null) return { exists: false, ...empty, error: null };
  let raw;
  try { raw = JSON.parse(text); } catch (e) { return { exists: true, ...empty, error: `${RUN_PLAN_ERROR_PATH} is not valid JSON (${e.message}); delete it to go back to the project's own plan, or start the run on the generated plan again` }; }
  const named = isPlainObject(raw) ? raw.plan : undefined;
  const { rel, error } = planPathIn(root, named);
  if (error) return { exists: true, ...empty, error: `${RUN_PLAN_ERROR_PATH}: the plan it ${error}` };
  const o = isPlainObject(raw) ? raw : {};
  return { exists: true, plan: rel, since: strOrNull(o.since), branch: strOrNull(o.branch), source: strOrNull(o.source), sweepId: strOrNull(o.sweepId), error: null };
}

// The plan file a run works on instead of config.plan, or null (none, or a broken override).
export function runPlanOverride(root) {
  return readRunPlan(root).plan;
}

// Points every run reader at `file` (absolute, or relative to the project). Throws on a file
// outside the project or inside .autoclaude/. Returns the project-relative path written. branch,
// source and sweepId are recorded when given (`autoclaude start` runs on that branch).
export function setRunPlan(root, file, { now = new Date(), branch = null, source = null, sweepId = null } = {}) {
  const { rel, error } = planPathIn(root, file);
  if (error) throw new Error(`cannot run on that plan: it ${error}`);
  const record = { plan: rel, since: new Date(now).toISOString() };
  if (strOrNull(branch)) record.branch = branch;
  if (strOrNull(source)) record.source = source;
  if (strOrNull(sweepId)) record.sweepId = sweepId;
  writeJsonAtomic(runPlanFile(root), record);
  return rel;
}

// Back to the project's own plan. True when an override was removed.
export function clearRunPlan(root) {
  return removeIfExists(runPlanFile(root));
}

// Writes the project's file as given (the caller passes the whole object it read and changed).
export function writeProjectConfig(root, obj) {
  const file = path.join(root, CONFIG_FILE);
  writeJsonAtomic(file, obj);
  return file;
}

// Changes the project's own file: fn(raw) edits a copy of what the file holds (never the merged
// layers, so nothing inherited is copied in) and may return a replacement; the result is written
// back and returned. Throws when the file is missing or does not parse, so nothing is lost.
export function updateProjectConfig(root, fn) {
  const p = readProjectConfig(root);
  if (!p.exists) throw new Error(`${p.file} does not exist; run autoclaude init first`);
  if (p.error) throw new Error(`${p.file} ${p.error}; fix it by hand first`);
  const raw = structuredClone(p.raw);
  const out = fn(raw) || raw;
  writeProjectConfig(root, out);
  return out;
}

// Writes this computer's defaults file as given.
export function writeMachineDefaults(obj, file = machineDefaultsFile()) {
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, obj);
  return file;
}

export function formatConfigErrors(errors) {
  return errors.map((e) => (e.path ? `  ${e.path}: ${e.message}` : `  ${e.message}`)).join("\n");
}

// What `init` writes: the version and the project-only keys (plus anything passed in). Personal
// settings stay out, so a new project follows this computer's defaults until it sets its own (D49).
export function configTemplate(overrides = {}) {
  const full = mergeConfig(overrides);
  const out = { version: full.version };
  for (const k of PROJECT_ONLY_KEYS) out[k] = full[k];
  for (const k of Object.keys(isPlainObject(overrides) ? overrides : {})) if (!Object.hasOwn(out, k)) out[k] = full[k];
  return out;
}
