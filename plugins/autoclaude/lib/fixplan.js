// "Fix right away" (PLAN.md P10.7, D58): a sweep's confirmed findings become a plan of their own
// (SECURITY_PLAN.md or OPTIMIZE_PLAN.md) that a normal run fixes on its own branch, every fix
// verified by the gate like any other step. The plan is committed, so it words every security fix
// neutrally: finding ids, files and the path of the gitignored report, never what is wrong or how
// to exploit it. The run reads the details from the report. Also the home of the run-plan
// override (`run --plan`), which lives in lib/config.js so loadConfig can apply it without
// loading this module. Node built-ins only.
import { parsePlan, lintPlan, TAGS } from "./plan.js";
import { gateSeverity, compareFindings, areaOf, normFile, numberFindings, SEVERITY_RANK } from "./findings.js";

export { setRunPlan, clearRunPlan, runPlanOverride, readRunPlan, runPlanFile, RUN_PLAN_FILE } from "./config.js";

export const FIX_PLAN_FILES = Object.freeze({ security: "SECURITY_PLAN.md", optimize: "OPTIMIZE_PLAN.md" });
export const MAX_STEPS_PER_PHASE = 5;
// Tier B changes pin today's behaviour here first; the change step may not edit these tests.
export const CHARACTERIZATION_DIR = "test/characterization";
// The tag of a change step that must leave the pinned tests alone; the tool guard denies the
// builder any write under CHARACTERIZATION_DIR while the current step is pinned (isPinnedStep).
// Written only once lib/plan.js knows the tag, so a generated plan always passes lint.
export const PINNED_TAG = "pinned";
// Step id prefixes: the letters of a step id. "SF" and "OF" (security fix, optimize fix), not the
// "S" the project template uses, so a fix run's PROGRESS.md lines never read like the project's
// own steps; another letter is added when the project's plan or PROGRESS.md already has the ids.
export const STEP_PREFIX = Object.freeze({ security: "SF", optimize: "OF" });

// A change step working under pinned tests: tagged pinned, or (a plan from before the tag) one
// that depends on an earlier step and names a test under CHARACTERIZATION_DIR, which is the
// shape of every pin-then-change pair this module writes.
export function isPinnedStep(step) {
  if (!step || typeof step !== "object") return false;
  if (Array.isArray(step.tags) && step.tags.includes(PINNED_TAG)) return true;
  const under = (t) => String(t).replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase().startsWith(`${CHARACTERIZATION_DIR}/`);
  return Array.isArray(step.depends) && step.depends.length > 0 && Array.isArray(step.test) && step.test.some(under);
}

// ---------- text that is safe in a plan ----------

// One line, no uppercase TODO or TBD (lint refuses them: nobody answers during a run).
function line(s) {
  return String(s || "").replace(/\s+/g, " ").trim().replace(/\bTODO\b/g, "todo").replace(/\bTBD\b/g, "to be decided");
}

function clip(s, max) {
  const t = line(s);
  return t.length > max ? `${t.slice(0, max - 3).replace(/\s+\S*$/, "")}...` : t;
}

const code = (s) => `\`${String(s).replace(/`/g, "'")}\``;
const lower = (id) => String(id).toLowerCase();

// The H1 and the plan name the branch, through planSlug: "Security fixes 2026-10-02" ->
// autoclaude/security-fixes-2026-10-02. stamp (optional, for example the sweep's time) makes the
// title, and so the branch, unique to one sweep: "Security fixes 2026-10-02 1430".
export function fixPlanTitle(kind, date, stamp = null) {
  const extra = stamp === null || stamp === undefined ? "" : line(stamp);
  return `${kind === "optimize" ? "Optimization" : "Security fixes"} ${date}${extra ? ` ${extra}` : ""}`;
}

// Every step-like id (S1.2, OF1.1) in a text, lower case.
function idsIn(text) {
  return new Set((String(text || "").match(/\b[A-Za-z]+\d+(?:\.\d+)+\b/g) || []).map((s) => s.toLowerCase()));
}

// The letters for this plan's step ids: STEP_PREFIX[kind], else that with a letter added (SFB,
// SFC ...), whichever writes no id the project's own plan or PROGRESS.md already has. counts:
// the number of steps in each phase, in order.
export function stepPrefix(kind, counts, { mainPlanText = "", progressText = "" } = {}) {
  const base = STEP_PREFIX[kind] || "X";
  const taken = new Set([...parsePlan(String(mainPlanText || "")).steps.map((s) => s.id.toLowerCase()), ...idsIn(progressText)]);
  const ids = (prefix) => counts.flatMap((n, i) => Array.from({ length: n }, (_, k) => `${prefix}${i + 1}.${k + 1}`.toLowerCase()));
  for (const extra of ["", ..."BCDEFGHJKLMNPQRSTUVWXYZ"]) {
    const prefix = `${base}${extra}`;
    if (!ids(prefix).some((id) => taken.has(id))) return prefix;
  }
  return `${base}Z`;
}

