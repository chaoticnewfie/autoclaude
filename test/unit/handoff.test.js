import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeHandoff, commitsByStep, HANDOFF_FILE } from "../../plugins/autoclaude/lib/handoff.js";
import { buildSummary } from "../../plugins/autoclaude/lib/summary.js";
import { parsePlan } from "../../plugins/autoclaude/lib/plan.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { prepareFixture, gitEnv } from "../fixtures/prepare.js";

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
  fs.writeFileSync(path.join(root, "docs", "SECURITY-FINDINGS.md"), "| Date | Severity | File | Issue | Fix | Status |\n|---|---|---|---|---|---|\n| 2026-09-28 | low | server.js:12 | no rate limit on /api/todos | add a limit | open |\n");
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
  assert.match(text, /- Security \(2026-09-28\): low server\.js:12 no rate limit on \/api\/todos\. Fix: add a limit\. Status: open/);
  assert.doesNotMatch(text, /button wraps/);
  // Push: what failed and the commands that finish it.
  assert.match(text, /Push FAILED for autoclaude\/todo-fixture \(2026-09-28 09:00 UTC\): ssh: connect to host github\.com port 22: Connection timed out\. Not on the remote: 2 commits and 1 tag \(ac-phase-2\)\./);
  assert.match(text, /```\ngit push origin autoclaude\/todo-fixture\ngit push origin ac-phase-2\n```/);
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
