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
import { parsePlan, setMarker, stepById, firstUnfinished, isFinished, isPhaseEnd, reopenUnverified, planSlug, MARKERS } from "./plan.js";
import { loadState, updateState, STATUS } from "./state.js";
import { projectPaths } from "./paths.js";
import { isPidAlive } from "./proc.js";
import * as git from "./git.js";
import { liveSupervisorPid } from "./builder.js";

// What a verification wrote before its checks ran (lib/gate.js): { id, step, pid, at, plan,
// progress, ticked: [ids], added: "<the PROGRESS lines it appended>", rows: [{ file, text,
// created }] (the findings rows it filed) }. A fix-up pass writes one with fixup: true and
// nothing to undo, so a pass that is cut off is counted as well. It stays on disk while the
// checks run and goes once the verification has an outcome.
export function pendingVerifyFile(root) {
  return path.join(projectPaths(root).runtimeDir, "verify-pending.json");
}

// The phases whose steps are verified one by one although gate.verifyAt is "phase" (D60:
// `autoclaude verify-per-step <phase>`, gate.stepPhases), as numbers. Read defensively: a config
// without the key, or with something else in it, has none.
export function stepPhaseList(config) {
  const list = config && config.gate && Array.isArray(config.gate.stepPhases) ? config.gate.stepPhases : [];
  return list.map((x) => (typeof x === "number" || (typeof x === "string" && x.trim()) ? Number(x) : NaN)).filter((n) => Number.isInteger(n) && n >= 0);
}

// "step" or "phase": how the steps of phase `num` are verified (any phase when num is null).
export function verifyModeFor(config, num = null) {
  if (config && config.gate && config.gate.verifyAt === "step") return "step";
  return num !== null && num !== undefined && stepPhaseList(config).includes(Number(num)) ? "step" : "phase";
}

// Built [~] steps no verification would reach any more (plan.js reopenUnverified), put back to
// [ ] by the way each phase is verified: every built step of a phase in gate.stepPhases is
// reopened too, so each gets its own ready. Returns { text, reopened: [ids] } in plan order.
export function reopenForMode(text, config) {
  const mode = verifyModeFor(config);
  const first = reopenUnverified(text, mode);
  const phases = mode === "step" ? [] : stepPhaseList(config);
  if (!phases.length) return first;
  let out = first.text;
  for (const ph of parsePlan(out).phases) {
    if (!phases.includes(ph.num)) continue;
    for (const s of ph.steps) if (s.marker === MARKERS.built) out = setMarker(out, s.id, MARKERS.todo);
  }
  const before = parsePlan(text);
  const reopened = parsePlan(out).steps.filter((s) => s.marker === MARKERS.todo && (stepById(before, s.id) || {}).marker === MARKERS.built).map((s) => s.id);
  return { text: out, reopened };
}

// Whether `v` (state.verifying) is a verification parked between two stops whose snapshot is
// `snap`: carried over to the next stop, so neither cut off nor the owner's.
export function parkedVerification(v, snap) {
  return !!(v && v.parked && snap && snap.id && v.verifyId === snap.id);
}

const VERIFY_PART_NAMES = Object.freeze({ tester: "the browser tester", bugbash: "the bug bash", security: "the security review" });

// The words for a part of a verification, by its key (lib/gate.js verificationParts and
// checkParts, which name their parts with this): check "<name>", the same check's second run with
// a step's findings filed (recheck:), the browser tester, the bug bash, the security review.
export function verifyPartName(key) {
  const k = String(key ?? "");
  const m = /^check:\d+:([\s\S]*)$/.exec(k);
  if (m) return `check "${m[1]}"`;
  const again = /^recheck:\d+:([\s\S]*)$/.exec(k);
  if (again) return `check "${again[1]}" (run again with the findings filed)`;
  return VERIFY_PART_NAMES[k] || k;
}

