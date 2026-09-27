import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { resolveEntry } from "../../plugins/autoclaude/templates/launcher.mjs";
import { installLauncher, LAUNCHER_NAME, LAUNCHER_SIDECAR } from "../../plugins/autoclaude/lib/launcher.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));
const entryIn = (dir) => path.join(dir, "bin", "autoclaude.js");

function fakeConfig({ installed = {}, markets = {} }) {
  const configDir = tmp("autoclaude-launch-cfg-");
  fs.mkdirSync(path.join(configDir, "plugins"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: installed }));
  fs.writeFileSync(path.join(configDir, "plugins", "known_marketplaces.json"), JSON.stringify(markets));
  return configDir;
}

function fakePlugin(label) {
  const dir = tmp(`autoclaude-launch-${label}-`);
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
  fs.writeFileSync(entryIn(dir), `process.stdout.write(${JSON.stringify(label)} + " " + process.argv.slice(2).join(" ")); process.exitCode = 3;\n`);
  return dir;
}

const github = { source: { source: "github", repo: "someone/autoclaude" }, installLocation: "x" };

test("resolveEntry: the newest cached install from a GitHub marketplace wins", () => {
  const old = fakePlugin("old");
  const cur = fakePlugin("new");
  const configDir = fakeConfig({
    installed: { "autoclaude@autoclaude": [
      { scope: "user", installPath: old, lastUpdated: "2026-09-01T00:00:00Z" },
      { scope: "project", installPath: cur, lastUpdated: "2026-09-20T00:00:00Z" }
    ], "other@autoclaude": [{ installPath: old }] },
    markets: { autoclaude: github }
  });
  assert.equal(resolveEntry({ configDir }), entryIn(cur));
});

test("resolveEntry: a directory marketplace resolves to the clone, not to its stale cache copy", () => {
  const clone = tmp("autoclaude-launch-clone-");
  fs.mkdirSync(path.join(clone, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(path.join(clone, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "mine", plugins: [{ name: "autoclaude", source: "./plugins/autoclaude" }] }));
  fs.mkdirSync(path.join(clone, "plugins", "autoclaude", "bin"), { recursive: true });
  fs.writeFileSync(path.join(clone, "plugins", "autoclaude", "bin", "autoclaude.js"), "");
  const stale = fakePlugin("stale");
  const configDir = fakeConfig({
    installed: { "autoclaude@mine": [{ scope: "user", installPath: stale }] },
    markets: { mine: { source: { source: "directory", path: clone }, installLocation: clone } }
  });
  assert.equal(resolveEntry({ configDir }), path.join(clone, "plugins", "autoclaude", "bin", "autoclaude.js"));
});

test("resolveEntry: a leftover install whose marketplace is gone is skipped; then the recorded fallback; else null", () => {
  const leftover = fakePlugin("leftover");
  const fallbackDir = fakePlugin("fallback");
  const configDir = fakeConfig({ installed: { "autoclaude@removed": [{ installPath: leftover }] }, markets: {} });
  assert.equal(resolveEntry({ configDir, fallback: entryIn(fallbackDir) }), entryIn(fallbackDir));
  assert.equal(resolveEntry({ configDir, fallback: path.join(fallbackDir, "missing.js") }), null);
  assert.equal(resolveEntry({ configDir: tmp("autoclaude-launch-empty-") }), null, "no plugin records at all");
  const gone = fakeConfig({ installed: { "autoclaude@autoclaude": [{ installPath: path.join(leftover, "deleted-version") }] }, markets: { autoclaude: github } });
  assert.equal(resolveEntry({ configDir: gone }), null, "an install folder that no longer exists does not count");
});

test("an installed launcher finds the current install, passes the arguments and the exit code through", () => {
  const bin = tmp("autoclaude-launch-bin-");
  const launcher = installLauncher({ dir: bin, root: path.resolve("plugins/autoclaude") });
  assert.equal(launcher, path.join(bin, LAUNCHER_NAME));
  const side = JSON.parse(fs.readFileSync(path.join(bin, LAUNCHER_SIDECAR), "utf8"));
  assert.equal(side.fallback, path.resolve("plugins/autoclaude/bin/autoclaude.js"));

  const v1 = fakePlugin("v1");
  const configDir = fakeConfig({ installed: { "autoclaude@autoclaude": [{ installPath: v1, lastUpdated: "2026-09-27T00:00:00Z" }] }, markets: { autoclaude: github } });
  const run = (cfg) => spawnSync(process.execPath, [launcher, "status", "--all"], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: cfg } });
  let r = run(configDir);
  assert.equal(r.stdout, "v1 status --all");
  assert.equal(r.status, 3);

  // A plugin update moves the plugin to a new versioned folder and removes the old one.
  const v2 = fakePlugin("v2");
  fs.rmSync(v1, { recursive: true, force: true });
  fs.writeFileSync(path.join(configDir, "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "autoclaude@autoclaude": [{ installPath: v2, lastUpdated: "2026-09-28T00:00:00Z" }] } }));
  r = run(configDir);
  assert.equal(r.stdout, "v2 status --all");

  // No plugin records: the recorded fallback (this repo's CLI) answers.
  r = spawnSync(process.execPath, [launcher, "version"], { encoding: "utf8", env: { ...process.env, CLAUDE_CONFIG_DIR: tmp("autoclaude-launch-none-") } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^\d+\.\d+\.\d+/);
});
