import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildSummary, progressEntries, parseDecisions, runDecisions, ownerReviewDecisions, decisionsMark, decisionsAtStart, parseTableRows, isOpenStatus, unresolvedRows, isPrivateDoc, afterRunSection, afterRunItems, pushLine, pushStatus, flakyChecksOfRun, flakyByCheck, flakyWhere } from "../../plugins/autoclaude/lib/summary.js";
import { preflight, checkRunnable, playwrightBrowsersDir, formatPreflight, checkRequirements } from "../../plugins/autoclaude/lib/preflight.js";
import { recordRunEnv, recordCheckTimes } from "../../plugins/autoclaude/lib/checks.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { parsePlan, MARKERS } from "../../plugins/autoclaude/lib/plan.js";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";

const tmp = (p) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test("progressEntries reads the gate's progress lines", () => {
  const e = progressEntries("# Progress\n\n- 2026-09-26 S1.1 One (attempt 1)\n- 2026-09-27 S1.2 Two words (attempt 3)\nnot a line\n");
  assert.deepEqual(e, [{ date: "2026-09-26", id: "S1.1", title: "One", attempt: 1 }, { date: "2026-09-27", id: "S1.2", title: "Two words", attempt: 3 }]);
  // A built step's line is not an entry: the step gets its attempt line when its feature passes.
  const phase = progressEntries("- 2026-09-27 S1.1 One (built; verified with Phase 1)\n- 2026-09-27 S1.1 One (attempt 2)\n- 2026-09-27 S1.2 Two (attempt 2)\n");
  assert.deepEqual(phase.map((x) => [x.id, x.attempt]), [["S1.1", 2], ["S1.2", 2]]);
});

test("buildSummary (morning): steps, attempts, the run's decisions, open items, push, usage used and elapsed time", () => {
  const root = tmp("autoclaude-sum-");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "PROGRESS.md"), "- 2026-09-26 S1.1 One (attempt 1)\n- 2026-09-27 S1.2 Two (attempt 3)\n");
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), "## D-001 x\n## D-002 y\n## N-001 note\n");
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), "| Date |\n|---|\n| 2026-09-27 | bug bash | S1.2 | medium: x | Claude | open |\n");
  fs.writeFileSync(path.join(root, "docs", "SECURITY-FINDINGS.md"), "| 2026-09-27 | low | a.js:1 | i | f | open |\n| 2026-09-27 | low | b.js:2 | i | f | open |\n");
  const parsed = parsePlan("# P\n\n## Phase 1: A\n- [x] **S1.1** One\n  - Accept: a\n- [x] **S1.2** Two\n  - Accept: b\n- [ ] **S1.3** Three\n  - Accept: c\n\n## After the run\n\n- Run deploy.sh on the server\n");
  const now = Date.parse("2026-09-27T06:30:00Z");
  // An older project whose config names the committed findings file: its rows are quoted.
  const text = buildSummary({ root, config: mergeConfig({ git: { push: false }, docs: { security: "docs/SECURITY-FINDINGS.md" } }), state: { status: "running", currentStep: "S1.3", startedAt: "2026-09-27T04:00:00Z", usageAtStart: 11 }, parsed, usage: { sevenDay: { pct: 19.4 } }, now, sinceDate: "2026-09-27" });
  assert.match(text, /Steps: 2\/3 verified, 1 since 2026-09-27\./);
  assert.match(text, /Attempts: 3 for 1 step \(0 passed first time\)\./);
  assert.match(text, /Decisions the run made: 2, owner notes handled: 1\./);
  assert.match(text, /Open items: 2 security findings, 1 follow-up\. Top: S1\.2 medium: x; low a\.js:1 i; low b\.js:2 i\./, "most severe first");
  assert.doesNotMatch(text, /Left for you|deploy\.sh/, "mid-run, the plan's own after-the-run list is not news");
  assert.match(text, /Push: off \(git\.push is false\), so nothing was pushed\./);
  assert.match(text, /Weekly usage: 19% \(8 points this run\)\./);
  assert.match(text, /Elapsed: 2 h 30 min\./);
  assert.match(text, /Now: running S1\.3\./);
  const built = parsePlan("# P\n\n## Phase 1: A\n- [~] **S1.1** One\n  - Accept: a\n- [ ] **S1.2** Two\n  - Accept: b\n");
  if (MARKERS.built) assert.match(buildSummary({ root, config: mergeConfig({}), state: { status: "running" }, parsed: built }), /Steps: 0\/2 verified, 1 built and waiting for their feature's verification\./);
});

