// Preflight for `autoclaude run` and `/autoclaude:start` (PLAN.md P6.3, D28): everything that
// would otherwise stop an unattended run in the first minutes, checked before it starts.
// Returns { ok, items: [{ name, status: "ok" | "warn" | "fail", detail }] }. Reads, never writes
// (the dev server is started and stopped again, which is the only side effect). Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readJson, readText } from "./fsatomic.js";
import { claudeUserConfigFile, homeDir, isWindows, trustKeyFor } from "./paths.js";
import { parsePlan, lintPlan, firstUnfinished, MARKERS } from "./plan.js";
import { findOnPath, runCommand } from "./proc.js";
import { claudeBinary } from "./headless.js";
import { checksEnv as runChecksEnv } from "./checks.js";
import { readUsage } from "./usage.js";
import { resolveChannel } from "./notify.js";
import { restartDevServer, stopDevServer, devServerInfo } from "./devserver.js";
import * as git from "./git.js";

export function playwrightBrowsersDir(env = process.env) {
  if (env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== "0") return env.PLAYWRIGHT_BROWSERS_PATH;
  if (isWindows) return path.join(env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local"), "ms-playwright");
  if (process.platform === "darwin") return path.join(homeDir(), "Library", "Caches", "ms-playwright");
  return path.join(homeDir(), ".cache", "ms-playwright");
}

// The executable a check command starts with, and whether it can run here.
export function checkRunnable(command, root, env = process.env) {
  const cmd = String(command).trim();
  const quoted = cmd.match(/^"([^"]+)"/);
  const first = quoted ? quoted[1] : cmd.split(/\s+/)[0];
  if (quoted || /[\\/]/.test(first)) {
    const full = path.isAbsolute(first) ? first : path.join(root, first);
    return fs.existsSync(full) ? { ok: true } : { ok: false, detail: `${first} does not exist` };
  }
  if (!findOnPath(first, env)) return { ok: false, detail: `\`${first}\` is not on PATH` };
  const npm = cmd.match(/^npm\s+(?:run(?:-script)?\s+(\S+)|(test|start))\b/);
  if (npm) {
    const script = npm[1] || npm[2];
    const pkg = readJson(path.join(root, "package.json"), null);
    if (!pkg || !pkg.scripts || !pkg.scripts[script]) return { ok: false, detail: `package.json has no "${script}" script` };
  }
  return { ok: true };
}

// A check's prerequisite (checks[i].requires, for example "docker version") gets this long.
export const REQUIRE_TIMEOUT_SEC = 60;

// Runs each check's `requires` command through the same shell as the checks. Returns the
// problems, one per check whose requirement failed, naming the check and the command.
export async function checkRequirements(checks, { root, env = process.env, run = runCommand } = {}) {
  const bad = [];
  for (const [index, c] of (checks || []).entries()) {
    const req = typeof c.requires === "string" ? c.requires.trim() : "";
    if (!req) continue;
    let why = null;
    try {
      const r = await run(req, { cwd: root, env, timeoutMs: REQUIRE_TIMEOUT_SEC * 1000 });
      if (r.timedOut) why = `timed out after ${REQUIRE_TIMEOUT_SEC} s`;
      else if (r.code !== 0) {
        const last = String(r.stderr || r.stdout || "").trim().split(/\r?\n/).pop();
        why = `exit code ${r.code === null ? "none" : r.code}${last ? `: ${last.slice(0, 200)}` : ""}`;
      }
    } catch (e) {
      why = `could not start: ${e && e.message ? e.message : e}`;
    }
    if (why) bad.push({ index, check: c.name, command: req, detail: `${c.name}: its requirement \`${req}\` failed (${why}); install or start what it needs first` });
  }
  return bad;
}

