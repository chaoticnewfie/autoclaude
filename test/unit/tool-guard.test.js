import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { decide, writesTo } from "../../plugins/autoclaude/scripts/tool-guard.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";

const root = process.platform === "win32" ? "C:\\proj" : "/proj";
// git.push defaults to true since 0.10.0 (D49); these tests check the push-off rules, so they say so.
const ctx = { root, config: mergeConfig({ git: { push: false } }) };
const d = (tool_name, tool_input) => decide({ tool_name, tool_input }, ctx);

test("AskUserQuestion is denied with the decide-it-yourself guidance", () => {
  assert.match(d("AskUserQuestion", { questions: [] }), /No human is available/);
});

test("edits to the plan, the config and .autoclaude are denied; other files are fine", () => {
  assert.match(d("Edit", { file_path: path.join(root, "PLAN.md") }), /managed by the gate/);
  assert.match(d("Write", { file_path: path.join(root, "autoclaude.config.json") }), /managed by the gate/);
  assert.match(d("Write", { file_path: path.join(root, ".autoclaude", "state.json") }), /managed by the gate/);
  assert.equal(d("Edit", { file_path: path.join(root, "src", "app.js") }), null);
  assert.equal(d("Edit", { file_path: path.join(root, "docs", "PLAN.md") }), null, "a differently located file with the same name is not the plan");
});

test("bash: force push, push when off, reset --hard, commits, recursive deletes and plan rewrites are denied", () => {
  assert.match(d("Bash", { command: "git push --force origin main" }), /Force pushes/);
  assert.match(d("Bash", { command: "git push -f" }), /Force pushes/);
  assert.match(d("Bash", { command: "git push origin HEAD" }), /Pushing is off/);
  assert.match(d("Bash", { command: "git reset --hard HEAD~1" }), /reset --hard/);
  assert.match(d("Bash", { command: "git commit -m x" }), /gate commits/);
  assert.match(d("Bash", { command: "rm -rf /" }), /Recursive deletes/);
  assert.match(d("Bash", { command: "rm -rf C:\\Users" }), /Recursive deletes/);
  assert.match(d("Bash", { command: "rm -rf ../other" }), /Recursive deletes/);
  assert.match(d("Bash", { command: "echo x > PLAN.md" }), /Shell writes to PLAN\.md/);
  assert.match(d("Bash", { command: "sed -i s/a/b/ PLAN.md" }), /Shell writes to PLAN\.md/);
  assert.match(d("Bash", { command: "cat x | tee .autoclaude/state.json" }), /gate's state/);
  assert.equal(d("Bash", { command: "rm -rf node_modules" }), null, "deleting inside the project is allowed");
  assert.equal(d("Bash", { command: "git status" }), null);
  assert.equal(d("Bash", { command: "grep ready PLAN.md" }), null, "reading the plan is fine");
  assert.equal(d("Bash", { command: "npm test" }), null);
});

test("reads of protected files are allowed even with redirects elsewhere on the line (live-run false positives)", () => {
  assert.equal(d("Bash", { command: "ls -la && cat CONTINUE_HERE.md 2>/dev/null; cat autoclaude.config.json; ls test 2>/dev/null" }), null);
  assert.equal(d("Bash", { command: "cat .autoclaude/state.json | head -40" }), null);
  assert.equal(d("Bash", { command: "ls .autoclaude 2>/dev/null; cat PLAN.md" }), null);
  assert.equal(d("Bash", { command: "node -e \"console.log(1)\" > out.txt 2>&1; cat PLAN.md" }), null);
  assert.match(d("Bash", { command: "cat x > .autoclaude/state.json" }), /gate's state/);
  assert.match(d("Bash", { command: "rm .autoclaude/ready.json" }), /gate's state/);
  assert.match(d("Bash", { command: "mv PLAN.md PLAN.old" }), /Shell writes to PLAN\.md/);
  assert.match(d("Bash", { command: "cp other.md autoclaude.config.json" }), /read-only/);
  assert.match(d("Bash", { command: "Set-Content -Path PLAN.md -Value x" }), /Shell writes to PLAN\.md/);
});

test("guard.deny: project rules block matching commands, case-insensitively, with their reason", () => {
  const rules = { root, config: mergeConfig({ guard: { deny: [
    { pattern: "\\bssh\\b|\\bscp\\b", reason: "this machine holds keys to other hosts" },
    { pattern: "\\b(qm|pct|zpool|zfs)\\b", reason: "no infrastructure commands" },
    { pattern: "[(" , reason: "a broken pattern is skipped, not fatal" }
  ] } }) };
  const g = (command) => decide({ tool_name: "Bash", tool_input: { command } }, rules);
  assert.match(g("ssh root@10.0.0.2 uptime"), /does not allow that command.*keys to other hosts/);
  assert.match(g("SCP file host:/tmp"), /keys to other hosts/);
  assert.match(g("zpool create tank /dev/sdb"), /no infrastructure commands/);
  assert.equal(g("npm test"), null);
  assert.equal(g("echo sshd_config is a file name"), null, "word boundaries keep near misses out");
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: path.join(root, "ssh.js") } }, rules), null, "rules apply to shell commands only");
});

