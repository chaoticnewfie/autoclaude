// Failure reports for the Stop gate (PLAN.md section 4.4): the full markdown file under
// <project>/.autoclaude/reports/<step>-<attempt>.md, and the short summary that goes back to
// Claude as the block reason, capped so the hook output is never truncated by Claude Code.
// Node built-ins only.
import path from "node:path";
import { writeFileAtomic } from "./fsatomic.js";
import { projectPaths } from "./paths.js";

export const SUMMARY_MAX_CHARS = 4000;
const TRUNCATED_LINE = "[... truncated, see the full report ...]";

// Absolute path of the report file for one attempt of one step.
export function reportPath(root, step, attempt) {
  const name = `${String(step)}-${String(attempt)}`.replace(/[<>:"/\\|?*\s]/g, "_");
  return path.join(projectPaths(path.resolve(root)).reportsDir, `${name}.md`);
}

// Writes the report: an H1, the timestamp, then one H2 per section. A section is
// { title, body, code? }; with code true the body goes in a fenced block.
// Returns { path (absolute), relPath (relative to root, forward slashes) }.
export function writeReport({ root, step, attempt, title = null, sections = [], now = new Date() }) {
  const absRoot = path.resolve(root);
  const file = reportPath(absRoot, step, attempt);
  const heading = title || `AutoClaude report: ${step} attempt ${attempt}`;
  const lines = [`# ${heading}`, "", `Generated: ${now.toISOString()}`, ""];
  for (const s of sections) {
    lines.push(`## ${s.title}`, "", s.code ? fence(s.body) : String(s.body ?? "").trim(), "");
  }
  writeFileAtomic(file, lines.join("\n"));
  return { path: file, relPath: path.relative(absRoot, file).split(path.sep).join("/") };
}

// A report section for one failing runChecks result: the command, why it failed, how long it
// took, and the tail of its output in a fenced block.
export function checkFailureSection(result) {
  const lines = [
    `Command: ${result.command}`,
    `Result: ${describeFailure(result)}`,
    `Duration: ${formatDuration(result.durationMs)}`,
    ""
  ];
  if (result.tail) lines.push("Output (last lines):", fence(result.tail));
  else lines.push("(no output)");
  return { title: `Check "${result.name}" failed`, body: lines.join("\n") };
}

// The block reason for the Stop hook: the headline, then the sections, then the report path.
// The whole string is at most maxChars; when it has to be cut, a marker line says so.
export function summarize({ headline, sections = [], reportPath: report, maxChars = SUMMARY_MAX_CHARS }) {
  const footer = `\nFull report: ${report}`;
  const parts = [String(headline ?? "").trim()];
  for (const s of sections) parts.push("", `## ${s.title}`, s.code ? fence(s.body) : String(s.body ?? "").trim());
  const body = parts.join("\n");
  if (body.length + footer.length <= maxChars) return body + footer;
  const room = Math.max(0, maxChars - footer.length - TRUNCATED_LINE.length - 1);
  const cut = body.slice(0, room).replace(/\s+$/, "");
  return `${cut}\n${TRUNCATED_LINE}${footer}`;
}

// Why a result failed, in words: its reason when set, else derived from the exit state.
export function describeFailure(result) {
  if (result.reason) return result.reason;
  if (result.timedOut) return `timed out after ${Math.round((result.durationMs || 0) / 1000)} s`;
  if (result.skipped) return "skipped (an earlier check failed)";
  return `exit code ${result.code === null || result.code === undefined ? "none" : result.code}`;
}

// Fenced code block that survives backticks in the body.
export function fence(body) {
  const text = String(body ?? "").replace(/\s+$/, "");
  let ticks = "```";
  while (text.includes(ticks)) ticks += "`";
  return `${ticks}\n${text}\n${ticks}`;
}

function formatDuration(ms) {
  const n = Number(ms) || 0;
  return n < 1000 ? `${n} ms` : `${(n / 1000).toFixed(1)} s`;
}
