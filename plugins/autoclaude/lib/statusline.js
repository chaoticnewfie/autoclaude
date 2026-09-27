// Installs the statusline bridge (templates/statusline-bridge.js) per machine and registers it
// in the user settings, chaining whatever status line was there. PLAN.md P2.2. Node built-ins only.
//
// This is the one place AutoClaude writes to <claude config dir>/settings.json. It takes a
// timestamped backup first and changes only the "statusLine" key.
import fs from "node:fs";
import path from "node:path";
import { readJson, writeJsonAtomic, ensureDir, writeFileAtomic } from "./fsatomic.js";
import { machinePaths, claudeConfigDir, pluginRoot } from "./paths.js";

export function settingsFile() {
  return path.join(claudeConfigDir(), "settings.json");
}

export function bridgeCommandFor(script) {
  return `node "${script.replace(/\\/g, "/")}"`;
}

export function isBridgeCommand(cmd) {
  return typeof cmd === "string" && /autoclaude[\\/]statusline\.js/.test(cmd);
}

// Returns { installed, alreadyInstalled, chained, backup, script, settings }.
export function installStatusline({ settings = settingsFile(), machine = machinePaths(), template = path.join(pluginRoot(), "templates", "statusline-bridge.js"), now = new Date() } = {}) {
  ensureDir(machine.dir);
  const script = machine.statuslineScript;
  writeFileAtomic(script, fs.readFileSync(template, "utf8"));

  let current = {};
  let existed = false;
  try {
    current = readJson(settings, null) || {};
    existed = fs.existsSync(settings);
  } catch (e) {
    throw new Error(`${settings} is not valid JSON; fix it before installing the status line (${e.message})`);
  }
  const ours = bridgeCommandFor(script);
  const existing = current.statusLine;
  if (existing && existing.type === "command" && isBridgeCommand(existing.command)) {
    return { installed: false, alreadyInstalled: true, chained: null, backup: null, script, settings };
  }

  let chained = null;
  const chainFile = path.join(machine.dir, "statusline.json");
  if (existing && existing.type === "command" && existing.command) {
    chained = { command: existing.command, args: Array.isArray(existing.args) ? existing.args : undefined };
    writeJsonAtomic(chainFile, { chain: chained, savedAt: now.toISOString() });
  } else if (!fs.existsSync(chainFile)) {
    writeJsonAtomic(chainFile, { chain: null, savedAt: now.toISOString() });
  }

  let backup = null;
  if (existed) {
    backup = `${settings}.autoclaude-backup-${now.toISOString().replace(/[:.]/g, "-")}`;
    fs.copyFileSync(settings, backup);
  }
  const next = { ...current, statusLine: { type: "command", command: ours } };
  writeJsonAtomic(settings, next);
  return { installed: true, alreadyInstalled: false, chained, backup, script, settings };
}

// Restores the chained status line (or removes ours). Returns { removed, restored }.
export function uninstallStatusline({ settings = settingsFile(), machine = machinePaths() } = {}) {
  const current = readJson(settings, null) || {};
  if (!current.statusLine || !isBridgeCommand(current.statusLine.command)) return { removed: false, restored: null };
  const chainFile = path.join(machine.dir, "statusline.json");
  const chain = (readJson(chainFile, null) || {}).chain || null;
  const next = { ...current };
  if (chain && chain.command) next.statusLine = { type: "command", command: chain.command, ...(chain.args ? { args: chain.args } : {}) };
  else delete next.statusLine;
  writeJsonAtomic(settings, next);
  return { removed: true, restored: chain };
}