test("push is allowed when the config says so", () => {
  const allowPush = { root, config: mergeConfig({ git: { push: true } }) };
  assert.equal(decide({ tool_name: "Bash", tool_input: { command: "git push origin HEAD" } }, allowPush), null);
});

// The shell rules below read paths with Windows rules for a C:\ root and POSIX rules for a /
// root on every OS, so both sets run everywhere.
// The temp folder is fixed here so the results do not depend on the machine running the tests.
const win = { root: "C:\\proj", config: mergeConfig({ git: { push: false } }), tempDirs: ["C:\\Users\\someone\\AppData\\Local\\Temp"] };
const nix = { root: "/proj", config: mergeConfig({ git: { push: false } }), tempDirs: ["/tmp"] };
const pushOn = (ctx) => ({ ...ctx, config: mergeConfig({ git: { push: true } }) });
const sh = (ctx, command, extra = {}) => decide({ tool_name: "Bash", tool_input: { command }, ...extra }, ctx);
const ps = (ctx, command, extra = {}) => decide({ tool_name: "PowerShell", tool_input: { command }, ...extra }, ctx);
const RECURSIVE = /Recursive deletes outside the project/;
const PLAN = /Shell writes to PLAN\.md/;
const CONFIG = /autoclaude\.config\.json is read-only/;
const STATE = /gate's state/;

test("PowerShell: every Bash git rule applies", () => {
  assert.match(ps(win, "git push"), /Pushing is off/);
  assert.match(ps(win, "git push --force origin main"), /Force pushes/);
  assert.match(ps(win, "git reset --hard HEAD~1"), /reset --hard/);
  assert.match(ps(win, "git commit -m x"), /gate commits/);
  assert.match(ps(win, "git tag v1"), /gate commits/);
  assert.match(ps(win, "& 'C:\\Program Files\\Git\\cmd\\git.exe' push"), /Pushing is off/, "the call operator and a full path to git");
  assert.equal(ps(win, "git status; git log --oneline -5"), null);
  assert.equal(ps(pushOn(win), "git push origin HEAD"), null);
});

test("PowerShell: writers, deletes, moves and copies onto the plan, the config or .autoclaude are denied", () => {
  assert.match(ps(win, "Set-Content -Path PLAN.md -Value x"), PLAN);
  assert.match(ps(win, "Set-Content -Path:PLAN.md -Value x"), PLAN);
  assert.match(ps(win, "'x' | Out-File -FilePath PLAN.md -Encoding utf8"), PLAN);
  assert.match(ps(win, "(Get-Content PLAN.md) -replace '\\[ \\]','[x]' | Set-Content PLAN.md"), PLAN);
  assert.match(ps(win, "Add-Content autoclaude.config.json 'x'"), CONFIG);
  assert.match(ps(win, "Clear-Content .\\autoclaude.config.json"), CONFIG);
  assert.match(ps(win, "Remove-Item .autoclaude\\ready.json"), STATE);
  assert.match(ps(win, "Move-Item PLAN.md PLAN.old"), PLAN);
  assert.match(ps(win, "Move-Item -Path notes.md -Destination PLAN.md"), PLAN);
  assert.match(ps(win, "Copy-Item other.md -Destination autoclaude.config.json"), CONFIG);
  assert.match(ps(win, "Copy-Item x.json .autoclaude\\state.json"), STATE);
  assert.match(ps(win, "New-Item -ItemType File -Path .autoclaude\\ready.json -Force"), STATE);
  assert.match(ps(win, "New-Item -Force PLAN.md"), PLAN);
  assert.match(ps(win, "New-Item -Path . -Name PLAN.md -ItemType File -Force"), PLAN);
  assert.match(ps(win, "echo x > PLAN.md"), PLAN);
  assert.match(ps(win, "Get-Date *>> .autoclaude\\log.txt"), STATE);
  assert.match(ps(win, "[IO.File]::WriteAllText(\"PLAN.md\", \"x\")"), PLAN);
  assert.match(ps(win, "Set-Content PLAN.md -Value @\"\nline one\nline two\n\"@"), PLAN);
  assert.equal(ps(win, "Copy-Item PLAN.md backup\\PLAN.md"), null, "copying the plan somewhere else only reads it");
  assert.equal(ps(win, "Get-Content PLAN.md | Select-String ready"), null);
  assert.equal(ps(win, "Get-Content .autoclaude\\state.json 2>$null"), null);
  assert.equal(ps(win, "Set-Content -Path notes.md -Value 'PLAN.md is read-only'"), null, "a value is data, not a path");
  assert.equal(ps(win, "New-Item -ItemType Directory -Force dist"), null);
});

