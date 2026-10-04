import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  estimatePhase, estimatePlan, fitLimitSec, verifiedPerStep, describePart, phaseLine, misfitText, misfitWarning, formatPlanEstimate,
  TESTER_BASE_SEC, TESTER_SEC_PER_LINE, BUGBASH_SEC_PER_TURN, SECURITY_SEC
} from "../../plugins/autoclaude/lib/estimate.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { DEFAULT_CHECK_TIMEOUT_SEC } from "../../plugins/autoclaude/lib/checks.js";
import { expectedCheckMs, stopPartsSec } from "../../plugins/autoclaude/lib/gate.js";

const SERVER = { command: "npm run dev", url: "http://127.0.0.1:4173", healthPath: "/", startTimeoutSec: 30 };
const CHECKS = [{ name: "unit", command: "npm test", timeoutSec: 600 }, { name: "e2e", command: "npm run e2e" }];
const cfgWith = (extra = {}) => mergeConfig({ checks: CHECKS, devServer: SERVER, ...extra });
const times = (map) => Object.fromEntries(Object.entries(map).map(([k, s]) => [k, { recentMs: [s * 1000], medianMs: s * 1000, at: null }]));

const PLAN = `# Demo plan

## Phase 1: Lists
- [ ] **S1.1** List page
  - Accept: a
  - Accept: b
  - Accept: c
- [ ] **S1.2** API
  - Accept: d
  - Test: test/api.test.js
  - Tags: no-ui
- [ ] **S1.3** Rename
  - Accept: e
  - Accept: f
  - Tags: security

## Phase 2: Old
- [x] **S2.1** Done already
  - Accept: g
`;

// A one-phase plan whose single UI step has n Accept lines.
function bigPlan(n, { marker = " " } = {}) {
  const lines = Array.from({ length: n }, (_, i) => `  - Accept: line ${i + 1}`).join("\n");
  return parsePlan(`# Big plan\n\n## Phase 1: Big\n- [${marker}] **S1.1** Everything\n${lines}\n`);
}

const kinds = (e) => e.parts.map((p) => `${p.kind}:${p.name}${p.step ? `@${p.step}` : ""}=${p.seconds}${p.known ? "" : "?"}`);

test("fitLimitSec is gate.fitPct percent of the time a stop has for its parts, as the gate gives it; verifiedPerStep follows verifyAt and stepPhases", () => {
  // The gate's deadline: gate.timeoutSec less a minute for the commit, never under 120 s.
  assert.deepEqual([stopPartsSec(mergeConfig({})), stopPartsSec(mergeConfig({ gate: { timeoutSec: 600 } })), stopPartsSec(mergeConfig({ gate: { timeoutSec: 100 } })), stopPartsSec(null)], [1740, 540, 120, 1740]);
  assert.equal(fitLimitSec(mergeConfig({})), 1218, "70% of 1740 s");
  assert.equal(fitLimitSec(mergeConfig({ gate: { timeoutSec: 600, fitPct: 50 } })), 270);
  assert.equal(fitLimitSec(mergeConfig({ gate: { timeoutSec: 100, fitPct: 50 } })), 60, "half of the least a stop has");
  assert.equal(fitLimitSec(null), 1218);
  assert.equal(verifiedPerStep(mergeConfig({}), 2), false);
  assert.equal(verifiedPerStep(mergeConfig({ gate: { stepPhases: [2, 4] } }), 2), true);
  assert.equal(verifiedPerStep(mergeConfig({ gate: { stepPhases: [2, 4] } }), 3), false);
  assert.equal(verifiedPerStep(mergeConfig({ gate: { verifyAt: "step" } }), 3), true);
  assert.equal(verifiedPerStep(null, 1), false);
});

