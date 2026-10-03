import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../plugins/autoclaude/lib/proc.js";
import { git as gitRun, isRepo, status, currentBranch, head, branchExists, tagExists, checkoutBranch, commitAll, tag, log, showFile, remoteFor, unpushedCount, pushRun } from "../../plugins/autoclaude/lib/git.js";

// Git is not on PATH in every shell on the dev VM; on Windows the tests prepend its cmd dir.
const GIT_DIR = "C:\\Program Files\\Git\\cmd";

function envWithGit() {
  const env = { ...process.env };
  if (process.platform === "win32" && fs.existsSync(GIT_DIR)) {
    const key = Object.keys(env).find((k) => k.toUpperCase() === "PATH") || "PATH";
    env[key] = GIT_DIR + path.delimiter + (env[key] || "");
  }
  return env;
}

const env = envWithGit();
const opts = { env };
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-git-"));
// Keeps git from finding a repository above the temp dir, wherever the tests run.
const outsideRepo = (root) => ({ env: { ...env, GIT_CEILING_DIRECTORIES: fs.realpathSync.native(path.dirname(root)) } });

async function sh(command, cwd, e = env) {
  const r = await runCommand(command, { cwd, env: e });
  assert.equal(r.code, 0, `${command}\n${r.stderr}`);
  return r.stdout.trim();
}

async function makeRepo({ identity = true } = {}) {
  const root = tmpDir();
  await sh("git init -q -b main", root);
  if (identity) {
    await sh('git config user.name "AutoClaude Test"', root);
    await sh("git config user.email autoclaude-test@localhost", root);
  }
  return root;
}

test("isRepo tells a repository from a plain directory", async () => {
  const root = await makeRepo();
  assert.equal(await isRepo(root, opts), true);
  const plain = tmpDir();
  assert.equal(await isRepo(plain, outsideRepo(plain)), false);
});

test("status is clean on a fresh repo, lists untracked and modified files, and never ignored ones", async () => {
  const root = await makeRepo();
  let s = await status(root, opts);
  assert.deepEqual(s, { ok: true, clean: true, entries: [], stderr: "" });
  fs.writeFileSync(path.join(root, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(root, "ignored.txt"), "x\n");
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "a.txt"), "hello\n");
  s = await status(root, opts);
  assert.equal(s.clean, false);
  assert.deepEqual(s.entries.map((e) => e.path).sort(), [".gitignore", "src/a.txt"]);
  assert.ok(s.entries.every((e) => e.code === "??"), JSON.stringify(s.entries));
  assert.equal((await commitAll(root, "first", opts)).committed, true);
  assert.equal((await status(root, opts)).clean, true);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "changed\n");
  s = await status(root, opts);
  assert.deepEqual(s.entries, [{ code: " M", path: "src/a.txt" }]);
});

test("commitAll commits everything with a multi-line message, then reports nothing to commit", async () => {
  const root = await makeRepo();
  assert.equal(await head(root, opts), null);
  assert.equal(await currentBranch(root, opts), null);
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const message = 'autoclaude(S1.1): first "quoted" step\n\nBody with \'apostrophes\', $dollars, %PATH% and `backticks`.\n#123 is not a comment\n';
  const c = await commitAll(root, message, opts);
  assert.equal(c.ok, true, c.stderr);
  assert.equal(c.committed, true);
  assert.match(c.sha, /^[0-9a-f]{40}$/);
  assert.equal(c.stderr, "");
  assert.equal(await head(root, opts), c.sha);
  assert.equal(await currentBranch(root, opts), "main");
  assert.equal(await sh("git log -1 --format=%B", root), message.trim());
  assert.equal(await sh("git log -1 --format=%an,%ae", root), "AutoClaude Test,autoclaude-test@localhost");
  const again = await commitAll(root, "nothing here", opts);
  assert.deepEqual(again, { ok: true, committed: false, sha: c.sha, stderr: "" });
  assert.deepEqual(await log(root, opts), [{ sha: c.sha, subject: 'autoclaude(S1.1): first "quoted" step' }]);
});

