// Logs every hook invocation (event name from argv, stdin JSON) to out/hooks.jsonl.
const fs = require("fs");
const path = require("path");
const outDir = path.join(__dirname, "out");
fs.mkdirSync(outDir, { recursive: true });
let raw = "";
try { raw = fs.readFileSync(0, "utf8"); } catch {}
let input = null;
try { input = JSON.parse(raw); } catch {}
const record = { event: process.argv[2] || "?", at: new Date().toISOString(), input };
fs.appendFileSync(path.join(outDir, "hooks.jsonl"), JSON.stringify(record) + "\n");
process.exit(0);
