// Headless `claude -p` runs for the gate's independent checkers: the browser tester, the bug
// bash (Phase 4), the security reviewer (Phase 5), and the decider the builder asks through
// `autoclaude decide` (Phase 8). Each run is a separate process with a
// fresh context, hooks disabled, no permission prompts, a narrow tool list and a JSON-schema
// verdict. Flags verified on Windows in Phase 0 (VERIFY.md P0.4 and P0.5): the prompt goes in on
// stdin, `--settings '{"disableAllHooks":true}'` (never `--bare`, which breaks subscription
// auth), `--output-format json` with `--json-schema` returns `structured_output`.
// Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { homeDir, isWindows } from "./paths.js";
import { findOnPath, killTree, spawnClaude } from "./proc.js";

// The native Claude Code install, then whatever `claude` is on PATH. AUTOCLAUDE_CLAUDE_BIN wins.
export function claudeBinary(env = process.env) {
  if (env.AUTOCLAUDE_CLAUDE_BIN) return env.AUTOCLAUDE_CLAUDE_BIN;
  const native = path.join(homeDir(), ".local", "bin", isWindows ? "claude.exe" : "claude");
  if (fs.existsSync(native)) return native;
  return findOnPath("claude", env);
}

export function buildArgs({ model = null, maxTurns = null, schema = null, mcpConfig = null, allowedTools = [], extraArgs = [] } = {}) {
  const args = ["-p", "--output-format", "json", "--settings", JSON.stringify({ disableAllHooks: true }), "--permission-mode", "dontAsk", "--strict-mcp-config"];
  if (mcpConfig) args.push("--mcp-config", mcpConfig);
  if (model) args.push("--model", String(model));
  if (maxTurns) args.push("--max-turns", String(maxTurns));
  if (schema) args.push("--json-schema", JSON.stringify(schema));
  if (allowedTools && allowedTools.length) args.push("--allowedTools", allowedTools.join(","));
  args.push(...extraArgs);
  return args;
}

// Turns the raw process result into { ok, infra, error, structured, output, costUsd, numTurns,
// sessionId, denials, durationMs, timedOut, code }. `infra` means the run itself did not produce
// a usable answer (timeout, crash, unreadable output, an error result, no structured output).
export function interpret({ stdout = "", stderr = "", code = null, timedOut = false, durationMs = 0, spawnError = null, expectStructured = true }) {
  const base = { ok: false, infra: true, structured: null, output: null, costUsd: null, numTurns: null, sessionId: null, subtype: null, denials: [], durationMs, timedOut, code };
  if (spawnError) return { ...base, error: `could not start claude: ${spawnError}` };
  if (timedOut) return { ...base, error: `timed out after ${Math.round(durationMs / 1000)} s` };
  const text = String(stdout).trim();
  let out = null;
  try { out = JSON.parse(text); } catch {
    const last = text.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
    try { out = last ? JSON.parse(last) : null; } catch { out = null; }
  }
  if (!out || typeof out !== "object") {
    const why = (String(stderr).trim() || text || "no output").slice(0, 400);
    return { ...base, error: `unreadable output (exit ${code}): ${why}` };
  }
  const meta = {
    output: out,
    costUsd: typeof out.total_cost_usd === "number" ? out.total_cost_usd : null,
    numTurns: typeof out.num_turns === "number" ? out.num_turns : null,
    sessionId: out.session_id || null,
    subtype: out.subtype || null,
    denials: Array.isArray(out.permission_denials) ? out.permission_denials : []
  };
  if (out.is_error) {
    const kind = out.subtype || out.terminal_reason || "error";
    return { ...base, ...meta, error: `claude ended with ${kind}: ${String(out.result || "").slice(0, 400)}` };
  }
  if (expectStructured && (out.structured_output === undefined || out.structured_output === null)) {
    return { ...base, ...meta, error: "the run finished without a structured verdict" };
  }
  return { ...base, ...meta, ok: true, infra: false, error: null, structured: out.structured_output === undefined ? null : out.structured_output };
}

