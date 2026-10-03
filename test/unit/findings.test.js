import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FINDING_SCHEMA, CANDIDATES_SCHEMA, VERDICT_SCHEMA, SEVERITIES, ACCEPTED_FILE, FINDINGS_SCHEMA_VERSION,
  redact, redactDeep, maskValue, fingerprint, normalizeFinding, dedupe, numberFindings, sortFindings, countBySeverity,
  gateSeverity, areaOf, loadAccepted, readAccepted, saveAccepted, applyAccepted, writeReport
} from "../../plugins/autoclaude/lib/findings.js";

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-findings-"));
// Built from parts so this file never holds a whole token-shaped string.
const GH = "ghp_" + "Ab1Cd2Ef3Gh4Ij5Kl6Mn7Op8Qr9St0Uv1Wx2";
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const STRIPE = "sk_" + "live_" + "4eC39HqLyjWDarjtT1zdp7dc";
const RANDOM = "Xk9pQ2mL7vR4tY8wZ1nB5cH3jF6gD0sA";

// ---------- schemas ----------

test("the schemas: one finding with every agreed field, candidates without id and fingerprint, a verdict", () => {
  for (const k of ["id", "kind", "category", "severity", "cwe", "cvss", "fixedVersion", "confidence", "file", "line", "evidence", "impact", "fix", "testIdea", "tier", "autoFixSafe", "fingerprint"]) {
    assert.ok(FINDING_SCHEMA.properties[k], `missing property ${k}`);
    assert.ok(FINDING_SCHEMA.required.includes(k), `${k} is not required`);
  }
  assert.deepEqual(FINDING_SCHEMA.properties.severity.enum, ["critical", "high", "medium", "low"]);
  assert.deepEqual(SEVERITIES, ["critical", "high", "medium", "low"]);
  assert.deepEqual(FINDING_SCHEMA.properties.tier.enum, ["A", "B", "C"]);
  const item = CANDIDATES_SCHEMA.properties.findings.items;
  assert.equal(item.properties.id, undefined);
  assert.equal(item.properties.fingerprint, undefined);
  assert.ok(item.required.includes("reproduce") && item.required.includes("title"), "the report needs a title and how to reproduce");
  assert.deepEqual(CANDIDATES_SCHEMA.required, ["findings", "coverage", "notes"]);
  assert.deepEqual(CANDIDATES_SCHEMA.properties.coverage.required, ["examined", "notExamined"]);
  assert.deepEqual(VERDICT_SCHEMA.properties.verdict.enum, ["confirmed", "refuted", "uncertain"]);
  assert.deepEqual(VERDICT_SCHEMA.required, ["verdict", "reason", "severity"]);
  // Structured output takes plain types only: no unions, no numeric bounds.
  const walk = (s) => {
    if (!s || typeof s !== "object") return;
    assert.ok(!Array.isArray(s.type), "no type unions");
    assert.equal(s.minimum, undefined);
    assert.equal(s.maximum, undefined);
    for (const v of Object.values(s.properties || {})) walk(v);
    if (s.items) walk(s.items);
  };
  [FINDING_SCHEMA, CANDIDATES_SCHEMA, VERDICT_SCHEMA].forEach(walk);
});

// ---------- masking ----------

test("redact masks keys, tokens, passwords and connection strings to a 4-character prefix and the length", () => {
  assert.equal(maskValue(GH), `ghp_[redacted, ${GH.length} chars]`);
  assert.equal(maskValue("hunter2"), "[redacted, 7 chars]", "a short value shows nothing");
  assert.equal(maskValue("abcdefghij"), "ab[redacted, 10 chars]");
  const cases = [
    [`const key = '${AWS}';`, AWS],
    [`token ${GH} in the log`, GH],
    [`export API_KEY=${STRIPE}`, STRIPE],
    ["DB_PASSWORD=hunter2", "hunter2"],
    ['{ "password": "s3cr3t-value", "user": "bob" }', "s3cr3t-value"],
    ["password = 'Tr0ub4dor&3'", "Tr0ub4dor&3"],
    ["  POSTGRES_PASSWORD: Pa55w0rd!", "Pa55w0rd!"],
    ["postgres://app:Sup3rS3cret@db.local:5432/app", "Sup3rS3cret"],
    ["Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789", "abcdefghijklmnopqrstuvwxyz0123456789"],
    ["GET /api/items?token=abc123def456&page=2", "abc123def456"],
    ["app --password hunter22 --verbose", "hunter22"],
    [`value ${RANDOM} here`, RANDOM],
    ["eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U", "dozjgNryP4J3jVmNHl0w5N"],
    ["https://discord.com/api/webhooks/123456789012345678/abcdefghijklmnopqrstuvwxyzABCDEFGHIJ", "abcdefghijklmnopqrstuvwxyzABCDEFGHIJ"]
  ];
  for (const [input, secret] of cases) {
    const out = redact(input);
    assert.ok(!out.includes(secret), `${input} -> ${out}`);
    assert.match(out, /\[redacted, \d+ chars\]/, input);
    assert.equal(redact(out), out, `idempotent: ${out}`);
  }
  assert.match(redact("postgres://app:Sup3rS3cret@db.local:5432/app"), /^postgres:\/\/app:Su\[redacted, 11 chars\]@db\.local:5432\/app$/, "user and host stay readable");
  assert.equal(redact(`k = '${AWS}'`), "k = 'AKIA[redacted, 20 chars]'");
});

