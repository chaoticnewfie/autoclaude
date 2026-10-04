// The optimize sweep's measurements and scanners (PLAN.md P10.8, D58). recordBaseline measures
// the project before any finding is acted on: each check's time, each test file's time and the
// tests that flip between identical runs, the build time and the gzip size of what it writes,
// the package count and the dev server's start time; the browser walk adds each page's timings
// through recordBrowserBaseline. runOptimizeScanners runs the deterministic tools: knip and
// jscpd through npx at pinned versions (fetched on the fly, never added to the project), npm
// outdated, a reference search for unused packages, git churn hotspots, stale TODO/FIXME
// comments and commented-out code. Something is "unused" only on three proofs (a tool flags it,
// a search of the whole repository finds no reference to it, no entry-point convention of the
// stack matches), and every candidate carries a fix tier: A mechanical with proof, B behind
// tests that pin the current behaviour, C report-only. A tool that is missing or fails is "not
// checked", never clean. The research behind the rules: knip called live hook scripts, lazily
// imported libraries and templates copied by path "unused" in this very repository.
// Node built-ins only.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { runCommand, findOnPath } from "./proc.js";
import { runChecks, checksEnv } from "./checks.js";
import { ensureDevServer } from "./devserver.js";
import { readJson, readText, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { isWindows } from "./paths.js";

// Pinned: the versions the research ran on 2026-10-02. A newer one is a deliberate change with
// its own check, never whatever the registry calls latest on the day of a sweep.
export const KNIP_VERSION = "6.39.0";
export const JSCPD_VERSION = "5.4.0";

export const OPTIMIZE_MODULES = Object.freeze(["unused", "duplicates", "performance", "rebuild", "tests"]);

// Every category an optimize finding may carry, with the safest tier it may get (D58). A finding
// can be moved to a riskier tier, never to a safer one (applyTierRules).
export const TIER_FLOOR = Object.freeze({
  "unused-file": "A",
  "unused-dependency": "A",
  "unlisted-dependency": "A",
  "commented-out": "A",
  "stale-todo": "A",
  "leftover": "A",
  "outdated": "A",
  "unused-export": "B",
  "duplicate": "B",
  "performance": "B",
  "rebuild": "B",
  "slow-test": "B",
  "flaky-test": "B",
  "bug": "B",
  "major-upgrade": "C"
});
export const OPTIMIZE_CATEGORIES = Object.freeze(Object.keys(TIER_FLOOR));

export const DEFAULT_FLAKY_RERUNS = 2;
export const STALE_TODO_DAYS = 180;
export const DUPLICATE_MIN_LINES = 10;
const DUPLICATE_MIN_TOKENS = 50;
// The most candidates of one category handed on: every candidate costs verification sessions.
export const MAX_PER_CATEGORY = 60;
export const HOTSPOT_COUNT = 10;
const CHURN_COMMITS = 1000;
const SLOW_TEST_MS = 5000;
const SLOW_TEST_SHARE = 0.1;
const MAX_SLOW_TESTS = 5;
const KNIP_TIMEOUT_MS = 10 * 60000;
const JSCPD_TIMEOUT_MS = 10 * 60000;
const NPM_TIMEOUT_MS = 3 * 60000;
const GIT_TIMEOUT_MS = 2 * 60000;
const BUILD_TIMEOUT_MS = 15 * 60000;
const TEST_FILE_TIMEOUT_MS = 10 * 60000;
// All the timed runs of one test suite together; what does not fit is reported as not checked.
const TEST_BUDGET_MS = 45 * 60000;
const MAX_CORPUS_FILES = 20000;
const MAX_CORPUS_BYTES = 1024 * 1024;
const MAX_BUNDLE_FILES = 20000;
const MAX_BUNDLE_FILE_BYTES = 50 * 1024 * 1024;
const MAX_BLAME_FILES = 60;
const MAX_BLAME_LINES = 50;

const norm = (p) => String(p ?? "").replace(/\\/g, "/").replace(/^\.\//, "");
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const arr = (v) => (Array.isArray(v) ? v : []);
const SAFE_ARG = /^[A-Za-z0-9_./=:%@+,-]+$/;

// One argument for the shell runCommand uses (cmd.exe on Windows, /bin/sh elsewhere).
export function q(arg) {
  const s = String(arg);
  if (SAFE_ARG.test(s)) return s;
  return isWindows ? `"${s.replace(/"/g, '\\"')}"` : `"${s.replace(/([\\"$`])/g, "\\$1")}"`;
}

// Runs a command through the injected runner and never rejects: { ok, code, stdout, stderr,
// timedOut, durationMs, error }.
async function safeRun(run, command, opts) {
  try {
    const r = (await run(command, opts)) || {};
    const code = r.code === undefined ? null : r.code;
    return { ok: code === 0 && !r.timedOut, code, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), timedOut: !!r.timedOut, durationMs: Number(r.durationMs) || 0, error: null };
  } catch (e) {
    return { ok: false, code: null, stdout: "", stderr: "", timedOut: false, durationMs: 0, error: e && e.message ? e.message : String(e) };
  }
}

// Why a command gave nothing usable, in a few words.
function why(r, timeoutMs) {
  if (r.error) return `could not start: ${r.error}`;
  if (r.timedOut) return `timed out after ${Math.round(timeoutMs / 1000)} s`;
  const text = (r.stderr || r.stdout || "").replace(/\s+/g, " ").trim().slice(0, 200);
  return `exit code ${r.code === null ? "none" : r.code}${text ? `: ${text}` : ""}`;
}

// JSON from a tool's stdout, tolerating a line of noise before or after it.
function parseJsonLoose(text) {
  const t = String(text || "").trim();
  if (!t) return null;
  try { return JSON.parse(t); } catch {}
  const a = t.indexOf("{");
  const b = t.lastIndexOf("}");
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(t.slice(a, b + 1)); } catch { return null; }
}

function readPkg(dir) {
  try { return readJson(path.join(dir, "package.json"), null); } catch { return null; }
}

export function median(values) {
  const v = arr(values).filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2);
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

function moduleSet(options) {
  const m = options && Array.isArray(options.modules) ? options.modules.filter((x) => OPTIMIZE_MODULES.includes(x)) : null;
  return new Set(m && m.length ? m : OPTIMIZE_MODULES);
}

export function flakyReruns(options) {
  const n = options ? options.flakyReruns : undefined;
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 10) : DEFAULT_FLAKY_RERUNS;
}

// ---------- the test commands ----------

