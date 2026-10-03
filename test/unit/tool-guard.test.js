import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
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

test("pushes that delete or force remote refs are denied whatever the remote, in any spelling git accepts; a plain push is not", () => {
  const on = pushOn(nix);
  const DELETE = /Deleting remote branches or tags/;
  for (const c of ["git push origin --delete release", "git push -d origin release", "git push -ud origin x", "git push origin :release", "git push https://example.com/other.git :refs/tags/v1", "git push --prune origin 'refs/heads/*:refs/heads/*'", "git push --del origin x"]) {
    assert.match(sh(on, c), DELETE, c);
  }
  // Git takes any unambiguous prefix of a long option: --mirr is --mirror, --force-w is --force-with-lease.
  for (const c of ["git push --mirr origin", "git push --m origin", "git push --force-w origin main", "git push --force-i origin main", "git push -vf", "git push origin main -f", "git push --all --force origin", "git push origin +main"]) {
    assert.match(sh(on, c), /Force pushes/, c);
  }
  // Settings that turn a later plain push into a forced or mirrored one, or alias push away.
  for (const c of ["git -c alias.p='push --force' p origin main", "git -c remote.origin.push=+HEAD:main push origin", "git -c remote.origin.mirror=true push origin", "git -c push.default=matching push", "git -c include.path=/tmp/x.cfg push", "git --config-env=alias.p=P p", "git config alias.p 'push --force'", "git config --local remote.origin.mirror true", "git config set alias.pf 'push -f'", "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=alias.p GIT_CONFIG_VALUE_0='push --force' git p"]) {
    assert.match(sh(on, c), /Changing git aliases or push settings/, c);
  }
  assert.match(sh(nix, "git -c alias.p='push --force' p origin main"), /Changing git aliases/, "with pushing off too");
  assert.match(ps(pushOn(win), "$env:GIT_CONFIG_PARAMETERS = \"'alias.p=push --force'\"; git p"), /Changing git aliases/);
  // A plain push to any remote, a new repository included, and harmless settings.
  for (const c of ["git push origin HEAD:main", "git push https://github.com/someone/new-repo.git HEAD", "git push -u origin feature", "git push --all origin", "git push --tags", "git push -o ci.skip origin x", "git push -uo ci.skip origin x", "git push --no-force-with-lease origin x", "git config --get alias.p", "git config --global push.autoSetupRemote true", "git config user.email x@example.com", "git -c core.quotepath=off status"]) {
    assert.equal(sh(on, c), null, c);
  }
});

test("git commands that only read pass: git tag listings and git config <key>; making, deleting and setting stay denied", () => {
  for (const ctx of [win, nix]) {
    for (const c of [
      "git tag", "git tag -l", "git tag --list 'v*'", "git tag -n", "git tag -n5 -l", "git tag --contains HEAD", "git tag --points-at HEAD", "git tag --merged main",
      "git tag --sort=-v:refname", "git tag -v v1", "git config push.default", "git config alias.st", "git config remote.origin.push", "git config --global push.default",
      "git config --get-all remote.origin.push", "git config get alias.p"
    ]) assert.equal(sh(ctx, c), null, c);
    for (const c of ["git tag v1", "git tag v1 HEAD~1", "git tag -a v1 -m 'release'", "git tag -f v1", "git tag -d v1", "git tag --delete v1", "git tag --del v1", "git -C . tag -s v1"]) {
      assert.match(sh(ctx, c), /gate commits/, c);
    }
    for (const c of ["git config push.default matching", "git config alias.st 'push -f'", "git config --add remote.origin.push '+refs/heads/*:refs/heads/*'"]) {
      assert.match(sh(ctx, c), /Changing git aliases or push settings/, c);
    }
  }
  assert.equal(ps(win, "git tag -l; git config alias.st"), null);
});

