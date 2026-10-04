import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULTS, mergeConfig, validateConfig, loadConfig, formatConfigErrors, PROJECT_ONLY_KEYS, SAFE_LIVE_KEYS, isSafeLiveKey,
  machineDefaultsFile, loadLayers, writeProjectConfig, writeMachineDefaults, readMachineDefaults, configTemplate, EFFORTS,
  setRunPlan, clearRunPlan, runPlanOverride, readRunPlan, runPlanFile, RUN_PLAN_ERROR_PATH, ACCEPTED_FILE, resolveRunPlanSource,
  continueHereFor, runPlanTag, updateProjectConfig
} from "../../plugins/autoclaude/lib/config.js";
import { runCli } from "../../plugins/autoclaude/lib/cli.js";
import { collectHandback, handoffFileFor } from "../../plugins/autoclaude/lib/summary.js";
import { defaultState } from "../../plugins/autoclaude/lib/state.js";

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
  assert.deepEqual(cfg.checkers, { effort: "xhigh", parallel: "security" }, "one effort for every checker, xhigh unless set (D55); the security review alongside the browser checks (D60)");
  assert.deepEqual(cfg.gate, { timeoutSec: 1800, verifyAt: "phase", fitPct: 70, stepPhases: [] });
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

test("checkers.effort: null or low to max; ultracode and other words are refused (D55)", () => {
  for (const e of [null, "low", "medium", "high", "xhigh", "max"]) assert.deepEqual(validateConfig(mergeConfig({ checkers: { effort: e } })), [], String(e));
  for (const e of ["ultracode", "turbo", 3]) assert.equal(validateConfig(mergeConfig({ checkers: { effort: e } }))[0].path, "checkers.effort", String(e));
});

test("checkers.parallel: security (the default), off or all; anything else is refused, and it is locked while a run is going", () => {
  for (const v of ["security", "off", "all"]) assert.deepEqual(validateConfig(mergeConfig({ checkers: { parallel: v } })), [], v);
  for (const v of ["on", "tester", true, null, 2]) {
    const errors = validateConfig(mergeConfig({ checkers: { parallel: v } }));
    assert.deepEqual(errors.map((e) => e.path), ["checkers.parallel"], JSON.stringify(v));
    assert.match(errors[0].message, /expected one of security, off, all/);
  }
  // An older project file that sets only the effort keeps the default.
  assert.equal(mergeConfig({ checkers: { effort: "high" } }).checkers.parallel, "security");
  assert.equal(isSafeLiveKey("checkers.parallel"), false);
});

// ---------- Phase 10: sweeps, the findings file, the run-plan override (D58) ----------

test("the sweep defaults: 3 sessions at once, thorough, advisories on, wait at 90% of the 5-hour window, fix right away", () => {
  assert.deepEqual(mergeConfig({}).sweep, { concurrency: 3, depth: "thorough", advisories: true, waitAt5hPct: 90, maxTurnsPerAgent: 40, timeoutSecPerAgent: 900, after: "fix" });
  assert.equal(mergeConfig({ sweep: { depth: "standard" } }).sweep.concurrency, 3, "a partial sweep block keeps the other defaults");
  assert.equal(PROJECT_ONLY_KEYS.includes("sweep"), false, "a computer may set its own sweep defaults");
  // A run never reads them, and a running sweep has its options in its own sweep.json.
  for (const k of ["sweep", "sweep.concurrency", "sweep.after", "sweep.depth", "sweep.advisories"]) assert.equal(isSafeLiveKey(k), true, k);
});

