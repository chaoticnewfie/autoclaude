// The /autoclaude:security and /autoclaude:optimize skills (PLAN.md P10.6, D58): what they ask,
// and that the options file they write is one the sweep engine accepts.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { MODULES, TEST_KINDS, normalizeOptions, validateSweepOptions } from "../../plugins/autoclaude/lib/sweep.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";
import { COMMANDS, commandHelp } from "../../plugins/autoclaude/lib/cli.js";
import { FIX_PLAN_FILES } from "../../plugins/autoclaude/lib/fixplan.js";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(`../../plugins/autoclaude/${rel}`, import.meta.url)), "utf8");
const SKILLS = { security: read("skills/security/SKILL.md"), optimize: read("skills/optimize/SKILL.md") };
const jsonBlocks = (md) => [...md.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]);

for (const [kind, md] of Object.entries(SKILLS)) {
  test(`the ${kind} skill: frontmatter, the ask-never-assume rules and the three outcomes`, () => {
    const front = md.match(/^---\nname: ([a-z]+)\ndescription: (.+)\n---\n/);
    assert.ok(front, "frontmatter with name and description");
    assert.equal(front[1], kind);
    assert.match(front[2], new RegExp(`/autoclaude:${kind}\\b`));
    assert.match(md, /AskUserQuestion/);
    assert.match(md, /"\(Recommended\)"/);
    assert.match(md, /Rounds of up to 4 questions/);
    assert.match(md, /numbered\s+text questions/, "the headless fallback");
    assert.match(md, /Ask before installing, pulling or starting anything/);
    assert.match(md, /"Fix right away \(Recommended\)"/);
    assert.match(md, /"Report and a fix plan to review"/);
    assert.match(md, /"Report\s+only"/);
    assert.match(md, /"thorough \(Recommended\)"/);
    assert.match(md, /autoclaude checks/, "unproven checks are proven the way the gate runs them");
    assert.match(md, /section 3b/, "setup follows the plan skill");
    assert.match(md, /ac-sweep-<project>/);
    assert.match(md, /autoclaude status/);
    assert.match(md, /sweep-run <id>/);
    assert.match(md, new RegExp(`autoclaude ${kind} --options \\.autoclaude/sweep-options-${kind}\\.json --estimate`));
    assert.match(md, new RegExp("```\\n\\s*autoclaude " + kind + " --options \\.autoclaude/sweep-options-" + kind + "\\.json\\n\\s*```"), "the start command, on its own");
    assert.match(md, /autoclaude\.accepted\.json/);
    assert.ok(!/\b(TODO|TBD)\b/.test(md));
    assert.ok(!/10\.10\.|192\.168\.|C:\\Users|chaoticnewfie|scott/i.test(md), "nothing personal in a shared skill");
  });

  test(`the ${kind} skill's options file is one the sweep engine accepts`, () => {
    const opts = jsonBlocks(md).map((b) => JSON.parse(b)).find((j) => j && j.kind === kind);
    assert.ok(opts, "an options example");
    assert.deepEqual(Object.keys(opts).sort(), ["advisories", "after", "depth", "exclude", "kind", "modules", "resetCommand", "targets", "testUsers", "tests", "writesAllowed"]);
    assert.deepEqual(opts.modules, [...MODULES[kind]], "every module on by default");
    assert.equal(opts.depth, "thorough");
    assert.equal(opts.after, "fix");
    assert.equal(opts.writesAllowed, false);
    if (kind === "security") assert.deepEqual(Object.keys(opts.tests).sort(), [...TEST_KINDS].sort());
    const norm = normalizeOptions(kind, opts, mergeConfig({ devServer: { command: "npm run dev", url: "http://127.0.0.1:3000" } }));
    assert.deepEqual(validateSweepOptions(norm), []);
    assert.equal(norm.targets[0].url, "http://127.0.0.1:3000");
    assert.equal(norm.targets[0].mode, "readonly");
    const accepted = jsonBlocks(md).map((b) => JSON.parse(b)).find(Array.isArray);
    assert.deepEqual(Object.keys(accepted[0]).sort(), ["by", "date", "fingerprint", "kind", "reason"]);
    assert.equal(accepted[0].kind, kind);
  });
}

