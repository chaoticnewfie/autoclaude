import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "../../plugins/autoclaude/lib/proc.js";
import { isRepo, status, currentBranch, head, branchExists, tagExists, checkoutBranch, commitAll, tag, log } from "../../plugins/autoclaude/lib/git.js";

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

test("a git failure comes back as ok false with stderr instead of a throw", async () => {
  const plain = tmpDir();
  const c = await commitAll(plain, "x", outsideRepo(plain));
  assert.equal(c.ok, false);
  assert.equal(c.committed, false);
  assert.match(c.stderr, /not a git repository/i);
  assert.equal(await head(plain, outsideRepo(plain)), null);
  assert.deepEqual(await log(plain, outsideRepo(plain)), []);
});