test("PowerShell: recursive deletes outside the project are denied, inside are fine", () => {
  assert.match(ps(win, "Remove-Item -Recurse -Force C:\\Users\\someone"), RECURSIVE);
  assert.match(ps(win, "Remove-Item ..\\other -Recurse"), RECURSIVE);
  assert.match(ps(win, "rm -r -fo ..\\other"), RECURSIVE);
  assert.match(ps(win, "Remove-Item -LiteralPath 'D:\\data' -Recurse:$true"), RECURSIVE);
  assert.match(ps(win, "Remove-Item -Rec $env:APPDATA\\x"), RECURSIVE, "a path from a variable cannot be checked, so it counts as outside");
  assert.equal(ps(win, "Remove-Item -Rec $env:TEMP\\x"), null, "inside the temp folder (P8.4)");
  assert.match(ps(win, "powershell -NoProfile -Command \"Remove-Item -Recurse C:\\Windows\\Temp\\x\""), RECURSIVE);
  assert.equal(ps(win, "Remove-Item -Recurse -Force node_modules"), null);
  assert.equal(ps(win, "Remove-Item dist -Recurse -Force"), null);
  assert.equal(ps(win, "Remove-Item -Recurse -Force C:\\proj\\dist"), null);
  assert.equal(ps(win, "Remove-Item -Recurse $PWD\\dist"), null);
  assert.equal(ps(win, "Remove-Item -Force ..\\notes.txt"), null, "-Force is not -Recurse; a single file is not a recursive delete");
  assert.match(ps(win, "Remove-Item -Recurse -Force .autoclaude\\"), STATE);
});

test("guard.deny rules apply to the PowerShell tool too", () => {
  const rules = { ...win, config: mergeConfig({ guard: { deny: [{ pattern: "\\bssh\\b", reason: "no remote hosts" }] } }) };
  assert.match(ps(rules, "ssh root@host uptime"), /no remote hosts/);
  assert.equal(ps(rules, "npm test"), null);
});

test("git with global options before the subcommand", () => {
  for (const ctx of [win, nix]) {
    assert.match(sh(ctx, "git -C . push"), /Pushing is off/);
    assert.match(sh(ctx, "git --no-pager push origin main"), /Pushing is off/);
    assert.match(sh(ctx, "git -c user.name=x commit -m y"), /gate commits/);
    assert.match(sh(ctx, "git -C sub -c core.editor=true tag v1"), /gate commits/);
    assert.match(sh(ctx, "git --git-dir=.git --work-tree . reset --hard"), /reset --hard/);
    assert.match(sh(ctx, "npm test && git -C . commit -am wip"), /gate commits/);
    assert.match(sh(ctx, "bash -c 'git push'"), /Pushing is off/);
    assert.match(sh(ctx, "cmd //c \"git push\""), /Pushing is off/);
    assert.equal(sh(ctx, "git -C . status"), null);
    assert.equal(sh(ctx, "git --no-pager log --oneline --grep commit"), null);
    assert.equal(sh(ctx, "git -c color.ui=never diff"), null);
    assert.equal(sh(ctx, "echo \"remember to git push later\""), null, "a mention is not a command");
  }
});

test("force pushes: --force, -f in a cluster, --force-with-lease, a +refspec and --mirror", () => {
  const on = pushOn(nix);
  for (const c of ["git push --force", "git push -f", "git push -uf origin main", "git push --force-with-lease=main origin main", "git push --force-if-includes", "git push origin +main", "git push origin +HEAD:refs/heads/main", "git push --mirror", "git -C . push --force"]) {
    assert.match(sh(on, c), /Force pushes/, c);
  }
  for (const c of ["git push origin main", "git push -u origin feature", "git push --follow-tags origin main", "git push origin HEAD:main"]) {
    assert.equal(sh(on, c), null, c);
  }
});

