import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  scanLine, entropy, maskValue, isFixturePath, localRedact, resolveRedact,
  scanTree, scanHistoryText, scanSensitiveAndGitignore,
  parseNpmAudit, severityFromNpm, severityFromCvss, parseLockfilePackages, scanOsv, scanLockfileHygiene,
  runSecurityScanners, parseGitleaks, parseOsvScanner, gitleaksArgs, osvScannerArgs, readOnlyMount, compareVersions, isMajorUpgrade,
  GITLEAKS_IMAGE, OSV_SCANNER_IMAGE
} from "../../plugins/autoclaude/lib/scan-security.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-scansec-"));
// A visible marker so a test can prove the shared/local redactor also ran.
const mark = (t) => `[r]${t}`;

// A high-entropy, non-placeholder value that the gated rules accept.
const REAL = "aZ9x7Qw3LpN2vB8kR4tE6yUj";

test("scanLine: ungated rules fire on the pattern; gated rules need entropy and no placeholder", () => {
  assert.deepEqual(scanLine("const k = 'AKIAIOSFODNN7EXAMPLE'").map((h) => h.name), ["aws-access-key"]);
  assert.equal(scanLine(`password = "${REAL}"`).some((h) => h.name === "generic-assignment"), true);
  assert.equal(scanLine('password = "changeme1234"').length, 0, "placeholder is skipped");
  assert.equal(scanLine("password = process.env.DB_PASSWORD").length, 0, "an env reference is skipped");
  assert.equal(scanLine('password = "aaaaaaaaaaaa"').length, 0, "low entropy is skipped");
  assert.equal(scanLine(`DATABASE_URL = "postgres://user:${REAL}@db:5432/app"`).some((h) => h.name === "url-with-password"), true);
  assert.equal(scanLine("nothing to see here").length, 0);
});

test("entropy, maskValue and isFixturePath", () => {
  assert.ok(entropy(REAL) > 3);
  assert.ok(entropy("aaaa") < 1);
  // The shared format (findings.js), which the redactor leaves alone as already masked.
  assert.equal(maskValue("AKIAIOSFODNN7EXAMPLE"), "AKIA[redacted, 20 chars]");
  assert.ok(!maskValue(REAL).includes(REAL), "the raw value never appears in the mask");
  assert.equal(maskValue("abc"), "[redacted, 3 chars]");
  for (const p of ["test/x.js", "src/__tests__/a.js", "fixtures/keys.js", "config.example", ".env.example", "examples/app.js"]) assert.equal(isFixturePath(p), true, p);
  for (const p of ["src/db.js", "lib/config.js", "server.js"]) assert.equal(isFixturePath(p), false, p);
});

test("localRedact masks long tokens; resolveRedact prefers an injected function", async () => {
  assert.ok(!localRedact(`token=${REAL}`).includes(REAL));
  const injected = (t) => mark(t);
  assert.equal(await resolveRedact(injected), injected);
  assert.equal(typeof (await resolveRedact(null)), "function");
});