// Where a verification spread over stops stands (state.verifying, D60), for `autoclaude status`
// and a builder session that starts while one is carried over: { what ("Phase 3", or the step id
// of one verified step by step), stepId, phase, feature, fixup (the checks of a fix-up pass),
// parked, turns, done: [names], left: [names] }, or null when there is none. `left` is what was
// carried over the last time, less what is done since; empty for a record that does not say.
export function stagedVerification(v) {
  if (!v || typeof v !== "object" || !v.stepId) return null;
  const done = Array.isArray(v.done) ? v.done : [];
  const left = Array.isArray(v.left) ? v.left.filter((k) => !done.includes(k)) : [];
  const phase = Number.isInteger(v.phase) ? v.phase : null;
  return {
    what: v.feature && phase !== null ? `Phase ${phase}` : String(v.stepId), stepId: String(v.stepId), phase, feature: !!v.feature, fixup: !!v.fixup,
    parked: !!v.parked, turns: Number.isInteger(v.turns) ? v.turns : 0, done: done.map(verifyPartName), left: left.map(verifyPartName)
  };
}

const andList = (xs) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

// The parts of a stagedVerification in words: 'check "unit" and the browser tester are done, and
// the bug bash is left'. Empty when it names none.
export function stagedPartsText(sv) {
  if (!sv) return "";
  const are = (xs) => (xs.length === 1 ? "is" : "are");
  const done = sv.done.length ? `${andList(sv.done)} ${are(sv.done)} done` : "";
  const left = sv.left.length ? `${andList(sv.left)} ${are(sv.left)} left` : "";
  return done && left ? `${done}, and ${left}` : done || (left ? `nothing is done yet, and ${left}` : "");
}

// Whether a gate process other than `except` is at work in the project right now
// (scripts/stop-gate.js keeps .autoclaude/gate.json with its pid while it runs).
export function gateRunning(root, { except = null } = {}) {
  try {
    const j = readJson(path.join(projectPaths(root).runtimeDir, "gate.json"), null);
    return !!(j && j.pid && j.pid !== except && isPidAlive(j.pid));
  } catch {
    return false;
  }
}

// The time any gate can take: its budget plus the supervisor's margin. A pid recorded longer ago
// than that is a reused one.
function gateLifeMs(config) {
  return (((config && config.gate && config.gate.timeoutSec) || 1800) + 300) * 1000;
}

// Whether the gate that wrote `rec` (a verification snapshot, or state.closing: { pid, at }) is
// not `self`, is still alive and is still within a gate's lifetime. gate.json can be overwritten
// by a second session's gate; these records cannot.
export function heldByLiveGate(rec, self, config) {
  if (!rec || !Number.isSafeInteger(rec.pid) || rec.pid <= 0 || rec.pid === self) return false;
  const at = Date.parse(rec.at || "");
  if (Number.isFinite(at) && Date.now() - at > gateLifeMs(config)) return false;
  return isPidAlive(rec.pid);
}

// Another gate at work in the project than `self`: a live gate.json of another pid, not older
// than a gate's lifetime, or a pending verification whose gate is alive.
export function liveOtherGate(root, config, self) {
  try {
    const j = readJson(path.join(projectPaths(root).runtimeDir, "gate.json"), null);
    if (j && j.pid && j.pid !== self && isPidAlive(j.pid)) {
      const at = Date.parse(j.at || "");
      if (!Number.isFinite(at) || Date.now() - at < gateLifeMs(config)) return true;
    }
  } catch {}
  let snap = null;
  try { snap = readJson(pendingVerifyFile(root), null); } catch { snap = null; }
  return heldByLiveGate(snap, self, config);
}