test("sweep validation: concurrency 1 to 8, depth and after from their lists, waitAt5hPct 1 to 100", () => {
  for (const ok of [{ concurrency: 1 }, { concurrency: 8 }, { depth: "standard" }, { depth: "quick" }, { after: "report" }, { after: "plan" }, { waitAt5hPct: 1 }, { waitAt5hPct: 100 }, { advisories: false }]) {
    assert.deepEqual(validateConfig(mergeConfig({ sweep: ok })), [], JSON.stringify(ok));
  }
  const bad = [
    [{ concurrency: 0 }, "sweep.concurrency", /whole number from 1 to 8/], [{ concurrency: 9 }, "sweep.concurrency"], [{ concurrency: 2.5 }, "sweep.concurrency"], [{ concurrency: "3" }, "sweep.concurrency"],
    [{ depth: "deep" }, "sweep.depth", /thorough, standard, quick/], [{ after: "now" }, "sweep.after", /report, plan, fix/],
    [{ waitAt5hPct: 0 }, "sweep.waitAt5hPct", /1 to 100/], [{ waitAt5hPct: 101 }, "sweep.waitAt5hPct"], [{ advisories: "yes" }, "sweep.advisories"],
    [{ maxTurnsPerAgent: 0 }, "sweep.maxTurnsPerAgent"], [{ timeoutSecPerAgent: -5 }, "sweep.timeoutSecPerAgent"]
  ];
  for (const [over, p, msg] of bad) {
    const errs = validateConfig(mergeConfig({ sweep: over }));
    assert.deepEqual(errs.map((e) => e.path), [p], JSON.stringify(over));
    if (msg) assert.match(errs[0].message, msg);
  }
  assert.deepEqual(validateConfig(mergeConfig({ sweep: "on" })).map((e) => e.path), ["sweep"]);
  // A bad sweep setting in this computer's defaults is ignored, never fatal.
  const machineFile = path.join(tmpDir(), "defaults.json");
  fs.writeFileSync(machineFile, JSON.stringify({ sweep: { concurrency: 20, depth: "standard" } }));
  const m = readMachineDefaults(machineFile);
  assert.deepEqual(m.values, { sweep: { depth: "standard" } });
  assert.deepEqual(m.problems.map((p) => p.path), ["sweep.concurrency"]);
});

test("docs.security defaults to the gitignored docs/private/SECURITY-FINDINGS.md; a project's own path is kept", () => {
  assert.equal(DEFAULTS.docs.security, "docs/private/SECURITY-FINDINGS.md");
  assert.equal(configTemplate({}).docs.security, "docs/private/SECURITY-FINDINGS.md", "a new project's file names the private path");
  assert.equal(mergeConfig({ docs: { security: "docs/SECURITY-FINDINGS.md" } }).docs.security, "docs/SECURITY-FINDINGS.md");
  assert.equal(ACCEPTED_FILE, "autoclaude.accepted.json");
});

function planProject() {
  const root = tmpDir();
  writeProjectConfig(root, { version: 1, plan: "PLAN.md" });
  const plan = (title, step) => `# ${title}\n\n## After the run\n\n- ${title}: left for you\n\n## Phase 1: Work\n\n- [ ] **${step}** Do it\n  - Accept: it is done\n`;
  fs.writeFileSync(path.join(root, "PLAN.md"), plan("Main plan", "S1.1"));
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), plan("Security fixes 2026-10-02", "S1.1") + "- [ ] **S1.2** Another\n  - Accept: also done\n");
  return root;
}

test("the run-plan override: loadConfig applies it, loadLayers (the settings page) never does, and it clears", () => {
  const root = planProject();
  let r = loadConfig(root);
  assert.deepEqual([r.config.plan, r.mainPlan, r.runPlan], ["PLAN.md", "PLAN.md", null]);
  assert.equal(runPlanOverride(root), null);

  const at = new Date("2026-10-02T14:30:00Z");
  assert.equal(setRunPlan(root, path.join(root, "SECURITY_PLAN.md"), { now: at }), "SECURITY_PLAN.md", "an absolute path inside the project is made relative");
  assert.deepEqual(JSON.parse(fs.readFileSync(runPlanFile(root), "utf8")), { plan: "SECURITY_PLAN.md", since: at.toISOString() });
  assert.equal(runPlanFile(root), path.join(root, ".autoclaude", "run-plan.json"));
  r = loadConfig(root);
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.config.plan, r.mainPlan, r.runPlan], ["SECURITY_PLAN.md", "PLAN.md", "SECURITY_PLAN.md"]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8")).plan, "PLAN.md", "the project's file is untouched");
  assert.equal(loadLayers(root).merged.plan, "PLAN.md", "the settings page shows the project's own plan");
  assert.deepEqual(readRunPlan(root), { exists: true, plan: "SECURITY_PLAN.md", since: at.toISOString(), branch: null, source: null, sweepId: null, error: null });
  // `run --plan` also records the branch it made and where the plan came from.
  setRunPlan(root, "SECURITY_PLAN.md", { now: at, branch: "autoclaude/security-fixes-2026-10-02-2", source: ".autoclaude/sweeps/s1/SECURITY_PLAN.md", sweepId: "s1" });
  assert.deepEqual(JSON.parse(fs.readFileSync(runPlanFile(root), "utf8")), { plan: "SECURITY_PLAN.md", since: at.toISOString(), branch: "autoclaude/security-fixes-2026-10-02-2", source: ".autoclaude/sweeps/s1/SECURITY_PLAN.md", sweepId: "s1" });
  assert.deepEqual(readRunPlan(root), { exists: true, plan: "SECURITY_PLAN.md", since: at.toISOString(), branch: "autoclaude/security-fixes-2026-10-02-2", source: ".autoclaude/sweeps/s1/SECURITY_PLAN.md", sweepId: "s1", error: null });
  // A sub-folder path keeps forward slashes.
  assert.equal(setRunPlan(root, "plans\\fix.md"), "plans/fix.md");
  assert.equal(loadConfig(root).config.plan, "plans/fix.md");

  assert.equal(clearRunPlan(root), true);
  assert.equal(clearRunPlan(root), false, "clearing twice is harmless");
  assert.equal(loadConfig(root).config.plan, "PLAN.md");
  // Without a project file the override still applies over the defaults.
  const bare = tmpDir();
  setRunPlan(bare, "OPTIMIZE_PLAN.md");
  assert.equal(loadConfig(bare).config.plan, "OPTIMIZE_PLAN.md");
});