test("scanTree reads the working tree, masks the value, lowers fixture confidence and honours exclude", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "config.js"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
  fs.mkdirSync(path.join(root, "test", "fixtures"), { recursive: true });
  fs.writeFileSync(path.join(root, "test", "fixtures", "keys.js"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
  fs.mkdirSync(path.join(root, "vendor"), { recursive: true });
  fs.writeFileSync(path.join(root, "vendor", "lib.js"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
  fs.writeFileSync(path.join(root, "logo.png"), Buffer.from([0, 1, 2, 0, 3]));
  const files = ["config.js", "test/fixtures/keys.js", "vendor/lib.js", "logo.png"];
  const { candidates, scanned } = scanTree({ root, files, exclude: ["vendor/**"], redact: mark });
  assert.equal(scanned, 2, "the binary and the excluded file are not read");
  const real = candidates.find((c) => c.file === "config.js");
  const fixture = candidates.find((c) => c.file === "test/fixtures/keys.js");
  assert.ok(real && real.severity === "critical" && real.confidence >= 8);
  assert.ok(fixture && fixture.severity === "low" && fixture.confidence <= 3);
  assert.ok(!candidates.some((c) => c.file.startsWith("vendor/")), "exclude globs keep a file out");
  for (const c of candidates) {
    assert.ok(c.evidence.startsWith("[r]"), "evidence passed through the redactor");
    assert.ok(!c.evidence.includes("AKIAIOSFODNN7EXAMPLE"), "the raw secret never appears");
    assert.equal(c.tier, "A");
    assert.equal(c.kind, "security");
  }
});

test("scanHistoryText finds a secret added then removed, and never prints the value", () => {
  const log = [
    "@@C abc1234",
    "diff --git a/config.js b/config.js",
    "+++ b/config.js",
    `+const key = "AKIAIOSFODNN7EXAMPLE";`,
    "@@C def5678",
    "+++ b/config.js",
    `-const key = "AKIAIOSFODNN7EXAMPLE";`
  ].join("\n");
  const { candidates, commits } = scanHistoryText(log, mark);
  assert.equal(commits, 2);
  assert.equal(candidates.length, 1, "only the added line counts");
  assert.match(candidates[0].evidence, /commit abc1234/);
  assert.ok(!candidates[0].evidence.includes("AKIAIOSFODNN7EXAMPLE"));
  assert.match(candidates[0].fix, /rotate/i);
});

test("scanSensitiveAndGitignore flags tracked secret files and missing .gitignore coverage", () => {
  const root = tmp();
  const tracked = ["src/app.js", "deploy/server.pem", "backup/data.sql", ".env.example"];
  const noGi = scanSensitiveAndGitignore({ root, tracked, redact: mark });
  const files = noGi.candidates.filter((c) => c.category === "secrets").map((c) => c.file);
  assert.ok(files.includes("deploy/server.pem"));
  assert.ok(files.includes("backup/data.sql"));
  assert.ok(!files.includes(".env.example"), "an example file is not a secret");
  assert.ok(noGi.candidates.some((c) => c.category === "config" && /gitignore/i.test(c.evidence)), "no .gitignore is a config finding");

  fs.writeFileSync(path.join(root, ".gitignore"), "node_modules/\nsecrets/\n.env\n");
  const withGi = scanSensitiveAndGitignore({ root, tracked: ["src/app.js"], redact: mark });
  assert.ok(!withGi.candidates.some((c) => c.category === "config"), "secrets/ and .env covered: no config finding");
});

test("npm audit parsing and severity maps", () => {
  assert.deepEqual(["critical", "high", "moderate", "low", "info"].map(severityFromNpm), ["critical", "high", "medium", "low", "low"]);
  assert.deepEqual([9.1, 7, 4, 1].map(severityFromCvss), ["critical", "high", "medium", "low"]);
  const audit = JSON.stringify({ vulnerabilities: { lodash: { name: "lodash", severity: "high", range: "<4.17.21", fixAvailable: { version: "4.17.21" }, via: [{ title: "Prototype pollution", cwe: ["CWE-1321"], cvss: { vectorString: "CVSS:3.1/AV:N" } }] } } });
  const { candidates, ok } = parseNpmAudit(audit, mark);
  assert.equal(ok, true);
  assert.equal(candidates.length, 1);
  assert.deepEqual([candidates[0].severity, candidates[0].cwe, candidates[0].fixedVersion], ["high", "CWE-1321", "4.17.21"]);
  assert.match(candidates[0].evidence, /lodash/);
  assert.equal(parseNpmAudit("{}", mark).candidates.length, 0);
  assert.equal(parseNpmAudit("not json", mark).ok, false);
});

test("parseLockfilePackages handles requirements.txt, go.sum and Cargo.lock", () => {
  assert.deepEqual(parseLockfilePackages("requirements.txt", "flask==2.0.1\n# c\nrequests==2.25.0\nunpinned\n"), [{ name: "flask", version: "2.0.1" }, { name: "requests", version: "2.25.0" }]);
  const cargo = `[[package]]\nname = "serde"\nversion = "1.0.0"\n\n[[package]]\nname = "tokio"\nversion = "1.2.3"\n`;
  assert.deepEqual(parseLockfilePackages("Cargo.lock", cargo), [{ name: "serde", version: "1.0.0" }, { name: "tokio", version: "1.2.3" }]);
  const gosum = "github.com/pkg/errors v0.9.1 h1:abc=\ngithub.com/pkg/errors v0.9.1/go.mod h1:def=\n";
  assert.deepEqual(parseLockfilePackages("go.sum", gosum), [{ name: "github.com/pkg/errors", version: "v0.9.1" }]);
  assert.deepEqual(parseLockfilePackages("yarn.lock", "whatever"), [], "formats needing an external scanner yield nothing");
});

test("scanOsv queries the batch API through the injected fetch and reports only packages with vulns", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => { calls.push({ url, body: JSON.parse(opts.body) }); return { json: async () => ({ results: [{ vulns: [{ id: "GHSA-xxxx" }] }, {}] }) }; };
  const { candidates, queried } = await scanOsv({ fetchImpl, ecosystem: "PyPI", packages: [{ name: "flask", version: "2.0.1" }, { name: "requests", version: "2.25.0" }], file: "requirements.txt", redact: mark });
  assert.equal(queried, 2);
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].evidence, /flask 2\.0\.1.*GHSA-xxxx/);
  assert.equal(calls[0].url, "https://api.osv.dev/v1/querybatch");
  const errd = await scanOsv({ fetchImpl: async () => { throw new Error("offline"); }, ecosystem: "PyPI", packages: [{ name: "x", version: "1" }], file: "requirements.txt", redact: mark });
  assert.match(errd.error, /offline/);
  assert.equal((await scanOsv({ fetchImpl, ecosystem: "npm", packages: [], file: "x", redact: mark })).queried, 0);
});

