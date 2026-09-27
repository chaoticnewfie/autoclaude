// Builds a scratch project from the todo-app fixture for scenario tests and live runs.
// prepareFixture({ dest, plan, git }) copies the app, applies the plan variant, writes the
// config, and optionally makes it a git repository with one commit. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
export const FIXTURE_APP = path.join(here, "todo-app");
export const FIXTURE_PLANS = path.join(here, "plans");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === ".autoclaude") continue;
    const s = path.join(src, e.name);
    const d = path.join(dest, e.name);
    if (e.isDirectory()) copyDir(s, d); else fs.copyFileSync(s, d);
  }
}

export function gitEnv(env = process.env) {
  const gitDir = "C:\\Program Files\\Git\\cmd";
  const p = env.PATH || env.Path || "";
  return { ...env, PATH: process.platform === "win32" && !p.includes(gitDir) ? `${gitDir};${p}` : p, GIT_TERMINAL_PROMPT: "0" };
}

export function prepareFixture({ dest, plan = "happy", git = true, checks = null, devServer = null, env = process.env }) {
  fs.rmSync(dest, { recursive: true, force: true });
  copyDir(FIXTURE_APP, dest);
  fs.copyFileSync(path.join(FIXTURE_PLANS, `${plan}.md`), path.join(dest, "PLAN.md"));
  const extraChecks = [];
  if (plan === "broken") {
    const impossible = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\n\ntest("impossible", () => {\n  assert.equal(1, 2);\n});\n';
    fs.writeFileSync(path.join(dest, "test", "impossible.test.js"), impossible);
    // The plan forbids touching the impossible test; this check makes the gate enforce it, so the
    // only way out is the three-strikes pause the scenario is meant to demonstrate.
    fs.writeFileSync(path.join(dest, "impossible.orig"), impossible);
    extraChecks.push({ name: "fixture-unchanged", command: `${JSON.stringify(process.execPath)} -e "const f=require('fs');process.exit(f.readFileSync('test/impossible.test.js','utf8')===f.readFileSync('impossible.orig','utf8')?0:1)"`, timeoutSec: 30 });
  }
  if (plan === "ui-bug") {
    const page = path.join(dest, "public", "index.html");
    fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace('id="text"', 'id="txt"'));
  }
  const node = JSON.stringify(process.execPath);
  const config = {
    version: 1,
    plan: "PLAN.md",
    devServer: devServer || { command: `${node} server.js`, url: "http://127.0.0.1:4173", healthPath: "/health", startTimeoutSec: 30 },
    checks: checks || [
      ...extraChecks,
      { name: "lint", command: "npm run lint", timeoutSec: 120 },
      { name: "unit", command: "npm test", timeoutSec: 300 }
    ]
  };
  fs.writeFileSync(path.join(dest, "autoclaude.config.json"), JSON.stringify(config, null, 2) + "\n");
  fs.writeFileSync(path.join(dest, "PROGRESS.md"), "# Progress\n\nOne line per verified step, written by the AutoClaude gate.\n");
  fs.mkdirSync(path.join(dest, "docs"), { recursive: true });
  fs.writeFileSync(path.join(dest, "docs", "DECISIONS.md"), "# DECISIONS\n");
  fs.writeFileSync(path.join(dest, "CONTINUE_HERE.md"), "# CONTINUE_HERE\n\nFresh fixture.\n");
  fs.writeFileSync(path.join(dest, ".gitignore"), ".autoclaude/\nnode_modules/\n");
  if (git) {
    const run = (args) => {
      const r = spawnSync("git", args, { cwd: dest, encoding: "utf8", env: gitEnv(env) });
      if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
      return r.stdout.trim();
    };
    run(["init", "-q", "-b", "main"]);
    run(["config", "user.name", "Fixture"]);
    run(["config", "user.email", "fixture@localhost"]);
    run(["add", "-A"]);
    run(["commit", "-q", "-m", "fixture: initial"]);
  }
  return { dest, config };
}
