// The security sweep's live layer (PLAN.md P10.5, D58): a Node forward proxy that lets the
// browser reach only the sweep's targets, and direct HTTP probes that use the same allow-list.
// Node http/net and the global fetch only, no dependencies.
//
// Safety boundary. Playwright MCP's own --allowed-origins is documented as "not a security
// boundary", so the real boundary is this proxy: the browser is launched with
// --proxy-server pointing here (tester.js mcpConfigFor), and every request it makes, including a
// redirect, passes through here and is allowed only when its origin (host:port) is on the list.
// Every request is logged, allowed or refused, so the proxy log is the evidence that the sweep
// never reached anything it should not have. The direct probes check the same list themselves
// and never follow a redirect to an origin that is not on it.
//
// Read-only by default, for the browser and the probes alike: every origin carries a method rule
// (allowRules). A read-only origin (a target in mode "readonly", a full one while writes are not
// allowed, or a bare origin) accepts GET and HEAD only, so a form post, a login or a delete never
// reaches it; the owner's rule may name single exceptions (the login form). Inside an https
// tunnel the method cannot be seen, so a read-only origin gets no CONNECT at all. Every refusal
// is logged. Writes (repeated login attempts for rate limiting, the browser's form posts) reach
// only an origin in mode "full" with writesAllowed, which the sweep sets after the owner confirms
// the data is throwaway.
import http from "node:http";
import net from "node:net";
import { URL } from "node:url";
import fs from "node:fs";
import { resolveRedact, maskValue } from "./scan-security.js";