test("scanLockfileHygiene flags a dependency resolved from outside the public registry", () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {
    "node_modules/ok": { resolved: "https://registry.npmjs.org/ok/-/ok-1.0.0.tgz" },
    "node_modules/sketchy": { resolved: "https://evil.example.test/sketchy.tgz" }
  } }));
  const { candidates, examined } = scanLockfileHygiene({ root, redact: mark });
  assert.ok(examined.includes("package-lock.json hygiene"));
  assert.equal(candidates.length, 1);
  assert.match(candidates[0].evidence, /sketchy/);
  assert.equal(scanLockfileHygiene({ root: tmp(), redact: mark }).candidates.length, 0, "no lockfile: nothing");
});

// ---------- orchestration ----------

// A command runner fake: answers git and npm from canned output, docker as unavailable.
function makeRun({ workingFiles = [], tracked = [], history = "", npmAudit = null } = {}) {
  const z = (arr) => arr.join("\0");
  return async (exe, args) => {
    const a = args.join(" ");
    if (exe === "git" && a.includes("ls-files -co")) return { ok: true, stdout: z(workingFiles), stderr: "" };
    if (exe === "git" && a.includes("ls-files -z")) return { ok: true, stdout: z(tracked), stderr: "" };
    if (exe === "git" && a.includes("log -p")) return { ok: true, stdout: history, stderr: "" };
    if (exe === "npm") return { ok: false, code: 1, stdout: npmAudit || "{}", stderr: "" };
    if (exe === "docker") return { ok: false, code: 127, stdout: "", stderr: "not found" };
    return { ok: false, stdout: "", stderr: `unexpected: ${exe} ${a}` };
  };
}

