// Tiny todo web app: one HTML page plus a JSON API. Node built-ins only.
// GET /            the page
// GET /api/todos   list
// POST /api/todos  { text }
// POST /api/todos/:id/toggle
// DELETE /api/todos/:id
// GET /health      { ok: true }
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createStore } from "./lib/todos.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(here, "public", "index.html"));
const store = createStore([{ id: 1, text: "Write the plan", done: true }, { id: 2, text: "Run autoclaude", done: false }]);
const port = Number(process.env.PORT || 4173);

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { resolve({}); } });
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/") { res.writeHead(200, { "content-type": "text/html; charset=utf-8" }); return res.end(page); }
    if (req.method === "GET" && url.pathname === "/health") return json(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/api/todos") return json(res, 200, store.list());
    if (req.method === "POST" && url.pathname === "/api/todos") { const body = await readBody(req); return json(res, 201, store.add(body.text)); }
    let m = url.pathname.match(/^\/api\/todos\/(\d+)\/toggle$/);
    if (req.method === "POST" && m) return json(res, 200, store.toggle(m[1]));
    m = url.pathname.match(/^\/api\/todos\/(\d+)$/);
    if (req.method === "DELETE" && m) { store.remove(m[1]); return json(res, 200, { ok: true }); }
    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 400, { error: e.message });
  }
});

server.listen(port, "127.0.0.1", () => console.log(`todo-app listening on http://127.0.0.1:${port}/`));
