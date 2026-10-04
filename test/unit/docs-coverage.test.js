// Keeps the settings page and the docs in step with the code (Scott, 2026-10-04: "Make sure the
// config page and instructions are updated whenever new features are added"). A new setting
// without a field on the settings page, a setting or command missing from docs/USAGE.md, or a
// command an owner types missing from INSTRUCTIONS.md fails here.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULTS } from "../../plugins/autoclaude/lib/config.js";
import { FIELDS } from "../../plugins/autoclaude/lib/configpage.js";
import { COMMANDS } from "../../plugins/autoclaude/lib/cli.js";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const usage = read("docs/USAGE.md");
const instructions = read("INSTRUCTIONS.md");
const section = (text, start, end) => {
  const a = text.indexOf(start);
  assert.ok(a >= 0, `missing section ${start}`);
  const b = end ? text.indexOf(end, a + start.length) : -1;
  return text.slice(a, b < 0 ? undefined : b);
};

// Settings that are deliberately not on the page, each with its reason.
const NOT_ON_PAGE = {
  version: "the config file format's version, not a setting",
  "retries.maxMinutesPerStep": "accepted but not enforced yet (DEFERRED 15)"
};
// Commands the run itself uses; an owner never types them.
const INTERNAL = ["supervise", "start", "ready", "blocked", "decide"];

function leaves(obj, prefix = "") {
  const out = [];
  for (const [k, v] of Object.entries(obj)) {
    const p = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) out.push(...leaves(v, p));
    else out.push(p);
  }
  return out;
}

test("every setting has a field on the settings page, apart from the listed exceptions", () => {
  const paths = FIELDS.map((f) => f.path);
  const covered = (leaf) => paths.some((p) => leaf === p || leaf.startsWith(`${p}.`));
  const missing = leaves(DEFAULTS).filter((l) => !covered(l) && !Object.hasOwn(NOT_ON_PAGE, l));
  assert.deepEqual(missing, [], `add these to lib/configpage.js FIELDS (or to NOT_ON_PAGE with a reason): ${missing.join(", ")}`);
  for (const p of Object.keys(NOT_ON_PAGE)) assert.ok(leaves(DEFAULTS).includes(p), `${p} is no longer a setting; drop it from NOT_ON_PAGE`);
});

test("every setting on the settings page is in docs/USAGE.md's configuration reference", () => {
  const ref = section(usage, "## 11. Configuration reference", "## 12.");
  const named = (p) => ref.includes(`\`${p}\``) || ref.includes(`"${p.split(".").pop()}"`) || ref.includes(`\`${p.split(".")[0]}\``);
  const missing = FIELDS.map((f) => f.path).filter((p) => !named(p));
  assert.deepEqual(missing, [], `document these in docs/USAGE.md section 11: ${missing.join(", ")}`);
});

test("every command is in docs/USAGE.md's command reference", () => {
  const ref = section(usage, "Command reference", null);
  const rows = ref.split("\n").filter((l) => l.startsWith("| "));
  const listed = (c) => rows.some((r) => r.includes(`\`${c}\``) || r.includes(`\`${c} `) || r.includes(`\`${c}[`) || new RegExp(`[\`,] *${c}[\`,]`).test(r));
  const missing = COMMANDS.filter((c) => !["help"].includes(c) && !listed(c));
  assert.deepEqual(missing, [], `add these to docs/USAGE.md's command reference: ${missing.join(", ")}`);
});

test("every command an owner types is in INSTRUCTIONS.md (and its project copy)", () => {
  const missing = COMMANDS.filter((c) => !INTERNAL.includes(c) && !instructions.includes(`autoclaude ${c}`) && !instructions.includes(`/autoclaude:${c}`));
  assert.deepEqual(missing, [], `add these to INSTRUCTIONS.md, then copy it over plugins/autoclaude/project-template/AUTOCLAUDE.md: ${missing.join(", ")}`);
  assert.equal(read("plugins/autoclaude/project-template/AUTOCLAUDE.md"), instructions, "copy INSTRUCTIONS.md over the project template's AUTOCLAUDE.md");
});