test("runSecurityScanners: secrets module scans tree, history, sensitive files, writes raw results, redacts, no raw secret anywhere", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "config.js"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
  fs.writeFileSync(path.join(root, "server.pem"), "-----BEGIN PRIVATE KEY-----\n");
  const sweepDir = path.join(root, ".autoclaude", "sweeps", "s1");
  const run = makeRun({
    workingFiles: ["config.js", "server.pem"],
    tracked: ["config.js", "server.pem"],
    history: ["@@C aaa1111", "+++ b/old.js", `+token = "${REAL}"`].join("\n")
  });
  const out = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["secrets"] }, sweepDir, run, redact: mark });
  const cats = out.candidates.map((c) => c.category);
  assert.ok(cats.includes("secrets"));
  assert.ok(out.candidates.some((c) => c.file === "config.js"));
  assert.ok(out.candidates.some((c) => c.file === "server.pem"), "tracked .pem is flagged");
  assert.ok(out.candidates.some((c) => /git history/.test(c.evidence) || c.file === "old.js"));
  assert.ok(out.coverage.examined.some((e) => /working tree/.test(e)));
  assert.ok(out.coverage.examined.some((e) => /git history/.test(e)));
  assert.ok(out.coverage.notExamined.some((n) => /gitleaks/.test(n)), "a missing external tool is 'not checked', never clean");
  const all = JSON.stringify(out);
  assert.ok(!all.includes("AKIAIOSFODNN7EXAMPLE") && !all.includes(REAL), "no raw secret in the result");
  assert.ok(fs.existsSync(path.join(sweepDir, "scanners", "secrets-tree.json")));
  assert.ok(fs.existsSync(path.join(sweepDir, "scanners", "secrets-history.json")));
  // deps was not requested, so no advisories work happened.
  assert.ok(!out.coverage.examined.some((e) => /advisor/i.test(e)));
});

test("runSecurityScanners: deps module runs npm audit, and respects advisories off", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  const npmAudit = JSON.stringify({ vulnerabilities: { lodash: { name: "lodash", severity: "critical", range: "<1", fixAvailable: { version: "1.2.3" }, via: [{ title: "x", cwe: ["CWE-1"] }] } } });
  const run = makeRun({ npmAudit });
  const sweepDir = path.join(root, ".autoclaude", "sweeps", "s2");
  const on = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["deps"], advisories: true }, sweepDir, run, redact: mark });
  assert.ok(on.candidates.some((c) => c.category === "deps" && c.severity === "critical"));
  assert.ok(on.coverage.examined.some((e) => /npm advisories/.test(e)));

  const off = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["deps"], advisories: false }, sweepDir, run, redact: mark });
  assert.ok(!off.candidates.some((c) => c.category === "deps" && c.severity === "critical"), "advisories off: no npm findings");
  assert.ok(off.coverage.notExamined.some((n) => /switched off/.test(n)));
});

test("runSecurityScanners: deps module uses OSV for a non-npm lockfile through the injected fetch", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "requirements.txt"), "flask==2.0.1\n");
  const fetchImpl = async () => ({ json: async () => ({ results: [{ vulns: [{ id: "GHSA-y" }] }] }) });
  const out = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["deps"], advisories: true }, sweepDir: path.join(root, ".autoclaude", "sweeps", "s3"), run: makeRun({}), fetchImpl, redact: mark });
  assert.ok(out.candidates.some((c) => c.category === "deps" && /flask/.test(c.evidence)));
  assert.ok(out.coverage.examined.some((e) => /OSV advisories/.test(e)));
});

test("runSecurityScanners: a git repo that cannot be read is 'not examined', not clean", async () => {
  const root = tmp();
  const run = async (exe, args) => (exe === "git" && args.join(" ").includes("ls-files -co") ? { ok: false, stdout: "", stderr: "not a repo" } : { ok: false, stdout: "", stderr: "" });
  const out = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["secrets"] }, sweepDir: path.join(root, ".autoclaude", "sweeps", "s4"), run, redact: mark });
  assert.ok(out.coverage.notExamined.some((n) => /not a git repository|git is unavailable/.test(n)));
});

