// Headless `claude -p` runs for the gate's independent checkers: the browser tester, the bug
// bash (Phase 4) and the security reviewer (Phase 5). Each run is a separate process with a
// fresh context, hooks disabled, no permission prompts, a narrow tool list and a JSON-schema
// verdict. Flags verified on Windows in Phase 0 (VERIFY.md P0.4 and P0.5): the prompt goes in on
// stdin, `--settings '{"disableAllHooks":true}'` (never `--bare`, which breaks subscription
// auth), `--output-format json` with `--json-schema` returns `structured_output`.
// Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { homeDir, isWindows } from "./paths.js";
import { findOnPath, killTree } from "./proc.js";

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
  const base = { ok: false, infra: true, structured: null, output: null, costUsd: null, numTurns: null, sessionId: null, denials: [], durationMs, timedOut, code };
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
      child = spawn(exe, [...binArgs, ...args], { cwd, env: { ...env, AUTOCLAUDE_ROLE: role }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
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
