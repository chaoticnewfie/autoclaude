// StopFailure hook (PLAN.md P6.2): a turn that ended because of an API error. While a run is
// active the error is written to .autoclaude/failure.json for the supervisor: `rate_limit`
// means Claude Code is waiting out a usage limit (the supervisor leaves it alone until the reset),
// anything else means the session is sitting idle and gets relaunched on the next pass.
// Nothing here notifies; the supervisor pages only when it cannot recover. The full hook input is
// logged, because its exact fields are not documented beyond the matcher values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function failureType(input) {
  const candidates = [input.error_type, input.error && input.error.type, typeof input.error === "string" ? input.error : null, input.stop_reason, input.reason, input.matcher];
  const found = candidates.find((v) => typeof v === "string" && v.trim());
  return found ? found.trim() : "unknown";
}

async function main() {
  if (process.env.AUTOCLAUDE_ROLE) return;
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const { findProjectRoot, projectPaths } = await import("../lib/paths.js");
  const { loadState } = await import("../lib/state.js");
  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root || loadState(root).status !== "running") return;
  const { writeJsonAtomic, appendLine } = await import("../lib/fsatomic.js");
  const p = projectPaths(root);
  const type = failureType(input);
  const at = new Date().toISOString();
  writeJsonAtomic(p.failureFile, { type, at, message: String(input.message || input.error_message || "").slice(0, 300) });
  appendLine(path.join(p.logsDir, "stopfailure.log"), `${at} ${type} ${raw.slice(0, 2000)}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
