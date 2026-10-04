// Prepares spikes/out/todo-live for the Phase 10 sweep proof (PLAN.md P10.12): the todo fixture as
// an existing project with planted problems for both sweeps, a few commits of history (one of them
// with a secret that a later commit removes), AutoClaude initialised and committed, and a local
// bare repository as its "origin". spikes/out/todo-live is the scratch path this VM trusts.
//
// Planted for the security sweep: XSS (innerHTML), path traversal (/api/export), an open redirect
// (/go), stack traces in error replies, a secret in git history, a Dockerfile with a token in ENV
// running as root, a compose port on every interface, a vulnerable package (minimist 0.0.8), and
// no security headers. For the optimize sweep: an unused file, an unused export, duplicated code,
// a slow route, a flaky test, an unused package, stale TODOs and commented-out code.
//
// Fake keys are built at runtime: GitHub push protection rejects key-shaped literals (CLAUDE.md).
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../../test/fixtures/prepare.js";

const dest = "C:/AutoClaude/spikes/out/todo-live";
const remote = "C:/AutoClaude/spikes/out/practice-remote.git";
const env = gitEnv(process.env);
const run = (cmd, args, cwd = dest) => {
  const r = spawnSync(cmd, args, { cwd, env, encoding: "utf8", shell: process.platform === "win32" && /^(npm|npx)$/.test(cmd) });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${r.stderr || r.stdout}`);
  return (r.stdout || "").trim();
};
const git = (...args) => run("git", args);
const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dest, rel)), { recursive: true }); fs.writeFileSync(path.join(dest, rel), text); };
const read = (rel) => fs.readFileSync(path.join(dest, rel), "utf8");
const edit = (rel, from, to) => { const t = read(rel); if (!t.includes(from)) throw new Error(`${rel}: missing ${from.slice(0, 40)}`); write(rel, t.replace(from, to)); };

fs.rmSync(remote, { recursive: true, force: true });
prepareFixture({ dest, plan: "happy", git: true, env });
for (const f of ["PLAN.md", "autoclaude.config.json", "PROGRESS.md", "CONTINUE_HERE.md", "docs"]) fs.rmSync(path.join(dest, f), { recursive: true, force: true });
write(".gitignore", "node_modules/\n");
// The project sits inside the AutoClaude repo: keep that repo's CLAUDE.md out of its sessions.
write(".claude/settings.json", JSON.stringify({ claudeMdExcludes: ["C:/AutoClaude/CLAUDE.md", "**/AutoClaude/CLAUDE.md"] }, null, 2) + "\n");
git("add", "-A");
git("commit", "-qm", "todo app");

// History: a payment key committed, then moved to the environment (it stays in history).
const paymentKey = ["sk", "live", "51Hq8RvTzLmP0aWc3XyK9dNb2Ef6Gh"].join("_");
write("lib/config.js", `// Payment provider settings.\nexport const PAYMENT_KEY = "${paymentKey}";\nexport const PAYMENT_URL = "https://payments.example.invalid/v1";\n`);
git("add", "-A");
git("commit", "-qm", "payment settings");
write("lib/config.js", `// Payment provider settings.\nexport const PAYMENT_KEY = process.env.PAYMENT_KEY || "";\nexport const PAYMENT_URL = "https://payments.example.invalid/v1";\n`);
git("add", "-A");
git("commit", "-qm", "read the payment key from the environment");

// Features with planted problems.
write("lib/format.js", `// Formatting helpers.\nexport function formatList(items) {\n  const lines = [];\n  for (const t of items) lines.push((t.done ? "[x] " : "[ ] ") + t.text);\n  return lines.join("\\n");\n}\n`);
write("lib/legacy.js", `// Old import format, from before the JSON API. Nothing uses this any more.\nexport function parseLegacy(text) {\n  return String(text).split(";").map((s) => s.trim()).filter(Boolean).map((t, i) => ({ id: i + 1, text: t, done: false }));\n}\n`);
edit("lib/todos.js", "export function createStore(", `// Counts finished todos.\nexport function countDone(items) {\n  return items.filter((t) => t.done).length;\n}\n\nexport function createStore(`);
edit("server.js", "const port = Number(process.env.PORT || 4173);", `const port = Number(process.env.PORT || 4173);\nconst exportsDir = path.join(here, "exports");\n// TODO: remove the old v1 routes once the app is migrated (done 2025)\n// function legacyList(res) {\n//   return json(res, 200, store.list().map((t) => t.text));\n// }`);
edit("server.js", `    if (req.method === "GET" && url.pathname === "/api/todos") return json(res, 200, store.list());`,
`    if (req.method === "GET" && url.pathname === "/api/todos") {
      // Sorted newest first.
      const items = store.list();
      for (let i = 0; i < items.length; i++) for (let j = 0; j < items.length - 1; j++) if (items[j].id < items[j + 1].id) [items[j], items[j + 1]] = [items[j + 1], items[j]];
      const until = Date.now() + 150; while (Date.now() < until) { /* settle */ }
      return json(res, 200, items);
    }
    if (req.method === "GET" && url.pathname === "/api/summary") {
      const lines = [];
      for (const t of store.list()) lines.push((t.done ? "[x] " : "[ ] ") + t.text);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(lines.join("\\n"));
    }
    if (req.method === "GET" && url.pathname === "/api/export") {
      const file = url.searchParams.get("file") || "todos.txt";
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(fs.readFileSync(path.join(exportsDir, file), "utf8"));
    }
    if (req.method === "GET" && url.pathname === "/go") {
      res.writeHead(302, { location: url.searchParams.get("to") || "/" });
      return res.end();
    }`);
edit("server.js", `    return json(res, 400, { error: e.message });`, `    return json(res, 400, { error: e.message, stack: e.stack });`);
write("exports/todos.txt", "[ ] Write the plan\n[ ] Run autoclaude\n");
edit("public/index.html", "span.textContent = t.text;", "span.innerHTML = t.text;");
write("test/timing.test.js", `import { test } from "node:test";\nimport assert from "node:assert/strict";\n\ntest("the store answers quickly", async () => {\n  const started = Date.now();\n  await new Promise((r) => setTimeout(r, 5));\n  // Timing on a busy machine varies.\n  assert.ok(Math.random() > 0.15, "took too long");\n  assert.ok(Date.now() - started < 5000);\n});\n`);
write("Dockerfile", `FROM node:24\nWORKDIR /app\nCOPY . .\nENV ADMIN_TOKEN=${["ghp", "Zx81Kq2mVt7Lr0WcY3nPd5HsB9eQaFgJ4uTi"].join("_")}\nEXPOSE 4173\nCMD ["node", "server.js"]\n`);
write("compose.yaml", `services:\n  app:\n    build: .\n    ports:\n      - "4173:4173"\n`);
const pkg = JSON.parse(read("package.json"));
pkg.dependencies = { minimist: "0.0.8" };
pkg.scripts.lint = "node --check server.js && node --check lib/todos.js && node --check lib/format.js && node --check lib/config.js";
write("package.json", JSON.stringify(pkg, null, 2) + "\n");
run("npm", ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"]);
git("add", "-A");
git("commit", "-qm", "summary, export and short links; container files");

// AutoClaude set up, as an existing project would have it after /autoclaude:init.
run(process.execPath, ["C:/AutoClaude/plugins/autoclaude/bin/autoclaude.js", "init", "--no-statusline"]);
git("add", "-A");
git("commit", "-qm", "add AutoClaude");
const branch = git("rev-parse", "--abbrev-ref", "HEAD");
run("git", ["init", "-q", "--bare", remote], path.dirname(remote));
git("remote", "add", "origin", remote);
git("push", "-q", "-u", "origin", branch);
console.log(`prepared ${dest} on ${branch}, origin ${remote}`);
console.log(git("log", "--oneline"));