// Undoes a verification that was cut off (the hook's timeout, `pause --now` ending the session
// and its gate, a crash): the ticks it wrote come out, its PROGRESS lines and findings rows go,
// and nothing else, so edits the owner made during a pause stay. With unlessGateRunning it is
// left to a gate that is still alive (`self`, the caller's own pid, never counts as one). A
// snapshot whose outcome the run state already records (a gate cut off between recording it
// and removing the file) is only removed. `own` is the gate taking out its own verification
// after a failure. A cut-off found while the run is running (not ended by the owner's pause)
// counts towards state.outOfTime. A verification parked between two stops (state.verifying,
// D60) is not cut off: it is left for the next stop. One taken out here (cut off in a later stop
// of it, or the gate's own) leaves state.verifying too. Returns { step, ids, fixup, count }
// (count: that step's out-of-time count when this one was counted, else 0) or null when there
// was nothing to undo.
export function undoCutVerification(root, config, { unlessGateRunning = false, self = null, own = false } = {}) {
  const file = pendingVerifyFile(root);
  let snap;
  try { snap = readJson(file, null); } catch { snap = {}; }
  if (!snap) return null;
  if (!own) {
    if (unlessGateRunning && (gateRunning(root, { except: self }) || heldByLiveGate(snap, self, config))) return null;
    const st = loadState(root);
    if (snap.id && ((st.closing && st.closing.verifyId === snap.id) || (st.fixup && st.fixup.verifyId === snap.id))) {
      removeIfExists(file);
      return null;
    }
    if (parkedVerification(st.verifying, snap)) return null;
  }
  const ids = undoVerification(root, config, snap);
  removeIfExists(file);
  let count = 0;
  const ours = (v) => !!(v && snap.id && v.verifyId === snap.id);
  const before = loadState(root);
  const counted = !own && !!snap.step && before.status === STATUS.running;
  if (counted || ours(before.verifying)) {
    const st = updateState(root, (s) => {
      if (counted) s.outOfTime = { ...(s.outOfTime || {}), [snap.step]: ((s.outOfTime || {})[snap.step] || 0) + 1 };
      if (ours(s.verifying)) s.verifying = null;
    });
    if (counted) count = st.outOfTime[snap.step];
  }
  return { step: snap.step || null, ids, fixup: !!snap.fixup, count };
}

// Takes out what a verification wrote: its ticks, its PROGRESS lines and its findings rows, and
// nothing else. `snap` is a snapshot as above, or the undo record of a verified close (lib/gate.js
// state.closing.undo), which lists the ticked steps' earlier markers in `markers` instead of
// keeping the plan, and says in `progressCreated` whether the verification created PROGRESS.md.
// Returns the ids of the steps it unticked.
export function undoVerification(root, config, snap) {
  const ids = [];
  const markers = snap.markers && typeof snap.markers === "object" ? snap.markers : null;
  if (typeof snap.plan === "string" || markers) {
    const planFile = path.join(root, config.plan);
    let text = readText(planFile, null);
    if (text !== null) {
      const before = typeof snap.plan === "string" ? parsePlan(snap.plan) : null;
      const now = parsePlan(text);
      // A snapshot that does not list its ticks: every step it did not have as done.
      const wrote = Array.isArray(snap.ticked) ? snap.ticked : before ? before.steps.filter((s) => s.marker !== MARKERS.done).map((s) => s.id) : Object.keys(markers);
      for (const id of wrote) {
        const cur = stepById(now, id);
        const old = before ? (stepById(before, id) || {}).marker : markers[id];
        if (cur && typeof old === "string" && cur.marker === MARKERS.done && old !== MARKERS.done) { text = setMarker(text, id, old); ids.push(id); }
      }
      if (ids.length) writeFileAtomic(planFile, text);
    }
  }
  const progressFile = path.join(root, config.docs.progress);
  const cur = snap.fixup ? null : readText(progressFile, null);
  if (cur !== null) {
    let next = cur;
    if (typeof snap.added === "string" && snap.added) {
      const i = cur.lastIndexOf(snap.added);
      if (i >= 0) next = cur.slice(0, i) + cur.slice(i + snap.added.length);
    } else if (typeof snap.progress === "string" && cur.startsWith(snap.progress)) {
      next = snap.progress;
    }
    // The verification created the file: it goes again.
    const created = typeof snap.progressCreated === "boolean" ? snap.progressCreated : snap.progress === null || snap.progress === undefined;
    if (next === "" && created) removeIfExists(progressFile);
    else if (next !== cur) writeFileAtomic(progressFile, next);
  }
  // The findings rows it filed, the last copy of each; a file it created goes when nothing else
  // was written to it.
  for (const r of Array.isArray(snap.rows) ? snap.rows : []) {
    if (!r || typeof r.file !== "string" || typeof r.text !== "string" || !r.text) continue;
    const f = path.join(root, r.file);
    const text = readText(f, null);
    const i = text === null ? -1 : text.lastIndexOf(r.text);
    if (i < 0) continue;
    const next = text.slice(0, i) + text.slice(i + r.text.length);
    if (r.created && next.trim() === "") removeIfExists(f);
    else writeFileAtomic(f, next);
  }
  return ids;
}

