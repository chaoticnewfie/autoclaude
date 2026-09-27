// Git for the gate (PLAN.md D12): a branch per plan, one commit per verified step, a tag at
// each phase end, never a push. Every function takes the project root first and runs git
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

// git add -A, then commit. committed is false (with ok true) when there was nothing to commit.
export async function commitAll(root, message, opts = {}) {
  const add = await git(root, ["add", "-A"], opts);
  if (!add.ok) return { ok: false, committed: false, sha: null, stderr: add.stderr };
  const st = await status(root, opts);
  if (!st.ok) return { ok: false, committed: false, sha: null, stderr: st.stderr };
  if (st.clean) return { ok: true, committed: false, sha: await head(root, opts), stderr: "" };
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

// Newest first: [{ sha, subject }]. Empty when there is no commit yet.
export async function log(root, { count = 10, env, timeoutMs } = {}) {
  const r = await git(root, ["log", "--format=%H%x09%s", "-n", String(count)], { env, timeoutMs });
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf("\t");
    return i < 0 ? { sha: line, subject: "" } : { sha: line.slice(0, i), subject: line.slice(i + 1) };
  });
}
