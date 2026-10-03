import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import {
  originOf, authorityOrigin, isAllowed, normaliseAllow, startAllowListProxy, allowRules, methodRefusal,
  checkSecurityHeaders, checkCookies, checkCors, checkExposedFiles, checkVerboseErrors,
  checkAuthBypass, checkRateLimit, runHttpProbe
} from "../../plugins/autoclaude/lib/probe.js";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-probe-"));
const mark = (t) => `[r]${t}`;

// A minimal fetch Response double.
function res({ status = 200, headers = {}, body = "" } = {}) {
  const h = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    status,
    headers: {
      get: (n) => (h.has(String(n).toLowerCase()) ? h.get(String(n).toLowerCase()) : null),
      getSetCookie: () => { const v = h.get("set-cookie"); return Array.isArray(v) ? v : v ? [v] : []; }
    },
    arrayBuffer: async () => Buffer.from(body, "utf8")
  };
}

test("originOf, authorityOrigin, isAllowed and normaliseAllow", () => {
  assert.equal(originOf("http://127.0.0.1:4173/x?y=1"), "127.0.0.1:4173");
  assert.equal(originOf("https://staging.example.test/path"), "staging.example.test:443");
  assert.equal(originOf("http://EXAMPLE.test"), "example.test:80");
  assert.equal(originOf("127.0.0.1:4173"), "127.0.0.1:4173");
  assert.equal(originOf(""), null);
  assert.equal(authorityOrigin("staging.example.test:443"), "staging.example.test:443");
  assert.equal(authorityOrigin("nonsense"), null);
  const allow = ["http://127.0.0.1:4173", "staging.example.test:443"];
  assert.equal(isAllowed("http://127.0.0.1:4173/a", allow), true);
  assert.equal(isAllowed("https://staging.example.test/a", allow), true);
  assert.equal(isAllowed("http://127.0.0.1:5000/a", allow), false, "a different port is a different origin");
  assert.equal(isAllowed("http://evil.test/a", allow), false);
  assert.deepEqual([...normaliseAllow(allow)].sort(), ["127.0.0.1:4173", "staging.example.test:443"]);
});

// A raw HTTP exchange through the proxy, so no real client proxy support is needed.
function proxyRequest(proxyPort, absoluteUrl) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => {
      const { hostname, port } = new URL(absoluteUrl);
      sock.write(`GET ${absoluteUrl} HTTP/1.1\r\nHost: ${hostname}:${port}\r\nConnection: close\r\n\r\n`);
    });
    let data = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => { data += d; });
    sock.on("end", () => resolve(data));
    sock.on("error", reject);
  });
}

test("startAllowListProxy forwards an allowed origin, refuses another, and logs both", async () => {
  const target = http.createServer((req, res2) => { res2.writeHead(200, { "content-type": "text/plain" }); res2.end("hello from target"); });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const targetPort = target.address().port;
  const other = http.createServer((req, res2) => { res2.end("should never be reached"); });
  await new Promise((r) => other.listen(0, "127.0.0.1", r));
  const otherPort = other.address().port;

  const logFile = path.join(tmp(), "proxy.log");
  const proxy = await startAllowListProxy({ allow: [`127.0.0.1:${targetPort}`], logFile });
  try {
    const okResp = await proxyRequest(proxy.port, `http://127.0.0.1:${targetPort}/ok`);
    assert.match(okResp, /200/);
    assert.match(okResp, /hello from target/);
    const blocked = await proxyRequest(proxy.port, `http://127.0.0.1:${otherPort}/nope`);
    assert.match(blocked, /403/);
    assert.doesNotMatch(blocked, /should never be reached/);
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, new RegExp(`ALLOW GET 127\\.0\\.0\\.1:${targetPort}`));
    assert.match(log, new RegExp(`REFUSE GET 127\\.0\\.0\\.1:${otherPort}`));
  } finally {
    await proxy.close();
    await new Promise((r) => target.close(r));
    await new Promise((r) => other.close(r));
  }
});

