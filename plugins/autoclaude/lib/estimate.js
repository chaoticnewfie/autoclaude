// How long a feature's verification is expected to take, part by part (P10.13, D60). The gate
// verifies a feature in parts: each check, the browser tester, the bug bash and the security
// review. It spreads them over the Stop hook's turns, but one part must still fit in a single
// stop: the seconds a stop has for its parts, gate.timeoutSec less a minute for the commit
// (lib/gate.js stopPartsSec). A phase fits when its largest part needs at most gate.fitPct
// percent of that; the rest is headroom for the dev server's start and a slow day. The checks
// are counted the way the gate weighs them (lib/gate.js expectedCheckMs: the recent time on this
// computer with a quarter on top, else the check's timeoutSec); the checkers by the model the gate
// weighs them by (lib/gate.js checkerNeedSec, fitted to measured runs, each capped by the
// checker's own limit; the gate adds a quarter on top before it starts one after another part),
// side by side the way the gate runs them (checkers.parallel, lib/gate.js checkerLanes). Running
// side by side shortens a verification in all, never what a single part needs, so it changes the
// time in all and not whether a phase fits: a stop's first parts always start, each with the
// whole of the stop's time. `autoclaude lint-plan`, the run preflight and planning use this. Node
// built-ins only.
import { acceptCount } from "./tester.js";
import { securityWanted } from "./security.js";
import { MARKERS } from "./plan.js";
import { DEFAULTS, MAX_GATE_TIMEOUT_SEC } from "./config.js";
import { verifyModeFor } from "./resume.js";
import {
  expectedCheckMs, recordedCheckMs, checkerLanes, checkersParallel, stopPartsSec, fitLimitSec, checkerNeedSec,
  TESTER_BASE_SEC, TESTER_SEC_PER_LINE, BUGBASH_SEC_PER_TURN, SECURITY_SEC
} from "./gate.js";

// The model and the most a part may need live with the gate, which weighs the parts by them.
export { fitLimitSec, TESTER_BASE_SEC, TESTER_SEC_PER_LINE, BUGBASH_SEC_PER_TURN, SECURITY_SEC };

const isUi = (s) => !(Array.isArray(s.tags) && s.tags.includes("no-ui"));
const sumSec = (parts) => parts.reduce((n, p) => n + p.seconds, 0);

function gateTimeoutSec(config) {
  const t = config && config.gate ? Number(config.gate.timeoutSec) : NaN;
  return t > 0 ? t : DEFAULTS.gate.timeoutSec;
}

// Whether the gate verifies this phase step by step: every phase with gate.verifyAt "step", a
// phase listed in gate.stepPhases (`autoclaude verify-per-step`) otherwise (lib/resume.js
// verifyModeFor, which the gate asks).
export function verifiedPerStep(config, phaseNum) {
  return verifyModeFor(config, phaseNum) === "step";
}

// One part per configured check, at what the gate expects it to need (lib/gate.js
// expectedCheckMs): its recent time on this computer with a quarter on top, else its timeoutSec
// (marked known: false), never more than its timeoutSec, where it is stopped.
function checkParts(config, checkTimes, step) {
  return (Array.isArray(config.checks) ? config.checks : []).map((c) => ({
    kind: "check", name: c.name, seconds: Math.ceil(expectedCheckMs(c, checkTimes) / 1000), known: recordedCheckMs(c, checkTimes) > 0, step
  }));
}

// The checkers, by the gate's model (lib/gate.js checkerNeedSec).
function testerPart(config, uiSteps, step) {
  return { kind: "tester", name: "browser tester", seconds: checkerNeedSec("tester", config, { steps: uiSteps }), known: true, step, lines: acceptCount(uiSteps) };
}

function bugBashPart(config, lastStep, step) {
  return { kind: "bugbash", name: "bug bash", seconds: checkerNeedSec("bugbash", config, { step: lastStep }), known: true, step };
}

function securityPart(config, step) {
  return { kind: "security", name: "security review", seconds: checkerNeedSec("security", config), known: true, step };
}

// One verification (one ready's: the whole feature, or one step of a phase verified step by
// step), the way the gate runs it: its checks one after another, then its checkers in the gate's
// lanes (lib/gate.js checkerLanes), side by side, the parts of a lane one after another. Its time
// in all is the checks' plus the longest lane's.
function round(config, step, checks, checkers) {
  const lanes = checkerLanes(config, checkers);
  return { step, parts: [...checks, ...checkers], lanes, elapsedSec: sumSec(checks) + Math.max(0, ...lanes.map(sumSec)) };
}

