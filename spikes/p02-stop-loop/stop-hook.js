// P0.2 spike: a Stop hook that blocks N times and records everything it is given.
// Modes (SPIKE_MODE): tool3 (block 3x, ask for a tool call each time),
// tool10 (block 10x with tool calls), notool10 (block 10x, no tool calls),
// sleep (block 3x, and on call 2 sleep 300 s to test the hook timeout).
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
const mode = process.env.SPIKE_MODE || "tool3";
const counterFile = path.join(outDir, "counter-" + mode + ".txt");
let n = 0;
try { n = parseInt(fs.readFileSync(counterFile, "utf8"), 10) || 0; } catch {}
n += 1;
fs.writeFileSync(counterFile, String(n));

let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = null;
try { input = JSON.parse(raw); } catch {}

let parentImage = null;
try {
  parentImage = execSync("tasklist /FI \"PID eq " + process.ppid + "\" /FO CSV /NH", { encoding: "utf8" }).trim();
} catch (e) { parentImage = "tasklist failed: " + e.message; }

const record = {
  call: n,
  mode,
  at: new Date().toISOString(),
  stop_hook_active: input ? input.stop_hook_active : undefined,
  input_keys: input ? Object.keys(input) : null,
  has_last_assistant_message: !!(input && input.last_assistant_message),
  last_assistant_message_preview: input && typeof input.last_assistant_message === "string" ? input.last_assistant_message.slice(0, 160) : null,
  transcript_path: input ? input.transcript_path : null,
  session_id: input ? input.session_id : null,
  raw_length: raw.length,
  shell_env: {
    ComSpec: process.env.ComSpec,
    SHELL: process.env.SHELL,
    MSYSTEM: process.env.MSYSTEM,
    PSModulePath_present: !!process.env.PSModulePath,
    ppid: process.ppid,
    parent_image: parentImage,
    cwd: process.cwd(),
    execPath: process.execPath
  }
};
fs.appendFileSync(path.join(outDir, "stop-calls-" + mode + ".jsonl"), JSON.stringify(record) + "\n");

if (mode === "sleep" && n === 2) {
  // Sleep 300 s without burning CPU.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300000);
  fs.appendFileSync(path.join(outDir, "stop-calls-" + mode + ".jsonl"), JSON.stringify({ call: n, slept_ms: 300000, at: new Date().toISOString() }) + "\n");
}

const limits = { tool3: 3, tool10: 10, notool10: 10, sleep: 3 };
const limit = limits[mode] || 3;
if (n <= limit) {
  let reason;
  if (mode === "notool10") {
    reason = "Blocked by the spike stop hook (call " + n + " of " + limit + "). Do not use any tool. Reply with the single word AGAIN and then stop.";
  } else {
    reason = "Blocked by the spike stop hook (call " + n + " of " + limit + "). Use the Bash tool to run exactly this command: echo tick " + n + " . Then stop.";
  }
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
}
process.exit(0);
