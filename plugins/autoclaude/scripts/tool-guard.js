// PreToolUse hook: while a run is active, keep the builder inside the rules (PLAN.md 4.2, 4.7).
//   - AskUserQuestion is denied with the section 4.5 guidance (no human is there).
//   - Edits to the plan, autoclaude.config.json and .autoclaude/ are denied.
//   - Bash commands that would rewrite those files, force-push, hard-reset a protected branch,
//     or rm -rf outside the project are denied.
// Silent and instant when no run is active. Never throws.
import fs from "node:fs";
import path from "node:path";
import { findProjectRoot } from "../lib/paths.js";
import { loadState, STATUS } from "../lib/state.js";
import { loadConfig } from "../lib/config.js";
import { recordDenial } from "../lib/denials.js";
import { notify } from "../lib/notify.js";

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

export function decide(input, { root, config }) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const cli = "autoclaude";
  if (tool === "AskUserQuestion") {
    return `No human is available during an AutoClaude run. Decide it yourself: check the plan's Constraints & decisions and ${config.docs.decisions} first, then ask the decider agent; apply a routine answer and log it in ${config.docs.decisions} as D-###. Only a critical question (secret, paid service, destructive action, contradiction with the plan) stops the run: \`${cli} blocked <step> "<question with options>"\`.`;
  }
  const protectedRel = [config.plan, "autoclaude.config.json"].map((f) => path.resolve(root, f).toLowerCase());
  const runtimeDir = path.resolve(root, ".autoclaude").toLowerCase();
  const isProtected = (file) => {
    if (!file) return false;
    const abs = path.resolve(root, String(file)).toLowerCase();
    return protectedRel.includes(abs) || abs === runtimeDir || abs.startsWith(runtimeDir + path.sep);
  };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = ti.file_path || ti.notebook_path;
    if (isProtected(file)) return `${path.basename(String(file))} is managed by the gate during a run. Only the gate ticks ${config.plan}; the config and .autoclaude/ are read-only for you. Continue the current step instead.`;
    return null;
  }
  if (tool === "Bash") {
    const cmd = String(ti.command || "");
    // The project's own off-limits list first (guard.deny in autoclaude.config.json, D37).
    const rules = (config.guard && Array.isArray(config.guard.deny)) ? config.guard.deny : [];
    for (const rule of rules) {
      let re;
      try { re = new RegExp(rule.pattern, "i"); } catch { continue; }
      if (re.test(cmd)) return `This project does not allow that command during an AutoClaude run: ${rule.reason || `it matches the guard.deny rule /${rule.pattern}/`}. Find another way that stays inside the project, or if the step truly needs it, run \`${cli} blocked <step> "<why, with the options>"\`.`;
    }
    if (/git\s+push\b[^\n]*(--force|-f\b|--force-with-lease)/.test(cmd)) return "Force pushes are not allowed during an AutoClaude run.";
    if (/git\s+push\b/.test(cmd) && !config.git.push) return "Pushing is off for this run (git.push is false in autoclaude.config.json). The owner pushes after review.";
    if (/git\s+reset\s+--hard/.test(cmd)) return "git reset --hard is not allowed during an AutoClaude run. Use a new commit or revert instead.";
    if (/git\s+(commit|tag)\b/.test(cmd)) return "The gate commits and tags after each verified step. Do not commit yourself; run `autoclaude ready <step>` when the step is done.";
    if (/rm\s+(-[a-zA-Z]*r[a-zA-Z]*f|-[a-zA-Z]*f[a-zA-Z]*r)\s+(\/|~|[A-Za-z]:[\\/]|\.\.)/.test(cmd) || /Remove-Item\b[^\n]*-Recurse[^\n]*([A-Za-z]:[\\/]|~|\.\.)/.test(cmd)) return "Recursive deletes outside the project are not allowed during an AutoClaude run.";
    // A write is a redirect, tee, in-place sed, PowerShell writer, delete or move whose TARGET is
    // the protected path. Reading it (cat, grep, `2>/dev/null` elsewhere on the line) is fine.
    const planName = path.basename(config.plan);
    if (writesTo(cmd, planName)) return `Shell writes to ${config.plan} are not allowed; only the gate edits it.`;
    if (writesTo(cmd, "autoclaude.config.json")) return "autoclaude.config.json is read-only during a run.";
    if (writesTo(cmd, ".autoclaude/") || writesTo(cmd, ".autoclaude\\")) return ".autoclaude/ is the gate's state; do not write to it.";
  }
  return null;
}

// True when a shell command line writes to, deletes or moves a path containing `target`.
export function writesTo(cmd, target) {
  const t = target.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  const pathRe = `["']?[^\\s"'|;&]*${t}[^\\s"'|;&]*["']?`;
  const patterns = [
    `(?:^|[^0-9])>>?\\s*${pathRe}`,                        // > file, >> file (not 2>/dev/null)
    `\\btee\\s+(?:-a\\s+)?${pathRe}`,                      // tee file
    `\\bsed\\s+-i[^|;&]*\\s${pathRe}`,                     // sed -i ... file
    `\\b(?:Set-Content|Out-File|Add-Content)\\b[^|;&]*${pathRe}`,
    `\\b(?:rm|del|erase|unlink|Remove-Item)\\b[^|;&]*${pathRe}`,
    `\\b(?:mv|move|cp|copy|Move-Item|Copy-Item)\\b[^|;&]*\\s${pathRe}\\s*$`, // ... as the destination
    `\\b(?:mv|move|Move-Item)\\b\\s+${pathRe}`,            // moving the file away
    `\\btruncate\\b[^|;&]*${pathRe}`
  ];
  return patterns.some((p) => new RegExp(p, "m").test(cmd));
}

async function main() {
  if (process.env.AUTOCLAUDE_ROLE) return; // nested runs have their own narrow tool list
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root) return;
  const state = loadState(root);
  if (state.status !== STATUS.running) return;
  const cfg = loadConfig(root);
  if (cfg.errors.length) return;
  const reason = decide(input, { root, config: cfg.config });
  if (reason) {
    deny(reason);
    const r = recordDenial(root, { kind: "guard", tool: input.tool_name, detail: JSON.stringify(input.tool_input || {}), reason });
    if (r.notify) {
      await notify({ title: `AutoClaude: ${r.count} denials in the last hour`, message: `The run on ${state.currentStep || "?"} keeps trying things the rules forbid (latest: ${input.tool_name}). It may be stuck. Look at .autoclaude/logs/denials.log.`, priority: "high" }, { logFile: path.join(root, ".autoclaude", "logs", "notify.log"), stdout: { write() { return true; } } });
    }
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
if (isMain) { try { await main(); } catch {} }
