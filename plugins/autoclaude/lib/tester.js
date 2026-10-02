// The browser tester and the phase-end bug bash (PLAN.md 4.4, P4.1 to P4.4). A separate
// headless `claude -p` (lib/headless.js) with Playwright MCP opens the running app, checks the
// Accept lines (tester) or tries to break every feature of the phase (bug bash), and returns a
// JSON verdict. The gate turns that into pass, fail (counts as an attempt) or infra (the checker
// itself could not run; never counts as an attempt). With verification once per feature (D49)
// the gate passes the whole phase as `steps`: one criterion per Accept line of every step, and a
// turn budget that grows with the number of lines. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { projectPaths, pluginRoot } from "./paths.js";
import { readText, readJson, writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { stepText, MARKERS } from "./plan.js";
import { loadState } from "./state.js";
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
    notes: { type: "string" },
    // The checker had no working browser (Playwright MCP missing or not connecting): nothing was
    // checked, so it is "could not run", never a failed attempt (practice run, 2026-09-29).
    browserUnavailable: { type: "boolean" }
  },
  required: ["verdict", "criteria", "bugs", "consoleErrors", "testConcerns", "notes", "browserUnavailable"]
};

// Claude Code gives an MCP server this long to start unless the owner set their own. npx can
// need more than the default the first time or on a busy machine: in the practice run the
// tester's Playwright MCP timed out on connect and the tester checked nothing.
export const MCP_START_MS = "120000";
export function checkerEnv(env) {
  return { ...env, MCP_TIMEOUT: env.MCP_TIMEOUT || MCP_START_MS, MCP_CONNECT_TIMEOUT_MS: env.MCP_CONNECT_TIMEOUT_MS || MCP_START_MS };
}

// Playwright MCP tools, plus read-only file tools. Nothing that edits or runs commands.
export const ALLOWED_TOOLS = ["mcp__playwright", "Read", "Glob", "Grep"];

export const KINDS = {
  tester: { label: "Browser tester", prompt: "tester.md", turnsFactor: 1 },
  bugbash: { label: "Bug bash", prompt: "bugbash.md", turnsFactor: 1.5 }
};

const TEST_FILE_RE = /(^|\/)(tests?|__tests__|e2e|specs?)\/|\.(test|spec)\.[cm]?[jt]sx?$/i;
const IMAGE_RE = /\.(png|jpe?g|webp)$/i;