test("startAllowListProxy refuses a CONNECT to an off-list authority and logs it", async () => {
  const logFile = path.join(tmp(), "proxy.log");
  const proxy = await startAllowListProxy({ allow: ["127.0.0.1:4173"], logFile });
  try {
    const resp = await new Promise((resolve, reject) => {
      const sock = net.connect(proxy.port, "127.0.0.1", () => sock.write("CONNECT evil.test:443 HTTP/1.1\r\nHost: evil.test:443\r\n\r\n"));
      let data = "";
      sock.setEncoding("utf8");
      sock.on("data", (d) => { data += d; });
      sock.on("close", () => resolve(data));
      sock.on("error", reject);
    });
    assert.match(resp, /403 Forbidden/);
    assert.match(fs.readFileSync(logFile, "utf8"), /REFUSE CONNECT evil\.test:443/);
  } finally {
    await proxy.close();
  }
});

// One raw exchange with the proxy: whatever request text is given, the whole answer back.
function rawProxy(proxyPort, text) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, "127.0.0.1", () => sock.write(text));
    let data = "";
    sock.setEncoding("utf8");
    sock.on("data", (d) => { data += d; });
    sock.on("close", () => resolve(data));
    sock.on("error", reject);
  });
}

test("allowRules: bare origins and readonly targets take GET and HEAD only; full targets every method only with writes allowed", () => {
  const rules = allowRules([
    "http://127.0.0.1:4173",
    { url: "https://staging.example.test", mode: "full" },
    { url: "http://127.0.0.1:5000", mode: "readonly" },
    { origin: "127.0.0.1:6000", methods: ["GET", "HEAD"], also: [{ method: "post", path: "/login" }] },
    { origin: "127.0.0.1:7000", methods: "*" }
  ]);
  assert.deepEqual([...rules.keys()], ["127.0.0.1:4173", "staging.example.test:443", "127.0.0.1:5000", "127.0.0.1:6000", "127.0.0.1:7000"]);
  assert.equal(rules.get("staging.example.test:443").any, false, "full without writes allowed is read-only");
  assert.equal(allowRules([{ url: "https://staging.example.test", mode: "full" }], { writesAllowed: true }).get("staging.example.test:443").any, true);
  assert.equal(methodRefusal(rules.get("127.0.0.1:4173"), "GET", "/"), null);
  assert.equal(methodRefusal(rules.get("127.0.0.1:4173"), "head", "/"), null);
  for (const m of ["POST", "PUT", "DELETE", "PATCH", "OPTIONS"]) assert.match(methodRefusal(rules.get("127.0.0.1:5000"), m, "/x"), /not allowed here/, m);
  assert.equal(methodRefusal(rules.get("127.0.0.1:6000"), "POST", "/login"), null, "the named exception");
  assert.match(methodRefusal(rules.get("127.0.0.1:6000"), "POST", "/login/other"), /not allowed/);
  assert.match(methodRefusal(rules.get("127.0.0.1:4173"), "GET", "/x", { "X-HTTP-Method-Override": "DELETE" }), /method-override header/);
  assert.equal(methodRefusal(rules.get("127.0.0.1:7000"), "DELETE", "/x"), null);
  assert.equal(methodRefusal(undefined, "GET", "/"), "not on the allow-list");
});