// Shell-like words of one command, quotes removed.
export function tokenize(command) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(String(command || "")))) out.push(m[1] !== undefined ? m[1].replace(/\\"/g, '"') : m[2] !== undefined ? m[2] : m[3]);
  return out;
}

const PM_RUN = /^(npm|pnpm|yarn|bun)\s+(run\s+|run-script\s+)?([\w:.@/-]+)(.*)$/;
const PM_BUILTINS = new Set(["install", "i", "ci", "add", "remove", "rm", "uninstall", "update", "up", "upgrade", "exec", "x", "dlx", "init", "create", "publish", "pack", "version", "view", "info", "ls", "list", "link", "outdated", "audit", "config", "cache", "why", "help"]);
const NPM_SCRIPT_WORDS = new Set(["test", "t", "start", "stop", "restart"]);

// A command line as its plain commands: split at &&, ||, ; and |, with npm, pnpm, yarn and bun
// script calls replaced by the scripts they run (so "npm test" becomes "node --test ...").
export function expandCommand(command, scripts = {}, depth = 0) {
  const out = [];
  for (const seg of String(command || "").split(/\s*(?:&&|\|\||;|\|)\s*/).map((s) => s.trim()).filter(Boolean)) {
    const m = PM_RUN.exec(seg);
    let name = m ? m[3] : null;
    const viaRun = !!(m && m[2]);
    const pm = m ? m[1] : null;
    if (name === "t" && pm === "npm" && !viaRun) name = "test";
    const isScript = m && depth < 4 && typeof scripts[name] === "string" && (viaRun || (pm === "npm" ? NPM_SCRIPT_WORDS.has(m[3]) : !PM_BUILTINS.has(name)));
    if (!isScript) { out.push(seg); continue; }
    const extra = String(m[4] || "").trim().replace(/^--(\s+|$)/, "").trim();
    out.push(...expandCommand(scripts[name] + (extra ? ` ${extra}` : ""), scripts, depth + 1));
  }
  return out;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const NODE_EXE = /(^|[\\/])node(\.exe)?$/i;
// node flags whose value is the next word when they are written without "=".
const NODE_VALUE_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file", "--conditions", "-C", "--test-name-pattern", "--test-skip-pattern", "--test-timeout", "--input-type", "--stack-size", "--test-shard"]);

// A `node ... --test ...` command: { exe, env, flags, patterns, concurrency }, or null. The
// reporter flags are dropped (each file is run with the TAP reporter) and so is --watch.
export function parseNodeTestCommand(segment) {
  const toks = tokenize(segment);
  const env = {};
  let i = 0;
  while (i < toks.length && (ENV_ASSIGN.test(toks[i]) || toks[i] === "cross-env" || toks[i] === "env")) {
    const t = toks[i++];
    if (ENV_ASSIGN.test(t)) { const k = t.slice(0, t.indexOf("=")); env[k] = t.slice(k.length + 1); }
  }
  if (i >= toks.length || !NODE_EXE.test(toks[i])) return null;
  const exe = toks[i++];
  const flags = [];
  const patterns = [];
  let hasTest = false;
  let concurrency = null;
  for (; i < toks.length; i++) {
    const t = toks[i];
    const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
    if (t === "--test") { hasTest = true; continue; }
    if (name === "--test-reporter" || name === "--test-reporter-destination" || name === "--watch-path") { if (!t.includes("=")) i++; continue; }
    if (t === "--watch") continue;
    if (name === "--test-concurrency") { const v = t.includes("=") ? t.slice(name.length + 1) : toks[++i]; concurrency = Number(v) > 0 ? Number(v) : null; continue; }
    if (t.startsWith("-")) {
      flags.push(t);
      if (!t.includes("=") && NODE_VALUE_FLAGS.has(t) && i + 1 < toks.length) flags.push(toks[++i]);
      continue;
    }
    patterns.push(t);
  }
  return hasTest ? { exe, env, flags, patterns, concurrency } : null;
}

const RUNNER_WORD = { vitest: /(^|[\\/])vitest(\.cmd|\.js|\.mjs)?$/i, jest: /(^|[\\/])jest(\.cmd|\.js)?$/i };
const RUNNER_DROP = new Set(["--watch", "--watchAll", "--json", "--ui", "--open", "--silent"]);

// vitest or jest in a command: { runner, args } with the arguments that choose what runs (watch
// and reporter flags dropped), or null.
export function detectJsonRunner(segment) {
  const toks = tokenize(segment);
  for (const runner of ["vitest", "jest"]) {
    const at = toks.findIndex((t) => RUNNER_WORD[runner].test(t));
    if (at < 0) continue;
    let rest = toks.slice(at + 1);
    if (runner === "vitest" && ["run", "watch", "dev"].includes(rest[0])) rest = rest.slice(1);
    const args = [];
    for (let i = 0; i < rest.length; i++) {
      const t = rest[i];
      const name = t.includes("=") ? t.slice(0, t.indexOf("=")) : t;
      if (RUNNER_DROP.has(t)) continue;
      if (name === "--reporter" || name === "--reporters" || name === "--outputFile") { if (!t.includes("=")) i++; continue; }
      args.push(t);
    }
    return { runner, args };
  }
  return null;
}

// Node's own default test file patterns (used when the command names none).
const NODE_DEFAULT_PATTERNS = ["**/*.test.{cjs,mjs,js,cts,mts,ts}", "**/*-test.{cjs,mjs,js,cts,mts,ts}", "**/*_test.{cjs,mjs,js,cts,mts,ts}", "**/test-*.{cjs,mjs,js,cts,mts,ts}", "**/test.{cjs,mjs,js,cts,mts,ts}", "**/test/**/*.{cjs,mjs,js,cts,mts,ts}"];

// The files a node --test command runs, relative with forward slashes, sorted.
export function nodeTestFiles(root, patterns) {
  const out = new Set();
  const glob = (pattern, cwd = root, prefix = "") => {
    let found = [];
    try { found = fs.globSync(pattern, { cwd }); } catch { found = []; }
    for (const f of found) {
      const rel = norm(prefix ? `${prefix}/${norm(f)}` : f);
      if (/(^|\/)node_modules\//.test(rel)) continue;
      try { if (fs.statSync(path.join(root, rel)).isFile()) out.add(rel); } catch {}
    }
  };
  for (const p of arr(patterns).length ? patterns : NODE_DEFAULT_PATTERNS) {
    const clean = norm(p);
    if (/[*?[\]{}]/.test(clean)) { glob(clean); continue; }
    let st = null;
    try { st = fs.statSync(path.join(root, clean)); } catch {}
    if (st && st.isFile()) out.add(clean);
    else if (st && st.isDirectory()) for (const d of NODE_DEFAULT_PATTERNS) glob(d, path.join(root, clean), clean);
  }
  return [...out].sort();
}

// TAP from node --test: one entry per test (suites left out), named "suite > test".
export function parseTap(text) {
  const out = [];
  const open = [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  let last = null;
  for (const line of lines) {
    const sub = /^(\s*)# Subtest: (.*)$/.exec(line);
    if (sub) { const level = Math.floor(sub[1].length / 4); open.length = level; open[level] = sub[2].trim(); continue; }
    const m = /^(\s*)(not ok|ok) \d+ - (.*?)(\s+#\s*(SKIP|TODO)\b.*)?$/i.exec(line);
    if (m) {
      const level = Math.floor(m[1].length / 4);
      const name = [...open.slice(0, level), m[3].trim()].join(" > ");
      last = { name, status: m[5] ? "skip" : m[2].toLowerCase() === "ok" ? "pass" : "fail", level };
      out.push(last);
      open.length = level;
      continue;
    }
    if (last && /^\s*type: 'suite'\s*$/.test(line)) { out.splice(out.indexOf(last), 1); last = null; }
  }
  return out.map(({ name, status }) => ({ name, status }));
}

const JEST_STATUS = { passed: "pass", failed: "fail" };

// A jest or vitest JSON report as [{ file, ms, ok, tests: [{ name, status }] }].
export function parseJestJson(json, root) {
  return arr(json && json.testResults).map((t) => {
    const name = String(t.name || t.testFilePath || "");
    const file = name && path.isAbsolute(name) ? norm(path.relative(root, name)) : norm(name);
    const tests = arr(t.assertionResults).map((a) => ({
      name: a.fullName || [...arr(a.ancestorTitles), a.title].filter(Boolean).join(" > "),
      status: JEST_STATUS[a.status] || "skip",
      duration: Number(a.duration) || 0
    }));
    const ms = Number.isFinite(t.endTime) && Number.isFinite(t.startTime) && t.endTime >= t.startTime ? t.endTime - t.startTime : tests.reduce((s, x) => s + x.duration, 0);
    const ok = t.status ? t.status === "passed" : tests.every((x) => x.status !== "fail");
    return { file, ms, ok, tests: tests.map(({ name: n, status }) => ({ name: n, status })) };
  });
}

const TESTY = /\b(test|tests|unit|spec|specs|e2e|integration|vitest|jest|mocha|pytest|playwright|cypress|ava|tap)\b/i;

// The test suites among the checks: node --test, vitest and jest by file; any other check that
// looks like tests ("other") only as a whole.
export function testSuites(root, checks) {
  const scripts = (readPkg(root) || {}).scripts || {};
  const seen = new Set();
  const suites = [];
  for (const check of arr(checks)) {
    if (!check || typeof check.command !== "string") continue;
    let found = false;
    for (const seg of expandCommand(check.command, scripts)) {
      const node = parseNodeTestCommand(seg);
      const json = node ? null : detectJsonRunner(seg);
      if (!node && !json) continue;
      found = true;
      const runner = node ? "node" : json.runner;
      if (seen.has(`${runner}|${seg}`)) continue;
      seen.add(`${runner}|${seg}`);
      suites.push({ check, runner, segment: seg, node, args: json ? json.args : null });
    }
    if (!found && TESTY.test(`${check.name || ""} ${check.command}`)) suites.push({ check, runner: "other", segment: check.command, node: null, args: null });
  }
  return suites;
}

// ---------- the baseline (P10.8) ----------

export function baselineFile(sweepDir) {
  return path.join(sweepDir, "scanners", "baseline.json");
}

export function readBaseline(sweepDir) {
  try { return readJson(baselineFile(sweepDir), null); } catch { return null; }
}

// Lockfiles and how to count the packages each one pins.
export function countLockPackages(root) {
  const read = (f) => readTextSafe(path.join(root, f));
  const json = (t) => { try { return JSON.parse(t); } catch { return null; } };
  for (const f of ["package-lock.json", "npm-shrinkwrap.json"]) {
    const j = json(read(f));
    if (!j) continue;
    if (j.packages && typeof j.packages === "object") return { lockfile: f, count: Object.entries(j.packages).filter(([k, v]) => k.includes("node_modules/") && !(v && v.link)).length };
    let n = 0;
    const walk = (deps) => { for (const v of Object.values(deps || {})) { n++; walk(v && v.dependencies); } };
    walk(j.dependencies);
    return { lockfile: f, count: n };
  }
  let t = read("pnpm-lock.yaml");
  if (t !== null) {
    let inPackages = false;
    let n = 0;
    for (const line of t.split(/\r?\n/)) {
      if (/^\S/.test(line)) { inPackages = /^packages:\s*$/.test(line); continue; }
      if (inPackages && /^ {2}\S.*:\s*$/.test(line)) n++;
    }
    return { lockfile: "pnpm-lock.yaml", count: n };
  }
  t = read("yarn.lock");
  if (t !== null) return { lockfile: "yarn.lock", count: t.split(/\r?\n/).filter((l) => /^[^\s#].*:\s*$/.test(l) && !/^"?__metadata"?:/.test(l)).length };
  t = read("bun.lock");
  if (t !== null) {
    const at = t.indexOf('"packages"');
    return { lockfile: "bun.lock", count: at < 0 ? 0 : (t.slice(at).match(/^ {4}"[^"]+":\s*\[/gm) || []).length };
  }
  for (const f of ["poetry.lock", "uv.lock", "Cargo.lock"]) {
    t = read(f);
    if (t !== null) return { lockfile: f, count: (t.match(/^\[\[package\]\]\s*$/gm) || []).length };
  }
  let j = json(read("Pipfile.lock"));
  if (j) return { lockfile: "Pipfile.lock", count: Object.keys(j.default || {}).length + Object.keys(j.develop || {}).length };
  j = json(read("composer.lock"));
  if (j) return { lockfile: "composer.lock", count: arr(j.packages).length + arr(j["packages-dev"]).length };
  t = read("Gemfile.lock");
  if (t !== null) return { lockfile: "Gemfile.lock", count: t.split(/\r?\n/).filter((l) => /^ {4}\S+ \(.+\)\s*$/.test(l)).length };
  t = read("go.sum");
  if (t !== null) {
    const mods = new Set();
    for (const l of t.split(/\r?\n/)) { const [mod, ver] = l.trim().split(/\s+/); if (mod && ver) mods.add(`${mod} ${ver.replace(/\/go\.mod$/, "")}`); }
    return { lockfile: "go.sum", count: mods.size };
  }
  return null;
}

function readTextSafe(file) {
  try { return readText(file, null); } catch { return null; }
}

const DEP_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];

function directDependencies(pkg) {
  const names = new Set();
  for (const k of DEP_FIELDS) for (const n of Object.keys((pkg && pkg[k]) || {})) names.add(n);
  return names.size;
}

const BUILD_DIRS = ["dist", "build", "out", ".output/public", ".svelte-kit/output", ".next/static", "public/build", "www"];
const COMPRESSED_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".ico", ".woff", ".woff2", ".gz", ".br", ".zip", ".mp4", ".webm", ".mp3", ".ogg"]);

function assetType(file) {
  const ext = path.extname(file).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return "js";
  if (ext === ".css") return "css";
  if ([".html", ".htm"].includes(ext)) return "html";
  if (ext === ".map") return "map";
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".svg", ".ico"].includes(ext)) return "images";
  if ([".woff", ".woff2", ".ttf", ".otf", ".eot"].includes(ext)) return "fonts";
  return "other";
}

function walkFiles(dir, visit, limit = Infinity) {
  let count = 0;
  const stack = [dir];
  while (stack.length && count < limit) {
    const d = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { if (count++ >= limit) break; visit(full); }
    }
  }
  return count;
}

// The newest modification time of any file under dir (0 when it has none).
function newestMtime(dir) {
  let newest = 0;
  walkFiles(dir, (f) => { try { newest = Math.max(newest, fs.statSync(f).mtimeMs); } catch {} }, MAX_BUNDLE_FILES);
  return newest;
}

// Raw and gzip bytes of a build output folder (source maps counted apart, already compressed
// formats at their raw size), per asset type, with the ten largest files by gzip size.
export function measureFolder(dir, { root = null, maxFiles = MAX_BUNDLE_FILES } = {}) {
  const byType = {};
  const all = [];
  let rawBytes = 0;
  let gzipBytes = 0;
  let mapBytes = 0;
  let skipped = 0;
  const seen = walkFiles(dir, (full) => {
    let buf;
    try {
      const st = fs.statSync(full);
      if (st.size > MAX_BUNDLE_FILE_BYTES) { skipped++; return; }
      buf = fs.readFileSync(full);
    } catch { skipped++; return; }
    const type = assetType(full);
    const raw = buf.length;
    if (type === "map") { mapBytes += raw; return; }
    const gz = COMPRESSED_EXT.has(path.extname(full).toLowerCase()) ? raw : zlib.gzipSync(buf).length;
    rawBytes += raw;
    gzipBytes += gz;
    const t = byType[type] || (byType[type] = { files: 0, rawBytes: 0, gzipBytes: 0 });
    t.files++;
    t.rawBytes += raw;
    t.gzipBytes += gz;
    all.push({ file: norm(path.relative(dir, full)), rawBytes: raw, gzipBytes: gz });
  }, maxFiles);
  all.sort((a, b) => b.gzipBytes - a.gzipBytes);
  return {
    dir: norm(root ? path.relative(root, dir) : dir),
    files: all.length,
    rawBytes,
    gzipBytes,
    mapBytes,
    byType,
    largest: all.slice(0, 10),
    skipped,
    truncated: seen >= maxFiles
  };
}

function packageManager(root) {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lock")) || fs.existsSync(path.join(root, "bun.lockb"))) return "bun";
  return "npm";
}

function scriptCommand(root, script) {
  const pm = packageManager(root);
  return pm === "yarn" ? `yarn ${script}` : `${pm} run ${script}`;
}

function defaultConcurrency() {
  const cpus = typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length;
  return Math.max(1, Math.min(4, cpus - 1));
}

function newFileAcc(file) {
  return { file, samples: [], oks: [], tests: new Map() };
}

function addRun(acc, { ms, ok, tests }) {
  acc.samples.push(ms);
  acc.oks.push(ok);
  for (const t of tests) {
    if (!acc.tests.has(t.name)) acc.tests.set(t.name, []);
    acc.tests.get(t.name).push(t.status);
  }
}

// One suite's per-file times (the median of its runs) and the tests that both passed and failed.
function finishSuite(check, runner, accs, rounds, flaky) {
  const files = [];
  for (const acc of accs.values()) {
    if (!acc.samples.length) continue;
    files.push({ file: acc.file, ms: median(acc.samples), samples: acc.samples, ok: acc.oks.every(Boolean), tests: acc.tests.size });
    let flipped = 0;
    for (const [name, sts] of acc.tests) {
      const passed = sts.filter((s) => s === "pass").length;
      const failed = sts.filter((s) => s === "fail").length;
      if (passed && failed) { flaky.tests.push({ check: check.name, file: acc.file, name, passed, failed, runs: sts.length }); flipped++; }
    }
    const okRuns = acc.oks.filter(Boolean).length;
    if (!flipped && okRuns && okRuns < acc.oks.length) flaky.files.push({ check: check.name, file: acc.file, passed: okRuns, runs: acc.oks.length });
  }
  files.sort((a, b) => b.ms - a.ms);
  return { check: check.name, runner, rounds, files };
}

// node --test, one process per file so each file gets its own time, the whole set run `rounds`
// times (as many files at once as node --test would run, unless the command sets a number).
async function timeNodeSuite(suite, ctx) {
  const { root, env, run, rounds, coverage, now } = ctx;
  const p = suite.node;
  const files = nodeTestFiles(root, p.patterns);
  const label = `test files of "${suite.check.name}"`;
  if (!files.length) { coverage.notExamined.push(`${label}: not checked (no file matched ${p.patterns.join(" ") || "node's default patterns"})`); return null; }
  const conc = p.concurrency || defaultConcurrency();
  const timeoutMs = Math.min(Number(suite.check.timeoutSec) > 0 ? Number(suite.check.timeoutSec) * 1000 : TEST_FILE_TIMEOUT_MS, TEST_FILE_TIMEOUT_MS);
  const accs = new Map(files.map((f) => [f, newFileAcc(f)]));
  const deadline = now() + TEST_BUDGET_MS;
  let done = 0;
  for (let round = 0; round < rounds; round++) {
    if (now() > deadline) break;
    await mapLimit(files, conc, async (f) => {
      const command = [q(p.exe), ...p.flags.map(q), "--test", "--test-reporter=tap", q(f)].join(" ");
      const r = await safeRun(run, command, { cwd: root, env: { ...env, ...p.env }, timeoutMs });
      addRun(accs.get(f), { ms: r.durationMs, ok: r.ok, tests: parseTap(r.stdout) });
    });
    done++;
  }
  if (done < rounds) coverage.notExamined.push(`${label}: only ${done} of ${rounds} runs fitted in the time budget`);
  coverage.examined.push(`${label}: ${files.length} files timed, ${done} ${done === 1 ? "run" : "runs"} each (node --test)`);
  return finishSuite(suite.check, "node", accs, done, ctx.flaky);
}

// vitest or jest with its JSON report, the whole suite run `rounds` times. Needs the runner
// installed in the project (npx --no never fetches it).
async function timeJsonSuite(suite, ctx) {
  const { root, env, run, rounds, coverage, sweepDir, now } = ctx;
  const label = `test files of "${suite.check.name}"`;
  const tmp = path.join(sweepDir, "scanners", "tmp");
  ensureDir(tmp);
  const timeoutMs = Number(suite.check.timeoutSec) > 0 ? Number(suite.check.timeoutSec) * 1000 : TEST_FILE_TIMEOUT_MS;
  const accs = new Map();
  const deadline = now() + TEST_BUDGET_MS;
  let done = 0;
  for (let round = 0; round < rounds; round++) {
    if (now() > deadline) break;
    const out = path.join(tmp, `${suite.runner}-${process.pid}-${round}.json`);
    const args = suite.args.map(q);
    const command = suite.runner === "vitest"
      ? ["npx", "--no", "vitest", "run", ...args, "--reporter=json", q(`--outputFile=${out}`)].join(" ")
      : ["npx", "--no", "jest", ...args, "--json", q(`--outputFile=${out}`)].join(" ");
    const r = await safeRun(run, command, { cwd: root, env, timeoutMs });
    let json = null;
    try { json = readJson(out, null); } catch { json = null; }
    try { fs.rmSync(out, { force: true }); } catch {}
    const files = json ? parseJestJson(json, root) : [];
    if (!files.length) {
      coverage.notExamined.push(`${label}: not checked (${suite.runner} wrote no JSON report: ${why(r, timeoutMs)})`);
      break;
    }
    for (const f of files) {
      if (!accs.has(f.file)) accs.set(f.file, newFileAcc(f.file));
      addRun(accs.get(f.file), f);
    }
    done++;
  }
  if (!done) return null;
  if (done < rounds) coverage.notExamined.push(`${label}: only ${done} of ${rounds} runs completed`);
  coverage.examined.push(`${label}: ${accs.size} files timed, ${done} ${done === 1 ? "run" : "runs"} each (${suite.runner})`);
  return finishSuite(suite.check, suite.runner, accs, done, ctx.flaky);
}

// Any other test check: per-file times are not available, so it is only rerun as a whole.
async function rerunSuite(suite, ctx, firstOk) {
  const { root, env, coverage, reruns, devServerReady } = ctx;
  const outcomes = typeof firstOk === "boolean" ? [firstOk] : [];
  for (let i = 0; i < reruns; i++) {
    const r = await ctx.runChecksFn([suite.check], { cwd: root, env, devServerReady });
    outcomes.push(!!(r && r.ok));
  }
  coverage.notExamined.push(`per-file times of "${suite.check.name}": not checked (only node --test, vitest and jest report them)`);
  if (outcomes.length < 2) return;
  coverage.examined.push(`"${suite.check.name}": run ${outcomes.length} times to find flakiness`);
  const passed = outcomes.filter(Boolean).length;
  if (passed && passed < outcomes.length) ctx.flaky.suites.push({ check: suite.check.name, command: suite.check.command, passed, runs: outcomes.length });
}

// Records the baseline in <sweepDir>/scanners/baseline.json and returns it. Never throws for a
// failing command: what could not be measured is listed in baseline.coverage.notExamined.
// options are the sweep's (modules, flakyReruns); deps replaces runChecks, ensureDevServer and
// the clock in tests; run is runCommand's signature.
export async function recordBaseline({ root, env = process.env, config = {}, sweepDir, run = runCommand, options = {}, deps = {} }) {
  const runChecksFn = deps.runChecks || runChecks;
  const ensureFn = deps.ensureDevServer || ensureDevServer;
  const now = deps.now || Date.now;
  const ce = checksEnv(root, env);
  // Set when this process runs under node --test: a nested node --test would then report to
  // that parent instead of printing TAP, and no file would get its tests counted.
  const runEnv = { ...ce.env };
  delete runEnv.NODE_TEST_CONTEXT;
  const modules = moduleSet(options);
  const coverage = { examined: [], notExamined: [] };
  const startedAt = now();
  const baseline = {
    version: 1,
    at: new Date(startedAt).toISOString(),
    envSource: ce.source,
    checks: [],
    checksGreen: null,
    testFiles: [],
    flaky: null,
    build: null,
    bundle: null,
    packages: null,
    devServer: null,
    pages: null,
    coverage
  };
  const pkg = readPkg(root);

  const lock = countLockPackages(root);
  if (lock || pkg) {
    baseline.packages = { lockfile: lock ? lock.lockfile : null, count: lock ? lock.count : null, direct: pkg ? directDependencies(pkg) : null };
    if (lock) coverage.examined.push(`packages: ${lock.count} in ${lock.lockfile}`);
    else coverage.notExamined.push("package count: not checked (no lockfile)");
  } else {
    coverage.notExamined.push("package count: not checked (no lockfile or package.json)");
  }

  let devServerReady = false;
  const ds = config.devServer;
  if (ds && ds.command && ds.url) {
    const t0 = now();
    let r;
    try { r = await ensureFn(ds, { root, env: runEnv }); } catch (e) { r = { ok: false, error: e.message }; }
    const ms = now() - t0;
    devServerReady = !!(r && r.ok && !r.skipped);
    baseline.devServer = { url: ds.url, ok: !!(r && r.ok), reused: !!(r && r.reused), startMs: r && r.ok && !r.reused ? ms : null, error: r && !r.ok ? r.error || "did not start" : null };
    if (r && r.ok && r.reused) coverage.notExamined.push("dev-server start time: not checked (a server was already answering at its URL)");
    else if (r && r.ok) coverage.examined.push(`dev server: ready in ${secs(ms)}`);
    else coverage.notExamined.push(`dev-server start time: not checked (it did not start: ${baseline.devServer.error})`);
  } else {
    coverage.notExamined.push("dev-server start time: not checked (no dev server is configured)");
  }

  const checks = arr(config.checks).filter((c) => c && c.command);
  const firstOk = new Map();
  for (const check of checks) {
    let res;
    try {
      const r = await runChecksFn([check], { cwd: root, env: runEnv, devServerReady });
      res = r && r.results && r.results[0] ? r.results[0] : { ok: false, durationMs: 0, reason: "no result" };
    } catch (e) {
      res = { ok: false, durationMs: 0, reason: `could not run: ${e.message}` };
    }
    firstOk.set(check, !!res.ok);
    baseline.checks.push({ name: check.name, command: check.command, ok: !!res.ok, ms: res.durationMs || 0, reason: res.ok ? null : res.reason || null });
  }
  if (checks.length) {
    baseline.checksGreen = baseline.checks.every((c) => c.ok);
    const failed = baseline.checks.filter((c) => !c.ok).length;
    coverage.examined.push(`checks: ${checks.length} timed (${failed ? `${failed} failed` : "all passed"})`);
  } else {
    coverage.notExamined.push("check times: not checked (no checks are configured)");
  }

  if (modules.has("tests")) {
    const reruns = flakyReruns(options);
    const ctx = { root, env: runEnv, run, rounds: reruns + 1, reruns, coverage, sweepDir, now, devServerReady, runChecksFn, flaky: { rounds: reruns + 1, tests: [], files: [], suites: [] } };
    const suites = testSuites(root, checks);
    if (!suites.length) coverage.notExamined.push("test files and flaky tests: not checked (no check runs tests)");
    for (const suite of suites) {
      let timed = null;
      try {
        if (suite.runner === "node") timed = await timeNodeSuite(suite, ctx);
        else if (suite.runner === "vitest" || suite.runner === "jest") timed = await timeJsonSuite(suite, ctx);
        else await rerunSuite(suite, ctx, firstOk.get(suite.check));
      } catch (e) {
        coverage.notExamined.push(`test files of "${suite.check.name}": not checked (${e.message})`);
      }
      if (timed) baseline.testFiles.push(timed);
    }
    baseline.flaky = ctx.flaky;
  } else {
    coverage.notExamined.push("test files and flaky tests: not checked (the tests module is off)");
  }

  const scripts = (pkg && pkg.scripts) || {};
  if (typeof scripts.build === "string" && scripts.build.trim()) {
    const command = scriptCommand(root, "build");
    const asCheck = baseline.checks.find((c) => c.command === command || c.command === "npm run build");
    let buildStart = now();
    if (asCheck) {
      baseline.build = { command, ok: asCheck.ok, ms: asCheck.ms, fromCheck: asCheck.name, reason: asCheck.reason };
      buildStart = startedAt;
    } else {
      const r = await safeRun(run, command, { cwd: root, env: runEnv, timeoutMs: BUILD_TIMEOUT_MS });
      baseline.build = { command, ok: r.ok, ms: r.durationMs, fromCheck: null, reason: r.ok ? null : why(r, BUILD_TIMEOUT_MS) };
    }
    if (baseline.build.ok) {
      coverage.examined.push(`build: ${command} in ${secs(baseline.build.ms)}`);
      // Only a folder this build wrote: a stale dist/ from an older build would mislead.
      const dir = BUILD_DIRS.map((d) => path.join(root, d)).find((d) => { try { return fs.statSync(d).isDirectory() && newestMtime(d) >= buildStart - 2000; } catch { return false; } });
      if (dir) {
        baseline.bundle = measureFolder(dir, { root });
        coverage.examined.push(`bundle: ${baseline.bundle.dir}, ${baseline.bundle.files} files, ${kb(baseline.bundle.gzipBytes)} gzip`);
      } else {
        coverage.notExamined.push(`bundle size: not checked (the build wrote none of ${BUILD_DIRS.join(", ")})`);
      }
    } else {
      coverage.notExamined.push(`build time and bundle size: not checked (the build failed: ${baseline.build.reason})`);
    }
  } else {
    coverage.notExamined.push("build time and bundle size: not checked (no build script)");
  }

  coverage.notExamined.push(PAGES_PENDING);
  ensureDir(path.dirname(baselineFile(sweepDir)));
  writeJsonAtomic(baselineFile(sweepDir), baseline);
  return baseline;
}

const PAGES_PENDING = "page timings: not checked yet (the browser walk adds them)";

// One page the optimize browser walk measured (prompts/sweep-optimize-browser.md).
export const PAGE_SCHEMA = {
  type: "object",
  properties: {
    url: { type: "string" },
    loads: { type: "integer" },
    loadMsMedian: { type: "number" },
    loadMsMin: { type: "number" },
    loadMsMax: { type: "number" },
    domContentLoadedMs: { type: "number" },
    requests: { type: "integer" },
    transferKb: { type: "number" },
    failedRequests: { type: "integer" },
    duplicateApiCalls: { type: "array", items: { type: "string" } },
    heavyAssets: { type: "array", items: { type: "string" } },
    consoleErrors: { type: "integer" }
  },
  required: ["url", "loads", "loadMsMedian", "loadMsMin", "loadMsMax", "requests", "transferKb", "duplicateApiCalls", "heavyAssets", "consoleErrors"]
};

// The browser walk's schema: the sweep's candidates schema (findings.js CANDIDATES_SCHEMA) plus
// the measured pages and whether a browser was available at all.
export function optimizeBrowserSchema(candidatesSchema) {
  const base = candidatesSchema && typeof candidatesSchema === "object" ? candidatesSchema : { type: "object", properties: {}, required: [] };
  return {
    ...base,
    properties: { ...(base.properties || {}), pages: { type: "array", items: PAGE_SCHEMA }, browserUnavailable: { type: "boolean" } },
    required: [...new Set([...arr(base.required), "pages", "browserUnavailable"])]
  };
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// Adds the browser walk's page timings to the baseline file and returns the updated baseline.
export function recordBrowserBaseline(sweepDir, result, { now = Date.now } = {}) {
  let b = readBaseline(sweepDir);
  if (!b || typeof b !== "object") b = { version: 1, pages: null, coverage: { examined: [], notExamined: [] } };
  const cov = b.coverage && typeof b.coverage === "object" ? b.coverage : (b.coverage = { examined: [], notExamined: [] });
  cov.examined = arr(cov.examined);
  cov.notExamined = arr(cov.notExamined).filter((s) => s !== PAGES_PENDING && !String(s).startsWith("page timings:"));
  const pages = arr(result && result.pages).filter((p) => p && typeof p === "object" && typeof p.url === "string" && p.url).slice(0, 50).map((p) => ({
    url: p.url,
    loads: num(p.loads),
    loadMsMedian: num(p.loadMsMedian),
    loadMsMin: num(p.loadMsMin),
    loadMsMax: num(p.loadMsMax),
    domContentLoadedMs: num(p.domContentLoadedMs),
    requests: num(p.requests),
    transferKb: num(p.transferKb),
    failedRequests: num(p.failedRequests),
    duplicateApiCalls: arr(p.duplicateApiCalls).map(String).slice(0, 20),
    heavyAssets: arr(p.heavyAssets).map(String).slice(0, 20),
    consoleErrors: num(p.consoleErrors)
  }));
  b.pages = pages;
  b.pagesAt = new Date(now()).toISOString();
  if (pages.length) cov.examined.push(`page timings: ${pages.length} ${pages.length === 1 ? "page" : "pages"} measured by the browser walk`);
  else cov.notExamined.push(`page timings: not checked (${result && result.browserUnavailable ? "no browser was available" : "the browser walk measured no page"})`);
  ensureDir(path.dirname(baselineFile(sweepDir)));
  writeJsonAtomic(baselineFile(sweepDir), b);
  return b;
}

// ---------- the project's files and the reference search ----------

const ALWAYS_SKIP = /(^|\/)(node_modules|\.git|\.autoclaude)\//;
const WALK_SKIP = new Set(["node_modules", ".git", ".autoclaude", "dist", "build", "out", "coverage", ".next", ".nuxt", ".svelte-kit", ".output", ".venv", "venv", "__pycache__", "target", ".turbo", ".cache", "vendor"]);

function walkProject(root) {
  const out = [];
  const stack = [""];
  while (stack.length && out.length < MAX_CORPUS_FILES) {
    const rel = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { if (!WALK_SKIP.has(e.name)) stack.push(r); } else if (e.isFile()) out.push(r);
    }
  }
  return out.sort();
}

// Every file of the project, relative with forward slashes: git's tracked and untracked files
// that .gitignore does not ignore, or a walk of the folder without git.
export async function listProjectFiles(root, { env = process.env, run = runCommand } = {}) {
  const r = await safeRun(run, "git ls-files -z --cached --others --exclude-standard", { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: GIT_TIMEOUT_MS });
  if (r.ok && r.stdout.trim()) {
    const files = [...new Set(r.stdout.split("\0").map((s) => norm(s.trim())).filter((f) => f && !ALWAYS_SKIP.test(f)))].sort();
    return { files, source: "git" };
  }
  return { files: walkProject(root), source: "folder" };
}

const LOCKFILES = new Set(["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "poetry.lock", "uv.lock", "Cargo.lock", "Gemfile.lock", "composer.lock", "go.sum", "Pipfile.lock"]);
// Generated by an earlier sweep from its findings: a name in them is not a use.
const GENERATED_PLANS = new Set(["SECURITY_PLAN.md", "OPTIMIZE_PLAN.md"]);
const BINARY_EXT = /\.(png|jpe?g|gif|webp|avif|ico|bmp|tiff?|pdf|zip|gz|tgz|br|7z|rar|jar|war|class|exe|dll|so|dylib|o|a|wasm|woff2?|ttf|otf|eot|mp[34]|webm|mov|avi|ogg|wav|flac|psd|sqlite3?|db|pyc|lockb)$/i;
const DEP_KEYS_ALL = [...DEP_FIELDS, "peerDependencies", "peerDependenciesMeta", "bundledDependencies", "bundleDependencies", "overrides", "resolutions"];

// A package.json without the blocks that declare packages: declaring one is not using it.
function withoutDependencyBlocks(text) {
  try {
    const j = JSON.parse(text);
    for (const k of DEP_KEYS_ALL) delete j[k];
    return JSON.stringify(j, null, 2);
  } catch {
    return text;
  }
}

// Every text file of the project (lockfiles, binaries and files over 1 MB left out) as a Map of
// relative path to text: what the reference search reads.
export function loadCorpus(root, files) {
  const corpus = new Map();
  for (const rel of files) {
    if (corpus.size >= MAX_CORPUS_FILES) break;
    const base = path.posix.basename(rel);
    if (LOCKFILES.has(base) || GENERATED_PLANS.has(base) || BINARY_EXT.test(rel)) continue;
    let buf;
    try {
      const st = fs.statSync(path.join(root, rel));
      if (!st.isFile() || st.size > MAX_CORPUS_BYTES) continue;
      buf = fs.readFileSync(path.join(root, rel));
    } catch { continue; }
    if (buf.subarray(0, 8000).includes(0)) continue;
    const text = buf.toString("utf8");
    corpus.set(rel, base === "package.json" ? withoutDependencyBlocks(text) : text);
  }
  return corpus;
}

export const identifierMatcher = (name) => ({ needle: name, re: new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`) });
// A package name as a whole word: "react/jsx-runtime" and "react" count, "react-dom",
// "@types/react" and "lodash.debounce" (for lodash) do not.
export const packageMatcher = (name) => ({ needle: name, re: new RegExp(`(?<![\\w@/.-])${esc(name)}(?![\\w-]|\\.\\w)`) });
const INDEX_STEMS = new Set(["index", "__init__", "mod", "main"]);

// How a file can be referred to: its name with the extension, its stem after a slash or a quote
// ("./footprint", 'lib/footprint'), its folder for an index file, and a Python module name.
export function fileMatchers(rel) {
  const base = path.posix.basename(rel);
  const ext = path.posix.extname(base);
  let stem = base.slice(0, base.length - ext.length);
  const list = [{ needle: base, re: new RegExp(`(?<![\\w.-])${esc(base)}(?![\\w-])`) }];
  if (INDEX_STEMS.has(stem)) {
    const parent = path.posix.basename(path.posix.dirname(rel));
    if (parent && parent !== ".") stem = parent;
  }
  if (stem) list.push({ needle: stem, re: new RegExp(`(?<=[/\\\\'"\`])${esc(stem)}(?![\\w-])`) });
  if (ext === ".py" && stem) list.push(identifierMatcher(stem));
  return list;
}

// The files (at most `limit`) in which any matcher matches, leaving out `except`.
export function findReferences(corpus, matchers, { except = new Set(), limit = 3 } = {}) {
  const hits = [];
  for (const [rel, text] of corpus) {
    if (except.has(rel)) continue;
    if (matchers.some((m) => text.includes(m.needle) && m.re.test(text))) {
      hits.push(rel);
      if (hits.length >= limit) break;
    }
  }
  return hits;
}

// Entry-point conventions: files a framework, a tool or the platform loads by name or by
// location, so no import ever names them. Matching one keeps a file out of "unused".
const ENTRY_FILE_RULES = [
  [/(^|\/)pages\//, "file-system pages"],
  [/(^|\/)app\/(.*\/)?(page|layout|route|loading|error|global-error|not-found|template|default|head|opengraph-image|twitter-image|icon|apple-icon|sitemap|robots|manifest)\.[cm]?[jt]sx?$/, "app router file"],
  [/(^|\/)routes\//, "file-system routes"],
  [/(^|\/)\+(page|layout|server|error)(\.server)?\.[jt]s$|(^|\/)\+(page|layout|error)\.svelte$/, "route file"],
  [/(^|\/)api\//, "API route folder"],
  [/(^|\/)(middleware|instrumentation)\.[cm]?[jt]s$/, "framework middleware"],
  [/(^|\/)[^/]+\.config\.[cm]?[jt]s$|(^|\/)\.[^/]+rc(\.[cm]?[jt]s|\.json|\.ya?ml)?$/, "tool config file"],
  [/(^|\/)(migrations?|migrate|seeds?|seeders|prisma|drizzle|alembic|supabase)\//, "migrations and seeds"],
  [/(^|\/)(bin|scripts|tools|cli)\//, "CLI and scripts"],
  [/(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures|__fixtures__|__mocks__|cypress|playwright)\//, "tests and test helpers"],
  [/\.(test|spec|e2e|stories|story)\.[^/]+$|\.d\.[cm]?ts$/, "test, story or declaration file"],
  [/(^|\/)(conftest|setup|manage|wsgi|asgi|settings|urls|admin|apps|signals|tasks|__main__|__init__)\.py$/, "Python framework file"],
  [/(^|\/)(\.storybook|\.github|\.husky|\.devcontainer|\.vscode)\//, "tooling folder"],
  [/(^|\/)(public|static|www)\//, "served by path"],
  [/(^|\/)(templates?|project-template|skeleton|scaffold|blueprints?)\//, "template copied by path"],
  [/(^|\/)(functions|netlify|lambdas?|workers?|jobs|cron|crons)\//, "workers and jobs"],
  [/(^|\/)(sw|service-worker|worker)\.[cm]?[jt]s$|\.worker\.[cm]?[jt]s$/, "worker script"],
  [/^(src\/)?(main|index|server|app|cli)\.[cm]?[jt]sx?$/, "application entry point"]
];

// The convention a file matches (a label), or null.
export function entryPointFile(rel, packageEntries = new Set()) {
  const r = norm(rel);
  if (packageEntries.has(r)) return "a package.json entry (main, exports or bin)";
  for (const [re, label] of ENTRY_FILE_RULES) if (re.test(r)) return label;
  return null;
}

// Exports a framework reads by name (route handlers, page options, loaders).
const ENTRY_EXPORT_NAMES = new Set(["default", "config", "metadata", "generateMetadata", "generateStaticParams", "generateViewport", "generateSitemaps", "viewport", "revalidate", "dynamic", "dynamicParams", "fetchCache", "runtime", "preferredRegion", "maxDuration", "getServerSideProps", "getStaticProps", "getStaticPaths", "getInitialProps", "loader", "action", "meta", "links", "headers", "handle", "shouldRevalidate", "ErrorBoundary", "HydrateFallback", "clientLoader", "clientAction", "load", "prerender", "ssr", "csr", "trailingSlash", "entries", "GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS", "handler", "middleware", "matcher"]);

// Packages used by a tool's convention rather than by an import.
const ENTRY_DEP_RULES = [
  [/^@types\//, "type definitions"],
  [/(^|\/)eslint-(config|plugin)(-|$)|^@typescript-eslint\/|^@eslint\/|^typescript-eslint$|^globals$/, "lint configuration"],
  [/(^|\/)prettier-plugin-|^prettier$/, "formatter"],
  [/^@babel\/|^babel-(preset|plugin)-/, "Babel preset or plugin"],
  [/^postcss(-|$)|^autoprefixer$|^tailwindcss$|^@tailwindcss\//, "CSS tooling"],
  [/^stylelint(-|$)|^@commitlint\/|^(husky|lint-staged|simple-git-hooks)$/, "repository tooling"],
  [/^(typescript|tslib|@swc\/helpers|regenerator-runtime|core-js)$/, "compiler or runtime helper"]
];

export function entryPointDependency(name) {
  for (const [re, label] of ENTRY_DEP_RULES) if (re.test(name)) return label;
  return null;
}

// Commands a package installs under another name than its own.
const KNOWN_BINS = {
  typescript: ["tsc", "tsserver"],
  "@playwright/test": ["playwright"],
  "npm-run-all": ["run-s", "run-p", "npm-run-all"],
  "npm-run-all2": ["run-s", "run-p", "npm-run-all"],
  "@biomejs/biome": ["biome"],
  "@angular/cli": ["ng"],
  "@vue/cli-service": ["vue-cli-service"],
  "@nestjs/cli": ["nest"],
  "@11ty/eleventy": ["eleventy"],
  "@storybook/cli": ["sb", "storybook"],
  "webpack-cli": ["webpack"],
  "@sveltejs/kit": ["svelte-kit"]
};

// The command names a package installs: from its installed package.json when there is one,
// the known renames, and the name without its scope.
function binsOf(root, manifestDir, name) {
  const bins = new Set(KNOWN_BINS[name] || []);
  if (name.startsWith("@")) bins.add(name.slice(name.indexOf("/") + 1));
  for (const dir of [path.join(root, manifestDir || "."), root]) {
    const pkg = readPkg(path.join(dir, "node_modules", name));
    if (!pkg) continue;
    if (typeof pkg.bin === "string") bins.add(name.replace(/^@[^/]+\//, ""));
    else if (pkg.bin && typeof pkg.bin === "object") for (const k of Object.keys(pkg.bin)) bins.add(k);
    break;
  }
  bins.delete(name);
  return [...bins].filter(Boolean);
}

function manifestsOf(root, files) {
  const out = [];
  for (const rel of files) {
    if (path.posix.basename(rel) !== "package.json") continue;
    const text = readTextSafe(path.join(root, rel));
    let json = null;
    try { json = JSON.parse(text); } catch { continue; }
    if (!json || typeof json !== "object") continue;
    const dir = path.posix.dirname(rel);
    out.push({ rel, dir: dir === "." ? "" : dir, json, text });
  }
  return out;
}

function packageEntries(manifests) {
  const out = new Set();
  const add = (dir, v) => {
    if (typeof v === "string") out.add(norm(path.posix.join(dir || ".", v)));
    else if (v && typeof v === "object") for (const x of Object.values(v)) add(dir, x);
  };
  for (const m of manifests) for (const k of ["main", "module", "browser", "types", "typings", "bin", "exports", "svelte"]) add(m.dir, m.json[k]);
  return out;
}

// The 1-based line of a key in a JSON text (0 when it is not there).
function lineOfKey(text, key) {
  const i = String(text || "").indexOf(`"${key}"`);
  return i < 0 ? 0 : String(text).slice(0, i).split("\n").length;
}

function matchesGlob(rel, glob) {
  const g = norm(glob).replace(/\/+$/, "");
  if (!g) return false;
  for (const p of [g, `${g}/**`, `**/${g}`, `**/${g}/**`]) {
    try { if (path.matchesGlob(rel, p)) return true; } catch {}
  }
  return false;
}

// True when the owner excluded the path from the sweep (sweep options "exclude").
export function isExcluded(rel, globs) {
  const r = norm(rel);
  return arr(globs).some((g) => matchesGlob(r, g));
}

// ---------- fix tiers ----------

const TIER_RANK = { A: 0, B: 1, C: 2 };
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|specs|e2e|fixtures|__mocks__)\/|\.(test|spec)\.[^/]+$/i;
// A database other apps may share: its schema, migrations and seeds are the owner's (tier C).
const SCHEMA_PATH = /(^|\/)(migrations?|migrate|alembic|seeds?|seeders|prisma|drizzle|supabase)\/|(^|\/)schema\.(prisma|sql|rb)$|\.sql$/i;
// Login and permissions belong to the security sweep: an optimize change there is report-only.
// "session" counts only as a whole file name or folder (session-context.js is not auth code).
const AUTH_PATH = /(^|\/)(auth|authn|authz|authentication|authorization|login|logout|signin|signup|permissions?|acl|rbac|oauth2?|sso|passport)(\/|\.|-|_|$)|(^|\/)sessions?(\/|\.[^/]*$)/i;

function riskier(a, b) {
  return (TIER_RANK[a] ?? 2) >= (TIER_RANK[b] ?? 2) ? a : b;
}

// A candidate with its tier raised to what the rules require: never safer than its category's
// floor, C for an unknown category, and C for schema, migration and auth code outside the tests.
// autoFixSafe stays true only for tier A.
export function applyTierRules(c) {
  const given = TIER_RANK[c.tier] === undefined ? "A" : c.tier;
  let tier = riskier(given, TIER_FLOOR[c.category] || "C");
  const file = norm(c.file);
  if (file && !TEST_PATH.test(file) && (SCHEMA_PATH.test(file) || AUTH_PATH.test(file))) tier = "C";
  return { ...c, tier, autoFixSafe: tier === "A" && c.autoFixSafe !== false };
}

const SEVERITY_RANK = { critical: 3, high: 2, medium: 1, low: 0 };

// A scanner's candidate in the findings shape. title: one plain line naming the problem and where
// (the report's heading); every scanner below writes one.
function candidate(fields) {
  return applyTierRules({
    kind: "optimize",
    title: "",
    category: "leftover",
    severity: "low",
    cwe: null,
    cvss: null,
    fixedVersion: null,
    confidence: 7,
    file: "",
    line: 0,
    evidence: "",
    impact: "",
    fix: "",
    testIdea: "",
    tier: "A",
    autoFixSafe: true,
    ...fields
  });
}

// ---------- knip, jscpd and npm outdated ----------

// knip's JSON reporter, version 5 (top-level files) or 6 (files per issue), as flat lists.
export function parseKnip(json) {
  const out = { files: [], exports: [], dependencies: [], unlisted: [] };
  const files = new Set();
  for (const f of arr(json && json.files)) files.add(norm(typeof f === "string" ? f : f && f.name));
  for (const i of arr(json && json.issues)) {
    const file = norm(i.file);
    for (const f of arr(i.files)) files.add(norm((f && f.name) || file));
    for (const key of ["exports", "types"]) for (const e of arr(i[key])) if (e && e.name) out.exports.push({ file, name: String(e.name), line: Number(e.line) || 0, type: key === "types" });
    for (const key of ["dependencies", "devDependencies"]) for (const d of arr(i[key])) if (d && d.name) out.dependencies.push({ file, name: String(d.name), line: Number(d.line) || 0, dev: key === "devDependencies" });
    for (const u of arr(i.unlisted)) if (u && u.name) out.unlisted.push({ file, name: String(u.name), line: Number(u.line) || 0 });
  }
  files.delete("");
  out.files = [...files].sort();
  return out;
}

async function runKnip(ctx) {
  const label = `unused files, exports and dependencies (knip ${KNIP_VERSION})`;
  if (!ctx.rootPkg) { ctx.coverage.notExamined.push(`${label}: not checked (no package.json at the project root)`); return null; }
  if (!ctx.which("npx", ctx.env)) { ctx.coverage.notExamined.push(`${label}: not checked (npx is not on PATH)`); return null; }
  const command = `npx -y knip@${KNIP_VERSION} --reporter json --no-exit-code --no-progress --no-config-hints`;
  const r = await safeRun(ctx.run, command, { cwd: ctx.root, env: ctx.env, timeoutMs: KNIP_TIMEOUT_MS });
  const json = r.ok ? parseJsonLoose(r.stdout) : null;
  if (!json || (!Array.isArray(json.issues) && !Array.isArray(json.files))) {
    ctx.coverage.notExamined.push(`${label}: not checked (${!r.ok ? why(r, KNIP_TIMEOUT_MS) : json ? "its report had no issues list" : "its output was not JSON"})`);
    return null;
  }
  const parsed = parseKnip(json);
  writeJsonAtomic(path.join(ctx.scannersDir, "knip.json"), { version: KNIP_VERSION, ...parsed });
  ctx.coverage.examined.push(`knip ${KNIP_VERSION}: flagged ${parsed.files.length} files, ${parsed.exports.length} exports and ${parsed.dependencies.length} dependencies as unused, before the reference search`);
  return parsed;
}

// jscpd's JSON report as [{ lines, tokens, a: { file, start, end }, b: {...} }]; the code
// fragments are left out (they could hold a secret, and the report needs only the places).
// jscpd names code embedded in another format "file.md:markdown"; the suffix is dropped.
export function parseJscpd(json) {
  const side = (f) => ({
    file: norm(f && f.name).replace(/(\.[A-Za-z0-9]+):[A-Za-z][\w-]*$/, "$1"),
    start: Number((f && f.startLoc && f.startLoc.line) ?? (f && f.start)) || 0,
    end: Number((f && f.endLoc && f.endLoc.line) ?? (f && f.end)) || 0
  });
  return arr(json && json.duplicates).map((d) => ({ lines: Number(d.lines) || 0, tokens: Number(d.tokens) || 0, format: d.format || null, a: side(d.firstFile), b: side(d.secondFile) })).filter((d) => d.a.file && d.b.file);
}

const DUPLICATE_EXTRA_EXT = new Set(["css", "scss", "less", "html", "sql"]);
const JSCPD_IGNORE = ["**/node_modules/**", "**/.git/**", "**/.autoclaude/**", "**/dist/**", "**/build/**", "**/out/**", "**/coverage/**", "**/*.min.js", "**/*.map", "**/package-lock.json", "**/pnpm-lock.yaml", "**/yarn.lock"];

async function runJscpd(ctx) {
  const label = `duplicated code (jscpd ${JSCPD_VERSION})`;
  if (!ctx.which("npx", ctx.env)) { ctx.coverage.notExamined.push(`${label}: not checked (npx is not on PATH)`); return []; }
  const outDir = path.join(ctx.scannersDir, "jscpd-raw");
  const ignore = [...JSCPD_IGNORE, ...ctx.exclude.map((g) => norm(g))].join(",");
  const command = ["npx", "-y", `jscpd@${JSCPD_VERSION}`, ".", "--reporters", "json", "--output", q(outDir), "--silent", "--no-colors", "--min-lines", String(DUPLICATE_MIN_LINES), "--min-tokens", String(DUPLICATE_MIN_TOKENS), "--ignore", q(ignore)].join(" ");
  const r = await safeRun(ctx.run, command, { cwd: ctx.root, env: ctx.env, timeoutMs: JSCPD_TIMEOUT_MS });
  let json = null;
  try { json = readJson(path.join(outDir, "jscpd-report.json"), null); } catch { json = null; }
  try { fs.rmSync(outDir, { recursive: true, force: true }); } catch {}
  if (!json || !Array.isArray(json.duplicates)) {
    ctx.coverage.notExamined.push(`${label}: not checked (${r.ok ? "it wrote no JSON report" : why(r, JSCPD_TIMEOUT_MS)})`);
    return [];
  }
  // Code only: repeated prose in docs and fixtures is not worth merging.
  const isCode = (f) => CODE_EXT.has(extOf(f)) || DUPLICATE_EXTRA_EXT.has(extOf(f));
  const dups = parseJscpd(json).filter((d) => d.lines >= DUPLICATE_MIN_LINES && isCode(d.a.file) && isCode(d.b.file) && !isExcluded(d.a.file, ctx.exclude) && !isExcluded(d.b.file, ctx.exclude));
  const stats = json.statistics && json.statistics.total ? json.statistics.total : null;
  writeJsonAtomic(path.join(ctx.scannersDir, "jscpd.json"), { version: JSCPD_VERSION, minLines: DUPLICATE_MIN_LINES, statistics: stats, duplicates: dups });
  ctx.coverage.examined.push(`jscpd ${JSCPD_VERSION}: ${dups.length} duplicated blocks of ${DUPLICATE_MIN_LINES} lines or more`);
  return dups.sort((x, y) => y.lines - x.lines).map((d) => candidate({
    title: d.a.file === d.b.file ? `${d.lines} lines repeated within ${d.a.file}` : `${d.lines} lines repeated in ${d.a.file} and ${d.b.file}`,
    category: "duplicate",
    tool: `jscpd ${JSCPD_VERSION}`,
    severity: d.lines >= 30 ? "medium" : "low",
    confidence: 7,
    file: d.a.file,
    line: d.a.start,
    evidence: `${d.lines} lines at ${d.a.file}:${d.a.start}-${d.a.end} repeat at ${d.b.file}:${d.b.start}-${d.b.end}`,
    impact: "A change made in one copy is easily missed in the other, and both have to be read and tested.",
    fix: "Move the shared code into one function or module that both places call, keeping each caller's behaviour exactly as it is.",
    testIdea: "Tests that pin both callers' current results pass before the merge and, unchanged, after it.",
    tier: "B"
  }));
}

function semver(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

function compareSemver(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

// A breaking step by semver: a new major, or a new minor (0.x) or patch (0.0.x) below 1.0.
export function isMajorJump(from, to) {
  const a = semver(from);
  const b = semver(to);
  if (!a || !b) return false;
  if (a[0] !== b[0]) return true;
  if (a[0] === 0 && a[1] !== b[1]) return true;
  return a[0] === 0 && a[1] === 0 && a[2] !== b[2];
}

// npm outdated --json as [{ name, current, wanted, latest }] (an array per name in workspaces).
export function parseOutdated(json) {
  const out = [];
  for (const [name, v] of Object.entries(json && typeof json === "object" ? json : {})) {
    for (const e of Array.isArray(v) ? v : [v]) if (e && typeof e === "object") out.push({ name, current: e.current || null, wanted: e.wanted || null, latest: e.latest || null });
  }
  return out;
}

// The upgrades the sweep may make (patch and minor: tier A) and the ones it only reports (a new
// major: tier C), from npm outdated.
export function outdatedCandidates(entries, manifestText = "") {
  const out = [];
  for (const e of entries) {
    const cur = semver(e.current);
    if (!cur) continue;
    const line = lineOfKey(manifestText, e.name);
    const lat = semver(e.latest);
    const want = semver(e.wanted);
    const major = !!lat && isMajorJump(e.current, e.latest);
    let target = null;
    if (lat && !major && compareSemver(lat, cur) > 0) target = e.latest;
    else if (want && compareSemver(want, cur) > 0 && !isMajorJump(e.current, e.wanted)) target = e.wanted;
    if (target) {
      out.push(candidate({
        title: `${e.name} ${e.current} can be updated to ${target}`,
        category: "outdated",
        tool: "npm outdated",
        confidence: 8,
        file: "package.json",
        line,
        fixedVersion: target,
        evidence: `${e.name} ${e.current} can move to ${target} (${semver(target)[1] !== cur[1] ? "minor" : "patch"} update)`,
        impact: "Fixes and improvements already published are missed, and later upgrades get bigger.",
        fix: `Upgrade ${e.name} to ${target} (npm install ${e.name}@${target}), updating package.json and the lockfile together.`,
        testIdea: "A clean install (npm ci), the build and every check pass on the new version.",
        tier: "A"
      }));
    }
    if (major) {
      out.push(candidate({
        title: `${e.name} has a new major version (${e.current} to ${e.latest})`,
        category: "major-upgrade",
        tool: "npm outdated",
        confidence: 8,
        file: "package.json",
        line,
        fixedVersion: e.latest,
        evidence: `${e.name} ${e.current}: ${e.latest} is a new major version`,
        impact: "A major version can break the code that uses it; staying behind grows the gap.",
        fix: `Read the breaking changes between ${e.current} and ${e.latest}, then upgrade in a step of its own when the owner decides to.`,
        testIdea: "The checks and a browser walk of the main pages pass on the new version.",
        tier: "C"
      }));
    }
  }
  return out;
}

async function runOutdated(ctx) {
  const label = "outdated packages (npm outdated)";
  if (!ctx.rootPkg) { ctx.coverage.notExamined.push(`${label}: not checked (no package.json at the project root)`); return []; }
  if (ctx.options.advisories === false) { ctx.coverage.notExamined.push(`${label}: not checked (sweep.advisories is off, so package names are not sent to the registry)`); return []; }
  const pm = packageManager(ctx.root);
  if (pm !== "npm") { ctx.coverage.notExamined.push(`${label}: not checked (the project uses ${pm}; only npm is supported)`); return []; }
  if (!ctx.which("npm", ctx.env)) { ctx.coverage.notExamined.push(`${label}: not checked (npm is not on PATH)`); return []; }
  const r = await safeRun(ctx.run, "npm outdated --json", { cwd: ctx.root, env: ctx.env, timeoutMs: NPM_TIMEOUT_MS });
  const json = (r.code === 0 || r.code === 1) && !r.timedOut ? (r.stdout.trim() ? parseJsonLoose(r.stdout) : {}) : null;
  if (!json) { ctx.coverage.notExamined.push(`${label}: not checked (${why(r, NPM_TIMEOUT_MS)})`); return []; }
  const entries = parseOutdated(json);
  writeJsonAtomic(path.join(ctx.scannersDir, "outdated.json"), { entries });
  const missing = entries.filter((e) => !e.current).length;
  if (entries.length && missing === entries.length) { ctx.coverage.notExamined.push(`${label}: not checked (no package is installed: run the install first)`); return []; }
  ctx.coverage.examined.push(`npm outdated: ${entries.length} packages behind${missing ? ` (${missing} not installed, not judged)` : ""}`);
  return outdatedCandidates(entries, readTextSafe(path.join(ctx.root, "package.json")) || "");
}

// ---------- unused files, exports and packages (the three proofs) ----------

const THREE_PROOFS = "a search of the whole repository (code, tests, package.json scripts, CI, Dockerfiles and compose files, manifests, config and docs) finds no reference to it, and it matches no entry-point convention";

function unusedFromKnip(ctx, knip, record) {
  const out = [];
  if (!knip) return out;
  for (const rel of knip.files) {
    if (isExcluded(rel, ctx.exclude) || !ctx.corpus.has(rel)) continue;
    const conv = entryPointFile(rel, ctx.entries);
    if (conv) { record.files.dropped.push({ name: rel, reason: `entry-point convention: ${conv}` }); continue; }
    const refs = findReferences(ctx.corpus, fileMatchers(rel), { except: new Set([rel]) });
    if (refs.length) { record.files.dropped.push({ name: rel, reason: `referenced in ${refs.join(", ")}` }); continue; }
    record.files.kept.push(rel);
    out.push(candidate({
      title: `${rel} is not used anywhere`,
      category: "unused-file",
      tool: `knip ${KNIP_VERSION} + reference search`,
      confidence: 7,
      file: rel,
      line: 0,
      evidence: `knip flags the file as unused; ${THREE_PROOFS}.`,
      impact: `${lineCount(ctx.corpus.get(rel))} lines that are read, built and maintained for nothing.`,
      fix: "Delete the file (git keeps the history).",
      testIdea: "After the deletion the build and every check pass, and a repository-wide search for its name finds only the sweep report.",
      tier: "A"
    }));
  }
  for (const e of knip.exports) {
    if (isExcluded(e.file, ctx.exclude) || !ctx.corpus.has(e.file)) continue;
    const name = `${e.file} ${e.type ? "type" : "export"} ${e.name}`;
    if (ENTRY_EXPORT_NAMES.has(e.name)) { record.exports.dropped.push({ name, reason: "a name frameworks read" }); continue; }
    const conv = entryPointFile(e.file, ctx.entries);
    if (conv) { record.exports.dropped.push({ name, reason: `entry-point convention: ${conv}` }); continue; }
    const refs = findReferences(ctx.corpus, [identifierMatcher(e.name)], { except: new Set([e.file]) });
    if (refs.length) { record.exports.dropped.push({ name, reason: `the name appears in ${refs.join(", ")}` }); continue; }
    record.exports.kept.push(name);
    const own = (ctx.corpus.get(e.file).match(new RegExp(`(?<![\\w$])${esc(e.name)}(?![\\w$])`, "g")) || []).length;
    out.push(candidate({
      title: `${e.type ? "The exported type" : "The export"} ${e.name} in ${e.file} is ${own > 1 ? "used only inside its own file" : "not used anywhere"}`,
      category: "unused-export",
      tool: `knip ${KNIP_VERSION} + reference search`,
      confidence: 7,
      file: e.file,
      line: e.line,
      evidence: `knip flags the ${e.type ? "exported type" : "export"} \`${e.name}\` as unused outside its file; ${THREE_PROOFS}.`,
      impact: "An export nobody imports widens the module's surface and keeps code alive that may be dead.",
      fix: own > 1 ? `Drop the \`export\` keyword from \`${e.name}\`: it is used only inside its own file.` : `Delete \`${e.name}\`: nothing uses it, inside its file or out.`,
      testIdea: "The build, the type check (if any) and every check pass after the change.",
      tier: "B"
    }));
  }
  for (const u of knip.unlisted) {
    if (isExcluded(u.file, ctx.exclude)) continue;
    out.push(candidate({
      title: `${u.file} imports ${u.name}, which no package.json declares`,
      category: "unlisted-dependency",
      tool: `knip ${KNIP_VERSION}`,
      confidence: 7,
      file: u.file,
      line: u.line,
      evidence: `imports "${u.name}", which no package.json of the project declares`,
      impact: "It works only while another package happens to bring it along; an upgrade or a clean install can break it.",
      fix: `Declare ${u.name} in package.json (devDependencies when only tests and tooling use it) at the version the lockfile already installs.`,
      testIdea: "A clean install (npm ci) followed by the build and every check passes.",
      tier: "A"
    }));
  }
  return out;
}

// Declared packages nothing uses: no import or mention anywhere outside the blocks that declare
// them and the lockfiles, no command of theirs used, no tool convention covering them. knip's
// verdict, when it ran, is merged in and needs the same proofs.
function unusedDependencies(ctx, knip, record) {
  const out = [];
  const flagged = new Set(knip ? knip.dependencies.map((d) => `${d.file}|${d.name}`) : []);
  for (const m of ctx.manifests) {
    if (isExcluded(m.rel, ctx.exclude)) continue;
    for (const field of DEP_FIELDS) {
      for (const name of Object.keys(m.json[field] || {})) {
        const byKnip = flagged.has(`${m.rel}|${name}`);
        const conv = entryPointDependency(name);
        if (conv) { if (byKnip) record.dependencies.dropped.push({ name, reason: `tool convention: ${conv}` }); continue; }
        const refs = findReferences(ctx.corpus, [packageMatcher(name)]);
        if (refs.length) { if (byKnip) record.dependencies.dropped.push({ name, reason: `mentioned in ${refs.join(", ")}` }); continue; }
        const bins = binsOf(ctx.root, m.dir, name);
        const binRefs = bins.length ? findReferences(ctx.corpus, bins.map(packageMatcher)) : [];
        if (binRefs.length) { if (byKnip) record.dependencies.dropped.push({ name, reason: `its command is used in ${binRefs.join(", ")}` }); continue; }
        record.dependencies.kept.push(`${m.rel} ${name}`);
        out.push(candidate({
          title: `${name} is declared in ${m.rel} but never used`,
          category: "unused-dependency",
          tool: byKnip ? `knip ${KNIP_VERSION} + reference search` : "reference search",
          confidence: byKnip ? 8 : 7,
          file: m.rel,
          line: lineOfKey(m.text, name),
          evidence: `"${name}" is declared in ${m.rel} (${field}) but nothing imports or mentions it: no import or require, no use in scripts, config, CI, Dockerfiles or docs${bins.length ? `, none of its commands (${bins.join(", ")})` : ""}, and no tool convention covers it.`,
          impact: "Every install downloads it and every audit and upgrade has to consider it.",
          fix: `Remove ${name} from ${m.rel} and the lockfile (npm uninstall ${name}).`,
          testIdea: "A clean install (npm ci), the build and every check pass without it.",
          tier: "A"
        }));
      }
    }
  }
  return out;
}

// ---------- leftovers: commented-out code and stale TODO/FIXME ----------

const LINE_COMMENT = { js: "//", jsx: "//", mjs: "//", cjs: "//", ts: "//", tsx: "//", mts: "//", cts: "//", go: "//", rs: "//", java: "//", kt: "//", kts: "//", cs: "//", swift: "//", c: "//", h: "//", cc: "//", cpp: "//", hpp: "//", scala: "//", dart: "//", php: "//", py: "#", rb: "#", sh: "#", bash: "#", ps1: "#", r: "#", pl: "#" };
const TODO_EXT = new Set([...Object.keys(LINE_COMMENT), "css", "scss", "less", "html", "vue", "svelte", "astro", "sql", "yaml", "yml", "toml"]);
const CODE_EXT = new Set([...Object.keys(LINE_COMMENT), "vue", "svelte", "astro"]);

const extOf = (rel) => path.posix.extname(rel).slice(1).toLowerCase();
const lineCount = (text) => (text ? String(text).split("\n").length : 0);

// What a line of code looks like once its comment marker is gone (prose rarely matches).
const CODE_LINE = [
  /^(if|for|while|switch|catch|with)\s*\(/,
  /^(}\s*)?else\b\s*(if\b|\{|$)/,
  /^(const|let|var)\s+[\w$[\]{},\s]+=/,
  /^(async\s+)?function\b[\s\w$]*\(/,
  /^return\b.*[;)}\]]\s*$|^return;?\s*$|^return\s+[\w$.[\]()'"]+\s*$/,
  /^(import\s.+\sfrom\s|import\s+['"]|export\s+(default|const|let|function|class|async|\{))/,
  /^(def|class)\s+\w+.*:\s*$/,
  /^(elif|else|try|except|finally)\b.*:\s*$/,
  /^(print|console\.\w+|await)\s*\(/,
  /^[\w$.[\]'"]+\s*(=|\+=|-=|\*=|\/=|\|\|=|&&=|\?\?=)\s*[^=\s]/,
  /^[\w$]+(\.[\w$]+)*\s*\(.*\)\s*;?\s*$/,
  /^[}\])]+[;,)]*\s*$/,
  /[;{]\s*$/
];

export function looksLikeCode(text) {
  const t = String(text).trim();
  return t.length > 1 && CODE_LINE.some((re) => re.test(t));
}

// Runs of three or more whole-line comments of which most read as code: [{ start, end }].
export function findCommentedOutBlocks(text, ext) {
  const marker = LINE_COMMENT[ext];
  if (!marker) return [];
  const lines = String(text || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let run = [];
  const flush = () => {
    const body = run.filter((r) => r.text.trim() !== "");
    const code = body.filter((r) => looksLikeCode(r.text)).length;
    if (run.length >= 3 && code >= 2 && code / Math.max(1, body.length) >= 0.6) blocks.push({ start: run[0].line, end: run[run.length - 1].line });
    run = [];
  };
  lines.forEach((line, i) => {
    const t = line.trim();
    const isComment = t.startsWith(marker) && !t.startsWith("///") && !t.startsWith("#!");
    if (isComment) run.push({ line: i + 1, text: t.slice(marker.length) });
    else flush();
  });
  flush();
  return blocks;
}

// Comments that begin with a TODO, FIXME, HACK or XXX: tag, as [{ line, tag, text }]. The
// comment marker starts the line or follows a space, so a tag inside a string does not count.
export function findTodoLines(text) {
  const out = [];
  String(text || "").replace(/\r\n?/g, "\n").split("\n").forEach((line, i) => {
    const m = /(?:^|\s)(?:\/\/+|#+|\/\*+|\*+|<!--|--)\s*@?(TODO\b|FIXME\b|HACK\b|XXX:)(.*)$/.exec(line);
    if (m) out.push({ line: i + 1, tag: m[1].replace(/:$/, ""), text: m[2].replace(/^[\s:(-]+/, "").replace(/\*\/|-->/g, "").trim().slice(0, 120) });
  });
  return out;
}

// git blame --porcelain as a Map of final line number to author time (epoch seconds).
export function parseBlameTimes(stdout) {
  const times = new Map();
  const lineSha = new Map();
  let sha = null;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    const h = /^([0-9a-f]{40}) \d+ (\d+)/.exec(line);
    if (h) { sha = h[1]; lineSha.set(Number(h[2]), sha); continue; }
    const t = /^author-time (\d+)/.exec(line);
    if (t && sha && !times.has(sha)) times.set(sha, Number(t[1]));
  }
  const out = new Map();
  for (const [ln, s] of lineSha) if (times.has(s)) out.set(ln, times.get(s));
  return out;
}

function leftoverCandidates(ctx) {
  const out = [];
  const record = { commentedOut: [], todos: [] };
  for (const [rel, text] of ctx.corpus) {
    if (isExcluded(rel, ctx.exclude)) continue;
    const ext = extOf(rel);
    if (CODE_EXT.has(ext)) {
      const blocks = findCommentedOutBlocks(text, ext);
      if (blocks.length) {
        record.commentedOut.push({ file: rel, blocks });
        const lines = blocks.reduce((s, b) => s + b.end - b.start + 1, 0);
        out.push(candidate({
          title: `${blocks.length === 1 ? "A block" : `${blocks.length} blocks`} of commented-out code in ${rel}`,
          category: "commented-out",
          tool: "comment scan",
          confidence: 6,
          file: rel,
          line: blocks[0].start,
          evidence: `${blocks.length} commented-out ${blocks.length === 1 ? "block" : "blocks"} (${lines} lines): ${blocks.slice(0, 5).map((b) => `lines ${b.start}-${b.end}`).join(", ")}${blocks.length > 5 ? ", ..." : ""}`,
          impact: "Dead code in comments is read on every visit and drifts out of date; git already keeps the history.",
          fix: "Delete the commented-out code; keep a comment only where it explains why something is done.",
          testIdea: "The checks pass, and the file has no commented-out code left.",
          tier: "A"
        }));
      }
    }
    if (TODO_EXT.has(ext)) {
      const todos = findTodoLines(text);
      if (todos.length) record.todos.push({ file: rel, todos });
    }
  }
  return { out, record };
}

async function staleTodoCandidates(ctx, record) {
  const out = [];
  const files = record.todos.slice(0, MAX_BLAME_FILES);
  if (!record.todos.length) { ctx.coverage.examined.push("TODO/FIXME comments: none found"); return out; }
  let blamed = 0;
  let failure = null;
  for (const entry of files) {
    const lines = entry.todos.slice(0, MAX_BLAME_LINES);
    const command = ["git", "blame", "--porcelain", ...lines.flatMap((t) => ["-L", `${t.line},${t.line}`]), "--", q(entry.file)].join(" ");
    const r = await safeRun(ctx.run, command, { cwd: ctx.root, env: { ...ctx.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: GIT_TIMEOUT_MS });
    // A file git does not have yet cannot be dated: its comments are new, not stale.
    if (!r.ok) { failure = why(r, GIT_TIMEOUT_MS); continue; }
    blamed++;
    const times = parseBlameTimes(r.stdout);
    const stale = [];
    for (const t of lines) {
      const at = times.get(t.line);
      if (!at) continue;
      const days = Math.floor((ctx.now() / 1000 - at) / 86400);
      if (days >= STALE_TODO_DAYS) stale.push({ ...t, days });
    }
    entry.stale = stale;
    if (!stale.length) continue;
    out.push(candidate({
      title: `${stale.length === 1 ? `A ${stale[0].tag} comment` : `${stale.length} TODO or FIXME comments`} over ${STALE_TODO_DAYS} days old in ${entry.file}`,
      category: "stale-todo",
      tool: "comment scan + git blame",
      confidence: 5,
      file: entry.file,
      line: stale[0].line,
      evidence: stale.slice(0, 5).map((t) => `${t.tag} at line ${t.line}, ${t.days} days old: "${t.text}"`).join("; ") + (stale.length > 5 ? `; and ${stale.length - 5} more` : ""),
      impact: "Old TODO comments either describe work that is done (noise) or a known problem nobody tracks.",
      fix: "For each one, check whether the work it describes is done: if so, remove the comment; if not, move it to the project's list of deferred work with a pointer here. Never just delete a live one.",
      testIdea: "No TODO older than six months is left in the file without an entry in the deferred list.",
      tier: "A",
      autoFixSafe: false
    }));
  }
  if (!blamed) ctx.coverage.notExamined.push(`stale TODO/FIXME comments: not checked (git blame did not work: ${failure}; ${record.todos.length} ${record.todos.length === 1 ? "file has" : "files have"} such comments)`);
  else ctx.coverage.examined.push(`TODO/FIXME comments: ${record.todos.length} files, ${blamed} dated with git blame${record.todos.length > files.length ? ` (the first ${files.length})` : ""}`);
  return out;
}

// ---------- churn hotspots ----------

const FIX_SUBJECT = /\b(fix|fixes|fixed|fixing|bug|bugfix|hotfix|regression|revert)\b/i;

// git log --numstat with "@@@<subject>" commit lines, as a Map of path to { commits, fixes,
// changed }. Renames count under the new name.
export function parseChurn(stdout) {
  const map = new Map();
  let fix = false;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (line.startsWith("@@@")) { fix = FIX_SUBJECT.test(line.slice(3)); continue; }
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    let p = m[3].replace(/\{([^{}]*) => ([^{}]*)\}/g, "$2").replace(/\/{2,}/g, "/");
    if (p.includes(" => ")) p = p.slice(p.lastIndexOf(" => ") + 4);
    p = norm(p.trim());
    const e = map.get(p) || { commits: 0, fixes: 0, changed: 0 };
    e.commits++;
    if (fix) e.fixes++;
    e.changed += (Number(m[1]) || 0) + (Number(m[2]) || 0);
    map.set(p, e);
  }
  return map;
}

async function churnHotspots(ctx) {
  const label = "churn hotspots (git log)";
  const command = `git log --no-merges -n ${CHURN_COMMITS} --numstat --format=@@@%s`;
  const r = await safeRun(ctx.run, command, { cwd: ctx.root, env: { ...ctx.env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs: GIT_TIMEOUT_MS });
  if (!r.ok) { ctx.coverage.notExamined.push(`${label}: not checked (${why(r, GIT_TIMEOUT_MS)})`); return []; }
  const leads = [];
  for (const [file, s] of parseChurn(r.stdout)) {
    if (s.commits < 2 || !ctx.corpus.has(file) || !CODE_EXT.has(extOf(file)) || TEST_PATH.test(file) || isExcluded(file, ctx.exclude)) continue;
    const lines = lineCount(ctx.corpus.get(file));
    leads.push({ file, commits: s.commits, fixCommits: s.fixes, linesChanged: s.changed, lines, score: s.commits * lines * (1 + s.fixes) });
  }
  leads.sort((a, b) => b.score - a.score || a.file.localeCompare(b.file));
  const top = leads.slice(0, HOTSPOT_COUNT);
  writeJsonAtomic(path.join(ctx.scannersDir, "churn.json"), { commits: CHURN_COMMITS, hotspots: top });
  ctx.coverage.examined.push(`git churn: the last ${CHURN_COMMITS} commits at most, ${top.length} hotspots ranked by changes x size x fix commits`);
  return top;
}

// ---------- the test suite, from the baseline ----------

// Flaky tests (any that both passed and failed in identical runs) and the slowest test files.
export function testCandidates(baseline) {
  const out = [];
  if (!baseline) return out;
  const flaky = baseline.flaky || {};
  const byFile = new Map();
  for (const t of arr(flaky.tests)) {
    if (!byFile.has(t.file)) byFile.set(t.file, []);
    byFile.get(t.file).push(t);
  }
  const flakyText = "A flaky test fails runs at random: each failure costs a fix-up pass, and a real failure is easily taken for noise.";
  const flakyFix = "Find the cause (timing, sleeps, shared state between tests, test order, ports, the real clock or random data) and make the test deterministic. Never skip it, delete or loosen an assertion, or raise a timeout to hide it.";
  for (const [file, tests] of byFile) {
    out.push(candidate({
      title: `${tests.length === 1 ? `The test "${tests[0].name}"` : `${tests.length} tests`} in ${file} passed some identical runs and failed others`,
      category: "flaky-test",
      tool: "baseline reruns",
      severity: "medium",
      confidence: 8,
      file,
      line: 0,
      evidence: tests.slice(0, 5).map((t) => `"${t.name}" passed ${t.passed} of ${t.runs} identical runs`).join("; ") + (tests.length > 5 ? `; and ${tests.length - 5} more` : ""),
      impact: flakyText,
      fix: flakyFix,
      testIdea: `Run the file at least ${Math.max(5, (flaky.rounds || 3) * 2)} times in a row: every run passes, and the test still fails when the code it covers is broken.`,
      tier: "B"
    }));
  }
  for (const f of arr(flaky.files)) {
    if (byFile.has(f.file)) continue;
    out.push(candidate({ title: `${f.file} passed some identical runs and failed others`, category: "flaky-test", tool: "baseline reruns", severity: "medium", confidence: 7, file: f.file, line: 0, evidence: `the file passed ${f.passed} of ${f.runs} identical runs (no single test was named)`, impact: flakyText, fix: flakyFix, testIdea: "Run the file at least 5 times in a row: every run passes.", tier: "B" }));
  }
  for (const s of arr(flaky.suites)) {
    out.push(candidate({ title: `The check "${s.check}" passed some identical runs and failed others`, category: "flaky-test", tool: "baseline reruns", severity: "medium", confidence: 7, file: "", line: 0, evidence: `the check "${s.check}" (${s.command}) passed ${s.passed} of ${s.runs} identical runs`, impact: flakyText, fix: `${flakyFix} Its runner gives no per-test results, so start from its output.`, testIdea: `Run the check at least 5 times in a row: every run passes.`, tier: "B" }));
  }
  for (const suite of arr(baseline.testFiles)) {
    const files = arr(suite.files).filter((f) => Number.isFinite(f.ms));
    const total = files.reduce((s, f) => s + f.ms, 0);
    if (files.length < 2 || total <= 0) continue;
    const slow = files.filter((f) => f.ms >= SLOW_TEST_MS && f.ms / total >= SLOW_TEST_SHARE).sort((a, b) => b.ms - a.ms).slice(0, MAX_SLOW_TESTS);
    for (const f of slow) {
      const share = f.ms / total;
      out.push(candidate({
        title: `${f.file} is one of the slowest test files: ${secs(f.ms)}, ${Math.round(share * 100)}% of the time of "${suite.check}"`,
        category: "slow-test",
        tool: "baseline timing",
        severity: share >= 0.25 ? "medium" : "low",
        confidence: 8,
        file: f.file,
        line: 0,
        evidence: `median ${secs(f.ms)} over ${arr(f.samples).length} runs, ${Math.round(share * 100)}% of the ${secs(total)} all ${files.length} files of "${suite.check}" take together`,
        impact: "Every verification runs the whole suite, so its slowest files set the pace of every run.",
        fix: "Find where the time goes (repeated expensive setup, sleeps and real timers, real network or ports, waits one after another) and remove it without weakening a test.",
        testIdea: `The file's tests pass unchanged, they still fail when the code they cover is broken, and its median time over 5 runs drops by more than 10% from ${secs(f.ms)} with the ranges not overlapping.`,
        tier: "B"
      }));
    }
  }
  return out;
}

// ---------- runOptimizeScanners ----------

// At most MAX_PER_CATEGORY candidates of each category, the most severe and surest first; what
// is cut is said in the coverage.
function capPerCategory(candidates, coverage) {
  const byCat = new Map();
  for (const c of candidates) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }
  const out = [];
  for (const [cat, list] of byCat) {
    list.sort((a, b) => (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0) || b.confidence - a.confidence || a.file.localeCompare(b.file) || a.line - b.line);
    out.push(...list.slice(0, MAX_PER_CATEGORY));
    if (list.length > MAX_PER_CATEGORY) coverage.notExamined.push(`${cat}: ${list.length - MAX_PER_CATEGORY} more candidates beyond the first ${MAX_PER_CATEGORY} were not handed on`);
  }
  return out;
}

// Runs the optimize scanners the sweep's modules ask for and returns { candidates, coverage,
// leads }: candidates in the findings shape without id and fingerprint, each with its tier;
// leads are the churn hotspots, for the reviewers rather than findings of their own. Every
// scanner's own output is saved under <sweepDir>/scanners/. run is runCommand's signature and
// which is proc.findOnPath's; both are replaced in tests.
export async function runOptimizeScanners({ root, env = process.env, options = {}, sweepDir, run = runCommand, baseline = null, which = findOnPath, now = Date.now }) {
  const ce = checksEnv(root, env).env;
  const modules = moduleSet(options);
  const coverage = { examined: [], notExamined: [] };
  const scannersDir = path.join(sweepDir, "scanners");
  ensureDir(scannersDir);
  const listing = await listProjectFiles(root, { env: ce, run });
  const corpus = loadCorpus(root, listing.files);
  const manifests = manifestsOf(root, listing.files);
  const ctx = {
    root,
    env: ce,
    run,
    which,
    now,
    options: options || {},
    corpus,
    manifests,
    entries: packageEntries(manifests),
    rootPkg: manifests.find((m) => m.rel === "package.json") || null,
    exclude: arr(options && options.exclude).map(String),
    scannersDir,
    coverage
  };
  coverage.examined.push(`reference search: ${corpus.size} text files (${listing.source === "git" ? "every file git tracks or would add" : "a walk of the folder, no git"}), lockfiles left out`);
  let candidates = [];
  let leads = [];

  if (modules.has("unused")) {
    const knip = await runKnip(ctx);
    const record = { files: { kept: [], dropped: [] }, exports: { kept: [], dropped: [] }, dependencies: { kept: [], dropped: [] } };
    candidates.push(...unusedFromKnip(ctx, knip, record));
    if (manifests.length) {
      candidates.push(...unusedDependencies(ctx, knip, record));
      coverage.examined.push(`unused packages: ${manifests.length} package.json ${manifests.length === 1 ? "file" : "files"} checked by reference search`);
    } else {
      coverage.notExamined.push("unused packages: not checked (no package.json; other package managers are left to the reviewers)");
    }
    writeJsonAtomic(path.join(scannersDir, "unused.json"), record);
    candidates.push(...(await runOutdated(ctx)));
  }
  if (modules.has("duplicates")) {
    candidates.push(...(await runJscpd(ctx)));
    const { out, record } = leftoverCandidates(ctx);
    candidates.push(...out);
    coverage.examined.push(`commented-out code: ${record.commentedOut.length} files with blocks of 3 or more lines`);
    candidates.push(...(await staleTodoCandidates(ctx, record)));
    writeJsonAtomic(path.join(scannersDir, "leftovers.json"), record);
  }
  if (modules.has("rebuild") || modules.has("performance")) leads = await churnHotspots(ctx);
  if (modules.has("tests")) {
    if (baseline) candidates.push(...testCandidates(baseline));
    else coverage.notExamined.push("slow and flaky tests: not checked (no baseline was recorded)");
  }
  if (modules.has("performance")) coverage.examined.push("performance: measured in the baseline (checks, build, bundle, dev server, pages); findings come from the reviewers and the browser walk");

  candidates = capPerCategory(candidates, coverage);
  writeJsonAtomic(path.join(scannersDir, "optimize.json"), { candidates, coverage, leads });
  return { candidates, coverage, leads };
}

// ---------- the prompts ----------

function secs(ms) {
  return `${(Math.round(Number(ms) / 100) / 10).toFixed(1)} s`;
}

function kb(bytes) {
  const n = Number(bytes) || 0;
  return n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`;
}

// The baseline in a few lines, for the reviewers' prompts.
export function summarizeBaseline(b) {
  if (!b || typeof b !== "object") return "(No baseline was recorded.)";
  const lines = [];
  const checks = arr(b.checks);
  if (checks.length) lines.push(`- Checks: ${checks.map((c) => `${c.name} ${secs(c.ms)} (${c.ok ? "passed" : "FAILED"})`).join(", ")}`);
  for (const s of arr(b.testFiles)) {
    const top = arr(s.files).slice(0, 8).map((f) => `${f.file} ${secs(f.ms)}`).join(", ");
    if (top) lines.push(`- Slowest test files of "${s.check}" (median of ${s.rounds} runs): ${top}`);
  }
  if (b.flaky) {
    const n = arr(b.flaky.tests).length + arr(b.flaky.files).length + arr(b.flaky.suites).length;
    lines.push(n ? `- Flaky: ${[...arr(b.flaky.tests).map((t) => `${t.file} "${t.name}" (${t.passed}/${t.runs})`), ...arr(b.flaky.files).map((f) => `${f.file} (${f.passed}/${f.runs})`), ...arr(b.flaky.suites).map((s) => `check ${s.check} (${s.passed}/${s.runs})`)].slice(0, 10).join(", ")}` : `- Flaky tests: none in ${b.flaky.rounds} identical runs`);
  }
  if (b.build) lines.push(`- Build: ${b.build.command} ${b.build.ok ? secs(b.build.ms) : "FAILED"}`);
  if (b.bundle) {
    const big = arr(b.bundle.largest).slice(0, 3).map((f) => `${f.file} ${kb(f.gzipBytes)}`).join(", ");
    lines.push(`- Bundle (${b.bundle.dir}): ${b.bundle.files} files, ${kb(b.bundle.rawBytes)} raw, ${kb(b.bundle.gzipBytes)} gzip${big ? `; largest (gzip): ${big}` : ""}`);
  }
  if (b.packages) lines.push(`- Packages: ${b.packages.count ?? "?"} in ${b.packages.lockfile || "no lockfile"}${b.packages.direct !== null && b.packages.direct !== undefined ? ` (${b.packages.direct} declared directly)` : ""}`);
  if (b.devServer) lines.push(`- Dev server: ${b.devServer.startMs !== null && b.devServer.startMs !== undefined ? `ready in ${secs(b.devServer.startMs)}` : b.devServer.reused ? "already running (start time not measured)" : "did not start"}`);
  for (const p of arr(b.pages).slice(0, 12)) lines.push(`- Page ${p.url}: ${p.loadMsMedian ?? "?"} ms median load, ${p.requests ?? "?"} requests, ${p.transferKb ?? "?"} KB${arr(p.duplicateApiCalls).length ? `, repeated calls: ${p.duplicateApiCalls.slice(0, 3).join(", ")}` : ""}`);
  const notChecked = arr(b.coverage && b.coverage.notExamined);
  if (notChecked.length) lines.push(`- Not measured: ${notChecked.join("; ")}`);
  return lines.join("\n") || "(The baseline is empty.)";
}

// Single pass with a function replacer: a "$" in the values stays literal and a placeholder
// inside a value is never expanded.
function fill(template, values) {
  return String(template).replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

const MODULE_LABELS = {
  unused: "Unused code and packages",
  duplicates: "Duplicates and leftovers",
  performance: "Performance",
  rebuild: "Poorly built features",
  tests: "The test suite's speed and flakiness"
};

function listText(items, max, empty) {
  const list = arr(items);
  if (!list.length) return empty;
  const shown = list.slice(0, max).map((x) => `- ${x}`);
  if (list.length > max) shown.push(`- (+${list.length - max} more)`);
  return shown.join("\n");
}

function where(c) {
  const line = Number(c.line);
  return `${c.file || "(no file)"}${line > 0 ? `:${line}` : ""}`;
}

// The area reviewer's prompt (prompts/sweep-optimize-area.md). area is { name, files }; the
// scanner candidates and hotspots are narrowed to the area's files when it lists them.
export function buildOptimizeAreaPrompt({ template, root, area = {}, candidates = [], leads = [], baseline = null, options = {}, constraints = "", planFile = "PLAN.md", turns = 40 }) {
  const files = arr(area && area.files).map(norm);
  const inArea = files.length ? new Set(files) : null;
  const hits = arr(candidates).filter((c) => !inArea || inArea.has(norm(c.file)));
  const hot = arr(leads).filter((l) => !inArea || inArea.has(norm(l.file)));
  const modules = moduleSet(options);
  return fill(template, {
    AREA: (area && area.name) || "the whole project",
    FILES: listText(files, 400, "(No file list was given: the area is the whole project.)"),
    MODULES: OPTIMIZE_MODULES.map((m) => `- ${MODULE_LABELS[m]} ("${m}"): ${modules.has(m) ? "on" : "off, do not report it"}`).join("\n"),
    EXCLUDE: listText(arr(options && options.exclude), 50, "(Nothing is excluded.)"),
    CONSTRAINTS: constraints || '(The plan has no "Constraints & decisions" section.)',
    PLAN_FILE: planFile,
    BASELINE: summarizeBaseline(baseline),
    SCANNER_HITS: listText(hits.map((c) => `${c.category}, tier ${c.tier}, ${where(c)}: ${c.evidence} (found by ${c.tool || "a scanner"})`), 80, "(No scanner hit in this area.)"),
    HOTSPOTS: listText(hot.map((l) => `${l.file}: ${l.commits} commits (${l.fixCommits} fixes), ${l.linesChanged} lines changed, ${l.lines} lines now`), 20, "(No hotspot in this area.)"),
    PROJECT_ROOT: String(root).replace(/\\/g, "/"),
    TURNS: turns
  });
}

// The browser walk's prompt (prompts/sweep-optimize-browser.md): read-only, on one URL (the
// local dev server, the first of the sweep's targets).
export function buildOptimizeBrowserPrompt({ template, url, root, turns = 40, loads = 5, maxPages = 12, login = null, pages = [] }) {
  return fill(template, {
    URL: url,
    PROJECT_ROOT: String(root).replace(/\\/g, "/"),
    TURNS: turns,
    LOADS: loads,
    MAX_PAGES: maxPages,
    LOGIN: login || "No login is available: measure the pages that open without one, and list the others under coverage.notExamined.",
    PAGES: listText(pages, 50, "(No page list was given: find the pages as described below.)")
  });
}
