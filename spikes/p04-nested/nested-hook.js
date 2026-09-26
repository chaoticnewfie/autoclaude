// P0.4 spike: a Stop hook that spawns nested headless `claude -p` runs with a
// JSON schema, three ways, and records what came back. Always allows the stop.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });

// Recursion guard: a nested run must never spawn further nested runs.
if (process.env.SPIKE_NESTED_DEPTH) {
  fs.appendFileSync(path.join(outDir, "recursion.log"), new Date().toISOString() + " nested hook fired inside a nested run (hooks were NOT disabled)\n");
  process.exit(0);
}

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}

const home = process.env.USERPROFILE || process.env.HOME;
const claude = path.join(home, ".local", "bin", "claude.exe");
const schema = JSON.stringify({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    note: { type: "string" }
  },
  required: ["verdict", "note"]
});
const prompt = "Return verdict pass, and a one-sentence note that names the model you are running as.";

function run(label, envMode, extraArgs) {
  const env = { ...process.env };
  if (envMode === "stripped") {
    for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
  }
  env.SPIKE_NESTED_DEPTH = "1";
  env.PATH = "C:\\Program Files\\nodejs;" + path.join(home, ".local", "bin") + ";" + (env.PATH || "");
  const args = ["-p", prompt, "--output-format", "json", "--json-schema", schema, "--model", "sonnet", ...extraArgs];
  const t0 = Date.now();
  const r = spawnSync(claude, args, { env, encoding: "utf8", timeout: 180000, cwd: __dirname, windowsHide: true });
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch {}
  return {
    label, envMode, extraArgs,
    ms: Date.now() - t0,
    status: r.status,
    spawn_error: r.error ? r.error.message : null,
    stderr_head: (r.stderr || "").slice(0, 400),
    stdout_head: parsed ? null : (r.stdout || "").slice(0, 300),
    is_error: parsed ? parsed.is_error : null,
    structured_output: parsed ? parsed.structured_output : null,
    models: parsed && parsed.modelUsage ? Object.keys(parsed.modelUsage) : null,
    session_id: parsed ? parsed.session_id : null
  };
}

const results = [];
results.push(run("settings-disableAllHooks", "inherited", ["--settings", JSON.stringify({ disableAllHooks: true })]));
results.push(run("settings-disableAllHooks", "stripped", ["--settings", JSON.stringify({ disableAllHooks: true })]));
results.push(run("bare", "stripped", ["--bare"]));
results.push({ outer_hook_env: { CLAUDECODE: process.env.CLAUDECODE, CLAUDE_CODE_ENTRYPOINT: process.env.CLAUDE_CODE_ENTRYPOINT, api_key_present: !!process.env.ANTHROPIC_API_KEY }, outer_stdin_length: raw.length });
fs.writeFileSync(path.join(outDir, "nested-results.json"), JSON.stringify(results, null, 2));
process.exit(0);