test("redact masks private key blocks, whole or cut off", () => {
  const block = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA1234567890abcdefghij\nqwertyuiop\n-----END RSA PRIVATE KEY-----";
  const out = redact(block);
  assert.ok(!out.includes("1234567890abcdefghij") && !out.includes("qwertyuiop"), out);
  assert.match(out, /^-----BEGIN RSA PRIVATE KEY-----\nMIIE\[redacted, \d+ chars\]\n-----END RSA PRIVATE KEY-----$/);
  assert.equal(redact(out), out);
  const cut = redact("see:\n-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQ");
  assert.ok(!cut.includes("ADANBgkqhkiG9w0"), cut);
});

test("redact leaves code that only reads a secret, placeholders, prose, paths and hashes alone", () => {
  for (const s of [
    "const password = req.body.password;",
    "password = process.env.DB_PASSWORD",
    "  apiKey: config.apiKey,",
    "password: ${DB_PASSWORD}",
    "postgres://app:${PGPASSWORD}@db/app",
    "secret: 'your-secret-here'",
    "  POSTGRES_PASSWORD: example",
    "API_KEY = os.environ[\"API_KEY\"]",
    "The password is stored in plain text in the users table.",
    "src/components/SomeLongComponentName2/index.js line 12",
    "commit 3b63c3b0f1e2d3c4b5a69788f9e0d1c2b3a4f5e6",
    "a task-management-system-for-everyone note"
  ]) assert.equal(redact(s), s, s);
  assert.equal(redact(null), null);
  assert.equal(redact(undefined), undefined);
});

test("redact stays fast on huge single-line text, and a long field is masked before it is cut", () => {
  const blob = "QUJD".repeat(50000) + " password='hunter22'";
  const started = Date.now();
  const out = redact(blob);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.ok(!out.includes("hunter22"));
  const longLetters = "a".repeat(100000);
  const t2 = Date.now();
  redact(`${longLetters} ${longLetters}`);
  assert.ok(Date.now() - t2 < 3000, `letters took ${Date.now() - t2} ms`);
  // The evidence limit falls inside a token: the token is masked whole, then the text is cut.
  const f = normalizeFinding({ category: "secrets", file: "a.js", evidence: `${"x ".repeat(995)}k = '${GH}' ${"y ".repeat(500)}` }, { kind: "security" });
  assert.ok(!f.evidence.includes(GH.slice(0, 12)), f.evidence.slice(-80));
  assert.match(f.evidence, /\[\.\.\. cut\]$/);
});

test("redactDeep masks every string but fingerprints, ids and commits", () => {
  const out = redactDeep({ id: "SEC-001", fingerprint: "ab".repeat(10), commit: "c".repeat(40), list: [`token=${GH}`], n: 3, nested: { evidence: `DB_PASSWORD=hunter2` } });
  assert.equal(out.id, "SEC-001");
  assert.equal(out.commit, "c".repeat(40));
  assert.ok(!JSON.stringify(out).includes(GH));
  assert.equal(out.nested.evidence, "DB_PASSWORD=[redacted, 7 chars]");
  assert.equal(out.n, 3);
});

// ---------- normalizing, fingerprints, dedupe, numbering ----------

test("normalizeFinding: known values, masked text, relative files, null for empty, a fingerprint", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";
  const f = normalizeFinding({
    category: "Access Control", severity: "CRITICAL", cwe: "639", cvss: "", fixedVersion: "", confidence: 14, file: path.join(root, "src", "api", "lists.js"),
    line: "12", evidence: `const k = '${GH}'`, fix: "use process.env.KEY", autoFixSafe: true, tier: "C", source: "area:src/api"
  }, { kind: "security", root });
  assert.equal(f.kind, "security");
  assert.equal(f.category, "access-control");
  assert.equal(f.severity, "critical");
  assert.equal(f.cwe, "CWE-639");
  assert.equal(f.cvss, null);
  assert.equal(f.fixedVersion, null);
  assert.equal(f.confidence, 10);
  assert.equal(f.file, "src/api/lists.js");
  assert.equal(f.line, 12);
  assert.ok(!f.evidence.includes(GH));
  assert.equal(f.tier, "A", "every security finding is tier A");
  assert.equal(f.autoFixSafe, true);
  assert.equal(f.ownerAction, null);
  assert.equal(f.source, "area:src/api", "extra fields the sweep adds are kept");
  assert.match(f.fingerprint, /^[0-9a-f]{20}$/);
  const o = normalizeFinding({ category: "unused-code", severity: "whatever", tier: "b" }, { kind: "optimize" });
  assert.deepEqual([o.kind, o.severity, o.tier, o.autoFixSafe, o.line, o.confidence], ["optimize", "medium", "B", false, 0, 5]);
  assert.equal(normalizeFinding({ category: "x", tier: "Z" }, { kind: "optimize" }).tier, "C", "an unknown optimize tier is the owner's");
});