// ---------- what "fix right away" may fix (D58) ----------

test("deterministic hits a change to the repository fixes are autoFixSafe; history secrets, majors and no-fix advisories are the owner's", () => {
  const audit = JSON.stringify({ vulnerabilities: {
    inrange: { severity: "high", range: "<1.2.4", fixAvailable: true, via: [{ title: "a" }] },
    minor: { severity: "high", range: "<2.3.0", fixAvailable: { name: "minor", version: "2.3.0", isSemVerMajor: false }, via: [{ title: "b" }] },
    major: { severity: "critical", range: "<4.0.0", fixAvailable: { name: "major", version: "4.0.0", isSemVerMajor: true }, via: [{ title: "c" }] },
    nofix: { severity: "low", range: "*", fixAvailable: false, via: [{ title: "d" }] }
  } });
  const by = Object.fromEntries(parseNpmAudit(audit, mark).candidates.map((c) => [c.anchor, c]));
  assert.deepEqual([by["pkg:npm:inrange"].autoFixSafe, by["pkg:npm:minor"].autoFixSafe, by["pkg:npm:major"].autoFixSafe, by["pkg:npm:nofix"].autoFixSafe], [true, true, false, false]);
  assert.equal(by["pkg:npm:minor"].fixedVersion, "2.3.0");
  assert.equal(by["pkg:npm:inrange"].fixedVersion, null, "npm names no version for an in-range fix");
  assert.match(by["pkg:npm:major"].ownerAction, /major upgrade/);
  assert.match(by["pkg:npm:nofix"].ownerAction, /No fixed version/);
  assert.equal(by["pkg:npm:minor"].ownerAction, undefined);

  const root = tmp();
  fs.writeFileSync(path.join(root, "config.js"), `const key = "AKIAIOSFODNN7EXAMPLE";\n`);
  const tree = scanTree({ root, files: ["config.js"], redact: mark }).candidates[0];
  assert.equal(tree.autoFixSafe, true, "moving a key out of the code is a change to the repository");
  assert.match(tree.ownerAction, /Rotate/);
  assert.match(tree.anchor, /^secret:aws-access-key:AKIA\[redacted, 20 chars\]$/);
  const hist = scanHistoryText(["@@C abc1234", "+++ b/config.js", `+const key = "AKIAIOSFODNN7EXAMPLE";`].join("\n"), mark).candidates[0];
  assert.equal(hist.autoFixSafe, false, "a secret in the history stays with the owner: rotate the key");
  assert.match(hist.ownerAction, /Rotate/);
  assert.equal(hist.commit, "abc1234");
  const tracked = scanSensitiveAndGitignore({ root, tracked: ["deploy/server.pem"], redact: mark }).candidates.find((c) => c.file === "deploy/server.pem");
  assert.equal(tracked.autoFixSafe, true);
  assert.match(tracked.ownerAction, /history/);
  for (const c of [tree, hist, tracked, ...Object.values(by)]) assert.ok(!JSON.stringify(c).includes("AKIAIOSFODNN7EXAMPLE"));
});

// ---------- gitleaks and osv-scanner from their images ----------

const LEAKED = "sk_" + "live_" + "Zq81mXvT0pLr5WcY3nKd";
const GITLEAKS_REPORT = JSON.stringify([
  { RuleID: "stripe-access-token", Description: "Stripe", StartLine: 3, File: "src/pay.js", Commit: "aaa1111bbbb2222cccc3333dddd4444eeee5555f", Secret: "REDACTED", Match: "const k = REDACTED", Author: "Dev", Email: "dev@example.test", Message: `add ${LEAKED}` },
  { RuleID: "generic-api-key", StartLine: 1, File: "test/fixtures/keys.js", Commit: "bbb2222cccc3333dddd4444eeee5555ffff6666a", Secret: "REDACTED", Match: "REDACTED" }
]);

