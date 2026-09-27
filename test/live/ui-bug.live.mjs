// Live scenario for PLAN.md P4.5 and CHECKPOINT 4: the real gate, the real dev server and the
// real browser tester (a headless `claude -p` with Playwright MCP), with a scripted builder.
// The fixture ships the page with its input's id changed, so the unit tests pass but adding a
// todo in the browser does nothing. Expected: attempt 1 fails in the tester with evidence; the
// one-line fix is applied the way a builder would; attempt 2 passes and the phase-end bug bash
// runs. Uses real Claude quota (Sonnet, a few minutes). Not part of `npm test`.
//   node test/live/ui-bug.live.mjs [destination folder]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { saveState, loadState, defaultState } from "../../plugins/autoclaude/lib/state.js";
import { writeReady } from "../../plugins/autoclaude/lib/protocol.js";
import { playwrightMcpConfig } from "../../plugins/autoclaude/lib/init.js";
import { stopDevServer } from "../../plugins/autoclaude/lib/devserver.js";
import { writeJsonAtomic } from "../../plugins/autoclaude/lib/fsatomic.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const dest = path.resolve(process.argv[2] || path.join(here, "..", "..", "spikes", "out", "ui-bug-live"));
const nodeDir = path.dirname(process.execPath);
const env = gitEnv({ ...process.env, PATH: `${nodeDir}${path.delimiter}${process.env.PATH || ""}` });
const log = (s) => console.log(`${new Date().toISOString().slice(11, 19)} ${s}`);
const sent = [];
const deps = { root: dest, env, notify: async (m) => { sent.push(m); return { ok: true }; } };
let exitCode = 1;

try {
  log(`preparing ${dest}`);
  prepareFixture({ dest, plan: "ui-bug", git: true, env });
  writeJsonAtomic(path.join(dest, ".autoclaude", "mcp.playwright.json"), playwrightMcpConfig());
  saveState(dest, { ...defaultState(), status: "running", currentStep: "S1.1", tickedByGate: [], startedAt: new Date().toISOString() });

  log("attempt 1: the page is broken; expecting the browser tester to fail it");
  writeReady(dest, "S1.1");
  let r = await runGate({ cwd: dest, hook_event_name: "Stop" }, deps);
  log(`gate: ${r.decision}; events: ${r.events.map((e) => e.type + (e.status ? `=${e.status}` : "")).join(", ")}`);
  console.log("----- reason sent to the builder -----\n" + (r.reason || "(none)") + "\n--------------------------------------");
  const first = r.events.find((e) => e.type === "tester");
  if (!first || first.status !== "failed") throw new Error(`expected the tester to fail attempt 1, got ${first ? first.status : "no tester run"}`);

  log("applying the builder's fix: the input id the script reads");
  const page = path.join(dest, "public", "index.html");
  fs.writeFileSync(page, fs.readFileSync(page, "utf8").replace('id="txt"', 'id="text"'));

  log("attempt 2: expecting the tester to pass, then the phase-end bug bash");
  writeReady(dest, "S1.1");
  r = await runGate({ cwd: dest, hook_event_name: "Stop" }, deps);
  log(`gate: ${r.decision}; events: ${r.events.map((e) => e.type + (e.status ? `=${e.status}` : "")).join(", ")}`);
  if (r.reason) console.log("----- reason sent to the builder -----\n" + r.reason + "\n--------------------------------------");
  const state = loadState(dest);
  log(`state: ${state.status}${state.pauseReason ? ` (${state.pauseReason})` : ""}; attempts ${JSON.stringify(state.attempts)}`);
  const reports = fs.readdirSync(path.join(dest, ".autoclaude", "reports"));
  log(`reports: ${reports.join(", ")}`);
  for (const n of sent) log(`notification: [${n.priority}] ${n.title}`);
  if (state.status !== "complete") throw new Error(`expected the plan to complete on attempt 2, got ${state.status}`);
  log("PASS: the tester caught the UI bug, the fix passed, the bug bash ran, the plan completed");
  exitCode = 0;
} catch (e) {
  log(`FAIL: ${e.message}`);
} finally {
  try { stopDevServer({ root: dest }); } catch {}
  process.exitCode = exitCode;
}
