import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULTS, mergeConfig, validateConfig, loadConfig, formatConfigErrors, PROJECT_ONLY_KEYS, SAFE_LIVE_KEYS, isSafeLiveKey,
  machineDefaultsFile, loadLayers, writeProjectConfig, writeMachineDefaults, readMachineDefaults, configTemplate, EFFORTS
} from "../../plugins/autoclaude/lib/config.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-config-"));
// Never read or write the real computer's defaults: every test here runs in a throwaway config dir.
process.env.CLAUDE_CONFIG_DIR = tmpDir();

test("mergeConfig fills every default and lets the user override deep keys", () => {
  const cfg = mergeConfig({ retries: { maxAttemptsPerStep: 5 }, checks: [{ name: "unit", command: "npm test", timeoutSec: 60 }] });
  assert.equal(cfg.retries.maxAttemptsPerStep, 5);
  assert.equal(cfg.retries.maxNoProgressStops, DEFAULTS.retries.maxNoProgressStops);
  assert.equal(cfg.review.pauseAt, "never");
  assert.equal(cfg.docs.decisions, "docs/DECISIONS.md");
  assert.deepEqual(cfg.checks, [{ name: "unit", command: "npm test", timeoutSec: 60 }]);
  assert.equal(validateConfig(cfg).length, 0);
});

test("guard.deny is validated: objects with a valid regex pattern and a string reason", () => {
  assert.deepEqual(validateConfig(mergeConfig({ guard: { deny: [{ pattern: "\\bssh\\b", reason: "keys" }] } })), []);
  const errors = validateConfig(mergeConfig({ guard: { deny: [{ pattern: "[(" }, "ssh", { pattern: 5 }, { pattern: "x", reason: 3 }] } }));
  const paths = errors.map((e) => e.path);
  for (const p of ["guard.deny[0].pattern", "guard.deny[1]", "guard.deny[2].pattern", "guard.deny[3].reason"]) assert.ok(paths.includes(p), `missing ${p}: ${paths.join(", ")}`);
  assert.match(errors.find((e) => e.path === "guard.deny[0].pattern").message, /not a valid regular expression/);
  assert.deepEqual(mergeConfig({}).guard, { deny: [] });
});

test("the defaults validate clean", () => {
  assert.deepEqual(validateConfig(mergeConfig({})), []);
});

test("validateConfig reports wrong types, bad enums and duplicate check names with paths", () => {
  const cfg = mergeConfig({
    plan: 7,
    review: { pauseAt: "sometimes" },
    security: { blockOn: "critical", when: ["phase-end", "tuesdays"] },
    usage: { weeklyPauseAtPct: 150 },
    checks: [{ name: "lint", command: "x", timeoutSec: 10 }, { name: "lint", command: 3, timeoutSec: -1 }],
    devServer: { command: "npm run dev", url: null },
    notify: { morningSummaryAt: "7am" },
    docs: { decisions: "C:\\abs\\DECISIONS.md" }
  });
  const errors = validateConfig(cfg);
  const paths = errors.map((e) => e.path);
  for (const p of ["plan", "review.pauseAt", "security.blockOn", "security.when[1]", "usage.weeklyPauseAtPct", "checks[1].name", "checks[1].command", "checks[1].timeoutSec", "devServer", "notify.morningSummaryAt", "docs.decisions"]) {
    assert.ok(paths.includes(p), `missing error for ${p}; got ${paths.join(", ")}`);
  }
  assert.match(formatConfigErrors(errors), /review\.pauseAt: expected one of never, phase-end, every-step/);
});

test("loadConfig: missing file, broken JSON, and a good file", () => {
  const dir = tmpDir();
  let r = loadConfig(dir);
  assert.equal(r.exists, false);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.plan, "PLAN.md");

  fs.writeFileSync(path.join(dir, "autoclaude.config.json"), "{ not json");
  r = loadConfig(dir);
  assert.equal(r.exists, true);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].message, /not valid JSON/);

  fs.writeFileSync(path.join(dir, "autoclaude.config.json"), JSON.stringify({ version: 1, plan: "docs/plan.md", gate: { timeoutSec: 60 } }));
  r = loadConfig(dir);
  assert.equal(r.exists, true);
  assert.deepEqual(r.errors, []);
  assert.equal(r.config.plan, "docs/plan.md");
  assert.equal(r.config.gate.timeoutSec, 60);
  assert.deepEqual([r.config.builder.model, r.config.tester.model, r.config.security.model], ["opus", "opus", "opus"]);
});

