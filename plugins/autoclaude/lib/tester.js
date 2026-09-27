// The browser tester and the phase-end bug bash (PLAN.md 4.4, P4.1 to P4.4). A separate
// headless `claude -p` (lib/headless.js) with Playwright MCP opens the running app, checks the
// step's Accept lines (tester) or tries to break every feature of the phase (bug bash), and
// returns a JSON verdict. The gate turns that into pass, fail (counts as an attempt) or infra
// (the checker itself could not run; never counts as an attempt). Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { projectPaths, pluginRoot } from "./paths.js";
import { readText, readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { stepText, MARKERS } from "./plan.js";
import { runHeadless, buildArgs, runWithWrapUp } from "./headless.js";
import { playwrightMcpConfig } from "./init.js";
import * as git from "./git.js";

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "fail"] },
    criteria: {
      type: "array",
      items: {
        type: "object",
        properties: { text: { type: "string" }, result: { type: "string", enum: ["pass", "fail"] }, evidence: { type: "string" } },
        required: ["text", "result", "evidence"]
      }
    },
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          severity: { type: "string", enum: ["high", "medium", "low"] },
          title: { type: "string" },
          repro: { type: "string" },
          expected: { type: "string" },
          actual: { type: "string" }
        },
        required: ["severity", "title", "repro", "expected", "actual"]
      }
    },
    consoleErrors: { type: "array", items: { type: "string" } },
    testConcerns: { type: "array", items: { type: "string" } },
    notes: { type: "string" }
  },
  required: ["verdict", "criteria", "bugs", "consoleErrors", "testConcerns", "notes"]
};

// Playwright MCP tools, plus read-only file tools. Nothing that edits or runs commands.
export const ALLOWED_TOOLS = ["mcp__playwright", "Read", "Glob", "Grep"];

export const KINDS = {
  tester: { label: "Browser tester", prompt: "tester.md", turnsFactor: 1 },
  bugbash: { label: "Bug bash", prompt: "bugbash.md", turnsFactor: 1.5 }
};

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|e2e|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

// Substitutes {{KEY}} placeholders with function replacers, so "$" in plan text stays literal.
function fill(template, values) {
  let out = template;
  for (const [k, v] of Object.entries(values)) out = out.replace(new RegExp(`\\{\\{${k}\\}\\}`, "g"), () => String(v));
  return out;
}

export function buildPrompt(kind, { template, url, step, parsed, testChanges = "", screenshotDir, turns = 40 }) {
  const phaseSteps = step.phase ? step.phase.steps : [step];
  const verified = phaseSteps.filter((s) => s !== step && s.marker === MARKERS.done);
  const neighbours = verified.slice(-6).map((s) => stepText(parsed, s)).join("\n\n") || "(none yet)";
  const features = phaseSteps.filter((s) => s === step || s.marker === MARKERS.done).map((s) => stepText(parsed, s)).join("\n\n");
  return fill(template, {
    URL: url,
    STEP_ID: step.id,
    STEP_TEXT: stepText(parsed, step),
    NEIGHBOURS: neighbours,
    FEATURES: features,
    PHASE: step.phase ? `Phase ${step.phase.num}: ${step.phase.title}` : "the plan",
    TEST_CHANGES: testChanges || "(no test files changed)",
    SCREENSHOT_DIR: screenshotDir,
    TURNS: String(turns)
  });
}

// Test files the builder changed since the last verified commit, with the diff of the tracked
// ones, so the tester can spot a weakened assertion. Bounded in size.
export async function testChanges(root, env = process.env, maxChars = 6000) {
  const st = await git.status(root, { env });
  if (!st.ok) return "(could not read git status)";
  const files = st.entries.filter((e) => TEST_FILE_RE.test(String(e.path).replace(/\\/g, "/")));
  if (files.length === 0) return "(no test files changed)";
  const listed = files.map((e) => `${e.code} ${e.path}`).join("\n");
  const tracked = files.filter((e) => !String(e.code).includes("?")).map((e) => e.path);
  let diff = "";
  if (tracked.length) {
    const d = await git.git(root, ["diff", "HEAD", "--", ...tracked], { env });
    diff = d.ok ? d.stdout : "";
  }
  let text = `Changed test files:\n${listed}\n\nDiff of the tracked ones against the last verified commit:\n${diff.trim() || "(none; the changed files are new)"}`;
  if (text.length > maxChars) text = text.slice(0, maxChars) + "\n[... diff truncated ...]";
  return text;
}