// The parts of one phase's verification, the way the gate runs them: the whole feature at once
// (every check, the tester over the Accept lines of every step not tagged no-ui, the bug bash when
// the phase has such a step, the security review when any step calls for it), or, for a phase
// verified step by step, the same for each unfinished step on its own (the bug bash at the
// phase's last step). The browser parts need devServer.command and url, as in the gate.
// Returns { phase, title, perStep, parallel, parts: [{ kind: "check" | "tester" | "bugbash" |
// "security", name, seconds, known, step, lines? }], rounds: [{ step, parts, lanes, elapsedSec }],
// largest, over, fits, limitSec, fitPct, stopSec, timeoutSec, totalSec, elapsedSec }. known:
// false marks a check never timed here, counted at its timeoutSec; step is the step id for a
// phase verified step by step, else null. totalSec adds up every part; elapsedSec is the time in
// all, with the checkers side by side (checkers.parallel). A phase fits when every single part,
// and so the longest part of every lane, fits in gate.fitPct of a stop's time for its parts.
export function estimatePhase(phase, { config = null, checkTimes = {}, parsed = null } = {}) {
  // Read only, so the built-in defaults themselves stand in when no config is given.
  const cfg = config || DEFAULTS;
  const steps = Array.isArray(phase.steps) ? phase.steps : [];
  const plan = parsed || { steps, phases: [phase] };
  const perStep = verifiedPerStep(cfg, phase.num);
  const browser = !!(cfg.devServer && cfg.devServer.command && cfg.devServer.url);
  const last = steps[steps.length - 1];
  const anyUi = steps.some(isUi);
  const rounds = [];
  if (perStep) {
    for (const s of steps.filter((x) => x.marker !== MARKERS.done)) {
      const checkers = [];
      if (browser && cfg.tester.enabled && isUi(s)) checkers.push(testerPart(cfg, [s], s.id));
      if (browser && cfg.bugBash.atPhaseEnd && s === last && anyUi) checkers.push(bugBashPart(cfg, s, s.id));
      if (securityWanted(cfg, s, plan)) checkers.push(securityPart(cfg, s.id));
      rounds.push(round(cfg, s.id, checkParts(cfg, checkTimes, s.id), checkers));
    }
  } else if (steps.length) {
    const ui = steps.filter(isUi);
    const checkers = [];
    if (browser && cfg.tester.enabled && ui.length) checkers.push(testerPart(cfg, ui, null));
    if (browser && cfg.bugBash.atPhaseEnd && ui.length) checkers.push(bugBashPart(cfg, last, null));
    if (steps.some((s) => securityWanted(cfg, s, plan))) checkers.push(securityPart(cfg, null));
    rounds.push(round(cfg, null, checkParts(cfg, checkTimes, null), checkers));
  }
  const parts = rounds.flatMap((r) => r.parts);
  const limitSec = fitLimitSec(cfg);
  const largest = parts.reduce((a, p) => (a && a.seconds >= p.seconds ? a : p), null);
  const over = parts.filter((p) => p.seconds > limitSec);
  return {
    phase: phase.num, title: phase.title || "", perStep, parallel: checkersParallel(cfg), parts, rounds, largest, over, fits: over.length === 0,
    limitSec, fitPct: cfg.gate.fitPct, stopSec: stopPartsSec(cfg), timeoutSec: gateTimeoutSec(cfg),
    totalSec: sumSec(parts), elapsedSec: rounds.reduce((n, r) => n + r.elapsedSec, 0)
  };
}

// estimatePhase for every phase with a step not yet verified ([x]). Returns { phases, misfits,
// fits, limitSec, fitPct, stopSec, timeoutSec, unmeasured (the names of checks never timed here) }.
export function estimatePlan(parsed, { config = null, checkTimes = {} } = {}) {
  const cfg = config || DEFAULTS;
  const phases = (parsed && Array.isArray(parsed.phases) ? parsed.phases : [])
    .filter((ph) => ph.steps.some((s) => s.marker !== MARKERS.done))
    .map((ph) => estimatePhase(ph, { config: cfg, checkTimes, parsed }));
  const unmeasured = (Array.isArray(cfg.checks) ? cfg.checks : []).filter((c) => !(recordedCheckMs(c, checkTimes) > 0)).map((c) => c.name);
  const misfits = phases.filter((e) => !e.fits);
  return { phases, misfits, fits: misfits.length === 0, limitSec: fitLimitSec(cfg), fitPct: cfg.gate.fitPct, stopSec: stopPartsSec(cfg), timeoutSec: gateTimeoutSec(cfg), unmeasured };
}

// ---------- words ----------

// A check runs whole at every step's verification, so it is never named by a step.
export function describePart(p) {
  const what = p.kind === "check" ? `check "${p.name}"` : p.kind === "tester" ? `browser tester (${p.lines} Accept line${p.lines === 1 ? "" : "s"})` : p.name;
  return p.step && p.kind !== "check" ? `${what} for ${p.step}` : what;
}

// "about 230 s (estimated)", "about 300 s (timed here, plus a quarter)", "up to 900 s (its
// timeoutSec; not timed yet)".
function amount(p) {
  if (p.kind !== "check") return `about ${p.seconds} s (estimated)`;
  return p.known ? `about ${p.seconds} s (timed here, plus a quarter)` : `up to ${p.seconds} s (its timeoutSec; not timed yet)`;
}