test("rm with separated, long and upper-case flags; quoted paths", () => {
  for (const ctx of [win, nix]) {
    for (const c of ["rm -r -f ../other", "rm --recursive --force ../other", "rm -R ../other", "rm -r ../other", "rm -Rf ../other", "rm -fr ../other", "rm -rf \"../other dir\"", "rm -rf '/'", "rm -rf -- ../other", "sudo rm -rf ../other"]) {
      assert.match(sh(ctx, c), RECURSIVE, c);
    }
    for (const c of ["rm -r -f node_modules", "rm --recursive --force dist", "rm -R build", "rm -rf \"my dist\"", "rm -rf 'node_modules'", "rm -rf ./dist/", "rm -rf my\\ dist", "rm ../notes.txt", "rm -f ../notes.txt"]) {
      assert.equal(sh(ctx, c), null, c);
    }
  }
});

test("recursive deletes: the target is resolved against the project root, in every path form", () => {
  // Windows root: C:\ forms, forward slashes, Git Bash /c/ forms, case differences.
  for (const c of ["rm -rf /c/proj/dist", "rm -rf C:\\proj\\dist", "rm -rf C:/proj/dist", "rm -rf c:\\PROJ\\dist", "rm -rf /c/proj/node_modules/.cache", "rm -rf \"$(pwd)/dist\"", "rm -rf $PWD/dist", "rm -rf ${PWD}/dist"]) {
    assert.equal(sh(win, c), null, c);
  }
  for (const c of ["rm -rf /c/other", "rm -rf /c", "rm -rf /", "rm -rf C:\\Users", "rm -rf C:\\project2", "rm -rf D:\\proj\\dist", "rm -rf /c/tmp/build", "rm -rf ~", "rm -rf ~/stuff", "rm -rf $HOME/x", "rm -rf \"$DIR\"", "rm -rf ../*", "rm -rf \\\\server\\share\\x"]) {
    assert.match(sh(win, c), RECURSIVE, c);
  }
  // POSIX root.
  assert.equal(sh(nix, "rm -rf /proj/dist"), null);
  assert.match(sh(nix, "rm -rf /proj2"), RECURSIVE);
  assert.match(sh(nix, "rm -rf C:\\Users"), RECURSIVE);
  for (const ctx of [win, nix]) {
    assert.match(sh(ctx, "rm -rf ."), RECURSIVE, "the whole project");
    assert.match(sh(ctx, "rm -rf ./"), RECURSIVE);
    // cd earlier on the line moves where relative paths point.
    assert.equal(sh(ctx, "cd .. && rm -rf proj/dist"), null);
    assert.match(sh(ctx, "cd .. && rm -rf other"), RECURSIVE);
    assert.match(sh(ctx, "cd /opt; rm -rf build"), RECURSIVE);
    assert.equal(sh(ctx, "cd /tmp; rm -rf build"), null, "inside the temp folder (P8.4)");
    assert.equal(sh(ctx, "cd src && rm -rf ../dist"), null);
    // find -delete and find -exec rm.
    assert.match(sh(ctx, "find .. -name '*.tmp' -delete"), RECURSIVE);
    assert.match(sh(ctx, "find / -name x -exec rm -rf {} +"), RECURSIVE);
    assert.equal(sh(ctx, "find . -name '*.tmp' -delete"), null);
    assert.equal(sh(ctx, "find src -type f -exec rm {} +"), null);
    assert.match(sh(ctx, "find . -delete"), RECURSIVE, "an unfiltered find from the root deletes the whole project");
    assert.match(sh(ctx, "find .autoclaude -delete"), STATE);
    assert.equal(sh(ctx, "find .. -name '*.md'"), null, "find without -delete only reads");
  }
  // The session's working directory (hook input cwd) is where a relative path starts.
  assert.equal(sh(win, "rm -rf ../dist", { cwd: "C:\\proj\\src" }), null);
  assert.match(sh(win, "rm -rf ../dist"), RECURSIVE);
  // cmd.exe forms.
  assert.match(sh(win, "cmd //c rd /s /q C:\\Windows\\Temp\\x"), RECURSIVE);
  assert.match(ps(win, "cmd /c \"rd /s /q ..\\other\""), RECURSIVE);
  assert.equal(sh(win, "cmd //c \"rd /s /q dist\""), null);
});

