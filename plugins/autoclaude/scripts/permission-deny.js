// PermissionRequest hook (PLAN.md P5.3, D9). While a run is active nobody is there to answer a
// permission prompt, so every prompt is answered "deny" with guidance instead of waiting all
// night. Silent when no run is active (the normal prompt appears), for nested checker runs, and
// for a person's own session in the project while a supervised run is going (they answer it).
// The output shape was verified live in Phase 0 (VERIFY.md P0.6).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function denyMessage(tool, cli = "autoclaude") {
  return `No human is available to approve ${tool || "this"} during an AutoClaude run, so it was denied. Do not retry it. Find another way that stays within what is already allowed (auto mode, the project's files, the configured checks). If the step truly cannot be done without it, run \`${cli} blocked <step> "<what you need and why, with the options>"\` and end your turn.`;
}

async function main() {
  if (process.env.AUTOCLAUDE_ROLE) return;
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const { findProjectRoot } = await import("../lib/paths.js");
  const { loadState } = await import("../lib/state.js");
  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root || loadState(root).status !== "running") return;
  const { isBuilderSession } = await import("../lib/builder.js");
  if (!isBuilderSession(root)) return;

  const tool = input.tool_name || "the action";
  let cli = "autoclaude";
  try { cli = (await import("../lib/gate.js")).cliCommand(process.env); } catch {}
  const message = denyMessage(tool, cli);
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message } } }));

  const { recordDenial } = await import("../lib/denials.js");
  const detail = JSON.stringify(input.tool_input || {});
  const r = recordDenial(root, { kind: "permission", tool, detail, reason: "no human available" });
  if (r.notify) {
    const { notify } = await import("../lib/notify.js");
    const { loadState: ls } = await import("../lib/state.js");
    const step = ls(root).currentStep || "?";
    // Never let the stdout fallback of notify() mix with this hook's JSON answer.
    const quiet = { write() { return true; } };
    await notify({ title: `AutoClaude: ${r.count} denials in the last hour`, message: `The run on ${step} keeps asking for things nobody can approve (latest: ${tool}). It may be stuck. Look at .autoclaude/logs/denials.log, then \`${cli} status\`.`, priority: "high" }, { logFile: path.join(root, ".autoclaude", "logs", "notify.log"), stdout: quiet });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
