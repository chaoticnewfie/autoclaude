// Resuming a paused run (D33), shared by `autoclaude resume`, `autoclaude answer` and the
// supervisor's automatic resume after a weekly usage reset. Node built-ins only.
//
// Resume re-baselines on the plan as the owner left it: the owner's ticks are the new record, a
// failed [!] or blocked [?] step goes back to [ ] with fresh attempts, a built [~] step stays
// built (its feature verifies it), and the run continues at the first unfinished step in plan
// order. A feature paused in its fix-up pass resumes in that pass. Returns the list of changes,
// for the owner to read.
import path from "node:path";
import { readText, readJson, writeFileAtomic, removeIfExists } from "./fsatomic.js";
import { parsePlan, setMarker, stepById, firstUnfinished, isFinished, isPhaseEnd, reopenUnverified, MARKERS } from "./plan.js";
import { updateState, STATUS } from "./state.js";
import { projectPaths } from "./paths.js";
import { isPidAlive } from "./proc.js";
import * as git from "./git.js";
import { liveSupervisorPid } from "./builder.js";

// The plan and PROGRESS.md as they were before a verification wrote its ticks (lib/gate.js):
// { step, plan, progress, ticked: [ids], added: "<the PROGRESS lines it appended>" }. It stays
// on disk while the checks run and goes once the verification has an outcome.
export function pendingVerifyFile(root) {
  return path.join(projectPaths(root).runtimeDir, "verify-pending.json");
}

// Whether a gate process is at work in the project right now (scripts/stop-gate.js keeps
// .autoclaude/gate.json with its pid while it runs).
export function gateRunning(root) {
  try {
    const j = readJson(path.join(projectPaths(root).runtimeDir, "gate.json"), null);
    return !!(j && j.pid && isPidAlive(j.pid));
  } catch {
    return false;
  }
}

// Undoes a verification that was cut off (the hook's timeout, `pause --now` ending the session
// and its gate, a crash): the ticks it wrote come out and its PROGRESS lines go, and nothing
// else, so edits the owner made during a pause stay. Left to a gate that is still alive when
// unlessGateRunning is set. Returns { step, ids } or null when there was nothing to undo.
export function undoCutVerification(root, config, { unlessGateRunning = false } = {}) {
  const file = pendingVerifyFile(root);
  let snap;
  try { snap = readJson(file, null); } catch { snap = {}; }
  if (!snap) return null;
  if (unlessGateRunning && gateRunning(root)) return null;
  const ids = [];
  if (typeof snap.plan === "string") {
    const planFile = path.join(root, config.plan);
    let text = readText(planFile, null);
    if (text !== null) {
      const before = parsePlan(snap.plan);
      const now = parsePlan(text);
      // A snapshot that does not list its ticks: every step it did not have as done.
      const wrote = Array.isArray(snap.ticked) ? snap.ticked : before.steps.filter((s) => s.marker !== MARKERS.done).map((s) => s.id);
      for (const id of wrote) {
        const cur = stepById(now, id);
        const old = stepById(before, id);
        if (cur && old && cur.marker === MARKERS.done && old.marker !== MARKERS.done) { text = setMarker(text, id, old.marker); ids.push(id); }
      }
      if (ids.length) writeFileAtomic(planFile, text);
    }
  }
  const progressFile = path.join(root, config.docs.progress);
  const cur = readText(progressFile, null);
  if (cur !== null) {
    let next = cur;
    if (typeof snap.added === "string" && snap.added) {
      const i = cur.lastIndexOf(snap.added);
      if (i >= 0) next = cur.slice(0, i) + cur.slice(i + snap.added.length);
    } else if (typeof snap.progress === "string" && cur.startsWith(snap.progress)) {
      next = snap.progress;
    }
    // The verification created the file: it goes again.
    if (next === "" && (snap.progress === null || snap.progress === undefined)) removeIfExists(progressFile);
    else if (next !== cur) writeFileAtomic(progressFile, next);
  }
  removeIfExists(file);
  return { step: snap.step || null, ids };
}

// Steps that passed verification (or were built) but could not be committed (the gate paused
// the run as "commit-failed"). Commits them in one commit, tags a phase end the way the gate
// would have, and leaves that tag for the next push. Returns { ok, ids, sha, error }.
export async function commitPending(project, state, { env } = {}) {
  const ids = state.uncommitted || [];
  if (!ids.length) return { ok: true, ids: [], sha: null, error: null };
  const parsed = parsePlan(readText(path.join(project.root, project.config.plan), ""));
  const titles = ids.map((id) => { const s = parsed.steps.find((x) => x.id === id); return s ? s.title : id; });
  const c = await git.commitAll(project.root, `autoclaude(${ids.join(", ")}): ${titles.join("; ")}\n\nCommitted by \`autoclaude resume\`: the gate had verified or built ${ids.join(", ")}, but its own commit failed.`, { env });
  if (!c.ok) return { ok: false, ids, sha: null, error: String(c.stderr || "").trim() || "unknown error" };
  const tags = [];
  const cfgGit = project.config.git || {};
  for (const id of ids) {
    const s = parsed.steps.find((x) => x.id === id);
    if (!s || !s.phase || s.marker !== MARKERS.done || !isPhaseEnd(parsed, id) || cfgGit.tagPhaseEnds === false) continue;
    const name = `ac-phase-${s.phase.num}`;
    // As in the gate: with pushes on, a phase verified before keeps its first tag.
    if (cfgGit.push && (await git.tagExists(project.root, name, { env }))) continue;
    if ((await git.tag(project.root, name, { force: true, env })).ok) tags.push(name);
  }
  updateState(project.root, (s) => {
    s.uncommitted = []; s.headAtLastGate = c.sha || s.headAtLastGate;
    if (tags.length && cfgGit.push) {
      const prev = s.pushState || {};
      s.pushState = { ...prev, unpushedTags: [...new Set([...(prev.unpushedTags || []), ...tags])] };
    }
  });
  return { ok: true, ids, sha: c.sha, error: null };
}

