// The security reviewer (PLAN.md 4.4, D13, P5.4). A separate headless `claude -p`
// (lib/headless.js) with read-only file tools and no MCP server reads the diff since the
// feature's first commit (or the last phase tag, or the run's start commit) and returns a JSON
// verdict with findings. Findings at or
// above `security.blockOn` fail the step (an attempt); the rest go back to the gate to file in
// docs/SECURITY-FINDINGS.md. An unusable answer is an infrastructure failure, retried once, the
// same rule as the browser checks (D35). Node built-ins only.
import path from "node:path";
import { projectPaths, pluginRoot } from "./paths.js";
import { readText, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { stepText, isPhaseEnd } from "./plan.js";
import { runHeadless, buildArgs, runWithWrapUp } from "./headless.js";
import { untrackedSet, sweepStrays } from "./tester.js";
import * as git from "./git.js";

const SEVERITIES = ["high", "medium", "low"];

export const SECURITY_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: SEVERITIES },
          file: { type: "string" },
          line: { type: "integer" },
          issue: { type: "string" },
          fix: { type: "string" }
        },
        required: ["severity", "file", "line", "issue", "fix"]
      }
    },
    notes: { type: "string" }
  },
  required: ["verdict", "findings", "notes"]
};

// Read-only. No Bash, no MCP server (buildArgs gets no MCP config, so only --strict-mcp-config).
export const SECURITY_TOOLS = ["Read", "Glob", "Grep"];

const LABEL = "Security review";
const MAX_TURNS = 40;
const MAX_UNTRACKED = 200;
const RANK = { high: 3, medium: 2, low: 1 };
const THRESHOLD = { high: 3, medium: 2, low: 1, none: Infinity };

export function securityWanted(config, step, parsed) {
  const when = config && config.security && Array.isArray(config.security.when) ? config.security.when : [];
  if (when.length === 0 || when.includes("never")) return false;
  if (when.includes("every-step")) return true;
  if (when.includes("phase-end") && isPhaseEnd(parsed, step.id)) return true;
  if (when.includes("tag:security") && Array.isArray(step.tags) && step.tags.includes("security")) return true;
  return false;
}

// The diff base: the commit the current feature started from (state.phaseBaseCommit, set while
// a feature is built step by step, D49), so the review covers the whole feature; else the newest
// `ac-phase-*` tag reachable from HEAD, else the commit the run started from, else null (the
// caller then reviews the uncommitted changes against HEAD).
export async function securityBase(root, state, env = process.env) {
  if (state && state.phaseBaseCommit) return state.phaseBaseCommit;
  const r = await git.git(root, ["describe", "--tags", "--match", "ac-phase-*", "--abbrev=0", "HEAD"], { env });
  const tag = r.ok ? r.stdout.trim() : "";
  if (tag) return tag;
  return (state && state.baseCommit) || null;
}

// The review text: the stat and the full diff of the working tree against the base (so the
// commits since the base and the step's uncommitted changes), plus the untracked files, which
// git diff leaves out. Over maxChars, the diff is cut and the stat and the file list are kept.
export async function reviewDiff(root, base, env = process.env, maxChars = 40000) {
  const against = base || "HEAD";
  const stat = await git.git(root, ["diff", "--no-color", "--stat", against], { env });
  const full = await git.git(root, ["diff", "--no-color", against], { env });
  const untracked = await untrackedSet(root, env);
  const files = untracked ? [...untracked].sort() : [];
  const shown = files.slice(0, MAX_UNTRACKED);
  if (files.length > shown.length) shown.push(`(+${files.length - shown.length} more)`);

  const statText = stat.ok ? stat.stdout.replace(/\s+$/, "") || "(no changes to tracked files)" : `(could not read the diff: ${String(stat.stderr).trim().slice(0, 300)})`;
  const head = [
    `Diff base: ${base || "HEAD (no phase tag and no run start commit; only the uncommitted changes are shown)"}`,
    "",
    `Changed tracked files (git diff --stat ${against}):`,
    statText,
    "",
    "New untracked files (not in the diff below; Read each one):",
    untracked ? (shown.join("\n") || "(none)") : "(could not read git status)",
    "",
    `Diff (git diff ${against}):`,
    ""
  ].join("\n");
  let diff = full.ok ? full.stdout.replace(/\s+$/, "") || "(no changes to tracked files)" : "(not available)";
  if (head.length + diff.length > maxChars) {
    const total = diff.length;
    const budget = Math.max(0, maxChars - head.length - 200);
    const cut = diff.lastIndexOf("\n", budget);
    diff = diff.slice(0, cut > 0 ? cut : budget);
    diff += `${diff ? "\n" : ""}[... diff truncated: ${diff.length} of ${total} characters shown. Read the changed files listed above that you need from the project folder ...]`;
  }
  return head + diff;
}