test("deleting or moving .autoclaude itself, with or without a trailing slash", () => {
  for (const ctx of [win, nix]) {
    for (const c of ["rm -rf .autoclaude", "rm -rf .autoclaude/", "rm -rf ./.autoclaude", "rm -r .autoclaude", "rm .autoclaude/*", "mv .autoclaude old-state", "mv .autoclaude/ /tmp/x", "mv notes.txt .autoclaude/notes.txt", "git clean -fdx", "git clean -fX", "rmdir .autoclaude"]) {
      assert.match(sh(ctx, c), STATE, c);
    }
    for (const c of ["ls .autoclaude/", "cat .autoclaude/state.json", "git clean -fd", "git clean -fdx dist", "rm -rf dist/.autoclaude-cache"]) {
      assert.equal(sh(ctx, c), null, c);
    }
  }
});

test("git checkout and git restore of the plan count as writes to it", () => {
  for (const ctx of [win, nix]) {
    for (const c of ["git checkout -- PLAN.md", "git checkout HEAD~1 PLAN.md", "git restore PLAN.md", "git restore --source=HEAD~2 PLAN.md", "git restore --staged --worktree ./PLAN.md", "git -C . checkout -- PLAN.md", "git rm PLAN.md", "git mv PLAN.md OLD.md"]) {
      assert.match(sh(ctx, c), PLAN, c);
    }
    assert.match(sh(ctx, "git checkout -- autoclaude.config.json"), CONFIG);
    for (const c of ["git checkout -- src/app.js", "git restore src/app.js", "git checkout main", "git checkout -b feature", "git diff PLAN.md", "git show HEAD:PLAN.md", "git log -- PLAN.md"]) {
      assert.equal(sh(ctx, c), null, c);
    }
  }
});

test("other shell writers, quoting, wildcards, nested plan paths and non-commands", () => {
  for (const ctx of [win, nix]) {
    assert.match(sh(ctx, "echo x > \"PLAN.md\""), PLAN);
    assert.match(sh(ctx, "echo x>PLAN.md"), PLAN);
    assert.match(sh(ctx, "echo x >> 'PLAN.md'"), PLAN);
    assert.match(sh(ctx, "npm test &> .autoclaude/out.log"), STATE);
    assert.match(sh(ctx, "cp other.md autoclaude.config.json && echo ok"), CONFIG, "the destination need not end the line");
    assert.match(sh(ctx, "perl -pi -e 's/a/b/' PLAN.md"), PLAN);
    assert.match(sh(ctx, "sed -i.bak 's/a/b/' PLAN.md"), PLAN);
    assert.match(sh(ctx, "rm *.md"), PLAN, "a wildcard that matches the plan");
    assert.match(sh(ctx, "node -e \"require('fs').writeFileSync('PLAN.md', 'x')\""), PLAN);
    assert.match(sh(ctx, "python -c \"open('autoclaude.config.json', 'w').write('{}')\""), CONFIG);
    assert.equal(sh(ctx, "grep -n writeFileSync PLAN.md"), null);
    assert.equal(sh(ctx, "node -e \"console.log(require('fs').readFileSync('PLAN.md', 'utf8'))\""), null);
    assert.equal(sh(ctx, "rm *.log"), null);
    assert.equal(sh(ctx, "ls # rm -rf / is a comment"), null);
    // A heredoc body is data; the command after it is still read.
    assert.equal(sh(ctx, "cat > notes.md <<'EOF'\nrm -rf /\ngit push\nEOF"), null);
    assert.match(sh(ctx, "cat > notes.md <<EOF\ntext\nEOF\ngit push"), /Pushing is off/);
  }
  const nested = { root: "/proj", config: mergeConfig({ plan: "docs/PLAN.md" }) };
  assert.match(sh(nested, "rm -rf docs"), /Shell writes to docs\/PLAN\.md/, "removing the folder the plan is in");
  assert.match(sh(nested, "mv docs old-docs"), /Shell writes to docs\/PLAN\.md/);
  assert.equal(sh(nested, "cp README.md docs"), null, "copying into the plan's folder does not touch the plan");
  assert.equal(sh(nested, "echo x > PLAN.md"), null, "a PLAN.md at the root is not this project's plan");
});

test("writesTo keeps working for callers that match a path fragment", () => {
  assert.equal(writesTo("echo x > PLAN.md", "PLAN.md"), true);
  assert.equal(writesTo("rm -rf .autoclaude", ".autoclaude/"), true);
  assert.equal(writesTo("cat PLAN.md > copy.md", "PLAN.md"), false);
  assert.equal(writesTo("Set-Content -Path PLAN.md -Value x", "PLAN.md", "powershell"), true);
});
