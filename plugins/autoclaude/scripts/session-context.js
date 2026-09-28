// SessionStart hook (startup, resume, clear, compact). PLAN.md P2.3.
// Runs in EVERY Claude Code session on this machine while the plugin is installed, so:
//   - it must be fast and silent when no AutoClaude run is active in the session's project,
//   - it must never throw (an exception would print noise into someone's session).
// While a run is active it injects prompts/context.md, the current step, the tail of the
// progress file and any pending owner notes, and records the session id in state.json; both
// only for the builder session (lib/builder.js). It also fills missing keys of the per-machine
// notify.json from the plugin's notify userConfig (D32), in every session.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../lib/paths.js";
import { loadState, saveState, STATUS } from "../lib/state.js";
import { loadConfig } from "../lib/config.js";
import { parsePlan, stepById, nextStep, stepText } from "../lib/plan.js";
import { readText, appendLine } from "../lib/fsatomic.js";
import { readMachineNotify, writeMachineNotify } from "../lib/notify.js";
import { isBuilderSession } from "../lib/builder.js";

const here = path.dirname(fileURLToPath(import.meta.url));

// Fills notify.json from the plugin userConfig only where notify.json has no value yet: a value
// set with `autoclaude notify-setup` is the owner's later choice and is never overwritten here.
export function mirrorNotifyConfig(env) {
  const map = { CLAUDE_PLUGIN_OPTION_NOTIFY_CHANNEL: "channel", CLAUDE_PLUGIN_OPTION_NTFY_URL: "ntfy_url", CLAUDE_PLUGIN_OPTION_NTFY_TOKEN: "ntfy_token", CLAUDE_PLUGIN_OPTION_DISCORD_WEBHOOK: "discord_webhook" };
  const current = readMachineNotify();
  const missing = {};
  for (const [k, key] of Object.entries(map)) {
    const v = env[k] ? String(env[k]).trim() : "";
    const has = current[key] !== undefined && current[key] !== null && String(current[key]).trim() !== "";
    if (v && !has) missing[key] = v;
  }
  if (Object.keys(missing).length) writeMachineNotify(missing);
}

export function buildContext({ root, state, config, planText, progressText, promptTemplate, cli = "autoclaude", now = new Date() }) {
  const parsed = parsePlan(planText || "");
  const step = (state.currentStep && stepById(parsed, state.currentStep)) || nextStep(parsed);
  const fill = (s) => s
    .replace(/\{\{AUTOCLAUDE_CMD\}\}/g, cli)
    .replace(/\{\{DATE\}\}/g, now.toISOString().slice(0, 10))
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
  // The feature the step belongs to, so a fresh session per feature (D49) sees the whole of it:
  // with verifyAt "phase" every Accept line below is checked when the last step is ready.
  if (step && step.phase && step.phase.steps.length > 1) {
    const perFeature = !(config.gate && config.gate.verifyAt === "step");
    const rows = step.phase.steps.map((s) => `- [${s.marker}] ${s.id} ${s.title}${s === step ? "  <- current" : ""}`);
    parts.push(`## Current feature: Phase ${step.phase.num} ${step.phase.title}\n\n${rows.join("\n")}\n\n${perFeature ? `[~] is built and waiting for the feature's verification, which runs over every Accept line of these steps when ${step.phase.steps[step.phase.steps.length - 1].id} is ready.` : "Each step is verified on its own ready (gate.verifyAt is \"step\")."}`);
  }
  if (state.fixup && Array.isArray(state.fixup.findings) && state.fixup.findings.length) {
    const list = state.fixup.findings.map((f, i) => `${i + 1}. [${f.source || "?"}, ${f.severity || "?"}] ${f.text || ""}${f.doc ? ` (${f.doc})` : ""}`).join("\n");
    parts.push(`## Fix-up pass in progress: Phase ${state.fixup.phase ?? "?"}\n\nThe feature passed its verification with these non-blocking findings. Fix each one or leave it for the owner with the reason, as the Fix-up pass rules above say, then run \`${cli} ready ${state.fixup.stepId}\`.\n\n${list}`);
  }
  const progressLines = (progressText || "").split(/\r?\n/).filter((l) => l.trim()).slice(-10);
  if (progressLines.length) parts.push(`## Recent progress (last ${progressLines.length} lines of ${config.docs.progress})\n\n${progressLines.join("\n")}`);
  if (state.ownerAnswer && state.ownerAnswer.answer) {
    const a = state.ownerAnswer;
    parts.push(`## Owner answer: act on this first\n\nYou stopped ${a.step || "the run"} with this question:\n> ${a.question || "(question not recorded)"}\n\nThe owner answered (${a.at}):\n> ${a.answer}\n\nIt is recorded in ${config.docs.decisions} as ${a.decisionId || "a decision"}. Carry on with the step using this answer.`);
  }
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

  // A nested tester or reviewer run must never receive the builder's rules.
  if (process.env.AUTOCLAUDE_ROLE) return;
  try { mirrorNotifyConfig(process.env); } catch {}

  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root) return;
  const state = loadState(root);
  if (state.status !== STATUS.running) return;
  // A person's own session in the project during a supervised run gets no run rules, and its id
  // is never recorded as the run's session.
  if (!isBuilderSession(root)) return;

  const cfg = loadConfig(root);
  if (cfg.errors.length) return;
  const config = cfg.config;
  const planText = readText(path.join(root, config.plan), "");
  const progressText = readText(path.join(root, config.docs.progress), "");
  const promptTemplate = readText(path.join(here, "..", "prompts", "context.md"), "");
  let cli = "autoclaude";
  try { cli = (await import("../lib/gate.js")).cliCommand(process.env); } catch {}
  const context = buildContext({ root, state, config, planText, progressText, promptTemplate, cli });

  // Record the session, and mark owner input as delivered: it reached the builder here, so the
  // gate need not repeat it and clears it when this step passes (seen live: a note injected only
  // at session start stayed pending after its step passed and would have been re-applied).
  const hasOwnerInput = (state.pendingNotes || []).some((n) => !n.delivered) || (state.ownerAnswer && !state.ownerAnswer.delivered);
  if ((input.session_id && state.sessionId !== input.session_id) || hasOwnerInput) {
    try {
      saveState(root, {
        ...state,
        sessionId: input.session_id || state.sessionId,
        pendingNotes: (state.pendingNotes || []).map((n) => ({ ...n, delivered: true })),
        ownerAnswer: state.ownerAnswer ? { ...state.ownerAnswer, delivered: true } : null
      });
    } catch {}
  }
  try { appendLine(path.join(root, ".autoclaude", "logs", "hooks.log"), `${new Date().toISOString()} SessionStart ${input.source || "?"} injected ${context.length} chars for ${state.currentStep || "-"}`); } catch {}

  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: context } }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
