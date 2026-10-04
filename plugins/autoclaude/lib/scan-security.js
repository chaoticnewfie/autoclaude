// The security sweep's deterministic scanners (PLAN.md P10.3, D58): no model, Node and the
// tools already on the machine only. They feed candidates to the verification pass like the
// model reviewers do, so the sweep triages their hits instead of trusting them. What they do:
//   - secrets in the working tree and the whole git history, values masked at detection so a
//     raw secret never reaches a candidate, a report or a log;
//   - tracked sensitive files (.env, keys, dumps) and whether .gitignore covers the usual ones;
//   - package advisories from `npm audit` (npm lockfiles) and the OSV service (others), only
//     when options.advisories is on, and lockfile hygiene offline;
//   - gitleaks and osv-scanner, run from pinned Docker images with the project mounted
//     read-only when Docker answers, reported "not checked" when it does not, never as clean.
// A missing or switched-off check is coverage.notExamined, never a clean result.
// Node built-ins only. `run` (a command runner) and `fetchImpl` are injected so tests never
// touch real git, npm, npx, Docker or the network.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { isWindows } from "./paths.js";
import { findOnPath, killTree, cmdShimLine } from "./proc.js";
import { writeJsonAtomic, ensureDir } from "./fsatomic.js";
import { maskValue as sharedMaskValue } from "./findings.js";

// ---------- shared helpers ----------

// The canonical redactor lives in lib/findings.js (another owner). It is resolved once per run
// and injected in tests; when it cannot be loaded, a conservative local masker is used so a
// secret is masked even if the shared one is somehow absent. Secret values are also masked at
// detection (maskValue), so this is a second layer, never the only one.
export async function resolveRedact(injected) {
  if (typeof injected === "function") return injected;
  try { const m = await import("./findings.js"); if (typeof m.redact === "function") return m.redact; } catch {}
  return localRedact;
}

const LOCAL_SECRETISH = /\b([A-Za-z0-9_\-]{20,}|[A-Za-z0-9+/]{24,}={0,2})\b/g;
// A last-resort masker: long tokens become a prefix plus their length.
export function localRedact(text) {
  return String(text == null ? "" : text).replace(LOCAL_SECRETISH, (m) => maskValue(m));
}

// A secret value as a short prefix and its length, never the value itself: the one format every
// sweep file uses (findings.js maskValue, "AKIA[redacted, 20 chars]"), which its redactor
// recognises as already masked.
export function maskValue(value) {
  return sharedMaskValue(value == null ? "" : value);
}

// Shannon entropy per character, to tell a real-looking secret from a short or repetitive value.
export function entropy(s) {
  const str = String(s);
  if (!str) return 0;
  const counts = new Map();
  for (const c of str) counts.set(c, (counts.get(c) || 0) + 1);
  let h = 0;
  for (const n of counts.values()) { const p = n / str.length; h -= p * Math.log2(p); }
  return h;
}

// A path that is a test fixture, example or sample: a hit there is marked low confidence (it is
// usually a dummy value), never dropped.
const FIXTURE_RE = /(^|\/)(tests?|__tests__|__mocks__|e2e|specs?|fixtures?|examples?|samples?|mocks?|testdata|test-data|seeds?|demos?)\//i;
const EXAMPLE_NAME_RE = /\.(example|sample|template|dist|template\.[a-z]+)$|(^|\/)[^/]*\.example(\.[a-z]+)?$/i;
export function isFixturePath(rel) {
  const p = String(rel || "").replace(/\\/g, "/");
  return FIXTURE_RE.test(p) || EXAMPLE_NAME_RE.test(p);
}