// Every `autoclaude <command> --flag ...` a skill tells the owner (or itself) to run, from inline
// code and from code blocks.
function cliMentions(md) {
  const out = [];
  for (const m of md.matchAll(/`autoclaude ([a-z][a-z-]*)([^`\n]*)`/g)) out.push({ cmd: m[1], rest: m[2], text: m[0] });
  for (const block of md.matchAll(/```[a-z]*\n([\s\S]*?)```/g)) {
    for (const line of block[1].split("\n")) {
      const m = line.trim().match(/^autoclaude ([a-z][a-z-]*)(.*)$/);
      if (m) out.push({ cmd: m[1], rest: m[2], text: line.trim() });
    }
  }
  return out;
}

for (const [kind, md] of Object.entries(SKILLS)) {
  test(`the ${kind} skill names only CLI commands and flags that exist`, () => {
    const mentions = cliMentions(md);
    assert.ok(mentions.length >= 8, `found ${mentions.length}`);
    for (const { cmd, rest, text } of mentions) {
      assert.ok(COMMANDS.includes(cmd), `${text}: no such command`);
      // The sweep options are listed once, under optimize, for both sweep commands.
      const help = `${commandHelp(cmd)}\n${cmd === "security" ? commandHelp("optimize") : ""}`;
      for (const flag of rest.match(/--[a-z][a-z-]*/g) || []) assert.ok(help.includes(flag), `${text}: ${cmd} has no ${flag}`);
    }
    assert.ok(mentions.some((m) => m.cmd === kind && /--estimate/.test(m.rest)), "the estimate");
    assert.doesNotMatch(md, /unknown option/, "no fallback for a flag the CLI does not have");
  });

  test(`the ${kind} skill tells the owner where a plan-mode sweep leaves its plan and the command that runs it`, () => {
    const file = FIX_PLAN_FILES[kind];
    const inFolder = `.autoclaude/sweeps/<id>/${file}`.replace(/[.]/g, "[.]");
    assert.match(md, new RegExp(`plan stays in the sweep's folder,\\s+\`${inFolder}\`, and nothing in the project changes`));
    assert.match(md, new RegExp(`\`autoclaude run --plan ${inFolder}\`\\. That makes a new\\s+branch from the current commit, commits the plan there as \`${file.replace(/[.]/g, "[.]")}\``));
    assert.match(md, new RegExp(`\`autoclaude run --plan ${inFolder} --check\` shows first`));
    assert.match(md, new RegExp(`HANDOFF-${kind.toUpperCase()}\\.md`));
    assert.doesNotMatch(md, /ends with `HANDOFF\.md`/);
    assert.doesNotMatch(md, /\(it changes nothing\)/, "a sweep beside a run is described as it is");
    assert.match(md, /autoResumeAfterWeeklyReset/);
    assert.match(md, /autoclaude watchdog --install/);
  });

  test(`the ${kind} skill says how to stop a sweep for good, and that a resumable one holds up a new one`, () => {
    assert.match(md, /closing the window does not stop a\s+sweep; `autoclaude sweep-stop` does/);
    assert.match(md, /the\s+watchdog leaves a stopped sweep alone;\s+`autoclaude sweep-run <id>` resumes it on purpose/);
    assert.match(md, new RegExp(`\`autoclaude sweep-stop <id>\` gives it up for good[\\s\\S]*only then can a new ${kind} sweep start`));
    assert.match(md, /A second sweep of the same\s+kind is refused while one is running, waiting, paused or gone\s+with its window/);
    assert.ok(cliMentions(md).some((m) => m.cmd === "sweep-stop"));
  });
}

test("the security skill: targets, production warning, written permission, throwaway data and test logins", () => {
  const md = SKILLS.security;
  assert.match(md, /Production: "Off \(Recommended\)", "Read-only checks"/);
  assert.match(md, /"Use read-only checks instead \(Recommended\)" or "Full attacks: I accept the risk"/);
  assert.match(md, /written\s+permission to test it/);
  assert.match(md, /throwaway/);
  assert.match(md, /secrets\/sweep-users\.json/);
  assert.match(md, /git check-ignore -q secrets\/sweep-users\.json/);
  assert.match(md, /No\s+password, token or secret ever goes in this file/);
  const users = jsonBlocks(md).map((b) => JSON.parse(b)).find((j) => j && Array.isArray(j.users));
  assert.equal(users.users.length, 2);
  for (const u of users.users) assert.equal(u.password, "type it here", "placeholders only");
  assert.match(md, /docs\/private\/SECURITY-FINDINGS\.md/);
  assert.match(md, /git rm --cached -- <file>/);
  assert.match(md, /"Look up advisories \(Recommended\)/);
});

test("the optimize skill: rebuilds behind pinned tests, the fixed rules, and no writes", () => {
  const md = SKILLS.optimize;
  assert.match(md, /"Allowed, with tests that pin today's behaviour written\s+first \(Recommended\)"/);
  assert.match(md, /minor and patch upgrades are made, major upgrades are\s+report-only/);
  assert.match(md, /fixed with a test and listed in\s+`HANDOFF-OPTIMIZE\.md` as a behaviour change/);
  assert.match(md, /never weakening a test/);
});

test("the plan skill points existing projects at the sweeps and offers the findings file move", () => {
  const md = read("skills/plan/SKILL.md");
  assert.match(md, /`\/autoclaude:security`/);
  assert.match(md, /`\/autoclaude:optimize`/);
  assert.match(md, /Neither needs this plan first/);
  assert.match(md, /"Move it to\s+docs\/private\/ \(Recommended\)/);
  assert.match(md, /git rm --cached -- <file>/);
  assert.match(md, /`docs\/private\/`, where the run files the security\s+findings/);
});
