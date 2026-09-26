// PreToolUse hook for AskUserQuestion: log and deny with guidance.
const fs = require("fs");
const path = require("path");
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = null;
try { input = JSON.parse(raw); } catch {}
fs.appendFileSync(path.join(outDir, "hooks.jsonl"), JSON.stringify({ event: "PreToolUse", at: new Date().toISOString(), input }) + "\n");
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: "SPIKE: AskUserQuestion is disabled while AutoClaude runs. Decide yourself, say ASK-DENIED-HANDLED, and wait."
  }
}));
process.exit(0);
