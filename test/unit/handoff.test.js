import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeHandoff, commitsByStep, HANDOFF_FILE, handoffFileFor, handoffFileName } from "../../plugins/autoclaude/lib/handoff.js";
import { buildSummary } from "../../plugins/autoclaude/lib/summary.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig, loadConfig, setRunPlan, runPlanFile } from "../../plugins/autoclaude/lib/config.js";
import { runGate } from "../../plugins/autoclaude/lib/gate.js";
import { loadState, saveState, defaultState, beginRunPlan, mainStateFile } from "../../plugins/autoclaude/lib/state.js";
import { writeReady } from "../../plugins/autoclaude/lib/protocol.js";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";

// Usage and this computer's defaults come from a throwaway config dir, never the machine's.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-handoff-cfg-"));
const env = gitEnv(process.env);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-handoff-"));
const config = mergeConfig({ git: { push: true } });

const PLAN = `# Todo fixture plan

## Goal

A todo app.

## After the run

What the owner does once the run is complete.

- Run the DNS script on the router:
  \`\`\`
  ssh admin@router ./scripts/dns.sh
  \`\`\`
- Sign in to the admin page once at http://127.0.0.1:4173/admin

## Phase 1: Three features

- [x] **S1.1** Clear completed todos
  - Accept: a
- [x] **S1.2** Show how many are done
  - Accept: b
- [x] **S1.3** Edit a todo's text
  - Accept: c

## Phase 2: Settings

- [x] **S2.1** Dark mode
  - Accept: d
`;

const DECISIONS = `# DECISIONS

## D-001 (2026-09-20, planning) Postgres in Docker
- Choice: Postgres 16
- By: owner

## D-002 (2026-09-28, S1.2) Count done todos on the client
- Choice: client side
- By: decider

## D-003 (2026-09-28, S2.1) Store the theme in a cookie without SameSite
- Choice: cookie without SameSite
- Why: the old browser on the kiosk rejects it
- Reverse by: add SameSite=Lax once the kiosk is replaced
- By: decider
- Owner review: yes
`;

function git(root, args) {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf8", env });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

function project() {
  const root = tmp();
  prepareFixture({ dest: root, plan: "happy", git: true, env });
  const base = git(root, ["rev-parse", "HEAD"]);
  git(root, ["checkout", "-q", "-b", "autoclaude/todo-fixture"]);
  const commit = (subject) => { fs.appendFileSync(path.join(root, "server.js"), `// ${subject}\n`); git(root, ["commit", "-q", "-am", subject]); return git(root, ["rev-parse", "--short=7", "HEAD"]); };
  const shas = { s11: commit("autoclaude(S1.1): Clear completed todos"), s1213: commit("autoclaude(S1.2, S1.3): Show how many are done; Edit"), other: commit("chore: not a step"), s21: commit("autoclaude(S2.1): Dark mode") };
  fs.writeFileSync(path.join(root, "PLAN.md"), PLAN);
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), DECISIONS);
  fs.writeFileSync(path.join(root, "docs", "BLOCKERS.md"), "# BLOCKERS\n\n| Date | Found by | Step | What | Owner | Status |\n|---|---|---|---|---|---|\n| 2026-09-28 | bug bash | S1.1 | low: button wraps on narrow screens | Claude | fixed in S1.3 |\n| 2026-09-28 | builder | S2.1 | Add the DNS record for todo.lan | owner | left for the owner: needs the router's admin login |\n| 2026-09-28 | browser tester | S2.1 | medium: theme flickers on reload | Claude | open |\n");
  // The default findings file: gitignored under docs/private/ (P10.10).
  fs.mkdirSync(path.join(root, "docs", "private"), { recursive: true });
  fs.writeFileSync(path.join(root, "docs", "private", "SECURITY-FINDINGS.md"), "| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n| 2026-09-28 | low | server.js:12 | no rate limit on /api/todos | add a limit | open |\n");
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "db.env"), "DB_PASSWORD=hunter2-very-secret\n");
  return { root, base, shas };
}

const FOOTPRINT = {
  removed: [{ kind: "container", id: "c".repeat(64), name: "test-db", image: "postgres:16" }, { kind: "volume", id: "f".repeat(64), name: "f".repeat(64) }],
  kept: [{ kind: "volume", id: "app-data", name: "app-data", reason: "a container uses it" }],
  runningCreated: [{ kind: "container", id: "b".repeat(64), name: "app-db", image: "postgres:16", state: "running" }],
  secretsCreated: ["secrets/db.env"],
  goneSinceStart: [{ kind: "volume", id: "old-cache", name: "old-cache" }],
  errors: [],
  dockerChecked: true
};