test("fingerprint: category, file and the normalized evidence; line numbers and whitespace do not matter", () => {
  const a = { category: "injection", file: "src/db.js", line: 12, evidence: "12: db.query('SELECT ' + q)\n" };
  const b = { category: "Injection", file: "./src\\db.js", line: 40, evidence: "  db.query('SELECT '   + q)  " };
  assert.equal(fingerprint(a), fingerprint(b));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, file: "src/other.js" }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, category: "xss" }));
  assert.notEqual(fingerprint(a), fingerprint({ ...a, evidence: "db.query(sql, [q])" }));
  // A secret's value never decides the fingerprint differently from its masked form.
  assert.equal(fingerprint({ category: "secrets", file: "a.js", evidence: `k = '${GH}'` }), fingerprint({ category: "secrets", file: "a.js", evidence: redact(`k = '${GH}'`) }));
  // Nothing about the finding can be read back from it.
  assert.match(fingerprint(a), /^[0-9a-f]{20}$/);
  assert.ok(!fingerprint(a).includes("db"));
});

test("dedupe merges the same finding from two sources, and near lines of one category in one file", () => {
  const base = { kind: "security", category: "xss", file: "src/view.js", line: 10, evidence: "el.innerHTML = name", severity: "medium", confidence: 6, source: "area:src" };
  const list = dedupe([
    base,
    { ...base, line: 12, severity: "high", confidence: 7, evidence: "el.innerHTML = name;", source: "browser" },
    { ...base, line: 40, evidence: "other.innerHTML = x", source: "area:src" },
    { ...base, category: "csrf", line: 11, evidence: "form without token", source: "area:src" },
    { ...base, kind: "optimize", category: "xss", line: 10, source: "x" },
    null
  ]);
  assert.equal(list.length, 4);
  const merged = list.find((f) => f.category === "xss" && f.line === 12);
  assert.ok(merged, JSON.stringify(list));
  assert.equal(merged.severity, "high", "the stronger report is kept");
  assert.equal(merged.confidence, 7);
  assert.deepEqual(merged.sources.sort(), ["area:src", "browser"]);
  assert.ok(list.every((f) => typeof f.fingerprint === "string"));
});

test("dedupe with a kind normalizes raw candidates first: masked, relative files, the sweep's kind filled in", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";
  const raw = [
    { category: "Unused Code", severity: "LOW", file: path.join(root, "src", "a.js"), line: 3, evidence: `old = '${GH}'`, tier: "a", source: "knip" },
    { category: "unused-code", severity: "medium", file: "src/a.js", line: 4, evidence: "old = 1", tier: "A", source: "area:src" }
  ];
  const list = dedupe(raw, { kind: "optimize", root });
  assert.equal(list.length, 1);
  assert.deepEqual([list[0].kind, list[0].category, list[0].file, list[0].tier, list[0].severity], ["optimize", "unused-code", "src/a.js", "A", "medium"]);
  assert.deepEqual(list[0].sources.sort(), ["area:src", "knip"]);
  assert.ok(!JSON.stringify(list).includes(GH));
  // Without a kind the findings are kept as they came (only a fingerprint is added).
  assert.equal(dedupe([raw[0]])[0].category, "Unused Code");
});

test("numberFindings: SEC- or OPT- ids in report order, most severe first; counts and gateSeverity", () => {
  const list = [
    { severity: "low", file: "a.js", confidence: 9 },
    { severity: "critical", file: "b.js", confidence: 5 },
    { severity: "high", file: "c.js", confidence: 8 },
    { severity: "high", file: "d.js", confidence: 9 }
  ];
  const sec = numberFindings(list, "security");
  assert.deepEqual(sec.map((f) => [f.id, f.file]), [["SEC-001", "b.js"], ["SEC-002", "d.js"], ["SEC-003", "c.js"], ["SEC-004", "a.js"]]);
  assert.deepEqual(numberFindings(list, "optimize", { start: 7 }).map((f) => f.id), ["OPT-007", "OPT-008", "OPT-009", "OPT-010"]);
  assert.deepEqual(sortFindings(list).map((f) => f.file), ["b.js", "d.js", "c.js", "a.js"]);
  assert.deepEqual(countBySeverity(list), { critical: 1, high: 2, medium: 0, low: 1, total: 4 });
  assert.deepEqual(["critical", "high", "medium", "low", "bogus"].map(gateSeverity), ["high", "high", "medium", "low", "medium"]);
});

