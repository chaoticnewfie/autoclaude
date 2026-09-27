// `autoclaude init`: set a project up for AutoClaude without touching anything that exists.
// PLAN.md P2.1, P2.4, P2.5, D23, R17. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { configTemplate } from "./config.js";
import { writeJsonAtomic, writeFileAtomic, readText, readJson, ensureDir } from "./fsatomic.js";
import { projectPaths, pluginRoot, homeDir, isWindows, CONFIG_FILE } from "./paths.js";
import { findOnPath } from "./proc.js";
import { registerProject } from "./registry.js";
import { installStatusline } from "./statusline.js";

export function templateDir() {
  return path.join(pluginRoot(), "project-template");
}

// Looks at package.json and guesses the checks and the dev server. Every guess is reported.
export function detectProject(root) {
  const pkg = readJson(path.join(root, "package.json"), null);
  const notes = [];
  const checks = [];
  let devServer = { command: null, url: null, healthPath: "/", startTimeoutSec: 90 };
  if (!pkg) {
    notes.push("no package.json: no checks detected; add them to autoclaude.config.json by hand");
    return { checks, devServer, notes, hasPackageJson: false, scripts: {} };
  }
  const scripts = pkg.scripts || {};
  const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
  const has = (n) => typeof scripts[n] === "string" && scripts[n].trim() !== "";
  if (has("lint")) checks.push({ name: "lint", command: "npm run lint", timeoutSec: 300 });
  if (has("typecheck")) checks.push({ name: "typecheck", command: "npm run typecheck", timeoutSec: 300 });
  else if (has("tsc")) checks.push({ name: "typecheck", command: "npm run tsc", timeoutSec: 300 });
  if (has("test")) checks.push({ name: "unit", command: "npm test", timeoutSec: 600 });
  const e2e = ["e2e", "test:e2e", "playwright"].find(has);
  if (e2e) checks.push({ name: "e2e", command: `npm run ${e2e}`, timeoutSec: 900, needsDevServer: true });
  if (checks.length === 0) notes.push("no lint, typecheck or test scripts found in package.json: the gate will only run the browser tester until you add checks");

  if (has("dev") || has("start")) {
    const name = has("dev") ? "dev" : "start";
    const script = scripts[name];
    let url = null;
    const port = (script.match(/--port[= ](\d+)/) || script.match(/PORT=(\d+)/) || [])[1];
    if (port) url = `http://localhost:${port}`;
    else if (deps.vite || deps["@vitejs/plugin-react"]) url = "http://localhost:5173";
    else if (deps.next) url = "http://localhost:3000";
    else if (deps.astro) url = "http://localhost:4321";
    else if (deps["@sveltejs/kit"]) url = "http://localhost:5173";
    if (!url) { url = "http://localhost:3000"; notes.push(`dev server: "npm run ${name}" found but its port is unknown; devServer.url is a guess, check it`); }
    devServer = { command: `npm run ${name}`, url, healthPath: "/", startTimeoutSec: 90 };
  } else {
    notes.push("no dev or start script: devServer left empty (the browser tester needs one for UI steps)");
  }
  return { checks, devServer, notes, hasPackageJson: true, scripts };
}

function walk(dir, rel = "", out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) walk(path.join(dir, e.name), r, out);
    else out.push(r);
  }
  return out;
}

