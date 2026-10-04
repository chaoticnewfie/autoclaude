import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FINDING_SCHEMA, CANDIDATES_SCHEMA, VERDICT_SCHEMA, SEVERITIES, ACCEPTED_FILE, FINDINGS_SCHEMA_VERSION,
  redact, redactDeep, maskValue, fingerprint, normalizeFinding, dedupe, numberFindings, sortFindings, countBySeverity,
  gateSeverity, areaOf, loadAccepted, readAccepted, saveAccepted, applyAccepted, writeReport, canonicalCategory,
  fileMentions, placesOf
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
  // A path outside the project is never read: its lines would anchor two findings apart, but
  // unread, the file is all a session's finding has.
  const parent = tmpDir();
  const inner = path.join(parent, "proj");
  fs.mkdirSync(inner);
  fs.writeFileSync(path.join(parent, "outside.js"), "const a = 1;\nconst b = 2;\n");
  const out1 = normalizeFinding({ category: "injection", file: "../outside.js", line: 1, evidence: "x", source: "session area-src" }, { kind: "security", root: inner });
  const out2 = normalizeFinding({ category: "injection", file: "../outside.js", line: 2, evidence: "y", source: "session area-src" }, { kind: "security", root: inner });
  assert.equal(out1.fingerprint, out2.fingerprint);
  fs.writeFileSync(path.join(inner, "inside.js"), "const a = 1;\nconst b = 2;\n");
  const in1 = normalizeFinding({ category: "injection", file: "inside.js", line: 1, evidence: "x", source: "session area-src" }, { kind: "security", root: inner });
  const in2 = normalizeFinding({ category: "injection", file: "inside.js", line: 2, evidence: "x", source: "session area-src" }, { kind: "security", root: inner });
  assert.notEqual(in1.fingerprint, in2.fingerprint, "the same lines inside the project are read and tell the two apart");
});

const ORDERS = [
  "import { db } from \"./db.js\";",
  "",
  "export async function getOrder(req, res) {",
  "  const id = req.params.id;",
  "  const order = await db.query(",
  "    `SELECT * FROM orders WHERE id = ${id}`",
  "  );",
  "  if (!order) return res.status(404).end();",
  "  // TODO: check the owner",
  "  res.json(order);",
  "}",
  "",
  "export async function listOrders(req, res) {",
  "  const rows = await db.query(\"SELECT * FROM orders WHERE owner = $1\", [req.user.id]);",
  "  // TODO: paginate",
  "  res.json(rows);",
  "}",
  "",
  "class Cart {",
  "  total() {",
  "    return 1;",
  "  }",
  "}",
  "",
  "class Invoice {",
  "  total() {",
  "    return 2;",
  "  }",
  "}",
  ""
].join("\n");

test("one issue reported twice, worded and categorized differently and a few lines apart: one fingerprint, and accepted stays accepted", () => {
  const root = tmpDir();
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "orders.js"), ORDERS);
  const norm = (f) => normalizeFinding(f, { kind: "security", root });
  // Sweep 1: the area reviewer points at the function's line.
  const first = norm({ category: "injection", title: "SQL injection in getOrder", severity: "high", file: "src/orders.js", line: 3,
    evidence: "getOrder builds its query from req.params.id", source: "session area-src" });
  // Sweep 2: another reviewer calls it "SQL Injection", words it otherwise and names the query's line.
  const second = norm({ category: "SQL Injection", title: "The order id reaches the database unescaped", severity: "critical", file: "src/orders.js", line: 6,
    evidence: "6: `SELECT * FROM orders WHERE id = ${id}`", source: "session area-api" });
  assert.equal(second.fingerprint, first.fingerprint);
  assert.equal(second.category, "sql-injection", "the stored category stays as the session wrote it");
  saveAccepted(root, [{ fingerprint: first.fingerprint, kind: "security", reason: "the id is checked by the router" }]);
  const next = applyAccepted([second], loadAccepted(root));
  assert.deepEqual([next.accepted.length, next.kept.length], [1, 0], "listed as accepted, not reported again");
  // One sweep's two reports, five lines apart (beyond NEAR_LINES): one finding.
  const merged = dedupe([{ ...first, fingerprint: undefined }, { ...second, fingerprint: undefined }], { kind: "security", root });
  assert.equal(merged.length, 1);

  // The reviewer says authz where the browser says idor, at other lines of the same function.
  const authz = norm({ category: "authz", file: "src/orders.js", line: 4, evidence: "no owner check", source: "session area-src" });
  const idor = norm({ category: "IDOR", file: "src/orders.js", line: 8, evidence: "user B reads user A's order", source: "session browser-0" });
  assert.equal(idor.fingerprint, authz.fingerprint);
  assert.notEqual(authz.fingerprint, first.fingerprint, "another kind of problem in the same function is another finding");
  // The same category in another function is another finding.
  assert.notEqual(norm({ category: "injection", file: "src/orders.js", line: 14, evidence: "x", source: "session area-src" }).fingerprint, first.fingerprint);
  // A method of one class is not the same-named method of another.
  assert.notEqual(norm({ category: "bug", file: "src/orders.js", line: 21, source: "session area-src" }).fingerprint, norm({ category: "bug", file: "src/orders.js", line: 27, source: "session area-src" }).fingerprint);

  // A file-level finding (line 0, nothing in the file quoted), or one on a URL path: the file alone.
  const fileLevel = (category, evidence, file = "src/orders.js") => norm({ category, file, line: 0, evidence, source: "session area-src" }).fingerprint;
  assert.equal(fileLevel("csrf", "the order routes take no token"), fileLevel("CSRF Protection", "no anti-forgery token anywhere in this router"));
  assert.equal(fileLevel("idor", "user B opened /orders/12", "/orders/:id"), fileLevel("access-control", "another user's order is shown", "/orders/:id"));
  assert.notEqual(fileLevel("csrf", "x"), fileLevel("csrf", "x", "src/other.js"));

  // A scanner names the exact line: two hits in one function stay two findings.
  const scan = (line) => normalizeFinding({ category: "stale-todo", file: "src/orders.js", line, evidence: "TODO", source: "scanner optimize" }, { kind: "optimize", root }).fingerprint;
  assert.notEqual(scan(9), scan(15));
  const sameFn = normalizeFinding({ category: "commented-out", file: "src/orders.js", line: 4, evidence: "x", source: "scanner optimize" }, { kind: "optimize", root }).fingerprint;
  assert.notEqual(sameFn, normalizeFinding({ category: "commented-out", file: "src/orders.js", line: 8, evidence: "x", source: "scanner optimize" }, { kind: "optimize", root }).fingerprint);
});