// { valid, reason, passed, findings, blocking, other }. The verdict word is informational: the
// step fails only on findings at or above blockOn (the same idea as the bug bash, D35).
export function evaluateSecurity(verdict, blockOn = "high") {
  const v = verdict;
  if (!v || typeof v !== "object" || !["pass", "fail"].includes(v.verdict) || !Array.isArray(v.findings)) return { valid: false, reason: "the verdict is missing or malformed" };
  if (v.findings.some((f) => !f || typeof f !== "object" || !SEVERITIES.includes(f.severity))) return { valid: false, reason: "a finding is malformed (no known severity)" };
  const threshold = THRESHOLD[blockOn] === undefined ? THRESHOLD.high : THRESHOLD[blockOn];
  const blocking = v.findings.filter((f) => RANK[f.severity] >= threshold);
  const other = v.findings.filter((f) => RANK[f.severity] < threshold);
  return { valid: true, reason: null, passed: blocking.length === 0, findings: v.findings, blocking, other };
}

// "lib/db.js:12", or just the file when the line is unknown (0).
function where(f) {
  const line = Number(f.line);
  return `${f.file || "(no file)"}${line > 0 ? `:${line}` : ""}`;
}

export function securitySection(verdict, evaluation, meta = {}) {
  const lines = [];
  const findings = evaluation.findings || [...evaluation.blocking, ...evaluation.other];
  if (findings.length) {
    lines.push("Findings:");
    for (const f of findings) lines.push(`- ${f.severity}: ${where(f)} ${f.issue}\n  Fix: ${f.fix}`);
  } else {
    lines.push("No findings.");
  }
  if (verdict && verdict.notes) lines.push("", `Notes: ${verdict.notes}`);
  const bits = [
    meta.model && `model ${meta.model}`,
    meta.numTurns !== null && meta.numTurns !== undefined && `${meta.numTurns} turns`,
    meta.durationMs && `${Math.round(meta.durationMs / 1000)} s`,
    meta.tries > 1 && `${meta.tries} tries`,
    meta.blockOn && `blocks on ${meta.blockOn}`,
    meta.base && `base ${meta.base}`,
    meta.verdictFile && `verdict ${meta.verdictFile}`
  ].filter(Boolean);
  if (bits.length) lines.push("", `Run: ${bits.join(", ")}`);
  return { title: `${LABEL}: ${evaluation.passed ? "passed" : "FAILED"}`, body: lines.join("\n").trim() };
}

// Single pass with a function replacer: "$" in plan text stays literal, and a placeholder that
// appears inside the diff is never expanded.
function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

export const CONSTRAINTS_MAX_CHARS = 6000;
const CONSTRAINTS_CUT = "\n[... cut here; Read the rest of this section in the plan ...]";

