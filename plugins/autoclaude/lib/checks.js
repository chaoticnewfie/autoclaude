// Runs a project's configured checks (the "checks" array in autoclaude.config.json) in order,
// each with its own timeout, and stops at the first failure. Node built-ins only. Every result
// keeps the full output plus the last 150 lines, so the report file can hold everything and the
// Stop-hook summary can quote just the tail (PLAN.md P3.4, section 4.4).
import path from "node:path";
import { runCommand } from "./proc.js";
import { readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { RUNTIME_DIR } from "./paths.js";

export const TAIL_LINES = 150;
// A check with no timeoutSec in the config gets this one, so a hung command cannot hold the gate.
export const DEFAULT_CHECK_TIMEOUT_SEC = 900;

// The last n lines of a string, joined with "\n". CRLF is normalised and trailing newlines
// do not count as lines, so a tail never ends with an empty line.
export function tailLines(text, n = TAIL_LINES) {
  const clean = String(text ?? "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
  if (clean === "" || !(n > 0)) return "";
  return clean.split("\n").slice(-n).join("\n");
}

// A check is not started with less than this left before the deadline.
export const MIN_CHECK_MS = 10000;

// Runs `checks` ({ name, command, timeoutSec?, needsDevServer? }) in order and stops at the
// first failure. Resolves to { ok, results, failed }: results in the original order (checks
// after the failure are included with skipped: true), failed is the failing result or null.
// Never throws for a failing command; a spawn error becomes a failed result with a reason.
// onProgress(result) is called after every check that was attempted (not for skipped ones).
// deadlineMs (epoch ms; the gate's, so the checks cannot outlive the Stop hook) caps every
// check's timeout; a check stopped by it, or not started for lack of time, has outOfTime: true.
export async function runChecks(checks, options = {}) {
  const { cwd = process.cwd(), env = process.env, devServerReady = false, onProgress = null, deadlineMs = Infinity, now = Date.now, minMs = MIN_CHECK_MS } = options;
  const results = [];
  let failed = null;
  for (const check of Array.isArray(checks) ? checks : []) {
    if (failed) {
      results.push(makeResult(check, { skipped: true }));
      continue;
    }
    const left = deadlineMs - now();
    const result = check.needsDevServer && !devServerReady
      ? makeResult(check, { reason: "dev server not available" })
      : left < minMs
        ? makeResult(check, { reason: "no time left before the gate's deadline", outOfTime: true })
        : await runOne(check, { cwd, env, leftMs: left });
    results.push(result);
    if (onProgress) onProgress(result);
    if (!result.ok) failed = result;
  }
  return { ok: failed === null, results, failed };
}

// Runs one check through the shell with its timeout, or what is left before the deadline when
// that is shorter. Resolves to a result, never rejects.
async function runOne(check, { cwd, env, leftMs = Infinity }) {
  const timeoutSec = Number(check.timeoutSec) > 0 ? Number(check.timeoutSec) : DEFAULT_CHECK_TIMEOUT_SEC;
  const timeoutMs = Math.min(timeoutSec * 1000, leftMs);
  const capped = timeoutMs < timeoutSec * 1000;
  let r;
  try {
    r = await runCommand(check.command, { cwd, env, timeoutMs });
  } catch (e) {
    return makeResult(check, { reason: `could not start: ${e && e.message ? e.message : String(e)}` });
  }
  const passed = r.code === 0 && !r.timedOut;
  const outOfTime = !passed && r.timedOut && capped;
  const reason = passed ? null : outOfTime ? `stopped at the gate's deadline after ${Math.round(timeoutMs / 1000)} s (its own timeoutSec is ${timeoutSec})` : r.timedOut ? `timed out after ${timeoutSec} s` : `exit code ${r.code === null ? "none" : r.code}`;
  return makeResult(check, {
    ran: true,
    ok: passed,
    code: r.code,
    timedOut: r.timedOut,
    outOfTime,
    durationMs: r.durationMs,
    stdout: r.stdout,
    stderr: r.stderr,
    reason
  });
}

// One result with every field present. Defaults describe a check that did not run and failed.
function makeResult(check, fields = {}) {
  const base = {
    name: check.name,
    command: check.command,
    ran: false,
    ok: false,
    code: null,
    timedOut: false,
    outOfTime: false,
    durationMs: 0,
    stdout: "",
    stderr: "",
    tail: "",
    reason: null,
    skipped: false
  };
  const result = { ...base, ...fields };
  result.tail = tailLines(joinOutput(result.stdout, result.stderr));
  return result;
}

function joinOutput(stdout, stderr) {
  const out = String(stdout ?? "");
  const err = String(stderr ?? "");
  if (!out) return err;
  if (!err) return out;
  return out.endsWith("\n") ? out + err : `${out}\n${err}`;
}

// ---------- the checks' environment (P8.4) ----------
// The gate runs the checks with the PATH of the terminal that ran `autoclaude run`: the window,
// the builder session and its hooks all inherit it. `autoclaude checks` is often typed in another
// shell (the builder's Bash tool is Git Bash, whose PATH has its own tools in front), and in the
// rehearsal its pass did not mean the gate's pass. So the run records its PATH, and `checks` and
// the preflight use that.

export const RUN_ENV_FILE = "run-env.json";

export function runEnvFile(root) {
  return path.join(root, RUNTIME_DIR, RUN_ENV_FILE);
}

// Every spelling of the PATH variable in `env` (Windows keeps "Path", Git Bash "PATH").
function pathKeys(env) {
  return Object.keys(env || {}).filter((k) => k.toUpperCase() === "PATH");
}

// Records the PATH (and Path) of `env` for this run. Written only when it differs from what is
// there, so a supervisor that restarts does not touch the file for nothing.
export function recordRunEnv(root, env = process.env, { now = () => new Date() } = {}) {
  const file = runEnvFile(root);
  const rec = { PATH: env.PATH ?? null, Path: env.Path ?? null };
  const old = readRunEnv(root);
  if (old && old.PATH === rec.PATH && old.Path === rec.Path) return { file, changed: false };
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, { ...rec, at: now().toISOString() });
  return { file, changed: true };
}

export function readRunEnv(root) {
  try {
    const j = readJson(runEnvFile(root), null);
    if (!j || typeof j !== "object") return null;
    const value = typeof j.PATH === "string" ? j.PATH : typeof j.Path === "string" ? j.Path : null;
    return value === null ? null : { PATH: j.PATH ?? null, Path: j.Path ?? null, value, at: j.at || null };
  } catch {
    return null;
  }
}

// Folders only Git Bash puts on PATH: its MSYS tree (usr\bin, usr\local\bin and the perl folders
// under usr\bin), the MinGW folders, and entries still in POSIX form (/usr/bin). Git's own cmd
// folder stays, because the Git installer puts that one on the system PATH for cmd.exe too.
const GIT_BASH_DIR = /[\\/](?:usr[\\/](?:local[\\/])?bin|mingw(?:32|64)[\\/]bin|ucrt64[\\/]bin|clang(?:32|64|arm64)[\\/]bin)(?:[\\/]|$)/i;

export function isGitBashOnlyDir(dir) {
  const d = String(dir || "").trim();
  if (!d) return false;
  if (d.startsWith("/") && !d.startsWith("//")) return true;
  return GIT_BASH_DIR.test(d);
}

export function withoutGitBashDirs(value, delimiter = path.delimiter) {
  return String(value || "").split(delimiter).filter((d) => d && !isGitBashOnlyDir(d)).join(delimiter);
}

// `env` with its PATH replaced by `value`, under every spelling it had (one when it had none),
// so a Windows child cannot pick up a stale "Path" next to a new "PATH".
function withPath(env, value) {
  const keys = pathKeys(env);
  const out = { ...env };
  for (const k of keys) delete out[k];
  for (const k of keys.length ? keys : ["PATH"]) out[k] = value;
  return out;
}

// The environment to run the checks in, from a shell's `env`:
// - the PATH the run recorded, when there is one (source "run");
// - otherwise, in Git Bash (MSYSTEM set), the shell's PATH without Git Bash's own folders, which
//   is what a run started from cmd or PowerShell would see (source "git-bash");
// - otherwise the shell's own (source "shell").
export function checksEnv(root, env = process.env, { delimiter = path.delimiter } = {}) {
  const rec = root ? readRunEnv(root) : null;
  if (rec) return { env: withPath(env, rec.value), source: "run", at: rec.at };
  if (env.MSYSTEM) return { env: withPath(env, withoutGitBashDirs(env.PATH ?? env.Path ?? "", delimiter)), source: "git-bash", at: null };
  return { env, source: "shell", at: null };
}

export function describeChecksEnv(ce) {
  if (!ce) return "";
  if (ce.source === "run") return `the PATH the run recorded${ce.at ? ` at ${ce.at}` : ""} (the gate's)`;
  if (ce.source === "git-bash") return "this shell's PATH without Git Bash's own folders (no run has recorded one yet)";
  return "this shell's PATH (no run has recorded one yet)";
}