export function playwrightMcpConfig() {
  return isWindows
    ? { mcpServers: { playwright: { command: "cmd", args: ["/c", "npx", "-y", "@playwright/mcp@latest", "--headless"] } } }
    : { mcpServers: { playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless"] } } };
}

export function nativeClaudePath() {
  const p = path.join(homeDir(), ".local", "bin", isWindows ? "claude.exe" : "claude");
  return fs.existsSync(p) ? p : (findOnPath("claude") || null);
}

// Returns a report. Never overwrites an existing file except the runtime MCP config.
export function initProject(root, options = {}) {
  const { devUrl = null, playwright = false, statusline = true, now = new Date(), env = process.env, template = templateDir() } = options;
  root = path.resolve(root);
  ensureDir(root);
  const p = projectPaths(root);
  const report = { root, created: [], skipped: [], warnings: [], notes: [], detected: null, existingProject: false, registry: null, statusline: null };

  const hadPlan = fs.existsSync(path.join(root, "PLAN.md"));
  const hadCode = fs.existsSync(path.join(root, "package.json")) || fs.existsSync(path.join(root, "src")) || fs.existsSync(path.join(root, "app"));
  report.existingProject = hadPlan || hadCode;

  // 1. config
  const detected = detectProject(root);
  report.detected = detected;
  if (devUrl) {
    detected.devServer = { ...detected.devServer, url: devUrl, command: detected.devServer.command || "npm run dev" };
    detected.notes = detected.notes.filter((n) => !/devServer\.url is a guess/.test(n));
  }
  report.notes.push(...detected.notes);
  if (fs.existsSync(p.configFile)) {
    report.skipped.push(CONFIG_FILE);
  } else {
    const cfg = configTemplate({ checks: detected.checks, devServer: detected.devServer });
    writeJsonAtomic(p.configFile, cfg);
    report.created.push(CONFIG_FILE);
  }

  // 2. template files (never overwrite)
  if (fs.existsSync(template)) {
    const name = path.basename(root);
    const date = now.toISOString().slice(0, 10);
    for (const rel of walk(template)) {
      const target = path.join(root, rel);
      if (fs.existsSync(target)) { report.skipped.push(rel); continue; }
      const src = fs.readFileSync(path.join(template, rel), "utf8");
      writeFileAtomic(target, src.replace(/\{\{PROJECT_NAME\}\}/g, name).replace(/\{\{DATE\}\}/g, date));
      report.created.push(rel);
    }
  } else {
    report.warnings.push(`project template not found at ${template}; only the config was written`);
  }

  // 3. .gitignore
  const gi = path.join(root, ".gitignore");
  const giText = readText(gi, null);
  if (giText === null) {
    writeFileAtomic(gi, "# AutoClaude runtime state\n.autoclaude/\n");
    if (!report.created.includes(".gitignore")) report.created.push(".gitignore");
  } else if (!/^\s*\.autoclaude\/?\s*$/m.test(giText)) {
    writeFileAtomic(gi, giText.replace(/\s*$/, "") + "\n\n# AutoClaude runtime state\n.autoclaude/\n");
    report.notes.push(".gitignore: added .autoclaude/");
  }

  // 4. runtime MCP config for the browser tester (runtime, so always refreshed)
  ensureDir(p.runtimeDir);
  writeJsonAtomic(p.mcpPlaywrightFile, playwrightMcpConfig());

  // 5. Playwright scaffold, only when asked
  if (playwright) {
    const cfgFile = ["playwright.config.ts", "playwright.config.js", "playwright.config.mjs"].find((f) => fs.existsSync(path.join(root, f)));
    if (cfgFile) report.skipped.push(cfgFile);
    else {
      const url = detected.devServer.url || "http://localhost:3000";
      writeFileAtomic(path.join(root, "playwright.config.js"), `// Added by autoclaude init. Adjust baseURL and the test directory to taste.\nexport default {\n  testDir: "e2e",\n  use: { baseURL: "${url}", headless: true },\n  reporter: "list"\n};\n`);
      ensureDir(path.join(root, "e2e"));
      if (!fs.existsSync(path.join(root, "e2e", "smoke.spec.js"))) {
        writeFileAtomic(path.join(root, "e2e", "smoke.spec.js"), `import { test, expect } from "@playwright/test";\n\ntest("the app answers", async ({ page }) => {\n  const res = await page.goto("/");\n  expect(res.ok()).toBeTruthy();\n});\n`);
      }
      report.created.push("playwright.config.js", "e2e/smoke.spec.js");
      report.notes.push("Playwright scaffold written; run `npm i -D @playwright/test` and `npx playwright install chromium`");
    }
  }

  // 6. machine checks
  if (!findOnPath("node", env)) report.warnings.push("`node` is not on PATH for this shell; hooks need it on the PATH of the claude process");
  if (!nativeClaudePath()) report.warnings.push("the native Claude Code install was not found (~/.local/bin/claude); unattended runs need it, see docs/USAGE.md");

  // 7. registry
  try { report.registry = registerProject(root, { now }); } catch (e) { report.warnings.push(`could not update the machine registry: ${e.message}`); }

  // 8. statusline bridge (the one write to user settings)
  if (statusline) {
    try { report.statusline = installStatusline({ now }); }
    catch (e) { report.warnings.push(`statusline bridge not installed: ${e.message}`); }
  }

  return report;
}

export function formatInitReport(r) {
  const lines = [];
  lines.push(`autoclaude: initialized ${r.root}`);
  if (r.created.length) lines.push(`  created: ${r.created.join(", ")}`);
  if (r.skipped.length) lines.push(`  kept as they were: ${r.skipped.join(", ")}`);
  if (r.detected) {
    const c = r.detected.checks.map((x) => `${x.name} (${x.command})`).join(", ") || "none";
    lines.push(`  checks: ${c}`);
    lines.push(`  dev server: ${r.detected.devServer.command ? `${r.detected.devServer.command} at ${r.detected.devServer.url}` : "none"}`);
  }
  for (const n of r.notes) lines.push(`  note: ${n}`);
  for (const w of r.warnings) lines.push(`  WARNING: ${w}`);
  if (r.registry) lines.push(`  registry: ${r.registry.added ? "added" : "already listed"} (${r.registry.projects.length} project${r.registry.projects.length === 1 ? "" : "s"} on this machine)`);
  if (r.statusline) {
    if (r.statusline.alreadyInstalled) lines.push("  statusline bridge: already installed");
    else lines.push(`  statusline bridge: installed at ${r.statusline.script}${r.statusline.chained ? " (your previous status line is chained)" : ""}${r.statusline.backup ? `; settings backup ${r.statusline.backup}` : ""}`);
  }
  lines.push("");
  lines.push(`  next: review ${CONFIG_FILE} (the detected commands are guesses), then /autoclaude:plan to write the plan.`);
  if (r.existingProject) {
    lines.push("  this project already had code or a plan: have /autoclaude:plan review the plan against the step format and the");
    lines.push("  \"planning for an unattended run\" rules in CLAUDE.md, so every step has Accept lines and no step needs a human.");
  }
  return lines.join("\n");
}
