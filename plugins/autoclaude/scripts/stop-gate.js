// Stop hook: the gate. Reads the hook JSON from stdin, runs lib/gate.js, and prints
// {"decision":"block","reason":...} to make Claude continue, or nothing to allow the stop.
// Never throws and never prints anything else: an unexpected error (including a missing
// library) is logged to .autoclaude/logs/gate.log and the stop is allowed; the supervisor then
// notices an idle session and nudges it. This hook runs in every session on the machine, so the
// fast path (no run active) must stay silent.
import fs from "node:fs";
import path from "node:path";

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = {};
try { input = JSON.parse(raw); } catch {}

function log(text) {
  try {
    const { findProjectRoot } = awaitImport("../lib/paths.js");
    const root = findProjectRoot(input.cwd || process.cwd());
    if (root) fs.appendFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), `${new Date().toISOString()} ${text}\n`);
  } catch {}
}

const cache = {};
function awaitImport(rel) { return cache[rel]; }

try {
  cache["../lib/paths.js"] = await import("../lib/paths.js");
  const { findProjectRoot } = cache["../lib/paths.js"];
  const { loadState } = await import("../lib/state.js");
  const root = findProjectRoot(input.cwd || process.cwd());
  if (root && loadState(root).status === "running" && !process.env.AUTOCLAUDE_ROLE) {
    const { runGate } = await import("../lib/gate.js");
    // notify() falls back to stdout when no channel is set; keep that out of the hook's answer.
    const result = await runGate(input, { stdout: { write() { return true; } } });
    if (result.decision === "block") process.stdout.write(JSON.stringify({ decision: "block", reason: result.reason }));
  }
} catch (e) {
  log(`GATE ERROR ${e && e.stack ? e.stack : e}`);
}