// What one part may need, in words: "gate.fitPct 70% of the 1740 s a stop has for its parts,
// gate.timeoutSec 1800 s less 60 s for the commit". `e` is an estimate (phase or plan).
function roomWords(e) {
  const less = e.timeoutSec - e.stopSec;
  return `gate.fitPct ${e.fitPct}% of the ${e.stopSec} s a stop has for its parts, ${less > 0 ? `gate.timeoutSec ${e.timeoutSec} s less ${less} s for the commit` : `the least any stop has (gate.timeoutSec is ${e.timeoutSec} s)`}`;
}

const phaseName = (e) => `Phase ${e.phase}${e.title ? ` (${e.title})` : ""}`;

// How the checkers overlap when they do (checkers.parallel).
const OVERLAP = Object.freeze({ security: "the security review alongside the browser checks", all: "the checkers side by side" });

// One line for a phase: whether it fits, its largest part and the whole verification.
export function phaseLine(e) {
  const name = `${phaseName(e)}${e.perStep ? ", verified step by step" : ""}`;
  if (!e.largest) return `${name}: nothing runs for it but the plan's ticks (no checks, no browser, no security review)`;
  const elapsed = typeof e.elapsedSec === "number" ? e.elapsedSec : e.totalSec;
  const overlap = elapsed < e.totalSec && OVERLAP[e.parallel] ? `, with ${OVERLAP[e.parallel]}` : "";
  return `${name}: ${e.fits ? "fits" : "DOES NOT FIT"}; largest part ${describePart(e.largest)}, ${amount(e.largest)}; about ${elapsed} s in all${overlap}`;
}

// What to do about a phase that does not fit, by the kind of its largest part. Splitting helps
// only the browser tester: every verification runs every check, and the bug bash and the security
// review do not grow with the phase.
function fixFor(e, p, cli) {
  const raise = e.timeoutSec < MAX_GATE_TIMEOUT_SEC ? `raise gate.timeoutSec (now ${e.timeoutSec} s, at most ${MAX_GATE_TIMEOUT_SEC})` : null;
  if (p.kind === "tester") {
    if (e.perStep) return `Split ${p.step} into smaller steps: verified step by step, one step's Accept lines are already the smallest part.`;
    return `Split Phase ${e.phase} into smaller features, or, for a plan already running, \`${cli} verify-per-step ${e.phase}\`.`;
  }
  if (p.kind === "check") {
    const why = "splitting the phase does not help, because every verification runs every check";
    if (!p.known) return `It has not been timed on this computer: \`${cli} checks\` times it. If it really needs that long, make it faster or split it into smaller checks (each is a part of its own)${raise ? `, or ${raise}` : ""}; ${why}.`;
    return `Make "${p.name}" faster, or split it into smaller checks (each is a part of its own)${raise ? `, or ${raise}` : ""}; ${why}.`;
  }
  if (p.kind === "bugbash") return `${raise ? `${raise[0].toUpperCase()}${raise.slice(1)}, or lower` : "Lower"} tester.maxTurns or tester.timeoutSec, which bound the bug bash.`;
  return `${raise ? `${raise[0].toUpperCase()}${raise.slice(1)}, or lower` : "Lower"} security.timeoutSec, which bounds the security review.`;
}

// The warning for a phase that does not fit, without its "WARNING: " head (the preflight's form).
// Other parts over the room are named once each; a browser tester among them gets its own fix,
// since splitting the phase is still needed once the larger part is dealt with.
export function misfitText(e, { cli = "autoclaude" } = {}) {
  const p = e.largest;
  const seen = new Set([describePart(p)]);
  const others = e.over.filter((x) => { const d = describePart(x); if (seen.has(d)) return false; seen.add(d); return true; });
  const tester = others.find((x) => x.kind === "tester");
  const also = others.length ? ` Also over it: ${others.map(describePart).join(", ")}.${tester ? ` ${fixFor(e, tester, cli)}` : ""}` : "";
  return `${phaseName(e)} does not fit its verification: its ${describePart(p)} needs ${amount(p)}, more than ${e.limitSec} s (${roomWords(e)}). ${fixFor(e, p, cli)}${also}`;
}

export function misfitWarning(e, opts = {}) {
  return `WARNING: ${misfitText(e, opts)}`;
}

// What `autoclaude lint-plan` prints after a clean lint: { lines, warnings }, one line per
// unfinished phase, the checks never timed here, then a WARNING line per phase that does not fit.
export function formatPlanEstimate(est, { cli = "autoclaude" } = {}) {
  if (!est.phases.length) return { lines: ["autoclaude: no unfinished phase to estimate"], warnings: [] };
  const lines = [`autoclaude: verification estimate per unfinished phase (one part may need up to ${est.limitSec} s: ${roomWords(est)})`];
  for (const e of est.phases) lines.push(`  ${phaseLine(e)}`);
  if (est.unmeasured.length) lines.push(`  not timed on this computer yet: ${est.unmeasured.join(", ")} (counted at ${est.unmeasured.length === 1 ? "its" : "their"} timeoutSec); \`${cli} checks\` times them`);
  return { lines, warnings: est.misfits.map((e) => misfitWarning(e, { cli })) };
}