// The commit a tag points at, or null.
async function tagCommit(root, name, env) {
  const r = await git.git(root, ["rev-parse", "--verify", "-q", `refs/tags/${name}^{commit}`], { env });
  return r.ok ? r.stdout.trim() || null : null;
}

// Whether `sha` is a commit of this run: on HEAD's history, and not on that of the commit the
// run started from.
async function madeByThisRun(root, sha, base, env) {
  const before = await git.git(root, ["merge-base", "--is-ancestor", sha, base], { env });
  if (before.ok) return false;
  const since = await git.git(root, ["merge-base", "--is-ancestor", sha, "HEAD"], { env });
  return since.ok;
}

// The tag a verified phase gets: ac-phase-<n>, unless that tag was made before this run (an
// earlier run's, or a new plan's Phase <n> meeting the last plan's: every plan gets the same
// title, so the title cannot tell them apart). Then this run's is ac-phase-<n>-<the first seven
// characters of `base`>, the commit the run started from (state.baseCommit). A phase verified
// again in this run finds its first tag. Without a base (a state from an older version) the
// plan's title is all there is to go on: another title at the tagged commit gives
// ac-phase-<n>-<plan slug>. Returns { name, sha (the commit an existing tag of that name points
// at, else null), other (whose the plain name is, when it is not this run's), plain }.
export async function phaseTag(root, config, parsed, num, { env, base = null } = {}) {
  const plain = `ac-phase-${num}`;
  const at = await tagCommit(root, plain, env);
  if (!at) return { name: plain, sha: null, other: null, plain };
  let other;
  let suffix;
  if (typeof base === "string" && base.trim()) {
    if (await madeByThisRun(root, at, base.trim(), env)) return { name: plain, sha: at, other: null, plain };
    other = "an earlier run";
    suffix = base.trim().slice(0, 7);
  } else {
    const slug = planSlug(parsed);
    const theirs = await git.showFile(root, plain, config.plan, { env });
    const their = theirs === null ? null : planSlug(parsePlan(theirs));
    if (their === slug) return { name: plain, sha: at, other: null, plain };
    other = their || "another plan";
    suffix = slug;
  }
  const name = `${plain}-${suffix}`;
  return { name, sha: await tagCommit(root, name, env), other, plain };
}

// The message `autoclaude resume` commits pending steps with: the gate's own message (its
// Accept lines, checks, decisions and findings) when the state kept it, with a line saying who
// made the commit.
export function pendingCommitMessage(ids, titles, messages = {}) {
  const note = `Committed by \`autoclaude resume\`: the gate had verified or built ${ids.join(", ")}, but its own commit failed.`;
  const kept = ids.map((id) => messages && messages[id]).filter((m) => typeof m === "string" && m.trim());
  const subjectOf = (m) => m.split(/\r?\n/)[0];
  const bodyOf = (m) => m.split(/\r?\n/).slice(1).join("\n").replace(/^\s*\n/, "").trimEnd();
  const subject = ids.length === 1 && kept.length === 1 ? subjectOf(kept[0]) : `autoclaude(${ids.join(", ")}): ${titles.join("; ")}`;
  return [subject, "", note, ...kept.map((m) => `\n${bodyOf(m)}`)].join("\n") + "\n";
}

