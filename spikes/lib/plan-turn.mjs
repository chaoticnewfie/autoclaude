// One turn of a headless planning conversation for the Phase 8 practice run (PLAN.md P8.9).
// The plan skill asks its rounds as numbered text when AskUserQuestion is unavailable and waits;
// here the owner's answers arrive as the next turn, through --resume.
//
//   node spikes/lib/plan-turn.mjs new <message file>
//   node spikes/lib/plan-turn.mjs next <message file>
//
// Runs the native claude.exe in spikes/out/todo-live with every CLAUDE* variable stripped, node,
// git and the autoclaude shim on PATH, and auto permission mode. Writes each reply to
// spikes/out/practice/turn-<n>.md and keeps the session id in spikes/out/practice/session.txt.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [mode, msgFile] = process.argv.slice(2);
if (!["new", "next"].includes(mode) || !msgFile) {
  console.error("usage: plan-turn.mjs new|next <message file>");
  process.exit(2);
}
const project = "C:/AutoClaude/spikes/out/todo-live";
const out = "C:/AutoClaude/spikes/out/practice";
fs.mkdirSync(out, { recursive: true });
const sessionFile = path.join(out, "session.txt");

const env = { ...process.env };
for (const k of Object.keys(env)) if (k === "CLAUDECODE" || k.startsWith("CLAUDE_")) delete env[k];
const home = os.homedir();
const bin = path.join(home, ".local", "bin");
const acBin = path.join(process.env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "autoclaude", "bin");
env.PATH = ["C:\\Program Files\\nodejs", "C:\\Program Files\\Git\\cmd", bin, acBin, env.PATH || ""].join(";");

const message = fs.readFileSync(msgFile, "utf8");
const args = ["-p", "--output-format", "json", "--model", "opus", "--permission-mode", "auto"];
if (mode === "next") args.push("--resume", fs.readFileSync(sessionFile, "utf8").trim());
args.push(message);

const started = Date.now();
const r = spawnSync(path.join(bin, "claude.exe"), args, { cwd: project, env, encoding: "utf8", windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 45 * 60 * 1000 });
const minutes = ((Date.now() - started) / 60000).toFixed(1);
let reply;
try {
  reply = JSON.parse(r.stdout);
} catch {
  console.error(`no JSON from claude (exit ${r.status}, ${minutes} min):\n${(r.stdout || "").slice(-2000)}\n${(r.stderr || "").slice(-2000)}`);
  process.exit(1);
}
if (reply.session_id) fs.writeFileSync(sessionFile, reply.session_id + "\n");
const n = fs.readdirSync(out).filter((f) => /^turn-\d+\.md$/.test(f)).length + 1;
const text = String(reply.result || "");
fs.writeFileSync(path.join(out, `turn-${n}.md`), `<!-- ${minutes} min, ${reply.num_turns} turns, error: ${!!reply.is_error} -->\n\n## Owner\n\n${message}\n\n## Claude\n\n${text}\n`);
console.log(`turn ${n}: ${minutes} min, ${reply.num_turns} turns, error ${!!reply.is_error}\n`);
console.log(text);
