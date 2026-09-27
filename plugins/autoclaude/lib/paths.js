// Every path AutoClaude touches, in one place. Node built-ins only.
// Per-machine files live under the Claude config dir (~/.claude or $CLAUDE_CONFIG_DIR).
// Per-project files live under <project>/.autoclaude/ (gitignored) plus the committed docs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const isWindows = process.platform === "win32";

export function homeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

export function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homeDir(), ".claude");
}

export function claudeUserConfigFile() {
  // ~/.claude.json: onboarding, workspace trust, cached usage. Read-only for us.
  return process.env.CLAUDE_CONFIG_DIR
    ? path.join(process.env.CLAUDE_CONFIG_DIR, ".claude.json")
    : path.join(homeDir(), ".claude.json");
}

export function machineDir() {
  return path.join(claudeConfigDir(), "autoclaude");
}

export function machinePaths() {
  const dir = machineDir();
  return {
    dir,
    usageFile: path.join(dir, "usage.json"),
    registryFile: path.join(dir, "registry.json"),
    statuslineScript: path.join(dir, "statusline.js"),
    logsDir: path.join(dir, "logs")
  };
}

export function binDir() {
  if (isWindows) {
    const local = process.env.LOCALAPPDATA || path.join(homeDir(), "AppData", "Local");
    return path.join(local, "autoclaude", "bin");
  }
  return path.join(homeDir(), ".local", "bin");
}

export const CONFIG_FILE = "autoclaude.config.json";
export const RUNTIME_DIR = ".autoclaude";

export function projectPaths(root) {
  const runtime = path.join(root, RUNTIME_DIR);
  return {
    root,
    configFile: path.join(root, CONFIG_FILE),
    runtimeDir: runtime,
    stateFile: path.join(runtime, "state.json"),
    readyFile: path.join(runtime, "ready.json"),
    blockedFile: path.join(runtime, "blocked.json"),
    heartbeatFile: path.join(runtime, "heartbeat"),
    idleFile: path.join(runtime, "idle"),
    failureFile: path.join(runtime, "failure.json"),
    supervisorPidFile: path.join(runtime, "supervisor.pid"),
    mcpPlaywrightFile: path.join(runtime, "mcp.playwright.json"),
    reportsDir: path.join(runtime, "reports"),
    logsDir: path.join(runtime, "logs")
  };
}

// Walk up from `from` looking for autoclaude.config.json, then for a .git directory.
// Returns null when neither is found.
export function findProjectRoot(from = process.cwd()) {
  let dir = path.resolve(from);
  let gitRoot = null;
  for (;;) {
    if (fs.existsSync(path.join(dir, CONFIG_FILE))) return dir;
    if (!gitRoot && fs.existsSync(path.join(dir, ".git"))) gitRoot = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return gitRoot;
}

// The form Claude Code uses as the key in ~/.claude.json "projects": the
// repository root with forward slashes (observed 2026-09-27, VERIFY.md P0.8).
export function trustKeyFor(root) {
  return path.resolve(root).replace(/\\/g, "/");
}

export function pluginRoot() {
  // scripts/ and bin/ both sit one level below the plugin root.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}
