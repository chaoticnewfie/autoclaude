// Prepares spikes/out/todo-live for the Phase 8 practice run (PLAN.md P8.9): the fixture app as a
// plain project with no AutoClaude files, one commit, and a local bare repository as its "origin"
// so the run's pushes can be checked without touching GitHub. /autoclaude:plan then sets it up
// from scratch. spikes/out/todo-live is the scratch path this VM trusts for interactive runs.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { prepareFixture, gitEnv } from "../../test/fixtures/prepare.js";

const dest = process.argv[2] || "C:/AutoClaude/spikes/out/todo-live";
const remote = process.argv[3] || "C:/AutoClaude/spikes/out/practice-remote.git";
const env = gitEnv(process.env);
const git = (cwd, ...args) => {
  const r = spawnSync("git", args, { cwd, env, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

fs.rmSync(remote, { recursive: true, force: true });
prepareFixture({ dest, plan: "happy", git: true, env });
// Back to an app that has never seen AutoClaude: the plan skill writes all of this itself.
for (const f of ["PLAN.md", "autoclaude.config.json", "PROGRESS.md", "CONTINUE_HERE.md", "docs"]) fs.rmSync(path.join(dest, f), { recursive: true, force: true });
fs.writeFileSync(path.join(dest, ".gitignore"), "node_modules/\n");
// The project sits inside this repository, so every session there would also load AutoClaude's
// own CLAUDE.md (its build rules). A real project has no such parent: exclude it.
fs.mkdirSync(path.join(dest, ".claude"), { recursive: true });
fs.writeFileSync(path.join(dest, ".claude", "settings.json"), JSON.stringify({ claudeMdExcludes: ["C:/AutoClaude/CLAUDE.md", "**/AutoClaude/CLAUDE.md"] }, null, 2) + "\n");
git(dest, "add", "-A");
git(dest, "commit", "-qm", "practice: the app before AutoClaude");
const branch = git(dest, "rev-parse", "--abbrev-ref", "HEAD");
git(path.dirname(remote), "init", "-q", "--bare", remote);
git(dest, "remote", "add", "origin", remote);
git(dest, "push", "-q", "-u", "origin", branch);
console.log(`prepared ${dest} on ${branch}, origin ${remote}`);
console.log(git(dest, "log", "--oneline"));
