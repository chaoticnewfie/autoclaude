// PLAN.md parsing, linting and marker updates. PLAN.md section 4.8.1.
// Only step lines and their indented fields are interpreted; everything else is prose.
// Node built-ins only. Byte-for-byte safe: text is split on "\n" and each line keeps
// its "\r" (if any), so writes change only the marker character.

export const MARKERS = Object.freeze({ todo: " ", done: "x", failed: "!", blocked: "?" });
const VALID_MARKERS = new Set(Object.values(MARKERS));

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
      if (!VALID_MARKERS.has(marker)) problems.push({ line: i + 1, id, message: `unknown marker "[${marker}]" (use [ ], [x], [!] or [?])` });
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
  }
  return problems;
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
  return parsed.steps.find((s) => s.marker !== MARKERS.done) || null;
}

export function isPhaseEnd(parsed, id) {
  const s = stepById(parsed, id);
  if (!s || !s.phase) return false;
  return s.phase.steps[s.phase.steps.length - 1] === s;
}

export function progress(parsed) {
  const counts = { total: parsed.steps.length, done: 0, todo: 0, failed: 0, blocked: 0 };
  for (const s of parsed.steps) {
    if (s.marker === MARKERS.done) counts.done++;
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