test("a check counts as the gate weighs it: its recent time with a quarter on top, at least 10 s, at most its timeoutSec; its timeoutSec when never timed", () => {
  const parsed = parsePlan(PLAN);
  const check = { name: "unit", command: "npm test", timeoutSec: 600 };
  for (const rec of [{}, times({ unit: 0.2 }), times({ unit: 100 }), times({ unit: 479.9 }), times({ unit: 1000 }), { unit: { recentMs: [100000, 120000, 400000, 500000] } }]) {
    const e = estimatePhase(parsed.phases[0], { config: cfgWith({ checks: [check] }), checkTimes: rec, parsed });
    const p = e.parts.find((x) => x.kind === "check");
    assert.equal(p.seconds, Math.ceil(expectedCheckMs(check, rec) / 1000), JSON.stringify(rec));
    assert.equal(p.known, !!rec.unit, JSON.stringify(rec));
  }
  const at = (rec) => estimatePhase(parsed.phases[0], { config: cfgWith({ checks: [check] }), checkTimes: rec, parsed }).parts[0].seconds;
  assert.deepEqual([at({}), at(times({ unit: 0.2 })), at(times({ unit: 100 })), at(times({ unit: 1000 })), at({ unit: { recentMs: [100000, 120000, 400000, 500000] } })], [600, 10, 125, 600, 325]);
});

test("a whole feature: every check as the gate weighs it, the tester by its UI Accept lines, the bug bash, the security review", () => {
  const parsed = parsePlan(PLAN);
  const e = estimatePhase(parsed.phases[0], { config: cfgWith(), checkTimes: times({ unit: 120.4 }), parsed });
  const lines = 5; // S1.1's three and S1.3's two; S1.2 is no-ui
  const tester = TESTER_BASE_SEC + TESTER_SEC_PER_LINE * lines;
  const bugbash = 60 * BUGBASH_SEC_PER_TURN; // tester.maxTurns 40 x 1.5
  assert.deepEqual(kinds(e), [
    "check:unit=151", // 120.4 s timed here, with a quarter on top
    `check:e2e=${DEFAULT_CHECK_TIMEOUT_SEC}?`,
    `tester:browser tester=${tester}`,
    `bugbash:bug bash=${bugbash}`,
    `security:security review=${SECURITY_SEC}`
  ]);
  assert.equal(e.parts.find((p) => p.kind === "tester").lines, lines);
  assert.deepEqual([e.phase, e.title, e.perStep, e.parallel, e.limitSec, e.fitPct, e.stopSec, e.timeoutSec], [1, "Lists", false, "security", 1218, 70, 1740, 1800]);
  assert.equal(e.largest.name, "e2e", "a check never timed here counts at its timeoutSec (900 s by default)");
  // A recorded time over the check's timeoutSec (lowered since) counts at the timeoutSec, where
  // the check is stopped.
  const capped = estimatePhase(parsed.phases[0], { config: cfgWith(), checkTimes: times({ unit: 1000 }), parsed });
  assert.deepEqual([capped.parts[0].seconds, capped.parts[0].known], [600, true]);
  assert.equal(e.fits, true);
  assert.deepEqual(e.over, []);
  assert.equal(e.totalSec, 151 + DEFAULT_CHECK_TIMEOUT_SEC + tester + bugbash + SECURITY_SEC);
  // By default the security review runs alongside the browser tester and the bug bash, which
  // stay one after the other: the checks, then the longer of the two lanes.
  assert.deepEqual(e.rounds[0].lanes.map((l) => l.map((p) => p.kind)), [["tester", "bugbash"], ["security"]]);
  assert.equal(e.elapsedSec, 151 + DEFAULT_CHECK_TIMEOUT_SEC + Math.max(tester + bugbash, SECURITY_SEC));
  // The DB run measured 68 to 125 s for 3 to 5 lines: the estimate sits at the top of that.
  assert.ok(TESTER_BASE_SEC + TESTER_SEC_PER_LINE * 3 >= 84 && tester >= 125 && tester < 200);
});

