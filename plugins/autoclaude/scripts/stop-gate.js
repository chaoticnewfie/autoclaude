// Stop hook: the gate. Reads the hook JSON from stdin, runs lib/gate.js, and prints
// {"decision":"block","reason":...} to make Claude continue, or nothing to allow the stop.
// Never throws and never prints anything else: an unexpected error (including a missing
// library) is logged to .autoclaude/logs/gate.log and the stop is allowed; the supervisor then
// notices an idle session and relaunches it. This hook runs in every session on the machine, so
// the fast path (no run active) must stay silent.
// While the gate works it keeps .autoclaude/gate.json, so the supervisor never mistakes a long
// verification (checks, browser tester, security review) for a stalled session.
import fs from "node:fs";
import path from "node:path";

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = {};
try { input = JSON.parse(raw); } catch {}

let root = null;
function log(text) {
  try { if (root) fs.appendFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), `${new Date().toISOString()} ${text}\n`); } catch {}
}

let marker = null;
try {
  const { findProjectRoot } = await import("../lib/paths.js");
  const { loadState } = await import("../lib/state.js");
  root = findProjectRoot(input.cwd || process.cwd());
  if (root && loadState(root).status === "running" && !process.env.AUTOCLAUDE_ROLE) {
    marker = path.join(root, ".autoclaude", "gate.json");
    try { fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { marker = null; }
    const { runGate } = await import("../lib/gate.js");
    // notify() falls back to stdout when no channel is set; keep that out of the hook's answer.
    const result = await runGate(input, { stdout: { write() { return true; } } });
    if (result.decision === "block") process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }));
  }
} catch (e) {
  log(`GATE ERROR ${e && e.stack ? e.stack : e}`);
} finally {
  if (marker) { try { fs.unlinkSync(marker); } catch {} }
}