// Single pass with a function replacer: "$" in plan text stays literal, and a placeholder that
// appears inside plan text or a diff is never expanded.
function fill(template, values) {
  return template.replace(/\{\{([A-Z_]+)\}\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

const BUILT = MARKERS.built || "~";
const isNoUi = (s) => Array.isArray(s.tags) && s.tags.includes("no-ui");

export function acceptCount(steps) {
  return steps.reduce((n, s) => n + (Array.isArray(s.accept) ? s.accept.length : 0), 0);
}

// The tester's budget: tester.maxTurns for every 5 Accept lines, never less than 1x, at most 4x.
export function turnScale(lines) {
  return Math.min(4, Math.max(1, Math.ceil(lines / 5)));
}

// The steps a browser check covers: the step, or in phase mode the feature (the tester leaves
// out no-ui steps).
function checkedSteps(kind, step, steps) {
  const phaseMode = Array.isArray(steps) && steps.length > 0;
  return !phaseMode ? [step || steps[steps.length - 1]] : kind === "tester" ? steps.filter((s) => !isNoUi(s)) : steps;
}

// The time a browser check allows itself (tester.timeoutSec, scaled for the tester like its
// turns), so the gate can share its own time out among the checkers in proportion.
export function browserTimeoutSec(kind, config, { step = null, steps = null } = {}) {
  const list = checkedSteps(kind, step, steps);
  return config.tester.timeoutSec * (kind === "tester" ? turnScale(acceptCount(list)) : 1);
}

// A retry needs at least this, and half of what the first try was given.
export const MIN_RETRY_MS = 60000;

// steps: the whole feature (phase mode); otherwise the single step, with the features verified
// earlier in its phase to smoke-check.
export function buildPrompt(kind, { template, url, step = null, steps = null, parsed, testChanges = "", screenshotDir, turns = 40 }) {
  const phaseMode = Array.isArray(steps) && steps.length > 0;
  const list = phaseMode ? steps : [step];
  const anchor = step || list[list.length - 1];
  const phase = anchor.phase || null;
  const phaseName = phase ? `Phase ${phase.num}: ${phase.title}` : "the plan";
  const text = (s) => stepText(parsed, s);
  let neighbours;
  let features;
  if (phaseMode) {
    neighbours = "(none: every step of this feature is under test above)";
    features = list.map(text).join("\n\n");
  } else {
    const phaseSteps = phase ? phase.steps : [anchor];
    const verified = phaseSteps.filter((s) => s !== anchor && s.marker === MARKERS.done);
    neighbours = verified.slice(-6).map(text).join("\n\n") || "(none yet)";
    // Built steps ([~]) belong to the feature too, before its verification ticks them.
    features = phaseSteps.filter((s) => s === anchor || s.marker === MARKERS.done || s.marker === BUILT).map(text).join("\n\n");
  }
  const ids = list.map((s) => s.id);
  return fill(template, {
    URL: url,
    STEP_ID: phaseMode ? ids.join(", ") : anchor.id,
    EXAMPLE_ID: list[0].id,
    UNIT: phaseMode ? "feature" : "step",
    SCOPE: phaseMode ? `The feature under test: ${phaseName} (${ids.length === 1 ? `step ${ids[0]}` : `steps ${ids.join(", ")}`})` : `The step under test: ${anchor.id}`,
    STEP_TEXT: list.map(text).join("\n\n"),
    ACCEPT_COUNT: String(acceptCount(list)),
    SMOKE: phaseMode
      ? "Every step of this feature is listed above, so there is nothing else to smoke-check. If one step's work breaks another's, that is a failing criterion of the step that no longer works."
      : "Smoke-check the features that were already verified earlier in this phase (listed below) with one quick action each. If one of them no longer works, that is a bug with severity high.",
    VERIFIED_SECTION: phaseMode ? "" : `## Features already verified in this phase\n\n${neighbours}`,
    NEIGHBOURS: neighbours,
    FEATURES: features,
    PHASE: phaseName,
    TEST_CHANGES: testChanges || "(no test files changed)",
    SCREENSHOT_DIR: screenshotDir,
    TURNS: String(turns)
  });
}

// Test files the builder changed, with the diff of the tracked ones, so the tester can spot a
// weakened assertion. Without a base: the uncommitted changes since the last commit (a step
// verified on its own). With one: everything since that commit, committed or not, which in
// phase mode is the whole feature (its steps are committed as they are built). Bounded in size.
export async function testChanges(root, env = process.env, maxChars = 6000, base = null) {
  const st = await git.status(root, { env });
  if (!st.ok) return "(could not read git status)";
  let entries = st.entries;
  if (base) {
    const d = await git.git(root, ["diff", "--name-status", "--no-renames", base], { env });
    if (d.ok) {
      const tracked = d.stdout.split(/\r?\n/).filter(Boolean).map((l) => { const [code, ...rest] = l.split("\t"); return { code: code.trim().padEnd(2), path: rest.join("\t") }; });
      entries = [...tracked, ...st.entries.filter((e) => String(e.code).includes("?"))];
    } else {
      base = null; // an unknown base: fall back to the uncommitted changes
    }
  }
  const files = entries.filter((e) => TEST_FILE_RE.test(String(e.path).replace(/\\/g, "/")));
  if (files.length === 0) return "(no test files changed)";
  const listed = files.map((e) => `${e.code} ${e.path}`).join("\n");
  const tracked = files.filter((e) => !String(e.code).includes("?")).map((e) => e.path);
  let diff = "";
  if (tracked.length) {
    const d = await git.git(root, ["diff", base || "HEAD", "--", ...tracked], { env });
    diff = d.ok ? d.stdout : "";
  }
  const against = base ? `the commit this feature started from (${String(base).slice(0, 7)})` : "the last verified commit";
  let text = `Changed test files:\n${listed}\n\nDiff of the tracked ones against ${against}:\n${diff.trim() || "(none; the changed files are new)"}`;
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
  // A short list usually means lines were merged or skipped; the owner should know, but it does
  // not fail the feature by itself (a merged pair would burn an attempt for nothing).
  if (kind === "tester" && meta.expectedCriteria && evaluation.criteria.length < meta.expectedCriteria) {
    lines.push("", `Coverage: ${evaluation.criteria.length} criteria reported for ${meta.expectedCriteria} Accept lines; compare them with the plan.`);
  }
  if (meta.screenshots && meta.screenshots.length) lines.push("", "Screenshots:", ...meta.screenshots.map((s) => `- ${s}`));
  const bits = [meta.model && `model ${meta.model}`, meta.numTurns !== null && meta.numTurns !== undefined && `${meta.numTurns} turns`, meta.durationMs && `${Math.round(meta.durationMs / 1000)} s`, meta.tries > 1 && `${meta.tries} tries`, meta.wrappedUp && "answer given after reaching the turn limit", meta.verdictFile && `verdict ${meta.verdictFile}`].filter(Boolean);
  if (bits.length) lines.push("", `Run: ${bits.join(", ")}`);
  return { title: `${label}: ${evaluation.passed ? "passed" : "FAILED"}`, body: lines.join("\n").trim() };
}

// Runs the tester (kind "tester") or the bug bash (kind "bugbash") for one verification.
// Resolves to { status: "passed" | "failed" | "infra" | "out-of-time", failed, sections,
// followUps, verdictFile, screenshots }. `run` is injectable for tests. Retries once on an
// infrastructure failure when the deadline leaves room for it. "out-of-time": the deadline
// (the gate's time for this checker), not the checker's own timeout, stopped it; that is a
// verification too big for one stop, not a machine problem. Takes `steps` (the whole feature,
// phase mode) or `step`; in phase mode the tester leaves out steps tagged no-ui (their tests
// verify them), and its test changes run from state.phaseBaseCommit (read from the run state
// when not passed).
export async function runBrowserCheck({ kind = "tester", root, config, step = null, steps = null, parsed, state = null, env = process.env, attempt = 1, deadlineMs = Infinity, run = runHeadless, now = () => Date.now() }) {
  const k = KINDS[kind];
  if (!k) throw new Error(`unknown browser check ${kind}`);
  const phaseMode = Array.isArray(steps) && steps.length > 0;
  if (!phaseMode && !step) throw new Error("runBrowserCheck needs a step or steps");
  const anchor = step || steps[steps.length - 1];
  const list = checkedSteps(kind, step, steps);
  if (list.length === 0) {
    return { status: "passed", failed: null, sections: [{ title: `${k.label}: skipped`, body: "Every step of this feature is tagged no-ui; its tests verify it." }], followUps: [], verdictFile: null, screenshots: [] };
  }
  const p = projectPaths(root);
  const tag = `${anchor.id}-${attempt}-${kind}`.replace(/[^A-Za-z0-9._-]/g, "_");
  const shotsDir = path.join(p.reportsDir, tag);
  ensureDir(shotsDir);
  const template = readText(path.join(pluginRoot(), "prompts", k.prompt), "");
  const t = config.tester;
  const lines = acceptCount(list);
  // The bug bash keeps its own budget; the tester's grows with the Accept lines it must check.
  const scale = kind === "tester" ? turnScale(lines) : 1;
  const maxTurns = Math.round(t.maxTurns * k.turnsFactor * scale);
  const timeoutSec = t.timeoutSec * scale;
  let base = null;
  if (phaseMode && kind === "tester") {
    const s = state || (() => { try { return loadState(root); } catch { return null; } })();
    base = s && s.phaseBaseCommit ? s.phaseBaseCommit : null;
  }
  const prompt = buildPrompt(kind, {
    template,
    turns: maxTurns,
    url: config.devServer.url,
    step: anchor,
    steps: phaseMode ? list : null,
    parsed,
    testChanges: kind === "tester" ? await testChanges(root, env, 6000, base) : "",
    screenshotDir: shotsDir.replace(/\\/g, "/")
  });
  const mcpFile = mcpConfigFor(root, shotsDir.replace(/\\/g, "/"));
  // The checker's working directory is its own report folder, so anything it saves by a bare
  // file name lands there; --add-dir keeps the project readable for Read, Glob and Grep.
  const args = buildArgs({ model: t.model, effort: config.checkers ? config.checkers.effort : null, maxTurns, schema: VERDICT_SCHEMA, mcpConfig: mcpFile, allowedTools: ALLOWED_TOOLS, extraArgs: ["--add-dir", root] });
  const before = await untrackedSet(root, env);

  const errors = [];
  let result = null;
  let evaluation = null;
  let tries = 0;
  let totalMs = 0;
  let cost = 0;
  // The last try was stopped by the deadline rather than by the checker's own timeout.
  let cut = false;
  const firstBudget = Math.max(0, Math.min(timeoutSec * 1000, deadlineMs - now()));
  while (tries < 2) {
    const remaining = deadlineMs - now();
    if (tries > 0 && remaining < Math.max(MIN_RETRY_MS, firstBudget * 0.5)) { errors.push("no time left for a retry before the gate's own timeout"); break; }
    tries++;
    const timeoutMs = Math.max(30000, Math.min(timeoutSec * 1000, remaining));
    result = await runWithWrapUp(run, { prompt, args, cwd: shotsDir, env: checkerEnv(env), role: kind, timeoutMs, deadlineMs });
    cut = !result.ok && !!result.timedOut && timeoutMs < timeoutSec * 1000;
    totalMs += result.durationMs || 0;
    if (typeof result.costUsd === "number") cost += result.costUsd;
    if (result.ok) {
      evaluation = evaluateVerdict(kind, result.structured);
      if (evaluation.valid && result.structured.browserUnavailable === true) {
        const why = String(result.structured.notes || "").trim().slice(0, 300);
        evaluation = { valid: false, reason: `it had no working browser${why ? `: ${why}` : ""}` };
      }
      if (evaluation.valid) break;
      errors.push(evaluation.reason);
      result = { ...result, ok: false };
      evaluation = null;
    } else {
      errors.push(cut ? `stopped at the gate's deadline after ${Math.round(timeoutMs / 1000)} s (its own limit is ${timeoutSec} s)` : result.error);
    }
    if (cut) break;
  }

  const strays = await sweepStrays(root, before, shotsDir, env);
  const screenshots = listImages(shotsDir).map((f) => rel(root, f));
  const verdictFile = path.join(p.reportsDir, `${tag}.json`);
  writeJsonAtomic(verdictFile, {
    kind, step: anchor.id, steps: list.map((s) => s.id), acceptLines: lines, maxTurns, attempt, tries, ok: !!evaluation, errors, strays,
    verdict: result && result.structured ? result.structured : null,
    model: t.model, numTurns: result ? result.numTurns : null, costUsd: cost || null, durationMs: totalMs, screenshots,
    wrappedUp: !!(result && result.wrappedUp)
  });
  const verdictRel = rel(root, verdictFile);

  if (!evaluation && cut) {
    return {
      status: "out-of-time",
      failed: `${k.label} ran out of the gate's time (${tries} ${tries === 1 ? "try" : "tries"}): ${errors.join("; ")}`,
      sections: [{ title: `${k.label}: out of time`, body: `Tries: ${tries}\nErrors:\n${errors.map((e) => `- ${e}`).join("\n")}\nVerdict file: ${verdictRel}` }],
      followUps: [],
      verdictFile: verdictRel,
      screenshots
    };
  }
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
  const section = verdictSection(kind, verdict, evaluation, { model: t.model, numTurns: result.numTurns, durationMs: totalMs, tries, verdictFile: verdictRel, screenshots, wrappedUp: !!result.wrappedUp, expectedCriteria: kind === "tester" ? lines : null });
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
