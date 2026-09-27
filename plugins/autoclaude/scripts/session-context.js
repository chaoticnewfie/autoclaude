// SessionStart hook (startup, resume, clear, compact). PLAN.md P2.3.
// Runs in EVERY Claude Code session on this machine while the plugin is installed, so:
//   - it must be fast and silent when no AutoClaude run is active in the session's project,
//   - it must never throw (an exception would print noise into someone's session).
// While a run is active it injects prompts/context.md, the current step, the tail of the
// progress file and any pending owner notes. It also mirrors the plugin's notify userConfig
// into the per-machine notify.json (D32), and records the session id in state.json.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../lib/paths.js";
import { loadState, saveState, STATUS } from "../lib/state.js";
import { loadConfig } from "../lib/config.js";
import { parsePlan, stepById, nextStep, stepText } from "../lib/plan.js";
import { readText, appendLine } from "../lib/fsatomic.js";
import { readMachineNotify, writeMachineNotify } from "../lib/notify.js";

const here = path.dirname(fileURLToPath(import.meta.url));

function mirrorNotifyConfig(env) {
  const map = { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "channel", CLAUDE_PLUGIN_OPTION_NTFY_URL: "ntfy_url", CLAUDE_PLUGIN_OPTION_NTFY_TOKEN: "ntfy_token", CLAUDE_PLUGIN_OPTION_DISCORD_WEBHOOK: "discord_webhook" };
  const values = {};
  for (const [k, key] of Object.entries(map)) if (env[k] && String(env[k]).trim()) values[key] = String(env[k]).trim();
  if (Object.keys(values).length === 0) return;
  const current = readMachineNotify();
  const changed = Object.entries(values).some(([k, v]) => current[k] !== v);
  if (changed) writeMachineNotify(values);
}

export function buildContext({ root, state, config, planText, progressText, promptTemplate, cli = "autoclaude" }) {
  const parsed = parsePlan(planText || "");
  const step = (state.currentStep && stepById(parsed, state.currentStep)) || nextStep(parsed);
  const fill = (s) => s
    .replace(/\{\{AUTOCLAUDE_CMD\}\}/g, cli)
    .replace(/\{\{PROJECT_ROOT\}\}/g, root)
    .replace(/\{\{STEP_ID\}\}/g, step ? step.id : "<step>")
    .replace(/\{\{PLAN_FILE\}\}/g, config.plan)
    .replace(/\{\{CONTINUE_HERE\}\}/g, config.docs.continueHere)
    .replace(/\{\{DECISIONS_FILE\}\}/g, config.docs.decisions)
    .replace(/\{\{MAX_ATTEMPTS\}\}/g, String(config.retries.maxAttemptsPerStep));
  const parts = [fill(promptTemplate)];
  if (step) {
    const attempts = state.attempts[step.id] || 0;
    parts.push(`## Current step: ${step.id} ${step.title}${attempts ? ` (attempt ${attempts + 1} of ${config.retries.maxAttemptsPerStep})` : ""}\n\n${stepText(parsed, step)}`);
  } else {
    parts.push("## Current step\n\nNo unfinished step is left in the plan. Run `autoclaude ready` with no id to let the gate close the run.");
  }
  const progressLines = (progressText || "").split(/\r?\n/).filter((l) => l.trim()).slice(-10);
  if (progressLines.length) parts.push(`## Recent progress (last ${progressLines.length} lines of ${config.docs.progress})\n\n${progressLines.join("\n")}`);
  if (state.pendingNotes && state.pendingNotes.length) {
    parts.push(`## Owner review notes: act on these first\n\n${state.pendingNotes.map((n) => `- (${n.at}) ${n.text}`).join("\n")}\n\nRecord how you handled each one in ${config.docs.decisions} as N-###.`);
  }
  return parts.join("\n\n");
}

async function main() {
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}

  try { mirrorNotifyConfig(process.env); } catch {}

  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root) return;
  const state = loadState(root);
  if (state.status !== STATUS.running) return;

  const cfg = loadConfig(root);
  if (cfg.errors.length) return;
  const config = cfg.config;
  const planText = readText(path.join(root, config.plan), "");
  const progressText = readText(path.join(root, config.docs.progress), "");
  const promptTemplate = readText(path.join(here, "..", "prompts", "context.md"), "");
  let cli = "autoclaude";
  try { cli = (await import("../lib/gate.js")).cliCommand(process.env); } catch {}
  const context = buildContext({ root, state, config, planText, progressText, promptTemplate, cli });

  if (input.session_id && state.sessionId !== input.session_id) {
    try { saveState(root, { ...state, sessionId: input.session_id }); } catch {}
  }
  try { appendLine(path.join(root, ".autoclaude", "logs", "hooks.log"), `${new Date().toISOString()} SessionStart ${input.source || "?"} injected ${context.length} chars for ${state.currentStep || "-"}`); } catch {}

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
