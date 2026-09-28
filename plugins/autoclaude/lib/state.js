// .autoclaude/state.json: the run state every hook and the supervisor read.
// PLAN.md sections 4.3 and 4.8.3. Node built-ins only. All writes are atomic.
import { readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { projectPaths } from "./paths.js";

export const STATUS = Object.freeze({ idle: "idle", running: "running", paused: "paused", complete: "complete" });
// Every pauseReason the gate, the CLI and the supervisor set.
export const PAUSE_REASONS = Object.freeze(["review", "blocked", "step-failed", "security", "stuck", "infra", "commit-failed", "weekly-limit"]);

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
    uncommitted: [],
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