test("commitAll never stages secrets/, even when the project does not ignore it", async () => {
  const root = await makeRepo();
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "db-password"), "hunter2\n");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const c = await commitAll(root, "first", opts);
  assert.equal(c.ok, true, c.stderr);
  assert.equal(c.committed, true);
  assert.equal(await sh("git ls-files", root), "a.txt");
  // Only a new secret changed: nothing to commit, and the secret stays untracked.
  fs.writeFileSync(path.join(root, "secrets", "api-key"), "k\n");
  const again = await commitAll(root, "only a secret", opts);
  assert.deepEqual(again, { ok: true, committed: false, sha: c.sha, stderr: "" });
  assert.deepEqual((await status(root, opts)).entries.map((e) => e.path).sort(), ["secrets/api-key", "secrets/db-password"]);
});

test("commitAll leaves out secrets/ that was staged beforehand, nested files in it too", async () => {
  const root = await makeRepo();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write("secrets/db.env", "PGPASSWORD=hunter2\n");
  write("secrets/tls/deep/server.key", "key\n");
  write("src/x.js", "x\n");
  // The builder staged everything itself, before the gate commits (the guard allows git add).
  await sh("git add -A", root);
  const c = await commitAll(root, "first", opts);
  assert.equal(c.ok, true, c.stderr);
  assert.equal(c.committed, true);
  assert.equal(await sh("git ls-files", root), "src/x.js");
  assert.equal(await sh("git diff --cached --name-only", root), "", "the secrets are unstaged, not left for the next commit");
  // Only a staged secret changed: nothing to commit.
  write("secrets/db.env", "PGPASSWORD=changed\n");
  await sh("git add -A", root);
  assert.deepEqual(await commitAll(root, "only a secret", opts), { ok: true, committed: false, sha: c.sha, stderr: "" });
});

test("commitAll leaves out the secrets folder under another case of its name (the same folder on Windows)", async () => {
  const other = await makeRepo();
  fs.mkdirSync(path.join(other, "Secrets"));
  fs.writeFileSync(path.join(other, "Secrets", "api.key"), "k\n");
  fs.writeFileSync(path.join(other, "b.txt"), "b\n");
  await sh("git add -A", other);
  fs.mkdirSync(path.join(other, "SECRETS"), { recursive: true });
  fs.writeFileSync(path.join(other, "SECRETS", "later.key"), "k\n");
  const cased = await commitAll(other, "cased", opts);
  assert.equal(cased.ok, true, cased.stderr);
  assert.equal(await sh("git ls-files", other), "b.txt");
});

test("commitAll still commits a secrets folder deeper in the tree, which may be source code", async () => {
  const root = await makeRepo();
  fs.mkdirSync(path.join(root, "src", "secrets"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "secrets", "vault.js"), "export const vault = {};\n");
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const c = await commitAll(root, "first", opts);
  assert.equal(c.ok, true, c.stderr);
  assert.deepEqual((await sh("git ls-files", root)).split(/\r?\n/), ["a.txt", "src/secrets/vault.js"]);
});

test("commitAll never stages docs/private/, where security findings go, even staged beforehand or under another case", async () => {
  const root = await makeRepo();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write("docs/private/SECURITY-FINDINGS.md", "| 2026-10-02 | high | src/db.js:12 | details | fix | open |\n");
  write("docs/DECISIONS.md", "# DECISIONS\n");
  write("secrets/db.env", "PGPASSWORD=hunter2\n");
  write("src/docs/private/page.js", "export const page = 1;\n");
  // The builder staged everything itself before the gate commits.
  await sh("git add -A", root);
  const c = await commitAll(root, "first", opts);
  assert.equal(c.ok, true, c.stderr);
  assert.equal(c.committed, true);
  assert.deepEqual((await sh("git ls-files", root)).split(/\r?\n/), ["docs/DECISIONS.md", "src/docs/private/page.js"], "a docs/private deeper in the tree is ordinary source");
  assert.equal(await sh("git diff --cached --name-only", root), "");
  // Only the findings changed: nothing to commit, and the file stays out.
  write("docs/private/SECURITY-FINDINGS.md", "| 2026-10-03 | low | a.js | more | fix | open |\n");
  write("Docs/Private/notes.md", "x\n");
  assert.deepEqual(await commitAll(root, "only findings", opts), { ok: true, committed: false, sha: c.sha, stderr: "" });
  assert.deepEqual((await sh("git ls-files", root)).split(/\r?\n/), ["docs/DECISIONS.md", "src/docs/private/page.js"]);
});

