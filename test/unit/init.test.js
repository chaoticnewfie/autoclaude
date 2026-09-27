import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject, detectProject, formatInitReport, playwrightMcpConfig } from "../../plugins/autoclaude/lib/init.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

// A tiny stand-in template so the tests do not depend on project-template/ content.
function fakeTemplate() {
  const dir = tmp("autoclaude-tpl-");
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), "# {{PROJECT_NAME}} rules\n\nCreated {{DATE}}.\n");
  fs.writeFileSync(path.join(dir, "PLAN.md"), "# {{PROJECT_NAME}} plan\n");
  fs.mkdirSync(path.join(dir, "docs"));
  fs.writeFileSync(path.join(dir, "docs", "DECISIONS.md"), "# DECISIONS\n");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".autoclaude/\nnode_modules/\n");
  return dir;
}

function withConfigDir(fn) {
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = tmp("autoclaude-cfg-");
  try { return fn(process.env.CLAUDE_CONFIG_DIR); } finally { if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prev; }
}

test("detectProject guesses checks and the dev server from package.json", () => {
  const root = tmp("autoclaude-init-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "vite", lint: "biome check .", typecheck: "tsc --noEmit", test: "vitest run", "test:e2e": "playwright test" }, devDependencies: { vite: "^8" } }));
  const d = detectProject(root);
  assert.deepEqual(d.checks.map((c) => [c.name, c.command, c.needsDevServer || false]), [["lint", "npm run lint", false], ["typecheck", "npm run typecheck", false], ["unit", "npm test", false], ["e2e", "npm run test:e2e", true]]);
  assert.equal(d.devServer.url, "http://localhost:5173");
  assert.equal(d.notes.length, 0);

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "node server.js --port 4173" } }));
  const d2 = detectProject(root);
  assert.equal(d2.devServer.url, "http://localhost:4173");
  assert.deepEqual(d2.checks, []);
  assert.ok(d2.notes.some((n) => /no lint, typecheck or test scripts/.test(n)));

  const bare = tmp("autoclaude-init-bare-");
  const d3 = detectProject(bare);
  assert.equal(d3.hasPackageJson, false);
  assert.equal(d3.devServer.command, null);
});

test("initProject in an empty folder: config, template files with placeholders, gitignore, mcp config, registry; then idempotent", () => {
  withConfigDir((cfgDir) => {
    const template = fakeTemplate();
    const root = path.join(tmp("autoclaude-init-"), "My App");
    const r = initProject(root, { template, statusline: false, now: new Date("2026-09-27T00:00:00Z") });
    assert.equal(r.existingProject, false);
    assert.ok(r.created.includes("autoclaude.config.json"));
    assert.ok(r.created.includes("CLAUDE.md") && r.created.includes("docs/DECISIONS.md"));
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "# My App rules\n\nCreated 2026-09-27.\n");
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
    assert.equal(cfg.version, 1);
    assert.deepEqual(cfg.checks, []);
    assert.equal(cfg.devServer.command, null);
    assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /\.autoclaude\//);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, ".autoclaude", "mcp.playwright.json"), "utf8")), playwrightMcpConfig());
    const reg = JSON.parse(fs.readFileSync(path.join(cfgDir, "autoclaude", "registry.json"), "utf8"));
    assert.equal(reg.projects.length, 1);
    assert.equal(r.registry.added, true);
    assert.equal(r.statusline, null);
    assert.match(formatInitReport(r), /next: review autoclaude\.config\.json/);
    assert.doesNotMatch(formatInitReport(r), /already had code or a plan/);

    fs.writeFileSync(path.join(root, "CLAUDE.md"), "edited by the owner\n");
    const r2 = initProject(root, { template, statusline: false });
    assert.deepEqual(r2.created, []);
    assert.ok(r2.skipped.includes("CLAUDE.md") && r2.skipped.includes("autoclaude.config.json"));
    assert.equal(fs.readFileSync(path.join(root, "CLAUDE.md"), "utf8"), "edited by the owner\n");
    assert.equal(r2.registry.added, false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(cfgDir, "autoclaude", "registry.json"), "utf8")).projects.length, 1);
  });
});

test("initProject on an existing project keeps its files, appends to .gitignore, detects scripts and recommends a plan review", () => {
  withConfigDir(() => {
    const template = fakeTemplate();
    const root = tmp("autoclaude-init-existing-");
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "next dev", test: "vitest run" }, dependencies: { next: "16" } }));
    fs.writeFileSync(path.join(root, "PLAN.md"), "# Their own plan\n");
    fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\n");
    const r = initProject(root, { template, statusline: false, devUrl: "http://127.0.0.1:3005" });
    assert.equal(r.existingProject, true);
    assert.ok(r.skipped.includes("PLAN.md"));
    assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), "# Their own plan\n");
    assert.match(fs.readFileSync(path.join(root, ".gitignore"), "utf8"), /^node_modules\/\n\n# AutoClaude runtime state\n\.autoclaude\/\n$/);
    const cfg = JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
    assert.equal(cfg.devServer.command, "npm run dev");
    assert.equal(cfg.devServer.url, "http://127.0.0.1:3005");
    assert.deepEqual(cfg.checks.map((c) => c.name), ["unit"]);
    assert.match(formatInitReport(r), /already had code or a plan/);
  });
});

test("the Playwright scaffold is written only when asked and never over an existing config", () => {
  withConfigDir(() => {
    const template = fakeTemplate();
    const root = tmp("autoclaude-init-pw-");
    let r = initProject(root, { template, statusline: false });
    assert.equal(fs.existsSync(path.join(root, "playwright.config.js")), false);
    r = initProject(root, { template, statusline: false, playwright: true });
    assert.ok(r.created.includes("playwright.config.js") && r.created.includes("e2e/smoke.spec.js"));
    assert.match(fs.readFileSync(path.join(root, "playwright.config.js"), "utf8"), /baseURL: "http:\/\/localhost:3000"/);
    r = initProject(root, { template, statusline: false, playwright: true });
    assert.ok(r.skipped.includes("playwright.config.js"));
  });
});