// ---------- secret rules ----------
// Pattern set for common keys, tokens, private keys, connection strings and passwords in config.
// Each rule: name, the regex (the secret is group 1 when present, else the whole match), a
// severity for a confident hit, and a CWE. The two "generic" rules only fire past an entropy and
// placeholder gate, because most of their hits are variable references or dummy values.
export const SECRET_RULES = Object.freeze([
  { name: "aws-access-key", re: /\b(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/, severity: "critical", cwe: "CWE-798" },
  { name: "github-token", re: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/, severity: "critical", cwe: "CWE-798" },
  { name: "anthropic-key", re: /\bsk-ant-[a-z0-9]{3,8}-[A-Za-z0-9_-]{40,}/, severity: "critical", cwe: "CWE-798" },
  { name: "openai-key", re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}T3BlbkFJ[A-Za-z0-9_-]{20,}/, severity: "critical", cwe: "CWE-798" },
  { name: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/, severity: "high", cwe: "CWE-798" },
  { name: "stripe-live", re: /\b(?:sk|rk)_live_[0-9a-zA-Z]{20,}/, severity: "critical", cwe: "CWE-798" },
  { name: "google-api-key", re: /\bAIza[0-9A-Za-z_-]{35}\b/, severity: "high", cwe: "CWE-798" },
  { name: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/, severity: "critical", cwe: "CWE-312", whole: true },
  { name: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, severity: "medium", cwe: "CWE-522" },
  { name: "url-with-password", re: /\b(?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis|rediss|amqps?|https?|ftp):\/\/[^:\s/@'"]+:([^@\s'"]{3,})@/, severity: "high", cwe: "CWE-798", gated: true },
  { name: "discord-webhook", re: /https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/, severity: "high", cwe: "CWE-798" },
  { name: "ntfy-token", re: /\btk_[a-z0-9]{29}\b/, severity: "medium", cwe: "CWE-798" },
  { name: "tailscale-key", re: /\btskey-(?:auth|api|client)-[A-Za-z0-9-]{10,}/, severity: "high", cwe: "CWE-798" },
  { name: "npm-token", re: /\bnpm_[A-Za-z0-9]{36}\b/, severity: "high", cwe: "CWE-798" },
  { name: "generic-assignment", re: /(?:password|passwd|secret|token|api[_-]?key|client[_-]?secret|private[_-]?key|access[_-]?key)["']?\s*[:=]\s*["']([^"'\s$<>{}]{12,})["']/i, severity: "high", cwe: "CWE-798", gated: true }
]);

const PLACEHOLDER_RE = /(?:example|changeme|change_me|placeholder|your[_-]|xxxx|<|\$\{|%[A-Z_]+%|\{\{|dummy|test|fake|sample|redacted|\*\*\*|\benv\b|process\.env|getenv|os\.environ|secret_file|_file\b)/i;

// What a secret rule (ours or gitleaks') found, in words for a finding's title: "A GitHub token".
const SECRET_LABELS = Object.freeze({
  "aws-access-key": "An AWS access key",
  "github-token": "A GitHub token",
  "anthropic-key": "An Anthropic API key",
  "openai-key": "An OpenAI API key",
  "slack-token": "A Slack token",
  "stripe-live": "A Stripe-style secret key",
  "google-api-key": "A Google API key",
  "private-key": "A private key",
  "jwt": "A JSON Web Token",
  "url-with-password": "A URL with a password in it",
  "discord-webhook": "A Discord webhook URL",
  "ntfy-token": "An ntfy access token",
  "tailscale-key": "A Tailscale key",
  "npm-token": "An npm access token",
  "generic-assignment": "A hard-coded password or key"
});
// gitleaks' rule ids (stripe-access-token, github-pat, aws-access-token, ...) by the service they
// name; a rule none of these names keeps its id in the title.
const SECRET_LABEL_WORDS = [
  [/stripe/i, "A Stripe-style secret key"], [/github|^gh[pousr]\b/i, "A GitHub token"], [/gitlab/i, "A GitLab token"], [/aws|amazon/i, "An AWS key"],
  [/anthropic/i, "An Anthropic API key"], [/openai/i, "An OpenAI API key"], [/slack/i, "A Slack token"], [/private[-_]?key/i, "A private key"],
  [/jwt/i, "A JSON Web Token"], [/gcp|google/i, "A Google API key"], [/npm/i, "An npm access token"], [/discord/i, "A Discord token or webhook"],
  [/twilio/i, "A Twilio key"], [/sendgrid/i, "A SendGrid key"], [/azure/i, "An Azure key"], [/password/i, "A password"]
];
export function secretLabel(rule) {
  const r = String(rule || "");
  if (SECRET_LABELS[r]) return SECRET_LABELS[r];
  const hit = SECRET_LABEL_WORDS.find(([re]) => re.test(r));
  return hit ? hit[1] : `A secret (rule ${r || "unknown"})`;
}

// One line, returns [{ name, severity, cwe, value }]. A gated rule needs the captured value to
// look like a real secret (entropy and no placeholder); the rest fire on the pattern alone.
export function scanLine(line) {
  const hits = [];
  for (const rule of SECRET_RULES) {
    const m = rule.re.exec(line);
    if (!m) continue;
    const value = rule.whole ? m[0] : (m[1] || m[0]);
    if (rule.gated) {
      if (PLACEHOLDER_RE.test(value) || entropy(value) < 3.0) continue;
    }
    hits.push({ name: rule.name, severity: rule.severity, cwe: rule.cwe, value });
  }
  return hits;
}

// Tracked files whose very name is a credential store, and dump files that often hold data.
const SENSITIVE_NAME_RE = /(?:^|\/)(?:\.env(?:\.[^/]*)?|\.?secrets?(?:\.[^/]*)?|id_(?:rsa|dsa|ecdsa|ed25519)|.*\.(?:pem|key|pfx|p12|keystore|jks|kdbx|ppk)|credentials(?:\.json)?|service-account.*\.json|\.npmrc|\.pypirc|\.netrc|\.htpasswd|terraform\.tfstate|.*\.(?:sql|dump|bak|sqlite3?|db))$/i;
// A sensitive name that is clearly an example or template is not a finding.
const SENSITIVE_OK_RE = /\.(?:example|sample|template|dist)$|(^|\/)[^/]*\.example(\.[a-z]+)?$/i;

// ---------- a default command runner (not used in tests) ----------
// run(exe, args, { cwd, env, input, timeoutMs }) -> { ok, code, stdout, stderr, timedOut }.
// Resolves the executable on PATH (so npm/npx/docker .cmd shims on Windows resolve), runs a .cmd
// or .bat through cmd.exe the way spawnClaude does, never through a shell otherwise, and never
// rejects. Tests inject their own `run`.
export function defaultRun(exe, args = [], { cwd = process.cwd(), env = process.env, input = null, timeoutMs = 120000, maxBuffer = 256 * 1024 * 1024 } = {}) {
  return new Promise((resolve) => {
    const resolved = findOnPath(exe, env) || exe;
    let child;
    try {
      if (isWindows && /\.(cmd|bat)$/i.test(resolved)) {
        child = spawn("cmd.exe", ["/d", "/s", "/c", cmdShimLine(resolved, args)], { cwd, env, windowsVerbatimArguments: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      } else {
        child = spawn(resolved, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      }
    } catch (e) {
      return resolve({ ok: false, code: null, stdout: "", stderr: String(e && e.message || e), timedOut: false });
    }
    let stdout = "";
    let stderr = "";
    let over = false;
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => { if (stdout.length < maxBuffer) stdout += d; else over = true; });
    child.stderr.on("data", (d) => { if (stderr.length < maxBuffer) stderr += d; });
    child.stdin.on("error", () => {});
    if (input !== null) child.stdin.end(String(input)); else child.stdin.end();
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, code: null, stdout, stderr: String(e && e.message || e), timedOut }); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0 && !timedOut, code, stdout, stderr, timedOut, truncated: over }); });
  });
}

// ---------- the scanners ----------

// A candidate finding (the sweep adds id and fingerprint later): the shared finding shape, kind
// "security", tier "A", with the redactor already applied to evidence.
// autoFixSafe: true when a change to this repository fixes it, so "fix right away" does (D58);
// false only for what needs the owner (a history rewrite, a major upgrade, no fix published, a
// judgement about a source). ownerAction: what only the owner can do even after the fix (rotate
// a key at its provider). anchor: a fixed key for the fingerprint (findings.anchorOf), so the
// same hit keeps its fingerprint from one sweep to the next; never a secret value. title: one
// plain line naming the problem and where, masked like the evidence (the report's heading).
function candidate({ title = "", category, severity, cwe = null, cvss = null, fixedVersion = null, confidence, file, line = 0, evidence, impact, fix, testIdea, autoFixSafe = false, ownerAction = null, anchor = null, commit = null }, redact) {
  return {
    kind: "security", title: redact(String(title || "")), category, severity, cwe, cvss, fixedVersion,
    confidence, file: String(file || "").replace(/\\/g, "/"), line: Number(line) || 0,
    evidence: redact(String(evidence || "")), impact, fix, testIdea, tier: "A", autoFixSafe,
    ...(ownerAction ? { ownerAction } : {}),
    ...(anchor ? { anchor } : {}),
    ...(commit ? { commit } : {})
  };
}

// What the owner still does when a secret was in the code: the fix moves it out, only the owner
// can replace the value at the service that issued it.
const ROTATE = "Rotate the value at the service that issued it: it was readable in the repository.";

// git ls-files -co --exclude-standard: tracked plus untracked-not-ignored, NUL-separated.
async function listWorkingFiles(run, root, env) {
  const r = await run("git", ["-C", root, "ls-files", "-co", "--exclude-standard", "-z"], { cwd: root, env });
  if (!r.ok) return null;
  return String(r.stdout).split("\0").filter(Boolean);
}

async function listTrackedFiles(run, root, env) {
  const r = await run("git", ["-C", root, "ls-files", "-z"], { cwd: root, env });
  if (!r.ok) return null;
  return String(r.stdout).split("\0").filter(Boolean);
}

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Secrets in the working tree. Reads each file from disk (reading is safe); skips binaries, big
// files and the excluded globs. A hit in a fixture or example path is low confidence.
export function scanTree({ root, files, exclude, redact }) {
  const candidates = [];
  let scanned = 0;
  const excluded = (rel) => (exclude || []).some((g) => { try { return path.matchesGlob(rel.replace(/\\/g, "/"), g); } catch { return false; } });
  for (const rel of files) {
    if (excluded(rel)) continue;
    const full = path.join(root, rel);
    let st; try { st = fs.statSync(full); } catch { continue; }
    if (!st.isFile() || st.size > MAX_FILE_BYTES) continue;
    let buf; try { buf = fs.readFileSync(full); } catch { continue; }
    if (buf.includes(0)) continue; // binary
    scanned++;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      for (const hit of scanLine(lines[i])) {
        const fixture = isFixturePath(rel);
        candidates.push(candidate({
          title: `${secretLabel(hit.name)} in ${rel.replace(/\\/g, "/")}${fixture ? " (a test or example file)" : ""}`,
          category: "secrets",
          severity: fixture ? "low" : hit.severity,
          cwe: hit.cwe,
          confidence: fixture ? 2 : (hit.name === "generic-assignment" || hit.name === "url-with-password" ? 6 : 8),
          file: rel, line: i + 1,
          evidence: `${hit.name} in the working tree (value ${maskValue(hit.value)})`,
          impact: fixture ? "A credential-shaped value in a test or example file; likely a dummy, confirm it is not real." : "A credential appears to be committed in the source tree, readable by anyone with the repository.",
          fix: "Remove the value from the file, load it from an environment variable or the gitignored secrets/ folder, and rotate it if it was ever real.",
          testIdea: "A scan of the working tree reports no secret in this file.",
          // Moving the value out of the code is a change to this repository; rotating it is not.
          autoFixSafe: true,
          ownerAction: ROTATE,
          anchor: `secret:${hit.name}:${maskValue(hit.value)}`
        }, redact));
      }
    }
  }
  return { candidates, scanned };
}

const HISTORY_CAP = 96 * 1024 * 1024;

// "A GitHub token in the git history of Dockerfile (commit c6a815d0cd2c)".
function historyTitle(label, file, commit) {
  return `${label} in the git history${file ? ` of ${file}` : ""}${commit ? ` (commit ${String(commit).slice(0, 12)})` : ""}`;
}

// Secrets anywhere in the git history (added lines across every ref), so a secret that was
// committed then deleted is still found. A real secret in history always needs the owner to
// rotate it, so the fix line says so and these are never auto-fixable.
export function scanHistoryText(stdout, redact) {
  const candidates = [];
  let commit = "";
  let file = "";
  let commits = 0;
  const lines = String(stdout).split(/\r?\n/);
  for (const l of lines) {
    if (l.startsWith("@@C ")) { commit = l.slice(4).trim(); commits++; continue; }
    if (l.startsWith("+++ ")) { file = l.slice(4).replace(/^b\//, "").trim(); continue; }
    if (l.startsWith("+") && !l.startsWith("+++")) {
      for (const hit of scanLine(l.slice(1))) {
        const fixture = isFixturePath(file);
        candidates.push(candidate({
          title: historyTitle(secretLabel(hit.name), file, commit),
          category: "secrets",
          severity: fixture ? "low" : hit.severity,
          cwe: hit.cwe,
          confidence: fixture ? 2 : (hit.name === "generic-assignment" || hit.name === "url-with-password" ? 5 : 7),
          file: file || "(history)", line: 0,
          evidence: `${hit.name} added in git history at commit ${commit || "?"} in ${file || "?"} (value ${maskValue(hit.value)})`,
          impact: fixture ? "A credential-shaped value in a historical test or example file; likely a dummy." : "A credential is present in the git history even if it is no longer in the latest files; anyone with the history can read it.",
          fix: "Treat the value as compromised and rotate it. Removing it from history needs a rewrite (git filter-repo / BFG) coordinated by the owner.",
          testIdea: "A history scan reports no secret of this kind after the value is rotated and the history is cleaned.",
          // Nothing a commit can change: the owner rotates the key (and decides on a rewrite).
          autoFixSafe: false,
          ownerAction: "Rotate the value at the service that issued it; rewriting the git history is your decision.",
          anchor: `history:${commit || "?"}:${hit.name}:${maskValue(hit.value)}`,
          commit: commit || null
        }, redact));
      }
    }
  }
  return { candidates, commits };
}

export async function scanHistory({ run, root, env, redact }) {
  const r = await run("git", ["-C", root, "log", "-p", "--all", "--no-color", "--no-ext-diff", "--unified=0", "--format=@@C %H"], { cwd: root, env, timeoutMs: 180000 });
  if (!r.ok) return { candidates: [], examined: null, note: `git history could not be read: ${String(r.stderr || "").slice(0, 200)}` };
  if (String(r.stdout).length > HISTORY_CAP || r.truncated) {
    return { candidates: [], examined: null, note: `git history too large to scan in one pass (${String(r.stdout).length} bytes); run an external secret scanner over the full history` };
  }
  const { candidates, commits } = scanHistoryText(r.stdout, redact);
  return { candidates, examined: `git history (${commits} commit${commits === 1 ? "" : "s"})`, note: null };
}

// Tracked sensitive files, and whether .gitignore covers the usual secret paths.
export function scanSensitiveAndGitignore({ root, tracked, redact }) {
  const candidates = [];
  for (const rel of (tracked || [])) {
    const p = rel.replace(/\\/g, "/");
    if (SENSITIVE_NAME_RE.test(p) && !SENSITIVE_OK_RE.test(p)) {
      const isDump = /\.(?:sql|dump|bak|sqlite3?|db)$/i.test(p);
      candidates.push(candidate({
        title: isDump ? `A database dump or local database is committed: ${p}` : `A file that usually holds secrets is committed: ${p}`,
        category: "secrets",
        severity: isDump ? "high" : "high",
        cwe: "CWE-312",
        confidence: isDump ? 6 : 7,
        file: rel, line: 0,
        evidence: `tracked sensitive file: ${p}`,
        impact: isDump ? "A database dump or local database is committed; it may contain real data or credentials." : "A file that normally holds secrets (keys, env, credentials) is committed to the repository.",
        fix: `Remove ${p} from the repository, add its path to .gitignore, and rotate anything it exposed.`,
        testIdea: "git ls-files reports this path is no longer tracked.",
        // Untracking it and ignoring its path is a commit; what it exposed stays in the history.
        autoFixSafe: true,
        ownerAction: "Rotate anything the file held: it stays readable in the git history.",
        anchor: `tracked:${p.toLowerCase()}`
      }, redact));
    }
  }
  // .gitignore coverage of the folders a run and a person keep secrets in.
  const giText = (() => { try { return fs.readFileSync(path.join(root, ".gitignore"), "utf8"); } catch { return null; } })();
  const want = [
    { re: /^\s*\/?secrets(\/\*{0,2})?\s*$/m, name: "secrets/" },
    { re: /^\s*\/?\.env(\b|\.|\/|\*)/m, name: ".env" }
  ];
  const missing = want.filter((w) => !(giText && w.re.test(giText)));
  if (missing.length) {
    candidates.push(candidate({
      title: giText === null ? "No .gitignore at the project root" : `.gitignore does not cover ${missing.map((m) => m.name).join(" or ")}`,
      category: "config",
      severity: "medium",
      cwe: "CWE-538",
      confidence: 5,
      file: ".gitignore", line: 0,
      evidence: giText === null ? "no .gitignore at the project root" : `.gitignore does not cover ${missing.map((m) => m.name).join(", ")}`,
      impact: "Secret files are not ignored, so a future commit could add them without warning.",
      fix: `Add ${missing.map((m) => m.name).join(" and ")} to .gitignore.`,
      testIdea: "The .gitignore covers the secret paths.",
      autoFixSafe: true,
      anchor: "gitignore:secret-paths"
    }, redact));
  }
  return { candidates };
}

// ---------- dependency advisories and lockfile hygiene ----------

const LOCKFILES = Object.freeze([
  { file: "package-lock.json", ecosystem: "npm", npm: true },
  { file: "npm-shrinkwrap.json", ecosystem: "npm", npm: true },
  { file: "yarn.lock", ecosystem: "npm" },
  { file: "pnpm-lock.yaml", ecosystem: "npm" },
  { file: "requirements.txt", ecosystem: "PyPI" },
  { file: "poetry.lock", ecosystem: "PyPI" },
  { file: "Pipfile.lock", ecosystem: "PyPI" },
  { file: "go.sum", ecosystem: "Go" },
  { file: "Cargo.lock", ecosystem: "crates.io" },
  { file: "composer.lock", ecosystem: "Packagist" },
  { file: "Gemfile.lock", ecosystem: "RubyGems" }
]);

export function severityFromNpm(sev) {
  const s = String(sev || "").toLowerCase();
  if (s === "critical") return "critical";
  if (s === "high") return "high";
  if (s === "moderate" || s === "medium") return "medium";
  return "low";
}

export function severityFromCvss(score) {
  const n = Number(score);
  if (!Number.isFinite(n)) return "medium";
  if (n >= 9) return "critical";
  if (n >= 7) return "high";
  if (n >= 4) return "medium";
  return "low";
}

// "minimist 0.0.8 has 2 known vulnerabilities (fixed in 1.2.6)": a vulnerable package in words.
// viaPackages: the vulnerable packages it depends on, when it has no advisory of its own.
// fixVia: { name, version } when an upgrade of another package (a parent) is the fix.
function advisoryTitle({ name, version = null, count = 0, viaPackages = [], fixedVersion = null, fixVia = null, fixInRange = false, noFix = false }) {
  const what = `${name}${version ? ` ${version}` : ""}`;
  const has = count > 0 ? `has ${count === 1 ? "a known vulnerability" : `${count} known vulnerabilities`}`
    : viaPackages.length ? `is vulnerable through ${viaPackages.slice(0, 3).join(", ")}${viaPackages.length > 3 ? " and more" : ""}`
      : "has known vulnerabilities";
  const fix = fixVia ? ` (upgrading ${fixVia.name}${fixVia.version ? ` to ${fixVia.version}` : ""} fixes it)`
    : fixedVersion ? ` (fixed in ${fixedVersion})` : fixInRange ? " (a fixed version is inside its allowed range)" : noFix ? " (no fixed version published yet)" : "";
  return `${what} ${has}${fix}`;
}

// The installed version of a package in a parsed package-lock.json (lockfile v2/v3 `packages`, or
// v1 `dependencies`), else null.
export function lockedVersion(lock, name) {
  if (!lock || typeof lock !== "object" || !name) return null;
  const p = lock.packages && lock.packages[`node_modules/${name}`];
  if (p && typeof p.version === "string") return p.version;
  const d = lock.dependencies && lock.dependencies[name];
  return d && typeof d.version === "string" ? d.version : null;
}

// npm audit --json --package-lock-only: parses the v7+ `vulnerabilities` map. The exit code is
// nonzero when it finds something, so the JSON, not the code, decides. lock: the parsed
// package-lock.json, for the installed versions the titles name (optional).
export function parseNpmAudit(stdout, redact, { lock = null } = {}) {
  const candidates = [];
  let data; try { data = JSON.parse(stdout); } catch { return { candidates, ok: false }; }
  const vulns = data && data.vulnerabilities;
  if (!vulns || typeof vulns !== "object") return { candidates, ok: true };
  for (const [name, v] of Object.entries(vulns)) {
    if (!v || typeof v !== "object") continue;
    const vias = Array.isArray(v.via) ? v.via : [];
    const via = vias.find((x) => x && typeof x === "object") || null;
    const cwe = via && Array.isArray(via.cwe) && via.cwe.length ? via.cwe[0] : null;
    const cvss = via && via.cvss && via.cvss.vectorString ? via.cvss.vectorString : null;
    // npm's fixAvailable: true (npm audit fix resolves it inside the allowed ranges), an object
    // naming the version (isSemVerMajor when that is a major upgrade), or false (no fix yet).
    const fa = v.fixAvailable;
    const fixObj = fa && typeof fa === "object" ? fa : null;
    const fixedVersion = fixObj && fixObj.version ? String(fixObj.version) : null;
    const major = !!(fixObj && fixObj.isSemVerMajor === true);
    const fixable = fa === true || (!!fixObj && !major);
    const fixName = fixObj && fixObj.name && fixObj.name !== name ? String(fixObj.name) : name;
    candidates.push(candidate({
      title: advisoryTitle({
        name, version: lockedVersion(lock, name), count: vias.filter((x) => x && typeof x === "object").length,
        viaPackages: [...new Set(vias.filter((x) => typeof x === "string"))],
        // npm names another package when a parent's upgrade is the fix.
        fixedVersion: fixName === name ? fixedVersion : null, fixVia: fixName !== name ? { name: fixName, version: fixedVersion } : null,
        fixInRange: fa === true, noFix: !fa
      }),
      category: "deps", severity: severityFromNpm(v.severity), cwe, cvss, fixedVersion,
      confidence: 8, file: "package-lock.json", line: 0,
      evidence: `npm advisory for ${name} (${v.range || "range unknown"})${via && via.title ? `: ${via.title}` : ""}`,
      impact: "A dependency version with a known vulnerability is installed.",
      fix: fa === true ? `Update ${name} inside its allowed range (npm audit fix does it without a major upgrade).`
        : fixObj ? `Upgrade ${fixName} to ${fixedVersion || "the fixed version"}${major ? " (a major upgrade: its breaking changes need the owner's review)" : " (no major upgrade needed)"}.`
        : `No fixed version is published yet for ${name}; track the advisory.`,
      testIdea: "npm audit reports no advisory for this package.",
      // A patch or minor move is a change to this repository; a major one, or none, is the owner's.
      autoFixSafe: fixable,
      ownerAction: major ? `A major upgrade of ${fixName} fixes it: review its breaking changes and upgrade, or accept the risk.`
        : fixable ? null : `No fixed version of ${name} is published yet: replace it, or accept the risk until one is.`,
      anchor: `pkg:npm:${String(name).toLowerCase()}`
    }, redact));
  }
  return { candidates, ok: true };
}

// OSV batch query for non-npm lockfiles. Parses the lockfile for name/version pairs (best effort
// per ecosystem) and asks OSV in one batch. Network, so only when options.advisories is on, and
// through the injected fetchImpl in tests.
export function parseLockfilePackages(file, text) {
  const pkgs = [];
  const base = path.basename(file);
  const push = (name, version) => { if (name && version) pkgs.push({ name: String(name), version: String(version) }); };
  if (base === "requirements.txt") {
    for (const line of String(text).split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z0-9_.\-]+)\s*==\s*([0-9][^\s;#]*)/);
      if (m) push(m[1], m[2]);
    }
  } else if (base === "Cargo.lock" || base === "Pipfile.lock" || base === "poetry.lock") {
    // TOML/JSON-ish: pair up name = "x" with the following version = "y".
    const names = [];
    const versions = [];
    const re = /(name|version)\s*=\s*"([^"]+)"/g;
    let m;
    const pending = {};
    while ((m = re.exec(String(text)))) {
      pending[m[1]] = m[2];
      if (pending.name && pending.version) { push(pending.name, pending.version); pending.name = pending.version = undefined; }
    }
    void names; void versions;
  } else if (base === "go.sum") {
    const seen = new Set();
    for (const line of String(text).split(/\r?\n/)) {
      const m = line.match(/^(\S+)\s+(v\S+?)(\/go\.mod)?\s+h1:/);
      if (m) { const key = `${m[1]}@${m[2]}`; if (!seen.has(key)) { seen.add(key); push(m[1], m[2]); } }
    }
  } else if (base === "composer.lock" || base === "Gemfile.lock" || base === "yarn.lock" || base === "pnpm-lock.yaml") {
    // These need an ecosystem-specific parser; left to an external scanner (coverage note).
    return pkgs;
  }
  return pkgs;
}

export async function scanOsv({ fetchImpl, ecosystem, packages, file, redact }) {
  if (!packages.length) return { candidates: [], queried: 0 };
  const body = { queries: packages.map((p) => ({ package: { name: p.name, ecosystem }, version: p.version })) };
  let results;
  try {
    const r = await fetchImpl("https://api.osv.dev/v1/querybatch", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const j = await r.json();
    results = Array.isArray(j.results) ? j.results : [];
  } catch (e) {
    return { candidates: [], queried: 0, error: String(e && e.message || e) };
  }
  const candidates = [];
  for (let i = 0; i < results.length; i++) {
    const vulns = results[i] && Array.isArray(results[i].vulns) ? results[i].vulns : [];
    if (!vulns.length) continue;
    const pkg = packages[i];
    const ids = vulns.map((v) => v.id).filter(Boolean);
    candidates.push(candidate({
      title: advisoryTitle({ name: pkg.name, version: pkg.version, count: ids.length || vulns.length }),
      category: "deps", severity: "medium", cwe: null, cvss: null, fixedVersion: null,
      confidence: 7, file, line: 0,
      evidence: `OSV advisory for ${pkg.name} ${pkg.version} (${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", ..." : ""})`,
      impact: "A dependency version has one or more known advisories in the OSV database.",
      fix: `Review the OSV advisories for ${pkg.name} and upgrade to a fixed version (majors are owner-reviewed).`,
      testIdea: "OSV reports no advisory for this package version.",
      // The batch answer names no fixed version, so which upgrade (if any) is the owner's call.
      autoFixSafe: false,
      ownerAction: `Pick the upgrade of ${pkg.name} the advisories allow (the batch query names no fixed version).`,
      anchor: `pkg:${String(ecosystem).toLowerCase()}:${String(pkg.name).toLowerCase()}`
    }, redact));
  }
  return { candidates, queried: packages.length };
}

// Lockfile hygiene, offline: packages resolved from outside the public registry and missing
// integrity hashes in an npm lockfile are a supply-chain risk worth a look.
export function scanLockfileHygiene({ root, redact }) {
  const candidates = [];
  const examined = [];
  const lockPath = path.join(root, "package-lock.json");
  let text; try { text = fs.readFileSync(lockPath, "utf8"); } catch { return { candidates, examined }; }
  examined.push("package-lock.json hygiene");
  let data; try { data = JSON.parse(text); } catch { return { candidates, examined }; }
  const packages = data.packages || {};
  for (const [name, p] of Object.entries(packages)) {
    if (!name || !p || typeof p !== "object") continue;
    const resolved = typeof p.resolved === "string" ? p.resolved : "";
    if (resolved && /^(https?:\/\/)/.test(resolved) && !/registry\.npmjs\.org|registry\.yarnpkg\.com/.test(resolved)) {
      candidates.push(candidate({
        title: `${name.replace(/^.*node_modules\//, "") || name} is installed from outside the public npm registry`,
        category: "deps", severity: "medium", cwe: "CWE-829", confidence: 6,
        file: "package-lock.json", line: 0,
        evidence: `${name} is resolved from outside the public npm registry (${resolved.replace(/\/\/[^@/]+@/, "//") })`,
        impact: "A dependency is pulled from a non-registry source, which is harder to audit and easier to tamper with.",
        fix: "Confirm the source is trusted and pinned by integrity hash, or move the package to the public registry.",
        testIdea: "The lockfile resolves this package from the public registry or a trusted, hashed source.",
        // Whether a private source is trusted is the owner's judgement.
        autoFixSafe: false,
        ownerAction: "Decide whether this source is trusted; if not, move the package to the public registry.",
        anchor: `resolved:${name.toLowerCase()}`
      }, redact));
    }
  }
  return { candidates, examined };
}

// ---------- external scanners fetched on the fly ----------
// gitleaks (secrets in the whole git history, with many more rules than SECRET_RULES) and
// osv-scanner (advisories for every lockfile it knows) are not npm packages, so they come as
// Docker images at pinned tags, fetched by `docker run` and never added to the project. The
// project is mounted read-only; gitleaks runs with no network at all, osv-scanner needs the OSV
// service and so runs only when advisories are on (sweep.advisories). Their output is parsed and
// masked like everything else: gitleaks is told to redact, and neither the secret nor the
// matched text is ever read from its report. When Docker does not answer, both are "not checked",
// never clean. Raise a tag only after checking the output format on the new release.
export const GITLEAKS_IMAGE = "ghcr.io/gitleaks/gitleaks:v8.30.1";
export const OSV_SCANNER_IMAGE = "ghcr.io/google/osv-scanner:v2.5.1";
const EXTERNAL_TIMEOUT_MS = 10 * 60 * 1000;

// { ok, version, reason }: whether a Docker engine answers.
export async function dockerStatus({ run, env }) {
  const r = await Promise.resolve(run("docker", ["version", "--format", "{{.Server.Version}}"], { env, timeoutMs: 15000 })).catch((e) => ({ ok: false, stderr: String(e && e.message || e) }));
  const version = r && r.ok ? String(r.stdout || "").trim() : "";
  if (version) return { ok: true, version, reason: null };
  return { ok: false, version: null, reason: "Docker is not running or not installed, and these scanners come only as Docker images" };
}

// The --mount value that binds the project read-only at `target`; null for a path Docker's
// mount syntax cannot carry.
export function readOnlyMount(root, target) {
  const src = path.resolve(root);
  if (src.includes("\"") || /[\r\n]/.test(src)) return null;
  return `type=bind,${src.includes(",") ? `"source=${src}"` : `source=${src}`},target=${target},readonly`;
}

// gitleaks over every commit of every ref (its default for `git`), report as JSON on stdout,
// values redacted, exit code 0 whatever it finds; no network.
export function gitleaksArgs(root) {
  const mount = readOnlyMount(root, "/repo");
  return mount ? ["run", "--rm", "--network", "none", "--mount", mount, GITLEAKS_IMAGE, "git", "/repo", "--report-format", "json", "--report-path", "-", "--redact", "--no-banner", "--exit-code", "0", "--log-level", "error"] : null;
}

// osv-scanner over every package file under the project, JSON on stdout. Exit code 1 means it
// found advisories, 128 that it found no package file.
export function osvScannerArgs(root) {
  const mount = readOnlyMount(root, "/src");
  return mount ? ["run", "--rm", "--mount", mount, OSV_SCANNER_IMAGE, "scan", "source", "--recursive", "--format", "json", "/src"] : null;
}

const firstLine = (s) => String(s || "").trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || "";

// gitleaks' JSON report: one candidate per finding, from the rule, the file, the line and the
// commit only (Secret, Match, the author and the commit message are never read).
export function parseGitleaks(stdout, redact) {
  const text = String(stdout || "").trim();
  if (!text) return { ok: true, candidates: [] };
  let data;
  try { data = JSON.parse(text); } catch { return { ok: false, candidates: [] }; }
  if (!Array.isArray(data)) return { ok: false, candidates: [] };
  const candidates = [];
  for (const g of data) {
    if (!g || typeof g !== "object") continue;
    const rule = String(g.RuleID || "secret").replace(/[^\w.-]/g, "").slice(0, 60) || "secret";
    const file = String(g.File || "").replace(/\\/g, "/").replace(/^\/repo\//, "").replace(/^\.\//, "");
    const commit = /^[0-9a-f]{7,64}$/i.test(String(g.Commit || "")) ? String(g.Commit).toLowerCase() : null;
    const line = Number.isInteger(Number(g.StartLine)) && Number(g.StartLine) > 0 ? Number(g.StartLine) : 0;
    const fixture = isFixturePath(file);
    candidates.push(candidate({
      title: historyTitle(secretLabel(rule), file, commit),
      category: "secrets", severity: fixture ? "low" : "high", cwe: "CWE-798",
      confidence: fixture ? 2 : 7,
      file: file || "(history)", line: 0,
      evidence: `gitleaks rule ${rule} matched in git history${commit ? ` at commit ${commit.slice(0, 12)}` : ""} in ${file || "?"}${line ? ` line ${line}` : ""} (the value is not shown)`,
      impact: fixture ? "A credential-shaped value in a historical test or example file; likely a dummy." : "A credential is present in the git history even if it is no longer in the latest files; anyone with the history can read it.",
      fix: "Treat the value as compromised and rotate it. Removing it from history needs a rewrite (git filter-repo / BFG) coordinated by the owner.",
      testIdea: "A history scan reports no secret of this kind after the value is rotated and the history is cleaned.",
      autoFixSafe: false,
      ownerAction: "Rotate the value at the service that issued it; rewriting the git history is your decision.",
      anchor: `gitleaks:${commit || "-"}:${file.toLowerCase()}:${rule.toLowerCase()}:${line}`,
      commit
    }, redact));
  }
  return { ok: true, candidates };
}

// Version order, good enough for advisories (semver-like): the release numbers compared as
// numbers (a missing one is 0), then a release is after its pre-releases (1.0.0 > 1.0.0-rc.1).
export function compareVersions(a, b) {
  const split = (v) => {
    const s = String(v || "").trim().replace(/^v/i, "").split("+")[0];
    const i = s.indexOf("-");
    return { rel: (i < 0 ? s : s.slice(0, i)).split("."), pre: i < 0 ? null : s.slice(i + 1).split(".") };
  };
  const cmpIds = (p, q) => {
    const np = /^\d+$/.test(p);
    const nq = /^\d+$/.test(q);
    if (np && nq) return Math.sign(Number(p) - Number(q));
    if (np !== nq) return np ? -1 : 1;
    return p === q ? 0 : p < q ? -1 : 1;
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.rel.length, y.rel.length); i++) {
    const d = cmpIds(x.rel[i] ?? "0", y.rel[i] ?? "0");
    if (d) return d;
  }
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const d = cmpIds(x.pre[i], y.pre[i]);
    if (d) return d;
  }
  return 0;
}

// A breaking upgrade: the major number goes up (for 0.x, the minor does).
export function isMajorUpgrade(from, to) {
  const n = (v) => String(v || "").replace(/^v/i, "").split(".").map((s) => Number.parseInt(s, 10));
  const [a0, a1] = n(from);
  const [b0, b1] = n(to);
  if (!Number.isFinite(a0) || !Number.isFinite(b0)) return true;
  if (b0 !== a0) return b0 > a0;
  return a0 === 0 && Number.isFinite(a1) && Number.isFinite(b1) && b1 > a1;
}

// The version that fixes every advisory of a package: for each advisory the first fixed version
// after the installed one, then the highest of those. null when any advisory has none.
function fixedVersionFor(vulns, pkg) {
  let need = null;
  for (const v of vulns) {
    const fixes = [];
    for (const a of Array.isArray(v && v.affected) ? v.affected : []) {
      const ap = a && a.package;
      if (ap && ap.name && String(ap.name).toLowerCase() !== String(pkg.name).toLowerCase()) continue;
      for (const r of Array.isArray(a.ranges) ? a.ranges : []) {
        for (const e of Array.isArray(r && r.events) ? r.events : []) {
          if (e && e.fixed && compareVersions(e.fixed, pkg.version) > 0) fixes.push(String(e.fixed));
        }
      }
    }
    if (!fixes.length) return null;
    const first = fixes.sort(compareVersions)[0];
    if (!need || compareVersions(first, need) > 0) need = first;
  }
  return need;
}

// osv-scanner's JSON (v2): one candidate per vulnerable package, its severity from the highest
// CVSS score of its advisory groups, the version that fixes them all when one is published.
export function parseOsvScanner(stdout, redact) {
  let data;
  try { data = JSON.parse(String(stdout || "")); } catch { return { ok: false, candidates: [], packages: 0 }; }
  if (!data || typeof data !== "object" || !Array.isArray(data.results)) return { ok: false, candidates: [], packages: 0 };
  const candidates = [];
  let packages = 0;
  for (const res of data.results) {
    const file = String((res && res.source && res.source.path) || "").replace(/\\/g, "/").replace(/^\/src\//, "").replace(/^\/src$/, "");
    for (const p of Array.isArray(res && res.packages) ? res.packages : []) {
      packages++;
      const pk = (p && p.package) || {};
      const vulns = Array.isArray(p.vulnerabilities) ? p.vulnerabilities.filter((v) => v && typeof v === "object") : [];
      if (!pk.name || !vulns.length) continue;
      const ids = vulns.map((v) => String(v.id || "")).filter(Boolean);
      const scores = (Array.isArray(p.groups) ? p.groups : []).map((g) => Number.parseFloat(g && g.max_severity)).filter(Number.isFinite);
      const severity = scores.length ? severityFromCvss(Math.max(...scores)) : "medium";
      const cwe = vulns.map((v) => v.database_specific && Array.isArray(v.database_specific.cwe_ids) ? v.database_specific.cwe_ids[0] : null).find(Boolean) || null;
      const cvss = vulns.flatMap((v) => (Array.isArray(v.severity) ? v.severity : [])).map((s) => s && s.score).find((s) => typeof s === "string" && s) || null;
      const fixed = pk.version ? fixedVersionFor(vulns, pk) : null;
      const major = !!fixed && isMajorUpgrade(pk.version, fixed);
      const eco = String(pk.ecosystem || "unknown");
      candidates.push(candidate({
        title: advisoryTitle({ name: pk.name, version: pk.version || null, count: ids.length || vulns.length, fixedVersion: fixed, noFix: !fixed }),
        category: "deps", severity, cwe, cvss, fixedVersion: fixed,
        confidence: 8, file: file || "(package files)", line: 0,
        evidence: `osv-scanner: ${pk.name} ${pk.version || "?"} (${eco}) has ${ids.length} advisor${ids.length === 1 ? "y" : "ies"}: ${ids.slice(0, 5).join(", ")}${ids.length > 5 ? ", ..." : ""}`,
        impact: "A dependency version with a known vulnerability is installed.",
        fix: fixed ? `Upgrade ${pk.name} to ${fixed} or later${major ? " (a major upgrade: its breaking changes need the owner's review)" : " (no major upgrade needed)"}.` : `No version of ${pk.name} that fixes every advisory is published yet; track them.`,
        testIdea: "osv-scanner reports no advisory for this package.",
        autoFixSafe: !!fixed && !major,
        ownerAction: !fixed ? `No fixed version of ${pk.name} covers every advisory yet: replace it, or accept the risk until one does.` : major ? `A major upgrade of ${pk.name} fixes it: review its breaking changes and upgrade, or accept the risk.` : null,
        anchor: `pkg:${eco.toLowerCase()}:${String(pk.name).toLowerCase()}`
      }, redact));
    }
  }
  return { ok: true, candidates, packages };
}

// Runs gitleaks from its image. { ok, candidates, examined, reason }.
export async function runGitleaks({ run, root, env, redact, docker }) {
  if (!docker || !docker.ok) return { ok: false, candidates: [], reason: (docker && docker.reason) || "Docker is not available" };
  const args = gitleaksArgs(root);
  if (!args) return { ok: false, candidates: [], reason: "the project path cannot be mounted (it holds a quote or a line break)" };
  const r = await Promise.resolve(run("docker", args, { cwd: root, env, timeoutMs: EXTERNAL_TIMEOUT_MS })).catch((e) => ({ ok: false, stderr: String(e && e.message || e) }));
  if (r.timedOut) return { ok: false, candidates: [], reason: `it did not finish in ${EXTERNAL_TIMEOUT_MS / 60000} min` };
  const parsed = parseGitleaks(r.stdout, redact);
  if (!r.ok || !parsed.ok) return { ok: false, candidates: [], reason: `it did not run (${redact(firstLine(r.stderr) || `exit code ${r.code}`).slice(0, 200)})` };
  return { ok: true, candidates: parsed.candidates, examined: `git history with gitleaks (${GITLEAKS_IMAGE}, project mounted read-only, no network)` };
}

// Runs osv-scanner from its image. { ok, candidates, examined, reason }.
export async function runOsvScanner({ run, root, env, redact, docker }) {
  if (!docker || !docker.ok) return { ok: false, candidates: [], reason: (docker && docker.reason) || "Docker is not available" };
  const args = osvScannerArgs(root);
  if (!args) return { ok: false, candidates: [], reason: "the project path cannot be mounted (it holds a quote or a line break)" };
  const r = await Promise.resolve(run("docker", args, { cwd: root, env, timeoutMs: EXTERNAL_TIMEOUT_MS })).catch((e) => ({ ok: false, stderr: String(e && e.message || e) }));
  if (r.timedOut) return { ok: false, candidates: [], reason: `it did not finish in ${EXTERNAL_TIMEOUT_MS / 60000} min` };
  if (r.code === 128) return { ok: true, candidates: [], examined: `advisories with osv-scanner (${OSV_SCANNER_IMAGE}): no package file it knows` };
  const parsed = parseOsvScanner(r.stdout, redact);
  if (!parsed.ok || !(r.ok || r.code === 1)) return { ok: false, candidates: [], reason: `it did not run (${redact(firstLine(r.stderr) || `exit code ${r.code}`).slice(0, 200)})` };
  return { ok: true, candidates: parsed.candidates, examined: `advisories with osv-scanner (${OSV_SCANNER_IMAGE}, ${parsed.packages} package${parsed.packages === 1 ? "" : "s"}, project mounted read-only)` };
}

// ---------- orchestration ----------

// Runs the deterministic security scanners the options turn on, writes each raw result to
// sweepDir/scanners/<name>.json (counts only, never a value), and returns the shared
// { candidates, coverage } shape. options.modules decides which run: "secrets" (secret scan of
// the tree and the history, gitleaks over the history, sensitive files, .gitignore) and "deps"
// (advisories when options.advisories: npm audit, osv-scanner, else the OSV service for other
// lockfiles; lockfile hygiene). An undefined modules list runs all of them.
export async function runSecurityScanners({ root, env = process.env, options = {}, sweepDir, run = defaultRun, fetchImpl = globalThis.fetch, redact: injectedRedact = null } = {}) {
  const redact = await resolveRedact(injectedRedact);
  const modules = Array.isArray(options.modules) ? options.modules : ["secrets", "deps", "config", "live"];
  const wants = (m) => modules.includes(m);
  const exclude = Array.isArray(options.exclude) ? options.exclude : [];
  const scannersDir = sweepDir ? path.join(sweepDir, "scanners") : null;
  if (scannersDir) ensureDir(scannersDir);
  const writeRaw = (name, obj) => { if (scannersDir) try { writeJsonAtomic(path.join(scannersDir, `${name}.json`), obj); } catch {} };

  const candidates = [];
  const examined = [];
  const notExamined = [];
  // Asked once, and only when a module needs an image.
  let docker = null;
  const dockerNow = async () => (docker ??= await dockerStatus({ run, env }));

  // secrets: working tree, history, sensitive files, .gitignore
  if (wants("secrets")) {
    const files = await listWorkingFiles(run, root, env);
    const tracked = await listTrackedFiles(run, root, env);
    if (files === null) {
      notExamined.push("secret scan of the working tree (not a git repository or git is unavailable)");
      writeRaw("secrets-tree", { error: "git ls-files failed" });
    } else {
      const tree = scanTree({ root, files, exclude, redact });
      candidates.push(...tree.candidates);
      examined.push(`working tree (${tree.scanned} text file${tree.scanned === 1 ? "" : "s"})`);
      writeRaw("secrets-tree", { scanned: tree.scanned, hits: tree.candidates.length });
    }
    const hist = await scanHistory({ run, root, env, redact });
    if (hist.examined) examined.push(hist.examined); else notExamined.push(hist.note);
    writeRaw("secrets-history", { examined: hist.examined, note: hist.note, hits: hist.candidates.length });

    // gitleaks over the history; a commit and file it reports are not reported twice.
    const gl = await runGitleaks({ run, root, env, redact, docker: await dockerNow() });
    if (gl.ok) {
      candidates.push(...gl.candidates);
      examined.push(gl.examined);
      const seen = new Set(gl.candidates.filter((c) => c.commit).map((c) => `${c.commit}|${c.file}`));
      candidates.push(...hist.candidates.filter((c) => !(c.commit && seen.has(`${String(c.commit).toLowerCase()}|${c.file}`))));
    } else {
      candidates.push(...hist.candidates);
      notExamined.push(`gitleaks over the git history (not checked: ${gl.reason})`);
    }
    writeRaw("gitleaks", { image: GITLEAKS_IMAGE, ran: gl.ok, hits: gl.candidates.length, reason: gl.ok ? null : gl.reason });

    const sens = scanSensitiveAndGitignore({ root, tracked: tracked || [], redact });
    candidates.push(...sens.candidates);
    examined.push("tracked sensitive files and .gitignore coverage");
    writeRaw("sensitive-files", { hits: sens.candidates.length });
  }

  // deps: advisories (behind options.advisories) and lockfile hygiene
  if (wants("deps")) {
    const present = LOCKFILES.filter((l) => { try { return fs.existsSync(path.join(root, l.file)); } catch { return false; } });
    if (!present.length) {
      notExamined.push("package advisories (no lockfile found)");
    } else if (options.advisories === false) {
      for (const l of present) notExamined.push(`package advisories for ${l.file} (switched off: sweep.advisories is false)`);
      notExamined.push("osv-scanner (not checked: switched off with the advisories, sweep.advisories is false)");
    } else {
      // osv-scanner reads every lockfile format; when it ran, the OSV batch query below is not
      // needed. npm audit still runs: its answer says whether a fix stays inside the allowed
      // ranges. The two meet on one package anchor, so a package is reported once.
      const osv = await runOsvScanner({ run, root, env, redact, docker: await dockerNow() });
      if (osv.ok) { candidates.push(...osv.candidates); examined.push(osv.examined); }
      else notExamined.push(`osv-scanner (not checked: ${osv.reason})`);
      writeRaw("osv-scanner", { image: OSV_SCANNER_IMAGE, ran: osv.ok, hits: osv.candidates.length, reason: osv.ok ? null : osv.reason });
      for (const l of present) {
        if (!l.npm && osv.ok) continue;
        if (l.npm) {
          const r = await run("npm", ["audit", "--json", "--package-lock-only"], { cwd: root, env, timeoutMs: 120000 });
          let lock = null;
          try { lock = JSON.parse(fs.readFileSync(path.join(root, l.file), "utf8")); } catch {}
          const parsed = parseNpmAudit(r.stdout, redact, { lock });
          if (parsed.ok) { candidates.push(...parsed.candidates); examined.push(`npm advisories (${l.file})`); }
          else notExamined.push(`npm advisories for ${l.file} (npm audit output could not be read)`);
          writeRaw(`advisories-${l.file.replace(/[^A-Za-z0-9.]/g, "_")}`, { ok: parsed.ok, hits: parsed.candidates.length });
        } else {
          let text; try { text = fs.readFileSync(path.join(root, l.file), "utf8"); } catch { text = ""; }
          const pkgs = parseLockfilePackages(l.file, text);
          if (!pkgs.length) { notExamined.push(`advisories for ${l.file} (needs an external scanner for this lockfile format)`); continue; }
          const batch = await scanOsv({ fetchImpl, ecosystem: l.ecosystem, packages: pkgs, file: l.file, redact });
          if (batch.error) notExamined.push(`OSV advisories for ${l.file} (query failed: ${batch.error})`);
          else { candidates.push(...batch.candidates); examined.push(`OSV advisories (${l.file}, ${batch.queried} package${batch.queried === 1 ? "" : "s"})`); }
          writeRaw(`advisories-${l.file.replace(/[^A-Za-z0-9.]/g, "_")}`, { queried: batch.queried || 0, hits: batch.candidates.length, error: batch.error || null });
        }
      }
    }
    const hyg = scanLockfileHygiene({ root, redact });
    candidates.push(...hyg.candidates);
    examined.push(...hyg.examined);
    if (hyg.examined.length) writeRaw("lockfile-hygiene", { hits: hyg.candidates.length });
  }

  const uniq = (a) => [...new Set(a)];
  return { candidates, coverage: { examined: uniq(examined), notExamined: uniq(notExamined) } };
}