test("commitAll works when .gitignore ignores secrets/ and docs/private/ and both exist (an exclude pathspec on them fails git add)", async () => {
  const root = await makeRepo();
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  write(".gitignore", "secrets/\ndocs/private/\n");
  write("secrets/db.env", "PGPASSWORD=hunter2\n");
  write("docs/private/SECURITY-FINDINGS.md", "| 2026-10-02 | high | a.js | x | y | open |\n");
  write("a.txt", "a\n");
  const c = await commitAll(root, "first", opts);
  assert.equal(c.ok, true, c.stderr);
  assert.equal(c.committed, true);
  assert.deepEqual((await sh("git ls-files", root)).split(/\r?\n/), [".gitignore", "a.txt"]);
  write("a.txt", "b\n");
  const again = await commitAll(root, "second", opts);
  assert.equal(again.ok, true, again.stderr);
  assert.equal(again.committed, true);
  assert.equal((await status(root, opts)).clean, true);
});

test("commitAll uses the AutoClaude identity only when no user.name is configured", async () => {
  const root = await makeRepo({ identity: false });
  const globalConfig = path.join(tmpDir(), "gitconfig");
  fs.writeFileSync(globalConfig, "");
  const bare = { env: { ...env, GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_NOSYSTEM: "1" } };
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const c = await commitAll(root, "no identity", bare);
  assert.equal(c.ok, true, c.stderr);
  assert.equal(c.committed, true);
  assert.equal(await sh("git log -1 --format=%an,%ae", root, bare.env), "AutoClaude,autoclaude@localhost");
  const t = await tag(root, "v0", { ...bare, message: "annotated without identity" });
  assert.equal(t.ok, true, t.stderr);
  assert.equal(await sh("git cat-file -t v0", root, bare.env), "tag");
});

test("checkoutBranch creates a branch the first time and checks out the existing one after", async () => {
  const root = await makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  await commitAll(root, "base", opts);
  assert.equal(await branchExists(root, "autoclaude/happy", opts), false);
  let r = await checkoutBranch(root, "autoclaude/happy", opts);
  assert.deepEqual({ ok: r.ok, created: r.created }, { ok: true, created: true }, r.stderr);
  assert.equal(await currentBranch(root, opts), "autoclaude/happy");
  assert.equal(await branchExists(root, "autoclaude/happy", opts), true);
  assert.equal(await branchExists(root, "main", opts), true);
  r = await checkoutBranch(root, "main", opts);
  assert.deepEqual({ ok: r.ok, created: r.created }, { ok: true, created: false }, r.stderr);
  assert.equal(await currentBranch(root, opts), "main");
  r = await checkoutBranch(root, "autoclaude/happy", opts);
  assert.deepEqual({ ok: r.ok, created: r.created }, { ok: true, created: false }, r.stderr);
  assert.equal(await currentBranch(root, opts), "autoclaude/happy");
  r = await checkoutBranch(root, "missing", { ...opts, create: false });
  assert.equal(r.ok, false);
  assert.equal(r.created, false);
  assert.match(r.stderr, /does not exist/);
});

