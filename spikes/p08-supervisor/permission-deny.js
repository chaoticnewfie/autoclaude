// PermissionRequest hook: log the request and deny it with guidance.
const fs = require("fs");
const path = require("path");
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = null;
try { input = JSON.parse(raw); } catch {}
fs.appendFileSync(path.join(outDir, "hooks.jsonl"), JSON.stringify({ event: "PermissionRequest", at: new Date().toISOString(), input }) + "\n");
process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message: "SPIKE: no human is available to approve this. Do not retry it; say PERMISSION-DENIED-HANDLED and wait." }
  }
}));
process.exit(0);