// Runs one headless session. Never rejects. `role` is exported as AUTOCLAUDE_ROLE so every
// AutoClaude hook in the child exits at once even if hooks were somehow enabled.
export function runHeadless({ prompt, args, cwd, env = process.env, role = "reviewer", timeoutMs = 900000, bin = null, binArgs = [], expectStructured = true }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    const exe = bin || claudeBinary(env);
    if (!exe) return done(interpret({ spawnError: "the claude CLI was not found; install Claude Code natively (https://claude.ai/install.ps1 on Windows)", durationMs: 0 }));
    let child;
    try {
      // An npm claude.cmd cannot be spawned directly (EINVAL); spawnClaude runs it through cmd.exe.
      child = spawnClaude(exe, [...binArgs, ...args], { cwd, env: { ...env, AUTOCLAUDE_ROLE: role }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return done(interpret({ spawnError: e.message, durationMs: Date.now() - started }));
    }
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { stdout += d; });
    child.stderr.on("data", (d) => { stderr += d; });
    child.stdin.on("error", () => {});
    child.stdin.end(String(prompt || ""));
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); done(interpret({ spawnError: e.message, durationMs: Date.now() - started })); });
    child.on("close", (code) => {
      clearTimeout(timer);
      done(interpret({ stdout, stderr, code, timedOut, durationMs: Date.now() - started, expectStructured }));
    });
  });
}

// A checker that runs out of turns has usually done the work and only lacks the answer (seen live:
// a phase-end bug bash explored for 60 turns, twice, and the gate threw both runs away). Resume
// that session once with a few turns and ask for the structured answer from what it has seen.
export const WRAP_UP_PROMPT = "You have used all your turns. Stop checking now and make no more tool calls except the one that returns your structured answer. Build the answer from what you have already seen, and say in it what you did not get to check.";
export const WRAP_UP_TURNS = 4;

export function hitTurnLimit(r) {
  return !!(r && !r.ok && r.subtype === "error_max_turns" && r.sessionId);
}

export function wrapUpArgs(args, sessionId, turns = WRAP_UP_TURNS) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--max-turns") { i++; continue; }
    out.push(args[i]);
  }
  return [...out, "--max-turns", String(turns), "--resume", sessionId];
}

// ---------- the decider (`autoclaude decide`, P8.4) ----------
// The builder asks the decider and waits for the answer, instead of starting the decider agent
// and carrying on without it (D49: decide, log, keep going). A read-only headless session in the
// project folder: Read, Glob and Grep only, the project's model, a JSON-schema answer.

export const DECIDER_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    classification: { type: "string", enum: ["routine", "critical"] },
    recommendation: { type: "string" },
    reasoning: { type: "string" },
    question_for_owner: { type: "string" },
    owner_review: { type: "boolean" }
  },
  required: ["classification", "recommendation", "reasoning", "question_for_owner", "owner_review"]
});
export const DECIDER_TOOLS = Object.freeze(["Read", "Glob", "Grep"]);
export const DECIDER_MAX_TURNS = 30;
// The builder waits in one Bash tool call, whose ceiling is 10 minutes.
export const DECIDER_TIMEOUT_MS = 9 * 60 * 1000;

// An agent file's body: everything after its YAML front matter.
export function agentBody(text) {
  const t = String(text || "").replace(/^﻿/, "");
  const m = t.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/);
  return (m ? t.slice(m[0].length) : t).trim();
}

// The decider's prompt: the agent's instructions (agents/decider.md), then this question with the
// files to read. Paths are absolute, because the Read tool wants them so.
export function buildDeciderPrompt({ template = "", question, root, planFile, decisionsFile, step = null, stepText = null }) {
  const body = agentBody(template);
  const lines = [];
  if (body) lines.push(body, "");
  lines.push("## This question", "");
  lines.push(`- Project folder (your working directory): ${root}`);
  lines.push(`- The plan: ${planFile}`);
  lines.push(`- The decisions log: ${decisionsFile}`);
  if (step) lines.push(`- The step being worked on: ${step.id} ${step.title}`);
  if (stepText) lines.push("", "The step as the plan has it:", "", stepText);
  lines.push("", "The builder asks:", "", String(question).trim(), "");
  lines.push("## How to answer here", "");
  lines.push("Give your answer as this run's structured output, with these fields: `classification` (\"routine\" or \"critical\"), `recommendation`, `reasoning` (end it with how to undo the choice if the owner disagrees), `question_for_owner` (an empty string unless the answer is critical), and `owner_review`: true when the recommendation accepts a security or privacy risk (a secret stored in plain text, a check turned off, a port opened, weaker authentication), so the owner reviews it after the run, false otherwise. The run goes on with your recommendation either way unless it is critical.");
  return lines.join("\n");
}