// The origin of a URL as host:port, with the default port filled in for http/https. Returns null
// when the input cannot be parsed. Hosts are lower-cased; the port is always explicit.
export function originOf(urlOrHost) {
  const s = String(urlOrHost || "").trim();
  if (!s) return null;
  let u;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`);
  } catch { return null; }
  const port = u.port || (u.protocol === "https:" ? "443" : u.protocol === "http:" ? "80" : "");
  if (!u.hostname || !port) return null;
  return `${u.hostname.toLowerCase()}:${port}`;
}

// A CONNECT authority ("host:port", no scheme) as a host:port origin, with no default to invent.
export function authorityOrigin(authority) {
  const s = String(authority || "").trim();
  const m = s.match(/^\[?([^\]]+?)\]?:(\d+)$/);
  if (!m) return null;
  return `${m[1].toLowerCase()}:${m[2]}`;
}

// True when a URL's origin is on the allow-list (whatever methods it allows). `allow` is a list
// of entries allowRules reads. The comparison is exact on host and port.
export function isAllowed(url, allow) {
  const origin = originOf(url);
  if (!origin) return false;
  const set = normaliseAllow(allow);
  return set.has(origin);
}

// The origins of an allow-list, whatever form its entries take.
export function normaliseAllow(allow) {
  return new Set(allowRules(allow).keys());
}

export const READ_METHODS = Object.freeze(["GET", "HEAD"]);
// Headers some frameworks read as the real method of a request: refused on a read-only origin,
// so a GET cannot stand in for a POST.
const METHOD_OVERRIDE_HEADERS = Object.freeze(["x-http-method-override", "x-http-method", "x-method-override"]);

function entryOrigin(e) {
  if (typeof e === "string") return originOf(e) || authorityOrigin(e);
  if (!e || typeof e !== "object") return null;
  const s = e.origin || e.url;
  return typeof s === "string" ? originOf(s) || authorityOrigin(s) : null;
}

// The allow-list as rules: Map origin -> { any, methods (a Set, upper case), also: [{ method,
// path }] }. Entries:
//   "http://host:port", "host:port"            read-only: GET and HEAD (fail closed)
//   { url | origin, mode: "readonly" | "full" } a sweep target: "full" allows every method only
//                                               with writesAllowed, else read-only
//   { origin | url, methods: [..] | "*", also } explicit methods; `also` names single exceptions
//                                               ({ method: "POST", path: "/login" }, exact path)
// An origin listed twice gets the union of its rules.
export function allowRules(allow, { writesAllowed = false } = {}) {
  const rules = new Map();
  for (const e of Array.isArray(allow) ? allow : []) {
    const origin = entryOrigin(e);
    if (!origin) continue;
    const r = rules.get(origin) || { any: false, methods: new Set(), also: [] };
    const obj = e && typeof e === "object" ? e : {};
    if (obj.methods === "*" || (Array.isArray(obj.methods) && obj.methods.includes("*"))) r.any = true;
    else if (Array.isArray(obj.methods)) for (const m of obj.methods) r.methods.add(String(m).toUpperCase());
    else if (obj.mode === "full" && writesAllowed) r.any = true;
    else for (const m of READ_METHODS) r.methods.add(m);
    for (const x of Array.isArray(obj.also) ? obj.also : []) {
      if (x && typeof x.method === "string" && typeof x.path === "string" && x.path.startsWith("/")) r.also.push({ method: x.method.toUpperCase(), path: x.path });
    }
    rules.set(origin, r);
  }
  return rules;
}

// Why a request is refused on an origin that is on the list (its method, a method-override
// header), or null when it may go.
export function methodRefusal(rule, method, pathname, headers = {}) {
  if (!rule) return "not on the allow-list";
  if (rule.any) return null;
  const m = String(method || "").toUpperCase();
  const p = String(pathname || "/");
  const exception = rule.also.some((x) => x.method === m && x.path === p);
  if (!rule.methods.has(m) && !exception) return `${m || "?"} is not allowed here (only ${[...rule.methods].join(", ") || "nothing"}${rule.also.length ? ` and ${rule.also.map((x) => `${x.method} ${x.path}`).join(", ")}` : ""})`;
  const h = headers && typeof headers === "object" ? headers : {};
  const override = METHOD_OVERRIDE_HEADERS.find((n) => Object.keys(h).some((k) => k.toLowerCase() === n));
  if (override && !exception) return `a method-override header (${override}) on a read-only origin`;
  return null;
}

function nowIso() { return new Date().toISOString(); }

// Appends one line to the proxy log; a failure to write never breaks the proxy.
function logLine(logFile, decision, method, origin, detail = "") {
  if (!logFile) return;
  const line = `${nowIso()} ${decision} ${method} ${origin}${detail ? ` ${detail}` : ""}\n`.replace(/[\r\n]+(?!$)/g, " ");
  try { fs.appendFileSync(logFile, line); } catch {}
}

// Starts the allow-list forward proxy on 127.0.0.1 and an ephemeral port. Resolves to
// { url, port, close() }. The browser is pointed at `url` with --proxy-server. A plain HTTP
// request (absolute-form URL) is forwarded only when its origin is allowed and its method is
// allowed there; a CONNECT (the tunnel https and WebSockets use) is opened only to an origin
// that allows every method, because the method inside the tunnel cannot be seen. Anything else
// gets a 403 and a REFUSE line in the log, with the reason. `allow` takes the entries allowRules
// reads; writesAllowed lets a target in mode "full" take every method.
export function startAllowListProxy({ allow, logFile = null, writesAllowed = false } = {}) {
  const rules = allowRules(allow, { writesAllowed });
  const server = http.createServer();
  const sockets = new Set();

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  const refuse = (req, res, method, origin, detail) => {
    logLine(logFile, "REFUSE", method, origin, detail);
    res.writeHead(403, { "content-type": "text/plain" });
    res.end("blocked by the AutoClaude sweep allow-list\n");
    req.resume();
  };

  // Plain HTTP: req.url is an absolute URL in forward-proxy mode.
  server.on("request", (req, res) => {
    const origin = /^[a-z][a-z0-9+.-]*:\/\//i.test(String(req.url || "")) ? originOf(req.url) : null;
    const method = req.method || "?";
    if (!origin || !rules.has(origin)) return refuse(req, res, method, origin || safeRequestTarget(req.url), "(not on the allow-list)");
    const why = methodRefusal(rules.get(origin), method, pathnameOf(req.url), req.headers);
    if (why) return refuse(req, res, method, origin, `${pathOf(req.url)} (${why})`);
    logLine(logFile, "ALLOW", method, origin, pathOf(req.url));
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400); res.end(); return; }
    const options = {
      hostname: target.hostname,
      port: target.port || 80,
      method: req.method,
      path: target.pathname + target.search,
      headers: req.headers
    };
    const upstream = http.request(options, (up) => {
      res.writeHead(up.statusCode || 502, up.headers);
      up.pipe(res);
    });
    upstream.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
    req.pipe(upstream);
  });

  // HTTPS and WebSocket tunnels: CONNECT host:port. Only to an origin that allows every method:
  // inside the tunnel a POST looks the same as a GET.
  server.on("connect", (req, clientSocket, head) => {
    const origin = authorityOrigin(req.url);
    const rule = origin ? rules.get(origin) : null;
    if (!rule || !rule.any) {
      logLine(logFile, "REFUSE", "CONNECT", origin || safeRequestTarget(req.url), rule ? "(a read-only origin: the method inside a tunnel cannot be checked)" : "(not on the allow-list)");
      clientSocket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      clientSocket.end();
      return;
    }
    logLine(logFile, "ALLOW", "CONNECT", origin);
    const [host, port] = origin.split(":");
    const upstream = net.connect(Number(port), host, () => {
      clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head && head.length) upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on("error", () => { try { clientSocket.end(); } catch {} });
    clientSocket.on("error", () => { try { upstream.destroy(); } catch {} });
  });

  // A WebSocket asked for in plain form (not through CONNECT): refused like any other upgrade.
  server.on("upgrade", (req, socket) => {
    logLine(logFile, "REFUSE", `UPGRADE ${String(req.headers && req.headers.upgrade || "?").slice(0, 20)}`, originOf(req.url) || safeRequestTarget(req.url), "(upgrades go through CONNECT, and only to an origin that allows every method)");
    try { socket.end("HTTP/1.1 403 Forbidden\r\n\r\n"); } catch {}
  });

  server.on("clientError", (err, socket) => {
    logLine(logFile, "REFUSE", "?", "(malformed request)", String(err && err.code || "").slice(0, 40));
    try { socket.end("HTTP/1.1 400 Bad Request\r\n\r\n"); } catch {}
  });

  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((done) => {
          for (const s of sockets) { try { s.destroy(); } catch {} }
          server.close(() => done());
        })
      });
    });
  });
}

// The path a log line shows: the query string is left out (a GET form would put a password
// there), only that there was one.
function pathOf(url) { try { const u = new URL(url); return u.pathname + (u.search ? "?[query not logged]" : ""); } catch { return ""; } }
function pathnameOf(url) { try { return new URL(url).pathname || "/"; } catch { return "/"; } }
// A request target that is not a URL, as far as the log shows it: no query, no control
// characters, short.
function safeRequestTarget(t) { return String(t || "?").split("?")[0].replace(/[^\x21-\x7e]/g, "").slice(0, 120) || "?"; }

// ---------- direct HTTP probes ----------

function baseUrl(url) { return String(url).replace(/\/+$/, ""); }

// A finding from a live probe. file is the endpoint (there is no source line), line 0. Every
// check here is fixed by a change to the app's code or its server settings in the repository, so
// they are autoFixSafe (D58: fix right away fixes them); ownerAction names what only the owner
// can do besides (rotate what a served .env held, block a path at a server outside the
// repository). anchor: the check's fixed key, so the fingerprint stays the same next sweep.
// title: one plain line naming the problem (the report's heading; the URL is in its Where row).
function finding({ title = "", category, severity, cwe = null, confidence, endpoint, evidence, impact, fix, testIdea, autoFixSafe = true, ownerAction = null, anchor = null }, redact) {
  return {
    kind: "security", title: redact(String(title || "")), category, severity, cwe, cvss: null, fixedVersion: null,
    confidence, file: endpoint, line: 0,
    evidence: redact(String(evidence || "")), impact, fix, testIdea, tier: "A", autoFixSafe,
    ...(ownerAction ? { ownerAction } : {}),
    ...(anchor ? { anchor } : {})
  };
}

const OUTSIDE_SERVER = "If a web server or proxy outside this repository serves the site, block it there too.";

// A fetch that refuses an off-allow-list URL or a method its origin does not allow (the same
// rules as the proxy), and never follows a redirect off the list. Logs every attempt to the proxy
// log. Returns { res, bodyText } or { error } or { refused, reason }.
async function guardedFetch({ url, method = "GET", headers = {}, body = null, allow, fetchImpl, logFile, maxBodyBytes = 64 * 1024 }) {
  const origin = originOf(url);
  const rules = allowRules(allow);
  const why = origin && rules.has(origin) ? methodRefusal(rules.get(origin), method, pathnameOf(url), headers) : "not on the allow-list";
  if (why) {
    logLine(logFile, "REFUSE", method, origin || safeRequestTarget(url), `${pathOf(url)} (${why})`);
    return { refused: true, reason: why };
  }
  logLine(logFile, "ALLOW", method, originOf(url), pathOf(url));
  let res;
  try {
    res = await fetchImpl(url, { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(15000) });
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
  // A redirect to an origin off the allow-list is reported, never followed.
  const location = res.headers && typeof res.headers.get === "function" ? res.headers.get("location") : null;
  let redirectOffList = false;
  if (location) {
    let abs = location;
    try { abs = new URL(location, url).toString(); } catch {}
    redirectOffList = !isAllowed(abs, allow);
    if (redirectOffList) logLine(logFile, "NOTE", "redirect-off-list", originOf(abs) || abs);
  }
  let bodyText = "";
  if (method !== "HEAD") {
    try {
      const buf = await res.arrayBuffer();
      bodyText = Buffer.from(buf).subarray(0, maxBodyBytes).toString("utf8");
    } catch {}
  }
  return { res, bodyText, location, redirectOffList };
}

function headerVal(res, name) {
  try { return res.headers.get(name); } catch { return null; }
}

function setCookies(res) {
  try {
    if (typeof res.headers.getSetCookie === "function") { const a = res.headers.getSetCookie(); if (a && a.length) return a; }
  } catch {}
  const raw = headerVal(res, "set-cookie");
  return raw ? [raw] : [];
}

// The checks, each returning candidate findings. Grouped so the booleans in `tests` switch them.

export function checkSecurityHeaders(res, endpoint, isHttps, redact) {
  const out = [];
  const has = (n) => !!headerVal(res, n);
  const csp = headerVal(res, "content-security-policy");
  if (!csp) out.push(finding({ title: "No Content-Security-Policy header", category: "headers", severity: "medium", cwe: "CWE-1021", confidence: 8, endpoint, evidence: "no Content-Security-Policy header on the main response", impact: "Without a CSP, an injected script has nothing stopping it from running.", fix: "Add a Content-Security-Policy that restricts scripts to trusted sources.", testIdea: "The response carries a Content-Security-Policy header.", anchor: "header:content-security-policy" }, redact));
  if (isHttps && !has("strict-transport-security")) out.push(finding({ title: "No Strict-Transport-Security header on an https site", category: "headers", severity: "medium", cwe: "CWE-319", confidence: 8, endpoint, evidence: "no Strict-Transport-Security header on an https response", impact: "A browser may be downgraded to http on a later visit.", fix: "Add Strict-Transport-Security with a long max-age.", testIdea: "The https response carries Strict-Transport-Security.", anchor: "header:strict-transport-security" }, redact));
  const frameAncestors = csp && /frame-ancestors/i.test(csp);
  if (!has("x-frame-options") && !frameAncestors) out.push(finding({ title: "No X-Frame-Options header or CSP frame-ancestors: other sites can frame the page", category: "headers", severity: "medium", cwe: "CWE-1021", confidence: 8, endpoint, evidence: "no X-Frame-Options header and no frame-ancestors in the CSP", impact: "The page can be framed by another site (clickjacking).", fix: "Add X-Frame-Options: DENY, or frame-ancestors 'none' in the CSP.", testIdea: "Framing is refused by a header.", anchor: "header:frame-options" }, redact));
  if (String(headerVal(res, "x-content-type-options") || "").toLowerCase() !== "nosniff") out.push(finding({ title: "No X-Content-Type-Options: nosniff header", category: "headers", severity: "low", cwe: "CWE-16", confidence: 8, endpoint, evidence: "no X-Content-Type-Options: nosniff header", impact: "A browser may guess a response's type and treat it as something executable.", fix: "Add X-Content-Type-Options: nosniff.", testIdea: "The response sets X-Content-Type-Options: nosniff.", anchor: "header:x-content-type-options" }, redact));
  if (!has("referrer-policy")) out.push(finding({ title: "No Referrer-Policy header", category: "headers", severity: "low", cwe: "CWE-200", confidence: 7, endpoint, evidence: "no Referrer-Policy header", impact: "Full URLs may leak to other sites through the Referer header.", fix: "Add a Referrer-Policy such as strict-origin-when-cross-origin.", testIdea: "The response sets a Referrer-Policy.", anchor: "header:referrer-policy" }, redact));
  return out;
}

export function checkCookies(res, endpoint, isHttps, redact) {
  const out = [];
  for (const raw of setCookies(res)) {
    const name = String(raw).split("=")[0].trim();
    const flags = String(raw).toLowerCase();
    const missing = [];
    if (!/;\s*httponly/.test(flags)) missing.push("HttpOnly");
    if (isHttps && !/;\s*secure/.test(flags)) missing.push("Secure");
    if (!/;\s*samesite=/.test(flags)) missing.push("SameSite");
    if (missing.length) out.push(finding({
      title: `Cookie ${maskValue(name)} is missing the ${missing.join(", ")} flag${missing.length === 1 ? "" : "s"}`,
      category: "cookies", severity: missing.includes("HttpOnly") ? "medium" : "low", cwe: "CWE-1004", confidence: 8,
      endpoint, evidence: `cookie ${maskValue(name)} is missing ${missing.join(", ")}`,
      impact: "A session cookie without these flags is easier to steal or misuse.",
      fix: `Set ${missing.join(", ")} on this cookie.`,
      testIdea: "The Set-Cookie header carries the expected flags.", anchor: `cookie:${maskValue(name)}`
    }, redact));
  }
  return out;
}

export function checkCors(res, endpoint, probedOrigin, redact) {
  const acao = headerVal(res, "access-control-allow-origin");
  const acac = String(headerVal(res, "access-control-allow-credentials") || "").toLowerCase() === "true";
  const out = [];
  if (acao && acao === probedOrigin && acac) {
    out.push(finding({ title: "CORS lets any site read responses with the visitor's credentials (the request Origin is reflected)", category: "cors", severity: "high", cwe: "CWE-942", confidence: 8, endpoint,
      evidence: `the response reflected the request Origin (${probedOrigin}) in Access-Control-Allow-Origin with Allow-Credentials: true`,
      impact: "Any site can make credentialed cross-origin requests and read the responses.",
      fix: "Allow only a fixed list of trusted origins, and never reflect the request Origin while allowing credentials.",
      testIdea: "A request with an untrusted Origin is not reflected with credentials allowed.", anchor: "cors:reflected-origin" }, redact));
  } else if (acao === "*" && acac) {
    out.push(finding({ title: "CORS allows any origin (*) together with credentials", category: "cors", severity: "high", cwe: "CWE-942", confidence: 8, endpoint,
      evidence: "Access-Control-Allow-Origin is * with Allow-Credentials: true",
      impact: "A wildcard origin with credentials exposes authenticated responses to any site.",
      fix: "Do not combine a wildcard origin with credentials; allow a fixed list of origins instead.",
      testIdea: "Credentialed CORS is not allowed from a wildcard origin.", anchor: "cors:wildcard-credentials" }, redact));
  }
  return out;
}

const EXPOSED_PATHS = Object.freeze([
  { path: "/.git/HEAD", sig: /ref:\s|^[0-9a-f]{40}/m, what: "a .git directory", cwe: "CWE-527", ownerAction: OUTSIDE_SERVER },
  { path: "/.env", sig: /^[A-Z0-9_]+\s*=/m, what: "a .env file", cwe: "CWE-538", ownerAction: `Rotate every value the served .env held: anyone could read it. ${OUTSIDE_SERVER}` }
]);

export async function checkExposedFiles({ base, allow, fetchImpl, logFile, redact }) {
  const out = [];
  for (const e of EXPOSED_PATHS) {
    const r = await guardedFetch({ url: base + e.path, allow, fetchImpl, logFile });
    if (r.refused || r.error || !r.res) continue;
    if (r.res.status === 200 && e.sig.test(r.bodyText || "")) {
      out.push(finding({ title: `${e.what[0].toUpperCase()}${e.what.slice(1)} is served at ${e.path}`, category: "exposure", severity: "high", cwe: e.cwe, confidence: 8, endpoint: base + e.path,
        evidence: `${e.path} is served (status 200 and looks like ${e.what})`,
        impact: "A sensitive file is reachable over HTTP, exposing source history or configuration.",
        fix: `Stop serving ${e.path}: block dotfiles at the web server, and keep ${e.what} out of the served root.`,
        testIdea: `A request for ${e.path} returns 404 or 403.`, ownerAction: e.ownerAction, anchor: `exposed:${e.path}` }, redact));
    }
  }
  // Source maps referenced by the main page and served.
  const page = await guardedFetch({ url: base + "/", allow, fetchImpl, logFile });
  if (page.res && page.bodyText) {
    const m = page.bodyText.match(/sourceMappingURL=([^\s"'*]+\.map)/);
    if (m) {
      let mapUrl = m[1];
      try { mapUrl = new URL(m[1], base + "/").toString(); } catch {}
      if (isAllowed(mapUrl, allow)) {
        const mr = await guardedFetch({ url: mapUrl, allow, fetchImpl, logFile });
        if (mr.res && mr.res.status === 200 && /"sources"|"mappings"/.test(mr.bodyText || "")) {
          out.push(finding({ title: "A JavaScript source map is served", category: "exposure", severity: "low", cwe: "CWE-540", confidence: 7, endpoint: mapUrl,
            evidence: "a JavaScript source map is served in this environment",
            impact: "Source maps expose original source, which aids an attacker reading the client code.",
            fix: "Do not serve source maps in production builds.",
            testIdea: "Source maps are absent from the production build.", anchor: "exposed:source-map" }, redact));
        }
      }
    }
  }
  return out;
}

const ERROR_SIGNATURES = /(\bat\s+[A-Za-z0-9_.$]+\s+\([^)]*:\d+:\d+\)|Traceback \(most recent call last\)|Exception in thread|System\.[A-Za-z.]+Exception|org\.[a-z]+\.[A-Za-z.]+Exception|node_modules[\\/]|\/home\/[a-z]+\/|[A-Z]:\\\\?[Uu]sers\\\\)/;

export async function checkVerboseErrors({ base, allow, fetchImpl, logFile, redact }) {
  const out = [];
  // A path unlikely to exist, with characters a careless handler may echo into an error page.
  const probe = base + "/autoclaude-sweep-probe-%27%22%3C%3E";
  const r = await guardedFetch({ url: probe, allow, fetchImpl, logFile });
  if (r.res && ERROR_SIGNATURES.test(r.bodyText || "")) {
    out.push(finding({ title: "Error responses show a stack trace or a server file path", category: "errors", severity: "medium", cwe: "CWE-209", confidence: 7, endpoint: probe,
      evidence: `the error response leaks a stack trace or file path (status ${r.res.status})`,
      impact: "Verbose errors disclose internal structure, file paths and library versions.",
      fix: "Return a generic error page in this environment and log the detail server-side only.",
      testIdea: "An error response contains no stack trace or server file path.", anchor: "errors:verbose" }, redact));
  }
  return out;
}

// Routes that answer without a login. `map.protectedRoutes` is the list the app map named as
// requiring auth; each is fetched with no credentials and a 200 (not 401/403 and not a redirect
// to a login page) is a finding.
export async function checkAuthBypass({ base, map, allow, fetchImpl, logFile, redact }) {
  const out = [];
  const routes = map && Array.isArray(map.protectedRoutes) ? map.protectedRoutes : [];
  for (const route of routes) {
    const url = base + (String(route).startsWith("/") ? route : `/${route}`);
    const r = await guardedFetch({ url, allow, fetchImpl, logFile });
    if (r.refused || r.error || !r.res) continue;
    const status = r.res.status;
    const location = r.location || "";
    const toLogin = status >= 300 && status < 400 && /login|signin|sign-in|auth/i.test(location);
    if (status === 200) {
      out.push(finding({ title: `${route} answers without a login`, category: "authz", severity: "high", cwe: "CWE-862", confidence: 6, endpoint: url,
        evidence: `${route} answered with 200 and no credentials`,
        impact: "A route the app map marks as protected is reachable without logging in.",
        fix: "Require and check authentication on this route before serving it.",
        testIdea: "The route returns 401 or redirects to login without a session.", anchor: `authz:${String(route).toLowerCase()}` }, redact));
    } else if (!toLogin && status !== 401 && status !== 403 && status < 500 && status !== 404) {
      out.push(finding({ title: `${route} may answer without a login (status ${status})`, category: "authz", severity: "medium", cwe: "CWE-862", confidence: 4, endpoint: url,
        evidence: `${route} answered with ${status} and no credentials (no login redirect, 401 or 403)`,
        impact: "A protected route may be partly reachable without a session.",
        fix: "Confirm this route requires authentication.",
        testIdea: "The route refuses an unauthenticated request.", anchor: `authz:${String(route).toLowerCase()}` }, redact));
    }
  }
  return out;
}

// Rate limiting on the login route: write-ish, so only when writesAllowed and the target is in
// full mode. Several quick bad-credential POSTs; no 429 anywhere is a finding.
export async function checkRateLimit({ base, map, allow, fetchImpl, logFile, redact, attempts = 12 }) {
  const loginPath = map && map.loginPath ? map.loginPath : null;
  if (!loginPath) return [];
  const url = base + (String(loginPath).startsWith("/") ? loginPath : `/${loginPath}`);
  let limited = false;
  let answered = 0;
  for (let i = 0; i < attempts; i++) {
    const r = await guardedFetch({ url, method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: `sweep-probe-${i}`, password: "wrong-on-purpose" }), allow, fetchImpl, logFile });
    if (r.refused || r.error || !r.res) break;
    answered++;
    if (r.res.status === 429) { limited = true; break; }
  }
  if (answered >= attempts && !limited) {
    return [finding({ title: `No rate limit on the login route ${loginPath}`, category: "rate-limit", severity: "medium", cwe: "CWE-307", confidence: 6, endpoint: url,
      evidence: `${attempts} rapid failed login attempts, none answered with 429`,
      impact: "No rate limit on login allows credential stuffing and brute-force attacks.",
      fix: "Add rate limiting or lockout on repeated failed login attempts.",
      testIdea: "Repeated failed logins are throttled (429) after a few attempts.", anchor: `rate-limit:${String(loginPath).toLowerCase()}` }, redact)];
  }
  return [];
}

// Runs the direct HTTP probes over every target. readonly targets get GET/HEAD checks only; the
// rate-limit check needs writesAllowed and a target in full mode. `tests` switches each check.
// Returns { candidates, coverage }. The allow-list is built from the targets' own origins, so a
// probe never reaches a host that is not a target. `map` (optional) carries protectedRoutes and
// loginPath from the app-map stage.
export async function runHttpProbe({ targets = [], tests = {}, writesAllowed = false, logFile = null, fetchImpl = globalThis.fetch, map = null, redact: injectedRedact = null } = {}) {
  const redact = await resolveRedact(injectedRedact);
  // The targets' own origins, each with its method rule: every method only on a full target
  // with writes allowed, GET and HEAD everywhere else.
  const allow = (targets || []).filter((t) => t && originOf(t.url)).map((t) => ({ origin: originOf(t.url), methods: t.mode === "full" && writesAllowed ? "*" : [...READ_METHODS] }));
  const on = (name) => tests[name] !== false; // default on unless explicitly switched off
  const candidates = [];
  const examined = [];
  const notExamined = [];

  for (const target of targets) {
    const base = baseUrl(target.url);
    const origin = originOf(target.url);
    const isHttps = /^https:/i.test(target.url);
    const full = target.mode === "full";
    const label = `${target.url} (${target.mode || "readonly"})`;

    const main = await guardedFetch({ url: base + "/", allow, fetchImpl, logFile });
    if (main.refused) { notExamined.push(`${label}: refused by the allow-list`); continue; }
    if (main.error || !main.res) { notExamined.push(`${label}: no response (${main.error || "unknown"})`); continue; }
    examined.push(label);

    if (on("headers")) { candidates.push(...checkSecurityHeaders(main.res, base + "/", isHttps, redact)); examined.push(`${origin}: security headers`); }
    else notExamined.push(`${origin}: security headers (switched off)`);

    if (on("cookies")) { candidates.push(...checkCookies(main.res, base + "/", isHttps, redact)); examined.push(`${origin}: cookie flags`); }
    else notExamined.push(`${origin}: cookie flags (switched off)`);

    if (on("cors")) {
      const probedOrigin = "https://autoclaude-sweep-probe.example";
      const corsRes = await guardedFetch({ url: base + "/", headers: { origin: probedOrigin }, allow, fetchImpl, logFile });
      if (corsRes.res) candidates.push(...checkCors(corsRes.res, base + "/", probedOrigin, redact));
      examined.push(`${origin}: CORS`);
    } else notExamined.push(`${origin}: CORS (switched off)`);

    if (on("exposedFiles")) { candidates.push(...await checkExposedFiles({ base, allow, fetchImpl, logFile, redact })); examined.push(`${origin}: exposed files (.git, .env, source maps)`); }
    else notExamined.push(`${origin}: exposed files (switched off)`);

    // Switched off by its own name or by the older "errors": either one being false is enough.
    if (on("verboseErrors") && on("errors")) { candidates.push(...await checkVerboseErrors({ base, allow, fetchImpl, logFile, redact })); examined.push(`${origin}: verbose errors`); }
    else notExamined.push(`${origin}: verbose errors (switched off)`);

    if (on("authBypass")) {
      if (map && Array.isArray(map.protectedRoutes) && map.protectedRoutes.length) { candidates.push(...await checkAuthBypass({ base, map, allow, fetchImpl, logFile, redact })); examined.push(`${origin}: routes answering without login`); }
      else notExamined.push(`${origin}: routes answering without login (no protected routes from the app map)`);
    } else notExamined.push(`${origin}: routes answering without login (switched off)`);

    if (on("rateLimit")) {
      if (writesAllowed && full && map && map.loginPath) { candidates.push(...await checkRateLimit({ base, map, allow, fetchImpl, logFile, redact })); examined.push(`${origin}: login rate limiting`); }
      else notExamined.push(`${origin}: login rate limiting (needs writes allowed, a full-mode target and a login route)`);
    } else notExamined.push(`${origin}: login rate limiting (switched off)`);
  }

  return { candidates, coverage: { examined, notExamined } };
}