// Steps that passed verification (or were built) but could not be committed (the gate paused
// the run as "commit-failed"). Commits them in one commit, with the gate's message, tags a phase
// end the way the gate would have, and leaves that tag for the next push. Returns { ok, ids,
// sha, error }.
export async function commitPending(project, state, { env } = {}) {
  const ids = state.uncommitted || [];
  if (!ids.length) return { ok: true, ids: [], sha: null, error: null };
  const parsed = parsePlan(readText(path.join(project.root, project.config.plan), ""));
  const titles = ids.map((id) => { const s = parsed.steps.find((x) => x.id === id); return s ? s.title : id; });
  const c = await git.commitAll(project.root, pendingCommitMessage(ids, titles, state.uncommittedMessages || {}), { env });
  if (!c.ok) return { ok: false, ids, sha: null, error: String(c.stderr || "").trim() || "unknown error" };
  const tags = [];
  const cfgGit = project.config.git || {};
  for (const id of ids) {
    const s = parsed.steps.find((x) => x.id === id);
    if (!s || !s.phase || s.marker !== MARKERS.done || !isPhaseEnd(parsed, id) || cfgGit.tagPhaseEnds === false) continue;
    const t = await phaseTag(project.root, project.config, parsed, s.phase.num, { env, base: state.baseCommit });
    // As in the gate: with pushes on, a phase verified before keeps its first tag.
    if (t.sha && cfgGit.push) continue;
    if ((await git.tag(project.root, t.name, { force: true, env })).ok) tags.push(t.name);
  }
  updateState(project.root, (s) => {
    s.uncommitted = []; s.uncommittedMessages = {}; s.headAtLastGate = c.sha || s.headAtLastGate;
    if (tags.length && cfgGit.push) {
      const prev = s.pushState || {};
      s.pushState = { ...prev, unpushedTags: [...new Set([...(prev.unpushedTags || []), ...tags])] };
    }
  });
  return { ok: true, ids, sha: c.sha, error: null };
}

// The verification carried over between two stops that a resume keeps (state.verifying), or
// null. One it cannot keep is taken out here, its ticks, PROGRESS lines and snapshot and nothing
// else, and the change is listed. One a live gate is still at work on is left to that gate. The
// checks of a fix-up pass carried over (fixup: true) are kept while that pass is: its closing
// step and every step of its phase still ticked.
function keepStaged(root, config, changes) {
  const st = loadState(root);
  const v = st.verifying;
  if (!v || !v.stepId) return null;
  let snap = null;
  try { snap = readJson(pendingVerifyFile(root), null); } catch { snap = null; }
  const own = !!(snap && snap.id && snap.id === v.verifyId);
  if (own && !v.parked) return v;
  const parsed = parsePlan(readText(path.join(root, config.plan), "") || "");
  const ticks = Array.isArray(v.ticked) ? v.ticked : [];
  const what = v.fixup ? `the fix-up checks of Phase ${v.phase}` : `the verification of ${v.feature && Number.isInteger(v.phase) ? `Phase ${v.phase}` : v.stepId}`;
  const was = v.fixup ? "were" : "was";
  const step = stepById(parsed, v.stepId);
  let why = null;
  if (!own) why = "its snapshot is gone";
  else if (!step || !ticks.every((id) => (stepById(parsed, id) || {}).marker === MARKERS.done)) why = "the owner changed its ticks";
  else if (v.fixup) {
    if (!(st.fixup && st.fixup.stepId === v.stepId) || !fixupIntact(step)) why = "its fix-up pass is no longer under way";
  } else {
    const first = parsed.steps.find((s) => !isFinished(s) || ticks.includes(s.id));
    const perFeature = verifyModeFor(config, step.phase ? step.phase.num : null) === "phase";
    const name = v.feature && Number.isInteger(v.phase) ? `Phase ${v.phase}` : v.stepId;
    if (!first || !ticks.includes(first.id)) why = "an earlier step is open again";
    else if (!!v.feature !== perFeature) why = perFeature ? `${name} is verified as one feature now` : `${name} is verified step by step now`;
  }
  if (!why) {
    const sv = stagedVerification(v);
    const parts = `${(v.done || []).length} of its parts are done${sv && sv.left.length ? `; left: ${sv.left.join(", ")}` : ""}`;
    changes.push(`${what} ${was} carried over between two stops; the next stop carries ${v.fixup ? "them" : "it"} on (${parts}), or starts ${v.fixup ? "them" : "it"} again if the files change before then. The builder ends its turn without changing anything, so the gate can carry ${v.fixup ? "them" : "it"} on`);
    return v;
  }
  const ids = undoVerification(root, config, own ? snap : v.undo || {});
  if (own) removeIfExists(pendingVerifyFile(root));
  changes.push(`${what} ${was} carried over between two stops, but ${why}: ${v.fixup ? "they were" : "it was"} taken out${ids.length ? ` (unticked ${ids.join(", ")})` : ""} and ${v.fixup ? "are" : "is"} done again`);
  return null;
}

