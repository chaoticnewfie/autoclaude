// Git for the gate (PLAN.md D12): a branch per plan, one commit per step, a tag at each phase
// end, and (git.push, D49) a push of the branch and the tag after each verified feature, never
// forced. Every function takes the project root first and runs git
// through runCommand with that cwd; a non-zero exit comes back as ok false with git's stderr,
// never as a throw. GIT_TERMINAL_PROMPT=0 keeps an unattended run from hanging on a prompt.
// Each function accepts a trailing options object with `env` (default process.env; must put
// git on PATH) and `timeoutMs`.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runCommand } from "./proc.js";
import { isWindows } from "./paths.js";

// Used only when the repo has no user.name configured, so a committed identity always wins.
const FALLBACK_IDENTITY = ["-c", "user.name=AutoClaude", "-c", "user.email=autoclaude@localhost"];
const SAFE_ARG = /^[A-Za-z0-9_.\/=:%@+,-]+$/;

// Quote one argument for the shell runCommand uses (cmd.exe on Windows, /bin/sh elsewhere).
function q(arg) {
  const s = String(arg);
  if (SAFE_ARG.test(s)) return s;
  return isWindows ? `"${s.replace(/"/g, '\\"')}"` : `"${s.replace(/([\\"$`])/g, "\\$1")}"`;
}

// Runs one git command. Resolves to { ok, code, stdout, stderr }; never rejects.
export async function git(root, args, { env = process.env, timeoutMs = 120000 } = {}) {
  const command = ["git", ...args.map(q)].join(" ");
  try {
    const r = await runCommand(command, { cwd: root, env: { ...env, GIT_TERMINAL_PROMPT: "0" }, timeoutMs });
    const stderr = r.timedOut ? `git timed out after ${timeoutMs} ms\n${r.stderr}` : r.stderr;
    return { ok: r.code === 0 && !r.timedOut, code: r.code, stdout: r.stdout, stderr };
  } catch (e) {
    return { ok: false, code: null, stdout: "", stderr: e.message };
  }
}

export async function isRepo(root, opts) {
  const r = await git(root, ["rev-parse", "--is-inside-work-tree"], opts);
  return r.ok && r.stdout.trim() === "true";
}

// { ok, clean, entries: [{ code, path }] }. Ignored files never appear; a rename shows as
// "old -> new" in path, the way porcelain v1 prints it.
export async function status(root, opts) {
  const r = await git(root, ["status", "--porcelain", "--untracked-files=all"], opts);
  if (!r.ok) return { ok: false, clean: false, entries: [], stderr: r.stderr };
  const entries = r.stdout.split(/\r?\n/).filter((l) => l.length > 3).map((l) => ({ code: l.slice(0, 2), path: l.slice(3) }));
  return { ok: true, clean: entries.length === 0, entries, stderr: "" };
}

// The branch name, or null before the first commit.
export async function currentBranch(root, opts) {
  const r = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], opts);
  return r.ok ? r.stdout.trim() || null : null;
}

export async function head(root, opts) {
  const r = await git(root, ["rev-parse", "--verify", "-q", "HEAD"], opts);
  return r.ok ? r.stdout.trim() || null : null;
}

async function refExists(root, ref, opts) {
  const r = await git(root, ["show-ref", "--verify", "--quiet", ref], opts);
  return r.ok;
}

export function branchExists(root, name, opts) {
  return refExists(root, `refs/heads/${name}`, opts);
}

export function tagExists(root, name, opts) {
  return refExists(root, `refs/tags/${name}`, opts);
}

// Checks the branch out, creating it from HEAD when it does not exist and create is true.
export async function checkoutBranch(root, name, { create = true, env, timeoutMs } = {}) {
  const opts = { env, timeoutMs };
  if (await branchExists(root, name, opts)) {
    const r = await git(root, ["checkout", name], opts);
    return { ok: r.ok, created: false, stderr: r.stderr };
  }
  if (!create) return { ok: false, created: false, stderr: `branch ${name} does not exist` };
  const r = await git(root, ["checkout", "-b", name], opts);
  return { ok: r.ok, created: r.ok, stderr: r.stderr };
}

