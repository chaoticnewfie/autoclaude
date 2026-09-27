// AutoClaude launcher. `autoclaude install-cli` and `autoclaude watchdog --install` copy this file
// into the machine's AutoClaude bin folder, and the `autoclaude` shim and the watchdog task run it.
// It finds the installed plugin every time it runs, so both keep working after a plugin update
// moves the plugin to a new versioned folder (D42). Node built-ins only; it must not import
// anything from the plugin, because finding the plugin is its job.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ENTRY = ["bin", "autoclaude.js"];

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { return null; }
}

// Where the plugin's CLI entry is, or null. Order:
// 1. Claude Code's record of installed plugins: an `autoclaude@<marketplace>` install from a
//    GitHub or URL marketplace (the newest one whose folder exists).
// 2. A directory marketplace (a local clone): the plugin folder inside the clone, because Claude
//    Code loads such a plugin from the clone, not from its cache copy.
// 3. The path recorded when this launcher was installed.
export function resolveEntry({ configDir, fallback = null, exists = fs.existsSync, readJson = readJsonSafe } = {}) {
  const installed = readJson(path.join(configDir, "plugins", "installed_plugins.json"));
  const markets = readJson(path.join(configDir, "plugins", "known_marketplaces.json")) || {};
  const plugins = installed && installed.plugins && typeof installed.plugins === "object" ? installed.plugins : {};
  const fromCache = [];
  const fromDirectory = [];
  for (const [key, list] of Object.entries(plugins)) {
    const m = /^autoclaude@(.+)$/.exec(key);
    if (!m || !Array.isArray(list)) continue;
    const market = markets[m[1]] || null;
    // An install whose marketplace is gone is a leftover; its cache copy may be very old.
    if (!market) continue;
    const isDirectory = !!(market.source && market.source.source === "directory");
    if (isDirectory) {
      const home = market.installLocation || market.source.path;
      if (!home) continue;
      const manifest = readJson(path.join(home, ".claude-plugin", "marketplace.json"));
      const entry = manifest && Array.isArray(manifest.plugins) ? manifest.plugins.find((p) => p && p.name === "autoclaude") : null;
      const source = entry && typeof entry.source === "string" ? entry.source : "./plugins/autoclaude";
      const file = path.join(home, source, ...ENTRY);
      if (exists(file)) fromDirectory.push(file);
      continue;
    }
    for (const inst of list) {
      if (!inst || !inst.installPath) continue;
      const file = path.join(inst.installPath, ...ENTRY);
      if (exists(file)) fromCache.push({ file, at: Date.parse(inst.lastUpdated || inst.installedAt || "") || 0 });
    }
  }
  if (fromCache.length) return fromCache.sort((a, b) => b.at - a.at)[0].file;
  if (fromDirectory.length) return fromDirectory[0];
  if (fallback && exists(fallback)) return fallback;
  return null;
}

function configDirFrom(env) {
  return env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
}

function main() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const side = readJsonSafe(path.join(here, "autoclaude-launch.json")) || {};
  const entry = resolveEntry({ configDir: configDirFrom(process.env), fallback: side.fallback || null });
  if (!entry) {
    process.stderr.write("autoclaude: the AutoClaude plugin is not installed for this user (Claude Code's plugin records do not list it). Install it as its README describes, then run `autoclaude install-cli` again.\n");
    process.exitCode = 1;
    return;
  }
  const r = spawnSync(process.execPath, [entry, ...process.argv.slice(2)], { stdio: "inherit" });
  if (r.error) {
    process.stderr.write(`autoclaude: could not start ${entry}: ${r.error.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.exitCode = r.status === null ? 1 : r.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