test("tag makes lightweight and annotated tags, tagExists sees them, force re-points", async () => {
  const root = await makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  const first = await commitAll(root, "one", opts);
  assert.equal(await tagExists(root, "ac/phase-1", opts), false);
  let r = await tag(root, "ac/phase-1", opts);
  assert.deepEqual(r, { ok: true, stderr: "" });
  assert.equal(await tagExists(root, "ac/phase-1", opts), true);
  assert.equal(await sh("git cat-file -t ac/phase-1", root), "commit");
  r = await tag(root, "ac/phase-1-notes", { ...opts, message: 'Phase 1 done\n\nWith a "quoted" body.' });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(await sh("git cat-file -t ac/phase-1-notes", root), "tag");
  assert.match(await sh("git tag -l -n1 ac/phase-1-notes", root), /Phase 1 done/);
  r = await tag(root, "ac/phase-1", opts);
  assert.equal(r.ok, false);
  assert.match(r.stderr, /already exists/);
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  const second = await commitAll(root, "two", opts);
  assert.notEqual(second.sha, first.sha);
  r = await tag(root, "ac/phase-1", { ...opts, force: true });
  assert.equal(r.ok, true, r.stderr);
  assert.equal(await sh("git rev-list -n 1 ac/phase-1", root), second.sha);
});

test("log returns newest first with sha and subject, limited by count", async () => {
  const root = await makeRepo();
  assert.deepEqual(await log(root, opts), []);
  const shas = [];
  for (const n of ["one", "two", "three"]) {
    fs.writeFileSync(path.join(root, `${n}.txt`), n + "\n");
    shas.push((await commitAll(root, `step ${n}\n\nbody of ${n}`, opts)).sha);
  }
  const all = await log(root, opts);
  assert.deepEqual(all.map((e) => e.subject), ["step three", "step two", "step one"]);
  assert.deepEqual(all.map((e) => e.sha), shas.slice().reverse());
  assert.equal((await log(root, { ...opts, count: 2 })).length, 2);
});