const DECISIONS = `# DECISIONS

## Entry format

\`\`\`markdown
## D-### (YYYY-MM-DD, S1.2) Short title of the choice
- Owner review: yes
\`\`\`

## Entries

## D-001 (2026-09-20, planning) Postgres 16 in Docker
- Choice: Postgres 16
- By: owner

## D-002 (2026-09-25, S1.1) Folder layout from an earlier run
- Choice: src/
- By: decider

## D-003 (2026-09-27, S1.2) Serve over plain HTTP on the LAN
- Question: TLS or not
- Choice: plain HTTP behind the LAN
- Why: no certificate on this machine
- By: decider
- Owner review: yes

## N-001 (2026-09-27, S1.2) Owner asked for bigger buttons
- Note: bigger buttons
- Done: S1.2

## D-004 (2026-09-28, S1.3) Keep the default port
- **Owner review:** no
- By: builder

## D-005 (2026-09-28, S2.1) Skip rate limiting on the admin page
**Owner review:** yes
`;

test("parseDecisions: headings, fields, owner review; fenced examples are not entries", () => {
  const e = parseDecisions(DECISIONS);
  assert.deepEqual(e.map((x) => [x.id, x.date, x.step, x.kind]), [
    ["D-001", "2026-09-20", "planning", "decision"], ["D-002", "2026-09-25", "S1.1", "decision"], ["D-003", "2026-09-27", "S1.2", "decision"],
    ["N-001", "2026-09-27", "S1.2", "note"], ["D-004", "2026-09-28", "S1.3", "decision"], ["D-005", "2026-09-28", "S2.1", "decision"]
  ]);
  assert.equal(e[2].title, "Serve over plain HTTP on the LAN");
  assert.deepEqual([e[2].fields.choice, e[2].fields.by], ["plain HTTP behind the LAN", "decider"]);
  assert.deepEqual(ownerReviewDecisions(e).map((x) => x.id), ["D-003", "D-005"], "\"no\" is not a review, bold and dash-less fields count");
  assert.deepEqual(ownerReviewDecisions(e, { sinceDate: "2026-09-28" }).map((x) => x.id), ["D-005"], "an earlier run's were in its own hand-back");
  assert.deepEqual(runDecisions(e).map((x) => x.id), ["D-002", "D-003", "D-004", "D-005"], "planning entries never count");
  assert.deepEqual(runDecisions(e, { sinceDate: "2026-09-27" }).map((x) => x.id), ["D-003", "D-004", "D-005"], "nor ones logged before this run");
  assert.deepEqual(parseDecisions("## D-001 x\n## D-002 y\n").map((x) => [x.id, x.date, x.step, x.title]), [["D-001", null, null, "x"], ["D-002", null, null, "y"]]);
  // The owner's answer to a blocked question is not a decision the run made.
  const answered = parseDecisions(`${DECISIONS}\n## D-006 (2026-09-28, S2.1) Owner answer to a blocked question\n- Question: q\n- Answer: a\n- By: owner, with \`autoclaude answer\`\n`);
  assert.deepEqual(runDecisions(answered, { sinceDate: "2026-09-28" }).map((x) => x.id), ["D-004", "D-005"]);
});

// A second run the same day as the first: every entry carries the same date, so only the
// decisions log's position at the run's start tells the two runs apart.
const SAME_DAY = `# DECISIONS

## D-001 (2026-09-28, planning) Postgres 16
- By: owner

## D-002 (2026-09-28, S1.1) First run: open port 8080 on the LAN
- By: decider
- Owner review: yes

## N-001 (2026-09-28, S1.2) First run's note
- Note: bigger buttons
- Done: S1.2

## D-003 (2026-09-28, planning) Plan extended with Phase 2
- By: owner

## D-004 (2026-09-28, S2.1) Second run: keep the default theme
- By: decider

## N-002 (2026-09-28, S2.1) Second run's note
- Note: rename the page
- Done: S2.1
`;

test("decisionsMark and a second run the same day: only entries logged after the run's start count", () => {
  assert.deepEqual(decisionsMark(SAME_DAY), { D: 4, N: 2 });
  assert.deepEqual(decisionsMark(""), { D: 0, N: 0 });
  assert.deepEqual(decisionsMark(DECISIONS), { D: 5, N: 1 }, "the fenced entry-format example is not an entry");
  const e = parseDecisions(SAME_DAY);
  const since = { D: 3, N: 1 };
  assert.deepEqual(runDecisions(e, { since, sinceDate: "2026-09-28" }).map((x) => x.id), ["D-004"]);
  assert.deepEqual(ownerReviewDecisions(e, { since, sinceDate: "2026-09-28" }).map((x) => x.id), []);
  assert.deepEqual(runDecisions(e, { sinceDate: "2026-09-28" }).map((x) => x.id), ["D-002", "D-004"], "by date alone the first run's count too");

  const root = tmp("autoclaude-sum-sameday-");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), SAME_DAY);
  const parsed = parsePlan("# P\n\n## Phase 2: B\n- [x] **S2.1** One\n  - Accept: a\n");
  const state = { status: "complete", startedAt: "2026-09-28T15:00:00Z", decisionsAtStart: since };
  const text = buildSummary({ root, config: mergeConfig({}), state, parsed, now: Date.parse("2026-09-28T17:00:00Z") });
  assert.match(text, /Decisions the run made: 1, owner notes handled: 1\./);
  assert.doesNotMatch(text, /For your review|D-002/, "the first run's owner-review decision was in its own hand-back");
  // A mark for decisions only: notes go by date.
  assert.match(buildSummary({ root, config: mergeConfig({}), state: { ...state, decisionsAtStart: { D: 3 } }, parsed }), /Decisions the run made: 1, owner notes handled: 2\./);
  // No mark and no base commit to read one from: the run's start date decides, as before.
  const byDate = { ...state, decisionsAtStart: null, baseCommit: null };
  assert.deepEqual(decisionsAtStart({ root, config: mergeConfig({}), state: byDate }), null);
  assert.match(buildSummary({ root, config: mergeConfig({}), state: byDate, parsed }), /Decisions the run made: 2, owner notes handled: 2\./);
});

