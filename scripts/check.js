// `npm run check`: syntax-check every plugin and test file, then run the tests.
// Node built-ins only. Exit code is non-zero on any failure.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const roots = ["plugins/autoclaude", "test", "scripts"].map((d) => path.join(root, d)).filter((d) => fs.existsSync(d));

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "out" || e.name.startsWith(".")) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (/\.(js|mjs)$/.test(e.name)) out.push(p);
  }
  return out;
}

const files = roots.flatMap((d) => walk(d, []));
let failed = 0;
for (const f of files) {
  const r = spawnSync(process.execPath, ["--check", f], { encoding: "utf8" });
  if (r.status !== 0) {
    failed++;
    console.error(`SYNTAX ${path.relative(root, f)}\n${r.stderr}`);
  }
}
console.log(`syntax: ${files.length - failed}/${files.length} files ok`);
if (failed) process.exit(1);

const testFiles = files.filter((f) => /\.test\.js$/.test(f) && f.startsWith(path.join(root, "test")));
if (testFiles.length === 0) {
  console.log("tests: none found");
  process.exit(0);
}
const t = spawnSync(process.execPath, ["--test", ...testFiles], { stdio: "inherit", cwd: root });
process.exit(t.status ?? 1);