test("startAllowListProxy enforces the method rules: a read-only origin gets no POST, DELETE or tunnel, a full one does; every refusal is logged", async () => {
  const seen = [];
  const target = http.createServer((req, res2) => { seen.push(`${req.method} ${req.url}`); res2.writeHead(200); res2.end("ok"); });
  await new Promise((r) => target.listen(0, "127.0.0.1", r));
  const port = target.address().port;
  const writable = http.createServer((req, res2) => { seen.push(`W ${req.method} ${req.url}`); res2.writeHead(200); res2.end("ok"); });
  await new Promise((r) => writable.listen(0, "127.0.0.1", r));
  const wport = writable.address().port;
  const logFile = path.join(tmp(), "proxy.log");
  const proxy = await startAllowListProxy({ allow: [{ url: `http://127.0.0.1:${port}`, mode: "readonly" }, { url: `http://127.0.0.1:${wport}`, mode: "full" }], writesAllowed: true, logFile });
  const req = (method, p, extra = "", body = "") => `${method} ${p} HTTP/1.1\r\nHost: x\r\nConnection: close\r\n${extra}Content-Length: ${body.length}\r\n\r\n${body}`;
  try {
    assert.match(await rawProxy(proxy.port, req("GET", `http://127.0.0.1:${port}/orders/42?token=hunter2hunter2`)), /200/);
    assert.match(await rawProxy(proxy.port, req("POST", `http://127.0.0.1:${port}/orders/42/cancel`, "", "x=1")), /403/);
    assert.match(await rawProxy(proxy.port, req("DELETE", `http://127.0.0.1:${port}/users/7`)), /403/);
    assert.match(await rawProxy(proxy.port, req("GET", `http://127.0.0.1:${port}/users/7`, "X-HTTP-Method-Override: DELETE\r\n")), /403/);
    assert.match(await rawProxy(proxy.port, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`), /403 Forbidden/);
    assert.match(await rawProxy(proxy.port, req("POST", `http://127.0.0.1:${wport}/orders`, "", "x=1")), /200/, "a full origin with writes allowed takes a POST");
    assert.deepEqual(seen, ["GET /orders/42?token=hunter2hunter2", "W POST /orders"], "nothing refused reached a server");
    const log = fs.readFileSync(logFile, "utf8");
    assert.match(log, new RegExp(`REFUSE POST 127\\.0\\.0\\.1:${port} /orders/42/cancel \\(POST is not allowed here`));
    assert.match(log, new RegExp(`REFUSE DELETE 127\\.0\\.0\\.1:${port} /users/7`));
    assert.match(log, /method-override header/);
    assert.match(log, new RegExp(`REFUSE CONNECT 127\\.0\\.0\\.1:${port} \\(a read-only origin`));
    assert.match(log, /ALLOW GET 127\.0\.0\.1:\d+ \/orders\/42\?\[query not logged\]/);
    assert.ok(!log.includes("hunter2"), "a query string never reaches the log");
  } finally {
    await proxy.close();
    await new Promise((r) => target.close(r));
    await new Promise((r) => writable.close(r));
  }
});

test("runHttpProbe: a readonly target's probes are GET only, through the same rules; probe findings are autoFixSafe with stable anchors", async () => {
  const { fn, calls } = fakeFetch({
    "GET /": res({ status: 200, headers: { "set-cookie": ["session=x; Path=/"], "access-control-allow-origin": "https://autoclaude-sweep-probe.example", "access-control-allow-credentials": "true" }, body: "home" }),
    "/.env": res({ status: 200, body: "DB_PASSWORD=x\n" }),
    "/admin": res({ status: 200, body: "admin" }),
    "*": res({ status: 500, body: "Error\n    at Object.handler (/home/app/server.js:42:13)" })
  });
  const out = await runHttpProbe({ targets: [{ url: "http://127.0.0.1:4173", mode: "full" }], tests: {}, writesAllowed: false, fetchImpl: fn, map: { protectedRoutes: ["/admin"], loginPath: "/login" }, redact: mark });
  assert.ok(calls.every((c) => c.method === "GET"), "full mode without writes allowed: still GET only");
  const byCat = (c) => out.candidates.filter((f) => f.category === c);
  for (const c of ["headers", "cookies", "cors", "exposure", "errors", "authz"]) {
    assert.ok(byCat(c).length, c);
    for (const f of byCat(c)) {
      assert.equal(f.autoFixSafe, true, `${c}: a change to the app fixes it`);
      assert.match(f.anchor, /^[a-z-]+:/, c);
    }
  }
  const env = byCat("exposure").find((f) => f.file.endsWith("/.env"));
  assert.match(env.ownerAction, /Rotate every value/);
  assert.deepEqual(byCat("headers").map((f) => f.anchor).sort(), ["header:content-security-policy", "header:frame-options", "header:referrer-policy", "header:x-content-type-options"]);
});

test("checkSecurityHeaders flags the missing ones and passes a fully-hardened response", () => {
  const bad = checkSecurityHeaders(res({ headers: {} }), "http://x/", false, mark);
  const cats = bad.map((f) => f.evidence);
  assert.ok(bad.some((f) => /Content-Security-Policy/.test(f.evidence)));
  assert.ok(bad.some((f) => /X-Frame-Options/.test(f.evidence)));
  assert.ok(bad.some((f) => /nosniff/.test(f.evidence)));
  assert.ok(bad.some((f) => /Referrer-Policy/.test(f.evidence)));
  assert.ok(!bad.some((f) => /Strict-Transport-Security/.test(f.evidence)), "HSTS only matters on https");
  void cats;
  const httpsBad = checkSecurityHeaders(res({ headers: {} }), "https://x/", true, mark);
  assert.ok(httpsBad.some((f) => /Strict-Transport-Security/.test(f.evidence)));
  const good = checkSecurityHeaders(res({ headers: {
    "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
    "strict-transport-security": "max-age=63072000",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin"
  } }), "https://x/", true, mark);
  assert.deepEqual(good, [], "frame-ancestors in the CSP counts for clickjacking");
  assert.ok(bad.every((f) => f.evidence.startsWith("[r]")));
});

test("checkCookies flags missing flags and masks the cookie name", () => {
  const out = checkCookies(res({ headers: { "set-cookie": ["session=abcdef; Path=/"] } }), "https://x/", true, mark);
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /HttpOnly, Secure, SameSite/);
  assert.ok(!out[0].evidence.includes("abcdef"), "the cookie value never appears");
  const ok = checkCookies(res({ headers: { "set-cookie": ["s=x; HttpOnly; Secure; SameSite=Lax"] } }), "https://x/", true, mark);
  assert.deepEqual(ok, []);
});

test("checkCors flags reflected origin with credentials and a wildcard with credentials", () => {
  const reflected = checkCors(res({ headers: { "access-control-allow-origin": "https://evil.test", "access-control-allow-credentials": "true" } }), "http://x/", "https://evil.test", mark);
  assert.equal(reflected.length, 1);
  assert.equal(reflected[0].severity, "high");
  const wildcard = checkCors(res({ headers: { "access-control-allow-origin": "*", "access-control-allow-credentials": "true" } }), "http://x/", "https://evil.test", mark);
  assert.equal(wildcard.length, 1);
  const fine = checkCors(res({ headers: { "access-control-allow-origin": "https://trusted.test" } }), "http://x/", "https://evil.test", mark);
  assert.deepEqual(fine, []);
});

// A fetch double dispatching on path+method; records every URL requested.
function fakeFetch(routes) {
  const calls = [];
  const fn = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || "GET", headers: opts.headers || {} });
    const u = new URL(url);
    const key = `${opts.method || "GET"} ${u.pathname}`;
    const handler = routes[key] || routes[u.pathname] || routes["*"];
    if (!handler) return res({ status: 404, body: "not found" });
    return typeof handler === "function" ? handler({ url, opts }) : handler;
  };
  return { fn, calls };
}