test("parseTableRows and unresolvedRows: headers, escaped pipes, closed statuses, rows left for the owner", () => {
  const rows = parseTableRows("| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n| 2026-09-27 | low | a.js:1 | uses a \\| b | fix | open |\n\ntext\n| 2026-09-28 | x | y |\n", ["date", "a", "b"]);
  assert.deepEqual(rows.map((r) => [r.cells.date, r.cells.issue || r.cells.b, r.status]), [["2026-09-27", "uses a | b", "open"], ["2026-09-28", "y", "y"]]);
  for (const s of ["open", "left for the owner: needs a DNS record", "in progress", ""]) assert.equal(isOpenStatus(s), true, s);
  for (const s of ["fixed in S1.3", "Fixed", "closed", "done", "won't fix: by design", "wontfix", "duplicate of 2"]) assert.equal(isOpenStatus(s), false, s);

  const root = tmp("autoclaude-sum-rows-");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), "# BLOCKERS\n\n| Date | Found by | Step | What | Owner | Status |\n|---|---|---|---|---|---|\n| 2026-09-27 | bug bash | S1.2 | low: a typo | Claude | fixed in S1.3 |\n| 2026-09-27 | builder | S1.3 | Add the DNS record for db.lan | owner | left for the owner: needs the router's admin login |\n| 2026-09-28 | tester | S2.1 | high: data lost on reload | Claude | open |\n");
  // The default findings file is the gitignored docs/private/ one (P10.10).
  fs.mkdirSync(path.join(root, "docs", "private"));
  fs.writeFileSync(path.join(root, "docs", "private", "SECURITY-FINDINGS.md"), "| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n| 2026-09-28 | medium | api.js:9 | no CSRF token | add one | left for the owner: needs a product decision |\n");
  const u = unresolvedRows(root, mergeConfig({}));
  assert.deepEqual(u.map((r) => [r.source, r.severity, r.leftForOwner]), [["follow-up", "high", false], ["security", "medium", true], ["follow-up", null, true]]);
  assert.equal(u[2].text, "S1.3 Add the DNS record for db.lan");
  // A private row says only its severity and where the details are: nothing of the issue, the
  // file, the fix or the status reason reaches HANDOFF.md or an alert.
  assert.equal(u[1].private, true);
  assert.equal(u[1].text, "medium security finding, details in docs/private/SECURITY-FINDINGS.md (kept out of git)");
  assert.equal(u[1].fix, "");
  assert.equal(u[1].status, "left for the owner");
  assert.doesNotMatch(JSON.stringify(u[1]), /CSRF|api\.js|add one|product decision/);
  assert.equal(isPrivateDoc("docs/private/SECURITY-FINDINGS.md"), true);
  assert.equal(isPrivateDoc("./Docs/Private/x.md"), true);
  assert.equal(isPrivateDoc("docs/SECURITY-FINDINGS.md"), false);
  // An older project's committed file is quoted as before.
  fs.writeFileSync(path.join(root, "docs", "SECURITY-FINDINGS.md"), "| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n| 2026-09-28 | low | api.js:9 | no CSRF token | add one | open |\n");
  const old = unresolvedRows(root, mergeConfig({ docs: { security: "docs/SECURITY-FINDINGS.md" } })).find((r) => r.source === "security");
  assert.equal(old.private, false);
  assert.equal(old.text, "low api.js:9 no CSRF token");
});