test("commitsByStep maps gate commit subjects to steps, oldest first", () => {
  const m = commitsByStep([{ sha: "4444444aaa", subject: "autoclaude(S1.2): fix-up" }, { sha: "3333333aaa", subject: "chore: x" }, { sha: "2222222aaa", subject: "autoclaude(S1.1, S1.2): resumed" }, { sha: "1111111aaa", subject: "autoclaude(S1.1): first" }]);
  assert.deepEqual(Object.fromEntries(m), { "S1.1": ["1111111", "2222222"], "S1.2": ["2222222", "4444444"] });
});

test("writeHandoff: HANDOFF.md with what was built, what is left, secrets by name, findings, decisions, push and footprint", () => {
  const { root, base, shas } = project();
  const parsed = parsePlan(PLAN);
  const state = {
    status: "complete", startedAt: "2026-09-28T01:00:00.000Z", baseCommit: base,
    pushState: { branch: "autoclaude/todo-fixture", remote: "origin", ok: false, at: "2026-09-28T09:00:00.000Z", error: "ssh: connect to host github.com port 22: Connection timed out", unpushedCommits: 2, unpushedTags: ["ac-phase-2"] }
  };
  const r = writeHandoff({ root, config, state, parsed, footprint: FOOTPRINT, env, now: new Date("2026-09-28T10:30:00.000Z") });
  assert.equal(r.path, path.join(root, HANDOFF_FILE));
  const text = fs.readFileSync(r.path, "utf8");

  // The summary the alert uses.
  const s = r.summary;
  assert.deepEqual([s.built.done, s.built.total, s.built.phases.length], [4, 4, 2]);
  assert.deepEqual(s.ownerItems.map((i) => i.from), ["plan", "plan", "docs/BLOCKERS.md"]);
  assert.deepEqual(s.secretsCreated, ["secrets/db.env"]);
  assert.deepEqual(s.openFindings.map((f) => f.source), ["follow-up", "security"], "medium before low; the left-for-owner row is an owner item, not repeated");
  assert.deepEqual(s.ownerReviewDecisions.map((d) => d.id), ["D-003"]);
  assert.equal(s.runDecisions, 2, "D-001 was made while planning");
  assert.equal(s.push, state.pushState);
  assert.equal(s.footprint, FOOTPRINT);

  // What was built, with commits.
  assert.match(text, /^# Hand-back: Todo fixture$/m);
  assert.match(text, /### Phase 1: Three features\n\n- S1\.1 Clear completed todos: verified, commit (\w{7})\n/);
  assert.ok(text.includes(`- S1.1 Clear completed todos: verified, commit ${shas.s11}`));
  assert.ok(text.includes(`- S1.3 Edit a todo's text: verified, commit ${shas.s1213}`));
  assert.ok(text.includes(`- S2.1 Dark mode: verified, commit ${shas.s21}`));
  assert.ok(text.includes(`git log --oneline ${base.slice(0, 7)}..autoclaude/todo-fixture`));
  // Left for the owner, with the exact commands, and without the template's intro.
  assert.match(text, /## Left for you\n\nFrom the plan's "After the run" section \(PLAN\.md\):\n\n- Run the DNS script on the router:\n  ```\n  ssh admin@router \.\/scripts\/dns\.sh\n  ```/);
  assert.doesNotMatch(text, /What the owner does once the run is complete/);
  assert.match(text, /- S2\.1 Add the DNS record for todo\.lan\. Status: left for the owner: needs the router's admin login\. \(docs\/BLOCKERS\.md\)/);
  // Secrets: the name, never the value, and a warning when git would commit it.
  assert.match(text, /- `secrets\/db\.env` - WARNING: git does not ignore this file/);
  assert.ok(!text.includes("hunter2"), "a secret value never reaches HANDOFF.md");
  // Decisions.
  assert.match(text, /- \*\*D-003\*\* \(2026-09-28, S2\.1\) Store the theme in a cookie without SameSite\. Choice: cookie without SameSite\. Why: the old browser on the kiosk rejects it\. Reverse by: add SameSite=Lax once the kiosk is replaced\. By: decider/);
  assert.match(text, /## Decisions the run made\n\n2 decisions logged during the run, in docs\/DECISIONS\.md:\n\n- D-002 \(S1\.2, by decider\) Count done todos on the client\n- D-003/);
  // Open findings, the fixed row left out.
  assert.match(text, /- Follow-up \(2026-09-28\): S2\.1 medium: theme flickers on reload\. Status: open\. \(docs\/BLOCKERS\.md\)/);
  // A row of the private findings file: its severity and where it is, never what it says, since
  // HANDOFF.md is committed and pushed.
  assert.match(text, /- Security \(2026-09-28\): low security finding, details in docs\/private\/SECURITY-FINDINGS\.md \(kept out of git\)\. Status: open/);
  assert.doesNotMatch(text, /no rate limit|add a limit|server\.js:12/);
  assert.doesNotMatch(text, /button wraps/);
  // Push: what failed before this file was committed, and the commands that finish it if the
  // push after it fails too.
  assert.match(text, /- Push before this file was committed: FAILED for autoclaude\/todo-fixture \(2026-09-28 09:00 UTC\): ssh: connect to host github\.com port 22: Connection timed out\. Not on the remote: 2 commits and 1 tag \(ac-phase-2\)\.\n/);
  assert.match(text, /## Push\n\nBefore this file was committed: FAILED for autoclaude\/todo-fixture \(2026-09-28 09:00 UTC\)/);
  assert.match(text, /The completion alert says how that push went\. If it says the push failed, push from the project folder:\n\n```\ngit push origin autoclaude\/todo-fixture\ngit push origin ac-phase-2\n```/);
  // The footprint, with a command for everything it did not remove.
  assert.match(text, /- container `app-db` \(image postgres:16\), running: `docker rm -f app-db`/);
  assert.match(text, /- volume `app-data`: a container uses it\. To remove it: `docker volume rm app-data`/);
  assert.match(text, /Removed: unused things the run created\.\n\n- container `test-db` \(image postgres:16\)\n- volume `f{12}`\n/);
  assert.match(text, /Gone since the run started[^\n]*\n\n- volume `old-cache`/);
  assert.match(text, /- This computer: removed 2 unused Docker objects the run created, 1 container the run started still running, kept 1\./);
  assert.doesNotMatch(text, /\n{3,}/);

  // The completion alert says the same thing.
  const alert = buildSummary({ root, config, state, parsed, handoff: r, now: Date.parse("2026-09-28T10:30:00Z") });
  assert.match(alert, /Decisions the run made: 2\./);
  assert.match(alert, /For your review: 1 decision marked "Owner review: yes": D-003/);
  assert.match(alert, /Left for you: 3 items: Run the DNS script on the router:; Sign in to the admin page once/);
  assert.match(alert, /The run created 1 secret file in secrets\//);
  assert.match(alert, /Hand-back: HANDOFF\.md in the project folder\./);

  // Once secrets/ is ignored, the warning goes.
  fs.appendFileSync(path.join(root, ".gitignore"), "secrets/\n");
  const again = fs.readFileSync(writeHandoff({ root, config, state, parsed, footprint: FOOTPRINT, env }).path, "utf8");
  assert.match(again, /- `secrets\/db\.env`\n/);
  assert.doesNotMatch(again, /WARNING/);

  // A secret a commit already holds is called exposed, not just unignored.
  fs.writeFileSync(path.join(root, "secrets", "api.key"), "sk-live-very-secret\n");
  git(root, ["add", "-f", "secrets/api.key"]);
  git(root, ["commit", "-q", "-m", "autoclaude(S2.1): leaked"]);
  const leaked = fs.readFileSync(writeHandoff({ root, config, state, parsed, footprint: { ...FOOTPRINT, secretsCreated: ["secrets/api.key", "secrets/db.env"] }, env }).path, "utf8");
  assert.match(leaked, /- Secrets the run created: 2 files in `secrets\/` \(1 COMMITTED to git\)\./);
  assert.match(leaked, /- `secrets\/api\.key` - WARNING: this file is in git \(the run never commits secrets\/, so it got there another way\)\. Treat the secret as exposed/);
  assert.match(leaked, /- `secrets\/db\.env`\n/);
  assert.ok(!leaked.includes("sk-live"));
});

test("writeHandoff: the push state is worded as before this file, so the pushed file stays true whatever its own push does", () => {
  const root = tmp();
  const plan = "# Push plan\n\n## Phase 1: A\n- [x] **S1.1** One\n  - Accept: a\n";
  const write = (cfg, pushState) => fs.readFileSync(writeHandoff({ root, config: cfg, state: { status: "complete", pushState }, parsed: parsePlan(plan), footprint: null, env, commits: [] }).path, "utf8");
  const failed = { branch: "autoclaude/p", remote: "origin", ok: false, at: "2026-09-28T09:00:00.000Z", error: "timed out", unpushedCommits: 2, unpushedTags: ["ac-phase-1"] };
  const ok = { branch: "autoclaude/p", remote: "origin", ok: true, at: "2026-09-28T09:00:00.000Z", unpushedTags: [] };
  // The gate commits and pushes this file after writing it (the defaults): a failed push before
  // it may succeed after it, and a pushed branch may fail to take the hand-back commit.
  for (const ps of [failed, ok, null]) {
    const text = write(config, ps);
    assert.doesNotMatch(text, /^(- )?Push( FAILED|:)/m, "no unqualified push state");
    assert.match(text, /^- Push before this file was committed: /m);
    assert.match(text, /The run commits this file right after writing it and then pushes the run branch[^\n]*\. The completion alert says how that push went\. If it says the push failed, push from the project folder:\n\n```\ngit push origin [^\n]+\n/);
    assert.doesNotMatch(text, /after your review/, "the gate pushes the branch itself");
  }
  assert.match(write(config, failed), /git push origin autoclaude\/p\ngit push origin ac-phase-1\n```/);
  assert.match(write(config, ok), /Before this file was committed: autoclaude\/p and its tags are on origin \(2026-09-28 09:00 UTC\)\./);
  const skipped = write(config, { branch: "autoclaude/p", ok: false, skipped: true, error: "no git remote is configured", unpushedTags: [] });
  assert.match(skipped, /Before this file was committed: skipped: no git remote is configured\. Nothing is on the remote from this run\.\n\nThe run commits this file right after writing it and then tries to push the run branch; the completion alert says how that went\./);
  assert.doesNotMatch(skipped, /git push/);

  // Not committed by the gate (git.commitEachStep false): the recorded push is the last one.
  const uncommitted = write(mergeConfig({ git: { push: true, commitEachStep: false } }), failed);
  assert.match(uncommitted, /^- Push FAILED for autoclaude\/p \(2026-09-28 09:00 UTC\): timed out\. Not on the remote: 2 commits and 1 tag \(ac-phase-1\)\.$/m);
  assert.match(uncommitted, /## Push\n\nPush FAILED for autoclaude\/p[^\n]*\n\nTo push what is missing, from the project folder:\n\n```\ngit push origin autoclaude\/p\ngit push origin ac-phase-1\n```/);
  assert.doesNotMatch(uncommitted, /Before this file was committed/);
});

test("writeHandoff counts a second run of the same day by the decisions log at the run's base commit", () => {
  const root = tmp();
  prepareFixture({ dest: root, plan: "happy", git: true, env });
  // The first run's entries, committed before the second run started (start needs a clean tree).
  const first = "# DECISIONS\n\n## D-001 (2026-09-28, planning) Postgres 16\n- By: owner\n\n## D-002 (2026-09-28, S1.1) First run: open port 8080 on the LAN\n- By: decider\n- Owner review: yes\n\n## N-001 (2026-09-28, S1.2) First run's note\n- Note: x\n- Done: y\n";
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), first);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "first run"]);
  const base = git(root, ["rev-parse", "HEAD"]);
  fs.appendFileSync(path.join(root, "docs", "DECISIONS.md"), "\n## D-003 (2026-09-28, S2.1) Second run: keep the default theme\n- By: decider\n\n## N-002 (2026-09-28, S2.1) Second run's note\n- Note: a\n- Done: b\n");
  const parsed = parsePlan(PLAN);
  const state = { status: "complete", startedAt: "2026-09-28T15:00:00.000Z", baseCommit: base };
  const r = writeHandoff({ root, config, state, parsed, footprint: null, env, commits: [] });
  assert.equal(r.summary.runDecisions, 1);
  assert.deepEqual(r.summary.ownerReviewDecisions, []);
  const text = fs.readFileSync(r.path, "utf8");
  assert.match(text, /## Decisions the run made\n\n1 decision logged during the run, in docs\/DECISIONS\.md:\n\n- D-003 \(S2\.1, by decider\) Second run: keep the default theme\n\n/);
  assert.match(text, /- Decisions for you to review: none\./);
  assert.match(buildSummary({ root, config, state, parsed }), /Decisions the run made: 1, owner notes handled: 1\./);
  // A mark the gate recorded at start wins over the base commit.
  assert.equal(writeHandoff({ root, config, state: { ...state, decisionsAtStart: { D: 0, N: 0 } }, parsed, footprint: null, env, commits: [] }).summary.runDecisions, 2);
});

test("writeHandoff on a quiet run: nothing left, nothing open, push off, footprint not checked", () => {
  const root = tmp();
  const plan = "# Quiet plan\n\n## After the run\n\n- Nothing: the run does all of this plan.\n\n## Phase 1: A\n- [x] **S1.1** One\n  - Accept: a\n- [~] **S1.2** Two\n  - Accept: b\n";
  const r = writeHandoff({ root, config: mergeConfig({ git: { push: false } }), state: { status: "complete" }, parsed: parsePlan(plan), footprint: null, env, commits: [] });
  const text = fs.readFileSync(r.path, "utf8");
  assert.deepEqual([r.summary.built.done, r.summary.built.built, r.summary.ownerItems.length, r.summary.openFindings.length, r.summary.runDecisions], [1, 1, 0, 0, 0]);
  assert.match(text, /1 of 2 steps are verified and 1 are built but not verified yet/);
  assert.match(text, /- S1\.2 Two: built, not verified yet\n/);
  assert.match(text, /## Left for you\n\nNothing\. The plan lists nothing for after the run, and the run left nothing for you\./);
  assert.match(text, /Push: off \(git\.push is false\), so nothing was pushed\./);
  assert.match(text, /## Decisions for you to review\n\nNone\./);
  assert.match(text, /## Open findings\n\nNone\./);
  assert.match(text, /## What the run left on this computer\n\nNot checked: the run did not record its footprint\./);
  assert.match(text, /None: everything the run needed was settled in the plan\./);
  assert.doesNotMatch(text, /Secrets the run created/);

  const noDocker = fs.readFileSync(writeHandoff({ root, config, state: {}, parsed: parsePlan(plan), footprint: { removed: [], kept: [], runningCreated: [], secretsCreated: [], goneSinceStart: [], errors: [], dockerChecked: false }, env, commits: [] }).path, "utf8");
  assert.match(noDocker, /Docker was not checked: it is not installed here, or it was not running when the run ended\./);
  assert.match(noDocker, /- This computer: Docker not checked \(not installed or not running\)\./);
});

test("writeHandoff and the alert list Docker objects not tied to the project, with no remove command, and say what tied the rest", () => {
  const root = tmp();
  const plan = "# Docker plan\n\n## Phase 1: A\n- [x] **S1.1** One\n  - Accept: a\n";
  const footprint = {
    removed: [{ kind: "volume", id: "app-cache", name: "app-cache", attributedBy: "a container of this project used it" }],
    kept: [], runningCreated: [{ kind: "container", id: "b".repeat(64), name: "app-web", image: "node:24", state: "running", attributedBy: "its compose folder is in the project" }],
    unattributed: [
      { kind: "container", id: "d".repeat(64), name: "other-db", image: "postgres:16", state: "exited", reason: "new since the run started, but its compose folder is outside this project (C:/other); it may be another project's or yours, so the run left it alone" },
      { kind: "volume", id: "e".repeat(64), name: "e".repeat(64), reason: "not provably new." }
    ],
    secretsCreated: [], goneSinceStart: [], errors: [], dockerChecked: true
  };
  const r = writeHandoff({ root, config: mergeConfig({ git: { push: false } }), state: { status: "complete" }, parsed: parsePlan(plan), footprint, env, commits: [] });
  const text = fs.readFileSync(r.path, "utf8");
  assert.match(text, /- This computer: removed 1 unused Docker object the run created, 1 container the run started still running, left alone 2 not tied to this project\./);
  assert.match(text, /New while the run was going, but not tied to this project, so the run left them alone \(another project, or you, may have made them\):\n\n- container `other-db` \(image postgres:16\), exited: new since the run started, but its compose folder is outside this project \(C:\/other\); it may be another project's or yours, so the run left it alone\.\n- volume `e{12}`: not provably new\.\n/);
  const section = text.slice(text.indexOf("New while the run was going"));
  assert.doesNotMatch(section.slice(0, section.indexOf("\n\n", section.indexOf("\n- "))), /docker (?:rm|volume rm)/, "no remove command for what may be another project's");
  assert.match(text, /- container `app-web` \(image node:24\) \(its compose folder is in the project\), running: `docker rm -f app-web`/);
  assert.match(text, /- volume `app-cache` \(a container of this project used it\)\n/);
  const alert = buildSummary({ root, config: mergeConfig({ git: { push: false } }), state: { status: "complete" }, parsed: parsePlan(plan), handoff: r });
  assert.match(alert, /Docker: removed 1 unused thing the run created, 1 container it started still running, left alone 2 not tied to this project\./);
});

// ---------- flaky checks (P10.14, D62) ----------

test("writeHandoff lists the run's flaky checks by check, says where each was flaky and that its test needs fixing; a run without one says nothing about them", () => {
  const root = tmp();
  const plan = "# Lists plan\n\n## Phase 1: Lists\n- [x] **S1.1** One\n  - Accept: a\n- [x] **S1.2** Two\n  - Accept: b\n\n## Phase 2: More\n- [x] **S2.1** Three\n  - Accept: c\n";
  const startedAt = "2026-10-04T08:00:00.000Z";
  const entry = (name, step, phase, feature, stage, at) => ({ name, step, phase, feature, stage, at, firstReason: "exit code 1" });
  const flakyChecks = [
    entry("unit", "S1.1", 1, false, "verify", "2026-10-03T20:00:00.000Z"),
    entry("unit", "S1.2", 1, true, "verify", "2026-10-04T09:00:00.000Z"),
    entry("e2e", "S1.2", 1, true, "fixup", "2026-10-04T09:30:00.000Z"),
    entry("unit", "S2.1", 2, false, "recheck", "2026-10-04T10:00:00.000Z")
  ];
  const write = (state) => writeHandoff({ root, config: mergeConfig({ git: { push: false } }), state: { status: "complete", startedAt, ...state }, parsed: parsePlan(plan), footprint: null, env, commits: [] });
  const r = write({ flakyChecks });
  assert.deepEqual(r.summary.flakyChecks.map((e) => `${e.name}@${e.step}`), ["unit@S1.2", "e2e@S1.2", "unit@S2.1"], "only this run's");
  const text = fs.readFileSync(r.path, "utf8");
  assert.match(text, /\n- Flaky checks: 2 \(`unit`, `e2e`\), to fix\.\n/);
  assert.match(text, /\n## Open findings\n\nNone\.\n\n## Flaky checks\n\nThese checks failed, then passed when the gate ran them again right away, so they counted as passed\. A check that passes only some of the time hides real failures and costs the run time: fix each test so it passes every time\.\n\n- `unit`, 2 times: Phase 1 \(Lists\), verified at S1\.2; S2\.1, in Phase 2 \(More\), with its findings filed\.\n- `e2e`: the fix-up checks of Phase 1 \(Lists\) at S1\.2\.\n\n## What was built\n/);
  assert.doesNotMatch(text, /S1\.1, in Phase 1/, "an earlier run's flaky check is not this run's");
  assert.doesNotMatch(text, /\n{3,}/);
  // No flaky check in this run: no line, no section.
  for (const state of [{}, { flakyChecks: [flakyChecks[0]] }]) {
    const quiet = write(state);
    assert.deepEqual(quiet.summary.flakyChecks, []);
    assert.doesNotMatch(fs.readFileSync(quiet.path, "utf8"), /[Ff]laky/);
  }
});

test("a check that was flaky in the run's last verification is in the hand-back and the completion alert", async () => {
  const root = tmp();
  const node = JSON.stringify(process.execPath);
  // It fails on its first run and passes on every other.
  const flaky = { name: "unit", command: `${node} -e "const f=require('fs'),p='.autoclaude/runs-unit';f.appendFileSync(p,'x');if(f.readFileSync(p,'utf8').length===1){console.log('flaky boom');process.exit(1)}"`, timeoutSec: 60 };
  prepareFixture({ dest: root, plan: "broken", git: true, checks: [flaky], devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 10 }, env });
  const cfgFile = path.join(root, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), gate: { verifyAt: "step" } }, null, 2) + "\n");
  git(root, ["commit", "-q", "-am", "verify per step"]);
  saveState(root, { ...defaultState(), status: "running", currentStep: "S1.1", tickedByGate: [], startedAt: new Date().toISOString(), baseCommit: git(root, ["rev-parse", "HEAD"]) });
  writeReady(root, "S1.1");
  const sent = [];
  const r = await runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, { env, root, notify: async (m) => { sent.push(m); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null, noteFootprint: null, finishFootprint: null });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.ok(r.events.some((e) => e.type === "check-flaky"), JSON.stringify(r.events));
  assert.equal(loadState(root).status, "complete");
  const text = fs.readFileSync(path.join(root, HANDOFF_FILE), "utf8");
  assert.match(text, /\n- Flaky checks: 1 \(`unit`\), to fix\.\n/);
  assert.match(text, /\n## Flaky checks\n\n[^\n]+fix each test so it passes every time\.\n\n- `unit`: S1\.1, in Phase 1 \(Impossible\)\.\n/);
  assert.equal(git(root, ["log", "-1", "--format=%s"]), "autoclaude: hand-back");
  assert.match(sent.at(-1).title, /plan complete/);
  assert.match(sent.at(-1).message, /\nFlaky checks: unit: each failed, then passed when run again; fix the tests\.\n/);
});

// ---------- a run on a generated plan (P10.7) ----------

test("handoffFileFor names a generated plan's hand-back after it; handoffFileName uses it only while that plan is the run's override", () => {
  assert.equal(handoffFileFor("SECURITY_PLAN.md"), "HANDOFF-SECURITY.md");
  assert.equal(handoffFileFor("OPTIMIZE_PLAN.md"), "HANDOFF-OPTIMIZE.md");
  assert.equal(handoffFileFor("plans/fix-plan.md"), "HANDOFF-FIX.md");
  assert.equal(handoffFileFor("Hardening.md"), "HANDOFF-HARDENING.md");
  assert.equal(handoffFileFor("plan.md"), "HANDOFF-RUN.md");
  const root = tmp();
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), "# Security fixes\n");
  assert.equal(handoffFileName(root, mergeConfig({})), HANDOFF_FILE);
  setRunPlan(root, "SECURITY_PLAN.md");
  assert.equal(handoffFileName(root, loadConfig(root).config), "HANDOFF-SECURITY.md");
  assert.equal(handoffFileName(root, mergeConfig({})), HANDOFF_FILE, "a config that names the project's own plan keeps HANDOFF.md");
});

test("during a run on a generated plan, the alert's hand-back line and the builder's rules name HANDOFF-SECURITY.md, not HANDOFF.md", async () => {
  const root = tmp();
  const fixPlan = "# Security fixes 2026-10-02\n\n## Phase 1: Fixes\n\n- [x] **SF1.1** Resolve finding SEC-001\n  - Tags: no-ui\n  - Test: test/sec.test.js\n  - Accept: the check passes\n";
  fs.writeFileSync(path.join(root, "PLAN.md"), "# Own plan\n\n## Phase 1: One\n- [x] **S1.1** a\n  - Accept: a\n");
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), fixPlan);
  setRunPlan(root, "SECURITY_PLAN.md");
  const config = loadConfig(root).config;
  const startedAt = new Date(Date.now() - 60000).toISOString();
  // A fresh HANDOFF-SECURITY.md (no hand-back result handed in, as for a later summary).
  fs.writeFileSync(path.join(root, "HANDOFF-SECURITY.md"), "# Hand-back\n");
  const text = buildSummary({ root, config, state: { status: "complete", startedAt }, parsed: parsePlan(fs.readFileSync(path.join(root, "SECURITY_PLAN.md"), "utf8")) });
  assert.match(text, /Hand-back: HANDOFF-SECURITY\.md in the project folder\./);
  assert.doesNotMatch(text, /HANDOFF\.md/);
  // The builder's session context says where its hand-back goes.
  const { buildContext } = await import("../../plugins/autoclaude/scripts/session-context.js");
  const ctx = buildContext({ root, state: { ...defaultState(), status: "running", currentStep: "SF1.1" }, config, planText: fixPlan, progressText: "", promptTemplate: "the run's hand-back, `{{HANDOFF_FILE}}`, gathers these rows" });
  assert.match(ctx, /the run's hand-back, `HANDOFF-SECURITY\.md`, gathers these rows/);
  const own = buildContext({ root: tmp(), state: { ...defaultState(), status: "running", currentStep: "S1.1" }, config: mergeConfig({}), planText: "", progressText: "", promptTemplate: "`{{HANDOFF_FILE}}`" });
  assert.match(own, /`HANDOFF\.md`/);
  // And the real prompt uses the slot.
  assert.match(fs.readFileSync(new URL("../../plugins/autoclaude/prompts/context.md", import.meta.url), "utf8"), /the run's hand-back, `\{\{HANDOFF_FILE\}\}`/);
});

const FIX_PLAN = `# Security fixes 2026-10-02

## Phase 1: Fixes

- [ ] **SEC1.1** Resolve finding SEC-001
  - Tags: no-ui
  - Test: test/sec.test.js
  - Accept: the check passes
`;

test("a run on a generated plan completes with HANDOFF-SECURITY.md committed, HANDOFF.md untouched, and the project handed back to its own plan and state", async () => {
  const root = tmp();
  const node = JSON.stringify(process.execPath);
  prepareFixture({ dest: root, plan: "happy", git: true, checks: [{ name: "unit", command: `${node} -e "process.exit(0)"`, timeoutSec: 60 }], devServer: { command: null, url: null, healthPath: "/", startTimeoutSec: 10 }, env });
  const cfgFile = path.join(root, "autoclaude.config.json");
  fs.writeFileSync(cfgFile, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfgFile, "utf8")), gate: { verifyAt: "step" } }, null, 2) + "\n");
  fs.writeFileSync(path.join(root, "HANDOFF.md"), "# Hand-back: the project's own last run\n");
  fs.writeFileSync(path.join(root, "SECURITY_PLAN.md"), FIX_PLAN);
  git(root, ["checkout", "-q", "-b", "autoclaude/security-fixes-2026-10-02"]);
  git(root, ["add", "-A"]);
  git(root, ["commit", "-q", "-m", "autoclaude: fix plan from sweep s1"]);
  const planBefore = fs.readFileSync(path.join(root, "PLAN.md"), "utf8");
  // The project's own run finished earlier and has a note waiting; run --plan kept it aside.
  saveState(root, { ...defaultState(), status: "complete", pendingNotes: [{ at: "2026-10-01T00:00:00Z", text: "keep the table" }], tickedByGate: ["S1.1"] });
  beginRunPlan(root, "SECURITY_PLAN.md", { branch: "autoclaude/security-fixes-2026-10-02", sweepId: "s1" }, { now: new Date("2026-10-02T10:00:00Z") });
  saveState(root, { ...loadState(root), status: "running", currentStep: "SEC1.1", tickedByGate: [], startedAt: new Date().toISOString(), baseCommit: git(root, ["rev-parse", "HEAD"]) });
  writeReady(root, "SEC1.1");
  const sent = [];
  const r = await runGate({ cwd: root, session_id: "s", hook_event_name: "Stop", stop_hook_active: false }, { env, root, notify: async (m) => { sent.push(m); return { ok: true }; }, stdout: { write() {} }, runTester: null, runSecurity: null, noteFootprint: null, finishFootprint: null });
  assert.equal(r.decision, "allow", JSON.stringify(r.events));
  assert.match(sent.at(-1).title, /plan complete \(security-fixes-2026-10-02\)/);
  // The generated plan's hand-back, committed under its own name; the project's own is untouched.
  assert.ok(fs.existsSync(path.join(root, "HANDOFF-SECURITY.md")));
  assert.match(fs.readFileSync(path.join(root, "HANDOFF-SECURITY.md"), "utf8"), /^# Hand-back: Security fixes 2026-10-02/);
  assert.equal(fs.readFileSync(path.join(root, "HANDOFF.md"), "utf8"), "# Hand-back: the project's own last run\n");
  assert.equal(git(root, ["log", "-1", "--format=%s"]), "autoclaude: hand-back");
  assert.match(git(root, ["log", "-1", "--format=%b"]), /^HANDOFF-SECURITY\.md, written when the plan completed/);
  assert.equal(git(root, ["show", "--name-only", "--format=", "HEAD"]), "HANDOFF-SECURITY.md");
  assert.match(fs.readFileSync(path.join(root, "SECURITY_PLAN.md"), "utf8"), /- \[x\] \*\*SEC1\.1\*\*/);
  assert.equal(fs.readFileSync(path.join(root, "PLAN.md"), "utf8"), planBefore, "the project's own plan is untouched");
  // Handed back: the project's own state (with its note) is in state.json again, the override is gone.
  const s = loadState(root);
  assert.deepEqual([s.status, s.pendingNotes.length, s.tickedByGate], ["complete", 1, ["S1.1"]]);
  assert.deepEqual([s.lastRunPlan.plan, s.lastRunPlan.branch, s.lastRunPlan.sweepId], ["SECURITY_PLAN.md", "autoclaude/security-fixes-2026-10-02", "s1"]);
  assert.equal(fs.existsSync(runPlanFile(root)), false);
  assert.equal(fs.existsSync(mainStateFile(root)), false);
  assert.equal(loadConfig(root).config.plan, "PLAN.md");
  assert.match(fs.readFileSync(path.join(root, ".autoclaude", "logs", "gate.log"), "utf8"), /the run on SECURITY_PLAN\.md is complete; the project's own plan and its run state are back/);
});