// Whether a fix-up pass at `end` (its closing step) can go on: the step and every step of its
// phase are still ticked.
function fixupIntact(end) {
  return !!(end && end.marker === MARKERS.done && (!end.phase || end.phase.steps.every((s) => s.marker === MARKERS.done)));
}

// `env` is the environment of the process running the resume: AUTOCLAUDE_BUILDER=1 there means
// it is the builder session itself (/autoclaude:resume typed in the run window).
export function resumeRun(project, state, extra = {}, { env = process.env } = {}) {
  const { root, config } = project;
  const planFile = path.join(root, config.plan);
  const changes = [];
  // First the leftovers of a verification that was cut off, or its ticks would read as the
  // owner's and its feature would be skipped.
  const cut = undoCutVerification(root, config, { unlessGateRunning: true });
  if (cut) changes.push(cut.fixup ? `the fix-up checks of ${cut.step || "the last step"} were cut off` : `the verification of ${cut.step || "the last step"} was cut off; its plan ticks and PROGRESS lines were taken out again`);
  // A verification carried over between two stops (state.verifying, D60) and parked when the run
  // paused: its ticks are the gate's, not the owner's, and the next stop carries it on (from its
  // first part again if the files change before then). It is taken out like a cut-off one when
  // the owner changed its ticks, an earlier step is open again, or its phase is now verified the
  // other way (gate.verifyAt, gate.stepPhases).
  let staged = keepStaged(root, config, changes);
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
  // their feature, verifyAt changed to "step", or the phase is now verified step by step) are
  // reopened, so no step stays unverified.
  const mode = verifyModeFor(config);
  const reopen = reopenForMode(text, config);
  if (reopen.reopened.length) {
    text = reopen.text;
    edited = true;
    const after = parsePlan(text);
    for (const id of reopen.reopened) {
      const s = stepById(after, id);
      changes.push(mode === "step"
        ? `${id}: reopened; it was built but not verified, and verifyAt is "step", so its ready verifies it`
        : s.phase && verifyModeFor(config, s.phase.num) === "step"
          ? `${id}: reopened; it was built but not verified, and Phase ${s.phase.num} is now verified step by step (gate.stepPhases), so its ready verifies it`
          : `${id}: reopened; Phase ${s.phase.num} was never verified and its other steps are all done or built, so the ready of ${id} verifies it`);
    }
  }
  if (edited) writeFileAtomic(planFile, text);
  parsed = parsePlan(text);
  // [x] and [~] are both the gate's record; the integrity check accepts exactly this list (and
  // the ticks of a parked verification, which it reads from state.verifying).
  // A built step the parked verification ticked [x] stays on the list as built.
  const before = new Set(state.tickedByGate || []);
  const stagedIds = new Set(staged ? staged.ticked : []);
  const ticked = parsed.steps.filter(isFinished).map((s) => s.id).filter((id) => !stagedIds.has(id) || before.has(id));
  for (const id of ticked) if (!before.has(id)) changes.push(`${id}: ticked by the owner, accepted as ${parsed.steps.find((s) => s.id === id).marker === MARKERS.built ? "built" : "done"}`);
  for (const id of before) if (!ticked.includes(id) && !reopen.reopened.includes(id)) changes.push(`${id}: unticked by the owner, will be done again`);

  // A fix-up pass carries on while its feature is still ticked; if the owner unticked any step
  // of that phase, the feature is verified again from scratch instead.
  let fixup = state.fixup && state.fixup.stepId ? state.fixup : null;
  if (fixup) {
    const end = parsed.steps.find((s) => s.id === fixup.stepId);
    if (!fixupIntact(end)) { changes.push(`the fix-up pass of ${fixup.stepId} is dropped: its phase is no longer ticked, so it is verified again`); fixup = null; }
  }
  // Checks of a fix-up pass carried over go with their pass.
  if (staged && staged.fixup && !(fixup && fixup.stepId === staged.stepId)) {
    let snap = null;
    try { snap = readJson(pendingVerifyFile(root), null); } catch { snap = null; }
    if (snap && snap.id && snap.id === staged.verifyId) removeIfExists(pendingVerifyFile(root));
    changes.push(`the fix-up checks of Phase ${staged.phase} carried over between two stops are dropped with their fix-up pass`);
    staged = null;
  }
  const current = fixup ? parsed.steps.find((s) => s.id === fixup.stepId) : staged ? stepById(parsed, staged.stepId) : firstUnfinished(parsed);
  const id = current ? current.id : null;
  if (fixup) changes.push(staged && staged.fixup ? `resuming the fix-up pass of ${id}: its findings are handled, and its checks go on at the next stop` : `resuming the fix-up pass of ${id}: fix or hand over each finding, then ready ${id}`);
  else if (id !== (state.currentStep || null)) changes.push(`current step is now ${id || "none (every step is done)"}`);
  // A pause at a feature's end (review, weekly limit) leaves the old builder session behind: the
  // next feature still gets a fresh one (D49), from a live supervisor only, since without one
  // nothing would start it. An answered question carries on in the session that asked it, and
  // so does a resume typed in the builder's own session: the supervisor would end that session
  // in the middle of the work the resume sets going.
  const boundary = !fixup && current && current.phase && current.phase.steps.every((s) => !isFinished(s));
  const insideBuilder = !!(env && env.AUTOCLAUDE_BUILDER === "1");
  const fresh = !!(boundary && state.pauseReason !== "blocked" && !insideBuilder && liveSupervisorPid(root));
  if (fresh) changes.push(`${id} starts a new feature, so the supervisor opens a fresh builder session for it`);
  else if (boundary && insideBuilder && state.pauseReason !== "blocked") changes.push(`${id} starts a new feature; this is the builder's own session, so it carries on here`);
  // With nothing built and no fix-up pass, no feature is under way: a base or start time left
  // behind (a gate cut off at the wrong moment) would stretch the next feature's review.
  const underWay = !!fixup || !!staged || parsed.steps.some((s) => s.marker === MARKERS.built);
  updateState(root, (s) => {
    s.status = STATUS.running; s.pauseReason = null; s.pauseRequested = false; s.recoveries = 0; s.noProgress = 0;
    // A `pause --now` the supervisor had not acted on yet must not end the resumed session later.
    s.haltSession = false;
    // A fresh-session request from before the pause is spent; a new feature asks again.
    s.freshSession = fresh;
    s.tickedByGate = ticked;
    s.currentStep = id;
    s.fixup = fixup;
    s.verifying = staged;
    if (!underWay) { s.phaseBaseCommit = null; s.phaseStartedAt = null; }
    if (id) {
      s.attempts = { ...s.attempts, [id]: 0 }; s.infraFailures = { ...(s.infraFailures || {}), [id]: 0 };
      // Every out-of-time count starts again, and the cut-off-close counts lib/gate.js keeps under
      // "close:<id>" go: the one that paused may belong to a later step of the feature than the
      // current one, which `autoclaude verify-per-step` makes common (its built steps reopen).
      s.outOfTime = Object.fromEntries(Object.entries({ ...(s.outOfTime || {}), [id]: 0 }).filter(([k]) => !k.startsWith("close:")).map(([k]) => [k, 0]));
    }
    Object.assign(s, extra);
  });
  return changes;
}