test("checkers.parallel: the checkers overlap the way the gate runs them, which changes the time in all and never whether a phase fits", () => {
  const parsed = parsePlan(PLAN);
  const ct = times({ unit: 100, e2e: 200 });
  const checks = 125 + 250;
  const tester = TESTER_BASE_SEC + TESTER_SEC_PER_LINE * 5;
  const bugbash = 60 * BUGBASH_SEC_PER_TURN;
  const est = (parallel, extra = {}) => estimatePhase(parsed.phases[0], { config: cfgWith({ checkers: { parallel }, ...extra }), checkTimes: ct, parsed });
  const lanes = (e) => e.rounds.flatMap((r) => r.lanes.map((l) => l.map((p) => p.kind).join("+")));
  const sec = est("security");
  const all = est("all");
  const off = est("off");
  assert.deepEqual([lanes(sec), lanes(all), lanes(off)], [["tester+bugbash", "security"], ["tester", "bugbash", "security"], ["tester+bugbash+security"]]);
  assert.deepEqual([sec.elapsedSec, all.elapsedSec, off.elapsedSec], [checks + tester + bugbash, checks + bugbash, checks + tester + bugbash + SECURITY_SEC]);
  for (const e of [sec, all, off]) assert.equal(e.totalSec, checks + tester + bugbash + SECURITY_SEC, "the parts are the same");
  assert.match(phaseLine(sec), new RegExp(`; about ${checks + tester + bugbash} s in all, with the security review alongside the browser checks$`));
  assert.match(phaseLine(all), new RegExp(`; about ${checks + bugbash} s in all, with the checkers side by side$`));
  assert.match(phaseLine(off), new RegExp(`; about ${checks + tester + bugbash + SECURITY_SEC} s in all$`));
  // A security review longer than the browser lane sets the time in all.
  const slow = est("security", { bugBash: { atPhaseEnd: false } });
  assert.ok(tester < SECURITY_SEC);
  assert.equal(slow.elapsedSec, checks + SECURITY_SEC);
  // Fitting is per part, in every mode: a lane's longest part is one of the parts. The bug bash
  // alone is over the room here, whichever way the checkers run.
  for (const parallel of ["security", "all", "off"]) {
    const e = est(parallel, { gate: { timeoutSec: 500 } });
    assert.deepEqual([e.fits, e.over.map((p) => p.kind)], [false, ["bugbash"]], parallel);
    for (const r of e.rounds) for (const l of r.lanes) assert.equal(l.every((p) => p.seconds <= e.limitSec), !l.some((p) => p.kind === "bugbash"), `${parallel}: ${l.map((p) => p.kind)}`);
  }
  // No browser: the security review runs on its own and nothing overlaps.
  const alone = est("security", { devServer: { command: null, url: null } });
  assert.equal(alone.elapsedSec, alone.totalSec);
  assert.doesNotMatch(phaseLine(alone), /alongside|side by side/);
  // Step by step, each step's verification overlaps on its own, and the times add up.
  const steps = estimatePhase(parsed.phases[0], { config: cfgWith({ gate: { stepPhases: [1] } }), checkTimes: ct, parsed });
  assert.deepEqual(steps.rounds.map((r) => r.step), ["S1.1", "S1.2", "S1.3"]);
  assert.equal(steps.elapsedSec, steps.rounds.reduce((n, r) => n + r.elapsedSec, 0));
  const s13 = steps.rounds[2];
  assert.equal(s13.elapsedSec, checks + Math.max(TESTER_BASE_SEC + 2 * TESTER_SEC_PER_LINE + bugbash, SECURITY_SEC));
});

test("the browser parts follow the gate: no dev server, the tester switched off, no bug bash, security rules", () => {
  const parsed = parsePlan(PLAN);
  const ph = parsed.phases[0];
  const est = (extra) => kinds(estimatePhase(ph, { config: cfgWith(extra), checkTimes: times({ unit: 10, e2e: 20 }), parsed })).map((k) => k.split(":")[0]);
  assert.deepEqual(est({ devServer: { command: null, url: null } }), ["check", "check", "security"], "no dev server: the gate opens no browser");
  assert.deepEqual(est({ tester: { enabled: false } }), ["check", "check", "bugbash", "security"], "the bug bash does not depend on the tester switch");
  assert.deepEqual(est({ bugBash: { atPhaseEnd: false } }), ["check", "check", "tester", "security"]);
  assert.deepEqual(est({ security: { when: ["never"] } }), ["check", "check", "tester", "bugbash"]);
  assert.deepEqual(est({ security: { when: ["tag:security"] } }).at(-1), "security", "S1.3 is tagged security");
  const untagged = parsePlan(PLAN.replace("  - Tags: security\n", ""));
  assert.equal(estimatePhase(untagged.phases[0], { config: cfgWith({ security: { when: ["tag:security"] } }), parsed: untagged }).parts.some((p) => p.kind === "security"), false);
  // A phase of no-ui steps only: no tester and no bug bash.
  const noUi = parsePlan("# P\n\n## Phase 1: Back end\n- [ ] **S1.1** API\n  - Accept: a\n  - Test: t.js\n  - Tags: no-ui\n");
  assert.deepEqual(kinds(estimatePhase(noUi.phases[0], { config: cfgWith(), checkTimes: times({ unit: 10, e2e: 20 }), parsed: noUi })).map((k) => k.split(":")[0]), ["check", "check", "security"]);
});

