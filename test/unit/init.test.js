import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { initProject, detectProject, formatInitReport, playwrightMcpConfig, existingProjectSignals, serverEntry, projectName } from "../../plugins/autoclaude/lib/init.js";
import { gitEnv } from "../fixtures/prepare.js";

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
  assert.equal(d.devServer.url, "http://127.0.0.1:5173");
  assert.equal(d.notes.length, 0);

  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { dev: "node server.js --port 4173" } }));
  const d2 = detectProject(root);
  assert.equal(d2.devServer.url, "http://127.0.0.1:4173");
  assert.deepEqual(d2.checks, []);
  assert.ok(d2.notes.some((n) => /no lint, typecheck or test scripts/.test(n)));

  const bare = tmp("autoclaude-init-bare-");
  const d3 = detectProject(bare);
  assert.equal(d3.hasPackageJson, false);
  assert.equal(d3.devServer.command, null);
});

test("detectProject reads a Node dev server's default port and health route; the name comes from package.json", () => {
  const root = tmp("autoclaude-init-entry-");
  fs.writeFileSync(path.join(root, "server.js"), "const port = Number(process.env.PORT || 4173);\napp.get(\"/health\", ok);\nserver.listen(port, \"127.0.0.1\");\n");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@home/kitchen-todos", scripts: { dev: "node --watch server.js" } }));
  const d = detectProject(root);
  assert.deepEqual([d.devServer.command, d.devServer.url, d.devServer.healthPath], ["npm run dev", "http://127.0.0.1:4173", "/health"]);
  assert.ok(!d.notes.some((n) => /port is unknown/.test(n)), "the port was read, not guessed");
  assert.deepEqual(serverEntry(root, "node src/missing.js"), null);
  fs.writeFileSync(path.join(root, "app.mjs"), "http.createServer(h).listen(8080);\n");
  assert.equal(serverEntry(root, "node app.mjs").port, "8080");
  assert.equal(projectName(root), "kitchen-todos");
  const bare = tmp("autoclaude-init-noname-");
  assert.equal(projectName(bare), path.basename(bare));
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

test("detectProject adds no e2e check without a dev server, and says why", () => {
  const root = tmp("autoclaude-init-noe2e-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest run", e2e: "playwright test" } }));
  const d = detectProject(root);
  assert.equal(d.devServer.command, null);
  assert.deepEqual(d.checks.map((c) => c.name), ["unit"]);
  assert.ok(d.notes.some((n) => /found "npm run e2e" but no dev server was detected, so it is not a check yet/.test(n)), d.notes.join("\n"));
});

test("existingProjectSignals: agent docs, plan-like markdown and git history count; a bare folder does not", () => {
  const env = gitEnv();
  const bare = tmp("autoclaude-init-sig-");
  assert.deepEqual(existingProjectSignals(bare, env), []);
  for (const f of ["CLAUDE.md", "AGENTS.md", "ROADMAP.md", "todo.md", "NEXT.md"]) {
    const root = tmp("autoclaude-init-sig-");
    fs.writeFileSync(path.join(root, f), "x\n");
    assert.deepEqual(existingProjectSignals(root, env), [f]);
  }
  const docs = tmp("autoclaude-init-sig-");
  fs.mkdirSync(path.join(docs, "docs"));
  fs.writeFileSync(path.join(docs, "docs", "DECISIONS.md"), "x\n");
  assert.deepEqual(existingProjectSignals(docs, env), []);
  fs.writeFileSync(path.join(docs, "docs", "plan-v2.md"), "x\n");
  assert.deepEqual(existingProjectSignals(docs, env), ["docs/plan-v2.md"]);

  // A repository counts once a commit holds files, even when nothing else is there.
  const repo = tmp("autoclaude-init-sig-git-");
  const git = (...args) => spawnSync("git", args, { cwd: repo, env, encoding: "utf8" });
  git("init", "-q");
  assert.deepEqual(existingProjectSignals(repo, env), [], "no commit yet");
  git("config", "user.name", "T");
  git("config", "user.email", "t@localhost");
  fs.mkdirSync(path.join(repo, "lib"));
  fs.writeFileSync(path.join(repo, "lib", "main.py"), "print(1)\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  fs.rmSync(path.join(repo, "lib"), { recursive: true });
  assert.deepEqual(existingProjectSignals(repo, env), ["git history"]);
  // A new subfolder of a repository is still a new project.
  const sub = path.join(repo, "newapp");
  fs.mkdirSync(sub);
  assert.deepEqual(existingProjectSignals(sub, env), []);
});

test("init keeps the owner's CLAUDE.md and says /autoclaude:plan adds an AutoClaude section to it", () => {
  withConfigDir(() => {
    const template = fakeTemplate();
    const root = tmp("autoclaude-init-own-");
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# House rules\n\nUse tabs.\n");
    const r = initProject(root, { template, statusline: false });
    assert.equal(r.existingProject, true);
    assert.deepEqual(r.existingSignals, ["CLAUDE.md"]);
    assert.ok(r.skipped.includes("CLAUDE.md"));
    assert.equal(r.keptOwnClaudeMd, true);
    const text = formatInitReport(r);
    assert.match(text, /already had its own CLAUDE\.md, which init kept as it was: \/autoclaude:plan reviews the project's own/);
    assert.match(text, /adds an AutoClaude section to that file/);
    assert.doesNotMatch(text, /"planning for an unattended run" rules in CLAUDE\.md/);

    // A CLAUDE.md that already has the AutoClaude rules gets the usual review hint.
    fs.writeFileSync(path.join(root, "CLAUDE.md"), "# House rules\n\n## During an AutoClaude run\n");
    const again = initProject(root, { template, statusline: false });
    assert.equal(again.keptOwnClaudeMd, false);
    assert.match(formatInitReport(again), /already had code or a plan/);
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
    assert.match(fs.readFileSync(path.join(root, "playwright.config.js"), "utf8"), /baseURL: "http:\/\/127\.0\.0\.1:3000"/);
    r = initProject(root, { template, statusline: false, playwright: true });
    assert.ok(r.skipped.includes("playwright.config.js"));
  });
});
