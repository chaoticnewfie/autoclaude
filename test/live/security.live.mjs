// Live check for PLAN.md P5.4: the real security reviewer (a headless `claude -p` on the opus
// alias, read-only tools, no MCP) reviews a fixture step that adds an obviously flawed file: a
// hardcoded live-looking API key and a SQL query built by string concatenation from a request
// parameter. The file is new and uncommitted, so it reaches the reviewer through the untracked
// list, not the diff. Expected: status "failed" with a high finding naming lib/search.js.
// Uses real Claude quota (one Opus run, a few minutes). Not part of `npm test`.
//   node test/live/security.live.mjs [destination folder]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";
import { runSecurityReview } from "../../plugins/autoclaude/lib/security.js";
import { parsePlan, stepById } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import * as git from "../../plugins/autoclaude/lib/git.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(process.argv[2] || path.join(here, "..", "..", "spikes", "out", "security-live"));
const nodeDir = path.dirname(process.execPath);
const env = gitEnv({ ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ""}` });
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
let exitCode = 1;

// Assembled at runtime so this source file never holds a string that looks like a live key.
const fakeKey = ["sk", "live", "51Qx7AutoClaudeFixtureNotARealKey9"].join("_");
const flawed = [
  "// Text search over the todos, used by GET /api/search?q=...",
  `const API_KEY = "${fakeKey}";`,
  "",
  "export async function searchTodos(db, req) {",
  "  const url = new URL(req.url, \"http://localhost\");",
  "  const q = url.searchParams.get(\"q\") || \"\";",
  "  const sql = \"SELECT id, text, done FROM todos WHERE text LIKE '%\" + q + \"%'\";",
  "  const rows = await db.query(sql, { apiKey: API_KEY });",
  "  return rows;",
  "}",
  ""
].join("\n");

try {
  log(`preparing ${dest}`);
  prepareFixture({ dest, plan: "happy", git: true, env });
  fs.writeFileSync(path.join(dest, "lib", "search.js"), flawed);
  const baseCommit = await git.head(dest, { env });
  const parsed = parsePlan(fs.readFileSync(path.join(dest, "PLAN.md"), "utf8"));
  const step = stepById(parsed, "S1.1");
  const config = mergeConfig({});
  log(`running the security reviewer for ${step.id} (model ${config.security.model}, blocks on ${config.security.blockOn}, base ${baseCommit})`);
  const started = Date.now();
  const r = await runSecurityReview({ root: dest, config, step, parsed, state: { baseCommit }, env, attempt: 1 });
  const secs = Math.round((Date.now() - started) / 1000);
  log(`status: ${r.status} after ${secs} s`);
  log(`failed: ${r.failed || "(none)"}`);
  for (const s of r.sections) console.log(`----- ${s.title} -----\n${s.body}\n--------------------------------------`);
  log(`non-blocking findings handed back: ${r.findings.length}; strays: ${r.strays.length ? r.strays.join(", ") : "none"}`);
  const saved = JSON.parse(fs.readFileSync(path.join(dest, r.verdictFile), "utf8"));
  log(`verdict file: ${r.verdictFile}; tries ${saved.tries}; turns ${saved.numTurns}; cost ${saved.costUsd === null ? "n/a" : `$${saved.costUsd.toFixed(4)}`}`);
  if (r.status !== "failed") throw new Error(`expected status failed, got ${r.status}`);
  if (!/high: lib\/search\.js/.test(r.failed)) throw new Error("expected a high finding naming lib/search.js");
  log("PASS: the reviewer caught the flawed file with a high finding");
  exitCode = 0;
} catch (e) {
  log(`FAIL: ${e.message}`);
} finally {
  process.exitCode = exitCode;
}