test("afterRunSection and afterRunItems: the plan's list, fences kept, placeholders and \"Nothing\" skipped", () => {
  const plan = "# P\n\n## After the run\n\nWhat the owner does.\n\n- Run `scripts/dns.sh` on the router:\n  ```\n  ## not a heading\n  ssh admin@router ./dns.sh\n  ```\n- Sign in to the admin page once\n\n## Phases\n\n- not this\n";
  const s = afterRunSection(plan);
  assert.match(s, /^What the owner does\./);
  assert.match(s, /ssh admin@router/);
  assert.doesNotMatch(s, /not this/);
  assert.deepEqual(afterRunItems(s), ["Run `scripts/dns.sh` on the router:", "Sign in to the admin page once"]);
  assert.deepEqual(afterRunItems(afterRunSection("## After the run\n\n- Nothing: the run does all of this plan.\n")), []);
  assert.deepEqual(afterRunItems(afterRunSection("## After the run\n\n- Not written yet. Scripts...\n")), []);
  assert.equal(afterRunSection("# P\n\n## Phase 1: A\n"), "");
});

test("pushLine: off, not yet, pushed, skipped, failed with what is missing", () => {
  const on = mergeConfig({ git: { push: true } });
  assert.equal(pushLine(null, mergeConfig({ git: { push: false } })), "Push: off (git.push is false), so nothing was pushed.");
  assert.equal(pushLine(null, on), "Push: nothing has been pushed yet.");
  assert.equal(pushLine({ branch: "autoclaude/shop", remote: "origin", ok: true, at: "2026-09-28T10:15:00Z" }, on), "Push: autoclaude/shop and its tags are on origin (2026-09-28 10:15 UTC).");
  assert.equal(pushLine({ branch: "b", ok: false, skipped: true, error: "no remote named origin" }, on), "Push: skipped: no remote named origin. Nothing is on the remote from this run.");
  assert.equal(pushLine({ branch: "b", remote: "origin", ok: false, at: "2026-09-28T10:15:00Z", error: "ssh: connect to host github.com port 22: timed out\nfatal", unpushedCommits: 3, unpushedTags: ["ac-phase-2"] }, on), "Push FAILED for b (2026-09-28 10:15 UTC): ssh: connect to host github.com port 22: timed out. Not on the remote: 3 commits and 1 tag (ac-phase-2).");
  // The same sentence without its label, for HANDOFF.md to qualify.
  assert.equal(pushStatus({ branch: "b", ok: false, error: "rejected", unpushedCommits: 1 }, on), "FAILED for b: rejected. Not on the remote: 1 commit.");
  assert.equal(pushStatus({ branch: "b", remote: "origin", ok: true }, on), "b and its tags are on origin.");
});

test("buildSummary (complete): only the run's decisions, owner-review decisions and open items with the top few, what is left, the push state", () => {
  const root = tmp("autoclaude-sum-done-");
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), DECISIONS);
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), "| Date | Found by | Step | What | Owner | Status |\n|---|---|---|---|---|---|\n| 2026-09-27 | builder | S1.3 | Add the DNS record | owner | left for the owner: router login |\n" + [1, 2, 3, 4].map((n) => `| 2026-09-28 | tester | S2.${n} | low: nit ${n} | Claude | open |\n`).join(""));
  const parsed = parsePlan("# P\n\n## Phase 1: A\n- [x] **S1.1** One\n  - Accept: a\n\n## After the run\n\n- Run deploy.sh\n");
  const state = { status: "complete", startedAt: "2026-09-27T04:00:00Z", pushState: { branch: "autoclaude/p", remote: "origin", ok: false, error: "rejected", unpushedCommits: 1, unpushedTags: [] } };
  const text = buildSummary({ root, config: mergeConfig({}), state, parsed, now: Date.parse("2026-09-27T10:00:00Z") });
  assert.match(text, /Decisions the run made: 3, owner notes handled: 1\./, "D-003 to D-005: not planning, not before the run");
  assert.match(text, /For your review: 2 decisions marked "Owner review: yes": D-003 Serve over plain HTTP on the LAN; D-005 Skip rate limiting on the admin page\./);
  assert.match(text, /Left for you: 2 items: Run deploy\.sh; S1\.3 Add the DNS record\./);
  assert.match(text, /Open items: 4 follow-ups\. Top: S2\.1 low: nit 1; S2\.2 low: nit 2; S2\.3 low: nit 3 \(\+1 more\)\./);
  assert.match(text, /Push FAILED for autoclaude\/p: rejected\. Not on the remote: 1 commit\./);
  assert.doesNotMatch(text, /Hand-back/, "no HANDOFF.md from this run");

  fs.writeFileSync(path.join(root, "HANDOFF.md"), "# Hand-back\n");
  assert.match(buildSummary({ root, config: mergeConfig({}), state, parsed }), /Hand-back: HANDOFF\.md in the project folder\./);
  const handoff = { path: path.join(root, "HANDOFF.md"), summary: { runDecisions: 7, ownerReviewDecisions: [], ownerItems: [], openFindings: [], secretsCreated: ["secrets/db.env"], push: { branch: "autoclaude/p", ok: true }, footprint: { removed: [{}, {}], kept: [], runningCreated: [{}], errors: [] } } };
  const withHandoff = buildSummary({ root, config: mergeConfig({}), state, parsed, handoff });
  assert.match(withHandoff, /Decisions the run made: 7/);
  assert.match(withHandoff, /Left for you: nothing\. The run created 1 secret file in secrets\/\./);
  assert.match(withHandoff, /Open items: none\./);
  assert.match(withHandoff, /Push: autoclaude\/p and its tags are on the remote\./);
  assert.match(withHandoff, /Docker: removed 2 unused things the run created, 1 container it started still running\./);
  // Fields of another shape (counts instead of lists) fall back to what the files say.
  const odd = buildSummary({ root, config: mergeConfig({}), state, parsed, handoff: { path: "HANDOFF.md", summary: { runDecisions: [1, 2], openFindings: 0, ownerItems: ["Run deploy.sh"], ownerReviewDecisions: null } } });
  assert.match(odd, /Decisions the run made: 2/);
  assert.match(odd, /Left for you: 1 item: Run deploy\.sh\./);
  assert.match(odd, /Open items: 4 follow-ups\./);
  assert.match(odd, /For your review: 2 decisions/);
});