test("areaOf: the session's area, else the first folder or two under a container folder", () => {
  assert.equal(areaOf({ area: "login and sessions", file: "src/a.js" }), "login and sessions");
  assert.equal(areaOf({ file: "src/auth/login.js" }), "src/auth");
  assert.equal(areaOf({ file: "src\\auth\\deep\\x.js" }), "src/auth");
  assert.equal(areaOf({ file: "docker/web/Dockerfile" }), "docker");
  assert.equal(areaOf({ file: "src/index.js" }), "src");
  assert.equal(areaOf({ file: "package.json" }), "project root");
  assert.equal(areaOf({}), "project root");
});

// ---------- accepted risks and false alarms ----------

test("the accepted list: fingerprints and reasons only, committed at the project root", () => {
  const root = tmpDir();
  assert.deepEqual(readAccepted(root), { exists: false, list: [], error: null });
  const fp = "0123456789abcdef0123";
  const file = saveAccepted(root, [
    { fingerprint: fp, kind: "security", reason: `test value, not real (${GH})`, by: "Scott", date: "2026-10-02", title: "leaks the title", evidence: "secret evidence", file: "src/x.js" },
    { fingerprint: "not-hex!", kind: "security", reason: "dropped" },
    { fingerprint: fp, kind: "optimize", reason: "kept for later" },
    { fingerprint: fp, kind: "security", reason: "false alarm: the route is admin-only", by: "Scott", date: "2026-10-03" }
  ], { now: new Date("2026-10-04T12:00:00Z") });
  assert.equal(file, path.join(root, ACCEPTED_FILE));
  const raw = fs.readFileSync(file, "utf8");
  assert.ok(raw.endsWith("\n") && !raw.includes("\r"));
  const saved = JSON.parse(raw);
  assert.ok(Array.isArray(saved));
  assert.deepEqual(saved, [
    { fingerprint: fp, kind: "optimize", reason: "kept for later", by: "owner", date: "2026-10-04" },
    { fingerprint: fp, kind: "security", reason: "false alarm: the route is admin-only", by: "Scott", date: "2026-10-03" }
  ]);
  for (const leak of ["leaks the title", "secret evidence", "src/x.js", GH]) assert.ok(!raw.includes(leak), leak);
  assert.deepEqual(loadAccepted(root), saved);
  // A reason that quotes a secret is masked.
  saveAccepted(root, [{ fingerprint: fp, kind: "security", reason: `rotated ${GH}` }]);
  assert.ok(!fs.readFileSync(file, "utf8").includes(GH));
  // A broken file: nothing accepted (the findings come back), never a throw.
  fs.writeFileSync(file, "{ broken");
  const broken = readAccepted(root);
  assert.deepEqual(broken.list, []);
  assert.match(broken.error, /not valid JSON/);
  fs.writeFileSync(file, JSON.stringify({ not: "an array" }));
  assert.match(readAccepted(root).error, /JSON array/);
});

test("applyAccepted splits off the findings the owner accepted, by fingerprint and kind", () => {
  const a = normalizeFinding({ category: "headers", file: "server.js", evidence: "no CSP" }, { kind: "security" });
  const b = normalizeFinding({ category: "xss", file: "view.js", evidence: "innerHTML" }, { kind: "security" });
  const c = normalizeFinding({ category: "headers", file: "server.js", evidence: "no CSP" }, { kind: "optimize" });
  const r = applyAccepted([a, b, c], [{ fingerprint: a.fingerprint, kind: "security", reason: "behind the proxy", by: "Scott", date: "2026-10-02" }]);
  assert.deepEqual(r.kept.map((f) => f.category + ":" + f.kind), ["xss:security", "headers:optimize"]);
  assert.equal(r.accepted.length, 1);
  assert.deepEqual(r.accepted[0].accepted, { reason: "behind the proxy", by: "Scott", date: "2026-10-02" });
  // An entry without a kind matches either sweep.
  assert.equal(applyAccepted([a, c], [{ fingerprint: a.fingerprint, reason: "x" }]).accepted.length, 2);
});

// ---------- fingerprints that last from one sweep to the next ----------

const ROUTES_V1 = [
  "import { db } from \"./db.js\";",
  "",
  "app.get(\"/search\", (req, res) => {",
  "  const q = req.query.q;",
  "  const rows = db.query(`SELECT * FROM todos WHERE title LIKE '%${q}%'`);",
  "",
  "  res.json(rows);",
  "});",
  "",
  "export function listAll(req, res) {",
  "  const rows = db.query(`SELECT * FROM todos WHERE title LIKE '%${q}%'`);",
  "  res.json(rows);",
  "}",
  ""
].join("\n");