test("models: Opus by default everywhere, Sonnet allowed as the floor, never Haiku (D44)", () => {
  assert.deepEqual(validateConfig(mergeConfig({ builder: { model: "sonnet" }, tester: { model: "sonnet" }, security: { model: "claude-opus-5-5" } })), []);
  assert.deepEqual(validateConfig(mergeConfig({ tester: { model: "opus[1m]" } })), []);
  for (const bad of ["haiku", "claude-haiku-4-5-20251001", "gpt-4", ""]) {
    const errs = validateConfig(mergeConfig({ tester: { model: bad } }));
    assert.equal(errs.length, 1, bad);
    assert.equal(errs[0].path, "tester.model");
    assert.match(errs[0].message, /Haiku is below AutoClaude's floor/);
  }
  assert.equal(validateConfig(mergeConfig({ builder: { model: "haiku" } }))[0].path, "builder.model");
  assert.equal(validateConfig(mergeConfig({ security: { model: "haiku" } }))[0].path, "security.model");
});

test("gate.timeoutSec may not exceed the Stop hook's 1800 s; a check's timeoutSec is optional", () => {
  assert.deepEqual(validateConfig(mergeConfig({ gate: { timeoutSec: 1800 } })), []);
  const over = validateConfig(mergeConfig({ gate: { timeoutSec: 1801 } }));
  assert.deepEqual(over.map((e) => e.path), ["gate.timeoutSec"]);
  assert.match(over[0].message, /at most 1800/);
  assert.deepEqual(validateConfig(mergeConfig({ checks: [{ name: "unit", command: "npm test" }] })), []);
  const bad = validateConfig(mergeConfig({ checks: [{ name: "unit", command: "npm test", timeoutSec: 0 }] }));
  assert.deepEqual(bad.map((e) => e.path), ["checks[0].timeoutSec"]);
});

// ---------- Phase 8: new keys, layers, the computer's defaults (P8.6, P8.7) ----------

test("the Phase 8 defaults: verify per feature, push on, effort unset, feature alerts on, Docker cleanup, no permissions", () => {
  const cfg = mergeConfig({});
  assert.deepEqual(cfg.builder, { model: "opus", effort: null });
  assert.deepEqual(cfg.gate, { timeoutSec: 1800, verifyAt: "phase" });
  assert.deepEqual(cfg.git, { commitEachStep: true, tagPhaseEnds: true, push: true });
  assert.deepEqual(cfg.notify, { morningSummaryAt: null, events: { featureVerified: true, stepVerified: false, runStarted: false, runResumed: false, pausedByOwner: false } });
  assert.deepEqual(cfg.footprint, { docker: true });
  assert.deepEqual(cfg.permissions, { allow: [], environment: [] });
  assert.deepEqual(PROJECT_ONLY_KEYS, ["plan", "branch", "devServer", "checks", "guard", "docs", "permissions"]);
  // An old project file that only sets morningSummaryAt still gets the event defaults.
  assert.equal(mergeConfig({ notify: { morningSummaryAt: "07:30" } }).notify.events.featureVerified, true);
});

test("validation of the new keys: verifyAt, effort, events, footprint, permissions, checks[i].requires", () => {
  assert.deepEqual(validateConfig(mergeConfig({ gate: { verifyAt: "step" }, builder: { effort: "ultracode" } })), []);
  for (const e of EFFORTS) assert.deepEqual(validateConfig(mergeConfig({ builder: { effort: e } })), [], e);
  const cfg = mergeConfig({
    gate: { verifyAt: "feature" },
    builder: { effort: "turbo" },
    notify: { events: { featureVerified: "yes", planComplete: false } },
    footprint: { docker: "no" },
    permissions: { allow: ["Bash(ssh pve *)", "ssh pve", 5, ""], environment: ["The build server is ours", ""] },
    checks: [{ name: "db", command: "npm run db", requires: "" }, { name: "x", command: "y", requires: 3 }, { name: "", command: " " }],
    guard: { deny: [{ pattern: "" }] }
  });
  const errors = validateConfig(cfg);
  const paths = errors.map((e) => e.path);
  for (const p of ["gate.verifyAt", "builder.effort", "notify.events.featureVerified", "notify.events.planComplete", "footprint.docker",
    "permissions.allow[1]", "permissions.allow[2]", "permissions.allow[3]", "permissions.environment[1]", "checks[0].requires", "checks[1].requires",
    "checks[2].name", "checks[2].command", "guard.deny[0].pattern"]) {
    assert.ok(paths.includes(p), `missing ${p}; got ${paths.join(", ")}`);
  }
  assert.ok(!paths.includes("permissions.allow[0]"));
  assert.match(errors.find((e) => e.path === "notify.events.planComplete").message, /critical alerts cannot be switched off/);
  assert.match(errors.find((e) => e.path === "permissions.allow[1]").message, /Bash\(ssh pve \*\)/);
  assert.deepEqual(validateConfig(mergeConfig({ permissions: { allow: ["Read(./secrets/**)", "mcp__playwright__browser_navigate", "WebFetch(domain:example.com)"] }, checks: [{ name: "db", command: "x", requires: "docker version" }] })), []);
  assert.deepEqual(validateConfig(mergeConfig({ permissions: { allow: "Bash" } })).map((e) => e.path), ["permissions.allow"]);
});

test("layers: built-in, then this computer's defaults.json, then the project, with the source of every value", () => {
  const cfgDir = tmpDir();
  const machineFile = path.join(cfgDir, "autoclaude", "defaults.json");
  const root = tmpDir();
  writeMachineDefaults({ builder: { effort: "ultracode" }, usage: { weeklyPauseAtPct: 70 }, notify: { events: { stepVerified: true } } }, machineFile);
  writeProjectConfig(root, { version: 1, plan: "PLAN.md", usage: { weeklyPauseAtPct: 90 }, checks: [{ name: "unit", command: "npm test" }] });
  const L = loadLayers(root, { machineFile });
  assert.deepEqual(L.errors, []);
  assert.equal(L.merged.builder.effort, "ultracode");
  assert.equal(L.merged.builder.model, "opus");
  assert.equal(L.merged.usage.weeklyPauseAtPct, 90);
  assert.equal(L.merged.notify.events.stepVerified, true);
  assert.equal(L.merged.notify.events.featureVerified, true);
  assert.equal(L.sourceOf("usage.weeklyPauseAtPct"), "project");
  assert.equal(L.sourceOf("builder.effort"), "computer");
  assert.equal(L.sourceOf("notify.events.stepVerified"), "computer");
  assert.equal(L.sourceOf("notify.events.featureVerified"), "built-in");
  assert.equal(L.sourceOf("tester.model"), "built-in");
  assert.equal(L.sourceOf("checks"), "project");
  assert.deepEqual(L.builtin.builder, DEFAULTS.builder);

  // loadConfig keeps its shape and uses the same layers.
  const r = loadConfig(root, { machineFile });
  assert.deepEqual([r.exists, r.errors, r.warnings], [true, [], []]);
  assert.equal(r.config.builder.effort, "ultracode");
  assert.equal(r.config.usage.weeklyPauseAtPct, 90);
  // A project without its own file still follows the computer.
  const bare = loadConfig(tmpDir(), { machineFile });
  assert.equal(bare.exists, false);
  assert.equal(bare.config.builder.effort, "ultracode");

  // The default file is <CLAUDE_CONFIG_DIR>/autoclaude/defaults.json, and loadConfig reads it by default.
  assert.equal(machineDefaultsFile(), path.join(process.env.CLAUDE_CONFIG_DIR, "autoclaude", "defaults.json"));
  writeMachineDefaults({ tester: { model: "sonnet" } });
  assert.equal(loadConfig(root).config.tester.model, "sonnet");
  fs.rmSync(machineDefaultsFile());
  assert.equal(loadConfig(root).config.tester.model, "opus");
});

test("defaults.json: project-only keys, unknown keys and invalid values are reported and ignored, never fatal", () => {
  const machineFile = path.join(tmpDir(), "defaults.json");
  const root = tmpDir();
  writeProjectConfig(root, { version: 1 });
  fs.writeFileSync(machineFile, JSON.stringify({
    version: 1,
    checks: [{ name: "x", command: "y" }], permissions: { allow: ["Bash"] }, devServer: { command: "npm run dev", url: "http://x" },
    colour: "blue",
    tester: { model: "haiku", maxTurns: 20 },
    security: { when: ["phase-end", "tuesdays"] },
    notify: { events: { featureVerified: false, planComplete: false } }
  }));
  const m = readMachineDefaults(machineFile);
  const probs = m.problems.map((p) => p.path);
  for (const p of ["checks", "permissions", "devServer", "colour", "tester.model", "security.when[1]", "notify.events.planComplete"]) assert.ok(probs.includes(p), `missing ${p}: ${probs.join(", ")}`);
  assert.ok(m.problems.every((p) => p.layer === "computer"));
  assert.match(m.problems.find((p) => p.path === "checks").message, /belongs to a project/);
  assert.deepEqual(m.values, { tester: { maxTurns: 20 }, notify: { events: { featureVerified: false } } });

  const r = loadConfig(root, { machineFile });
  assert.deepEqual(r.errors, [], "a bad computer file never makes a project's config fail");
  assert.ok(r.warnings.length >= 7);
  assert.match(r.warnings[0].message, /defaults\.json/);
  assert.equal(r.config.tester.model, "opus");
  assert.equal(r.config.tester.maxTurns, 20);
  assert.deepEqual(r.config.checks, []);
  assert.equal(r.config.notify.events.featureVerified, false);
  const L = loadLayers(root, { machineFile });
  assert.ok(L.errors.some((e) => e.layer === "computer" && e.path === "checks"));

  fs.writeFileSync(machineFile, "{ broken");
  const broken = readMachineDefaults(machineFile);
  assert.equal(broken.broken, true);
  assert.deepEqual(broken.values, {});
  const r2 = loadConfig(root, { machineFile });
  assert.deepEqual(r2.errors, []);
  assert.match(r2.warnings[0].message, /not valid JSON/);
  assert.equal(r2.config.builder.model, "opus");
});

test("configTemplate writes the project-only keys, so a new project follows this computer's defaults", () => {
  const t = configTemplate({ checks: [{ name: "unit", command: "npm test" }], devServer: { command: "npm run dev", url: "http://127.0.0.1:3000" } });
  assert.deepEqual(Object.keys(t).sort(), ["version", ...PROJECT_ONLY_KEYS].sort());
  assert.equal(t.devServer.healthPath, "/");
  assert.deepEqual(t.checks, [{ name: "unit", command: "npm test" }]);
  assert.equal(t.builder, undefined);
  assert.deepEqual(validateConfig(mergeConfig(t)), []);
  assert.equal(configTemplate({ review: { pauseAt: "phase-end" } }).review.pauseAt, "phase-end", "an explicit override is kept");
});

test("SAFE_LIVE_KEYS: alerts, usage, review pauses, supervisor timings, pushes and cleanup may change during a run", () => {
  for (const k of ["notify.events.featureVerified", "notify.morningSummaryAt", "usage.weeklyPauseAtPct", "review.pauseAt", "supervisor.stallMin", "git.push", "git.tagPhaseEnds", "footprint.docker"]) assert.ok(isSafeLiveKey(k), k);
  for (const k of ["builder.model", "builder.effort", "gate.verifyAt", "tester.model", "security.blockOn", "checks", "guard.deny", "permissions.allow", "git.commitEachStep", "retries.maxAttemptsPerStep", "notifyx"]) assert.ok(!isSafeLiveKey(k), k);
  assert.ok(SAFE_LIVE_KEYS.includes("notify"));
});