test("each checker is capped by its own limit", () => {
  const parsed = parsePlan(PLAN);
  const e = estimatePhase(parsed.phases[0], { config: cfgWith({ tester: { timeoutSec: 60 }, security: { timeoutSec: 100 } }), checkTimes: times({ unit: 1, e2e: 1 }), parsed });
  const by = Object.fromEntries(e.parts.map((p) => [p.kind === "check" ? p.name : p.kind, p.seconds]));
  assert.deepEqual([by.tester, by.bugbash, by.security], [60, 60, 100]);
  // The tester's limit grows with its lines (tester.timeoutSec for every 5, at most 4 times).
  const big = bigPlan(12);
  let t = estimatePhase(big.phases[0], { config: cfgWith({ tester: { timeoutSec: 50 } }), parsed: big }).parts.find((p) => p.kind === "tester");
  assert.equal(t.seconds, 150, "12 lines: 3 x 50 s, under the 230 s of the estimate");
  t = estimatePhase(big.phases[0], { config: cfgWith({ tester: { timeoutSec: 100 } }), parsed: big }).parts.find((p) => p.kind === "tester");
  assert.equal(t.seconds, TESTER_BASE_SEC + 12 * TESTER_SEC_PER_LINE, "3 x 100 s leaves room for the estimate");
});

test("a browser tester too big for one turn does not fit: split the phase, or verify-per-step for a plan already running", () => {
  // 77 lines: 50 + 15 x 77 = 1205 s fits 1218 s (70% of 1740 s); 78 lines does not.
  const fits = bigPlan(77);
  assert.equal(estimatePhase(fits.phases[0], { config: cfgWith(), checkTimes: times({ unit: 60, e2e: 60 }), parsed: fits }).fits, true);
  const big = bigPlan(78);
  const e = estimatePhase(big.phases[0], { config: cfgWith(), checkTimes: times({ unit: 60, e2e: 60 }), parsed: big });
  assert.deepEqual([e.fits, e.largest.kind, e.largest.seconds, e.over.length], [false, "tester", 1220, 1]);
  assert.equal(misfitWarning(e), "WARNING: Phase 1 (Big) does not fit its verification: its browser tester (78 Accept lines) needs about 1220 s (estimated), more than 1218 s (gate.fitPct 70% of the 1740 s a stop has for its parts, gate.timeoutSec 1800 s less 60 s for the commit). Split Phase 1 into smaller features, or, for a plan already running, `autoclaude verify-per-step 1`.");
  assert.equal(misfitText(e), misfitWarning(e).replace(/^WARNING: /, ""));
  assert.match(phaseLine(e), /^Phase 1 \(Big\): DOES NOT FIT; largest part browser tester \(78 Accept lines\), about 1220 s \(estimated\); about \d+ s in all, with the security review alongside the browser checks$/);
});

