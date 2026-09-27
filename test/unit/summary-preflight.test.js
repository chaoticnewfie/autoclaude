import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSummary, progressEntries } from "../../plugins/autoclaude/lib/summary.js";
import { preflight, checkRunnable, playwrightBrowsersDir, formatPreflight } from "../../plugins/autoclaude/lib/preflight.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("progressEntries reads the gate's progress lines", () => {
  const e = progressEntries("# Progress\n\n- 2026-09-26 S1.1 One (attempt 1)\n- 2026-09-27 S1.2 Two words (attempt 3)\nnot a line\n");
  assert.deepEqual(e, [{ date: "2026-09-26", id: "S1.1", title: "One", attempt: 1 }, { date: "2026-09-27", id: "S1.2", title: "Two words", attempt: 3 }]);
});

test("buildSummary: steps, attempts, decisions, follow-ups, findings, usage used and elapsed time", () => {
  const root = tmp("autoclaude-sum-");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "PROGRESS.md"), "- 2026-09-26 S1.1 One (attempt 1)\n- 2026-09-27 S1.2 Two (attempt 3)\n");
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), "## D-001 x\n## D-002 y\n## N-001 note\n");
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), "| Date |\n|---|\n| 2026-09-27 | bug bash | S1.2 | medium: x | Claude | open |\n");
  fs.writeFileSync(path.join(root, "docs", "SECURITY-FINDINGS.md"), "| 2026-09-27 | low | a.js:1 | i | f | open |\n| 2026-09-27 | low | b.js:2 | i | f | open |\n");
  const parsed = parsePlan("# P\n\n## Phase 1: A\n- [x] **S1.1** One\n  - Accept: a\n- [x] **S1.2** Two\n  - Accept: b\n- [ ] **S1.3** Three\n  - Accept: c\n");
  const now = Date.parse("2026-09-27T06:30:00Z");
  const text = buildSummary({ root, config: mergeConfig({}), state: { status: "running", currentStep: "S1.3", startedAt: "2026-09-27T04:00:00Z", usageAtStart: 11 }, parsed, usage: { sevenDay: { pct: 19.4 } }, now, sinceDate: "2026-09-27" });
  assert.match(text, /Steps: 2\/3 verified, 1 since 2026-09-27\./);
  assert.match(text, /Attempts: 3 for 1 step \(0 passed first time\)\./);
  assert.match(text, /Decisions logged: 2, owner notes handled: 1\. Follow-ups: 1\. Security findings filed: 2\./);
  assert.match(text, /Weekly usage: 19% \(8 points this run\)\./);
  assert.match(text, /Elapsed: 2 h 30 min\./);
  assert.match(text, /Now: running S1\.3\./);
});

test("checkRunnable: absolute paths, PATH lookups and npm scripts", () => {
  const root = tmp("autoclaude-pf-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x", lint: "y" } }));
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") };
  assert.equal(checkRunnable(`${JSON.stringify(process.execPath)} -e 1`, root, env).ok, true);
  assert.equal(checkRunnable("npm test", root, env).ok, true);
  assert.equal(checkRunnable("npm run lint", root, env).ok, true);
  assert.match(checkRunnable("npm run typecheck", root, env).detail, /no "typecheck" script/);
  assert.match(checkRunnable("definitely-missing-tool --x", root, env).detail, /not on PATH/);
  assert.match(checkRunnable('"C:/nope/tool.exe" x', root, env).detail, /does not exist/);
  assert.ok(playwrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: "D:/pw" }) === "D:/pw");
});

test("preflight on a fixture: every problem is reported, trust is read from the user config and never written", async () => {
  const env = gitEnv({ ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") });
  const root = tmp("autoclaude-pf-proj-");
  prepareFixture({ dest: root, plan: "broken", git: true, env, devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 5 } });
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
  const project = { root, config: mergeConfig(cfg) };
  let r = await preflight(project, { env, userConfigFile });
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(r.ok, false);
  assert.equal(byName.trust.status, "fail", "no user config: onboarding and trust unknown");
  assert.match(byName.trust.detail, /Run `claude` once in/);
  assert.equal(byName.plan.status, "ok");
  assert.equal(byName.git.status, "ok");
  assert.equal(byName.checks.status, "ok");
  assert.equal(byName.playwright, undefined, "no UI steps in the broken plan, so no browser needed");
  assert.ok(!fs.existsSync(userConfigFile), "never written");

  const top = root.replace(/\\/g, "/");
  fs.writeFileSync(userConfigFile, JSON.stringify({ hasCompletedOnboarding: true, projects: { [top]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(root, "stray.txt"), "dirty");
  r = await preflight(project, { env, userConfigFile });
  const again = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(again.trust.status, "ok");
  assert.equal(again.git.status, "fail");
  assert.match(formatPreflight(r), /FAIL git: the working tree has 1 uncommitted change/);
  fs.unlinkSync(path.join(root, "stray.txt"));
  r = await preflight(project, { env, userConfigFile, skip: ["notify", "usage"] });
  assert.equal(r.ok, true, formatPreflight(r));

  // A shell without git on PATH (seen live: the run window inherited one) fails preflight, even
  // for a run already under way, which skips the repository checks but not the tools.
  const noGit = { ...env, PATH: path.dirname(process.execPath) };
  r = await preflight(project, { env: noGit, userConfigFile, skip: ["plan", "git", "checks", "playwright", "devserver", "usage", "notify"] });
  const tools = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(r.ok, false);
  assert.equal(tools["git-cli"].status, "fail");
  assert.match(formatPreflight(r), /FAIL git-cli: `git` is not on PATH; the gate commits every verified step/);
  r = await preflight(project, { env: noGit, userConfigFile });
  assert.match(formatPreflight(r), /FAIL git: `git` is not on PATH, so the repository cannot be checked/);
});