test("a session's finding keeps its fingerprint in the next sweep: reworded, another span quoted, code moved down", () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "src"));
  const file = path.join(root, "src", "routes.js");
  fs.writeFileSync(file, ROUTES_V1);
  // Sweep 1: the reviewer points at line 5 and quotes the route with it.
  const first = dedupe([{ category: "injection", title: "SQL injection in the search route", severity: "high", file: "src/routes.js", line: 5,
    evidence: "app.get(\"/search\", ...)\n  const rows = db.query(`SELECT * FROM todos WHERE title LIKE '%${q}%'`);", source: "session area-src" }], { kind: "security", root });
  assert.equal(first.length, 1);
  saveAccepted(root, [{ fingerprint: first[0].fingerprint, kind: "security", reason: "false alarm: q is an enum" }]);

  // The code moves down three lines (a new import and a comment), and CRLF line endings.
  fs.writeFileSync(file, ["import { log } from \"./log.js\";", "// search", "", ROUTES_V1].join("\n").replace(/\n/g, "\r\n"));
  // Sweep 2: another session words it differently, quotes only the query, and its line is one
  // off, on the blank line under the query.
  const second = dedupe([{ category: "injection", title: "User input reaches the database unescaped", severity: "critical", file: "src/routes.js", line: 9,
    evidence: "8: db.query(`SELECT * FROM todos WHERE title LIKE '%${q}%'`)", source: "session area-api" }], { kind: "security", root });
  assert.equal(second[0].fingerprint, first[0].fingerprint, "the same code in the same function: the same fingerprint");
  const r = applyAccepted(second, loadAccepted(root));
  assert.equal(r.accepted.length, 1, "the accepted finding is listed as accepted, not reported again");
  assert.equal(r.kept.length, 0);

  // The same line in another function is another finding, and so is another category.
  const other = normalizeFinding({ category: "injection", file: "src/routes.js", line: 14, evidence: "db.query(...)" }, { kind: "security", root });
  assert.notEqual(other.fingerprint, first[0].fingerprint);
  assert.notEqual(normalizeFinding({ category: "xss", file: "src/routes.js", line: 8, evidence: "x" }, { kind: "security", root }).fingerprint, first[0].fingerprint);
  // A finding with no line is anchored by the evidence line it quotes, when that line is in the file.
  assert.equal(normalizeFinding({ category: "injection", file: "src/routes.js", line: 0, evidence: "const rows = db.query(`SELECT * FROM todos WHERE title LIKE '%${q}%'`);" }, { kind: "security", root }).fingerprint,
    first[0].fingerprint, "the first copy of the line in the file, in the search route");
  // Without the project to read, the evidence decides, as before.
  assert.notEqual(fingerprint({ category: "injection", file: "src/routes.js", evidence: "a" }), fingerprint({ category: "injection", file: "src/routes.js", evidence: "b" }));
  // A path outside the project is never read.
  const outside = normalizeFinding({ category: "injection", file: "../../etc/passwd", line: 1, evidence: "x" }, { kind: "security", root });
  assert.equal(outside.fingerprint, fingerprint({ category: "injection", file: "../../etc/passwd", line: 1, evidence: "x" }));
});

test("a scanner's anchor decides its fingerprint; a session cannot set one; dedupe keeps every member's fingerprint", () => {
  const root = tmpDir();
  fs.writeFileSync(path.join(root, "server.js"), "const app = express();\napp.listen(3000);\n");
  const s1 = normalizeFinding({ category: "deps", file: "package-lock.json", anchor: "pkg:npm:lodash", evidence: "npm advisory for lodash (<4.17.21): Prototype pollution", source: "scanner security" }, { kind: "security", root });
  const s2 = normalizeFinding({ category: "deps", file: "package-lock.json", anchor: "pkg:npm:lodash", evidence: "osv-scanner: lodash 4.17.20 (npm): GHSA-1, GHSA-2", source: "scanner security" }, { kind: "security", root });
  assert.equal(s1.fingerprint, s2.fingerprint, "two scanners, one package: one fingerprint");
  const sessionAnchor = normalizeFinding({ category: "deps", file: "package-lock.json", anchor: "pkg:npm:lodash", evidence: "lodash is old", source: "session area-src" }, { kind: "security", root });
  assert.notEqual(sessionAnchor.fingerprint, s1.fingerprint, "an anchor a session wrote is not trusted");

  // A scanner hit and a stronger session report of the same thing merge; both fingerprints stay.
  const scanner = { category: "headers", file: "server.js", line: 1, anchor: "header:csp", evidence: "no Content-Security-Policy header", severity: "medium", confidence: 8, source: "scanner probe" };
  const session = { category: "headers", file: "server.js", line: 2, evidence: "app has no helmet()", severity: "high", confidence: 9, source: "session area-src" };
  const merged = dedupe([scanner, session], { kind: "security", root });
  assert.equal(merged.length, 1);
  const scannerFp = normalizeFinding(scanner, { kind: "security", root }).fingerprint;
  assert.equal(merged[0].severity, "high", "the session's report is the stronger one");
  assert.notEqual(merged[0].fingerprint, scannerFp);
  assert.ok(merged[0].fingerprints.includes(scannerFp) && merged[0].fingerprints[0] === merged[0].fingerprint, JSON.stringify(merged[0].fingerprints));
  // Accepted through the scanner's fingerprint: still accepted although the session's is shown.
  assert.equal(applyAccepted(merged, [{ fingerprint: scannerFp, kind: "security", reason: "set by the proxy" }]).accepted.length, 1);
  // redactDeep leaves fingerprints and anchors alone; the report names every fingerprint.
  assert.deepEqual(redactDeep(merged[0]).fingerprints, merged[0].fingerprints);
  const dir = tmpDir();
  writeReport(dir, { kind: "security", confirmed: numberFindings(merged, "security") });
  assert.match(fs.readFileSync(path.join(dir, "report.md"), "utf8"), new RegExp(`Fingerprint \\| \`${merged[0].fingerprint}\` \\(also \`${scannerFp}\`\\)`));
});

