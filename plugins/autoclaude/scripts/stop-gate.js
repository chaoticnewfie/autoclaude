// Stop hook: the gate. Reads the hook JSON from stdin, runs lib/gate.js, and prints
// {"decision":"block","reason":...} to make Claude continue, or nothing to allow the stop.
// Never throws and never prints anything else: an unexpected error (including a missing
// library) is logged to .autoclaude/logs/gate.log and the stop is allowed; the supervisor then
// notices an idle session and relaunches it. This hook runs in every session on the machine, so
// the fast path (no run active) must stay silent, and a person's own session opened in the
// project during a supervised run must be able to stop normally (lib/builder.js).
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

// Whether gate.json names another gate that is still at work: a live pid, written within a
// gate's lifetime (its budget plus the supervisor's margin; older means a reused pid).
async function otherGateHolds(file) {
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!j || !Number.isSafeInteger(j.pid) || j.pid <= 0 || j.pid === process.pid) return false;
    const { isPidAlive } = await import("../lib/proc.js");
    if (!isPidAlive(j.pid)) return false;
    let timeoutSec = 1800;
    try { timeoutSec = (await import("../lib/config.js")).loadConfig(root).config.gate.timeoutSec || timeoutSec; } catch {}
    const at = Date.parse(j.at || "");
    return !Number.isFinite(at) || Date.now() - at < (timeoutSec + 300) * 1000;
  } catch {
    return false;
  }
}

let marker = null;
try {
  const { findProjectRoot } = await import("../lib/paths.js");
  const { loadState } = await import("../lib/state.js");
  root = findProjectRoot(input.cwd || process.cwd());
  const running = root && loadState(root).status === "running" && !process.env.AUTOCLAUDE_ROLE;
  if (running && (await import("../lib/builder.js")).isBuilderSession(root)) {
    // A second gate in the project (a second session in a run started by hand, or a gate left
    // behind by a halt on Linux or macOS) must not hide the first from the supervisor: its
    // gate.json stays, and runGate below stands down.
    const file = path.join(root, ".autoclaude", "gate.json");
    if (!(await otherGateHolds(file))) {
      marker = file;
      try { fs.writeFileSync(marker, JSON.stringify({ pid: process.pid, at: new Date().toISOString() })); } catch { marker = null; }
    }
    const { runGate } = await import("../lib/gate.js");
    // notify() falls back to stdout when no channel is set; keep that out of the hook's answer.
    const result = await runGate(input, { stdout: { write() { return true; } } });
    if (result.decision === "block") process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }));
  }
} catch (e) {
  log(`GATE ERROR ${e && e.stack ? e.stack : e}`);
} finally {
  // Only this gate's own marker goes; one another gate has written since is left to it.
  if (marker) { try { if (JSON.parse(fs.readFileSync(marker, "utf8")).pid === process.pid) fs.unlinkSync(marker); } catch {} }
}
