// Installs templates/launcher.mjs into the machine's AutoClaude bin folder (D42). The `autoclaude`
// shim and the watchdog task run the launcher, which finds the current plugin install each time,
// instead of a path into one versioned plugin folder. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { binDir, pluginRoot } from "./paths.js";
import { ensureDir, writeJsonAtomic } from "./fsatomic.js";

export const LAUNCHER_NAME = "autoclaude-launch.mjs";
export const LAUNCHER_SIDECAR = "autoclaude-launch.json";

// Copies the launcher and records this plugin's CLI entry as its last-resort fallback.
// Returns the launcher's path.
export function installLauncher({ dir = binDir(), root = pluginRoot() } = {}) {
  ensureDir(dir);
  const target = path.join(dir, LAUNCHER_NAME);
  fs.copyFileSync(path.join(root, "templates", "launcher.mjs"), target);
  writeJsonAtomic(path.join(dir, LAUNCHER_SIDECAR), { fallback: path.join(root, "bin", "autoclaude.js") });
  return target;
}