// ---------- the report ----------

function sampleFindings() {
  const confirmed = numberFindings([
    { category: "injection", title: "Search builds SQL from the query string", severity: "critical", cwe: "CWE-89", confidence: 9, file: "src/api/search.js", line: 12,
      evidence: "db.query(`SELECT * FROM items WHERE name = '${q}'`)\n```nested fence```", impact: "Any visitor reads every table.", reproduce: "1. Open /search\n2. Type a quote",
      fix: "Use a parameter:\n\n```js\ndb.query('SELECT * FROM items WHERE name = $1', [q]);\n```", testIdea: "A search for a quote returns no rows.", autoFixSafe: true, votes: { confirmed: 3, refuted: 0, uncertain: 0 } },
    { category: "secrets", title: "A live key in the config", severity: "high", confidence: 10, file: "config/keys.js", line: 3, evidence: `const stripe = '${STRIPE}'`,
      impact: "Charges in the owner's name.", reproduce: "Read the file.", fix: "Move it to secrets/ and read it from the environment.", testIdea: "The file holds no key.", autoFixSafe: true, ownerAction: `Rotate ${STRIPE} at the provider` },
    { category: "dependencies", title: "An old library with an advisory", severity: "medium", cwe: "", cvss: "CVSS:3.1/AV:N/AC:L", fixedVersion: "4.17.21", confidence: 10, file: "package-lock.json", evidence: "lodash 4.17.15", impact: "x", reproduce: "npm audit", fix: "npm install lodash@4.17.21", testIdea: "-", autoFixSafe: true }
  ].map((f) => normalizeFinding(f, { kind: "security" })), "security");
  const uncertain = numberFindings([normalizeFinding({ category: "csrf", title: "A form may lack a token", severity: "low", file: "src/views/form.html", line: 5, evidence: "<form method=post>", verdicts: [{ verdict: "uncertain", reason: "depends on the framework default" }] }, { kind: "security" })], "security", { start: 4 });
  const refuted = [normalizeFinding({ category: "xss", title: "innerHTML with a constant", severity: "medium", file: "src/x.js", line: 2, evidence: "el.innerHTML = '<b>'", verdicts: [{ verdict: "refuted", reason: "the value is a constant" }] }, { kind: "security" })];
  const accepted = [{ ...normalizeFinding({ category: "headers", title: "No HSTS", severity: "low", file: "server.js" }, { kind: "security" }), accepted: { reason: "TLS ends at the proxy", by: "Scott", date: "2026-10-01" } }];
  return { confirmed, uncertain, refuted, accepted };
}