test("checkExposedFiles flags a served .git and .env and a source map", async () => {
  const base = "http://127.0.0.1:4173";
  const allow = ["127.0.0.1:4173"];
  const logFile = path.join(tmp(), "proxy.log");
  const { fn } = fakeFetch({
    "/.git/HEAD": res({ status: 200, body: "ref: refs/heads/main\n" }),
    "/.env": res({ status: 200, body: "SECRET_KEY=abc\nDB=postgres\n" }),
    "GET /": res({ status: 200, body: `<script src="/app.js"></script>\n//# sourceMappingURL=/app.js.map` }),
    "/app.js.map": res({ status: 200, body: `{"version":3,"sources":["a.js"],"mappings":"AAAA"}` })
  });
  const out = await checkExposedFiles({ base, allow, fetchImpl: fn, logFile, redact: mark });
  assert.ok(out.some((f) => /\.git/.test(f.file)));
  assert.ok(out.some((f) => f.file.endsWith("/.env")));
  assert.ok(out.some((f) => /source map/.test(f.evidence)));
  assert.match(fs.readFileSync(logFile, "utf8"), /ALLOW GET 127\.0\.0\.1:4173/);
});

test("checkVerboseErrors flags a leaked stack trace", async () => {
  const { fn } = fakeFetch({ "*": res({ status: 500, body: "Error\n    at Object.handler (/home/app/server.js:42:13)" }) });
  const out = await checkVerboseErrors({ base: "http://127.0.0.1:4173", allow: ["127.0.0.1:4173"], fetchImpl: fn, redact: mark });
  assert.equal(out.length, 1);
  assert.equal(out[0].cwe, "CWE-209");
  const clean = await checkVerboseErrors({ base: "http://127.0.0.1:4173", allow: ["127.0.0.1:4173"], fetchImpl: fakeFetch({ "*": res({ status: 404, body: "Not found" }) }).fn, redact: mark });
  assert.deepEqual(clean, []);
});

test("checkAuthBypass flags a protected route that answers 200 without a login", async () => {
  const map = { protectedRoutes: ["/admin", "/account", "/public-ok"] };
  const { fn } = fakeFetch({
    "GET /admin": res({ status: 200, body: "admin panel" }),
    "GET /account": res({ status: 302, headers: { location: "/login" } }),
    "GET /public-ok": res({ status: 401, body: "" })
  });
  const out = await checkAuthBypass({ base: "http://127.0.0.1:4173", map, allow: ["127.0.0.1:4173"], fetchImpl: fn, redact: mark });
  assert.equal(out.length, 1);
  assert.match(out[0].evidence, /\/admin answered with 200/);
  assert.equal(out[0].cwe, "CWE-862");
});