const OSV_REPORT = JSON.stringify({ results: [
  { source: { path: "/src/package-lock.json", type: "lockfile" }, packages: [
    { package: { name: "lodash", version: "4.17.20", ecosystem: "npm" },
      vulnerabilities: [
        { id: "GHSA-aaaa", affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }], database_specific: { cwe_ids: ["CWE-1321"] }, severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L" }] },
        { id: "GHSA-bbbb", affected: [{ package: { name: "lodash", ecosystem: "npm" }, ranges: [{ type: "SEMVER", events: [{ introduced: "4.0.0" }, { fixed: "4.17.19" }, { introduced: "4.17.20" }, { fixed: "4.17.22" }] }] }] }
      ],
      groups: [{ ids: ["GHSA-aaaa"], max_severity: "7.4" }, { ids: ["GHSA-bbbb"], max_severity: "5.0" }] },
    { package: { name: "express", version: "3.0.0", ecosystem: "npm" }, vulnerabilities: [{ id: "GHSA-cccc", affected: [{ package: { name: "express" }, ranges: [{ events: [{ introduced: "0" }, { fixed: "4.0.0" }] }] }] }], groups: [{ max_severity: "9.8" }] },
    { package: { name: "clean", version: "1.0.0", ecosystem: "npm" } }
  ] },
  { source: { path: "/src/api/requirements.txt" }, packages: [
    { package: { name: "flask", version: "2.0.1", ecosystem: "PyPI" }, vulnerabilities: [{ id: "PYSEC-1", affected: [{ ranges: [{ events: [{ introduced: "0" }] }] }] }] }
  ] }
] });

test("gitleaks and osv-scanner: pinned images, the project mounted read-only, gitleaks without network", () => {
  const root = path.join(tmp(), "my app");
  const g = gitleaksArgs(root);
  assert.deepEqual(g.slice(0, 5), ["run", "--rm", "--network", "none", "--mount"]);
  assert.equal(g[5], `type=bind,source=${path.resolve(root)},target=/repo,readonly`);
  assert.ok(g.includes(GITLEAKS_IMAGE) && /:v\d+\.\d+\.\d+$/.test(GITLEAKS_IMAGE), "a pinned tag, never latest");
  assert.ok(g.includes("--redact") && g.join(" ").includes("--report-path -"));
  const o = osvScannerArgs(root);
  assert.ok(o.includes(OSV_SCANNER_IMAGE) && /:v\d+\.\d+\.\d+$/.test(OSV_SCANNER_IMAGE));
  assert.ok(o.some((a) => /,readonly$/.test(a) && a.includes("target=/src")));
  assert.match(readOnlyMount("C:\\a,b", "/x"), /"source=.*a,b",target=\/x,readonly$/, "a comma in the path is quoted");
  assert.equal(readOnlyMount("/a\"b", "/x"), null);
});

