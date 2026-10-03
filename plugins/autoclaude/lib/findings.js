// Sweep findings (PLAN.md P10.2, D58): one schema for the security and the optimize sweep, the
// fingerprint that follows a finding from one sweep to the next, masking of secret-looking values,
// the owner's committed list of accepted risks and false alarms, and the report (report.md plus
// findings.json) in the sweep's gitignored folder. Nothing here runs a model or a tool; the
// sweep (lib/sweep.js) feeds it. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readText, writeFileAtomic, ensureDir } from "./fsatomic.js";
import { ACCEPTED_FILE } from "./config.js";

export { ACCEPTED_FILE };
export const SEVERITIES = Object.freeze(["critical", "high", "medium", "low"]);
export const SEVERITY_RANK = Object.freeze({ critical: 4, high: 3, medium: 2, low: 1 });
export const KINDS = Object.freeze(["security", "optimize"]);
// Optimize fix tiers: A mechanical and proven, B behaviour-preserving behind pinned tests, C for
// the owner (report only). Every security finding is tier A.
export const TIERS = Object.freeze(["A", "B", "C"]);
export const ID_PREFIX = Object.freeze({ security: "SEC", optimize: "OPT" });
export const FINDINGS_SCHEMA_VERSION = 1;
// Two findings of one category in one file this many lines apart or closer are one finding.
export const NEAR_LINES = 3;

const MAX_EVIDENCE = 2000;
const MAX_TEXT = 4000;
const MAX_TITLE = 200;
const MAX_REASON = 300;

// ---------- schemas (for `claude -p --json-schema`) ----------

// No type unions, no numeric bounds: the schemas stay inside what structured output accepts.
// Empty strings stand for "none" and normalizeFinding turns them into null.
const CANDIDATE_PROPS = {
  kind: { type: "string", enum: [...KINDS] },
  category: { type: "string", description: "short lowercase slug, for example injection, access-control, secrets, headers, dependencies, unused-code, duplicates, performance, rebuild, tests" },
  title: { type: "string", description: "one neutral line naming the problem and where it is" },
  area: { type: "string", description: "the part of the project it is in (a folder or a feature); empty when unsure" },
  severity: { type: "string", enum: [...SEVERITIES] },
  cwe: { type: "string", description: "CWE id such as CWE-89 for a security finding; empty when none" },
  cvss: { type: "string", description: "CVSS vector or score for a package advisory; empty when none" },
  fixedVersion: { type: "string", description: "the first fixed version for a package advisory; empty when none" },
  confidence: { type: "integer", description: "0 to 10: how sure you are this is real" },
  file: { type: "string", description: "project-relative path with forward slashes" },
  line: { type: "integer", description: "1-based line, 0 when it is the whole file" },
  evidence: { type: "string", description: "the few lines that show it; never a secret value: write its first 4 characters and its length instead" },
  impact: { type: "string" },
  reproduce: { type: "string", description: "how to show it happens, step by step" },
  fix: { type: "string", description: "the suggested fix, with code" },
  testIdea: { type: "string", description: "a test that fails now and passes once it is fixed" },
  tier: { type: "string", enum: [...TIERS], description: "optimize: A mechanical, B behaviour-preserving behind pinned tests, C owner decision only; security: A" },
  autoFixSafe: { type: "boolean", description: "false when the fix needs the owner (a decision, an account, a key to rotate, a change outside this repository)" },
  ownerAction: { type: "string", description: "what only the owner can do, even after the fix (rotate a key at its provider, say); empty when nothing" }
};
const CANDIDATE_REQUIRED = ["kind", "category", "title", "severity", "cwe", "cvss", "fixedVersion", "confidence", "file", "line", "evidence", "impact", "reproduce", "fix", "testIdea", "tier", "autoFixSafe"];

// One finding as the sweep stores it: a candidate plus its id (SEC-001) and fingerprint.
export const FINDING_SCHEMA = Object.freeze({
  type: "object",
  properties: { id: { type: "string" }, ...CANDIDATE_PROPS, fingerprint: { type: "string" } },
  required: ["id", ...CANDIDATE_REQUIRED, "fingerprint"]
});

// What a reviewer session returns: candidates (no id or fingerprint yet), what it did and did
// not look at, and free notes.
export const CANDIDATES_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    findings: { type: "array", items: { type: "object", properties: CANDIDATE_PROPS, required: CANDIDATE_REQUIRED } },
    coverage: {
      type: "object",
      properties: { examined: { type: "array", items: { type: "string" } }, notExamined: { type: "array", items: { type: "string" } } },
      required: ["examined", "notExamined"]
    },
    notes: { type: "string" }
  },
  required: ["findings", "coverage", "notes"]
});

// What a verifier session returns for one candidate it tried to disprove.
export const VERDICT_SCHEMA = Object.freeze({
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["confirmed", "refuted", "uncertain"] },
    reason: { type: "string" },
    severity: { type: "string", enum: [...SEVERITIES] }
  },
  required: ["verdict", "reason", "severity"]
});

// ---------- masking ----------

const MASKED = "[redacted";

// "ghp_[redacted, 40 chars]": the first 4 characters and the length. Shorter values show less
// (2 characters from 8, none below), so a short password is never mostly visible.
export function maskValue(value) {
  const s = String(value);
  const keep = s.length >= 12 ? 4 : s.length >= 8 ? 2 : 0;
  return `${s.slice(0, keep)}${MASKED}, ${s.length} chars]`;
}

// Values that only point at a secret: a variable, a template, a placeholder, code that reads one.
const REFERENCE_RES = [
  /^\$\{[^}]*\}$/, /^\$[A-Za-z_]\w*$/, /^%[A-Za-z_]\w*%$/, /^\{\{[^}]*\}\}$/, /^<[^>]*>$/, /^\*+$/, /^x{3,}$/i, /^\.{3}$/,
  /^(process\.env|os\.environ|os\.getenv|env\.|ENV\[|getenv|import\.meta\.env)/i,
  // Code: a call or a member access (req.body.password, getToken()).
  /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)+$/, /^[A-Za-z_$][\w$.]*\s*\(/,
  /^(your|my)[-_ ]/i,
  /^(null|none|nil|undefined|true|false|changeme|change-me|placeholder|example|dummy|redacted|bearer|basic|digest)$/i
];
function isReference(v) {
  const s = String(v).trim();
  return s === "" || s.includes(MASKED) || REFERENCE_RES.some((re) => re.test(s));
}