test("canonicalCategory: synonyms and casing to one slug per kind; each canonical slug is its own; unknown slugs are kept", () => {
  const same = (kind, ...names) => {
    const want = canonicalCategory(names[0], kind);
    for (const n of names) assert.equal(canonicalCategory(n, kind), want, `${kind}: ${n} -> ${canonicalCategory(n, kind)}, not ${want}`);
    return want;
  };
  assert.equal(same("security", "injection", "sql-injection", "SQL Injection", "sqli", "command_injection", "nosql"), "injection");
  assert.equal(same("security", "authz", "idor", "IDOR", "access-control", "Broken Access Control", "authorization", "authentication", "missing-auth"), "authz");
  assert.equal(same("security", "xss", "stored-xss", "Cross-Site Scripting", "html-injection"), "xss");
  assert.equal(same("security", "secrets", "secret", "hardcoded-secret", "Hard-coded credentials", "api-key"), "secrets");
  assert.equal(same("security", "deps", "dependencies", "dependency", "vulnerable-dependency", "supply-chain"), "deps");
  assert.equal(same("security", "headers", "security-headers", "missing-csp", "clickjacking"), "headers");
  assert.equal(same("security", "csrf", "CSRF", "missing-csrf-protection", "xsrf"), "csrf");
  assert.equal(same("security", "cookies", "cookie", "insecure-cookie", "session-cookie"), "cookies");
  assert.equal(same("security", "errors", "verbose-errors", "stack-trace"), "errors");
  assert.equal(same("security", "exposure", "information-disclosure", "source-maps"), "exposure");
  assert.equal(same("security", "rate-limit", "brute-force", "missing-rate-limiting"), "rate-limit");
  assert.equal(canonicalCategory("ssrf", "security"), "ssrf", "server-side request forgery is not csrf");
  assert.equal(canonicalCategory("server-side-request-forgery", "security"), "ssrf");
  assert.equal(same("optimize", "duplicate", "duplicates", "duplicated-code"), "duplicate");
  assert.equal(same("optimize", "unused-export", "unused-code", "dead-code", "unused"), "unused-export");
  assert.equal(same("optimize", "unused-file", "unused-files", "dead-file"), "unused-file");
  assert.equal(same("optimize", "performance", "perf", "n+1", "slow-query"), "performance");
  assert.equal(same("optimize", "slow-test", "slow-tests"), "slow-test");
  assert.equal(same("optimize", "major-upgrade", "major"), "major-upgrade");
  // Every category the scanners write is canonical; another kind's canonical slug is kept.
  for (const c of ["authz", "config", "cookies", "cors", "deps", "errors", "exposure", "headers", "rate-limit", "secrets"]) assert.equal(canonicalCategory(c, "security"), c);
  assert.equal(canonicalCategory("headers", "optimize"), "headers");
  assert.equal(canonicalCategory("performance", "security"), "performance");
  for (const c of ["unused-file", "unused-dependency", "unlisted-dependency", "commented-out", "stale-todo", "leftover", "outdated", "unused-export", "duplicate", "performance", "rebuild", "slow-test", "flaky-test", "bug", "major-upgrade"]) {
    assert.equal(canonicalCategory(c, "optimize"), c);
  }
  // Unknown slugs: kept, with a plural dropped; empty is "other".
  assert.equal(canonicalCategory("Business Logic", "security"), "business-logic");
  assert.equal(canonicalCategory("refute-me"), "refute-me");
  assert.equal(canonicalCategory("missing-checks"), "missing-check");
  assert.equal(canonicalCategory("", "security"), "other");
  // The fingerprint follows the canonical slug; the kind decides which synonyms apply.
  assert.equal(fingerprint({ kind: "security", category: "idor", file: "a.js", evidence: "e" }), fingerprint({ kind: "security", category: "authz", file: "a.js", evidence: "e" }));
  assert.notEqual(fingerprint({ kind: "security", category: "injection", file: "a.js", evidence: "e" }), fingerprint({ kind: "security", category: "xss", file: "a.js", evidence: "e" }));
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

// ---------- one problem reported twice in one file, or from each end of a copy (P10.14) ----------
//
// Shapes copied from the live proof's findings.json (spikes/out/todo-live, sweeps 20261004-0010
// and 20261004-0929), trimmed.

const LEGACY_JS = "// Old import format, from before the JSON API. Nothing uses this any more.\nexport function parseLegacy(text) {\n  return text.split(\",\");\n}\n";
const CONFIG_JS = "// Payment settings.\nexport const PAYMENT_KEY = process.env.PAYMENT_KEY || \"\";\n";

// Every line of these files differs, so each line anchors its own fingerprint.
const numbered = (n) => Array.from({ length: n }, (_, i) => `const step${i + 1} = ${i + 1};`).join("\n") + "\n";

function proofProject() {
  const root = tmpDir();
  for (const [rel, text] of [["lib/legacy.js", LEGACY_JS], ["lib/config.js", CONFIG_JS], ["Dockerfile", "FROM node:24\nWORKDIR /app\nCOPY . .\nENV ADMIN_TOKEN=${ADMIN_TOKEN}\n"],
    ["server.js", numbered(100)], ["test/sec-015.test.js", numbered(60)], ["e2e/todo.spec.js", numbered(20)], ["package-lock.json", "{}\n"]]) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), text);
  }
  return root;
}

