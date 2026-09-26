// Opens a new, detached console window on Windows and runs a command in it.
// Usage: node open-window.mjs <title> <cwd> <program> [args...]
// This is the mechanism `autoclaude run` will use (lib/proc.js). Node built-ins only.
import { spawn } from "node:child_process";

const [title, cwd, ...cmd] = process.argv.slice(2);
if (!title || !cwd || cmd.length === 0) {
  console.error("usage: node open-window.mjs <title> <cwd> <program> [args...]");
  process.exit(2);
}
const q = (s) => (/[\s"&|<>^]/.test(s) ? "\"" + s.replace(/"/g, "\\\"") + "\"" : s);
const line = ["start", JSON.stringify(title), "/D", q(cwd), ...cmd.map(q)].join(" ");
const child = spawn("cmd.exe", ["/d", "/s", "/c", "\"" + line + "\""], {
  detached: true,
  stdio: "ignore",
  windowsVerbatimArguments: true,
  windowsHide: true
});
child.on("error", (e) => { console.error("launch failed: " + e.message); process.exit(1); });
child.unref();
console.log("launched via cmd pid " + child.pid + ": " + line);