test("a wrapper's options and timeout's duration do not hide the command behind them", () => {
  for (const ctx of [win, nix]) {
    for (const c of ["timeout 5 rm -rf /", "timeout -k 5 30 rm -rf ../other", "nice -n 5 rm -rf /", "sudo -u root rm -rf /", "env -u HOME rm -rf ../other", "env -S 'rm -rf /'"]) {
      assert.match(sh(ctx, c), RECURSIVE, c);
    }
    assert.match(sh(ctx, "timeout 30 git push origin main"), /Pushing is off/);
    assert.match(sh(pushOn(ctx), "timeout 30 git push --force"), /Force pushes/);
    for (const c of ["timeout 60 npm test", "nice -n 10 rm -rf dist", "env NODE_ENV=test rm -rf dist", "sudo -u root rm -rf dist"]) assert.equal(sh(ctx, c), null, c);
  }
});

test("bash's own escapes and quoting: .\\. is .., $'...' and $\"...\" are not taken as plain text", () => {
  for (const ctx of [win, nix]) {
    // bash reads sub/.\. as sub/.., which is the project itself.
    for (const c of ["rm -rf sub/.\\.", "rm -rf a/b/.\\./.\\./.\\.", "rm -rf ..\\/other", "rm -rf $\"..\"", "rm -rf $'..'"]) assert.match(sh(ctx, c), RECURSIVE, c);
    assert.match(sh(ctx, "echo x > PLAN\\.md"), PLAN);
    assert.equal(sh(ctx, "grep -c $'\\r$' notes.txt"), null);
  }
});