test("verified step by step: each unfinished step on its own, the bug bash at the phase's last step, security when due", () => {
  const parsed = parsePlan(PLAN.replace("- [ ] **S1.1**", "- [x] **S1.1**"));
  const e = estimatePhase(parsed.phases[0], { config: cfgWith({ gate: { stepPhases: [1] } }), checkTimes: times({ unit: 100, e2e: 200 }), parsed });
  assert.equal(e.perStep, true);
  assert.deepEqual(kinds(e), [
    "check:unit@S1.2=125", "check:e2e@S1.2=250",
    "check:unit@S1.3=125", "check:e2e@S1.3=250",
    `tester:browser tester@S1.3=${TESTER_BASE_SEC + 2 * TESTER_SEC_PER_LINE}`,
    `bugbash:bug bash@S1.3=${60 * BUGBASH_SEC_PER_TURN}`,
    `security:security review@S1.3=${SECURITY_SEC}`
  ], "S1.1 is verified already; S1.2 is no-ui and neither the phase's end nor tagged security");
  assert.match(phaseLine(e), /^Phase 1 \(Lists\), verified step by step: fits; largest part bug bash for S1\.3, about 420 s/);
  // verifyAt "step" verifies every phase that way.
  assert.equal(estimatePhase(parsed.phases[0], { config: cfgWith({ gate: { verifyAt: "step" } }), parsed }).perStep, true);
  // One step too big on its own: split the step; verify-per-step is no help any more.
  const big = bigPlan(90);
  const s = estimatePhase(big.phases[0], { config: cfgWith({ gate: { stepPhases: [1] } }), checkTimes: times({ unit: 60, e2e: 60 }), parsed: big });
  assert.equal(s.fits, false);
  assert.equal(s.largest.step, "S1.1");
  assert.match(misfitText(s), /its browser tester \(90 Accept lines\) for S1\.1 needs about 1400 s .*Split S1\.1 into smaller steps: verified step by step, one step's Accept lines are already the smallest part\.$/);
  assert.doesNotMatch(misfitText(s), /verify-per-step/);
});

test("a check too long for one turn: measure it when it was never timed; splitting the phase is no help", () => {
  const parsed = parsePlan(PLAN);
  const ph = parsed.phases[0];
  // Never timed, and its timeoutSec is over the room: time it first.
  let e = estimatePhase(ph, { config: cfgWith({ checks: [{ name: "suite", command: "npm test", timeoutSec: 1500 }] }), parsed });
  assert.deepEqual([e.fits, e.largest.name, e.largest.known, e.largest.seconds], [false, "suite", false, 1500]);
  assert.equal(misfitText(e), "Phase 1 (Lists) does not fit its verification: its check \"suite\" needs up to 1500 s (its timeoutSec; not timed yet), more than 1218 s (gate.fitPct 70% of the 1740 s a stop has for its parts, gate.timeoutSec 1800 s less 60 s for the commit). It has not been timed on this computer: `autoclaude checks` times it. If it really needs that long, make it faster or split it into smaller checks (each is a part of its own); splitting the phase does not help, because every verification runs every check.");
  // Timed at 22 minutes (27.5 with the gate's quarter on top): make it faster or split the
  // check; with gate.timeoutSec below the maximum, raising it is offered too.
  e = estimatePhase(ph, { config: cfgWith({ checks: [{ name: "suite", command: "npm test", timeoutSec: 1700 }] }), checkTimes: times({ suite: 1320 }), parsed });
  assert.equal(misfitText(e), "Phase 1 (Lists) does not fit its verification: its check \"suite\" needs about 1650 s (timed here, plus a quarter), more than 1218 s (gate.fitPct 70% of the 1740 s a stop has for its parts, gate.timeoutSec 1800 s less 60 s for the commit). Make \"suite\" faster, or split it into smaller checks (each is a part of its own); splitting the phase does not help, because every verification runs every check.");
  e = estimatePhase(ph, { config: cfgWith({ checks: [{ name: "suite", command: "npm test" }], gate: { timeoutSec: 1200 } }), checkTimes: times({ suite: 900 }), parsed });
  assert.match(misfitText(e), /more than 798 s \(gate\.fitPct 70% of the 1140 s a stop has for its parts, gate\.timeoutSec 1200 s less 60 s for the commit\)\. Make "suite" faster, or split it into smaller checks \(each is a part of its own\), or raise gate\.timeoutSec \(now 1200 s, at most 1800\); splitting/);
  // A check timed just under the room, but over it with the gate's quarter on top, does not fit.
  e = estimatePhase(ph, { config: cfgWith({ checks: [{ name: "suite", command: "npm test", timeoutSec: 1700 }] }), checkTimes: times({ suite: 1000 }), parsed });
  assert.deepEqual([e.fits, e.largest.seconds], [false, 1250]);
});

test("the bug bash and the security review do not grow with the phase: the fix is the time limits", () => {
  const parsed = parsePlan(PLAN);
  const ph = parsed.phases[0];
  let e = estimatePhase(ph, { config: cfgWith({ checks: [], gate: { timeoutSec: 500 } }), parsed });
  assert.deepEqual([e.limitSec, e.largest.kind, e.over.map((p) => p.kind)], [308, "bugbash", ["bugbash"]]);
  assert.match(misfitText(e), /its bug bash needs about 420 s \(estimated\), more than 308 s .*\. Raise gate\.timeoutSec \(now 500 s, at most 1800\), or lower tester\.maxTurns or tester\.timeoutSec, which bound the bug bash\.$/);
  e = estimatePhase(ph, { config: cfgWith({ checks: [], devServer: { command: null, url: null }, gate: { timeoutSec: 200, fitPct: 50 } }), parsed });
  assert.match(misfitText(e), /its security review needs about 180 s \(estimated\), more than 70 s .*\. Raise gate\.timeoutSec \(now 200 s, at most 1800\), or lower security\.timeoutSec, which bounds the security review\.$/);
  // A gate.timeoutSec so low that a stop gets the least it can have.
  e = estimatePhase(ph, { config: cfgWith({ checks: [], devServer: { command: null, url: null }, gate: { timeoutSec: 100, fitPct: 50 } }), parsed });
  assert.match(misfitText(e), /more than 60 s \(gate\.fitPct 50% of the 120 s a stop has for its parts, the least any stop has \(gate\.timeoutSec is 100 s\)\)\./);
  // At the maximum gate time only the checker's own limits are left to lower.
  e = estimatePhase(ph, { config: cfgWith({ checks: [], gate: { fitPct: 30 }, tester: { maxTurns: 100 } }), parsed });
  assert.equal(e.largest.kind, "bugbash");
  assert.match(misfitText(e), /\. Lower tester\.maxTurns or tester\.timeoutSec, which bound the bug bash\.$/);
  // More than one part over the room: the largest leads, the others are named once.
  const big = bigPlan(90);
  e = estimatePhase(big.phases[0], { config: cfgWith({ checks: [{ name: "suite", command: "x", timeoutSec: 1300 }] }), parsed: big });
  assert.match(misfitText(e), /its browser tester \(90 Accept lines\) needs about 1400 s .* Also over it: check "suite"\.$/);
  // The check leads; the tester over the room too still gets its own fix.
  e = estimatePhase(big.phases[0], { config: cfgWith({ checks: [{ name: "suite", command: "x", timeoutSec: 1500 }] }), parsed: big });
  assert.match(misfitText(e), /its check "suite" needs up to 1500 s .* Also over it: browser tester \(90 Accept lines\)\. Split Phase 1 into smaller features, or, for a plan already running, `autoclaude verify-per-step 1`\.$/);
  // Verified step by step, a check over the room is named once, not once per step.
  const two = parsePlan("# P\n\n## Phase 1: A\n- [ ] **S1.1** a\n  - Accept: a\n- [ ] **S1.2** b\n  - Accept: b\n");
  e = estimatePhase(two.phases[0], { config: cfgWith({ checks: [{ name: "suite", command: "x", timeoutSec: 1500 }], gate: { stepPhases: [1] } }), parsed: two });
  assert.equal(e.over.length, 2, "the check at each of the two steps");
  assert.match(misfitText(e), /^Phase 1 \(A\) does not fit its verification: its check "suite" needs up to 1500 s/);
  assert.doesNotMatch(misfitText(e), /Also over it|for S1/);
});

test("estimatePlan: every phase with a step not yet verified, the misfits, and the checks never timed here", () => {
  const parsed = parsePlan(PLAN);
  let est = estimatePlan(parsed, { config: cfgWith(), checkTimes: times({ unit: 30 }) });
  assert.deepEqual(est.phases.map((e) => e.phase), [1], "Phase 2 is verified");
  assert.deepEqual([est.fits, est.misfits, est.limitSec, est.fitPct, est.stopSec, est.timeoutSec, est.unmeasured], [true, [], 1218, 70, 1740, 1800, ["e2e"]]);
  const out = formatPlanEstimate(est);
  assert.deepEqual(out.warnings, []);
  assert.equal(out.lines[0], "autoclaude: verification estimate per unfinished phase (one part may need up to 1218 s: gate.fitPct 70% of the 1740 s a stop has for its parts, gate.timeoutSec 1800 s less 60 s for the commit)");
  assert.match(out.lines[1], /^ {2}Phase 1 \(Lists\): fits; largest part check "e2e", up to 900 s \(its timeoutSec; not timed yet\); about \d+ s in all, with the security review alongside the browser checks$/);
  // A check whose record holds only recent times (no median) counts as timed, as in the gate.
  assert.deepEqual(estimatePlan(parsed, { config: cfgWith(), checkTimes: { unit: { recentMs: [5000] }, e2e: { recentMs: [6000, 8000] } } }).unmeasured, []);
  assert.equal(out.lines[2], "  not timed on this computer yet: e2e (counted at its timeoutSec); `autoclaude checks` times them");

  // A misfit, with every check timed.
  const big = bigPlan(85);
  est = estimatePlan(big, { config: cfgWith(), checkTimes: times({ unit: 30, e2e: 40 }) });
  const f = formatPlanEstimate(est, { cli: "ac" });
  assert.equal(est.fits, false);
  assert.equal(f.lines.length, 2, "no line about untimed checks");
  assert.deepEqual(f.warnings, [misfitWarning(est.misfits[0], { cli: "ac" })]);
  assert.match(f.warnings[0], /`ac verify-per-step 1`/);
  // Nothing left to verify.
  assert.deepEqual(formatPlanEstimate(estimatePlan(bigPlan(3, { marker: "x" }), { config: cfgWith() })), { lines: ["autoclaude: no unfinished phase to estimate"], warnings: [] });
  // A built [~] step is not verified yet: its phase is still estimated.
  assert.equal(estimatePlan(bigPlan(3, { marker: "~" }), { config: cfgWith() }).phases.length, 1);
  // Defaults when no config is given: no checks, no dev server, the security review only.
  assert.deepEqual(estimatePlan(parsed).phases[0].parts.map((p) => p.kind), ["security"]);
});

test("describePart and the line for a phase with nothing to run", () => {
  assert.equal(describePart({ kind: "check", name: "unit", step: null }), 'check "unit"');
  assert.equal(describePart({ kind: "check", name: "unit", step: "S2.1" }), 'check "unit"', "a check runs whole at every step");
  assert.equal(describePart({ kind: "tester", name: "browser tester", lines: 1, step: "S2.1" }), "browser tester (1 Accept line) for S2.1");
  assert.equal(describePart({ kind: "security", name: "security review", step: null }), "security review");
  const parsed = parsePlan(PLAN);
  const e = estimatePhase(parsed.phases[0], { config: mergeConfig({ security: { when: ["never"] } }), parsed });
  assert.deepEqual([e.parts, e.largest, e.fits], [[], null, true]);
  assert.match(phaseLine(e), /^Phase 1 \(Lists\): nothing runs for it but the plan's ticks/);
});

test("the plan skill times the checks, estimates every phase, splits a phase that does not fit by itself and says so", () => {
  const skill = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "plugins", "autoclaude", "skills", "plan", "SKILL.md"), "utf8");
  assert.match(skill, /`autoclaude checks` also times\s+each check that passes/);
  assert.match(skill, /`autoclaude lint-plan` prints that estimate\s+for every unfinished phase/);
  assert.match(skill, /split it into smaller features yourself, without\s+asking/);
  assert.match(skill, /tell the owner which phases you split and why/);
  assert.match(skill, /is not fixed by splitting phases: every verification runs every\s+check/);
  assert.match(skill, /`autoclaude verify-per-step <phase>` has that phase verified step by step/);
  assert.match(skill, /`gate\.fitPct` \(default 70\)/);
});
