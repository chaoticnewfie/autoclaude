// Runs the native claude.exe with every CLAUDE* environment variable stripped
// (so a run started from inside a Claude Code session is not treated as nested)
// and with node and the native CLI on PATH. Passes all arguments through.
import { spawn } from "node:child_process";
import path from "node:path";

const env = { ...process.env };
for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
const home = process.env.USERPROFILE || process.env.HOME;
const bin = path.join(home, ".local", "bin");
env.PATH = "C:\\Program Files\\nodejs;" + bin + ";" + (env.PATH || "");
const claude = path.join(bin, "claude.exe");

const child = spawn(claude, process.argv.slice(2), { stdio: "inherit", env, windowsHide: true });
child.on("exit", (code, signal) => process.exit(code == null ? 1 : code));
child.on("error", (e) => { console.error("spawn failed: " + e.message); process.exit(1); });
