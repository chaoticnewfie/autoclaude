// Watches an AutoClaude run's state for the practice run (PLAN.md P8.9): logs every change of
// status, current step, pause reason or fix-up pass, with the time, to <out>/timeline.log, and
// exits when the run pauses or completes (or after the given hours).
//   node spikes/lib/watch-run.mjs <project> <out folder> [hours]
import fs from "node:fs";
import path from "node:path";

const [project, out, hours = "6"] = process.argv.slice(2);
const file = path.join(project, ".autoclaude", "state.json");
const log = path.join(out, "timeline.log");
const until = Date.now() + Number(hours) * 3600 * 1000;
let last = "";
const read = () => { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } };
while (Date.now() < until) {
  const s = read();
  if (s) {
    const key = [s.status, s.currentStep, s.pauseReason, s.fixup ? `fixup:${s.fixup.stepId}` : "", s.completing ? "completing" : "", s.freshSession ? "fresh" : ""].join(" | ");
    if (key !== last) {
      fs.appendFileSync(log, `${new Date().toISOString()} ${key}\n`);
      console.log(`${new Date().toISOString()} ${key}`);
      last = key;
    }
    if (s.status === "paused" || s.status === "complete") process.exit(0);
  }
  await new Promise((r) => setTimeout(r, 20000));
}
console.log("watch timed out");