test("parseGitleaks reads rule, file, line and commit only; parseOsvScanner finds the version that fixes every advisory", () => {
  const gl = parseGitleaks(GITLEAKS_REPORT, mark);
  assert.equal(gl.ok, true);
  assert.equal(gl.candidates.length, 2);
  const real = gl.candidates[0];
  assert.deepEqual([real.category, real.severity, real.file, real.commit, real.autoFixSafe], ["secrets", "high", "src/pay.js", "aaa1111bbbb2222cccc3333dddd4444eeee5555f", false]);
  assert.match(real.evidence, /gitleaks rule stripe-access-token matched in git history at commit aaa1111bbbb2 in src\/pay\.js line 3/);
  assert.match(real.ownerAction, /Rotate/);
  assert.equal(gl.candidates[1].severity, "low", "a fixture path is low");
  const text = JSON.stringify(gl);
  for (const leak of [LEAKED, "dev@example.test", "Dev", "const k"]) assert.ok(!text.includes(leak), leak);
  assert.deepEqual(parseGitleaks("", mark), { ok: true, candidates: [] });
  assert.equal(parseGitleaks("not json", mark).ok, false);

  const osv = parseOsvScanner(OSV_REPORT, mark);
  assert.equal(osv.ok, true);
  assert.equal(osv.packages, 4);
  const by = Object.fromEntries(osv.candidates.map((c) => [c.anchor, c]));
  const lodash = by["pkg:npm:lodash"];
  assert.deepEqual([lodash.file, lodash.severity, lodash.cwe, lodash.fixedVersion, lodash.autoFixSafe], ["package-lock.json", "high", "CWE-1321", "4.17.22", true]);
  assert.match(lodash.evidence, /lodash 4\.17\.20 \(npm\) has 2 advisories: GHSA-aaaa, GHSA-bbbb/);
  assert.deepEqual([by["pkg:npm:express"].severity, by["pkg:npm:express"].fixedVersion, by["pkg:npm:express"].autoFixSafe], ["critical", "4.0.0", false], "a major upgrade is the owner's");
  assert.deepEqual([by["pkg:pypi:flask"].file, by["pkg:pypi:flask"].fixedVersion, by["pkg:pypi:flask"].autoFixSafe], ["api/requirements.txt", null, false]);
  assert.equal(by["pkg:npm:clean"], undefined);
  assert.equal(parseOsvScanner("No package sources found", mark).ok, false);
  assert.deepEqual([compareVersions("4.17.21", "4.17.3"), compareVersions("v1.0.0", "1.0.0-rc.1"), compareVersions("1.2", "1.2.0"), compareVersions("1.0.0-rc.2", "1.0.0-rc.10"), compareVersions("2.0.0", "10.0.0")], [1, 1, 0, -1, -1]);
  assert.deepEqual([isMajorUpgrade("4.17.20", "4.17.22"), isMajorUpgrade("3.0.0", "4.0.0"), isMajorUpgrade("0.3.1", "0.4.0"), isMajorUpgrade("0.3.1", "0.3.2")], [false, true, true, false]);
});

// A command runner fake with a working Docker: git and npm from canned output, the two images
// from the reports above. Records every docker call.
function dockerRun({ history = "", npmAudit = null, gitleaks = GITLEAKS_REPORT, osv = OSV_REPORT, osvCode = 1 } = {}) {
  const calls = [];
  const fn = async (exe, args) => {
    const a = args.join(" ");
    if (exe === "docker") {
      calls.push(args);
      if (args[0] === "version") return { ok: true, code: 0, stdout: "29.8.0\n", stderr: "" };
      if (args.includes(GITLEAKS_IMAGE)) return { ok: true, code: 0, stdout: gitleaks, stderr: "" };
      if (args.includes(OSV_SCANNER_IMAGE)) return { ok: osvCode === 0, code: osvCode, stdout: osv, stderr: "" };
    }
    if (exe === "git" && a.includes("ls-files")) return { ok: true, stdout: "", stderr: "" };
    if (exe === "git" && a.includes("log -p")) return { ok: true, stdout: history, stderr: "" };
    if (exe === "npm") return { ok: false, code: 1, stdout: npmAudit || "{}", stderr: "" };
    return { ok: false, stdout: "", stderr: `unexpected: ${exe} ${a}` };
  };
  return { fn, calls };
}