// A per-run MCP config: the project's .autoclaude/mcp.playwright.json (so an owner's tweaks are
// kept) plus --headless, --isolated (a fresh in-memory browser profile per run) and --output-dir
// pointing at this attempt's screenshot folder. The server is always named "playwright", which
// is what ALLOWED_TOOLS refers to.
export function mcpConfigFor(root, outputDir) {
  const p = projectPaths(root);
  let base = null;
  try { base = readJson(p.mcpPlaywrightFile, null); } catch { base = null; }
  if (!base || !base.mcpServers) base = playwrightMcpConfig();
  const server = base.mcpServers.playwright || Object.values(base.mcpServers)[0];
  const args = [...(server.args || [])];
  if (!args.includes("--headless")) args.push("--headless");
  if (!args.includes("--isolated")) args.push("--isolated");
  if (!args.includes("--output-dir")) args.push("--output-dir", outputDir);
  const file = path.join(p.runtimeDir, "mcp.playwright.run.json");
  writeJsonAtomic(file, { mcpServers: { playwright: { ...server, args } } });
  return file;
}

// { valid, reason, passed, criteria, failing, high, other, bugs }
// Tester: strict; any failing criterion, a high bug or a "fail" verdict fails the step.
// Bug bash: its criteria are "works under normal use" per feature, and misuse findings are bugs;
// the step fails only on a failing criterion or a high bug. Its overall verdict word is not used,
// because a model tends to answer "fail" for a medium finding (seen live, 2026-09-27).
export function evaluateVerdict(kind, v) {
  if (!v || typeof v !== "object" || !["pass", "fail"].includes(v.verdict)) return { valid: false, reason: "the verdict is missing or malformed" };
  const criteria = Array.isArray(v.criteria) ? v.criteria : [];
  const bugs = Array.isArray(v.bugs) ? v.bugs : [];
  if (kind === "tester" && criteria.length === 0) return { valid: false, reason: "the tester returned no criteria" };
  const failing = criteria.filter((c) => c && c.result !== "pass");
  const high = bugs.filter((b) => b && b.severity === "high");
  const other = bugs.filter((b) => b && b.severity !== "high");
  const passed = failing.length === 0 && high.length === 0 && (kind === "bugbash" || v.verdict === "pass");
  return { valid: true, reason: null, passed, criteria, failing, high, other, bugs };
}

// Files a checker created in the project while it ran (seen live: screenshots saved by name
// land in the process's working directory) are moved into its report folder, so the gate's
// step commit can never pick them up. Needs git; a no-op outside a repository.
export async function untrackedSet(root, env) {
  const st = await git.status(root, { env });
  return st.ok ? new Set(st.entries.filter((e) => String(e.code).includes("?")).map((e) => e.path)) : null;
}

export async function sweepStrays(root, before, destDir, env = process.env) {
  if (!before) return [];
  const after = await untrackedSet(root, env);
  if (!after) return [];
  const moved = [];
  for (const rel of after) {
    if (before.has(rel)) continue;
    const from = path.join(root, rel);
    const to = path.join(destDir, "stray", rel);
    try {
      ensureDir(path.dirname(to));
      fs.renameSync(from, to);
      moved.push(rel);
    } catch {}
  }
  return moved;
}

function listImages(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (IMAGE_RE.test(e.name)) out.push(full);
    }
  };
  walk(dir);
  return out.sort();
}

const rel = (root, f) => path.relative(root, f).replace(/\\/g, "/");

export function verdictSection(kind, verdict, evaluation, meta = {}) {
  const label = KINDS[kind].label;
  const lines = [];
  if (evaluation.criteria.length) {
    lines.push("Criteria:");
    for (const c of evaluation.criteria) lines.push(`- [${c.result === "pass" ? "pass" : "FAIL"}] ${c.text}\n  Evidence: ${c.evidence}`);
  }
  if (evaluation.bugs.length) {
    lines.push("", "Bugs:");
    for (const b of evaluation.bugs) lines.push(`- ${b.severity}: ${b.title}\n  Repro: ${b.repro}\n  Expected: ${b.expected}\n  Actual: ${b.actual}`);
  }
  const consoleErrors = Array.isArray(verdict.consoleErrors) ? verdict.consoleErrors : [];
  if (consoleErrors.length) lines.push("", "Console errors:", ...consoleErrors.map((e) => `- ${e}`));
  const concerns = Array.isArray(verdict.testConcerns) ? verdict.testConcerns : [];
  if (concerns.length) lines.push("", "Test concerns:", ...concerns.map((e) => `- ${e}`));
  if (verdict.notes) lines.push("", `Notes: ${verdict.notes}`);
  if (meta.screenshots && meta.screenshots.length) lines.push("", "Screenshots:", ...meta.screenshots.map((s) => `- ${s}`));
  const bits = [meta.model && `model ${meta.model}`, meta.numTurns !== null && meta.numTurns !== undefined && `${meta.numTurns} turns`, meta.durationMs && `${Math.round(meta.durationMs / 1000)} s`, meta.tries > 1 && `${meta.tries} tries`, meta.wrappedUp && "answer given after reaching the turn limit", meta.verdictFile && `verdict ${meta.verdictFile}`].filter(Boolean);
  if (bits.length) lines.push("", `Run: ${bits.join(", ")}`);
  return { title: `${label}: ${evaluation.passed ? "passed" : "FAILED"}`, body: lines.join("\n").trim() };
}

