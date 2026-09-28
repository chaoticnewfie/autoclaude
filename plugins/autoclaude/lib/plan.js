// PLAN.md parsing, linting and marker updates. PLAN.md section 4.8.1.
// Only step lines and their indented fields are interpreted; everything else is prose.
// Node built-ins only. Byte-for-byte safe: text is split on "\n" and each line keeps
// its "\r" (if any), so writes change only the marker character.

// built "~": committed without checks, waiting for its feature's verification (gate.verifyAt
// "phase", D49). The gate turns the whole phase to "x" when the feature passes.
export const MARKERS = Object.freeze({ todo: " ", done: "x", built: "~", failed: "!", blocked: "?" });
const VALID_MARKERS = new Set(Object.values(MARKERS));

// Done or built: the run does not work on it again.
export function isFinished(step) {
  return !!step && (step.marker === MARKERS.done || step.marker === MARKERS.built);
}

// - [ ] **S1.2** Title   (any marker character is captured so lint can report bad ones)
const STEP_RE = /^(?<indent>[ \t]*)- \[(?<marker>.)\] \*\*(?<id>[A-Za-z]+\d+(?:\.\d+)+)\*\*[ \t]*(?<title>.*?)[ \t]*\r?$/;
// `## Phase N: title` is the documented form; `###` and `####` are accepted because real plans
// nest phases under a numbered section heading.
const PHASE_RE = /^#{2,4}[ \t]+Phase[ \t]+(?<num>\d+)[ \t]*:[ \t]*(?<title>.*?)[ \t]*\r?$/i;
const FENCE_RE = /^[ \t]*(```|~~~)/;
const HEADING_RE = /^#{1,6}[ \t]/;
const FIELD_RE = /^(?<indent>[ \t]+)-[ \t]+(?<key>Accept|Test|Tags|Depends)[ \t]*:[ \t]*(?<value>.*?)[ \t]*\r?$/i;
const H1_RE = /^#[ \t]+(?<title>.*?)[ \t]*\r?$/;

function splitList(value) {
  return value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
}

export function parsePlan(text) {
  const lines = text.split("\n");
  const phases = [];
  const steps = [];
  const problems = [];
  let title = null;
  let phase = null;
  let step = null;

  const endStep = () => { step = null; };
  let fence = null; // inside a ``` or ~~~ block: nothing in there is a step or a heading

  lines.forEach((rawLine, i) => {
    const line = i === 0 ? rawLine.replace(/^﻿/, "") : rawLine;
    let m;
    if ((m = line.match(FENCE_RE))) {
      if (fence === null) { fence = m[1]; endStep(); } else if (m[1] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    if ((m = line.match(PHASE_RE))) {
      phase = { num: Number(m.groups.num), title: m.groups.title, line: i, steps: [] };
      phases.push(phase);
      endStep();
      return;
    }
    if (HEADING_RE.test(line)) {
      if (title === null && (m = line.match(H1_RE))) title = m.groups.title;
      endStep();
      return;
    }
    if ((m = line.match(STEP_RE))) {
      const { indent, marker, id } = m.groups;
      step = {
        id,
        title: m.groups.title,
        marker,
        line: i,
        lastLine: i,
        indent,
        phase,
        accept: [],
        test: [],
        tags: [],
        depends: []
      };
      if (!VALID_MARKERS.has(marker)) problems.push({ line: i + 1, id, message: `unknown marker "[${marker}]" (use [ ], [x], [~], [!] or [?])` });
      steps.push(step);
      if (phase) phase.steps.push(step);
      return;
    }
    if (!step) return;
    const blank = line.trim() === "";
    if (blank) return;
    const indented = /^[ \t]/.test(line) && line.match(/^[ \t]*/)[0].length > step.indent.length;
    if (!indented) { endStep(); return; }
    step.lastLine = i;
    if ((m = line.match(FIELD_RE))) {
      const key = m.groups.key.toLowerCase();
      const value = m.groups.value;
      if (key === "accept") step.accept.push(value);
      else if (key === "test") step.test.push(...splitList(value));
      else if (key === "tags") step.tags.push(...splitList(value).map((t) => t.toLowerCase()));
      else if (key === "depends") step.depends.push(...splitList(value));
    }
  });

  return { title, lines, phases, steps, problems };
}

export const TAGS = Object.freeze(["ui", "no-ui", "security", "db"]);
// Sentences the project template ships in place of real content; a plan still holding one was
// never finished by /autoclaude:plan.
export const TEMPLATE_PLACEHOLDERS = Object.freeze(["Not written yet.", "Nothing decided yet."]);
// Uppercase only, so a todo app's "todo" is fine; a file name such as TODO.md is not a marker.
const UNFINISHED_RE = /\b(TBD|TODO)\b(?!\.\w)/;
const INLINE_CODE_RE = /`[^`]*`/g;

// S1.10 -> [1, 10], so ids compare as numbers, not as text.
function idNumbers(id) {
  return id.replace(/^[A-Za-z]+/, "").split(".").map(Number);
}

function compareIds(a, b) {
  const x = idNumbers(a);
  const y = idNumbers(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? -1) - (y[i] ?? -1);
    if (d !== 0) return d;
  }
  return 0;
}

// Line indexes outside ``` and ~~~ fences, the same way parsePlan skips fenced blocks.
function proseLineIndexes(lines) {
  const out = [];
  let fence = null;
  lines.forEach((line, i) => {
    const m = line.match(FENCE_RE);
    if (m) { if (fence === null) fence = m[1]; else if (m[1] === fence) fence = null; return; }
    if (fence === null) out.push(i);
  });
  return out;
}

// Every rule of section 4.8.1. Returns [{ line, id, message }], empty when the plan is usable.
export function lintPlan(parsed) {
  const problems = [...parsed.problems];
  if (parsed.steps.length === 0) problems.push({ line: 0, id: null, message: "no steps found (a step line looks like `- [ ] **S1.1** Title`)" });
  const seen = new Map();
  const ids = new Set(parsed.steps.map((s) => s.id));
  for (const s of parsed.steps) {
    const at = s.line + 1;
    if (seen.has(s.id)) problems.push({ line: at, id: s.id, message: `duplicate step id ${s.id} (first at line ${seen.get(s.id)})` });
    else seen.set(s.id, at);
    if (!s.phase) problems.push({ line: at, id: s.id, message: "step is not under a `## Phase N: ...` heading" });
    if (!s.title) problems.push({ line: at, id: s.id, message: "step has no title" });
    if (s.accept.length === 0) problems.push({ line: at, id: s.id, message: "step has no `- Accept:` line (at least one is required)" });
    for (const d of s.depends) if (!ids.has(d)) problems.push({ line: at, id: s.id, message: `Depends refers to unknown step ${d}` });
    if (s.phase) {
      const m = s.id.match(/^[A-Za-z]+(\d+)\./);
      if (m && Number(m[1]) !== s.phase.num) problems.push({ line: at, id: s.id, message: `step id ${s.id} does not match its phase number ${s.phase.num}` });
    }
    for (const t of s.tags) if (!TAGS.includes(t)) problems.push({ line: at, id: s.id, message: `unknown tag "${t}" (use ${TAGS.slice(0, -1).join(", ")} or ${TAGS.at(-1)})` });
    if (s.tags.includes("ui") && s.tags.includes("no-ui")) problems.push({ line: at, id: s.id, message: "step is tagged both ui and no-ui" });
    // No browser checks a no-ui step, so a named test has to.
    if (s.tags.includes("no-ui") && s.test.length === 0) problems.push({ line: at, id: s.id, message: "a no-ui step needs a `- Test:` line naming the test that proves it (no browser checks it)" });
    const unfinished = [s.title, ...s.accept, ...s.test, ...s.tags, ...s.depends].map((v) => v.replace(INLINE_CODE_RE, "")).find((v) => UNFINISHED_RE.test(v));
    if (unfinished !== undefined) problems.push({ line: at, id: s.id, message: `step still says ${unfinished.match(UNFINISHED_RE)[1]}; settle it before the run, because nobody answers during it` });
  }

  const phaseAt = new Map();
  let prev = null;
  for (const ph of parsed.phases) {
    const at = ph.line + 1;
    if (phaseAt.has(ph.num)) problems.push({ line: at, id: null, message: `phase number ${ph.num} is used twice (first at line ${phaseAt.get(ph.num)})` });
    else {
      if (prev && ph.num < prev.num) problems.push({ line: at, id: null, message: `Phase ${ph.num} comes after Phase ${prev.num}; phases must be in ascending order` });
      phaseAt.set(ph.num, at);
    }
    prev = ph;
    if (ph.steps.length === 0) problems.push({ line: at, id: null, message: `Phase ${ph.num} has no steps (add steps under it or remove the heading)` });
    for (let i = 1; i < ph.steps.length; i++) {
      const a = ph.steps[i - 1];
      const b = ph.steps[i];
      if (compareIds(b.id, a.id) < 0) problems.push({ line: b.line + 1, id: b.id, message: `step id ${b.id} comes after ${a.id}; step ids must be in ascending order within a phase` });
    }
  }

  for (const i of proseLineIndexes(parsed.lines)) {
    const text = parsed.lines[i].replace(INLINE_CODE_RE, "");
    for (const p of TEMPLATE_PLACEHOLDERS) {
      if (text.includes(p)) problems.push({ line: i + 1, id: null, message: `template placeholder "${p}" is still in the plan; /autoclaude:plan replaces it with the real content` });
    }
  }
  return problems.sort((a, b) => a.line - b.line);
}

export function formatLint(problems) {
  return problems.map((p) => (p.line ? `  line ${p.line}${p.id ? ` (${p.id})` : ""}: ${p.message}` : `  ${p.message}`)).join("\n");
}

export function stepById(parsed, id) {
  return parsed.steps.find((s) => s.id === id) || null;
}

// The first step still marked [ ], in document order. Failed [!] and blocked [?] steps are not
// skipped over silently: they come first if they precede the next todo, so the caller can pause.
export function nextStep(parsed) {
  return parsed.steps.find((s) => s.marker === MARKERS.todo) || null;
}

export function firstUnfinished(parsed) {
  return parsed.steps.find((s) => !isFinished(s)) || null;
}

export function isPhaseEnd(parsed, id) {
  const s = stepById(parsed, id);
  if (!s || !s.phase) return false;
  return s.phase.steps[s.phase.steps.length - 1] === s;
}

// The step that closes its feature when verifyAt is "phase": every other step of its phase is
// done or built. Normally the phase's last step; after the owner unticks an earlier step of a
// closed phase, that step, so the phase is verified again instead of being left at [~].
export function isFeatureEnd(parsed, id) {
  const s = stepById(parsed, id);
  if (!s) return false;
  if (!s.phase) return true;
  return s.phase.steps.every((x) => x === s || isFinished(x));
}

// Built [~] steps that no verification would reach any more, put back to [ ] so that a ready
// verifies them. verifyAt "phase": a phase whose steps are all done or built (the owner ticked
// the step that would have closed it) gets its last built step back, and that step's ready
// verifies the whole phase. verifyAt "step" (switched from "phase" between runs): every built
// step, each then verified on its own ready. Returns { text, reopened: [ids] }.
export function reopenUnverified(text, verifyAt = "phase") {
  const parsed = parsePlan(text);
  const ids = [];
  if (verifyAt === "step") {
    for (const s of parsed.steps) if (s.marker === MARKERS.built) ids.push(s.id);
  } else {
    for (const ph of parsed.phases) {
      const built = ph.steps.filter((s) => s.marker === MARKERS.built);
      if (built.length && ph.steps.every(isFinished)) ids.push(built[built.length - 1].id);
    }
  }
  let out = text;
  for (const id of ids) out = setMarker(out, id, MARKERS.todo);
  return { text: out, reopened: ids };
}

export function progress(parsed) {
  const counts = { total: parsed.steps.length, done: 0, built: 0, todo: 0, failed: 0, blocked: 0 };
  for (const s of parsed.steps) {
    if (s.marker === MARKERS.done) counts.done++;
    else if (s.marker === MARKERS.built) counts.built++;
    else if (s.marker === MARKERS.failed) counts.failed++;
    else if (s.marker === MARKERS.blocked) counts.blocked++;
    else counts.todo++;
  }
  return counts;
}

// The step line plus its indented lines, exactly as written (for context injection).
export function stepText(parsed, step) {
  return parsed.lines.slice(step.line, step.lastLine + 1).map((l) => l.replace(/\r$/, "")).join("\n");
}

// Returns the new text with only the marker character of that step changed. Throws on an
// unknown id or marker. Every other byte, including line endings and a BOM, is preserved.
export function setMarker(text, id, marker) {
  if (!VALID_MARKERS.has(marker)) throw new Error(`invalid marker "${marker}"`);
  const parsed = parsePlan(text);
  const step = stepById(parsed, id);
  if (!step) throw new Error(`no step with id ${id}`);
  const lines = parsed.lines.slice();
  const line = lines[step.line];
  const idx = line.indexOf("- [");
  lines[step.line] = line.slice(0, idx + 3) + marker + line.slice(idx + 4);
  return lines.join("\n");
}

export function slugify(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "plan";
}

// Branch slug from the H1 ("# My App plan" -> "my-app"), or "plan".
export function planSlug(parsed) {
  return slugify((parsed.title || "").replace(/\bplan\b/i, "").trim());
}