test("checkRateLimit: a finding only when nothing ever returns 429", async () => {
  const full = [{ origin: "127.0.0.1:4173", methods: "*" }];
  const never = fakeFetch({ "POST /login": res({ status: 401, body: "" }) });
  const flagged = await checkRateLimit({ base: "http://127.0.0.1:4173", map: { loginPath: "/login" }, allow: full, fetchImpl: never.fn, redact: mark, attempts: 5 });
  assert.equal(flagged.length, 1);
  assert.equal(flagged[0].cwe, "CWE-307");
  assert.equal(never.calls.filter((c) => c.method === "POST").length, 5);
  let n = 0;
  const limited = fakeFetch({ "POST /login": () => res({ status: n++ >= 2 ? 429 : 401 }) });
  assert.deepEqual(await checkRateLimit({ base: "http://127.0.0.1:4173", map: { loginPath: "/login" }, allow: full, fetchImpl: limited.fn, redact: mark, attempts: 5 }), []);
  assert.deepEqual(await checkRateLimit({ base: "http://x", map: {}, allow: [], fetchImpl: never.fn, redact: mark }), [], "no login path: skipped");
  // A bare origin is read-only: not one POST leaves, and each refusal is logged.
  const logFile = path.join(tmp(), "proxy.log");
  const readOnly = fakeFetch({ "POST /login": res({ status: 401 }) });
  assert.deepEqual(await checkRateLimit({ base: "http://127.0.0.1:4173", map: { loginPath: "/login" }, allow: ["127.0.0.1:4173"], fetchImpl: readOnly.fn, logFile, redact: mark, attempts: 5 }), []);
  assert.equal(readOnly.calls.length, 0);
  assert.match(fs.readFileSync(logFile, "utf8"), /REFUSE POST 127\.0\.0\.1:4173 \/login \(POST is not allowed here \(only GET, HEAD\)\)/);
});

test("runHttpProbe runs the readonly checks over the targets and never POSTs without writes allowed", async () => {
  const logFile = path.join(tmp(), "proxy.log");
  const { fn, calls } = fakeFetch({
    "GET /": res({ status: 200, headers: { "set-cookie": ["session=x; Path=/"] }, body: "home" }),
    "/.git/HEAD": res({ status: 404 }),
    "/.env": res({ status: 404 }),
    "*": res({ status: 404, body: "nf" })
  });
  const out = await runHttpProbe({
    targets: [{ url: "http://127.0.0.1:4173", mode: "readonly" }],
    tests: { rateLimit: true, authBypass: true },
    writesAllowed: false,
    logFile, fetchImpl: fn,
    map: { protectedRoutes: ["/admin"], loginPath: "/login" },
    redact: mark
  });
  assert.ok(out.candidates.some((c) => c.category === "headers"));
  assert.ok(out.candidates.some((c) => c.category === "cookies"));
  assert.ok(out.coverage.examined.some((e) => /security headers/.test(e)));
  assert.equal(calls.filter((c) => c.method === "POST").length, 0, "no writes in readonly mode");
  assert.ok(out.coverage.notExamined.some((n) => /login rate limiting/.test(n)), "rate limiting needs writes + full mode");
  // Every request that happened targeted the one allowed origin.
  assert.ok(calls.every((c) => new URL(c.url).host === "127.0.0.1:4173"));
});

test("runHttpProbe: a switched-off test is reported not examined, and writes run only in full mode with writes allowed", async () => {
  const { fn, calls } = fakeFetch({
    "GET /": res({ status: 200, body: "home" }),
    "POST /login": res({ status: 401 }),
    "*": res({ status: 404 })
  });
  const out = await runHttpProbe({
    targets: [{ url: "http://127.0.0.1:4173", mode: "full" }],
    tests: { headers: false, rateLimit: true },
    writesAllowed: true,
    fetchImpl: fn,
    map: { loginPath: "/login" },
    redact: mark
  });
  assert.ok(out.coverage.notExamined.some((n) => /security headers \(switched off\)/.test(n)));
  assert.ok(!out.coverage.examined.some((e) => /security headers/.test(e)));
  assert.ok(calls.some((c) => c.method === "POST"), "full mode + writes allowed: the login rate-limit check runs");
});