// A decider answer that has every field in its expected type, or null.
export function validDecision(v) {
  if (!v || typeof v !== "object") return null;
  if (v.classification !== "routine" && v.classification !== "critical") return null;
  for (const k of ["recommendation", "reasoning"]) if (typeof v[k] !== "string" || !v[k].trim()) return null;
  return {
    classification: v.classification,
    recommendation: v.recommendation,
    reasoning: v.reasoning,
    question_for_owner: typeof v.question_for_owner === "string" ? v.question_for_owner : "",
    owner_review: v.owner_review === true
  };
}

// Runs the decider once (plus a wrap-up at the turn limit). Resolves to { ok, decision, error,
// durationMs, costUsd, numTurns }; never rejects. `run` is runHeadless or a test fake.
export async function runDecider({ root, question, planFile, decisionsFile, model = "opus", template = "", step = null, stepText = null, env = process.env, run = runHeadless, timeoutMs = DECIDER_TIMEOUT_MS }) {
  const prompt = buildDeciderPrompt({ template, question, root, planFile, decisionsFile, step, stepText });
  const args = buildArgs({ model, maxTurns: DECIDER_MAX_TURNS, schema: DECIDER_SCHEMA, allowedTools: [...DECIDER_TOOLS] });
  // Not the builder: the child's hooks (disabled anyway) must never take it for one.
  const childEnv = { ...env };
  delete childEnv.AUTOCLAUDE_BUILDER;
  let r;
  try {
    // Half a minute past the first run's timeout for a wrap-up, still inside the Bash call.
    r = await runWithWrapUp(run, { prompt, args, cwd: root, env: childEnv, role: "decider", timeoutMs, deadlineMs: Date.now() + timeoutMs + 30000 });
  } catch (e) {
    r = { ok: false, error: e && e.message ? e.message : String(e) };
  }
  const meta = { durationMs: r.durationMs || 0, costUsd: typeof r.costUsd === "number" ? r.costUsd : null, numTurns: r.numTurns ?? null };
  if (!r.ok) return { ok: false, decision: null, error: r.error || "the decider did not answer", ...meta };
  const decision = validDecision(r.structured);
  if (!decision) return { ok: false, decision: null, error: `the decider's answer is incomplete: ${JSON.stringify(r.structured).slice(0, 300)}`, ...meta };
  return { ok: true, decision, error: null, ...meta };
}

// run(opts), and if that ends at the turn limit, one short resumed run for the answer. The result
// carries the summed time, cost and turns, and wrappedUp: true when the answer came from the
// wrap-up. `run` is runHeadless or a test fake.
// opts.deadlineMs (an epoch time), when given, also caps the wrap-up: the gate's hook timeout and
// the builder's 10-minute Bash call for `decide` end the whole thing, wrap-up included.
export async function runWithWrapUp(run, opts) {
  const first = await run(opts);
  if (!hitTurnLimit(first)) return first;
  const left = Number.isFinite(opts.deadlineMs) ? Math.max(20000, opts.deadlineMs - Date.now()) : Infinity;
  const second = await run({ ...opts, prompt: WRAP_UP_PROMPT, args: wrapUpArgs(opts.args, first.sessionId), timeoutMs: Math.min(opts.timeoutMs || 300000, 300000, left) });
  const add = (a, b) => (typeof a === "number" || typeof b === "number" ? (a || 0) + (b || 0) : null);
  const totals = { durationMs: (first.durationMs || 0) + (second.durationMs || 0), costUsd: add(first.costUsd, second.costUsd), numTurns: add(first.numTurns, second.numTurns) };
  if (second.ok) return { ...second, ...totals, wrappedUp: true };
  return { ...first, ...totals, wrappedUp: false, error: `${first.error}; the wrap-up also failed: ${second.error}` };
}
