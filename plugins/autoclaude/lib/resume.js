// Resuming a paused run (D33), shared by `autoclaude resume`, `autoclaude answer` and the
// supervisor's automatic resume after a weekly usage reset. Node built-ins only.
//
// Resume re-baselines on the plan as the owner left it: the owner's ticks are the new record, a
// failed [!] or blocked [?] step goes back to [ ] with fresh attempts, and the run continues at
// the first unfinished step in plan order. Returns the list of changes, for the owner to read.
import path from "node:path";
import { readText, writeFileAtomic } from "./fsatomic.js";
import { parsePlan, setMarker, firstUnfinished, MARKERS } from "./plan.js";
import { updateState, STATUS } from "./state.js";

export function resumeRun(project, state, extra = {}) {
  const { root, config } = project;
  const planFile = path.join(root, config.plan);
  let text = readText(planFile, "");
  let parsed = parsePlan(text);
  const changes = [];
  for (const s of parsed.steps) {
    if (s.marker === MARKERS.failed || s.marker === MARKERS.blocked) {
      text = setMarker(text, s.id, MARKERS.todo);
      changes.push(`${s.id}: [${s.marker}] reset to [ ] with fresh attempts`);
    }
  }
  if (changes.length) writeFileAtomic(planFile, text);
  parsed = parsePlan(text);
  const ticked = parsed.steps.filter((s) => s.marker === MARKERS.done).map((s) => s.id);
  const before = new Set(state.tickedByGate || []);
  for (const id of ticked) if (!before.has(id)) changes.push(`${id}: ticked by the owner, accepted as done`);
  for (const id of before) if (!ticked.includes(id)) changes.push(`${id}: unticked by the owner, will be done again`);
  const current = firstUnfinished(parsed);
  const id = current ? current.id : null;
  if (id !== (state.currentStep || null)) changes.push(`current step is now ${id || "none (every step is done)"}`);
  updateState(root, (s) => {
    s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.recoveries = 0; s.noProgress = 0;
    s.tickedByGate = ticked;
    s.currentStep = id;
    if (id) { s.attempts = { ...s.attempts, [id]: 0 }; s.infraFailures = { ...(s.infraFailures || {}), [id]: 0 }; }
    Object.assign(s, extra);
  });
  return changes;
}