// OPT-013 (knip, the whole file) and OPT-007 (a reviewer, line 1).
const OPT_013 = { category: "unused-file", severity: "low", confidence: 7, file: "lib/legacy.js", line: 0, title: "", tier: "A", autoFixSafe: true, tool: "knip 6.39.0 + reference search", source: "scanner optimize",
  evidence: "knip flags the file as unused; a search of the whole repository (code, tests, package.json scripts, CI, Dockerfiles and compose files, manifests, config and docs) finds no reference to it, and it matches no entry-point convention.",
  impact: "5 lines that are read, built and maintained for nothing.", fix: "Delete the file (git keeps the history)." };
const OPT_007 = { category: "unused-file", title: "Delete unused lib/legacy.js (parseLegacy)", severity: "low", confidence: 9, file: "lib/legacy.js", line: 1, tier: "A", autoFixSafe: true, area: "lib", source: "session area-lib",
  evidence: "\"// Old import format, from before the JSON API. Nothing uses this any more.\" / \"export function parseLegacy(text) {\". (1) Nothing imports ./lib/legacy.js or calls parseLegacy.",
  fix: "git rm lib/legacy.js. Nothing else references it, so no other edit is needed." };
// OPT-011 (baseline timing, the whole file) and OPT-005 (a reviewer, the line that holds it open).
const OPT_011 = { category: "slow-test", severity: "low", confidence: 8, file: "test/sec-015.test.js", line: 0, title: "", tier: "B", tool: "baseline timing", source: "scanner optimize",
  evidence: "median 6.5 s over 3 runs, 19% of the 35.3 s all 20 files of \"unit\" take together" };
const OPT_005 = { category: "slow-test", title: "sec-015 leaves a 5 s timeout timer pending, holding the test file open after its tests finish", severity: "medium", confidence: 8, file: "test/sec-015.test.js", line: 41, tier: "B", source: "session area-test",
  evidence: "const outcome = await Promise.race([closed, new Promise((resolve) => setTimeout(() => resolve(\"still open\"), 5000))]);  -- the timer is never cleared." };