// ---------- flaky checks (P10.14, D62) ----------

const FLAKY_PLAN = "# P plan\n\n## Phase 1: Lists\n- [x] **S1.1** One\n  - Accept: a\n- [x] **S1.3** Three\n  - Accept: c\n\n## Phase 2: More\n- [x] **S2.2** Five\n  - Accept: e\n";
const flakyAt = (name, step, phase, feature, stage, at) => ({ name, step, phase, feature, stage, at, firstReason: "exit code 1" });

test("flaky checks: only the run's own, grouped by check, said where; the alert gives them one short line, and none when there are none", () => {
  const startedAt = "2026-10-04T08:00:00.000Z";
  const flakyChecks = [
    flakyAt("unit", "S1.1", 1, false, "verify", "2026-10-03T23:00:00.000Z"),
    flakyAt("unit", "S1.3", 1, true, "verify", "2026-10-04T09:00:00.000Z"),
    flakyAt("e2e", "S2.2", 2, true, "fixup", "2026-10-04T10:00:00.000Z"),
    flakyAt("unit", "S3.1", 3, false, "recheck", "2026-10-04T11:00:00.000Z"),
    null, { name: "" }, { step: "S1.1" }
  ];
  const run = flakyChecksOfRun({ startedAt, flakyChecks });
  assert.deepEqual(run.map((e) => e.step), ["S1.3", "S2.2", "S3.1"], "an earlier run's entry and broken ones are left out");
  assert.equal(flakyChecksOfRun({ flakyChecks }).length, 4, "no start recorded: every entry");
  assert.deepEqual(flakyChecksOfRun({}), []);
  assert.deepEqual(flakyByCheck(run).map((f) => [f.name, f.count, f.entries.map((e) => e.step)]), [["unit", 2, ["S1.3", "S3.1"]], ["e2e", 1, ["S2.2"]]]);
  const parsed = parsePlan(FLAKY_PLAN);
  assert.deepEqual(run.map((e) => flakyWhere(e, parsed)), ["Phase 1 (Lists), verified at S1.3", "the fix-up checks of Phase 2 (More) at S2.2", "S3.1, in Phase 3, with its findings filed"]);
  assert.equal(flakyWhere({ name: "unit", step: "S1.1", phase: 1, feature: false, stage: "verify" }, parsed), "S1.1, in Phase 1 (Lists)");
  assert.equal(flakyWhere({ name: "unit", step: "S9", phase: null, stage: "verify" }), "S9");

  const root = tmp("autoclaude-sum-flaky-");
  fs.mkdirSync(path.join(root, "docs"));
  const config = mergeConfig({});
  const text = buildSummary({ root, config, state: { status: "complete", startedAt, flakyChecks }, parsed });
  assert.match(text, /\nOpen items: none\.\nFlaky checks: unit \(2 times\), e2e: each failed, then passed when run again; fix the tests\.\n/);
  // The hand-back's own list, when there is one; the top three and how many more.
  const handoff = { path: path.join(root, "HANDOFF.md"), summary: { flakyChecks: ["a", "b", "c", "d"].map((n, i) => flakyAt(n, "S1.1", 1, false, "verify", `2026-10-04T1${i}:00:00.000Z`)) } };
  assert.match(buildSummary({ root, config, state: { status: "complete", startedAt }, parsed, handoff }), /\nFlaky checks: a, b, c \(\+1 more\): each failed, then passed when run again; fix the tests\.\n/);
  assert.doesNotMatch(buildSummary({ root, config, state: { status: "complete", startedAt, flakyChecks: [flakyChecks[0]] }, parsed }), /Flaky/, "only an earlier run's: nothing");
  assert.doesNotMatch(buildSummary({ root, config, state: { status: "complete", startedAt }, parsed }), /Flaky/);
});

