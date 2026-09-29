// Drives the settings page of a running project for the practice run (PLAN.md P8.9), the way the
// page's own script does: reads the state, changes a live-safe setting, tries a locked one, takes
// a headless screenshot, then clicks Done. Uses the INSTALLED plugin, never this clone.
//   node spikes/lib/config-live.mjs <project> <plugin folder> <screenshot.png>
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";

const [project, plugin, shot, mode] = process.argv.slice(2);
const shotOnly = mode === "--shot-only";
const { openConfigPage, TOKEN_HEADER } = await import(pathToFileURL(path.join(plugin, "lib", "configpage.js")).href);

let page = null;
const ready = new Promise((resolve) => { page = resolve; });
const finished = openConfigPage({ root: project, openBrowser: () => true, listen: (x) => page(x), io: { out: (s) => console.log(s), env: process.env } });
const { url, port, token } = await ready;
const api = async (method, p, body) => {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { [TOKEN_HEADER]: token, ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await r.json(); } catch {}
  return { status: r.status, json };
};

const state = await api("GET", "/api/state");
const fields = JSON.stringify(state.json);
console.log(`GET /api/state: ${state.status}, ${fields.length} bytes; running: ${/"running":true/.test(fields)}`);

if (!shotOnly) {
const safe = await api("POST", "/api/save", { project: { set: { "notify.events.stepVerified": true }, reset: [] } });
console.log(`save notify.events.stepVerified=true while running: ${safe.status} ${JSON.stringify(safe.json).slice(0, 300)}`);
const locked = await api("POST", "/api/save", { project: { set: { "gate.verifyAt": "step" }, reset: [] } });
console.log(`save gate.verifyAt=step while running: ${locked.status} ${JSON.stringify(locked.json).slice(0, 400)}`);
const cfg = JSON.parse(fs.readFileSync(path.join(project, "autoclaude.config.json"), "utf8"));
console.log(`project file now: notify.events=${JSON.stringify((cfg.notify || {}).events)} gate=${JSON.stringify(cfg.gate || null)}`);
}

// A headless screenshot of the page itself (its script fetches the state with the token).
const base = path.join(os.homedir(), "AppData", "Local", "ms-playwright");
const dir = fs.readdirSync(base).find((d) => /^chromium-\d+$/.test(d));
const chrome = dir ? [path.join(base, dir, "chrome-win64", "chrome.exe"), path.join(base, dir, "chrome-win", "chrome.exe")].find((p) => fs.existsSync(p)) : null;
if (chrome) {
  // Async: this process serves the page, so a blocking spawn would starve the browser.
  const r = await new Promise((resolve) => { let stderr = ""; const c = spawn(chrome, ["--headless=new", "--no-sandbox", `--user-data-dir=${fs.mkdtempSync(path.join(os.tmpdir(), "ac-shot-"))}`, "--disable-gpu", "--hide-scrollbars", `--screenshot=${shot}`, "--window-size=1280,4200", "--virtual-time-budget=8000", url]); c.stderr.on("data", (d) => { stderr += d; }); const k = setTimeout(() => c.kill(), 120000); c.on("exit", (status) => { clearTimeout(k); resolve({ status, stderr }); }); });
  console.log(`screenshot: ${fs.existsSync(shot) ? shot : `failed (${r.status}) ${(r.stderr || "").slice(-300)}`}`);
} else console.log("screenshot: no Playwright Chromium found");

const done = await api("POST", "/api/done", {});
console.log(`done: ${done.status}`);
const result = await finished;
console.log(`page closed: ${result.reason}, saves ${JSON.stringify(result.saves).slice(0, 200)}`);