// checksEnv: the environment the checks run in (checks.js checksEnv: the PATH the run recorded,
// or this shell's without Git Bash's own folders). `autoclaude run` passes the launching
// terminal's own env, which is the one it records. runRequirement is a test seam.
export async function preflight(project, { env = process.env, checksEnv = null, runRequirement = runCommand, devServer = true, userConfigFile = claudeUserConfigFile(), now = Date.now(), skip = [], platform = process.platform } = {}) {
  const { root, config } = project;
  const items = [];
  const add = (name, status, detail = "") => { if (!skip.includes(name)) items.push({ name, status, detail }); };

  // Plan
  const planText = readText(path.join(root, config.plan), null);
  let next = null;
  if (planText === null) add("plan", "fail", `${config.plan} not found`);
  else {
    const parsed = parsePlan(planText);
    const problems = lintPlan(parsed);
    next = firstUnfinished(parsed);
    if (problems.length) add("plan", "fail", `${problems.length} lint problem(s); run \`autoclaude lint-plan\``);
    else if (!next) add("plan", "fail", "every step is already verified");
    else add("plan", "ok", `${parsed.steps.length} steps, next ${next.id}`);
    project.parsed = parsed;
  }

  // Git. The CLI itself is also checked under Tools, which a run already under way still checks: a
  // supervisor started from a shell without git on PATH ran a whole step and could not commit it.
  const gitCli = findOnPath("git", env);
  if (!gitCli) add("git", "fail", "`git` is not on PATH, so the repository cannot be checked");
  else if (!(await git.isRepo(root, { env }))) add("git", "fail", "not a git repository; the gate commits every verified step");
  else {
    const st = await git.status(root, { env });
    if (!st.clean) add("git", "fail", `the working tree has ${st.entries.length} uncommitted change(s); commit or stash them first`);
    else add("git", "ok", "clean working tree");
  }

  // Tools
  add("git-cli", gitCli ? "ok" : "fail", gitCli || "`git` is not on PATH; the gate commits every verified step");
  add("node", findOnPath("node", env) ? "ok" : "fail", findOnPath("node", env) || "`node` is not on PATH; the hooks need it");
  const claude = claudeBinary(env);
  add("claude", claude ? "ok" : "fail", claude || "Claude Code is not installed natively (Windows: irm https://claude.ai/install.ps1 | iex)");
  // Linux and macOS: without tmux the supervisor falls back to a background process, and the
  // interactive builder session it starts then has no terminal to run in.
  if (platform !== "win32") {
    const tmux = findOnPath("tmux", env);
    add("tmux", tmux ? "ok" : "fail", tmux || "`tmux` is not on PATH; on Linux and macOS the run needs it to give the builder session a terminal (apt install tmux, or brew install tmux)");
  }

  // First-run onboarding and workspace trust (read-only, D28)
  let cfg = null;
  try { cfg = readJson(userConfigFile, null); } catch { cfg = null; }
  const top = (await git.git(root, ["rev-parse", "--show-toplevel"], { env })).stdout.trim() || root;
  // Compare real paths: Windows can name one folder by its 8.3 short form (ADMINI~1) and its long
  // form (Administrator), and git reports the long one.
  const real = (p) => { try { return fs.realpathSync.native(p); } catch { return p; } };
  const key = trustKeyFor(real(top)).toLowerCase();
  const projects = (cfg && cfg.projects) || {};
  const trustEntry = Object.entries(projects).find(([k]) => k.toLowerCase() === key || trustKeyFor(real(k)).toLowerCase() === key);
  if (!cfg || !cfg.hasCompletedOnboarding || !trustEntry || !trustEntry[1].hasTrustDialogAccepted) {
    add("trust", "fail", `Claude Code has not been opened here yet. Run \`claude\` once in ${top}, pick a theme if asked, accept the trust dialog, then \`/exit\`.`);
  } else add("trust", "ok", "onboarding done and the folder is trusted");

  // Checks. One with needsDevServer fails every step when no dev server is configured.
  // A check's `requires` runs first; a check whose requirement fails is not looked at further.
  const hasDevServer = Boolean(config.devServer.command && config.devServer.url);
  const bad = [];
  const cenv = checksEnv || runChecksEnv(root, env).env;
  const unmet = skip.includes("checks") ? [] : await checkRequirements(config.checks, { root, env: cenv, run: runRequirement });
  for (const [i, c] of config.checks.entries()) {
    const miss = unmet.find((u) => u.index === i);
    if (miss) { bad.push(miss.detail); continue; }
    const r = checkRunnable(c.command, root, cenv);
    if (!r.ok) bad.push(`${c.name}: ${r.detail}`);
    if (c.needsDevServer && !hasDevServer) bad.push(`${c.name}: needsDevServer is true but devServer.command and devServer.url are not both set, so this check would fail every step`);
  }
  if (config.checks.length === 0) add("checks", "warn", "no checks configured; only the browser tester and the reviewers verify steps");
  else if (bad.length) add("checks", "fail", bad.join("; "));
  else add("checks", "ok", config.checks.map((c) => c.name).join(", "));

  // Browser tester. The gate opens a browser only with the tester on, a dev server configured and
  // a step left that has a UI, so Playwright's Chromium is needed only then.
  const uiLeft = project.parsed ? project.parsed.steps.some((s) => s.marker !== MARKERS.done && !s.tags.includes("no-ui")) : false;
  const testerWanted = config.tester.enabled && uiLeft;
  if (testerWanted && hasDevServer) {
    const dir = playwrightBrowsersDir(env);
    let found = false;
    try { found = fs.readdirSync(dir).some((d) => /^chromium/i.test(d)); } catch {}
    add("playwright", found ? "ok" : "fail", found ? dir : `no Chromium under ${dir}; run \`npx playwright install chromium\``);
  }
  if (hasDevServer) {
    if (devServer) {
      const before = devServerInfo({ root });
      const ds = await restartDevServer(config.devServer, { root, env: cenv });
      if (!before) stopDevServer({ root });
      if (ds.ok) add("dev server", "ok", `answers at ${config.devServer.url}${ds.reused ? " (already running)" : ""}`);
      // A new project's first steps are often the ones that write the server, so it cannot answer
      // yet. That is fine while the next step needs no browser.
      else if (next && next.tags.includes("no-ui")) add("dev server", "warn", `not running yet (${ds.error}); the next step, ${next.id}, is no-ui. The gate starts the dev server for each step that needs it and fails that step if it cannot`);
      else add("dev server", "fail", `${ds.error}`);
    }
  } else if (testerWanted) {
    add("dev server", "warn", "no devServer configured, so UI steps will not be checked in a browser");
  }

  // Usage
  const usage = readUsage({ staleAfterMin: config.usage.staleAfterMin, now });
  if (!usage.source || usage.stale) add("usage", "warn", "no fresh usage data yet; the weekly pause starts working once a session has run");
  else if (usage.sevenDay && usage.sevenDay.pct >= config.usage.weeklyPauseAtPct) add("usage", "fail", `weekly usage is ${Math.round(usage.sevenDay.pct)}%, at or over the ${config.usage.weeklyPauseAtPct}% pause threshold`);
  else add("usage", "ok", `7d ${usage.sevenDay ? Math.round(usage.sevenDay.pct) : "?"}%`);

  // Notifications
  const ch = resolveChannel({}, env);
  add("notify", ch.channel === "stdout" ? "warn" : "ok", ch.channel === "stdout" ? "no ntfy or Discord channel; alerts only go to the log (`autoclaude notify-setup`)" : ch.channel);

  return { ok: !items.some((i) => i.status === "fail"), items };
}

export function formatPreflight(result) {
  const mark = { ok: "ok  ", warn: "warn", fail: "FAIL" };
  return result.items.map((i) => `  ${mark[i.status]} ${i.name}: ${i.detail}`).join(os.EOL === "\r\n" ? "\n" : "\n");
}
