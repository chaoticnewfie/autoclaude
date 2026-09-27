// Small synchronous file helpers with atomic writes. Hooks are short-lived scripts,
// so everything here is synchronous on purpose. Node built-ins only.
//
// Windows note (VERIFY.md P0.10): renaming over a file that another process holds
// open with no sharing fails with EPERM (sometimes EBUSY or EACCES) until the lock
// drops. writeFileAtomic retries with growing sleeps for up to ~15 s.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const RETRY_CODES = new Set(["EPERM", "EBUSY", "EACCES"]);

export function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms));
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

export function readText(file, fallback = null) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e.code === "ENOENT") return fallback;
    throw e;
  }
}

export function readJson(file, fallback = null) {
  const text = readText(file, null);
  if (text === null) return fallback;
  return JSON.parse(text);
}

export function writeFileAtomic(file, data, options = {}) {
  const { maxWaitMs = 15000, baseDelayMs = 50, maxDelayMs = 1000, beforeRename = null } = options;
  ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data);
  const started = Date.now();
  let attempt = 0;
  try {
    if (beforeRename) beforeRename(tmp);
    for (;;) {
      attempt++;
      try {
        fs.renameSync(tmp, file);
        return { attempts: attempt };
      } catch (e) {
        if (!RETRY_CODES.has(e.code) || Date.now() - started > maxWaitMs) throw e;
        sleepSync(Math.min(baseDelayMs * attempt, maxDelayMs));
      }
    }
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

export function writeJsonAtomic(file, value, options) {
  return writeFileAtomic(file, JSON.stringify(value, null, 2) + "\n", options);
}

export function appendLine(file, line) {
  ensureDir(path.dirname(file));
  fs.appendFileSync(file, line.endsWith("\n") ? line : line + "\n");
}

export function touch(file) {
  ensureDir(path.dirname(file));
  const now = new Date();
  try {
    fs.utimesSync(file, now, now);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    fs.writeFileSync(file, "");
  }
}

export function mtimeMs(file) {
  try {
    return fs.statSync(file).mtimeMs;
  } catch (e) {
    if (e.code === "ENOENT") return null;
    throw e;
  }
}

export function ageMs(file, now = Date.now()) {
  const m = mtimeMs(file);
  return m === null ? null : now - m;
}

export function removeIfExists(file) {
  try {
    fs.unlinkSync(file);
    return true;
  } catch (e) {
    if (e.code === "ENOENT") return false;
    throw e;
  }
}