async function hasIdentity(root, opts) {
  const r = await git(root, ["config", "user.name"], opts);
  return r.ok && r.stdout.trim() !== "";
}

// Messages go through a temp file and -F so quotes and newlines never touch the shell.
function messageFile(kind, text) {
  const file = path.join(os.tmpdir(), `autoclaude-${kind}-${process.pid}-${crypto.randomBytes(4).toString("hex")}.txt`);
  fs.writeFileSync(file, String(text), "utf8");
  return file;
}

// The folder a run generates secrets into (D49): secrets/ at the top of the project, in any case
// (Secrets/ on Windows is the same folder), with everything below it. commitAll never stages it,
// so a project that forgot to ignore it still never commits or pushes a secret. A secrets folder
// deeper in the tree (src/secrets/) may be real source code and is committed as usual.
export const SECRETS_PATHSPEC = ":(top,exclude,icase)secrets";
const SECRETS_DIR = ":(top,icase)secrets";

// git add -A (all but secrets/), unstage secrets/ whatever put it in the index (the builder's own
// `git add -A`, say), then commit. committed is false (with ok true) when there was nothing to
// commit.
export async function commitAll(root, message, opts = {}) {
  const add = await git(root, ["add", "-A", "--", ".", SECRETS_PATHSPEC], opts);
  if (!add.ok) return { ok: false, committed: false, sha: null, stderr: add.stderr };
  // Back to HEAD's version: a new secret leaves the index, a change to one committed earlier is
  // not committed. Works before the first commit too, and matching nothing is not an error.
  const unstage = await git(root, ["reset", "-q", "--", SECRETS_DIR], opts);
  if (!unstage.ok) return { ok: false, committed: false, sha: null, stderr: unstage.stderr };
  // Staged changes, not the status: an unignored secrets/ stays untracked and must not count.
  const staged = await git(root, ["diff", "--cached", "--quiet"], opts);
  if (staged.code !== 0 && staged.code !== 1) return { ok: false, committed: false, sha: null, stderr: staged.stderr };
  if (staged.code === 0) return { ok: true, committed: false, sha: await head(root, opts), stderr: "" };
  const ident = (await hasIdentity(root, opts)) ? [] : FALLBACK_IDENTITY;
  const file = messageFile("commit", message);
  try {
    const r = await git(root, [...ident, "commit", "-F", file], opts);
    if (!r.ok) return { ok: false, committed: false, sha: null, stderr: r.stderr };
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
  return { ok: true, committed: true, sha: await head(root, opts), stderr: "" };
}

// Lightweight tag, or annotated when a message is given. force re-points an existing tag.
export async function tag(root, name, { message = null, force = false, env, timeoutMs } = {}) {
  const opts = { env, timeoutMs };
  const flags = force ? ["-f"] : [];
  if (message === null) {
    const r = await git(root, ["tag", ...flags, name], opts);
    return { ok: r.ok, stderr: r.stderr };
  }
  const ident = (await hasIdentity(root, opts)) ? [] : FALLBACK_IDENTITY;
  const file = messageFile("tag", message);
  try {
    const r = await git(root, [...ident, "tag", ...flags, "-a", name, "-F", file], opts);
    return { ok: r.ok, stderr: r.stderr };
  } finally {
    try { fs.unlinkSync(file); } catch {}
  }
}

// A file as it is at a revision (say HEAD), or null when the revision or the path is missing.
export async function showFile(root, rev, relPath, { env, timeoutMs, run = git } = {}) {
  const r = await run(root, ["show", `${rev}:${String(relPath).replace(/\\/g, "/")}`], { env, timeoutMs });
  return r.ok ? r.stdout : null;
}

// The remote a branch pushes to: its configured upstream remote, else "origin", else the first
// remote; null when the repository has none.
export async function remoteFor(root, branch, { env, timeoutMs, run = git } = {}) {
  const opts = { env, timeoutMs };
  const up = branch ? await run(root, ["config", "--get", `branch.${branch}.remote`], opts) : null;
  if (up && up.ok && up.stdout.trim()) return up.stdout.trim();
  const r = await run(root, ["remote"], opts);
  if (!r.ok) return null;
  const names = r.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  return names.includes("origin") ? "origin" : names[0] || null;
}

// Commits on HEAD that no ref of the remote holds: 0 once everything is pushed. null when git
// cannot tell.
export async function unpushedCount(root, remote, { env, timeoutMs, run = git } = {}) {
  const r = await run(root, ["rev-list", "--count", "HEAD", "--not", `--remotes=${remote}`], { env, timeoutMs });
  const n = r.ok ? Number(r.stdout.trim()) : NaN;
  return Number.isFinite(n) ? n : null;
}

function pushError(r) {
  const text = String((r && r.stderr) || "").replace(/\s+/g, " ").trim();
  return (text || "git push failed").slice(0, 400);
}

// Pushes the run branch (with -u, so it gets an upstream) and the given tags, retrying once
// whatever failed. Never forces: a rejected push stays rejected and is reported. `run` replaces
// git() in tests. Resolves, never rejects, to { ok, skipped, remote, branch, error, pushedTags,
// unpushedTags, unpushedCommits, tries }; skipped is true when there is no remote to push to.
export async function pushRun(root, { branch = null, tags = [], retries = 1, env, timeoutMs, run = git } = {}) {
  const opts = { env, timeoutMs };
  let b = branch;
  if (!b) {
    const r = await run(root, ["rev-parse", "--abbrev-ref", "HEAD"], opts);
    b = r.ok ? r.stdout.trim() : null;
  }
  const wanted = [...new Set((tags || []).filter(Boolean))];
  if (!b || b === "HEAD") return { ok: false, skipped: true, remote: null, branch: null, error: "not on a branch", pushedTags: [], unpushedTags: wanted, unpushedCommits: null, tries: 0 };
  const remote = await remoteFor(root, b, { ...opts, run });
  if (!remote) return { ok: false, skipped: true, remote: null, branch: b, error: "no git remote is configured", pushedTags: [], unpushedTags: wanted, unpushedCommits: null, tries: 0 };
  let branchPushed = false;
  let left = wanted;
  const pushed = [];
  let error = null;
  let tries = 0;
  while (tries <= retries && (!branchPushed || left.length)) {
    tries++;
    error = null;
    if (!branchPushed) {
      const r = await run(root, ["push", "-u", remote, b], opts);
      if (r.ok) branchPushed = true;
      else error = pushError(r);
    }
    // Tags only after the branch, so a tag never reaches the remote without its commits.
    if (branchPushed) {
      for (const t of left.slice()) {
        const r = await run(root, ["push", remote, `refs/tags/${t}`], opts);
        if (r.ok) { pushed.push(t); left = left.filter((x) => x !== t); } else if (!error) error = `tag ${t}: ${pushError(r)}`;
      }
    }
  }
  const ok = branchPushed && left.length === 0;
  const unpushedCommits = await unpushedCount(root, remote, { ...opts, run });
  return { ok, skipped: false, remote, branch: b, error: ok ? null : error, pushedTags: pushed, unpushedTags: left, unpushedCommits, tries };
}

// Newest first: [{ sha, subject }]. Empty when there is no commit yet.
export async function log(root, { count = 10, env, timeoutMs } = {}) {
  const r = await git(root, ["log", "--format=%H%x09%s", "-n", String(count)], { env, timeoutMs });
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf("\t");
    return i < 0 ? { sha: line, subject: "" } : { sha: line.slice(0, i), subject: line.slice(i + 1) };
  });
}
