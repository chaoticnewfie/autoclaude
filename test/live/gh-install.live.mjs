// Live check (PLAN.md P7.2, D42): install AutoClaude from its GitHub marketplace into a throwaway
// Claude config, the way a machine that has never seen this repository would, and prove that
// everything works from the installed copy. Needs network, git credentials that can read the
// repository, and the native `claude` CLI. It never touches the real Claude config, PATH or
// scheduler: every path is inside one temp folder whose name has a space and a tilde, because
// such profile paths once switched the tool guard off.
//
//   node test/live/gh-install.live.mjs [marketplace source] [--keep]
//
// The default source is chaoticnewfie/autoclaude; pass a local clone's path to test unpushed
// work. Exit code 0 when every check passes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const keep = args.includes("--keep");
const source = args.find((a) => !a.startsWith("--")) || "chaoticnewfie/autoclaude";
const base = fs.mkdtempSync(path.join(os.tmpdir(), "ac gh install ~"));
const cfg = path.join(base, "claude config");
const bin = path.join(base, "bin");
const proj = path.join(base, "my project");
fs.mkdirSync(cfg, { recursive: true });
fs.mkdirSync(proj, { recursive: true });
const env = { ...process.env, CLAUDE_CONFIG_DIR: cfg, AUTOCLAUDE_BIN_DIR: bin };
delete env.AUTOCLAUDE_BUILDER;
delete env.AUTOCLAUDE_ROLE;

const claude = (() => {
  const native = path.join(os.homedir(), ".local", "bin", process.platform === "win32" ? "claude.exe" : "claude");
  return fs.existsSync(native) ? native : "claude";
})();

const results = [];
const check = (name, ok, detail = "") => { results.push({ name, ok }); console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? `: ${detail}` : ""}`); return ok; };
const run = (cmd, argv, opts = {}) => spawnSync(cmd, argv, { encoding: "utf8", env, windowsHide: true, ...opts });
const out = (r) => `${r.stdout || ""}${r.stderr || ""}`.trim().split(/\r?\n/).slice(-3).join(" | ");

console.log(`temp folder: ${base}`);
console.log(`source: ${source}`);

let r = run(claude, ["plugin", "marketplace", "add", source], { timeout: 180000 });
check("marketplace add", r.status === 0, out(r));
r = run(claude, ["plugin", "install", "autoclaude@autoclaude"], { timeout: 180000 });
check("plugin install", r.status === 0, out(r));

const installed = JSON.parse(fs.readFileSync(path.join(cfg, "plugins", "installed_plugins.json"), "utf8"));
const entry = (installed.plugins["autoclaude@autoclaude"] || [])[0];
const installPath = entry && entry.installPath;
check("installed into a versioned cache folder", !!installPath && fs.existsSync(path.join(installPath, "bin", "autoclaude.js")), installPath || "no install record");
check("the project template ships inside the plugin", !!installPath && fs.existsSync(path.join(installPath, "project-template", "PLAN.md")));

r = run(process.execPath, [path.join(installPath, "bin", "autoclaude.js"), "install-cli", "--no-path"]);
const launcher = path.join(bin, "autoclaude-launch.mjs");
check("install-cli writes the launcher and shims", r.status === 0 && fs.existsSync(launcher) && fs.existsSync(path.join(bin, "autoclaude")), out(r));

const git = (...a) => run("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...a], { cwd: proj });
fs.writeFileSync(path.join(proj, "package.json"), JSON.stringify({ name: "demo", private: true, scripts: { test: "node -e 0" } }, null, 2) + "\n");
git("init", "-q");
git("add", "-A");
git("commit", "-q", "-m", "initial");
r = run(process.execPath, [launcher, "init", "--no-statusline"], { cwd: proj });
check("init from the installed copy, through the launcher", r.status === 0 && fs.existsSync(path.join(proj, "autoclaude.config.json")) && fs.existsSync(path.join(proj, "CLAUDE.md")), out(r));
const guide = path.join(proj, "AUTOCLAUDE.md");
const guideText = fs.existsSync(guide) ? fs.readFileSync(guide, "utf8") : "";
check("init puts the instructions into the project as AUTOCLAUDE.md, stamped with the version", guideText.includes(`Copied into this project by AutoClaude ${entry.version}`), guideText.split("\n").slice(0, 3).join(" | "));

// A running state, then the installed tool guard, spawned by its installed path (which has a
// space and a tilde in it), must deny a push from both shell tools.
const { saveState, defaultState } = await import(pathToFileURL(path.join(installPath, "lib", "state.js")).href);
saveState(proj, { ...defaultState(), status: "running", currentStep: "S1.1" });
for (const tool of ["Bash", "PowerShell"]) {
  r = run(process.execPath, [path.join(installPath, "scripts", "tool-guard.js")], { cwd: proj, input: JSON.stringify({ hook_event_name: "PreToolUse", cwd: proj, tool_name: tool, tool_input: { command: "git push origin main" } }) });
  check(`installed tool guard denies a push from the ${tool} tool`, /"permissionDecision":\s*"deny"/.test(r.stdout || ""), (r.stdout || r.stderr || "no output").slice(0, 160));
}
saveState(proj, { ...defaultState(), status: "idle" });

// A plugin update moves the plugin to a new versioned folder and removes the old one.
const nextDir = `${installPath}-next`;
fs.cpSync(installPath, nextDir, { recursive: true });
const manifest = path.join(nextDir, ".claude-plugin", "plugin.json");
const pj = JSON.parse(fs.readFileSync(manifest, "utf8"));
pj.version = `${pj.version}-next`;
fs.writeFileSync(manifest, JSON.stringify(pj, null, 2));
installed.plugins["autoclaude@autoclaude"][0] = { ...entry, installPath: nextDir, version: pj.version, lastUpdated: new Date().toISOString() };
fs.writeFileSync(path.join(cfg, "plugins", "installed_plugins.json"), JSON.stringify(installed, null, 2));
fs.rmSync(installPath, { recursive: true, force: true });
r = run(process.execPath, [launcher, "version"]);
check("the launcher follows a plugin update", (r.stdout || "").trim() === pj.version, (r.stdout || r.stderr || "").trim());

const failed = results.filter((x) => !x.ok).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
if (keep) console.log(`kept ${base}`);
else fs.rmSync(base, { recursive: true, force: true });
process.exitCode = failed ? 1 : 0;
