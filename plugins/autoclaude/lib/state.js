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
    tickedByGate: [],
    baseCommit: null,
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
  if (state.status === STATUS.running && state.pauseRequested) return "running, pause requested after the next verified commit";
  return state.status;
}