test("this computer's AutoClaude defaults, notify settings and Claude Code user settings are read-only during a run", () => {
  const cfg = path.join(os.homedir(), ".claude-test");
  const m = { ...ctx, configDir: cfg };
  const MACHINE = /AutoClaude and Claude Code settings/;
  for (const f of [path.join(cfg, "autoclaude", "defaults.json"), path.join(cfg, "autoclaude", "notify.json"), path.join(cfg, "settings.json")]) {
    for (const tool of ["Edit", "Write", "MultiEdit"]) assert.match(decide({ tool_name: tool, tool_input: { file_path: f } }, m), /this computer's AutoClaude or Claude Code settings/, `${tool} ${f}`);
    assert.match(decide({ tool_name: "Bash", tool_input: { command: `echo '{}' > "${f.replace(/\\/g, "/")}"` } }, m), MACHINE, f);
  }
  if (process.platform === "win32") assert.match(decide({ tool_name: "Write", tool_input: { file_path: path.join(cfg.toUpperCase(), "AUTOCLAUDE", "Defaults.json") } }, m), /read-only during a run/);
  const bash = (command) => decide({ tool_name: "Bash", tool_input: { command } }, m);
  const pwsh = (command) => decide({ tool_name: "PowerShell", tool_input: { command } }, m);
  for (const c of [
    "echo '{\"tester\":{\"enabled\":false}}' > ~/.claude-test/autoclaude/defaults.json", "echo x > \"$CLAUDE_CONFIG_DIR/autoclaude/defaults.json\"",
    "echo x >> ${CLAUDE_CONFIG_DIR}/settings.json", "cp other.json ~/.claude-test/autoclaude/notify.json", "tee \"$X/autoclaude/defaults.json\" < x.json",
    "node -e \"require('fs').writeFileSync(require('os').homedir() + '/.claude-test/autoclaude/defaults.json', '{}')\""
  ]) assert.match(bash(c), MACHINE, c);
  const s = path.sep; // PowerShell takes either separator; Windows people type backslashes
  for (const c of [`Set-Content -Path $env:CLAUDE_CONFIG_DIR${s}autoclaude${s}defaults.json -Value '{}'`, `Copy-Item x.json -Destination $env:USERPROFILE${s}.claude-test${s}settings.json`, `[IO.File]::WriteAllText("$env:CLAUDE_CONFIG_DIR${s}autoclaude${s}notify.json", "{}")`]) {
    assert.match(pwsh(c), MACHINE, c);
  }
  // Reading them, and files of the same name elsewhere, are fine.
  for (const c of ["cat ~/.claude-test/autoclaude/defaults.json", "echo x > autoclaude/defaults.json.bak", "echo x > .claude/settings.json", "cp a.json config/settings.json"]) assert.equal(bash(c), null, c);
  assert.equal(pwsh(`Get-Content $env:CLAUDE_CONFIG_DIR${s}settings.json`), null);
  assert.equal(decide({ tool_name: "Write", tool_input: { file_path: path.join(root, ".claude", "settings.json") } }, m), null, "a project's own Claude settings are its files");
});

test("the Claude config folder is found the way lib/paths.js finds it: CLAUDE_CONFIG_DIR first", () => {
  const saved = process.env.CLAUDE_CONFIG_DIR;
  const dir = path.join(os.tmpdir(), "autoclaude-guard-config");
  process.env.CLAUDE_CONFIG_DIR = dir;
  try {
    assert.match(d("Write", { file_path: path.join(dir, "autoclaude", "defaults.json") }), /read-only during a run/);
    assert.match(d("Bash", { command: `echo x > "${path.join(dir, "settings.json").replace(/\\/g, "/")}"` }), /AutoClaude and Claude Code settings/);
  } finally {
    if (saved === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = saved;
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

test("cmd: ; , and = end a redirect's file name, so a bash-style ; cannot hide a plan write", () => {
  for (const line of ['cmd /c "type nul > PLAN.md;"', 'cmd /c "echo x > PLAN.md; echo y"', 'cmd /c "echo x>PLAN.md;"', 'cmd /c "echo x > PLAN.md,"', 'cmd /c "echo x > PLAN.md="']) {
    assert.match(ps(win, line), PLAN, line);
    assert.match(sh(win, line), PLAN, line);
  }
  assert.match(ps(win, 'cmd /c "echo x > autoclaude.config.json;"'), CONFIG);
  // Ordinary cmd lines with ; , = in their arguments still pass.
  assert.equal(ps(win, 'cmd /c "echo a;b > out.txt"'), null);
  assert.equal(ps(win, 'cmd /c "set X=1 & echo %X% > notes.txt"'), null);
});

// ---------- Phase 10: generated plans, the accepted list, the sweep reports (P10.7, D58) ----------

const fixRun = (ctx) => ({ ...ctx, config: mergeConfig({ git: { push: false }, plan: "SECURITY_PLAN.md" }), mainPlan: "PLAN.md" });
const MAIN = /Shell writes to PLAN\.md are not allowed; it is the project's own plan, left alone while this run works on SECURITY_PLAN\.md/;
const ACCEPTED = /autoclaude\.accepted\.json is the owner's list of accepted risks and false alarms/;

test("a run on a generated plan protects that plan and the project's own plan alike", () => {
  const ctx = fixRun({ root });
  assert.match(decide({ tool_name: "Edit", tool_input: { file_path: path.join(root, "SECURITY_PLAN.md") } }, ctx), /Only the gate ticks SECURITY_PLAN\.md/);
  const own = decide({ tool_name: "Write", tool_input: { file_path: path.join(root, "PLAN.md") } }, ctx);
  assert.match(own, /PLAN\.md \(the project's own plan\) is left alone while this run works on SECURITY_PLAN\.md/);
  assert.equal(decide({ tool_name: "Edit", tool_input: { file_path: path.join(root, "src", "app.js") } }, ctx), null);
  // Without a generated plan nothing changes: the main plan is the run's plan.
  const plain = { root, config: mergeConfig({ git: { push: false } }), mainPlan: "PLAN.md" };
  assert.match(decide({ tool_name: "Edit", tool_input: { file_path: path.join(root, "PLAN.md") } }, plain), /Only the gate ticks PLAN\.md; the config/);
  for (const c of [fixRun(win), fixRun(nix)]) {
    assert.match(sh(c, "echo x > SECURITY_PLAN.md"), /Shell writes to SECURITY_PLAN\.md/);
    assert.match(sh(c, "sed -i s/a/b/ PLAN.md"), MAIN);
    assert.match(sh(c, "mv PLAN.md PLAN.old"), MAIN);
    assert.match(sh(c, "node -e \"require('fs').writeFileSync('PLAN.md', 'x')\""), /PLAN\.md/);
    assert.equal(sh(c, "cat PLAN.md SECURITY_PLAN.md"), null, "reading both plans is fine");
  }
  assert.match(ps(fixRun(win), "Set-Content -Path PLAN.md -Value x"), MAIN);
});

test("autoclaude.accepted.json and the sweep reports are read-only during a run", () => {
  const ctx = { root, config: mergeConfig({ git: { push: false } }) };
  assert.match(decide({ tool_name: "Write", tool_input: { file_path: path.join(root, "autoclaude.accepted.json") } }, ctx), /only the owner changes it, never a run/);
  assert.match(decide({ tool_name: "Edit", tool_input: { file_path: path.join(root, ".autoclaude", "sweeps", "20261002-1430-security", "report.md") } }, ctx), /managed by the gate/);
  assert.match(decide({ tool_name: "Write", tool_input: { file_path: path.join(root, ".autoclaude", "run-plan.json") } }, ctx), /managed by the gate/);
  for (const c of [win, nix]) {
    assert.match(sh(c, "echo [] > autoclaude.accepted.json"), ACCEPTED);
    assert.match(sh(c, "rm autoclaude.accepted.json"), ACCEPTED);
    assert.match(sh(c, "node -e \"require('fs').writeFileSync('autoclaude.accepted.json', '[]')\""), ACCEPTED);
    assert.match(sh(c, "echo x >> .autoclaude/sweeps/20261002-1430-security/findings.json"), STATE);
    assert.match(sh(c, "rm -rf .autoclaude/sweeps"), STATE);
    assert.equal(sh(c, "cat .autoclaude/sweeps/20261002-1430-security/report.md"), null, "the builder reads the report for a finding's details");
    assert.equal(sh(c, "cat autoclaude.accepted.json"), null);
  }
  assert.match(ps(win, "Set-Content autoclaude.accepted.json '[]'"), ACCEPTED);
});

const PINNED = /test\/characterization\/ holds the characterization tests the pin step OF1\.1 wrote\. Step OF1\.2 changes the code under them/;

test("a change step under pinned tests may not write under test/characterization/, by any tool; other steps may", () => {
  for (const base of [win, nix]) {
    const pinned = { ...fixRun(base), config: mergeConfig({ git: { push: false }, plan: "OPTIMIZE_PLAN.md" }), pinned: { step: "OF1.2", dir: "test/characterization", pinStep: "OF1.1" } };
    const r = base.root;
    const sep = base === win ? "\\" : "/";
    const edit = (tool, file) => decide({ tool_name: tool, tool_input: tool === "NotebookEdit" ? { notebook_path: file } : { file_path: file } }, pinned);
    for (const tool of ["Edit", "Write", "MultiEdit", "NotebookEdit"]) {
      assert.match(edit(tool, `${r}${sep}test${sep}characterization${sep}opt-001.test.js`), PINNED, tool);
      assert.match(edit(tool, "test/characterization/deep/x.test.js"), PINNED, `${tool}, relative`);
    }
    assert.equal(edit("Edit", `${r}${sep}test${sep}opt-002.test.js`), null, "other tests are the step's to write");
    assert.equal(edit("Edit", `${r}${sep}src${sep}price.js`), null);
    assert.equal(edit("Edit", `${r}${sep}test${sep}characterization-notes.md`), null, "a sibling with a longer name is not the folder");
    for (const cmd of [
      "echo x > test/characterization/opt-001.test.js",
      "sed -i s/1/2/ test/characterization/opt-001.test.js",
      "rm -rf test/characterization",
      "rm test/characterization/*.js",
      "git checkout -- test/characterization/opt-001.test.js",
      "mv test/characterization/opt-001.test.js /tmp/x",
      "node -e \"require('fs').writeFileSync('test/characterization/opt-001.test.js', '')\""
    ]) assert.match(sh(pinned, cmd), PINNED, cmd);
    if (base === win) {
      assert.match(ps(pinned, "Set-Content -Path test\\characterization\\opt-001.test.js -Value x"), PINNED);
      assert.match(ps(pinned, "Remove-Item -Recurse -Force .\\test\\characterization"), PINNED);
    }
    assert.equal(sh(pinned, "cat test/characterization/opt-001.test.js && node --test test/characterization/opt-001.test.js"), null, "reading and running them is fine");
    // The pin step itself (not pinned) writes them.
    const pinStep = { ...pinned, pinned: null };
    assert.equal(decide({ tool_name: "Write", tool_input: { file_path: "test/characterization/opt-001.test.js" } }, pinStep), null);
    assert.equal(sh(pinStep, "echo x > test/characterization/opt-001.test.js"), null);
  }
});

test("the hook finds the pinned step in the run's plan: denied during the change step, allowed during the pin step", async () => {
  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { saveState, defaultState } = await import("../../plugins/autoclaude/lib/state.js");
  const { setRunPlan } = await import("../../plugins/autoclaude/lib/config.js");
  const { pinnedStep } = await import("../../plugins/autoclaude/scripts/tool-guard.js");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-guard-pin-"));
  fs.writeFileSync(path.join(proj, "autoclaude.config.json"), JSON.stringify({ version: 1, plan: "PLAN.md" }));
  fs.writeFileSync(path.join(proj, "PLAN.md"), "# Own plan\n\n## Phase 1: A\n- [ ] **S1.1** x\n  - Accept: a\n");
  fs.writeFileSync(path.join(proj, "OPTIMIZE_PLAN.md"), [
    "# Optimization 2026-10-02", "", "## Phase 1: Optimizations in src (medium)",
    "- [x] **OF1.1** Pin the current behaviour around finding OPT-001", "  - Accept: pinned", "  - Test: test/characterization/opt-001.test.js",
    "- [ ] **OF1.2** Merge the two copies (OPT-001)", "  - Accept: unchanged", "  - Test: test/characterization/opt-001.test.js", "  - Tags: no-ui, pinned", "  - Depends: OF1.1", ""
  ].join("\n"));
  setRunPlan(proj, "OPTIMIZE_PLAN.md");
  const script = fileURLToPath(new URL("../../plugins/autoclaude/scripts/tool-guard.js", import.meta.url));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-guard-cfg-")) };
  delete env.AUTOCLAUDE_ROLE;
  delete env.AUTOCLAUDE_BUILDER;
  const hook = (file) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(proj, file) }, cwd: proj }), env, encoding: "utf8" });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null;
  };
  saveState(proj, { ...defaultState(), status: "running", currentStep: "OF1.2" });
  assert.match(hook("test/characterization/opt-001.test.js"), PINNED);
  assert.equal(hook("src/price.js"), null);
  assert.deepEqual(await pinnedStep(proj, { plan: "OPTIMIZE_PLAN.md" }, { currentStep: "OF1.2" }), { step: "OF1.2", dir: "test/characterization", pinStep: "OF1.1" });
  saveState(proj, { ...defaultState(), status: "running", currentStep: "OF1.1" });
  assert.equal(hook("test/characterization/opt-001.test.js"), null, "the pin step writes the tests");
  assert.equal(await pinnedStep(proj, { plan: "missing.md" }, { currentStep: "OF1.2" }), null, "an unreadable plan leaves the step unpinned");
});

test("an owner's step with Depends and a Test under test/characterization/ is not pinned: it writes its own test", async () => {
  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { saveState, defaultState } = await import("../../plugins/autoclaude/lib/state.js");
  const { pinnedStep } = await import("../../plugins/autoclaude/scripts/tool-guard.js");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-guard-ownpin-"));
  fs.writeFileSync(path.join(proj, "autoclaude.config.json"), JSON.stringify({ version: 1, plan: "PLAN.md" }));
  fs.writeFileSync(path.join(proj, "PLAN.md"), [
    "# Own plan", "", "## Phase 1: Parser",
    "- [x] **S1.1** Split the parser", "  - Accept: a", "  - Test: test/parser.test.js",
    "- [ ] **S1.2** Pin the parser's current output", "  - Accept: b", "  - Test: test/characterization/parser.test.js", "  - Depends: S1.1", ""
  ].join("\n"));
  const script = fileURLToPath(new URL("../../plugins/autoclaude/scripts/tool-guard.js", import.meta.url));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-guard-cfg-")) };
  delete env.AUTOCLAUDE_ROLE;
  delete env.AUTOCLAUDE_BUILDER;
  const hook = (file) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "Write", tool_input: { file_path: path.join(proj, file) }, cwd: proj }), env, encoding: "utf8" });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null;
  };
  saveState(proj, { ...defaultState(), status: "running", currentStep: "S1.2" });
  assert.equal(await pinnedStep(proj, { plan: "PLAN.md" }, { currentStep: "S1.2" }), null, "no pinned tag: not pinned");
  assert.equal(hook("test/characterization/parser.test.js"), null, "the step writes the test it must create");
  // The same step tagged pinned is guarded.
  fs.writeFileSync(path.join(proj, "PLAN.md"), fs.readFileSync(path.join(proj, "PLAN.md"), "utf8").replace("  - Depends: S1.1", "  - Tags: pinned\n  - Depends: S1.1"));
  assert.deepEqual(await pinnedStep(proj, { plan: "PLAN.md" }, { currentStep: "S1.2" }), { step: "S1.2", dir: "test/characterization", pinStep: "S1.1" });
  assert.match(hook("test/characterization/parser.test.js"), /test\/characterization\/ holds the characterization tests the pin step S1\.1 wrote/);
});