test("the run-plan override refuses a plan outside the project or in .autoclaude/, and a broken one is an error, never a guess", () => {
  const root = planProject();
  for (const bad of ["", "../other/PLAN.md", path.join(os.tmpdir(), "x.md"), ".autoclaude/sweeps/x/PLAN.md", ".AutoClaude\\p.md", "."]) {
    assert.throws(() => setRunPlan(root, bad), /cannot run on that plan/, JSON.stringify(bad));
  }
  assert.equal(fs.existsSync(runPlanFile(root)), false, "nothing was written");
  for (const [text, why] of [["{ broken", /not valid JSON/], [JSON.stringify({ plan: "../x.md" }), /not inside the project/], [JSON.stringify({ nope: 1 }), /names no plan file/], ["[]", /names no plan file/]]) {
    fs.mkdirSync(path.dirname(runPlanFile(root)), { recursive: true });
    fs.writeFileSync(runPlanFile(root), text);
    const r = loadConfig(root);
    assert.equal(r.config.plan, "PLAN.md", "a broken override never points a run at a guessed plan");
    assert.equal(r.runPlan, null);
    assert.deepEqual(r.errors.map((e) => e.path), [RUN_PLAN_ERROR_PATH]);
    assert.match(r.errors[0].message, why);
    assert.equal(runPlanOverride(root), null);
  }
});