export function resumeRun(project, state, extra = {}) {
  const { root, config } = project;
  const planFile = path.join(root, config.plan);
  const changes = [];
  // First the leftovers of a verification that was cut off, or its ticks would read as the
  // owner's and its feature would be skipped.
  const cut = undoCutVerification(root, config, { unlessGateRunning: true });
  if (cut) changes.push(`the verification of ${cut.step || "the last step"} was cut off; its plan ticks and PROGRESS lines were taken out again`);
  let text = readText(planFile, "");
  let parsed = parsePlan(text);
  let edited = false;
  for (const s of parsed.steps) {
    if (s.marker === MARKERS.failed || s.marker === MARKERS.blocked) {
      text = setMarker(text, s.id, MARKERS.todo);
      edited = true;
      changes.push(`${s.id}: [${s.marker}] reset to [ ] with fresh attempts`);
    }
  }
  // Built steps no verification would reach any more (the owner ticked the step that closes
  // their feature, or verifyAt changed to "step") are reopened, so no step stays unverified.
  const mode = config.gate && config.gate.verifyAt === "step" ? "step" : "phase";
  const reopen = reopenUnverified(text, mode);
  if (reopen.reopened.length) {
    text = reopen.text;
    edited = true;
    const after = parsePlan(text);
    for (const id of reopen.reopened) {
      const s = stepById(after, id);
      changes.push(mode === "step"
        ? `${id}: reopened; it was built but not verified, and verifyAt is "step", so its ready verifies it`
        : `${id}: reopened; Phase ${s.phase.num} was never verified and its other steps are all done or built, so the ready of ${id} verifies it`);
    }
  }
  if (edited) writeFileAtomic(planFile, text);
  parsed = parsePlan(text);
  // [x] and [~] are both the gate's record; the integrity check accepts exactly this list.
  const ticked = parsed.steps.filter(isFinished).map((s) => s.id);
  const before = new Set(state.tickedByGate || []);
  for (const id of ticked) if (!before.has(id)) changes.push(`${id}: ticked by the owner, accepted as ${parsed.steps.find((s) => s.id === id).marker === MARKERS.built ? "built" : "done"}`);
  for (const id of before) if (!ticked.includes(id) && !reopen.reopened.includes(id)) changes.push(`${id}: unticked by the owner, will be done again`);

  // A fix-up pass carries on while its feature is still ticked; if the owner unticked any step
  // of that phase, the feature is verified again from scratch instead.
  let fixup = state.fixup && state.fixup.stepId ? state.fixup : null;
  if (fixup) {
    const end = parsed.steps.find((s) => s.id === fixup.stepId);
    const intact = end && end.marker === MARKERS.done && (!end.phase || end.phase.steps.every((s) => s.marker === MARKERS.done));
    if (!intact) { changes.push(`the fix-up pass of ${fixup.stepId} is dropped: its phase is no longer ticked, so it is verified again`); fixup = null; }
  }
  const current = fixup ? parsed.steps.find((s) => s.id === fixup.stepId) : firstUnfinished(parsed);
  const id = current ? current.id : null;
  if (fixup) changes.push(`resuming the fix-up pass of ${id}: fix or hand over each finding, then ready ${id}`);
  else if (id !== (state.currentStep || null)) changes.push(`current step is now ${id || "none (every step is done)"}`);
  // A pause at a feature's end (review, weekly limit) leaves the old builder session behind: the
  // next feature still gets a fresh one (D49), from a live supervisor only, since without one
  // nothing would start it. An answered question carries on in the session that asked it.
  const boundary = !fixup && current && current.phase && current.phase.steps.every((s) => !isFinished(s));
  const fresh = !!(boundary && state.pauseReason !== "blocked" && liveSupervisorPid(root));
  if (fresh) changes.push(`${id} starts a new feature, so the supervisor opens a fresh builder session for it`);
  // With nothing built and no fix-up pass, no feature is under way: a base or start time left
  // behind (a gate cut off at the wrong moment) would stretch the next feature's review.
  const underWay = !!fixup || parsed.steps.some((s) => s.marker === MARKERS.built);
  updateState(root, (s) => {
    s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.recoveries = 0; s.noProgress = 0;
    // A `pause --now` the supervisor had not acted on yet must not end the resumed session later.
    s.haltSession = false;
    // A fresh-session request from before the pause is spent; a new feature asks again.
    s.freshSession = fresh;
    s.tickedByGate = ticked;
    s.currentStep = id;
    s.fixup = fixup;
    if (!underWay) { s.phaseBaseCommit = null; s.phaseStartedAt = null; }
    if (id) { s.attempts = { ...s.attempts, [id]: 0 }; s.infraFailures = { ...(s.infraFailures || {}), [id]: 0 }; }
    Object.assign(s, extra);
  });
  return changes;
}