test("the hook itself follows the run-plan override through loadConfig and guards both plans", async () => {
  const fs = await import("node:fs");
  const { spawnSync } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const { saveState, defaultState } = await import("../../plugins/autoclaude/lib/state.js");
  const { setRunPlan } = await import("../../plugins/autoclaude/lib/config.js");
  const proj = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-guard-"));
  fs.writeFileSync(path.join(proj, "autoclaude.config.json"), JSON.stringify({ version: 1, plan: "PLAN.md" }));
  saveState(proj, { ...defaultState(), status: "running", currentStep: "S1.1" });
  const script = fileURLToPath(new URL("../../plugins/autoclaude/scripts/tool-guard.js", import.meta.url));
  const env = { ...process.env, CLAUDE_CONFIG_DIR: fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-guard-cfg-")) };
  delete env.AUTOCLAUDE_ROLE;
  delete env.AUTOCLAUDE_BUILDER;
  const hook = (file) => {
    const r = spawnSync(process.execPath, [script], { input: JSON.stringify({ tool_name: "Edit", tool_input: { file_path: path.join(proj, file) }, cwd: proj }), env, encoding: "utf8" });
    return r.stdout ? JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason : null;
  };
  assert.match(hook("PLAN.md"), /Only the gate ticks PLAN\.md/);
  assert.equal(hook("SECURITY_PLAN.md"), null, "without the override the generated plan is an ordinary file");
  setRunPlan(proj, "SECURITY_PLAN.md");
  assert.match(hook("SECURITY_PLAN.md"), /Only the gate ticks SECURITY_PLAN\.md/);
  assert.match(hook("PLAN.md"), /the project's own plan/);
  assert.match(hook("autoclaude.accepted.json"), /accepted risks/);
  // A broken override: the run's plan falls back to the project's own, which stays guarded.
  fs.writeFileSync(path.join(proj, ".autoclaude", "run-plan.json"), "{ broken");
  assert.match(hook("PLAN.md"), /Only the gate ticks PLAN\.md/);
});