test("showFile reads a file at a revision and gives null for a missing one", async () => {
  const root = await makeRepo();
  fs.mkdirSync(path.join(root, "docs"));
  fs.writeFileSync(path.join(root, "docs", "DECISIONS.md"), "# DECISIONS\n\n## D-001 (2026-09-28, S1.1) First\n");
  await commitAll(root, "one", opts);
  assert.match(await showFile(root, "HEAD", "docs/DECISIONS.md", opts), /## D-001/);
  assert.match(await showFile(root, "HEAD", "docs\\DECISIONS.md", opts), /## D-001/, "Windows separators work");
  assert.equal(await showFile(root, "HEAD", "docs/NOPE.md", opts), null);
});

// A repository with a commit on a run branch, and a bare repository as its "origin".
async function repoWithRemote({ remote = true } = {}) {
  const root = await makeRepo();
  fs.writeFileSync(path.join(root, "a.txt"), "a\n");
  await commitAll(root, "base", opts);
  await checkoutBranch(root, "autoclaude/demo", opts);
  fs.writeFileSync(path.join(root, "b.txt"), "b\n");
  await commitAll(root, "autoclaude(S1.1): one", opts);
  await tag(root, "ac-phase-1", opts);
  let bare = null;
  if (remote) {
    bare = path.join(tmpDir(), "remote.git");
    await sh(`git init -q --bare "${bare}"`, root);
    await sh(`git remote add origin "${bare}"`, root);
  }
  return { root, bare };
}

test("pushRun pushes the branch with an upstream and the tag to a bare remote, then reports nothing unpushed", async () => {
  const { root, bare } = await repoWithRemote();
  assert.equal(await remoteFor(root, "autoclaude/demo", opts), "origin");
  assert.equal(await unpushedCount(root, "origin", opts), 2, "nothing is on the remote yet");
  const r = await pushRun(root, { tags: ["ac-phase-1"], ...opts });
  assert.equal(r.ok, true, r.error);
  assert.deepEqual([r.skipped, r.remote, r.branch, r.pushedTags, r.unpushedTags, r.unpushedCommits, r.tries], [false, "origin", "autoclaude/demo", ["ac-phase-1"], [], 0, 1]);
  const local = await head(root, opts);
  assert.equal(await sh("git rev-parse refs/heads/autoclaude/demo", bare), local);
  assert.equal(await sh("git rev-list -n 1 ac-phase-1", bare), local);
  assert.equal(await sh("git config --get branch.autoclaude/demo.remote", root), "origin", "-u set the upstream");
  // A second push with nothing new is still fine.
  fs.writeFileSync(path.join(root, "c.txt"), "c\n");
  await commitAll(root, "autoclaude(S1.2): two", opts);
  assert.equal(await unpushedCount(root, "origin", opts), 1);
  const again = await pushRun(root, { branch: "autoclaude/demo", ...opts });
  assert.deepEqual([again.ok, again.unpushedCommits], [true, 0]);
});

test("pushRun with no remote skips and says so; a rejected push retries once and reports what is left", async () => {
  const { root } = await repoWithRemote({ remote: false });
  const none = await pushRun(root, { tags: ["ac-phase-1"], ...opts });
  assert.deepEqual([none.ok, none.skipped, none.error, none.unpushedTags, none.tries], [false, true, "no git remote is configured", ["ac-phase-1"], 0]);

  // The injectable runner: every push fails, everything else is real git.
  const calls = [];
  const failing = async (r, args, o) => {
    if (args[0] === "push") { calls.push(args.join(" ")); return { ok: false, code: 1, stdout: "", stderr: "fatal: unable to access remote\n  (network down)" }; }
    return gitRun(r, args, o);
  };
  const { root: withRemote } = await repoWithRemote();
  const r = await pushRun(withRemote, { tags: ["ac-phase-1"], run: failing, ...opts });
  assert.equal(r.ok, false);
  assert.equal(r.skipped, false);
  assert.equal(r.tries, 2, "one retry");
  assert.deepEqual(calls, ["push -u origin autoclaude/demo", "push -u origin autoclaude/demo"], "no tag goes out before its branch");
  assert.equal(r.error, "fatal: unable to access remote (network down)");
  assert.deepEqual(r.unpushedTags, ["ac-phase-1"]);
  assert.equal(r.unpushedCommits, 2);

  // The first push fails, the retry works: ok, two tries.
  let n = 0;
  const flaky = async (rt, args, o) => (args[0] === "push" && args[1] === "-u" && n++ === 0 ? { ok: false, code: 1, stdout: "", stderr: "ssh: connect to host timed out" } : gitRun(rt, args, o));
  const ok = await pushRun(withRemote, { tags: ["ac-phase-1"], run: flaky, ...opts });
  assert.deepEqual([ok.ok, ok.tries, ok.pushedTags, ok.error], [true, 2, ["ac-phase-1"], null]);
});

test("pushRun never forces: a tag moved after it was pushed is reported, not overwritten", async () => {
  const { root, bare } = await repoWithRemote();
  assert.equal((await pushRun(root, { tags: ["ac-phase-1"], ...opts })).ok, true);
  const first = await sh("git rev-list -n 1 ac-phase-1", bare);
  fs.writeFileSync(path.join(root, "d.txt"), "d\n");
  await commitAll(root, "later", opts);
  await tag(root, "ac-phase-1", { ...opts, force: true });
  const r = await pushRun(root, { tags: ["ac-phase-1"], ...opts });
  assert.equal(r.ok, false);
  assert.match(r.error, /^tag ac-phase-1: /);
  assert.deepEqual(r.unpushedTags, ["ac-phase-1"]);
  assert.equal(r.unpushedCommits, 0, "the branch itself went out");
  assert.equal(await sh("git rev-list -n 1 ac-phase-1", bare), first, "the remote tag is untouched");
});

test("a git failure comes back as ok false with stderr instead of a throw", async () => {
  const plain = tmpDir();
  const c = await commitAll(plain, "x", outsideRepo(plain));
  assert.equal(c.ok, false);
  assert.equal(c.committed, false);
  assert.match(c.stderr, /not a git repository/i);
  assert.equal(await head(plain, outsideRepo(plain)), null);
  assert.deepEqual(await log(plain, outsideRepo(plain)), []);
});
