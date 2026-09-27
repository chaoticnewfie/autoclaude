import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULTS, mergeConfig, validateConfig, loadConfig, formatConfigErrors } from "../../plugins/autoclaude/lib/config.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-config-"));

test("mergeConfig fills every default and lets the user override deep keys", () => {
  const cfg = mergeConfig({ retries: { maxAttemptsPerStep: 5 }, checks: [{ name: "unit", command: "npm test", timeoutSec: 60 }] });
  assert.equal(cfg.retries.maxAttemptsPerStep, 5);
  assert.equal(cfg.retries.maxNoProgressStops, DEFAULTS.retries.maxNoProgressStops);
  assert.equal(cfg.review.pauseAt, "never");
  assert.equal(cfg.docs.decisions, "docs/DECISIONS.md");
  assert.deepEqual(cfg.checks, [{ name: "unit", command: "npm test", timeoutSec: 60 }]);
  assert.equal(validateConfig(cfg).length, 0);
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
  assert.equal(r.config.tester.model, "sonnet");
});