// SEC-007 (gitleaks: the key in lib/config.js's history, line 2 at that commit) and SEC-008 (a reviewer, line 2).
const SEC_007 = { category: "secrets", severity: "high", cwe: "CWE-798", confidence: 7, file: "lib/config.js", line: 0, title: "", autoFixSafe: false, source: "scanner security",
  evidence: "gitleaks rule stripe-access-token matched in git history at commit 734d093f053a in lib/config.js line 2 (the value is not shown)",
  ownerAction: "Rotate the value at the service that issued it; rewriting the git history is your decision.",
  anchor: "gitleaks:734d093f053a1ee067a1eed6a51ae286c7014119:lib/config.js:stripe-access-token:2", commit: "734d093f053a1ee067a1eed6a51ae286c7014119" };
const SEC_008 = { category: "secrets", title: "Stripe-shaped payment key hardcoded in lib/config.js in git history (commit 734d093), still reachable after the env-var change", severity: "high", cwe: "CWE-798", confidence: 7,
  file: "lib/config.js", line: 2, autoFixSafe: false, source: "session area-lib",
  evidence: "gitleaks rule stripe-access-token matched lib/config.js line 2 at commit 734d093 'payment settings'. The next commit replaced it with process.env.PAYMENT_KEY (the current line 2).",
  ownerAction: "Revoke/rotate the key at the payment provider." };