// ---------- the main plan's constraints ----------

const PLACEHOLDERS = ["Not written yet.", "Nothing decided yet."];
const STEP_LIKE = /^([ \t]*)- \[.\] \*\*([A-Za-z]+\d+(?:\.\d+)+)\*\*/;
const PHASE_LIKE = /^#{2,4}[ \t]+(Phase[ \t]+\d+[ \t]*:.*?)[ \t]*$/i;

// The whole "## Constraints & decisions" section of the main plan (to the next "## " heading,
// fences respected), made safe to copy: no step or phase lines that would become steps here, no
// paragraph still holding a template placeholder. "" when the plan has none.
export function copyConstraints(planText) {
  const lines = String(planText || "").replace(/\r\n?/g, "\n").split("\n");
  let start = -1;
  let fence = null;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(```|~~~)/.exec(lines[i]);
    if (m) { fence = fence === null ? m[1] : fence === m[1] ? null : fence; continue; }
    if (fence === null && /^##\s+Constraints\s*(?:&|and)\s*decisions\b/i.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return "";
  let end = lines.length;
  fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*(```|~~~)/.exec(lines[i]);
    if (m) { fence = fence === null ? m[1] : fence === m[1] ? null : fence; continue; }
    if (fence === null && /^##\s/.test(lines[i])) { end = i; break; }
  }
  fence = null;
  const body = lines.slice(start + 1, end).map((l) => {
    const m = /^\s*(```|~~~)/.exec(l);
    if (m) { fence = fence === null ? m[1] : fence === m[1] ? null : fence; return l; }
    if (fence !== null) return l;
    if (STEP_LIKE.test(l)) return l.replace(STEP_LIKE, "$1- $2:");
    const ph = PHASE_LIKE.exec(l);
    return ph ? `**${ph[1]}**` : l;
  }).join("\n");
  const paragraphs = body.split(/\n[ \t]*\n/).filter((p) => !PLACEHOLDERS.some((ph) => p.replace(/`[^`]*`/g, "").includes(ph)));
  // A subsection left empty (its placeholder paragraph gone) loses its heading too.
  const depth = (p) => { const m = /^(#{3,6})[ \t]/.exec(p); return m && !p.includes("\n") ? m[1].length : 0; };
  const kept = paragraphs.filter((p, i) => {
    const d = depth(p);
    if (!d) return true;
    const next = paragraphs[i + 1];
    return next !== undefined && (depth(next) === 0 || depth(next) > d);
  });
  return kept.join("\n\n").trim();
}

// ---------- findings to steps ----------

// The language a regression test is written in, from the finding's file, else from the files of
// all findings (the project's main language), else JavaScript.
const CODE_EXT = /\.(mjs|cjs|js|jsx|ts|tsx|py|go|rb)$/i;
function testExt(file, fallback) {
  const m = CODE_EXT.exec(String(file || ""));
  return m ? m[1].toLowerCase() : fallback;
}

function mainExt(findings) {
  const n = new Map();
  for (const f of findings) {
    const e = testExt(f.file, null);
    if (e) n.set(e, (n.get(e) || 0) + 1);
  }
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || "js";
}

// A file named after the finding, in the project's test folder (or the folder given).
function testFile(dir, id, ext) {
  const slug = lower(id);
  if (ext === "py") return `${dir}/test_${slug.replace(/-/g, "_")}.py`;
  if (ext === "go") return `${dir}/${slug.replace(/-/g, "_")}_test.go`;
  if (ext === "rb") return `${dir}/${slug.replace(/-/g, "_")}_spec.rb`;
  return `${dir}/${slug}.test.${ext}`;
}

const isDependency = (f) => !!f.fixedVersion || /\b(dep|deps|dependenc|package|advisor|supply)/i.test(String(f.category || ""));
const isPerformance = (f) => /perf|slow|speed|bundle|load|query|n\+1|latency/i.test(String(f.category || ""));
const isRebuild = (f) => /rebuild|poorly|redesign/i.test(String(f.category || ""));
const isBug = (f) => /\bbug\b/i.test(String(f.category || ""));

// Who fixes it: the run, or the owner (a security finding marked unsafe to fix automatically,
// an optimize finding of tier C). A finding the run fixes may still leave something for the
// owner (ownerAction), which "After the run" then lists.
// For optimize the tier alone decides: autoFixSafe there means "mechanical, no judgement needed"
// (true only for tier A, scan-optimize.applyTierRules), and tier B is fixed behind pinned tests.
// An optimize finding without a known tier counts as C: what nobody classified is not changed.
export function needsOwner(f, kind) {
  if (kind === "optimize") return !["A", "B"].includes(String(f.tier || "").toUpperCase());
  return f.autoFixSafe === false;
}

function securitySteps(f, ctx) {
  const id = f.id;
  const where = f.file ? code(normFile(f.file)) : "the project";
  const test = testFile(ctx.testDir, id, testExt(f.file, ctx.ext));
  const note = `Finding ${id} (${gateSeverity(f.severity)}), details in ${code(ctx.reportRel)}`;
  if (isDependency(f)) {
    return [{
      title: `Update the dependency named in finding ${id}`,
      accept: [
        `the dependency finding ${id} names is upgraded the way its report entry says (to the fixed version it gives, or later; inside the allowed range when it gives none), in the manifest and the lockfile, with no major upgrade`,
        "a clean install, the build and every configured check pass with it",
        `a regression test named for ${id} checks that the installed version is no longer one the advisory covers, and passes`
      ],
      test: [test], tags: ["no-ui", "security"], notes: [note]
    }];
  }
  return [{
    title: `Resolve finding ${id} in ${where}`,
    accept: [
      `the problem finding ${id} describes no longer occurs in ${where}: reproduced the way its report entry says, it no longer shows`,
      `a regression test named for ${id} covers that case and passes, and it fails on the code from before this step`,
      "no existing test is weakened, skipped or deleted"
    ],
    test: [test], tags: ["no-ui", "security"], notes: [note]
  }];
}

function optimizeSteps(f, ctx) {
  const id = f.id;
  const what = clip(f.title || `the change finding ${id} describes`, 90);
  const where = f.file ? ` in ${code(normFile(f.file))}` : "";
  const ext = testExt(f.file, ctx.ext);
  const note = `Finding ${id}, details in ${code(ctx.reportRel)}`;
  const extra = [];
  if (isPerformance(f)) extra.push(`measured again the way the report's baseline was (the median of at least 5 runs), the figure finding ${id} names improves by more than the noise, and the before and after figures are recorded in the decisions log`);
  if (isBug(f)) extra.push(`the behaviour change is recorded in the decisions log with \`- Owner review: yes\`, so the hand-back lists it`);
  const done = `done as finding ${id} describes in its report entry: ${what}${where}`;
  // A real bug is fixed with a regression test, never pinned first: pinning would pin the bug.
  if (isBug(f)) {
    return [{
      title: `${what} (${id})`,
      accept: [
        done,
        ...extra,
        `a regression test named for ${id} covers the bug and passes, and it fails on the code from before this step`,
        "no existing test is weakened, skipped or deleted"
      ],
      test: [testFile(ctx.testDir, id, ext)], tags: ["no-ui"], notes: [note]
    }];
  }
  if (String(f.tier || "").toUpperCase() !== "B") {
    return [{
      title: `${what} (${id})`,
      accept: [
        done,
        ...extra,
        `the tests that cover the changed code pass, with a new test named for ${id} where none covered it; no test is weakened, and a test is removed only together with the code it tested`
      ],
      test: [testFile(ctx.testDir, id, ext)], tags: ["no-ui"], notes: [note]
    }];
  }
  // Tier B: pin today's behaviour first, then change the code under the pinned tests.
  const pinned = testFile(CHARACTERIZATION_DIR, id, ext);
  const pin = {
    title: `Pin the current behaviour around finding ${id}${where}`,
    accept: [
      `characterization tests in ${code(pinned)} exercise the code finding ${id} names and pass on the code as it is before the change`,
      `the project's test command runs ${code(pinned)} (its file pattern is extended if it did not)`,
      `this step changes no file outside ${code(`${CHARACTERIZATION_DIR}/`)} other than the test command's file pattern`
    ],
    test: [pinned], tags: ["no-ui"], notes: [note, "Pin what the code does today, odd results included: the next step must not change them."]
  };
  const ui = isRebuild(f);
  const change = {
    title: `${what} (${id})`,
    accept: [
      done,
      ...extra,
      `${code(pinned)} is unchanged since the pin step's commit (git shows no change to it after that commit) and passes`,
      ...(ui ? ["the pages that use this code show the same content and work the same as in the sweep's baseline screenshots in the report folder"] : [])
    ],
    test: [pinned], tags: [...(ui ? [] : ["no-ui"]), ...(TAGS.includes(PINNED_TAG) ? [PINNED_TAG] : [])], notes: [note], dependsOnPin: true
  };
  return [pin, change];
}

// ---------- the plan ----------

function phaseTitle(kind, area, units, part) {
  const sevs = [...new Set(units.map((u) => gateSeverity(u.finding.severity)))].sort((a, b) => SEVERITY_RANK[b] - SEVERITY_RANK[a]);
  const place = area === "project root" ? "the project root" : area;
  const what = kind === "optimize" ? `Optimizations in ${place}` : `Security fixes in ${place}`;
  return `${what} (${sevs.join(", ")})${part > 1 ? `, part ${part}` : ""}`;
}

// Findings grouped by area (the area with the most severe finding first), most severe first within
// an area, then cut into phases of at most MAX_STEPS_PER_PHASE steps; a pin step and its change
// stay in one phase.
function phasesOf(kind, units) {
  const byArea = new Map();
  for (const u of units) {
    const a = areaOf(u.finding);
    if (!byArea.has(a)) byArea.set(a, []);
    byArea.get(a).push(u);
  }
  const areas = [...byArea.entries()].map(([area, list]) => ({ area, list: list.sort((x, y) => compareFindings(x.finding, y.finding)) }));
  areas.sort((x, y) => compareFindings(x.list[0].finding, y.list[0].finding) || x.area.localeCompare(y.area));
  const phases = [];
  for (const { area, list } of areas) {
    let cur = null;
    let part = 0;
    for (const u of list) {
      if (!cur || cur.count + u.steps.length > MAX_STEPS_PER_PHASE) {
        cur = { area, part: ++part, units: [], count: 0 };
        phases.push(cur);
      }
      cur.units.push(u);
      cur.count += u.steps.length;
    }
  }
  return phases.map((p) => ({ ...p, title: phaseTitle(kind, p.area, p.units, p.part) }));
}

function renderStep(id, s, dependsOn) {
  const L = [`- [ ] **${id}** ${line(s.title)}`];
  for (const a of s.accept) L.push(`  - Accept: ${line(a)}`);
  if (s.test.length) L.push(`  - Test: ${s.test.join(", ")}`);
  if (s.tags.length) L.push(`  - Tags: ${s.tags.join(", ")}`);
  if (dependsOn) L.push(`  - Depends: ${dependsOn}`);
  for (const n of s.notes) L.push(`  - Note: ${line(n)}`);
  return L;
}

function defaultConstraints(kind) {
  return [
    "The project's own plan has no \"Constraints & decisions\" section, so these defaults apply.",
    "",
    "- Prefer what the repo already has: the existing library, pattern, naming and folder layout.",
    "- Prefer the simplest change that satisfies the Accept lines. No extra features.",
    "- A new runtime dependency is a decider question, logged in `docs/DECISIONS.md`.",
    "- Never delete data, drop a table or rewrite git history.",
    kind === "security" ? "- A secret the fix needs is generated into the gitignored `secrets/` folder, never committed or printed." : "- Major upgrades and changes to a database other apps share are left for the owner."
  ].join("\n");
}

function planRules(kind, reportRel) {
  const R = [
    "- Fix only what each step names. Anything else you notice goes in the decisions log for the owner, not into this run.",
    `- Read each finding's entry in ${code(reportRel)} before its step: where it is, why it matters, how to reproduce it, the suggested fix and a test idea. The report is not committed.`,
    "- Never weaken, skip or delete an existing test to get a step green."
  ];
  if (kind === "security") {
    R.push(
      "- Keep finding details out of everything committed: code comments, test names, commit messages, docs and the decisions log say only the finding id and what was changed in neutral words, never how the problem could be used.",
      "- Severity: critical findings are treated as high (D58)."
    );
  } else {
    R.push(
      `- Tests a pin step writes under ${code(`${CHARACTERIZATION_DIR}/`)} are never edited afterwards; the change that follows must pass them as they are.`,
      "- A real bug found on the way is fixed with a test and recorded in the decisions log as a behaviour change with `- Owner review: yes`.",
      "- Minor and patch upgrades are fine; a major upgrade is left for the owner."
    );
  }
  return R.join("\n");
}

// The generated plan: { text, file, stepCount, phases: [{ num, title, steps }], ownerItems (the
// finding ids left for the owner), problems (lintPlan's, empty for any plan with a step) }.
// confirmed: the sweep's confirmed findings with their ids; uncertain: the ones no session could
// settle, listed for the owner and never fixed. reportRel: the report's project-relative path.
// testDir: the project's test folder (default "test"). stepCount 0 means nothing is left for a
// run: the text then has no phases and fails lint, so it is not written or run.
// progressText: the project's PROGRESS.md, so the step ids (stepPrefix) are ones it has never
// recorded; the main plan's ids are avoided too. stamp: see fixPlanTitle.
export function generateFixPlan({ kind, confirmed = [], uncertain = [], mainPlanText = "", progressText = "", reportRel, date = new Date().toISOString().slice(0, 10), testDir = "test", stamp = null } = {}) {
  if (!FIX_PLAN_FILES[kind]) throw new Error(`generateFixPlan: unknown kind ${JSON.stringify(kind)} (security or optimize)`);
  const report = String(reportRel || ".autoclaude/sweeps").replace(/\\/g, "/");
  const dir = String(testDir || "test").replace(/\\/g, "/").replace(/\/+$/, "") || "test";
  // Findings without an id get one, the way the report numbers them.
  const list = (confirmed || []).filter((f) => f && typeof f === "object");
  const withIds = list.every((f) => typeof f.id === "string" && f.id.trim()) ? list : numberFindings(list, kind);
  const ctx = { kind, reportRel: report, testDir: dir, ext: mainExt(withIds) };

  const fixable = withIds.filter((f) => !needsOwner(f, kind));
  const forOwner = withIds.filter((f) => needsOwner(f, kind)).sort(compareFindings);
  const units = fixable.map((f) => ({ finding: f, steps: kind === "security" ? securitySteps(f, ctx) : optimizeSteps(f, ctx) }));
  const phases = phasesOf(kind, units);

  const L = [];
  L.push(`# ${fixPlanTitle(kind, date, stamp)}`, "");
  L.push(`Generated by AutoClaude from the ${kind === "security" ? "security" : "optimization"} sweep, for \`autoclaude run --plan\`, which commits it as \`${FIX_PLAN_FILES[kind]}\` on a new branch and runs it there. The project's own plan and its run state are kept aside until that run completes. Each step names its findings by id; the details are in the sweep's report, which is never committed.`, "");
  L.push("## Goal", "");
  L.push(kind === "security"
    ? `Fix the confirmed findings of the security sweep, each with a regression test, verified by the gate like any other step. Every finding's details and suggested fix: ${code(report)} (gitignored).`
    : `Make the confirmed improvements of the optimization sweep without changing what the app does, each verified by the gate like any other step. Every finding's details, the suggested change and the baseline: ${code(report)} (gitignored).`, "");
  L.push("## Constraints & decisions", "");
  L.push(copyConstraints(mainPlanText) || defaultConstraints(kind), "");
  L.push("### Rules for this plan", "", planRules(kind, report), "");

  L.push("## After the run", "");
  const after = [`Review the run branch, then merge it. The report ${code(report)} lists every finding, the ones fixed and the ones left.`];
  for (const f of forOwner) {
    after.push(kind === "security"
      ? `${f.id} (${gateSeverity(f.severity)}) needs you: see its entry in ${code(report)}.`
      : `${f.id} (${clip(f.title || f.category || "change", 80)}) is left for your decision: see its entry in ${code(report)}.`);
  }
  for (const f of fixable.filter((x) => x.ownerAction).sort(compareFindings)) after.push(`${f.id} is fixed by this plan and also needs something only you can do: see its entry in ${code(report)}.`);
  const unsure = (uncertain || []).filter((f) => f && f.id).sort(compareFindings).map((f) => f.id);
  if (unsure.length) after.push(`Not fixed because no session could confirm or refute them: ${unsure.join(", ")}. Check them yourself in ${code(report)}.`);
  for (const a of after) L.push(`- ${line(a)}`);
  L.push("");

  const prefix = stepPrefix(kind, phases.map((p) => p.count), { mainPlanText, progressText });
  const out = [];
  phases.forEach((p, i) => {
    const num = i + 1;
    L.push(`## Phase ${num}: ${line(p.title)}`, "");
    let n = 0;
    const ids = [];
    for (const u of p.units) {
      let pinId = null;
      for (const s of u.steps) {
        const id = `${prefix}${num}.${++n}`;
        L.push(...renderStep(id, s, s.dependsOnPin ? pinId : null));
        if (!s.dependsOnPin) pinId = id;
        ids.push(id);
      }
    }
    L.push("");
    out.push({ num, title: line(p.title), steps: ids, findings: p.units.map((u) => u.finding.id) });
  });

  const text = L.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n";
  const stepCount = out.reduce((n, p) => n + p.steps.length, 0);
  return { text, file: FIX_PLAN_FILES[kind], stepCount, phases: out, ownerItems: forOwner.map((f) => f.id), problems: lintPlan(parsePlan(text)) };
}