// Runs the tester (kind "tester") or the bug bash (kind "bugbash") for one verification.
// Resolves to { status: "passed" | "failed" | "infra", failed, sections, followUps, verdictFile,
// screenshots }. `run` is injectable for tests. Retries once on an infrastructure failure when
// the gate's deadline leaves room for it.
export async function runBrowserCheck({ kind = "tester", root, config, step, parsed, env = process.env, attempt = 1, deadlineMs = Infinity, run = runHeadless, now = () => Date.now() }) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown browser check ${kind}`);
  const p = projectPaths(root);
  const tag = `${step.id}-${attempt}-${kind}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const shotsDir = path.join(p.reportsDir, tag);
  ensureDir(shotsDir);
  const template = readText(path.join(pluginRoot(), "prompts", k.prompt), "");
  const t = config.tester;
  const maxTurns = Math.round(t.maxTurns * k.turnsFactor);
  const prompt = buildPrompt(kind, {
    template,
    turns: maxTurns,
    url: config.devServer.url,
    step,
    parsed,
    testChanges: kind === "tester" ? await testChanges(root, env) : "",
    screenshotDir: shotsDir.replace(/\\/g, "/")
  });
  const mcpFile = mcpConfigFor(root, shotsDir.replace(/\\/g, "/"));
  // The checker's working directory is its own report folder, so anything it saves by a bare
  // file name lands there; --add-dir keeps the project readable for Read, Glob and Grep.
  const args = buildArgs({ model: t.model, maxTurns, schema: VERDICT_SCHEMA, mcpConfig: mcpFile, allowedTools: ALLOWED_TOOLS, extraArgs: ["--add-dir", root] });
  const before = await untrackedSet(root, env);

  const errors = [];
  let result = null;
  let evaluation = null;
  let tries = 0;
  let totalMs = 0;
  let cost = 0;
  while (tries < 2) {
    const remaining = deadlineMs - now();
    if (tries > 0 && remaining < t.timeoutSec * 1000 * 0.5) { errors.push("no time left for a retry before the gate's own timeout"); break; }
    tries++;
    const timeoutMs = Math.max(30000, Math.min(t.timeoutSec * 1000, remaining));
    result = await runWithWrapUp(run, { prompt, args, cwd: shotsDir, env, role: kind, timeoutMs });
    totalMs += result.durationMs || 0;
    if (typeof result.costUsd === "number") cost += result.costUsd;
    if (result.ok) {
      evaluation = evaluateVerdict(kind, result.structured);
      if (evaluation.valid) break;
      errors.push(evaluation.reason);
      result = { ...result, ok: false };
      evaluation = null;
    } else {
      errors.push(result.error);
    }
  }

  const strays = await sweepStrays(root, before, shotsDir, env);
  const screenshots = listImages(shotsDir).map((f) => rel(root, f));
  const verdictFile = path.join(p.reportsDir, `${tag}.json`);
  writeJsonAtomic(verdictFile, {
    kind, step: step.id, attempt, tries, ok: !!evaluation, errors, strays,
    verdict: result && result.structured ? result.structured : null,
    model: t.model, numTurns: result ? result.numTurns : null, costUsd: cost || null, durationMs: totalMs, screenshots,
    wrappedUp: !!(result && result.wrappedUp)
  });
  const verdictRel = rel(root, verdictFile);

  if (!evaluation) {
    return {
      status: "infra",
      failed: `${k.label} could not run (${tries} ${tries === 1 ? "try" : "tries"}): ${errors.join("; ")}`,
      sections: [{ title: `${k.label}: could not run`, body: `Tries: ${tries}\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}\nVerdict file: ${verdictRel}` }],
      followUps: [],
      verdictFile: verdictRel,
      screenshots
    };
  }

  const verdict = result.structured;
  const section = verdictSection(kind, verdict, evaluation, { model: t.model, numTurns: result.numTurns, durationMs: totalMs, tries, verdictFile: verdictRel, screenshots, wrappedUp: !!result.wrappedUp });
  const concerns = Array.isArray(verdict.testConcerns) ? verdict.testConcerns : [];
  const followUps = [
    ...evaluation.other.map((b) => ({ ...b, foundBy: kind })),
    ...concerns.map((c) => ({ severity: "low", title: "possible weakened or skipped test", repro: "", expected: "", actual: c, foundBy: kind }))
  ];
  if (evaluation.passed) return { status: "passed", failed: null, sections: [section], followUps, verdictFile: verdictRel, screenshots };
  const what = [
    ...evaluation.failing.map((c) => `criterion failed: ${c.text}`),
    ...evaluation.high.map((b) => `high bug: ${b.title}`)
  ];
  if (what.length === 0) what.push("the verdict was fail");
  return { status: "failed", failed: `${k.label.toLowerCase()}: ${what.slice(0, 3).join("; ")}${what.length > 3 ? ` (+${what.length - 3} more)` : ""}`, sections: [section], followUps, verdictFile: verdictRel, screenshots };
}