test("checkRunnable: absolute paths, PATH lookups and npm scripts", () => {
  const root = tmp("autoclaude-pf-");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "x", lint: "y" } }));
  const env = { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") };
  assert.equal(checkRunnable(`${JSON.stringify(process.execPath)} -e 1`, root, env).ok, true);
  assert.equal(checkRunnable("npm test", root, env).ok, true);
  assert.equal(checkRunnable("npm run lint", root, env).ok, true);
  assert.match(checkRunnable("npm run typecheck", root, env).detail, /no "typecheck" script/);
  assert.match(checkRunnable("definitely-missing-tool --x", root, env).detail, /not on PATH/);
  assert.match(checkRunnable('"C:/nope/tool.exe" x', root, env).detail, /does not exist/);
  assert.ok(playwrightBrowsersDir({ PLAYWRIGHT_BROWSERS_PATH: "D:/pw" }) === "D:/pw");
});

test("preflight on a fixture: every problem is reported, trust is read from the user config and never written", async () => {
  const env = gitEnv({ ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") });
  const root = tmp("autoclaude-pf-proj-");
  prepareFixture({ dest: root, plan: "broken", git: true, env, devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 5 } });
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const cfg = JSON.parse(fs.readFileSync(path.join(root, "autoclaude.config.json"), "utf8"));
  const project = { root, config: mergeConfig(cfg) };
  let r = await preflight(project, { env, userConfigFile });
  const byName = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(r.ok, false);
  assert.equal(byName.trust.status, "fail", "no user config: onboarding and trust unknown");
  assert.match(byName.trust.detail, /Run `claude` once in/);
  assert.equal(byName.plan.status, "ok");
  assert.equal(byName.git.status, "ok");
  assert.equal(byName.checks.status, "ok");
  assert.equal(byName.playwright, undefined, "no UI steps in the broken plan, so no browser needed");
  assert.ok(!fs.existsSync(userConfigFile), "never written");

  const top = root.replace(/\\/g, "/");
  fs.writeFileSync(userConfigFile, JSON.stringify({ hasCompletedOnboarding: true, projects: { [top]: { hasTrustDialogAccepted: true } } }));
  fs.writeFileSync(path.join(root, "stray.txt"), "dirty");
  r = await preflight(project, { env, userConfigFile });
  const again = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(again.trust.status, "ok");
  assert.equal(again.git.status, "fail");
  assert.match(formatPreflight(r), /FAIL git: the working tree has 1 uncommitted change/);
  fs.unlinkSync(path.join(root, "stray.txt"));
  // platform win32: the tmux item (Linux and macOS only) must not depend on the test machine.
  r = await preflight(project, { env, userConfigFile, skip: ["notify", "usage"], platform: "win32" });
  assert.equal(r.ok, true, formatPreflight(r));

  // A shell without git on PATH (seen live: the run window inherited one) fails preflight, even
  // for a run already under way, which skips the repository checks but not the tools.
  const noGit = { ...env, PATH: path.dirname(process.execPath) };
  r = await preflight(project, { env: noGit, userConfigFile, skip: ["plan", "git", "checks", "playwright", "dev server", "usage", "notify"] });
  const tools = Object.fromEntries(r.items.map((i) => [i.name, i]));
  assert.equal(r.ok, false);
  assert.equal(tools["git-cli"].status, "fail");
  assert.match(formatPreflight(r), /FAIL git-cli: `git` is not on PATH; the gate commits every verified step/);
  r = await preflight(project, { env: noGit, userConfigFile });
  assert.match(formatPreflight(r), /FAIL git: `git` is not on PATH, so the repository cannot be checked/);
});

// A scratch project for the item-level preflight tests below. Only the named items are compared.
function pfProject(plan, config = {}) {
  const root = tmp("autoclaude-pf-item-");
  fs.writeFileSync(path.join(root, "PLAN.md"), plan);
  return { root, config: mergeConfig(config) };
}
const QUIET = ["usage", "notify", "trust", "git", "git-cli", "node", "claude"];
const itemsOf = (r) => Object.fromEntries(r.items.map((i) => [i.name, i]));
const UI_PLAN = "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** Page\n  - Accept: a\n  - Tags: ui\n";
const NO_UI_FIRST = "# P plan\n\n## Phase 1: A\n- [ ] **S1.1** Server\n  - Accept: a\n  - Test: test/a.test.js\n  - Tags: no-ui\n- [ ] **S1.2** Page\n  - Accept: b\n  - Tags: ui\n";
const UI_DONE = "# P plan\n\n## Phase 1: A\n- [x] **S1.1** Page\n  - Accept: a\n  - Tags: ui\n- [ ] **S1.2** Logic\n  - Accept: b\n  - Test: test/b.test.js\n  - Tags: no-ui\n";
const SERVER = { command: "npm run dev", url: "http://127.0.0.1:4173", healthPath: "/", startTimeoutSec: 5 };

test("preflight needs Chromium only with the tester on, a dev server set and an unfinished UI step", async () => {
  const browsers = tmp("autoclaude-pf-pw-");
  const env = gitEnv({ ...process.env, PLAYWRIGHT_BROWSERS_PATH: browsers });
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const run = (project) => preflight(project, { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }).then(itemsOf);

  // No dev server: the gate never opens a browser, so Chromium is not required.
  let items = await run(pfProject(UI_PLAN));
  assert.equal(items.playwright, undefined);
  assert.equal(items["dev server"].status, "warn");
  assert.match(items["dev server"].detail, /no devServer configured, so UI steps will not be checked in a browser/);

  items = await run(pfProject(UI_PLAN, { devServer: SERVER }));
  assert.equal(items.playwright.status, "fail");
  assert.match(items.playwright.detail, /no Chromium under .*npx playwright install chromium/);
  fs.mkdirSync(path.join(browsers, "chromium-1200"));
  items = await run(pfProject(UI_PLAN, { devServer: SERVER }));
  assert.equal(items.playwright.status, "ok");

  assert.equal((await run(pfProject(UI_PLAN, { devServer: SERVER, tester: { enabled: false } }))).playwright, undefined, "tester off");
  assert.equal((await run(pfProject(UI_DONE, { devServer: SERVER }))).playwright, undefined, "the only UI step is already verified");
});

test("preflight: a dev server that cannot answer is a WARN while the next step is no-ui, a FAIL otherwise", async () => {
  const env = gitEnv({ ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") });
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  // A command that exits at once and a port nothing listens on: the server never answers.
  const dead = { command: `${JSON.stringify(process.execPath)} -e 0`, url: "http://127.0.0.1:9", healthPath: "/", startTimeoutSec: 1 };
  const skip = [...QUIET, "playwright"];

  let r = await preflight(pfProject(NO_UI_FIRST, { devServer: dead }), { env, userConfigFile, skip, platform: "win32" });
  const warn = itemsOf(r)["dev server"];
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /^not running yet \(dev server did not answer/);
  assert.match(warn.detail, /the next step, S1\.1, is no-ui\. The gate starts the dev server for each step that needs it and fails that step if it cannot/);
  assert.equal(r.ok, true, formatPreflight(r));

  r = await preflight(pfProject(UI_PLAN, { devServer: dead }), { env, userConfigFile, skip, platform: "win32" });
  assert.equal(itemsOf(r)["dev server"].status, "fail");
  assert.equal(r.ok, false);
});

test("preflight: a check that needs the dev server FAILs, by name, when no dev server is configured", async () => {
  const env = gitEnv(process.env);
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const e2e = { name: "e2e", command: `${JSON.stringify(process.execPath)} -e 0`, needsDevServer: true };
  const unit = { name: "unit", command: `${JSON.stringify(process.execPath)} -e 0` };
  let items = itemsOf(await preflight(pfProject(UI_PLAN, { checks: [unit, e2e] }), { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.equal(items.checks.status, "fail");
  assert.match(items.checks.detail, /^e2e: needsDevServer is true but devServer\.command and devServer\.url are not both set, so this check would fail every step$/);
  items = itemsOf(await preflight(pfProject(UI_PLAN, { checks: [unit, e2e], devServer: SERVER }), { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.equal(items.checks.status, "ok");
});

test("preflight: a check's `requires` runs first; a failing one fails the checks item naming the check and the command", async () => {
  const env = gitEnv({ ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || "") });
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const node = JSON.stringify(process.execPath);
  // `exit N` means the same in cmd.exe and sh, the shells the checks run through.
  const docker = { name: "db-tests", command: "definitely-missing-tool --run", requires: "exit 3" };
  const unit = { name: "unit", command: `${node} -e 0`, requires: "exit 0" };
  let items = itemsOf(await preflight(pfProject(UI_PLAN, { checks: [unit, docker] }), { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.equal(items.checks.status, "fail");
  assert.match(items.checks.detail, /^db-tests: its requirement `exit 3` failed \(exit code 3\); install or start what it needs first$/, "only the requirement is reported, not the missing tool behind it");

  items = itemsOf(await preflight(pfProject(UI_PLAN, { checks: [unit] }), { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.deepEqual([items.checks.status, items.checks.detail], ["ok", "unit"]);

  // The requirement runs in the checks' environment and its last line of output is quoted.
  const calls = [];
  const fake = async (cmd, o) => { calls.push([cmd, o.cwd, o.env.MARK, o.timeoutMs]); return { code: 1, stdout: "", stderr: "Cannot connect to the Docker daemon\n", timedOut: false }; };
  const project = pfProject(UI_PLAN, { checks: [{ name: "db", command: `${node} -e 0`, requires: "docker version" }] });
  items = itemsOf(await preflight(project, { env, checksEnv: { ...env, MARK: "checks-env" }, runRequirement: fake, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.match(items.checks.detail, /^db: its requirement `docker version` failed \(exit code 1: Cannot connect to the Docker daemon\)/);
  assert.deepEqual(calls, [["docker version", project.root, "checks-env", 60000]]);

  // A run already under way skips the checks item, and with it every requirement.
  calls.length = 0;
  await preflight(project, { env, runRequirement: fake, userConfigFile, devServer: false, skip: [...QUIET, "checks"], platform: "win32" });
  assert.deepEqual(calls, []);

  const timedOut = await checkRequirements([{ name: "slow", requires: "x" }, { name: "none" }], { root: project.root, run: async () => ({ code: null, timedOut: true }) });
  assert.deepEqual(timedOut.map((b) => [b.index, b.check]), [[0, "slow"]]);
  assert.match(timedOut[0].detail, /timed out after 60 s/);
  const thrown = await checkRequirements([{ name: "boom", requires: "x" }], { root: project.root, run: async () => { throw new Error("spawn EINVAL"); } });
  assert.match(thrown[0].detail, /could not start: spawn EINVAL/);
});

test("preflight looks for check commands on the PATH the run recorded, not the shell's", async () => {
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const tools = tmp("autoclaude-pf-tools-");
  for (const f of ["only-in-run", "only-in-run.cmd"]) fs.writeFileSync(path.join(tools, f), "");
  const project = pfProject(UI_PLAN, { checks: [{ name: "lint", command: "only-in-run --all" }] });
  const shell = { PATH: path.dirname(process.execPath) };
  let items = itemsOf(await preflight(project, { env: shell, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.match(items.checks.detail, /lint: `only-in-run` is not on PATH/);
  recordRunEnv(project.root, { PATH: tools });
  items = itemsOf(await preflight(project, { env: shell, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.equal(items.checks.status, "ok", items.checks.detail);
  // `autoclaude run` judges with its own terminal's env, the one it is about to record.
  items = itemsOf(await preflight(project, { env: shell, checksEnv: shell, userConfigFile, devServer: false, skip: QUIET, platform: "win32" }));
  assert.equal(items.checks.status, "fail");
});

test("preflight on Linux and macOS requires tmux; on Windows there is no tmux item", async () => {
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const project = pfProject(UI_PLAN);
  const skip = [...QUIET, "plan", "checks", "playwright", "dev server"];
  const without = tmp("autoclaude-pf-notmux-");
  let r = await preflight(project, { env: { PATH: without }, userConfigFile, skip, platform: "linux" });
  assert.equal(itemsOf(r).tmux.status, "fail");
  assert.match(formatPreflight(r), /FAIL tmux: `tmux` is not on PATH; on Linux and macOS the run needs it/);
  assert.equal(r.ok, false);

  const withTmux = tmp("autoclaude-pf-tmux-");
  for (const f of ["tmux", "tmux.exe"]) fs.writeFileSync(path.join(withTmux, f), "");
  r = await preflight(project, { env: { PATH: withTmux }, userConfigFile, skip, platform: "darwin" });
  assert.equal(itemsOf(r).tmux.status, "ok");

  r = await preflight(project, { env: { PATH: without }, userConfigFile, skip, platform: "win32" });
  assert.equal(itemsOf(r).tmux, undefined);
});

test("preflight warns, never fails, about a phase whose largest verification part does not fit; recorded check times count", async () => {
  const env = gitEnv(process.env);
  const userConfigFile = path.join(tmp("autoclaude-pf-cfg-"), ".claude.json");
  const node = JSON.stringify(process.execPath);
  const suite = { name: "suite", command: `${node} -e 0`, timeoutSec: 1500 };
  const project = pfProject(UI_PLAN, { checks: [suite] });
  let r = await preflight(project, { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" });
  const warn = itemsOf(r)["phase size"];
  assert.equal(warn.status, "warn");
  assert.match(warn.detail, /^Phase 1 \(A\) does not fit its verification: its check "suite" needs up to 1500 s \(its timeoutSec; not timed yet\), more than 1218 s .*`autoclaude checks` times it\./);
  assert.equal(r.ok, true, formatPreflight(r));
  assert.match(formatPreflight(r), /\n {2}warn phase size: Phase 1 \(A\) does not fit/);

  // Timed on this computer at two minutes: nothing to warn about.
  recordCheckTimes(project.root, [{ name: "suite", ok: true, ran: true, durationMs: 120000 }]);
  r = await preflight(project, { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" });
  assert.equal(itemsOf(r)["phase size"], undefined);

  // A plan that fails lint is the plan item's FAIL alone; there is nothing to estimate.
  const broken = pfProject("# P\n\n## Phase 1: A\n- [ ] **S1.1** no accept line\n", { checks: [suite] });
  r = await preflight(broken, { env, userConfigFile, devServer: false, skip: QUIET, platform: "win32" });
  assert.equal(itemsOf(r)["phase size"], undefined);
  assert.equal(itemsOf(r).plan.status, "fail");
});
