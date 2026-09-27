// `autoclaude init`: set a project up for AutoClaude without touching anything that exists.
// PLAN.md P2.1, P2.4, P2.5, D23, R17. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
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
// The instructions for people (the repo's INSTRUCTIONS.md, kept identical in the template by a
// test) land in every project as AUTOCLAUDE.md. Claude Code only loads files named CLAUDE.md, so
// this one costs the builder nothing (D46). The copy is stamped with the version that wrote it.
export const GUIDE_FILE = "AUTOCLAUDE.md";

export function pluginVersion(template = templateDir()) {
  try { return JSON.parse(fs.readFileSync(path.join(template, "..", ".claude-plugin", "plugin.json"), "utf8")).version || "?"; } catch { return "?"; }
}

export function stampGuide(text, version, date) {
  const stamp = `> Copied into this project by AutoClaude ${version} on ${date}. After updating AutoClaude,\n> delete this file and run \`autoclaude init\` to get the current instructions.\n`;
  const nl = text.indexOf("\n");
  return nl < 0 ? `${text}\n\n${stamp}` : `${text.slice(0, nl + 1)}\n${stamp}${text.slice(nl + 1)}`;
}

// For a dev script that runs a Node file ("node server.js", "node --watch src/app.js"), read that
// file for its default port (`PORT || 4173`, `.listen(4173`) and a health route ("/health").
export function serverEntry(root, script) {
  const m = String(script || "").match(/\bnode\b(?:\s+--?[\w-]+(?:=\S+)?)*\s+("[^"]+"|'[^']+'|[^\s"']+\.(?:m?js|cjs))/);
  if (!m) return null;
  const file = path.join(root, m[1].replace(/^["']|["']$/g, ""));
  let text = "";
  try { const st = fs.statSync(file); if (st.size > 512 * 1024) return null; text = fs.readFileSync(file, "utf8"); } catch { return null; }
  const port = (text.match(/PORT\s*(?:\|\||\?\?)\s*(\d{2,5})\b/) || text.match(/\.listen\(\s*(\d{2,5})\b/) || [])[1] || null;
  const health = (text.match(/["'`](\/health(?:z|check)?)["'`]/) || [])[1] || null;
  return { file, port, healthPath: health };
}

// The project's name for the templates: package.json's name (without an npm scope), else the
// folder's name (the rehearsal's folder name ended up in the plan title and the run branch).
export function projectName(root) {
  const pkg = readJson(path.join(root, "package.json"), null);
  const n = pkg && typeof pkg.name === "string" ? pkg.name.replace(/^@[^/]+\//, "").trim() : "";
  return n || path.basename(root);
}

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

  if (has("dev") || has("start")) {
    const name = has("dev") ? "dev" : "start";
    const script = scripts[name];
    // 127.0.0.1, not localhost: on Windows localhost can resolve to ::1 first, and a server
    // bound to 127.0.0.1 only never answers there (seen in the onboarding rehearsal).
    let url = null;
    let healthPath = "/";
    const entry = serverEntry(root, script);
    const port = (script.match(/--port[= ](\d+)/) || script.match(/PORT=(\d+)/) || [])[1] || (entry && entry.port);
    if (port) url = `http://127.0.0.1:${port}`;
    else if (deps.vite || deps["@vitejs/plugin-react"]) url = "http://127.0.0.1:5173";
    else if (deps.next) url = "http://127.0.0.1:3000";
    else if (deps.astro) url = "http://127.0.0.1:4321";
    else if (deps["@sveltejs/kit"]) url = "http://127.0.0.1:5173";
    if (entry && entry.healthPath) healthPath = entry.healthPath;
    if (!url) { url = "http://127.0.0.1:3000"; notes.push(`dev server: "npm run ${name}" found but its port is unknown; devServer.url is a guess, check it`); }
    devServer = { command: `npm run ${name}`, url, healthPath, startTimeoutSec: 90 };
  } else {
    notes.push("no dev or start script: devServer left empty (the browser tester needs one for UI steps)");
  }

  // An e2e check needs the dev server; without one the gate would fail it on every step.
  const e2e = ["e2e", "test:e2e", "playwright"].find(has);
  if (e2e && devServer.command) checks.push({ name: "e2e", command: `npm run ${e2e}`, timeoutSec: 900, needsDevServer: true });
  else if (e2e) notes.push(`found "npm run ${e2e}" but no dev server was detected, so it is not a check yet: set devServer in ${CONFIG_FILE}, then add it with "needsDevServer": true`);
  if (checks.length === 0) notes.push("no lint, typecheck or test scripts found in package.json: the gate will only run the browser tester until you add checks");
  return { checks, devServer, notes, hasPackageJson: true, scripts };
}

// Plan-like markdown another tool or the owner may already keep, besides PLAN.md.
const PLAN_LIKE = ["roadmap.md", "todo.md", "next.md"];

// Why a folder counts as an existing project (empty when it is new). Read before the template is
// copied, so the files init writes itself never count.
export function existingProjectSignals(root, env = process.env) {
  const signals = [];
  const has = (rel) => fs.existsSync(path.join(root, rel));
  for (const rel of ["PLAN.md", "package.json", "src", "app", "CLAUDE.md", "AGENTS.md"]) if (has(rel)) signals.push(rel);
  const names = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };
  for (const n of names(root)) if (PLAN_LIKE.includes(n.toLowerCase())) signals.push(n);
  for (const n of names(path.join(root, "docs"))) if (/^plan.*\.md$/i.test(n)) signals.push(`docs/${n}`);
  if (hasCommittedFiles(root, env)) signals.push("git history");
  return signals;
}

// True when HEAD has at least one file under root. False without git, a repo or a commit.
function hasCommittedFiles(root, env) {
  const gitCli = findOnPath("git", env);
  if (!gitCli || !fs.existsSync(root)) return false;
  const r = spawnSync(gitCli, ["ls-tree", "-r", "--name-only", "HEAD", "--", "."], { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 30000 });
  return r.status === 0 && String(r.stdout || "").trim() !== "";
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
  const report = { root, created: [], skipped: [], warnings: [], notes: [], detected: null, existingProject: false, existingSignals: [], registry: null, statusline: null };

  report.existingSignals = existingProjectSignals(root, env);
  report.existingProject = report.existingSignals.length > 0;
  // A CLAUDE.md that is kept and never mentions AutoClaude is the owner's own, without the run
  // rules; one written by an earlier init or extended by /autoclaude:plan mentions it.
  const ownClaudeMd = readText(path.join(root, "CLAUDE.md"), null);
  report.keptOwnClaudeMd = ownClaudeMd !== null && !/autoclaude/i.test(ownClaudeMd);

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
    const name = projectName(root);
    const date = now.toISOString().slice(0, 10);
    for (const rel of walk(template)) {
      const target = path.join(root, rel);
      if (fs.existsSync(target)) { report.skipped.push(rel); continue; }
      let src = fs.readFileSync(path.join(template, rel), "utf8");
      if (rel === GUIDE_FILE) src = stampGuide(src, pluginVersion(template), date);
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
      const url = detected.devServer.url || "http://127.0.0.1:3000";
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
  if (!nativeClaudePath()) report.warnings.push("the native Claude Code install was not found (~/.local/bin/claude); unattended runs need it, see the AutoClaude README (docs/USAGE.md in the AutoClaude repository)");

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
  if (r.keptOwnClaudeMd) {
    // The owner's CLAUDE.md was kept, so the AutoClaude rules are not in it yet.
    lines.push("  this project already had its own CLAUDE.md, which init kept as it was: /autoclaude:plan reviews the project's own");
    lines.push("  rules and adds an AutoClaude section to that file, then reviews the plan against the step format, so every step");
    lines.push("  has Accept lines and no step needs a human.");
  } else if (r.existingProject) {
    lines.push("  this project already had code or a plan: have /autoclaude:plan review the plan against the step format and the");
    lines.push("  \"planning for an unattended run\" rules in CLAUDE.md, so every step has Accept lines and no step needs a human.");
  }
  return lines.join("\n");
}
