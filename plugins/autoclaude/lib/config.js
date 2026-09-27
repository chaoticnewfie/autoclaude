// autoclaude.config.json: defaults, merge, validation. Node built-ins only.
// The shape is PLAN.md section 4.8.2. Secrets never live here (they are plugin userConfig).
import path from "node:path";
import { readText } from "./fsatomic.js";
import { CONFIG_FILE } from "./paths.js";

export const DEFAULTS = Object.freeze({
  version: 1,
  plan: "PLAN.md",
  branch: "autoclaude/{planSlug}",
  devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 90 },
  checks: [],
  tester: { enabled: true, model: "sonnet", maxTurns: 40, timeoutSec: 900 },
  security: { when: ["phase-end", "tag:security"], blockOn: "high", model: "opus", timeoutSec: 900 },
  bugBash: { atPhaseEnd: true },
  retries: { maxAttemptsPerStep: 3, maxNoProgressStops: 3, maxMinutesPerStep: 120 },
  usage: { weeklyPauseAtPct: 85, autoResumeAfterWeeklyReset: false, staleAfterMin: 30 },
  git: { commitEachStep: true, tagPhaseEnds: true, push: false },
  gate: { timeoutSec: 1800 },
  notify: { morningSummaryAt: null },
  review: { pauseAt: "never" },
  // The supervisor that keeps the builder session alive (PLAN.md P6.4, D18). Minutes unless noted.
  supervisor: { pollSec: 60, idleRelaunchMin: 15, stallMin: 45, resumeGraceMin: 2, rateLimitGraceMin: 10, maxRecoveries: 2 },
  // Extra Bash commands a run may never execute in this project, on top of the built-in list
  // (D37). Each rule: { "pattern": "<regular expression, case-insensitive>", "reason": "..." }.
  guard: { deny: [] },
  docs: {
    progress: "PROGRESS.md",
    continueHere: "CONTINUE_HERE.md",
    decisions: "docs/DECISIONS.md",
    blockers: "docs/BLOCKERS.md",
    security: "docs/SECURITY-FINDINGS.md",
    reviewNotes: "docs/REVIEW_NOTES.md",
    sessionLog: "docs/SESSION_LOG.md"
  }
});

const PAUSE_AT = ["never", "phase-end", "every-step"];
// The Stop hook's own timeout in hooks.json. Claude Code kills the gate after this many seconds,
// so a longer gate.timeoutSec would never be honoured.
export const MAX_GATE_TIMEOUT_SEC = 1800;
const BLOCK_ON = ["high", "medium", "low", "none"];
const SECURITY_WHEN = ["phase-end", "tag:security", "every-step", "never"];

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Deep merge of user values over the defaults. Arrays replace, objects merge.
export function mergeConfig(user = {}) {
  const merge = (base, over) => {
    const out = {};
    for (const k of Object.keys(base)) out[k] = isPlainObject(base[k]) ? merge(base[k], isPlainObject(over[k]) ? over[k] : {}) : base[k];
    for (const k of Object.keys(over)) {
      if (isPlainObject(base[k]) && isPlainObject(over[k])) continue; // already merged
      out[k] = over[k];
    }
    return out;
  };
  return merge(DEFAULTS, isPlainObject(user) ? user : {});
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
        if (names.has(c.name)) err(`${p}.name`, `duplicate check name "${c.name}"`);
        names.add(c.name);
      }
      expect(`${p}.command`, c.command, "string");
      // Optional: lib/checks.js runs a check without one under its default timeout.
      if (c.timeoutSec !== undefined) positive(`${p}.timeoutSec`, c.timeoutSec);
      if (c.needsDevServer !== undefined) expect(`${p}.needsDevServer`, c.needsDevServer, "boolean");
    });
  }

  if (expect("tester", cfg.tester, "object")) {
    expect("tester.enabled", cfg.tester.enabled, "boolean");
    expect("tester.model", cfg.tester.model, "string");
    positive("tester.maxTurns", cfg.tester.maxTurns);
    positive("tester.timeoutSec", cfg.tester.timeoutSec);
  }
  if (expect("security", cfg.security, "object")) {
    if (expect("security.when", cfg.security.when, "array")) cfg.security.when.forEach((w, i) => oneOf(`security.when[${i}]`, w, SECURITY_WHEN));
    oneOf("security.blockOn", cfg.security.blockOn, BLOCK_ON);
    expect("security.model", cfg.security.model, "string");
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
  }
  if (expect("notify", cfg.notify, "object") && cfg.notify.morningSummaryAt !== null) {
    if (typeof cfg.notify.morningSummaryAt !== "string" || !/^([01]\d|2[0-3]):[0-5]\d$/.test(cfg.notify.morningSummaryAt)) err("notify.morningSummaryAt", "expected null or a time like 07:30");
  }
  if (expect("review", cfg.review, "object")) oneOf("review.pauseAt", cfg.review.pauseAt, PAUSE_AT);
  if (expect("supervisor", cfg.supervisor, "object")) {
    for (const k of ["pollSec", "idleRelaunchMin", "stallMin", "resumeGraceMin", "rateLimitGraceMin", "maxRecoveries"]) positive(`supervisor.${k}`, cfg.supervisor[k]);
  }
  if (expect("guard", cfg.guard, "object") && expect("guard.deny", cfg.guard.deny, "array")) {
    cfg.guard.deny.forEach((rule, i) => {
      const p = `guard.deny[${i}]`;
      if (!expect(p, rule, "object")) return;
      if (expect(`${p}.pattern`, rule.pattern, "string")) {
        try { new RegExp(rule.pattern, "i"); } catch (e) { err(`${p}.pattern`, `not a valid regular expression: ${e.message}`); }
      }
      if (rule.reason !== undefined) expect(`${p}.reason`, rule.reason, "string");
    });
  }
  if (expect("docs", cfg.docs, "object")) {
    for (const k of Object.keys(DEFAULTS.docs)) {
      if (expect(`docs.${k}`, cfg.docs[k], "string") && path.isAbsolute(cfg.docs[k])) err(`docs.${k}`, "must be a path relative to the project root");
    }
  }
  return errors;
}

// Reads <root>/autoclaude.config.json. Never throws for a missing or broken file:
// { exists, config (merged over defaults, or the defaults when broken), errors[] }.
export function loadConfig(root) {
  const file = path.join(root, CONFIG_FILE);
  const text = readText(file, null);
  if (text === null) return { exists: false, file, config: mergeConfig({}), errors: [] };
  let user;
  try {
    user = JSON.parse(text);
  } catch (e) {
    return { exists: true, file, config: mergeConfig({}), errors: [{ path: "", message: `not valid JSON: ${e.message}` }] };
  }
  const config = mergeConfig(user);
  return { exists: true, file, config, errors: validateConfig(config) };
}

export function formatConfigErrors(errors) {
  return errors.map((e) => (e.path ? `  ${e.path}: ${e.message}` : `  ${e.message}`)).join("\n");
}

// A user-facing config with the defaults filled in, used by `init` (Phase 2).
export function configTemplate(overrides = {}) {
  return mergeConfig(overrides);
}
