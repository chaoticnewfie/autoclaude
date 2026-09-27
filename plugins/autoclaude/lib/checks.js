// Runs a project's configured checks (the "checks" array in autoclaude.config.json) in order,
// each with its own timeout, and stops at the first failure. Node built-ins only. Every result
// keeps the full output plus the last 150 lines, so the report file can hold everything and the
// Stop-hook summary can quote just the tail (PLAN.md P3.4, section 4.4).
import { runCommand } from "./proc.js";

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

// Runs `checks` ({ name, command, timeoutSec?, needsDevServer? }) in order and stops at the
// first failure. Resolves to { ok, results, failed }: results in the original order (checks
// after the failure are included with skipped: true), failed is the failing result or null.
// Never throws for a failing command; a spawn error becomes a failed result with a reason.
// onProgress(result) is called after every check that was attempted (not for skipped ones).
export async function runChecks(checks, options = {}) {
  const { cwd = process.cwd(), env = process.env, devServerReady = false, onProgress = null } = options;
  const results = [];
  let failed = null;
  for (const check of Array.isArray(checks) ? checks : []) {
    if (failed) {
      results.push(makeResult(check, { skipped: true }));
      continue;
    }
    const result = check.needsDevServer && !devServerReady
      ? makeResult(check, { reason: "dev server not available" })
      : await runOne(check, { cwd, env });
    results.push(result);
    if (onProgress) onProgress(result);
    if (!result.ok) failed = result;
  }
  return { ok: failed === null, results, failed };
}

// Runs one check through the shell with its timeout. Resolves to a result, never rejects.
async function runOne(check, { cwd, env }) {
  const timeoutSec = Number(check.timeoutSec) > 0 ? Number(check.timeoutSec) : DEFAULT_CHECK_TIMEOUT_SEC;
  let r;
  try {
    r = await runCommand(check.command, { cwd, env, timeoutMs: timeoutSec * 1000 });
  } catch (e) {
    return makeResult(check, { reason: `could not start: ${e && e.message ? e.message : String(e)}` });
  }
  const passed = r.code === 0 && !r.timedOut;
  const reason = passed ? null : r.timedOut ? `timed out after ${timeoutSec} s` : `exit code ${r.code === null ? "none" : r.code}`;
  return makeResult(check, {
    ran: true,
    ok: passed,
    code: r.code,
    timedOut: r.timedOut,
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