test("dedupe merges a whole-file report with one that names a line in that file: the line's place and title, both sources, every fingerprint", () => {
  const root = proofProject();
  const opt = dedupe([OPT_013, OPT_007, OPT_011, OPT_005], { kind: "optimize", root });
  assert.equal(opt.length, 2, JSON.stringify(opt.map((f) => [f.file, f.line])));
  const legacy = opt.find((f) => f.file === "lib/legacy.js");
  assert.deepEqual([legacy.line, legacy.title, legacy.confidence], [1, "Delete unused lib/legacy.js (parseLegacy)", 9]);
  assert.deepEqual(legacy.sources, ["session area-lib", "scanner optimize"], "Found by lists both");
  const scannerFp = normalizeFinding(OPT_013, { kind: "optimize", root }).fingerprint;
  const sessionFp = normalizeFinding(OPT_007, { kind: "optimize", root }).fingerprint;
  assert.deepEqual(legacy.fingerprints, [sessionFp, scannerFp], "no fingerprint changes; the kept report's comes first");
  assert.equal(legacy.fingerprint, sessionFp);
  const slow = opt.find((f) => f.file === "test/sec-015.test.js");
  assert.deepEqual([slow.line, slow.severity, slow.sources], [41, "medium", ["session area-test", "scanner optimize"]]);
  // An owner who accepted the scanner's report earlier still has it accepted.
  assert.equal(applyAccepted(opt, [{ fingerprint: scannerFp, kind: "optimize", reason: "accepted: loaded by name" }]).accepted.length, 1);

  const sec = dedupe([SEC_008, SEC_007], { kind: "security", root });
  assert.equal(sec.length, 1);
  assert.deepEqual([sec[0].line, sec[0].title, sec[0].sources], [2, SEC_008.title, ["session area-lib", "scanner security"]]);
  assert.ok(sec[0].fingerprints.includes(normalizeFinding(SEC_007, { kind: "security", root }).fingerprint));
  // The order they come in does not matter, and the more severe severity is kept.
  const flipped = dedupe([{ ...SEC_007, severity: "critical" }, SEC_008], { kind: "security", root });
  assert.deepEqual([flipped.length, flipped[0].line, flipped[0].severity, flipped[0].title], [1, 2, "critical", SEC_008.title]);
  // The report shows one finding found by both.
  const dir = tmpDir();
  writeReport(dir, { kind: "optimize", confirmed: numberFindings(opt, "optimize") });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.equal((md.match(/^### OPT-\d{3} .*legacy/gm) || []).length, 1, "one heading for lib/legacy.js");
  assert.match(md, /\| Where \| `lib\/legacy\.js:1` \|/);
  assert.match(md, /\| Found by \| session area-lib, scanner optimize \|/);
});

test("dedupe keeps different problems in one file apart: two scanner hits, two missing headers, two session bugs, another package, another line, and anything ambiguous", () => {
  const root = proofProject();
  const count = (list, kind) => dedupe(list, { kind, root }).length;
  // SEC-001 (the token in the working tree, with the reviewers who saw it) and SEC-006 (gitleaks:
  // the same token in the history): two scanner hits, two fixes (a commit; a rotation).
  const SEC_001 = { category: "secrets", severity: "critical", file: "Dockerfile", line: 4, evidence: "github-token in the working tree (value ghp_[redacted, 40 chars])", anchor: "secret:github-token:ghp_[redacted, 40 chars]", source: "scanner security", autoFixSafe: true };
  const SEC_001_REVIEW = { category: "secrets", title: "GitHub token hard-coded in the Dockerfile", severity: "critical", file: "Dockerfile", line: 4, evidence: "ENV ADMIN_TOKEN=ghp_...", source: "session crosscut-infra" };
  const SEC_006 = { category: "secrets", severity: "high", file: "Dockerfile", line: 0, evidence: "gitleaks rule github-pat matched in git history at commit c6a815d0cd2c in Dockerfile line 4 (the value is not shown)", anchor: "gitleaks:c6a815d0cd2cfd3bc5204bb5111a66e7ee432c94:dockerfile:github-pat:4", source: "scanner security" };
  assert.equal(count([SEC_001, SEC_001_REVIEW, SEC_006], "security"), 2);
  // SEC-013, 014, 020 (three headers the probe found missing on the page) and SEC-025 (a reviewer: no security headers in server.js).
  const URL = "http://127.0.0.1:4173/";
  const probe = (anchor, evidence) => ({ category: "headers", severity: "medium", file: URL, line: 0, anchor, evidence, source: "scanner probe" });
  const headers = [probe("header:content-security-policy", "no Content-Security-Policy header on the main response"), probe("header:frame-options", "no X-Frame-Options header and no frame-ancestors in the CSP"),
    probe("header:x-content-type-options", "no X-Content-Type-Options: nosniff header"),
    { category: "headers", title: "No security headers on any response (server.js)", severity: "low", file: "server.js", line: 25, evidence: "server.js:25 sets only content-type", source: "session area-root" }];
  assert.equal(count(headers, "security"), 4);
  assert.equal(count([...headers.slice(0, 3), { ...headers[0], line: 1, anchor: undefined, source: "session browser-0", evidence: "the page has no CSP" }], "security"), 4, "a URL has no lines to merge on");
  // Two bugs in server.js from the reviewers, one about the whole file: two findings.
  const bugs = [{ category: "bug", title: "server.js has no error handling around its routes", severity: "medium", file: "server.js", line: 0, evidence: "no try/catch in the handler", source: "session area-root" },
    { category: "bug", title: "A request for the path // crashes the server", severity: "critical", file: "server.js", line: 73, evidence: "new URL() runs before the try block", source: "session area-root" }];
  assert.equal(count(bugs, "optimize"), 2);
  // ...unless the whole-file one points at that line, or the category is about the whole file.
  assert.equal(count([{ ...bugs[0], evidence: "server.js:73 parses the URL outside the try block" }, bugs[1]], "optimize"), 1);
  assert.equal(count([{ category: "unused-file", file: "e2e/todo.spec.js", line: 0, evidence: "no runner", source: "session area-e2e" }, { category: "unused-file", file: "e2e/todo.spec.js", line: 1, evidence: "nothing runs it", source: "session crosscut" }], "optimize"), 1);
  // A package advisory and a report about another package in the same lockfile; the same package merges.
  const minimist = { category: "deps", severity: "critical", file: "package-lock.json", line: 0, anchor: "pkg:npm:minimist", evidence: "osv-scanner: minimist 0.0.8 (npm) has 2 advisories: GHSA-vh95-rmgr-6w4m, GHSA-xvch-5gv4-984h", source: "scanner security" };
  assert.equal(count([minimist, { category: "dependencies", title: "lodash 4.17.20 is pinned", file: "package-lock.json", line: 120, evidence: "lodash 4.17.20 has a prototype pollution advisory", source: "session crosscut-infra" }], "security"), 2);
  assert.equal(count([minimist, { category: "dependencies", title: "minimist 0.0.8 is pinned", file: "package-lock.json", line: 14, evidence: "minimist 0.0.8 (prototype pollution)", source: "session crosscut-infra" }], "security"), 1);
  // A whole-file report that names another line of its file.
  assert.equal(count([{ ...SEC_007, evidence: "gitleaks rule stripe-access-token matched in git history at commit 734d093f053a in lib/config.js line 40" }, SEC_008], "security"), 2);
  // Ambiguous: one whole-file report and two lines far apart, or two whole-file reports for one line.
  assert.equal(count([OPT_011, OPT_005, { ...OPT_005, line: 10, title: "sec-015 starts the server twice", evidence: "before() and the first test both start it" }], "optimize"), 3);
  const history = (commit, rule, masked) => ({ category: "secrets", severity: "high", file: "lib/config.js", line: 0, evidence: `${rule} added in git history at commit ${commit} in lib/config.js (value ${masked})`,
    anchor: `history:${commit}:${rule}:${masked}`, source: "scanner security" });
  assert.equal(count([history("734d093", "stripe-live", "sk_l[redacted, 32 chars]"), history("9f0e1d2", "aws-access-key", "AKIA[redacted, 20 chars]"), SEC_008], "security"), 3);
});

// OPT-019 and OPT-023: the formatList copy, seen from lib/format.js and from server.js.
const OPT_019 = { category: "duplicate", title: "Reuse lib/format.js formatList in /api/summary instead of its inline copy", severity: "low", confidence: 6, file: "lib/format.js", line: 2, tier: "B", area: "lib", source: "session area-lib",
  evidence: "lib/format.js:4 \"for (const t of items) lines.push((t.done ? \\\"[x] \\\" : \\\"[ ] \\\") + t.text);\" matches server.js:90 \"for (const t of store.list()) lines.push(...)\", and both then join with a newline. formatList is imported nowhere.",
  reproduce: "Grep \"formatList\": only the definition at lib/format.js:2. Compare lib/format.js:3-5 with server.js:89-92: same loop, same join." };
const OPT_023 = { category: "duplicate", title: "The /api/summary route in server.js re-implements formatList from lib/format.js", severity: "low", confidence: 6, file: "server.js", line: 89, tier: "B", source: "session area-root",
  evidence: "server.js:89-90: const lines = []; for (const t of store.list()) lines.push(...);\nlib/format.js:3-4: const lines = []; for (const t of items) lines.push(...);\nNo code imports formatList.",
  reproduce: "Grep the repository for 'formatList': only its definition at lib/format.js:2. Grep for 'format.js': only package.json:9 (lint)." };

test("dedupe merges a duplicate-code pair reported from each of its two places into one finding that names both", () => {
  const list = dedupe([OPT_023, OPT_019], { kind: "optimize" });
  assert.equal(list.length, 1);
  const f = list[0];
  assert.deepEqual(placesOf(f), [{ file: "lib/format.js", line: 2 }, { file: "server.js", line: 89 }]);
  assert.equal(f.title, OPT_019.title);
  assert.deepEqual(f.sources.sort(), ["session area-lib", "session area-root"]);
  assert.equal(f.fingerprints.length, 2);
  const dir = tmpDir();
  writeReport(dir, { kind: "optimize", confirmed: numberFindings(list, "optimize") });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  assert.match(md, /\| Where \| `lib\/format\.js:2` and `server\.js:89` \|/);
  assert.equal((md.match(/^### OPT-/gm) || []).length, 1);
  // The jscpd hit (OPT-016) and a review of another copy elsewhere in its partner file: two.
  const jscpd = { category: "duplicate", severity: "low", file: "test/sec-012.test.js", line: 1, evidence: "15 lines at test/sec-012.test.js:1-15 repeat at test/sec-019.test.js:1-15", source: "scanner optimize" };
  const other = { category: "duplicate", title: "Another copy", file: "test/sec-019.test.js", line: 40, evidence: "test/sec-019.test.js:40-52 repeats test/sec-012.test.js:30-42", source: "session area-test" };
  assert.equal(dedupe([jscpd, other], { kind: "optimize" }).length, 2, "lines that do not meet stay apart");
  assert.equal(dedupe([jscpd, { ...other, line: 2, evidence: "test/sec-019.test.js:1-13 repeats the helper of test/sec-012.test.js:1-13" }], { kind: "optimize" }).length, 1, "the other end of the jscpd hit");
  // One-sided: only one of them names the other.
  assert.equal(dedupe([OPT_019, { ...OPT_023, evidence: "an inline loop builds the summary", reproduce: "", title: "The summary is built inline" }], { kind: "optimize" }).length, 2);
  // A third copy that names the two: the pair still merges, the third stays (it is named by neither).
  const third = { category: "duplicate", title: "A third copy of the loop", file: "lib/report.js", line: 5, evidence: "the same loop as lib/format.js:3 and server.js:89", source: "session area-lib" };
  assert.equal(dedupe([OPT_019, OPT_023, third], { kind: "optimize" }).length, 2);
  // Three copies each naming both others: no single partner, so nothing is merged.
  const copy = (file, a, b) => ({ category: "duplicate", title: `A copy in ${file}`, file, line: 1, evidence: `the same loop as ${a}:1 and ${b}:1`, source: "session area-lib" });
  assert.equal(dedupe([copy("lib/a.js", "lib/b.js", "lib/c.js"), copy("lib/b.js", "lib/a.js", "lib/c.js"), copy("lib/c.js", "lib/a.js", "lib/b.js")], { kind: "optimize" }).length, 3);
});

test("fileMentions matches a project path whole, with the lines it gives", () => {
  assert.deepEqual(fileMentions("lib/format.js:4 matches server.js:90; compare lib/format.js:3-5 with server.js:89-92", "server.js"), [{ from: 90, to: 90 }, { from: 89, to: 92 }]);
  assert.deepEqual(fileMentions("matched in git history at commit 734d093f053a in lib/config.js line 2 (the value", "lib/config.js"), [{ from: 2, to: 2 }]);
  assert.deepEqual(fileMentions("see ./lib\\config.js (lines 3 to 5) and `lib/config.js`", "lib/config.js"), [{ from: 3, to: 5 }, { from: 0, to: 0 }]);
  assert.deepEqual(fileMentions("test/helpers/server.js:30 and server.json and server.js.map", "server.js"), [], "another file that ends the same is not a mention");
  assert.deepEqual(fileMentions("anything", "http://127.0.0.1:4173/"), []);
  assert.deepEqual(placesOf({ file: "a.js", line: 3 }), [{ file: "a.js", line: 3 }]);
  assert.deepEqual(placesOf({ file: "a.js", line: 3, locations: [{ file: "a.js", line: 3 }, { file: ".\\b.js", line: "7" }, { file: "a.js", line: 3 }] }), [{ file: "a.js", line: 3 }, { file: "b.js", line: 7 }]);
});

test("a scanner's title never decides its fingerprint, so the titles scanners now write changed none", () => {
  const root = proofProject();
  const scanner = { kind: "optimize", category: "slow-test", file: "test/sec-015.test.js", line: 0, evidence: "", source: "scanner optimize" };
  const titled = { ...scanner, title: "test/sec-015.test.js is one of the slowest test files" };
  assert.equal(fingerprint(titled), fingerprint(scanner), "without the project");
  assert.equal(fingerprint(titled, { root }), fingerprint(scanner, { root }), "with the project");
  assert.equal(normalizeFinding(titled, { kind: "optimize", root }).fingerprint, normalizeFinding(scanner, { kind: "optimize", root }).fingerprint);
  // A session's title still counts where nothing else can (as before).
  const session = { kind: "optimize", category: "bug", file: "a.js", evidence: "", source: "session area-src" };
  assert.notEqual(fingerprint({ ...session, title: "one" }), fingerprint({ ...session, title: "two" }));
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

test("writeReport: an optimize report shows the fix tier and the baseline, whatever its shape, in plain words", () => {
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
  for (const want of [/\| Build \| 8\.2 s \|/, /\| Bundle size \| 137 KB gzip, 500 KB before compression \|/, /\| Flaky \| test\/clock\.test\.js \|/, /\| Packages \| 412 \|/, /\| Dev server start \| 2\.3 s \|/,
    /### Pages\n\n\| Page \| Load \| Requests \|\n\|---\|---\|---\|\n\| \/ \| 320 ms \| 14 \|\n\| \/cart \| 410 ms \| 22 \|/,
    /### Checks\n\n\| Check \| Command \| Result \| Time \|\n\|---\|---\|---\|---\|\n\| unit \| - \| passed \| 41\.0 s \|/]) assert.match(md, want);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8")).baseline.bundle, { rawBytes: 512000, gzipBytes: 140000 }, "findings.json keeps the raw numbers");
});

// The live proof's baseline (20261004-0929-optimize), trimmed: its report showed version, at,
// envSource, checksGreen, flaky.rounds, coverage.notExamined and a test-file list as raw JSON.
const PROOF_BASELINE = {
  version: 1, at: "2026-10-04T14:29:18.809Z", envSource: "run",
  checks: [{ name: "lint", command: "npm run lint", ok: true, ms: 4161, reason: null }, { name: "unit", command: "npm test", ok: true, ms: 10711, reason: null }],
  checksGreen: true,
  testFiles: [{ check: "unit", runner: "node", rounds: 3, files: [{ file: "test/sec-015.test.js", ms: 6532, samples: [6532, 6738, 6471], ok: true, tests: 4 }, { file: "test/sec-010.test.js", ms: 861, samples: [861, 987, 827], ok: true, tests: 2 }] }],
  flaky: { rounds: 3, tests: [], files: [], suites: [] },
  build: null, bundle: null,
  packages: { lockfile: "package-lock.json", count: 0, direct: 0 },
  devServer: { url: "http://127.0.0.1:4173", ok: true, reused: false, startMs: 3357, error: null },
  pages: [{ url: "http://127.0.0.1:4173/", loads: 5, loadMsMedian: 326, loadMsMin: 229, loadMsMax: 1534, domContentLoadedMs: 265, requests: 2, transferKb: 2.5, failedRequests: 0, duplicateApiCalls: [], heavyAssets: [], consoleErrors: 0 }],
  coverage: { examined: ["packages: 0 in package-lock.json", "dev server: ready in 3.4 s"], notExamined: ["build time and bundle size: not checked (no build script)"] },
  pagesAt: "2026-10-04T14:45:45.032Z"
};

test("writeReport: the optimize baseline in plain labels, readable times and sizes, no internal fields, and what was not checked", () => {
  const dir = tmpDir();
  writeReport(dir, { kind: "optimize", baseline: PROOF_BASELINE });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  const section = md.slice(md.indexOf("## Baseline"), md.indexOf("## Appendix"));
  for (const raw of ["version", "envSource", "checksGreen", "flaky.rounds", "notExamined", "coverage.", "startMs", "loadMsMedian", "transferKb", "pagesAt", "durationMs", "| at |", "| ok |", "{\"file\""]) {
    assert.equal(section.includes(raw), false, `no raw field name or JSON: ${raw}\n${section}`);
  }
  for (const want of [
    "| Measured at | 2026-10-04 14:29 UTC |", "| Checks | all 2 passed |", "| Build | not checked (no build script) |", "| Bundle size | not checked (no build script) |",
    "| Packages | 0 in package-lock.json, 0 declared directly |", "| Dev server start | 3.4 s (http://127.0.0.1:4173) |", "| Flaky tests | none in 3 identical runs |", "| Pages measured at | 2026-10-04 14:45 UTC |",
    "### Checks\n\n| Check | Command | Result | Time |\n|---|---|---|---|\n| lint | npm run lint | passed | 4.2 s |\n| unit | npm test | passed | 10.7 s |",
    "### Test files of \"unit\" (node, 3 runs each)\n\n| File | Median | Each run | Tests | Result |", "| test/sec-015.test.js | 6.5 s | 6.5 s, 6.7 s, 6.5 s | 4 | passed |", "| test/sec-010.test.js | 861 ms | 861 ms, 987 ms, 827 ms | 2 | passed |",
    "| Page | Loads | Median load | Fastest | Slowest | DOM ready | Requests | Transferred | Failed requests | Repeated API calls | Heavy assets | Console errors |",
    "| http://127.0.0.1:4173/ | 5 | 326 ms | 229 ms | 1.5 s | 265 ms | 2 | 2.5 KB | 0 | none | none | 0 |",
    "### Not checked\n\n- build time and bundle size: not checked (no build script)"
  ]) assert.ok(section.includes(want), `missing: ${want}\n${section}`);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, "findings.json"), "utf8")).baseline.version, 1, "findings.json keeps every field");
});

test("writeReport: a baseline with a build, a bundle, a failed check, a flaky test and a server already running reads as plainly", () => {
  const dir = tmpDir();
  writeReport(dir, { kind: "optimize", baseline: {
    version: 1, at: "2026-10-04T09:00:00.000Z", envSource: "dotenv",
    checks: [{ name: "unit", command: "npm test", ok: false, ms: 65000, reason: "exit code 1" }], checksGreen: false,
    testFiles: [], flaky: { rounds: 3, tests: [{ check: "unit", file: "test/clock.test.js", name: "ticks", passed: 2, failed: 1, runs: 3 }], files: [{ check: "unit", file: "test/net.test.js", passed: 1, runs: 3 }], suites: [] },
    build: { command: "npm run build", ok: true, ms: 12300, fromCheck: null, reason: null },
    bundle: { dir: "dist", files: 12, rawBytes: 512000, gzipBytes: 140000, mapBytes: 2 * 1024 * 1024, byType: { js: { files: 3, rawBytes: 400000, gzipBytes: 120000 } }, largest: [{ file: "assets/index.js", rawBytes: 380000, gzipBytes: 110000 }], skipped: 0, truncated: false },
    packages: null, devServer: { url: "http://127.0.0.1:5173", ok: true, reused: true, startMs: null, error: null }, pages: null,
    coverage: { examined: [], notExamined: ["package count: not checked (no lockfile or package.json)", "dev-server start time: not checked (a server was already answering at its URL)", "per-file times of \"unit\": not checked (only node --test, vitest and jest report them)", "page timings: not checked yet (the browser walk adds them)"] }
  } });
  const md = fs.readFileSync(path.join(dir, "report.md"), "utf8");
  for (const want of [
    "| Checks | 1 of 1 failed |", "| unit | npm test | failed: exit code 1 | 1 min 5 s |", "| Build | 12.3 s (npm run build) |",
    "| Bundle size | dist, 12 files: 137 KB gzip, 500 KB before compression; source maps 2.0 MB more |", "### Bundle by type\n\n| Type | Files | Size | Gzip |\n|---|---|---|---|\n| js | 3 | 391 KB | 117 KB |",
    "| assets/index.js | 371 KB | 107 KB |", "| Packages | not checked (no lockfile or package.json) |", "| Dev server start | not measured: a server was already answering at http://127.0.0.1:5173 |",
    "| Flaky tests | 2 found in 3 identical runs (listed below) |", "| \"ticks\" | test/clock.test.js | 2 of 3 |", "| the whole file (no single test was named) | test/net.test.js | 1 of 3 |",
    "| Test file times | not checked (only node --test, vitest and jest report them) |",
    "| Page timings | not checked yet (the browser walk adds them) |", "- page timings: not checked yet (the browser walk adds them)"
  ]) assert.ok(md.includes(want), `missing: ${want}`);
  assert.equal(md.includes("dotenv"), false, "the env source is internal");
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