test("resolveRunPlanSource: a sweep's plan is copied to the root under its own name; any other plan in the project is worked where it is", () => {
  const root = planProject();
  const sweepPlan = path.join(root, ".autoclaude", "sweeps", "20261002-0905-security", "SECURITY_PLAN.md");
  assert.deepEqual(resolveRunPlanSource(root, sweepPlan), { source: ".autoclaude/sweeps/20261002-0905-security/SECURITY_PLAN.md", target: "SECURITY_PLAN.md", sweepId: "20261002-0905-security", error: null });
  assert.deepEqual(resolveRunPlanSource(root, ".autoclaude\\sweeps\\20261002-1200-optimize\\OPTIMIZE_PLAN.md"), { source: ".autoclaude/sweeps/20261002-1200-optimize/OPTIMIZE_PLAN.md", target: "OPTIMIZE_PLAN.md", sweepId: "20261002-1200-optimize", error: null });
  assert.deepEqual(resolveRunPlanSource(root, "SECURITY_PLAN.md"), { source: "SECURITY_PLAN.md", target: "SECURITY_PLAN.md", sweepId: null, error: null });
  assert.deepEqual(resolveRunPlanSource(root, "plans\\fix.md"), { source: "plans/fix.md", target: "plans/fix.md", sweepId: null, error: null });
  for (const [bad, why] of [["", /names no plan file/], ["../x.md", /is not inside the project/], [path.join(os.tmpdir(), "x.md"), /is not inside the project/], [".autoclaude/X_PLAN.md", /is inside \.autoclaude\/, which is never committed.*only a plan a sweep wrote in \.autoclaude\/sweeps\/<id>\/ is taken from there/], [".autoclaude/sweeps/x/sub/X.md", /inside \.autoclaude\//], [".autoclaude/sweeps/x/notes.txt", /inside \.autoclaude\//]]) {
    const r = resolveRunPlanSource(root, bad);
    assert.equal(r.source, null, JSON.stringify(bad));
    assert.match(r.error, why, JSON.stringify(bad));
  }
});

test("every config.plan reader follows the override: the CLI, the hand-back and the session context read the generated plan", async () => {
  const root = planProject();
  setRunPlan(root, "SECURITY_PLAN.md");
  const out = [];
  const io = { cwd: root, stdout: { write: (s) => out.push(s) }, stderr: { write: (s) => out.push(s) } };
  assert.equal(await runCli(["lint-plan"], io), 0, out.join(""));
  assert.match(out.join(""), /SECURITY_PLAN\.md ok: 2 steps in 1 phases/);
  const { config } = loadConfig(root);
  const got = collectHandback({ root, config, state: defaultState(), parsed: null });
  assert.deepEqual(got.ownerItems.filter((i) => i.from === "plan").map((i) => i.text), ["Security fixes 2026-10-02: left for you"]);
  const { buildContext } = await import("../../plugins/autoclaude/scripts/session-context.js");
  const ctx = buildContext({ root, state: { ...defaultState(), status: "running", currentStep: "S1.1" }, config, planText: fs.readFileSync(path.join(root, config.plan), "utf8"), progressText: "", promptTemplate: "Plan: {{PLAN_FILE}}" });
  assert.match(ctx, /Plan: SECURITY_PLAN\.md/);
  clearRunPlan(root);
  out.length = 0;
  assert.equal(await runCli(["lint-plan"], io), 0);
  assert.match(out.join(""), /PLAN\.md ok: 1 steps in 1 phases/);
  assert.equal(out.join("").includes("SECURITY_PLAN"), false);
});

test("a run on a generated plan has its own resume file: CONTINUE_HERE-SECURITY.md, named like its hand-back (D59)", () => {
  assert.equal(continueHereFor("CONTINUE_HERE.md", "SECURITY_PLAN.md"), "CONTINUE_HERE-SECURITY.md");
  assert.equal(continueHereFor("CONTINUE_HERE.md", "OPTIMIZE_PLAN.md"), "CONTINUE_HERE-OPTIMIZE.md");
  assert.equal(continueHereFor("docs\\RESUME.md", "plans/fix.md"), "docs/RESUME-FIX.md", "next to the project's own, forward slashes");
  assert.equal(continueHereFor("./CONTINUE_HERE.md", "PLAN.md"), "CONTINUE_HERE-RUN.md");
  assert.equal(continueHereFor("NOTES", "SECURITY_PLAN.md"), "NOTES-SECURITY.md");
  for (const p of ["SECURITY_PLAN.md", "OPTIMIZE_PLAN.md", "plans/fix.md", "my plan.md", "PLAN.md"]) assert.equal(`HANDOFF-${runPlanTag(p)}.md`, handoffFileFor(p), p);

  const root = planProject();
  let r = loadConfig(root);
  assert.deepEqual([r.config.docs.continueHere, r.mainContinueHere], ["CONTINUE_HERE.md", "CONTINUE_HERE.md"]);
  setRunPlan(root, "SECURITY_PLAN.md");
  r = loadConfig(root);
  assert.deepEqual(r.errors, []);
  assert.deepEqual([r.config.plan, r.config.docs.continueHere, r.mainContinueHere], ["SECURITY_PLAN.md", "CONTINUE_HERE-SECURITY.md", "CONTINUE_HERE.md"]);
  assert.equal(r.config.docs.progress, "PROGRESS.md", "the other docs are the project's");
  assert.equal(loadLayers(root).merged.docs.continueHere, "CONTINUE_HERE.md", "the settings page shows the project's own");
  setRunPlan(root, "OPTIMIZE_PLAN.md");
  assert.equal(loadConfig(root).config.docs.continueHere, "CONTINUE_HERE-OPTIMIZE.md");
  // A project that names its own resume file: the run's sits next to it.
  writeProjectConfig(root, { version: 1, plan: "PLAN.md", docs: { continueHere: "docs/RESUME.md" } });
  r = loadConfig(root);
  assert.deepEqual([r.config.docs.continueHere, r.mainContinueHere], ["docs/RESUME-OPTIMIZE.md", "docs/RESUME.md"]);
  // A broken override or none: the project's own resume file.
  fs.writeFileSync(runPlanFile(root), "{ broken");
  assert.equal(loadConfig(root).config.docs.continueHere, "docs/RESUME.md");
  clearRunPlan(root);
  assert.equal(loadConfig(root).config.docs.continueHere, "docs/RESUME.md");
});

test("the session context and the gate follow the run's resume file through loadConfig", async () => {
  const root = planProject();
  setRunPlan(root, "SECURITY_PLAN.md");
  const { config } = loadConfig(root);
  const { buildContext } = await import("../../plugins/autoclaude/scripts/session-context.js");
  const ctx = buildContext({ root, state: { ...defaultState(), status: "running", currentStep: "S1.1" }, config, planText: fs.readFileSync(path.join(root, config.plan), "utf8"), progressText: "", promptTemplate: "Read `{{CONTINUE_HERE}}` first, rewrite `{{CONTINUE_HERE}}` before ready." });
  assert.match(ctx, /Read `CONTINUE_HERE-SECURITY\.md` first, rewrite `CONTINUE_HERE-SECURITY\.md` before ready\./);
  assert.equal(/`CONTINUE_HERE\.md`/.test(ctx), false, "the project's own resume file is not the builder's");
  // The real prompt uses the placeholder, never the file name.
  const prompt = fs.readFileSync(fileURLToPath(new URL("../../plugins/autoclaude/prompts/context.md", import.meta.url)), "utf8");
  assert.match(prompt, /\{\{CONTINUE_HERE\}\}/);
  assert.equal(prompt.includes("CONTINUE_HERE.md"), false);
  // The gate takes its config from loadConfig and names the resume file only through
  // config.docs.continueHere (the comments aside).
  const gate = fs.readFileSync(fileURLToPath(new URL("../../plugins/autoclaude/lib/gate.js", import.meta.url)), "utf8");
  assert.match(gate, /loadConfig\(root\)/);
  assert.match(gate, /\bconfig\.docs\.continueHere\b/);
  const code = gate.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  assert.equal(code.includes("CONTINUE_HERE"), false, "no resume file name written into the gate's code");
  clearRunPlan(root);
});

test("no module reads the project's config except through loadConfig, so the override reaches every config.plan reader", () => {
  const pluginDir = fileURLToPath(new URL("../../plugins/autoclaude/", import.meta.url));
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && !["node_modules", "project-template", "prompts", "skills", "agents"].includes(e.name)) walk(p);
      else if (e.isFile() && /\.(m?js)$/.test(e.name)) files.push(p);
    }
  };
  walk(pluginDir);
  assert.ok(files.length > 20, `found ${files.length} plugin modules`);
  const rawReaders = /\b(readProjectConfig|loadLayers|mergeLayers|mergeConfig|readMachineDefaults)\s*\(/;
  const allowed = new Set(["config.js", "configpage.js"]);
  const readsPlan = /\b(config|cfg|cfgNow\(\))\.plan\b/;
  for (const f of files) {
    const text = fs.readFileSync(f, "utf8");
    const name = path.basename(f);
    if (!allowed.has(name)) {
      assert.equal(rawReaders.test(text), false, `${name} builds a config without loadConfig`);
      for (const line of text.split("\n")) {
        if (/(CONFIG_FILE|autoclaude\.config\.json)/.test(line) && /\b(readText|readJson|readFileSync|JSON\.parse)\s*\(/.test(line)) assert.fail(`${name} reads the config file directly: ${line.trim()}`);
      }
    }
    // The settings page edits the project's own file and must never act on config.plan.
    if (name === "configpage.js") assert.equal(readsPlan.test(text), false, "configpage.js reads config.plan");
  }
  // The readers named in the plan's research all exist and get their config from loadConfig or a caller that does.
  const readers = files.filter((f) => readsPlan.test(fs.readFileSync(f, "utf8"))).map((f) => path.basename(f)).sort();
  for (const want of ["cli.js", "gate.js", "session-context.js", "tool-guard.js"]) assert.ok(readers.includes(want), `${want} reads config.plan: ${readers.join(", ")}`);
});

// ---------- P10.13: phases that fit their verification (D60) ----------

test("gate.fitPct is a number from 30 to 95 (default 70); gate.stepPhases a list of phase numbers (default none)", () => {
  const cfg = mergeConfig({ gate: { timeoutSec: 1200 } });
  assert.deepEqual([cfg.gate.fitPct, cfg.gate.stepPhases], [70, []], "a partial gate block keeps both defaults");
  for (const ok of [30, 50, 70, 95, 72.5]) assert.deepEqual(validateConfig(mergeConfig({ gate: { fitPct: ok } })), [], String(ok));
  for (const bad of [29, 96, 0, "70", null]) {
    const errs = validateConfig(mergeConfig({ gate: { fitPct: bad } }));
    assert.deepEqual(errs.map((e) => e.path), ["gate.fitPct"], String(bad));
    assert.match(errs[0].message, /from 30 to 95/);
  }
  assert.deepEqual(validateConfig(mergeConfig({ gate: { stepPhases: [2, 5] } })), []);
  const errs = validateConfig(mergeConfig({ gate: { stepPhases: [3, 0, 1.5, "4", -2] } }));
  assert.deepEqual(errs.map((e) => e.path), ["gate.stepPhases[1]", "gate.stepPhases[2]", "gate.stepPhases[3]", "gate.stepPhases[4]"]);
  assert.match(errs[0].message, /a phase number/);
  assert.deepEqual(validateConfig(mergeConfig({ gate: { stepPhases: 3 } })).map((e) => e.path), ["gate.stepPhases"]);
  // Neither may change while a run is going: both change how a feature is checked. A paused run
  // is the normal time to change them (`verify-per-step`, the settings page).
  for (const k of ["gate.fitPct", "gate.stepPhases"]) assert.equal(isSafeLiveKey(k), false, k);
});

test("gate.stepPhases is a project's own: in this computer's defaults it is reported and ignored, gate.fitPct is kept", () => {
  const machineFile = path.join(tmpDir(), "defaults.json");
  const root = tmpDir();
  writeProjectConfig(root, { version: 1 });
  fs.writeFileSync(machineFile, JSON.stringify({ gate: { fitPct: 80, stepPhases: [2] } }));
  const m = readMachineDefaults(machineFile);
  assert.deepEqual(m.values, { gate: { fitPct: 80 } });
  const p = m.problems.find((x) => x.path === "gate.stepPhases");
  assert.ok(p, JSON.stringify(m.problems));
  assert.match(p.message, /belongs to a project's autoclaude\.config\.json/);
  const r = loadConfig(root, { machineFile });
  assert.deepEqual([r.config.gate.fitPct, r.config.gate.stepPhases, r.errors], [80, [], []]);
  // A project sets its own.
  writeProjectConfig(root, { version: 1, gate: { stepPhases: [4] } });
  assert.deepEqual(loadConfig(root, { machineFile }).config.gate.stepPhases, [4]);
  // Only stepPhases goes: a computer file whose gate holds nothing else loses the empty group.
  fs.writeFileSync(machineFile, JSON.stringify({ gate: { stepPhases: [2] }, tester: { maxTurns: 30 } }));
  assert.deepEqual(readMachineDefaults(machineFile).values, { tester: { maxTurns: 30 } });
});

test("updateProjectConfig edits the project's own file only, and refuses a missing or broken one", () => {
  const machineFile = path.join(tmpDir(), "defaults.json");
  writeMachineDefaults({ tester: { maxTurns: 30 } }, machineFile);
  const root = tmpDir();
  assert.throws(() => updateProjectConfig(root, () => {}), /does not exist; run autoclaude init first/);
  assert.equal(fs.existsSync(path.join(root, "autoclaude.config.json")), false);
  writeProjectConfig(root, { version: 1, gate: { timeoutSec: 1200 } });
  const out = updateProjectConfig(root, (raw) => { raw.gate.stepPhases = [3]; });
  assert.deepEqual(out, { version: 1, gate: { timeoutSec: 1200, stepPhases: [3] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8")), out, "nothing inherited is copied in");
  assert.deepEqual(updateProjectConfig(root, () => ({ version: 1 })), { version: 1 }, "a returned object replaces it");
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), "{ broken");
  assert.throws(() => updateProjectConfig(root, () => {}), /not valid JSON.*fix it by hand first/);
  assert.equal(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"), "{ broken");
});