// An unquoted value masked, punctuation that ends the statement (a comma, a semicolon, a closing
// bracket) kept after it; the value itself when it is only a reference.
function maskBare(v) {
  if (isReference(v)) return v;
  const tail = (v.match(/[,;)\]}]+$/) || [""])[0];
  const core = v.slice(0, v.length - tail.length);
  return isReference(core) ? v : `${maskValue(core)}${tail}`;
}

// Names whose value is a secret: password, passwd, pwd, passphrase, secret, token, api key,
// access key, private key, client secret, credentials, auth token, authorization, session key,
// signing key, salt, dsn, connection string, database url, anything ending in _key or -key.
const KEY = "[A-Za-z0-9_.-]*(?:passw(?:or)?d|pwd|passphrase|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?|auth[_-]?token|authorization|session[_-]?key|signing[_-]?key|salt|dsn|connection[_-]?string|database[_-]?url|db[_-]?url|[_-]key)[A-Za-z0-9_.-]*";

// Token formats of well-known services, masked whole.
const TOKEN_RES = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g,
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g,
  /\bAIza[0-9A-Za-z_-]{35}\b/g,
  /\bnpm_[A-Za-z0-9]{36}\b/g,
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
  /\btk_[a-z0-9]{29}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g
];

function entropy(s) {
  const counts = new Map();
  for (const ch of s) counts.set(ch, (counts.get(ch) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

// A long random-looking run (upper and lower case letters and at least three digits, high
// entropy): a key with no recognisable name. Hex hashes and identifiers do not qualify.
function looksRandom(s) {
  return s.length >= 32 && /[A-Z]/.test(s) && /[a-z]/.test(s) && (s.match(/\d/g) || []).length >= 3 && entropy(s) >= 4.3;
}

// Masks values that look like keys, tokens, passwords and connection-string passwords to their
// first 4 characters plus the length. Idempotent: masked text comes back unchanged. Code that
// only reads a secret (process.env.X, req.body.password) and placeholders are left alone.
export function redact(text) {
  if (text === null || text === undefined) return text;
  let s = String(text);
  // Private key blocks, also when cut off before their END line.
  s = s.replace(/(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----|$)/g, (m, begin, body, end) => {
    const b = body.trim();
    return !b || b.includes(MASKED) ? m : `${begin}\n${maskValue(b)}${end ? `\n${end}` : ""}`;
  });
  // A password in a connection string or URL: scheme://user:password@host.
  s = s.replace(/\b([a-z][a-z0-9+.-]{1,20}):\/\/([^\s:/@'"`]+):([^\s@/'"`]+)@/gi, (m, scheme, user, pass) => (isReference(pass) ? m : `${scheme}://${user}:${maskValue(pass)}@`));
  // Discord webhooks: the token after the id.
  s = s.replace(/(\bhttps?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/)([A-Za-z0-9_-]{20,})/gi, (m, head, tok) => `${head}${maskValue(tok)}`);
  for (const re of TOKEN_RES) s = s.replace(re, (m) => maskValue(m));
  // Authorization header values.
  s = s.replace(/\b(Bearer|Basic)(\s+)([A-Za-z0-9._~+/=-]{8,})/g, (m, scheme, sp, v) => `${scheme}${sp}${maskValue(v)}`);
  // key = "value", "key": "value", key: 'value', key => `value` (quoted values, any length). The
  // lookbehind starts a key only where a name starts, which keeps long runs of letters linear.
  const quoted = new RegExp(`(?<![A-Za-z0-9_.-])(["']?)(${KEY})\\1(\\s*(?::=|=>|[:=])\\s*)(["'\`])((?:\\\\.|(?!\\4)[^\\\\\\r\\n]){1,500})\\4`, "gi");
  s = s.replace(quoted, (m, kq, key, sep, q, v) => (isReference(v) ? m : `${kq}${key}${kq}${sep}${q}${maskValue(v)}${q}`));
  // .env and shell lines: KEY=value, export KEY=value.
  const envLine = new RegExp(`^([ \\t]*(?:export[ \\t]+)?)(${KEY})([ \\t]*=[ \\t]*)([^\\s'"\`#][^\\s'"\`]*)`, "gim");
  s = s.replace(envLine, (m, lead, key, sep, v) => `${lead}${key}${sep}${maskBare(v)}`);
  // YAML: key: value at the start of a line (compose files, CI settings).
  const yamlLine = new RegExp(`^([ \\t]*(?:-[ \\t]+)?)(${KEY})(:[ \\t]+)([^\\s'"\`#{[|>&*!][^\\s'"\`]*)`, "gim");
  s = s.replace(yamlLine, (m, lead, key, sep, v) => `${lead}${key}${sep}${maskBare(v)}`);
  // URL query parameters and command-line options: ?token=..., --password=..., --api-key ...
  const query = new RegExp(`([?&;])(${KEY})=([^&\\s'"\`#]+)`, "gi");
  s = s.replace(query, (m, lead, key, v) => `${lead}${key}=${maskBare(v)}`);
  const option = new RegExp(`(--${KEY})([= ])([^\\s'"\`-][^\\s'"\`]*)`, "gi");
  s = s.replace(option, (m, opt, sep, v) => `${opt}${sep}${maskBare(v)}`);
  // Anything else long and random.
  s = s.replace(/(?<![A-Za-z0-9+_=-])[A-Za-z0-9+_=-]{32,}(?![A-Za-z0-9+_=-])/g, (m) => (looksRandom(m) ? maskValue(m) : m));
  return s;
}

// Every string inside a value, masked (fingerprints, ids, commits and a scanner's anchor are left
// as they are; none of them carries a secret value).
const KEEP_KEYS = new Set(["fingerprint", "fingerprints", "anchor", "id", "commit", "sha"]);
export function redactDeep(value, key = null) {
  if (typeof value === "string") return key && KEEP_KEYS.has(key) ? value : redact(value);
  if (Array.isArray(value)) return value.map((v) => (key && KEEP_KEYS.has(key) && typeof v === "string" ? v : redactDeep(v)));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactDeep(v, k);
    return out;
  }
  return value;
}

// ---------- normalizing, fingerprints, dedupe ----------

const sha = (s) => crypto.createHash("sha256").update(String(s), "utf8").digest("hex");

// A file as a project-relative path with forward slashes (an absolute path inside root is made
// relative; one outside stays as it is).
export function normFile(file, root = null) {
  let s = String(file || "").trim();
  if (root && s && path.isAbsolute(s)) {
    const r = path.relative(root, s);
    if (r && !r.startsWith("..") && !path.isAbsolute(r)) s = r;
  }
  return s.replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

// Evidence as compared between sweeps: masked, line-number prefixes ("12: ", "12 | ") dropped,
// blank lines dropped, whitespace collapsed, lower case.
export function normalizeEvidence(text) {
  return redact(String(text || ""))
    .replace(/\r/g, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\d+\s*[:|]\s?/, "").trim())
    .filter(Boolean)
    .join("\n")
    .replace(/[ \t]+/g, " ")
    .toLowerCase();
}

// ---------- the anchor a fingerprint is made from ----------
//
// A finding a session reports is free text: the next sweep's session quotes another span, words
// the title differently, and the line moves when code above it changes. None of that may change
// the fingerprint, or a finding the owner accepted comes back (P10.2). So the fingerprint is made
// from facts that stay put: the category, the file, and an anchor:
//   - a scanner's own `anchor` (a package, a header, a secret rule and its masked value), which
//     its code writes the same way every time; a session's is ignored;
//   - else the code the finding points at, read from the working tree: the line (a blank or
//     brace-only line moves to the nearest line with code), normalized and masked, with the name
//     of the function, method, class or route around it. The line number itself never counts;
//   - else (no root, no readable file, a line that is not in it) the normalized evidence, then the
//     title: deterministic checks write fixed text there.

const MAX_ANCHOR_FILE = 2 * 1024 * 1024;
const URL_FILE = /^[a-z][a-z0-9+.-]*:\/\//i;

// The lines of a project file, or null: outside the root, a URL, unreadable, too big or binary.
// cache (a Map) keeps one read per file for a whole merge.
function sourceLines(root, file, cache) {
  const rel = normFile(file, root);
  if (!root || !rel || URL_FILE.test(rel)) return null;
  const base = path.resolve(root);
  const abs = path.resolve(base, rel);
  const r = path.relative(base, abs);
  if (!r || r === ".." || r.startsWith(`..${path.sep}`) || path.isAbsolute(r)) return null;
  if (cache && cache.has(abs)) return cache.get(abs);
  let lines = null;
  try {
    const st = fs.statSync(abs);
    if (st.isFile() && st.size <= MAX_ANCHOR_FILE) {
      const buf = fs.readFileSync(abs);
      if (!buf.includes(0)) lines = buf.toString("utf8").replace(/\r/g, "").split("\n");
    }
  } catch {}
  if (cache) cache.set(abs, lines);
  return lines;
}

const squash = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
// Nothing to anchor on: blank, only brackets and punctuation, or only a comment.
const TRIVIAL_LINE = /^\s*(?:[{}()[\];,]*|(?:\/\/|#|\/\*|\*|<!--|--).*)\s*$/;

// The line itself, else the nearest line with code: just above it (a blank line or a closing
// bracket ends what came before), or just below it when the line only opens a bracket.
function significantLine(lines, idx) {
  if (!TRIVIAL_LINE.test(lines[idx])) return idx;
  const below = /^\s*[{([]\s*$/.test(lines[idx]);
  const look = (dir) => { for (let d = 1; d <= 3; d++) { const j = idx + dir * d; if (j >= 0 && j < lines.length && !TRIVIAL_LINE.test(lines[j])) return j; } return -1; };
  const first = look(below ? 1 : -1);
  if (first >= 0) return first;
  const second = look(below ? -1 : 1);
  return second >= 0 ? second : idx;
}

// A finding without a line: the first line of its evidence (line-number prefixes dropped) that
// appears in the file as it is. -1 when none does.
function evidenceLine(lines, evidence) {
  const wanted = String(evidence || "").replace(/\r/g, "").split("\n").map((l) => squash(l.replace(/^\s*\d+\s*[:|]\s?/, ""))).filter((l) => l.length >= 8 && !TRIVIAL_LINE.test(l));
  if (!wanted.length) return -1;
  const have = new Map();
  lines.forEach((l, i) => { const k = squash(l); if (k && !have.has(k)) have.set(k, i); });
  for (const w of wanted) if (have.has(w)) return have.get(w);
  return -1;
}

const NOT_NAMES = new Set(["if", "for", "while", "switch", "catch", "with", "return", "function", "else", "do", "try", "new", "typeof", "await", "yield"]);
const DECLARATIONS = [
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/,
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]*)?=>|[A-Za-z_$][\w$]*\s*=>)/,
  /^\s*(?:async\s+)?def\s+(?:self\.)?([A-Za-z_]\w*[?!]?)/,
  /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/,
  /^\s*(?:(?:public|private|protected|static|async|override|readonly|get|set)\s+)*\*?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::\s*[^{=]+)?\{\s*$/
];
const ROUTE = /^\s*[A-Za-z_$][\w$]*\.(get|post|put|patch|delete|all|use|route)\(\s*(['"`])([^'"`]+)\2/i;

function declarationName(line) {
  const r = ROUTE.exec(line);
  if (r) return `${r[1].toLowerCase()} ${r[3]}`;
  for (const re of DECLARATIONS) {
    const m = re.exec(line);
    if (m && !NOT_NAMES.has(m[1])) return m[1];
  }
  return "";
}

const indentOf = (l) => (/^[ \t]*/.exec(l)[0].replace(/\t/g, "  ")).length;

// The function, method, class or route the line is in (or is): the nearest less indented line
// above it that declares one. "" at the top level.
function enclosingName(lines, idx) {
  const own = declarationName(lines[idx]);
  if (own) return own;
  let indent = indentOf(lines[idx]);
  for (let j = idx - 1; j >= 0 && j >= idx - 400 && indent > 0; j--) {
    const l = lines[j];
    if (!l.trim()) continue;
    const ind = indentOf(l);
    if (ind >= indent) continue;
    const name = declarationName(l);
    if (name) return name;
    indent = ind;
  }
  return "";
}

// The anchor of a finding, as described above: "scanner:...", "code:...", or "text:...".
// options: root (the project, to read the code), cache (a Map shared by one merge).
export function anchorOf(finding, { root = null, cache = null } = {}) {
  const f = finding || {};
  const fromSession = /^session\b/i.test(String(f.source || ""));
  if (typeof f.anchor === "string" && f.anchor.trim() && !fromSession) return `scanner:${f.anchor.trim().toLowerCase()}`;
  const lines = root ? sourceLines(root, f.file, cache) : null;
  if (lines) {
    const n = Number(f.line);
    let idx = Number.isFinite(n) && n >= 1 && n <= lines.length ? Math.floor(n) - 1 : evidenceLine(lines, f.evidence);
    if (idx >= 0) {
      idx = significantLine(lines, idx);
      const code = normalizeEvidence(lines[idx]);
      if (code) return `code:${enclosingName(lines, idx)}\n${code}`;
    }
  }
  return `text:${normalizeEvidence(f.evidence) || normalizeEvidence(f.title) || `line ${Number(f.line) || 0}`}`;
}

// Category, file and a hash of the anchor, as one opaque hash: it says nothing about the finding,
// so the committed accepted list can carry it. Without a root (or a readable file) it falls back
// to the evidence, as before.
export function fingerprint(finding, { root = null, cache = null } = {}) {
  const f = finding || {};
  const category = String(f.category || "").trim().toLowerCase();
  const file = normFile(f.file).toLowerCase();
  const anchor = anchorOf(f, { root, cache });
  // A text anchor hashes exactly as the fingerprint did before anchors existed.
  const key = anchor.startsWith("text:") ? anchor.slice(5) : anchor;
  return sha(`${category}\n${file}\n${sha(key)}`).slice(0, 20);
}

// Every fingerprint a finding answers to: its own first, then those of the reports merged into it.
export function fingerprintsOf(finding) {
  const f = finding || {};
  const list = [f.fingerprint || fingerprint(f), ...(Array.isArray(f.fingerprints) ? f.fingerprints : [])];
  return [...new Set(list.filter((x) => typeof x === "string" && x).map((x) => x.trim().toLowerCase()))];
}

export function severityOf(v) {
  const s = String(v || "").trim().toLowerCase();
  return SEVERITIES.includes(s) ? s : "medium";
}

// The fixing severity: critical is treated as high (D58), so the gate's levels apply.
export function gateSeverity(sev) {
  const s = severityOf(sev);
  return s === "critical" ? "high" : s;
}

function cweOf(v) {
  const s = String(v || "").trim();
  if (!s) return null;
  const m = s.match(/^(?:cwe[-\s:]*)?(\d+)$/i);
  return m ? `CWE-${m[1]}` : s;
}

// Masked, then cut to max. Only a window a little past max is masked, so a huge value costs
// little, and a secret that straddles the cut is masked whole before it is cut.
const text = (v, max) => {
  if (v === null || v === undefined) return "";
  const raw = String(v);
  const s = redact(raw.length > max + 400 ? raw.slice(0, max + 400) : raw).trim();
  return s.length > max || raw.length > max + 400 ? `${s.slice(0, max)} [... cut]` : s;
};
const orNull = (v) => {
  const s = v === null || v === undefined ? "" : String(v).trim();
  return s ? s : null;
};

// The folder a finding belongs to when its session gave none: the first folder, or the first two
// under a container folder (src/auth, packages/api); files at the top are "project root".
const CONTAINERS = new Set(["src", "lib", "app", "apps", "packages", "server", "client", "backend", "frontend", "web", "api", "services", "pkg", "cmd", "internal", "source"]);
export function areaOf(finding) {
  const f = finding || {};
  if (typeof f.area === "string" && f.area.trim()) return f.area.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  // A live check names a URL (http://127.0.0.1:3000/), not a file.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(f.file || "").trim())) return "the running app";
  const dirs = normFile(f.file).split("/").filter(Boolean).slice(0, -1);
  if (!dirs.length) return "project root";
  return CONTAINERS.has(dirs[0].toLowerCase()) && dirs.length >= 2 ? `${dirs[0]}/${dirs[1]}` : dirs[0];
}

// One finding in the stored shape, whatever a session or a scanner returned: known values,
// masked text, a project-relative file, a fresh fingerprint (anchored in the code when root is
// given, see anchorOf). kind fills a missing kind. Extra fields the sweep adds (source, votes,
// verdicts) are kept, their text masked. cache: a Map that one merge shares, so each file is read
// once.
export function normalizeFinding(raw, { kind = null, root = null, cache = null } = {}) {
  const f = raw && typeof raw === "object" ? raw : {};
  const k = KINDS.includes(f.kind) ? f.kind : KINDS.includes(kind) ? kind : "security";
  const tier = k === "security" ? "A" : TIERS.includes(String(f.tier || "").toUpperCase()) ? String(f.tier).toUpperCase() : "C";
  const conf = Number(f.confidence);
  const out = {
    ...redactDeep(f),
    kind: k,
    category: String(f.category || "other").trim().toLowerCase().replace(/\s+/g, "-") || "other",
    title: text(f.title, MAX_TITLE).replace(/\s+/g, " "),
    severity: severityOf(f.severity),
    cwe: cweOf(f.cwe),
    cvss: orNull(f.cvss),
    fixedVersion: orNull(f.fixedVersion),
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(10, Math.round(conf))) : 5,
    file: normFile(f.file, root),
    line: Number.isFinite(Number(f.line)) && Number(f.line) > 0 ? Math.floor(Number(f.line)) : 0,
    evidence: text(f.evidence, MAX_EVIDENCE),
    impact: text(f.impact, MAX_TEXT),
    reproduce: text(f.reproduce, MAX_TEXT),
    fix: text(f.fix, MAX_TEXT),
    testIdea: text(f.testIdea, MAX_TEXT),
    tier,
    autoFixSafe: f.autoFixSafe === true,
    ownerAction: orNull(text(f.ownerAction, MAX_TEXT))
  };
  if (typeof f.area === "string" && f.area.trim()) out.area = f.area.trim();
  else delete out.area;
  if (typeof f.id !== "string" || !f.id.trim()) delete out.id;
  out.fingerprint = fingerprint(out, { root, cache });
  return out;
}

// Most severe first, then the most confident, then by file and line.
export function compareFindings(a, b) {
  return (SEVERITY_RANK[severityOf(b.severity)] - SEVERITY_RANK[severityOf(a.severity)])
    || ((Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    || normFile(a.file).localeCompare(normFile(b.file))
    || ((Number(a.line) || 0) - (Number(b.line) || 0));
}

export function sortFindings(findings) {
  return [...(findings || [])].sort(compareFindings);
}

// Findings reported more than once (two sessions, or a scanner and a session) become one: the
// same fingerprint, or the same kind, category and file with lines at most NEAR_LINES apart. The
// strongest report is kept (severity, then confidence), with the highest confidence of the group
// and every source that found it in `sources`. Every member's fingerprint is kept in
// `fingerprints` (the kept one first), so an accepted entry made from any of them still matches
// (applyAccepted). With { kind } (and root) every finding is first normalized (normalizeFinding):
// raw candidates from sessions and scanners go in as they came.
export function dedupe(findings, { kind = null, root = null } = {}) {
  const out = [];
  const cache = new Map();
  for (const raw of findings || []) {
    if (!raw || typeof raw !== "object") continue;
    const f = KINDS.includes(kind) ? normalizeFinding(raw, { kind, root, cache }) : { ...raw, fingerprint: raw.fingerprint || fingerprint(raw, { root, cache }) };
    const srcs = [...(Array.isArray(f.sources) ? f.sources : []), ...(f.source ? [f.source] : [])];
    const fps = fingerprintsOf(f);
    const i = out.findIndex((g) => (g.kind || null) === (f.kind || null) && (g.fingerprints.some((x) => fps.includes(x)) || (
      g.category === f.category && normFile(g.file) === normFile(f.file) && normFile(f.file) !== ""
      && Number(g.line) > 0 && Number(f.line) > 0 && Math.abs(Number(g.line) - Number(f.line)) <= NEAR_LINES)));
    if (i < 0) { out.push({ ...f, sources: [...new Set(srcs)], fingerprints: fps }); continue; }
    const g = out[i];
    const sources = [...new Set([...(g.sources || []), ...srcs])];
    const confidence = Math.max(Number(g.confidence) || 0, Number(f.confidence) || 0);
    const kept = compareFindings(f, g) < 0 ? f : g;
    const fingerprints = [...new Set([String(kept.fingerprint).toLowerCase(), ...g.fingerprints, ...fps])];
    out[i] = { ...kept, confidence, sources, fingerprints };
  }
  return out;
}

// SEC-001, SEC-002 ... (OPT- for optimize) in report order: most severe first.
export function numberFindings(findings, kind, { start = 1 } = {}) {
  const prefix = ID_PREFIX[kind] || "FND";
  return sortFindings(findings).map((f, i) => ({ ...f, id: `${prefix}-${String(start + i).padStart(3, "0")}` }));
}

export function countBySeverity(findings) {
  const out = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const f of findings || []) { out[severityOf(f.severity)]++; out.total++; }
  return out;
}

// ---------- accepted risks and false alarms (committed) ----------

export function acceptedFile(root) {
  return path.join(root, ACCEPTED_FILE);
}

const FINGERPRINT_RE = /^[0-9a-f]{8,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// One entry as it is kept: fingerprint, kind, a short masked reason, who and when. Nothing else,
// so no finding detail reaches the committed file. null for an unusable entry.
function cleanAccepted(e, today) {
  if (!e || typeof e !== "object" || typeof e.fingerprint !== "string") return null;
  const fp = e.fingerprint.trim().toLowerCase();
  if (!FINGERPRINT_RE.test(fp)) return null;
  const reason = redact(String(e.reason || "").replace(/\s+/g, " ").trim()).slice(0, MAX_REASON);
  return {
    fingerprint: fp,
    kind: KINDS.includes(e.kind) ? e.kind : null,
    reason,
    by: String(e.by || "owner").replace(/\s+/g, " ").trim().slice(0, 80) || "owner",
    date: typeof e.date === "string" && DATE_RE.test(e.date) ? e.date : today
  };
}

const todayOf = (now = new Date()) => new Date(now).toISOString().slice(0, 10);

// { exists, list, error }. Never throws: a broken file gives an empty list and the reason, so a
// sweep reports those findings again instead of failing.
export function readAccepted(root) {
  const file = acceptedFile(root);
  let raw;
  try { raw = readText(file, null); } catch (e) { return { exists: true, list: [], error: `${ACCEPTED_FILE} could not be read: ${e.message}` }; }
  if (raw === null) return { exists: false, list: [], error: null };
  let data;
  try { data = JSON.parse(raw); } catch (e) { return { exists: true, list: [], error: `${ACCEPTED_FILE} is not valid JSON: ${e.message}` }; }
  if (!Array.isArray(data)) return { exists: true, list: [], error: `${ACCEPTED_FILE} must hold a JSON array` };
  const today = todayOf();
  return { exists: true, list: data.map((e) => cleanAccepted(e, today)).filter(Boolean), error: null };
}

export function loadAccepted(root) {
  return readAccepted(root).list;
}

// Writes the list (one entry per kind and fingerprint, the later one winning, in first-seen
// order) to autoclaude.accepted.json at the project root. Returns the file.
export function saveAccepted(root, list, { now = new Date() } = {}) {
  const today = todayOf(now);
  const byKey = new Map();
  for (const e of Array.isArray(list) ? list : []) {
    const c = cleanAccepted(e, today);
    if (!c) continue;
    const key = `${c.kind || "*"}:${c.fingerprint}`;
    if (byKey.has(key)) byKey.delete(key);
    byKey.set(key, c);
  }
  const file = acceptedFile(root);
  writeFileAtomic(file, JSON.stringify([...byKey.values()], null, 2) + "\n");
  return file;
}

// Splits findings into those still reported and those the owner accepted (by any of a finding's
// fingerprints, its own or one merged into it, and by kind when the entry names one). Accepted
// findings carry `accepted: { reason, by, date }`.
export function applyAccepted(findings, accepted) {
  const map = new Map();
  for (const e of accepted || []) {
    if (!e || typeof e.fingerprint !== "string") continue;
    map.set(`${KINDS.includes(e.kind) ? e.kind : "*"}:${e.fingerprint.trim().toLowerCase()}`, e);
  }
  const kept = [];
  const acc = [];
  for (const f of findings || []) {
    const fps = fingerprintsOf(f);
    let e = null;
    for (const fp of fps) { e = map.get(`${f.kind}:${fp}`) || map.get(`*:${fp}`); if (e) break; }
    if (e) acc.push({ ...f, fingerprint: fps[0], accepted: { reason: e.reason || "", by: e.by || "owner", date: e.date || null } });
    else kept.push(f);
  }
  return { kept, accepted: acc };
}

// ---------- the report ----------

const KIND_TITLE = { security: "Security sweep report", optimize: "Optimization sweep report" };
const DEPTH_TEXT = {
  thorough: "thorough (every finding checked by 3 independent sessions, kept on a majority)",
  standard: "standard (every finding checked by 1 session)",
  quick: "quick (findings not checked again)"
};

const cell = (v) => String(v === null || v === undefined || v === "" ? "-" : v).replace(/\r?\n/g, " ").replace(/\|/g, "\\|");
const where = (f) => `${f.file || "(no file)"}${Number(f.line) > 0 ? `:${f.line}` : ""}`;
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// A fence longer than any backtick run in the text, so evidence holding ``` stays one block.
function fenced(body) {
  const runs = String(body).match(/`+/g) || [];
  const n = Math.max(3, ...runs.map((r) => r.length + 1));
  const f = "`".repeat(n);
  return `${f}\n${String(body).replace(/\s+$/, "")}\n${f}`;
}

function pct(u, k) {
  const w = u && u[k];
  const v = w && typeof w === "object" ? w.pct : w;
  return typeof v === "number" && Number.isFinite(v) ? `${Math.round(v)}%` : null;
}

function duration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const min = Math.round(ms / 60000);
  if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} s`;
  return min >= 60 ? `${Math.floor(min / 60)} h ${min % 60} min` : `${min} min`;
}

function usageRow(meta, k) {
  const b = pct(meta.usageBefore, k);
  const a = pct(meta.usageAfter, k);
  if (!b && !a) return null;
  return `${b || "unknown"} before, ${a || "unknown"} after`;
}

function verification(f) {
  const v = f.votes;
  if (v && typeof v === "object") {
    const total = ["confirmed", "refuted", "uncertain"].reduce((n, k) => n + (Number(v[k]) || 0), 0);
    if (total) return `confirmed by ${Number(v.confirmed) || 0} of ${total} session${total === 1 ? "" : "s"}${v.refuted ? `, refuted by ${v.refuted}` : ""}${v.uncertain ? `, unsure: ${v.uncertain}` : ""}`;
  }
  return null;
}

// Why the verifiers refuted (or doubted) a finding: its own reason field, else the first verdict
// that says so.
function verdictReason(f, verdict) {
  if (typeof f.reason === "string" && f.reason.trim()) return f.reason.trim();
  const list = Array.isArray(f.verdicts) ? f.verdicts : [];
  const hit = list.find((v) => v && v.verdict === verdict && v.reason) || list.find((v) => v && v.reason);
  return hit ? String(hit.reason).trim() : "";
}

function titleOf(f) {
  return f.title || `${f.category || "finding"} in ${where(f)}`;
}

function findingBlock(f, { kind, detail = true, fixable = true }) {
  const L = [];
  L.push(`### ${f.id ? `${f.id} · ` : ""}${severityOf(f.severity)} · ${titleOf(f)}`, "");
  const rows = [
    ["Category", f.category],
    kind === "security" ? ["CWE", f.cwe] : null,
    f.cvss ? ["CVSS", f.cvss] : null,
    f.fixedVersion ? ["Fixed version", f.fixedVersion] : null,
    ["Where", `\`${where(f)}\``],
    ["Area", areaOf(f)],
    ["Confidence", `${Number(f.confidence) || 0}/10`],
    verification(f) ? ["Verification", verification(f)] : null,
    kind === "optimize" ? ["Fix tier", { A: "A (mechanical, proven)", B: "B (behind pinned tests)", C: "C (your decision, report only)" }[f.tier] || f.tier] : null,
    // The same rule as fixplan.needsOwner: for optimize the tier decides (tier B is fixed behind
    // pinned tests), for security autoFixSafe does.
    ["Fixed automatically", !fixable ? "no, it is not confirmed" : (kind === "optimize" ? !["A", "B"].includes(f.tier) : f.autoFixSafe === false) ? "no, needs the owner" : "yes, when fixing right away"],
    f.ownerAction ? ["Left for the owner", f.ownerAction] : null,
    Array.isArray(f.sources) && f.sources.length ? ["Found by", f.sources.join(", ")] : null,
    ["Fingerprint", (() => { const [own, ...also] = fingerprintsOf(f); return `\`${own}\`${also.length ? ` (also ${also.map((x) => `\`${x}\``).join(", ")})` : ""}`; })()]
  ].filter(Boolean);
  L.push("| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${cell(v)} |`), "");
  if (f.evidence) L.push("**Evidence**", "", fenced(f.evidence), "");
  if (!detail) return L;
  if (f.impact) L.push(`**Impact.** ${f.impact}`, "");
  if (f.reproduce) L.push("**How to reproduce.**", "", f.reproduce, "");
  if (f.fix) L.push("**Suggested fix.**", "", f.fix, "");
  if (f.testIdea) L.push(`**Test idea.** ${f.testIdea}`, "");
  return L;
}

function severityTable(findings) {
  const cats = [...new Set(findings.map((f) => f.category || "other"))].sort();
  const L = ["| Category | Critical | High | Medium | Low | Total |", "|---|---|---|---|---|---|"];
  for (const c of cats) {
    const n = countBySeverity(findings.filter((f) => (f.category || "other") === c));
    L.push(`| ${cell(c)} | ${n.critical} | ${n.high} | ${n.medium} | ${n.low} | ${n.total} |`);
  }
  const t = countBySeverity(findings);
  L.push(`| **Total** | ${t.critical} | ${t.high} | ${t.medium} | ${t.low} | ${t.total} |`);
  return L;
}

function coverageSection(coverage) {
  const c = coverage && typeof coverage === "object" ? coverage : {};
  const L = ["## Coverage", ""];
  const item = (x) => (typeof x === "string" ? x : x && typeof x === "object" ? [x.what || x.name || x.area || x.path, x.why || x.reason].filter(Boolean).join(": ") : String(x));
  const examined = Array.isArray(c.examined) ? c.examined : [];
  const notExamined = Array.isArray(c.notExamined) ? c.notExamined : [];
  L.push("### Examined", "", ...(examined.length ? examined.map((x) => `- ${item(x)}`) : ["- (nothing recorded)"]), "");
  L.push("### Not examined", "", ...(notExamined.length ? notExamined.map((x) => `- ${item(x)}`) : ["- (nothing recorded; that is not the same as everything examined)"]), "");
  const tools = Array.isArray(c.tools) ? c.tools : [];
  if (tools.length) {
    L.push("### Tools", "", "| Tool | Result | Notes |", "|---|---|---|");
    for (const t of tools) {
      const status = t.status || (t.ran === true ? "ran" : t.ran === false ? "skipped" : "-");
      const took = duration(t.durationMs);
      L.push(`| ${cell(t.name)} | ${cell(`${status}${took ? ` (${took})` : ""}`)} | ${cell(t.reason || t.note || "")} |`);
    }
    L.push("", "A tool that did not run is \"not checked\", never \"clean\".", "");
  }
  const areas = Array.isArray(c.areas) ? c.areas : [];
  if (areas.length) {
    L.push("### Areas", "", "| Area | Files | Review |", "|---|---|---|");
    for (const a of areas) L.push(`| ${cell(a.name || a.area)} | ${cell(a.files)} | ${cell(a.status)} |`);
    L.push("");
  }
  return L;
}

// The optimize baseline, whatever shape the scanner gave it: numbers and text as rows, lists of
// records as tables, nested records with dotted names.
function baselineSection(baseline) {
  const L = ["## Baseline", "", "Measured before any finding was acted on; a later change claims an improvement only above the noise.", ""];
  const rows = [];
  const tables = [];
  const walk = (obj, prefix) => {
    for (const [k, v] of Object.entries(obj)) {
      const name = prefix ? `${prefix}.${k}` : k;
      if (v === null || ["string", "number", "boolean"].includes(typeof v)) rows.push([name, v]);
      else if (Array.isArray(v)) {
        if (v.every((x) => x && typeof x === "object" && !Array.isArray(x))) tables.push([name, v]);
        else rows.push([name, v.join(", ")]);
      } else if (typeof v === "object") walk(v, name);
    }
  };
  walk(baseline, "");
  if (rows.length) L.push("| Measure | Value |", "|---|---|", ...rows.map(([k, v]) => `| ${cell(k)} | ${cell(v)} |`), "");
  for (const [name, list] of tables) {
    const cols = [...new Set(list.flatMap((x) => Object.keys(x)))];
    L.push(`### ${name}`, "", `| ${cols.map(cell).join(" | ")} |`, `|${cols.map(() => "---").join("|")}|`);
    for (const x of list.slice(0, 200)) L.push(`| ${cols.map((c) => cell(typeof x[c] === "object" && x[c] !== null ? JSON.stringify(x[c]) : x[c])).join(" | ")} |`);
    if (list.length > 200) L.push("", `(+${list.length - 200} more in findings.json)`);
    L.push("");
  }
  return L;
}

// The report's facts from what the sweep has: its own names (usageAtStart, usageAtEnd, agents,
// options) filled in where the report's are missing.
function reportMeta(meta) {
  const m = { ...meta };
  const o = m.options && typeof m.options === "object" ? m.options : {};
  if (m.usageBefore === undefined) m.usageBefore = m.usageAtStart;
  if (m.usageAfter === undefined) m.usageAfter = m.usageAtEnd;
  if (typeof m.sessions !== "number" && m.agents && typeof m.agents === "object") {
    const states = Object.values(m.agents);
    m.sessions = states.length;
    if (m.sessionsFailed === undefined) m.sessionsFailed = states.filter((s) => s === "failed").length;
  }
  if (typeof m.durationMs !== "number" && m.startedAt && m.finishedAt) {
    const d = Date.parse(m.finishedAt) - Date.parse(m.startedAt);
    if (Number.isFinite(d) && d >= 0) m.durationMs = d;
  }
  if (!m.depth && o.depth) m.depth = o.depth;
  if (!m.after && o.after) m.after = o.after;
  if (!m.modules && Array.isArray(o.modules)) m.modules = o.modules;
  if (!m.targets && Array.isArray(o.targets)) m.targets = o.targets;
  return m;
}

// Writes report.md and findings.json (schemaVersion 1) into the sweep's folder. Every finding
// text is masked again on the way out. meta (all optional): project, id, commit, dirty, branch,
// depth, startedAt, finishedAt, durationMs, sessions, sessionsFailed, model, effort,
// usageBefore and usageAfter ({ fiveHour, sevenDay }, each a percentage or { pct }), costUsd,
// targets ([{ url, mode }]), modules, after, plan (the generated plan file), next; or the
// sweep's own usageAtStart, usageAtEnd, agents ({ name: "done" | "failed" }) and options.
// coverage: { examined, notExamined, tools: [{ name, status, reason, durationMs }], areas }.
// findings.json also lists every finding once in `findings`, each with its verdict.
export function writeReport(sweepDir, { kind = "security", meta = {}, confirmed = [], uncertain = [], refuted = [], accepted = [], coverage = {}, baseline = null } = {}) {
  ensureDir(sweepDir);
  const m = redactDeep(reportMeta(meta && typeof meta === "object" ? meta : {}));
  const clean = (list) => sortFindings((list || []).map((f) => redactDeep(f)));
  const C = clean(confirmed);
  const U = clean(uncertain);
  const R = clean(refuted);
  const A = clean(accepted);
  const cov = redactDeep(coverage && typeof coverage === "object" ? coverage : {});
  const base = baseline && typeof baseline === "object" ? redactDeep(baseline) : null;
  const generatedAt = m.finishedAt || new Date().toISOString();

  const L = [];
  L.push(`# ${KIND_TITLE[kind] || "Sweep report"}`, "");
  const head = [m.project && `Project: ${m.project}`, m.id && `sweep ${m.id}`, `written ${generatedAt}`].filter(Boolean).join(", ");
  L.push(head, "");
  const facts = [
    ["Commit", m.commit ? `${String(m.commit).slice(0, 12)}${m.dirty ? " (with uncommitted changes)" : ""}${m.branch ? ` on ${m.branch}` : ""}` : null],
    ["Depth", m.depth ? DEPTH_TEXT[m.depth] || m.depth : null],
    ["Duration", [duration(m.durationMs), m.startedAt && `started ${m.startedAt}`].filter(Boolean).join(", ") || null],
    ["Sessions", typeof m.sessions === "number" ? `${m.sessions}${m.sessionsFailed ? ` (${m.sessionsFailed} failed)` : ""}` : null],
    ["Model and effort", m.model ? `${m.model}${m.effort ? `, effort ${m.effort}` : ", your Claude Code default effort"}` : null],
    ["5-hour usage", usageRow(m, "fiveHour")],
    ["Weekly usage", usageRow(m, "sevenDay")],
    ["Cost at API prices", typeof m.costUsd === "number" ? `$${m.costUsd.toFixed(2)}` : null],
    ["Modules", Array.isArray(m.modules) && m.modules.length ? m.modules.join(", ") : null],
    ["Targets", Array.isArray(m.targets) && m.targets.length ? m.targets.map((t) => (typeof t === "string" ? t : `${t.url}${t.mode ? ` (${t.mode})` : ""}`)).join(", ") : null],
    ["After the sweep", m.after ? `${{ report: "report only", plan: "a fix plan to review", fix: "fix right away" }[m.after] || m.after}${m.plan ? `: ${m.plan}` : ""}` : null]
  ].filter(([, v]) => v);
  if (facts.length) L.push("| | |", "|---|---|", ...facts.map(([k, v]) => `| ${k} | ${cell(v)} |`), "");
  L.push("This report stays in the gitignored `.autoclaude/` folder and is never committed. Secret values are masked to their first characters and their length.", "");

  const n = countBySeverity(C);
  L.push("## Summary", "");
  L.push(`Confirmed: ${n.total} (critical ${n.critical}, high ${n.high}, medium ${n.medium}, low ${n.low}). Uncertain: ${U.length}. Refuted: ${R.length}. Accepted earlier: ${A.length}.`, "");
  if (C.length) L.push(...severityTable(C), "");

  L.push(...coverageSection(cov));

  L.push("## Findings", "");
  if (!C.length) L.push("No confirmed findings.", "");
  for (const f of C) L.push(...findingBlock(f, { kind }));

  L.push("## Uncertain", "", "The verifying sessions could neither confirm nor refute these. They are never fixed automatically; check them yourself.", "");
  if (!U.length) L.push("None.", "");
  for (const f of U) {
    L.push(...findingBlock(f, { kind, fixable: false }));
    const why = verdictReason(f, "uncertain");
    if (why) L.push(`**Why it is uncertain.** ${why}`, "");
  }

  L.push("## Accepted earlier", "", `Findings matching an entry in \`${ACCEPTED_FILE}\` (an accepted risk or a false alarm). Remove the entry to have them reported again.`, "");
  if (!A.length) L.push("None.", "");
  else {
    L.push("| Finding | Severity | Where | Reason | By | Date |", "|---|---|---|---|---|---|");
    for (const f of A) {
      const a = f.accepted || {};
      L.push(`| ${cell(titleOf(f))} | ${cell(severityOf(f.severity))} | ${cell(where(f))} | ${cell(a.reason)} | ${cell(a.by)} | ${cell(a.date)} |`);
    }
    L.push("");
  }

  if (kind === "optimize" && base) L.push(...baselineSection(base));

  L.push("## Appendix: refuted", "", "Candidates the verifying sessions showed to be false alarms, with their reason.", "");
  if (!R.length) L.push("None.", "");
  else {
    L.push("| Candidate | Category | Where | Why it was refuted |", "|---|---|---|---|");
    for (const f of R) L.push(`| ${cell(titleOf(f))} | ${cell(f.category)} | ${cell(where(f))} | ${cell(verdictReason(f, "refuted"))} |`);
    L.push("");
  }
  if (m.next) L.push("## Next", "", String(m.next), "");

  const reportFile = path.join(sweepDir, "report.md");
  const jsonFile = path.join(sweepDir, "findings.json");
  writeFileAtomic(reportFile, L.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\s+$/, "") + "\n");
  const json = {
    schemaVersion: FINDINGS_SCHEMA_VERSION,
    kind,
    generatedAt,
    meta: m,
    coverage: cov,
    counts: { confirmed: n, uncertain: U.length, refuted: R.length, accepted: A.length },
    confirmed: C,
    uncertain: U,
    refuted: R,
    accepted: A,
    baseline: base,
    findings: [...C.map((f) => ({ ...f, verdict: "confirmed" })), ...U.map((f) => ({ ...f, verdict: "uncertain" })), ...R.map((f) => ({ ...f, verdict: "refuted" }))]
  };
  writeFileAtomic(jsonFile, JSON.stringify(json, null, 2) + "\n");
  return { reportFile, jsonFile };
}