// The body of the plan's "## Constraints & decisions" section, up to the next "## " heading (its
// "###" subsections included, headings inside code fences ignored), at most maxChars long. The
// reviewer needs it to tell the owner's deliberate choices (no login, 127.0.0.1 only) from
// mistakes; without it such a choice failed every attempt as a high finding.
export function constraintsSection(planText, maxChars = CONSTRAINTS_MAX_CHARS) {
  const lines = String(planText || "").replace(/\r\n?/g, "\n").split("\n");
  const start = lines.findIndex((l) => /^##\s+Constraints\s*(?:&|and)\s*decisions\b/i.test(l));
  if (start < 0) return "";
  let end = lines.length;
  let fence = null;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*(```|~~~)/.exec(lines[i]);
    if (m) { fence = fence === null ? m[1] : fence === m[1] ? null : fence; continue; }
    if (fence === null && /^##\s/.test(lines[i])) { end = i; break; }
  }
  const text = lines.slice(start + 1, end).join("\n").trim();
  if (text.length <= maxChars) return text;
  const budget = Math.max(0, maxChars - CONSTRAINTS_CUT.length);
  const cut = text.lastIndexOf("\n", budget);
  return text.slice(0, cut > 0 ? cut : budget).replace(/\s+$/, "") + CONSTRAINTS_CUT;
}

// The steps whose changes the diff holds: the given list, or, when the diff runs from the
// feature's start (phaseBaseCommit), the phase's steps up to this one; else just this step.
export function reviewedSteps(step, state = null, steps = null) {
  if (Array.isArray(steps) && steps.length) return steps;
  if (state && state.phaseBaseCommit && step.phase) {
    const i = step.phase.steps.indexOf(step);
    if (i >= 0) return step.phase.steps.slice(0, i + 1);
  }
  return [step];
}

export function buildSecurityPrompt({ template, step, steps = null, parsed, base, diff, root, planText = null, planFile = "PLAN.md" }) {
  const text = planText !== null ? planText : parsed && Array.isArray(parsed.lines) ? parsed.lines.join("\n") : "";
  const constraints = constraintsSection(text);
  const list = Array.isArray(steps) && steps.length ? steps : [step];
  const scope = list.length > 1 && step.phase ? `Phase ${step.phase.num}: ${step.phase.title} (steps ${list.map((s) => s.id).join(", ")})` : list.map((s) => s.id).join(", ");
  return fill(template, {
    STEP_ID: scope,
    STEP_TEXT: list.map((s) => stepText(parsed, s)).join("\n\n"),
    BASE: base || "HEAD",
    DIFF: diff,
    PROJECT_ROOT: String(root).replace(/\\/g, "/"),
    PLAN_FILE: planFile,
    CONSTRAINTS: constraints || "(The plan has no \"Constraints & decisions\" section.)"
  });
}

// A finding's file as a project-relative path with forward slashes, when the reviewer gave an
// absolute path inside the project.
function relFile(root, file) {
  const s = String(file || "");
  if (!s || !path.isAbsolute(s)) return s.replace(/\\/g, "/");
  const r = path.relative(root, s);
  return r && !r.startsWith("..") && !path.isAbsolute(r) ? r.replace(/\\/g, "/") : s.replace(/\\/g, "/");
}

const rel = (root, f) => path.relative(root, f).replace(/\\/g, "/");

// A retry needs at least this, and half of what the first try was given.
const MIN_RETRY_MS = 60000;

// Runs the security reviewer once for a verification. Resolves to { status: "passed" | "failed"
// | "infra" | "out-of-time", failed, sections, findings (the non-blocking ones, for the gate to
// file), verdictFile, strays }. `run` is injectable for tests. Retries once on an
// infrastructure failure when the deadline leaves room for it. "out-of-time": the deadline (the
// gate's time for this checker), not security.timeoutSec, stopped it.
export async function runSecurityReview({ root, config, step = null, steps = null, parsed, state = null, env = process.env, attempt = 1, deadlineMs = Infinity, run = runHeadless, now = () => Date.now() }) {
  if (!step && !(Array.isArray(steps) && steps.length)) throw new Error("runSecurityReview needs a step or steps");
  step = step || steps[steps.length - 1];
  const p = projectPaths(root);
  const s = config.security;
  const tag = `${step.id}-${attempt}-security`.replace(/[^A-Za-z0-9._-]/g, "_");
  const reportDir = path.join(p.reportsDir, tag);
  ensureDir(reportDir);
  const base = await securityBase(root, state, env);
  const diff = await reviewDiff(root, base, env);
  const template = readText(path.join(pluginRoot(), "prompts", "security.md"), "");
  const reviewed = reviewedSteps(step, state, steps);
  const prompt = buildSecurityPrompt({ template, step, steps: reviewed, parsed, base, diff, root, planFile: config.plan });
  // The reviewer works inside its report folder; --add-dir keeps the project readable.
  const args = buildArgs({ model: s.model, effort: config.checkers ? config.checkers.effort : null, maxTurns: MAX_TURNS, schema: SECURITY_SCHEMA, mcpConfig: null, allowedTools: SECURITY_TOOLS, extraArgs: ["--add-dir", root] });
  const before = await untrackedSet(root, env);

  const errors = [];
  let result = null;
  let evaluation = null;
  let verdict = null;
  let tries = 0;
  let totalMs = 0;
  let cost = 0;
  // The last try was stopped by the deadline rather than by security.timeoutSec.
  let cut = false;
  const firstBudget = Math.max(0, Math.min(s.timeoutSec * 1000, deadlineMs - now()));
  while (tries < 2) {
    const remaining = deadlineMs - now();
    if (tries > 0 && remaining < Math.max(MIN_RETRY_MS, firstBudget * 0.5)) { errors.push("no time left for a retry before the gate's own timeout"); break; }
    tries++;
    const timeoutMs = Math.max(30000, Math.min(s.timeoutSec * 1000, remaining));
    result = await runWithWrapUp(run, { prompt, args, cwd: reportDir, env, role: "security", timeoutMs, deadlineMs });
    cut = !result.ok && !!result.timedOut && timeoutMs < s.timeoutSec * 1000;
    totalMs += result.durationMs || 0;
    if (typeof result.costUsd === "number") cost += result.costUsd;
    if (cut) { errors.push(`stopped at the gate's deadline after ${Math.round(timeoutMs / 1000)} s (its own limit is ${s.timeoutSec} s)`); break; }
    if (result.ok) {
      const raw = result.structured;
      verdict = raw && typeof raw === "object" && Array.isArray(raw.findings)
        ? { ...raw, findings: raw.findings.map((f) => (f && typeof f === "object" ? { ...f, file: relFile(root, f.file) } : f)) }
        : raw;
      evaluation = evaluateSecurity(verdict, s.blockOn);
      if (evaluation.valid) break;
      errors.push(evaluation.reason);
      result = { ...result, ok: false };
      evaluation = null;
    } else {
      errors.push(result.error);
    }
  }

  const strays = await sweepStrays(root, before, reportDir, env);
  const verdictFile = path.join(p.reportsDir, `${tag}.json`);
  writeJsonAtomic(verdictFile, {
    kind: "security", step: step.id, steps: reviewed.map((x) => x.id), attempt, tries, ok: !!evaluation, errors, strays, base, blockOn: s.blockOn,
    verdict: result && result.structured ? result.structured : null,
    model: s.model, numTurns: result ? result.numTurns : null, costUsd: cost || null, durationMs: totalMs
  });
  const verdictRel = rel(root, verdictFile);

  if (!evaluation && cut) {
    return {
      status: "out-of-time",
      failed: `${LABEL} ran out of the gate's time (${tries} ${tries === 1 ? "try" : "tries"}): ${errors.join("; ")}`,
      sections: [{ title: `${LABEL}: out of time`, body: `Tries: ${tries}\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}\nVerdict file: ${verdictRel}` }],
      findings: [],
      verdictFile: verdictRel,
      strays
    };
  }
  if (!evaluation) {
    return {
      status: "infra",
      failed: `${LABEL} could not run (${tries} ${tries === 1 ? "try" : "tries"}): ${errors.join("; ")}`,
      sections: [{ title: `${LABEL}: could not run`, body: `Tries: ${tries}\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}\nVerdict file: ${verdictRel}` }],
      findings: [],
      verdictFile: verdictRel,
      strays
    };
  }

  const section = securitySection(verdict, evaluation, { model: s.model, numTurns: result.numTurns, durationMs: totalMs, tries, blockOn: s.blockOn, base, verdictFile: verdictRel });
  if (evaluation.passed) return { status: "passed", failed: null, sections: [section], findings: evaluation.other, verdictFile: verdictRel, strays };
  const what = evaluation.blocking.map((f) => `${f.severity}: ${where(f)} ${f.issue}`);
  return {
    status: "failed",
    failed: `${LABEL.toLowerCase()}: ${what.slice(0, 3).join("; ")}${what.length > 3 ? ` (+${what.length - 3} more)` : ""}`,
    sections: [section],
    findings: evaluation.other,
    verdictFile: verdictRel,
    strays
  };
}