test("writeReport: report.md with the header, coverage, the severity table, findings in full, uncertain, accepted and refuted", () => {
  const dir = path.join(tmpDir(), "20261002-1430-security");
  const { confirmed, uncertain, refuted, accepted } = sampleFindings();
  const meta = {
    project: "todo-app", id: "20261002-1430-security", commit: "3b63c3b0f1e2d3c4b5a69788f9e0d1c2b3a4f5e6", dirty: true, depth: "thorough", startedAt: "2026-10-02T14:30:00Z", finishedAt: "2026-10-02T15:42:00Z",
    durationMs: 72 * 60000, sessions: 24, sessionsFailed: 1, model: "opus", effort: "xhigh", usageBefore: { fiveHour: { pct: 12 }, sevenDay: 30 }, usageAfter: { fiveHour: { pct: 48.4 }, sevenDay: 35 },
    costUsd: 12.345, targets: [{ url: "http://127.0.0.1:3000", mode: "full" }, { url: "https://u:Sup3rS3cret@staging.example.com", mode: "readonly" }], after: "fix", plan: "SECURITY_PLAN.md", next: "The fix run starts in this window."
  };
  const coverage = {
    examined: ["src/ (42 files)", "Dockerfile, compose.yaml"], notExamined: [{ what: "mobile/", why: "excluded by the owner" }],
    tools: [{ name: "secret scan (tree and history)", status: "ran", durationMs: 2100 }, { name: "OSV advisories", status: "skipped", reason: "sweep.advisories is off" }],
    areas: [{ name: "src/api", files: 12, status: "done" }]
  };
  const { reportFile, jsonFile } = writeReport(dir, { kind: "security", meta, confirmed, uncertain, refuted, accepted, coverage });
  assert.equal(reportFile, path.join(dir, "report.md"));
  assert.equal(jsonFile, path.join(dir, "findings.json"));
  const md = fs.readFileSync(reportFile, "utf8");
  for (const want of [
    /^# Security sweep report\n/, /Project: todo-app, sweep 20261002-1430-security/, /\| Commit \| 3b63c3b0f1e2 \(with uncommitted changes\) \|/, /\| Depth \| thorough \(every finding checked by 3 independent sessions/,
    /\| Duration \| 1 h 12 min/, /\| Sessions \| 24 \(1 failed\) \|/, /\| Model and effort \| opus, effort xhigh \|/, /\| 5-hour usage \| 12% before, 48% after \|/, /\| Weekly usage \| 30% before, 35% after \|/,
    /\| Cost at API prices \| \$12\.35 \|/, /\| After the sweep \| fix right away: SECURITY_PLAN\.md \|/,
    /Confirmed: 3 \(critical 1, high 1, medium 1, low 0\)\. Uncertain: 1\. Refuted: 1\. Accepted earlier: 1\./,
    /\| Category \| Critical \| High \| Medium \| Low \| Total \|/, /\| injection \| 1 \| 0 \| 0 \| 0 \| 1 \|/, /\| \*\*Total\*\* \| 1 \| 1 \| 1 \| 0 \| 3 \|/,
    /### Examined\n\n- src\/ \(42 files\)/, /### Not examined\n\n- mobile\/: excluded by the owner/, /\| OSV advisories \| skipped \| sweep\.advisories is off \|/, /\| secret scan \(tree and history\) \| ran \(2 s\) \|/,
    /not checked", never "clean"/,
    /### SEC-001 · critical · Search builds SQL from the query string/, /\| CWE \| CWE-89 \|/, /\| Where \| `src\/api\/search\.js:12` \|/, /\| Verification \| confirmed by 3 of 3 sessions \|/,
    /\*\*Impact\.\*\* Any visitor reads every table\./, /\*\*How to reproduce\.\*\*\n\n1\. Open \/search/, /\*\*Suggested fix\.\*\*\n\nUse a parameter:\n\n```js/, /\*\*Test idea\.\*\* A search for a quote/,
    /\| CVSS \| CVSS:3\.1\/AV:N\/AC:L \|/, /\| Fixed version \| 4\.17\.21 \|/, /\| Left for the owner \| Rotate sk_l\[redacted/,
    /## Uncertain[\s\S]*### SEC-004 · low · A form may lack a token[\s\S]*\| Fixed automatically \| no, it is not confirmed \|[\s\S]*\*\*Why it is uncertain\.\*\* depends on the framework default/,
    /## Accepted earlier[\s\S]*\| No HSTS \| low \| server\.js \| TLS ends at the proxy \| Scott \| 2026-10-01 \|/,
    /## Appendix: refuted[\s\S]*\| innerHTML with a constant \| xss \| src\/x\.js:2 \| the value is a constant \|/,
    /## Next\n\nThe fix run starts in this window\./
  ]) assert.match(md, want);
  // Most severe first; evidence holding ``` stays inside one longer fence.
  assert.ok(md.indexOf("SEC-001") < md.indexOf("SEC-002") && md.indexOf("SEC-002") < md.indexOf("SEC-003"));
  assert.match(md, /````\ndb\.query\(`SELECT[\s\S]*```nested fence```\n````/);
  assert.equal(md.includes("## Baseline"), false, "no baseline in a security report");
  // No secret value anywhere, in either file.
  const json = fs.readFileSync(jsonFile, "utf8");
  for (const text of [md, json]) {
    assert.ok(!text.includes(STRIPE), "the key is masked");
    assert.ok(!text.includes("Sup3rS3cret"), "the target's password is masked");
  }
});

test("writeReport: findings.json carries schemaVersion 1, counts and every list; an empty sweep says so", () => {
  const dir = tmpDir();
  const { confirmed, uncertain, refuted, accepted } = sampleFindings();
  writeReport(dir, { kind: "security", meta: { commit: "abc" }, confirmed, uncertain, refuted, accepted, coverage: { examined: ["src/"] } });
  const data = JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8"));
  assert.equal(data.schemaVersion, FINDINGS_SCHEMA_VERSION);
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.kind, "security");
  assert.deepEqual(data.counts, { confirmed: { critical: 1, high: 1, medium: 1, low: 0, total: 3 }, uncertain: 1, refuted: 1, accepted: 1 });
  assert.deepEqual(data.confirmed.map((f) => f.id), ["SEC-001", "SEC-002", "SEC-003"]);
  assert.equal(data.uncertain[0].id, "SEC-004");
  assert.equal(data.meta.commit, "abc");
  assert.deepEqual(data.coverage.examined, ["src/"]);
  assert.equal(data.baseline, null);
  // Every finding once, with its verdict, for a reader that filters one list.
  assert.deepEqual(data.findings.map((f) => `${f.id || f.title}:${f.verdict}`), ["SEC-001:confirmed", "SEC-002:confirmed", "SEC-003:confirmed", "SEC-004:uncertain", "innerHTML with a constant:refuted"]);

  const empty = tmpDir();
  writeReport(empty, { kind: "security" });
  const md = fs.readFileSync(path.join(empty, "report.md"), "utf8");
  assert.match(md, /No confirmed findings\./);
  assert.match(md, /### Not examined\n\n- \(nothing recorded; that is not the same as everything examined\)/);
  assert.match(md, /Confirmed: 0 \(critical 0, high 0, medium 0, low 0\)/);
});

test("writeReport: an optimize report shows the fix tier and the baseline, whatever its shape", () => {
  const dir = tmpDir();
  const confirmed = numberFindings([normalizeFinding({ category: "duplicates", title: "Two copies of the price code", severity: "medium", file: "src/cart/price.js", tier: "B", autoFixSafe: true }, { kind: "optimize" })], "optimize");
  const baseline = {
    buildMs: 8200, packages: 412, bundle: { rawBytes: 512000, gzipBytes: 140000 }, devServerStartMs: 2300,
    checks: [{ name: "unit", durationMs: 41000, ok: true }], flaky: ["test/clock.test.js"],
    pages: [{ url: "/", loadMs: 320, requests: 14 }, { url: "/cart", loadMs: 410, requests: 22 }]
  };
  writeReport(dir, { kind: "optimize", confirmed, baseline });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.match(md, /^# Optimization sweep report/);
  assert.match(md, /### OPT-001 · medium · Two copies of the price code/);
  assert.match(md, /\| Fix tier \| B \(behind pinned tests\) \|/);
  assert.equal(/\| CWE \|/.test(md), false, "no CWE row in an optimize report");
  assert.match(md, /## Baseline/);
  assert.match(md, /\| buildMs \| 8200 \|/);
  assert.match(md, /\| bundle\.gzipBytes \| 140000 \|/);
  assert.match(md, /\| flaky \| test\/clock\.test\.js \|/);
  assert.match(md, /### pages\n\n\| url \| loadMs \| requests \|\n\|---\|---\|---\|\n\| \/ \| 320 \| 14 \|\n\| \/cart \| 410 \| 22 \|/);
  assert.match(md, /### checks\n\n\| name \| durationMs \| ok \|/);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8")).baseline.bundle, { rawBytes: 512000, gzipBytes: 140000 });
});

test("writeReport takes the sweep's own names: usage at start and end, agents, options", () => {
  const dir = tmpDir();
  writeReport(dir, { kind: "security", meta: {
    id: "x", commit: "abc", startedAt: "2026-10-02T14:00:00Z", finishedAt: "2026-10-02T14:45:00Z", model: "opus", effort: "xhigh",
    usageAtStart: { fiveHour: 10, sevenDay: 20 }, usageAtEnd: { fiveHour: 40, sevenDay: 22 },
    agents: { "area-src": "done", "verify-SEC-001-1": "done", "area-api": "failed" },
    options: { depth: "standard", after: "plan", modules: ["code", "secrets"], targets: [{ url: "http://127.0.0.1:3000", mode: "full" }] }
  } });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  for (const want of [/\| Duration \| 45 min/, /\| Sessions \| 3 \(1 failed\) \|/, /\| 5-hour usage \| 10% before, 40% after \|/, /\| Weekly usage \| 20% before, 22% after \|/,
    /\| Depth \| standard/, /\| After the sweep \| a fix plan to review \|/, /\| Modules \| code, secrets \|/, /\| Targets \| http:\/\/127\.0\.0\.1:3000 \(full\) \|/]) assert.match(md, want);
});

test("writeReport: table cells with pipes and newlines stay one cell", () => {
  const dir = tmpDir();
  const refuted = [normalizeFinding({ category: "x", title: "a | b\nc", file: "f.js", reason: "it is | fine" }, { kind: "security" })];
  writeReport(dir, { kind: "security", refuted });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.match(md, /\| a \\\| b c \| x \| f\.js \| it is \\\| fine \|/);
});
