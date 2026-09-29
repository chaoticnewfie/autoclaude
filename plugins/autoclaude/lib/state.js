// .autoclaude/state.json: the run state every hook and the supervisor read.
// PLAN.md sections 4.3 and 4.8.3. Node built-ins only. All writes are atomic.
import { readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { projectPaths } from "./paths.js";

export const STATUS = Object.freeze({ idle: "idle", running: "running", paused: "paused", complete: "complete" });
// Every pauseReason the gate, the CLI and the supervisor set.
// "out-of-time": a verification that does not fit in one stop, twice for the same step.
export const PAUSE_REASONS = Object.freeze(["review", "blocked", "step-failed", "security", "stuck", "infra", "out-of-time", "commit-failed", "weekly-limit"]);

export function defaultState() {
  return {
    version: 1,
    status: STATUS.idle,
    pauseReason: null,
    pauseRequested: false,
    pendingNotes: [],
    currentStep: null,
    attempts: {},
    infraFailures: {},
    // Per step: verifications that ran out of the gate's time (a check or checker stopped at
    // its deadline, or the whole gate cut off by the hook's timeout). The second one pauses.
    outOfTime: {},
    uncommitted: [],
    // The gate's commit message for each step in `uncommitted`, so `autoclaude resume` commits
    // it with the body the gate wrote.
    uncommittedMessages: {},
    noProgress: 0,
    recoveries: 0,
    toolCallsAtLastGate: 0,
    headAtLastGate: null,
    stepStartedAt: null,
    startedAt: null,
    windowTitle: null,
    supervisorPid: null,
    sessionId: null,
    // The UUID the supervisor gave the builder session, so hooks can tell it from other sessions.
    builderSessionId: null,
    // Set by `pause --now`; the supervisor ends the builder session and clears it.
    haltSession: false,
    // Steps the gate marked [x] or [~]; any other tick is reverted by the integrity check.
    tickedByGate: [],
    baseCommit: null,
    // The fix-up pass of a verified feature with non-blocking findings (D49):
    // { phase, stepId, findings: [...], attempt, report, checks }. The next ready runs the checks
    // only, then closes the feature.
    fixup: null,
    // A verified step or feature on its way into a commit: { verifyId, stepId, scope, attempt,
    // timings, findings, report, feature, phaseEnd, fixupDone, headBefore, tree, undo, pid, at }.
    // Recorded with the ticks before the verification's snapshot goes, so a gate cut off during
    // the commit, the tag or the push is finished by the next stop instead of verified again.
    // tree is the verified tree (git write-tree); a next stop that finds other files verifies
    // again instead, taking the verification out with undo ({ ticked, markers, added,
    // progressCreated, rows }; none after a fix-up pass, which goes back to that pass).
    closing: null,
    // The plan is complete and the gate is finishing the run (machine footprint, hand-back,
    // its commit and push, the alert): { at, footprintDone, footprint, handoffDone, handoff,
    // headBefore, committed, pushWanted, pushed, pushState }. The run is marked complete only
    // once that is done.
    completing: null,
    // Set by the gate after a verified feature when a supervisor is live; the supervisor ends the
    // builder, clears it, and starts a fresh session for the next feature.
    freshSession: false,
    // The commit the current feature started from (verifyAt "phase"): the security review's
    // diff base, cleared when the feature closes.
    phaseBaseCommit: null,
    // When the current feature's first step started, for the feature alert's "took" time.
    phaseStartedAt: null,
    // The last push of the run branch: { branch, remote, ok, skipped, at, error,
    // unpushedCommits, unpushedTags }, or null when the gate has not pushed.
    pushState: null,
    // Where the decisions log stood when the run started ({ D, N }, the highest numbers), so
    // the hand-back counts only this run's entries (lib/summary.js).
    decisionsAtStart: null,
    ownerAnswer: null,
    lastBlockedQuestion: null,
    usageStaleWarned: false,
    updatedAt: null
  };
}

// Missing file -> defaults. Unknown keys are kept; missing keys are filled in.
export function loadState(root) {
  const p = projectPaths(root);
  let stored = null;
  try {
    stored = readJson(p.stateFile, null);
  } catch {
    stored = null; // a half-written or corrupt file counts as no state; the gate will not run on garbage
  }
  return { ...defaultState(), ...(stored && typeof stored === "object" ? stored : {}) };
}

export function saveState(root, state) {
  const p = projectPaths(root);
  ensureDir(p.runtimeDir);
  const next = { ...state, updatedAt: new Date().toISOString() };
  writeJsonAtomic(p.stateFile, next);
  return next;
}

// Load, mutate in place (or return a replacement), save. Returns the saved state.
export function updateState(root, mutate) {
  const state = loadState(root);
  const replaced = mutate(state);
  return saveState(root, replaced && typeof replaced === "object" ? replaced : state);
}

export function isRunning(state) {
  return state && state.status === STATUS.running;
}

export function describeState(state) {
  if (!state) return "unknown";
  if (state.status === STATUS.paused) return `paused (${state.pauseReason || "no reason recorded"})`;
  if (state.status === STATUS.running && state.pauseRequested) return "running, pause requested after the next committed step";
  return state.status;
}