test("runSecurityScanners runs gitleaks and osv-scanner when Docker answers, and reports each hit once", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  fs.writeFileSync(path.join(root, "requirements.txt"), "flask==2.0.1\n");
  // The same secret our own history scan sees, in the commit and file gitleaks reports it in.
  const history = ["@@C aaa1111bbbb2222cccc3333dddd4444eeee5555f", "+++ b/src/pay.js", `+const k = "AKIAIOSFODNN7EXAMPLE";`, "@@C 9999999", "+++ b/other.js", `+const k = "AKIAIOSFODNN7EXAMPLE";`].join("\n");
  const npmAudit = JSON.stringify({ vulnerabilities: { lodash: { severity: "high", range: "<4.17.22", fixAvailable: true, via: [{ title: "x" }] } } });
  const { fn, calls } = dockerRun({ history, npmAudit });
  let fetched = 0;
  const sweepDir = path.join(root, ".autoclaude", "sweeps", "s9");
  const out = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["secrets", "deps"], advisories: true }, sweepDir, run: fn, fetchImpl: async () => { fetched++; throw new Error("not needed"); }, redact: mark });
  assert.equal(calls.filter((c) => c[0] === "version").length, 1, "Docker is asked once");
  assert.ok(out.coverage.examined.some((e) => /gitleaks/.test(e) && e.includes(GITLEAKS_IMAGE)));
  assert.ok(out.coverage.examined.some((e) => /osv-scanner/.test(e) && e.includes(OSV_SCANNER_IMAGE)));
  assert.ok(!out.coverage.notExamined.some((n) => /gitleaks|osv-scanner/.test(n)), JSON.stringify(out.coverage.notExamined));
  const secrets = out.candidates.filter((c) => c.category === "secrets");
  assert.equal(secrets.filter((c) => c.file === "src/pay.js").length, 1, "the gitleaks hit replaces our own for the same commit and file");
  assert.equal(secrets.filter((c) => c.file === "other.js").length, 1, "our own hit elsewhere stays");
  assert.equal(fetched, 0, "osv-scanner covered requirements.txt: no OSV batch query");
  assert.ok(out.candidates.some((c) => c.anchor === "pkg:pypi:flask"));
  assert.equal(out.candidates.filter((c) => c.anchor === "pkg:npm:lodash").length, 2, "npm audit and osv-scanner meet on one anchor (dedupe merges them)");
  const raw = JSON.parse(fs.readFileSync(path.join(sweepDir, "scanners", "gitleaks.json"), "utf8"));
  assert.deepEqual([raw.ran, raw.hits], [true, 2]);
  assert.ok(!JSON.stringify(out).includes("AKIAIOSFODNN7EXAMPLE") && !JSON.stringify(out).includes(LEAKED));
});

test("runSecurityScanners: without Docker both are not checked; advisories off leaves osv-scanner off; a failed image run is not checked", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "package-lock.json"), JSON.stringify({ packages: {} }));
  const noDocker = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["secrets", "deps"], advisories: true }, sweepDir: path.join(root, "s1"), run: makeRun({}), redact: mark });
  assert.ok(noDocker.coverage.notExamined.some((n) => /^gitleaks over the git history \(not checked: Docker is not running/.test(n)));
  assert.ok(noDocker.coverage.notExamined.some((n) => /^osv-scanner \(not checked: Docker is not running/.test(n)));

  const { fn, calls } = dockerRun({});
  const off = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["deps"], advisories: false }, sweepDir: path.join(root, "s2"), run: fn, redact: mark });
  assert.ok(!calls.some((c) => c.includes(OSV_SCANNER_IMAGE)), "advisories off: no osv-scanner (it would send package names out)");
  assert.ok(off.coverage.notExamined.some((n) => /osv-scanner \(not checked: switched off/.test(n)));

  const broken = dockerRun({ gitleaks: "panic: boom", osv: "", osvCode: 127 });
  const failed = await runSecurityScanners({ root, env: { PATH: "" }, options: { modules: ["secrets", "deps"], advisories: true }, sweepDir: path.join(root, "s3"), run: broken.fn, fetchImpl: async () => ({ json: async () => ({ results: [] }) }), redact: mark });
  assert.ok(failed.coverage.notExamined.some((n) => /^gitleaks over the git history \(not checked: it did not run/.test(n)));
  assert.ok(failed.coverage.notExamined.some((n) => /^osv-scanner \(not checked: it did not run/.test(n)));
});
