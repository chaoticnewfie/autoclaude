import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeReport, reportPath, checkFailureSection, summarize, describeFailure, fence } from "../../plugins/autoclaude/lib/report.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-report-"));

const failedResult = (extra = {}) => ({
  name: "unit",
  command: "npm test",
  ran: true,
  ok: false,
  code: 1,
  timedOut: false,
  durationMs: 1234,
  stdout: "1 failing\n",
  stderr: "AssertionError: expected 1 to equal 2\n",
  tail: "1 failing\nAssertionError: expected 1 to equal 2",
  reason: "exit code 1",
  skipped: false,
  ...extra
});

test("writeReport writes <root>/.autoclaude/reports/<step>-<attempt>.md with title, timestamp and sections", () => {
  const root = tmpDir();
  const r = writeReport({
    root,
    step: "P1.2",
    attempt: 1,
    sections: [
      { title: 'Check "unit" failed', body: "Command: npm test\nResult: exit code 1\n" },
      { title: "Diff", body: "+a\n-b\n", code: true }
    ]
  });
  assert.equal(r.path, path.join(root, ".autoclaude", "reports", "P1.2-1.md"));
  assert.equal(r.relPath, ".autoclaude/reports/P1.2-1.md");
  assert.equal(reportPath(root, "P1.2", 1), r.path);
  const text = fs.readFileSync(r.path, "utf8");
  assert.match(text, /^# AutoClaude report: P1\.2 attempt 1\n/);
  assert.match(text, /\nGenerated: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\n/);
  assert.match(text, /\n## Check "unit" failed\n\nCommand: npm test\nResult: exit code 1\n/);
  assert.match(text, /\n## Diff\n\n```\n\+a\n-b\n```\n/);
  assert.deepEqual(fs.readdirSync(path.dirname(r.path)), ["P1.2-1.md"]);
});

test("writeReport uses a custom title, resolves a relative root and overwrites the same attempt", () => {
  const root = tmpDir();
  const previous = process.cwd();
  process.chdir(root);
  try {
    const r = writeReport({ root: ".", step: "P2.1", attempt: 3, title: "Custom title", sections: [] });
    assert.ok(path.isAbsolute(r.path));
    assert.equal(r.relPath, ".autoclaude/reports/P2.1-3.md");
    assert.match(fs.readFileSync(r.path, "utf8"), /^# Custom title\n/);
    writeReport({ root: ".", step: "P2.1", attempt: 3, title: "Second write", sections: [] });
    assert.match(fs.readFileSync(r.path, "utf8"), /^# Second write\n/);
  } finally {
    process.chdir(previous);
  }
});

test("checkFailureSection describes an exit code, a timeout and a reason, with the tail fenced", () => {
  const exit = checkFailureSection(failedResult());
  assert.equal(exit.title, 'Check "unit" failed');
  assert.match(exit.body, /^Command: npm test\n/);
  assert.match(exit.body, /\nResult: exit code 1\n/);
  assert.match(exit.body, /\nDuration: 1\.2 s\n/);
  assert.match(exit.body, /```\n1 failing\nAssertionError: expected 1 to equal 2\n```$/);

  const timeout = checkFailureSection(failedResult({ code: null, timedOut: true, durationMs: 30012, reason: "timed out after 30 s" }));
  assert.match(timeout.body, /\nResult: timed out after 30 s\n/);
  assert.match(timeout.body, /\nDuration: 30\.0 s\n/);

  const derived = describeFailure({ code: null, timedOut: true, durationMs: 30012, reason: null });
  assert.equal(derived, "timed out after 30 s");
  assert.equal(describeFailure({ code: 7, timedOut: false, reason: null }), "exit code 7");
  assert.equal(describeFailure({ skipped: true, code: null, timedOut: false, reason: null }), "skipped (an earlier check failed)");

  const noRun = checkFailureSection(failedResult({ ran: false, code: null, durationMs: 0, stdout: "", stderr: "", tail: "", reason: "dev server not available" }));
  assert.match(noRun.body, /\nResult: dev server not available\n/);
  assert.match(noRun.body, /\nDuration: 0 ms\n/);
  assert.match(noRun.body, /\(no output\)$/);
  assert.doesNotMatch(noRun.body, /```/);
});

test("fence grows the fence when the body contains backticks", () => {
  assert.equal(fence("plain\n"), "```\nplain\n```");
  assert.equal(fence("has ``` inside"), "````\nhas ``` inside\n````");
});

test("summarize joins the headline, sections and report path when it fits", () => {
  const report = "C:\\proj\\.autoclaude\\reports\\P1.2-1.md";
  const s = summarize({
    headline: "P1.2 attempt 1/3 failed:",
    sections: [{ title: 'Check "unit" failed', body: "Command: npm test\nResult: exit code 1\n" }, { title: "Notes", body: "  none  " }],
    reportPath: report
  });
  assert.equal(s, `P1.2 attempt 1/3 failed:\n\n## Check "unit" failed\nCommand: npm test\nResult: exit code 1\n\n## Notes\nnone\nFull report: ${report}`);
  assert.ok(s.length <= 4000);
  assert.doesNotMatch(s, /truncated/);
});

test("summarize never exceeds maxChars and always ends with the report path", () => {
  const report = path.join("C:", "proj", ".autoclaude", "reports", "P3.4-2.md");
  const huge = Array.from({ length: 500 }, (_, i) => `line ${i + 1}: ${"x".repeat(30)}`).join("\n");
  assert.ok(huge.length >= 20000, String(huge.length));
  const sections = [{ title: "Small", body: "fine" }, { title: "Huge", body: huge }];

  const s = summarize({ headline: "P3.4 attempt 2/3 failed:", sections, reportPath: report });
  assert.ok(s.length <= 4000, String(s.length));
  assert.ok(s.endsWith(`\nFull report: ${report}`), s.slice(-120));
  assert.match(s, /\n\[\.\.\. truncated, see the full report \.\.\.\]\nFull report: /);
  assert.match(s, /^P3\.4 attempt 2\/3 failed:\n\n## Small\nfine\n\n## Huge\nline 1: /);

  for (const maxChars of [100, 250, 1000, 3999, 4000, 8000]) {
    const t = summarize({ headline: "h", sections, reportPath: report, maxChars });
    assert.ok(t.length <= maxChars, `${maxChars}: ${t.length}`);
    assert.ok(t.endsWith(`\nFull report: ${report}`), `${maxChars}: ${t.slice(-80)}`);
    assert.match(t, /\[\.\.\. truncated, see the full report \.\.\.\]/);
  }

  const big = summarize({ headline: "h", sections, reportPath: report, maxChars: 100000 });
  assert.ok(big.length > 20000);
  assert.doesNotMatch(big, /truncated/);
  assert.ok(big.endsWith(`\nFull report: ${report}`));
});
