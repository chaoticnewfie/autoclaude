// P8.4: guard.deny rules match the commands a line runs, not its data; recursive deletes inside
// the temp folder pass. The rehearsal's 13 false positives (P7.3, denials.log) are the first
// cases. The log keeps 200 characters of each command, so the longer ones are completed with
// what the visible part was doing; the homelab address and the user name are replaced with
// neutral ones (rule 4 of CLAUDE.md), the rules are otherwise the rehearsal's own.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { decide, ruleTexts, parseCommandLine } from "../../plugins/autoclaude/scripts/tool-guard.js";
import { mergeConfig } from "../../plugins/autoclaude/lib/config.js";

const HOSTS = "No remote machines during a run";
const SCRIPTS = "only the owner runs it";
const PROXMOX = "Proxmox and disk tools belong to the owner";
const DOCKER = "Never delete Docker volumes or prune";
const GITHUB = "Only the run branch is pushed";
const MACHINE = "No changes to this machine";
const RULES = [
  { pattern: "\\b(ssh|scp|sftp|rsync|plink|pscp)\\b|10\\.0\\.5\\.\\d|\\bpve\\b", reason: `${HOSTS}: the Proxmox host (pve) and the db VM belong to the owner. Read files that name these hosts with the Read and Grep tools.` },
  { pattern: "\\b(deploy\\.ps1|deploy\\.sh|bootstrap\\.sh|build-iso\\.sh|create-vm\\.sh|storage\\.sh|backup\\.sh|restore-drill\\.sh)\\b", reason: `This script changes the Proxmox host, so ${SCRIPTS}. Read it with the Read and Grep tools.` },
  { pattern: "\\b(qm|pct|pvesm|pvesh|pveum|zpool|zfs|wipefs|sgdisk|vzdump)\\b", reason: `${PROXMOX}'s runbook, never to a run.` },
  { pattern: "\\bdown\\b[^|;&\\n]*\\s(-v|--volumes)\\b|\\bdocker\\s+(system|volume|image|container|network|builder|buildx)\\s+prune\\b|\\bdocker\\s+volume\\s+rm\\b|--privileged\\b|\\bdocker\\s+(login|logout|push)\\b", reason: `${DOCKER}: compose down -v is forbidden.` },
  { pattern: "\\bgh\\b|\\bgit\\s+push\\b[^|;&\\n]*(\\bmain\\b|\\bmaster\\b|--all|--mirror|--delete|--tags|\\s-d\\b|\\s:[\\w/-])|\\bgit\\s+config\\b[^|;&\\n]*--(global|system)\\b|\\bgit\\s+remote\\s+(add|set-url|remove|rm|rename)\\b", reason: `${GITHUB}, with a plain git push.` },
  { pattern: "\\b(winget|choco|scoop|wsl|setx|bcdedit|netsh|diskpart)\\b|Set-ExecutionPolicy|Enable-WindowsOptionalFeature|Restart-Computer|Stop-Computer|\\bshutdown(\\.exe)?\\s|\\breg(\\.exe)?\\s+(add|delete|import)\\b|HKLM:|HKCU:|\\bnpm\\s+(i|install|add)\\s[^|;&\\n]*(-g\\b|--global\\b)|\\bnpm\\s+publish\\b|\\bclaude\\s+mcp\\b", reason: `${MACHINE}: installed software, WSL, the registry.` }
];
const TEMP = "C:\\Users\\SOMEON~1\\AppData\\Local\\Temp\\2";
const config = mergeConfig({ git: { push: true }, guard: { deny: RULES } });
const win = { root: "C:\\proj", config, tempDirs: [TEMP] };
const nix = { root: "/proj", config, tempDirs: ["/tmp"] };
const sh = (ctx, command, extra = {}) => decide({ tool_name: "Bash", tool_input: { command }, ...extra }, ctx);
const ps = (ctx, command, extra = {}) => decide({ tool_name: "PowerShell", tool_input: { command }, ...extra }, ctx);
const RECURSIVE = /Recursive deletes outside the project/;
const oldRuleHit = (command) => RULES.find((r) => new RegExp(r.pattern, "i").test(command));

const SUB = [
  "def sub(p, old, new, count=1):",
  "    s=open(p,encoding='utf8',newline='').read()",
  "    assert s.count(old)==count, (p, old[:70], s.count(old))",
  "    s=s.replace(old,new)",
  "    open(p,'w',encoding='utf8',newline='').write(s)"
].join("\n");

// [what denied it on 2026-09-27/28, the command]
const REHEARSAL = [
  [SCRIPTS, `grep -n "devices" deploy/grafana/dashboards/app-drilldown.json | cut -c1-80; sed -n 100,112p deploy/restore-drill.sh`],
  [HOSTS, `python - <<'EOF'\n${SUB}\nsub('docs/DEPLOY_RUNBOOK.md', 'ssh root@pve qm start 105', 'ssh root@pve qm start 105 && qm wait 105')\nEOF`],
  [HOSTS, `python - <<'EOF'\n${SUB}\nsub('deploy/.env.example', 'PGHOST=10.0.5.105', 'PGHOST=db.internal')\nsub('docs/ARCHITECTURE.md', 'the db VM (10.0.5.105)', 'the db VM')\nEOF\ngit diff --stat`],
  [SCRIPTS, `python - <<'EOF'\n${SUB}\nsub('docs/DEPLOY_RUNBOOK.md', 'Run deploy/backup.sh nightly.', 'Run deploy/backup.sh at 02:00.')\nEOF`],
  [SCRIPTS, `python - <<'EOF'\n${SUB}\nsub('test/deploy/restore-drill.test.ts', "const SCRIPT = 'deploy/restore-drill.sh'", "const SCRIPT = RESTORE_DRILL")\nEOF`],
  [SCRIPTS, "cat >> docs/DECISIONS.md <<'EOF'\n\n## D-044 (2026-09-27, S2.5) Correction to I-05: a dimensionless vector column takes no plain index, but an expression-and-partial one works\n- Question: can the embeddings column be indexed without a fixed dimension?\n- Decision: an expression index with a partial WHERE clause; vm/bootstrap.sh needs no change.\nEOF"],
  ["recursive", `d=$(mktemp -d) && time sh deploy/init-secrets.sh "$d" >/dev/null && rm -rf "$d"; grep -n "migrate:down" -A30 db/migrations/008_roles_grants.sql | grep -niE "DROP ROLE|app_mcp|authenticator"`],
  ["recursive", `S=C:/Users/SOMEON~1/AppData/Local/Temp/2/claude/C--project/9db51981-7b20-464a-88aa-171a930a9938/scratchpad; rm -rf "$S/stack-secrets"; mkdir -p "$S/stack-secrets"; sh deploy/init-secrets.sh "$S/stack-secrets" && ls -la "$S/stack-secrets"`],
  [HOSTS, `python - <<'EOF'\np = 'test/deploy/nftables.test.ts'\ns = open(p, encoding='utf8', newline='').read()\nold_mount = "'--mount', \`type=bind,source=\${CONF},target=/etc/nftables.conf,readonly\`,"\nnew_mount = old_mount + " '--network', 'none',"\nassert s.count(old_mount) == 1\ns = s.replace(old_mount, new_mount).replace('accepts ssh from 10.0.5.0/24', 'accepts ssh from the LAN only')\nopen(p, 'w', encoding='utf8', newline='').write(s)\nEOF`],
  [SCRIPTS, String.raw`tail -25 test/static/stale-text.test.ts; grep -n "FALLBACK ruleset" vm/bootstrap.sh; grep -n "cat > \"\${STAGED}\" <<\|<<'EOF'\|<<EOF" vm/bootstrap.sh | sed -n 1,10p`],
  [SCRIPTS, `MSYS_NO_PATHCONV=1 docker run --rm --network none -v "C:/proj:/mnt:ro" koalaman/shellcheck:v0.11.0 /mnt/proxmox/create-vm.sh /mnt/deploy/backup-failed.sh; echo "shellcheck=$?"`],
  [SCRIPTS, String.raw`grep -n "PGHOST\|container route\|DBMATE\b\|DBMATE\|PSQL" docs/DEPLOY_RUNBOOK.md deploy/deploy.sh | cut -c1-220 | head -20`],
  [SCRIPTS, String.raw`echo "lines: $(wc -l < scripts/deploy.ps1) crlf: $(grep -c $'\r$' scripts/deploy.ps1)"; git show HEAD:scripts/deploy.ps1 | grep -c $'\r$'; git ls-files --eol scripts/deploy.ps1`]
];

test("the rehearsal's 13 denials were real false positives under the old whole-line matching", () => {
  assert.equal(REHEARSAL.length, 13);
  for (const [was, command] of REHEARSAL) {
    if (was === "recursive") {
      // With no temp folder known, the old rule is what denied it.
      assert.match(sh({ ...win, tempDirs: [] }, command), RECURSIVE, command);
    } else {
      assert.ok(oldRuleHit(command)?.reason.includes(was), `the old matching denied it with "${was}": ${command.slice(0, 80)}`);
    }
  }
});

test("each of the rehearsal's 13 denials now passes", () => {
  for (const [, command] of REHEARSAL) assert.equal(sh(win, command), null, command.slice(0, 120));
  // The same lines on a POSIX project, except the one with a Windows scratchpad path in it.
  for (const [, command] of REHEARSAL.filter(([, c]) => !c.startsWith("S=C:/"))) assert.equal(sh(nix, command), null, command.slice(0, 120));
});

test("every rehearsal rule still denies what it was written for", () => {
  const denied = {
    [HOSTS]: [
      "ssh root@10.0.5.200 qm list", "scp backup.tar.gz db:/srv/backups/", "rsync -a dist/ pve:/srv/app/", "curl -s http://10.0.5.105:9187/metrics",
      "ping -c 1 pve", "bash -c \"ssh pve uptime\"", "echo uptime | ssh pve", "PGHOST=10.0.5.105 psql -c \"select 1\"",
      "H=10.0.5.105; curl \"http://$H:8080/health\"", "export PGHOST=10.0.5.105", "ls //10.0.5.105/share/",
      "cat > notes.md <<EOF\nuptime: $(ssh pve uptime)\nEOF", "echo \"$(ssh pve uptime)\"", "echo `ssh pve uptime`",
      "python - <<'EOF'\nimport subprocess\nsubprocess.run(['ssh', 'pve', 'uptime'])\nEOF",
      "node -e \"require('child_process').execSync('ssh pve uptime')\"", "awk 'BEGIN { system(\"ssh pve uptime\") }'",
      "bash <<< \"ssh pve uptime\"", "timeout 30 ssh pve uptime", "sudo -E ssh pve", "cmd //c \"ssh pve uptime\""
    ],
    [SCRIPTS]: [
      "sh deploy/deploy.sh", "bash vm/bootstrap.sh --dry-run", "./deploy/backup.sh", "sudo ./proxmox/create-vm.sh", "source deploy/deploy.sh",
      ". deploy/deploy.sh", "(cd deploy && ./deploy.sh)", "cat deploy/deploy.sh | bash", "bash < deploy/restore-drill.sh",
      "bash <<'EOF'\n./deploy/restore-drill.sh --check\nEOF", "f=deploy/deploy.sh; bash \"$f\"", "find deploy -name deploy.sh -exec sh {} \\;",
      "docker run --rm -v \"$PWD:/w\" alpine sh /w/deploy/deploy.sh", "docker run --rm -v \"$PWD:/w:ro\" alpine sh /w/deploy/deploy.sh",
      "timeout 600 ./deploy/deploy.sh", "nohup ./deploy/backup.sh > backup.log 2>&1 &", "node -e \"require('child_process').execSync('sh deploy/deploy.sh')\"",
      "awk '{ print | \"sh\" }' deploy/deploy.sh", "sed -i 's/a/b/' deploy/deploy.sh", "chmod +x deploy/deploy.sh && ./deploy/deploy.sh",
      "cat <<'EOF' | bash\n./deploy/deploy.sh\nEOF"
    ],
    [PROXMOX]: ["qm start 105", "sudo zfs list", "pct exec 101 -- ls", "vzdump 105 --storage VM-Bulk"],
    [DOCKER]: ["docker compose down -v", "docker compose -f deploy/compose.yml down --volumes", "docker volume prune -f", "docker run --rm --privileged -v \"$PWD:/mnt:ro\" koalaman/shellcheck /mnt/x.sh"],
    [GITHUB]: ["gh pr create --fill", "git push origin main", "git push --tags", "git config --global user.email x@example.com", "git remote add upstream git@github.com:x/y.git"],
    [MACHINE]: ["winget install jqlang.jq", "wsl --shutdown", "setx PATH \"%PATH%;C:\\tools\"", "npm i -g pnpm", "claude mcp add x -- y"]
  };
  for (const [reason, commands] of Object.entries(denied)) {
    for (const c of commands) {
      assert.match(String(sh(win, c)), new RegExp(`does not allow that command.*${reason.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`), c);
    }
  }
  // The PowerShell tool: scripts, remote hosts, cmdlets.
  for (const [c, reason] of [
    ["powershell -File scripts/deploy.ps1", SCRIPTS], ["pwsh -NoProfile -ExecutionPolicy Bypass -File .\\scripts\\deploy.ps1", SCRIPTS],
    ["& .\\scripts\\deploy.ps1", SCRIPTS], ["Get-Content scripts\\deploy.ps1 -Raw | Invoke-Expression", SCRIPTS],
    ["powershell -NoProfile -Command \"& ./scripts/deploy.ps1\"", SCRIPTS], ["Invoke-Command -ComputerName pve { hostname }", HOSTS],
    ["Test-Connection 10.0.5.105", HOSTS], ["$r = ssh pve uptime", HOSTS], ["Set-ExecutionPolicy Bypass -Scope CurrentUser", MACHINE],
    ["Get-ItemProperty HKLM:\\Software\\x", MACHINE]
  ]) {
    assert.match(String(ps(win, c)), new RegExp(`does not allow that command.*${reason}`), c);
  }
});

test("read-only commands on a named file pass; so do printed text, comments and data", () => {
  const allowed = [
    "grep -rn pve docs/", String.raw`rg -n "10\.0\.5\." deploy/`, "sed -n 1,40p deploy/deploy.sh", "head -50 vm/bootstrap.sh", "tail -n 20 deploy/backup.sh",
    "wc -l deploy/deploy.sh vm/bootstrap.sh", "less deploy/deploy.sh", "file deploy/deploy.sh", "stat deploy/deploy.sh", "cat deploy/deploy.sh",
    "shellcheck deploy/deploy.sh vm/bootstrap.sh", "bash -n deploy/deploy.sh", "git show HEAD:deploy/deploy.sh", "git log --oneline -- deploy/deploy.sh",
    "git diff deploy/deploy.sh", "git blame vm/bootstrap.sh", "git ls-files deploy", "git restore deploy/deploy.sh", "git add deploy/deploy.sh",
    "awk '/ssh/ {print FILENAME\": \"$0}' deploy/deploy.sh", "awk 'NR>=10 && NR<=20' deploy/deploy.sh", "find deploy -name \"*.sh\"",
    "diff deploy/deploy.sh /tmp/deploy.sh.orig", "docker run --rm -v \"$PWD/deploy/deploy.sh:/x.sh:ro\" koalaman/shellcheck /x.sh",
    "docker run --rm --mount type=bind,source=/c/proj,target=/mnt,readonly hadolint/hadolint hadolint /mnt/deploy/Dockerfile",
    "command -v qm", "which ssh", "echo \"run deploy/deploy.sh on pve\"", "printf 'ssh %s uptime\\n' pve >> docs/RUNBOOK.md",
    "ls # later: ssh pve and run deploy.sh", "cat >> docs/RUNBOOK.md <<'EOF'\nssh root@pve qm start 105\nsh deploy/deploy.sh\nEOF",
    "grep -c ssh <<< \"ssh pve\"", "node -e \"console.log(require('fs').readFileSync('deploy/deploy.sh','utf8').length)\"",
    "python -c \"print(open('deploy/deploy.sh').read().count('ssh'))\"", "for f in deploy/*.sh; do shellcheck \"$f\"; done",
    "if grep -q pve deploy/deploy.sh; then echo found; fi", "grep -l pve deploy/*.sh | xargs wc -l", "diff <(git show HEAD:deploy/deploy.sh) deploy/deploy.sh",
    "git stash push -m \"wip: pve checks\"", "npm test", "git push"
  ];
  for (const c of allowed) assert.equal(sh(win, c), null, c);
  for (const c of [
    "Select-String -Path scripts\\deploy.ps1 -Pattern ssh", "Get-Content scripts\\deploy.ps1 | Measure-Object -Line", "Set-Content -Path docs\\notes.md -Value \"ssh pve\"",
    "Write-Output \"qm start 105\"", "Invoke-ScriptAnalyzer -Path scripts\\deploy.ps1", "Test-Path scripts\\deploy.ps1", "Get-Content scripts\\deploy.ps1 -TotalCount 20"
  ]) assert.equal(ps(win, c), null, c);
});

test("a heredoc body is data unless a shell or an interpreter that starts processes reads it", () => {
  const h = (cmd, body, delim = "'EOF'") => `${cmd} <<${delim}\n${body}\nEOF`;
  assert.equal(sh(win, h("cat > notes.md", "ssh pve uptime")), null);
  assert.equal(sh(win, h("tee -a notes.md", "sh deploy/deploy.sh")), null);
  assert.equal(sh(win, h("python -", "print('ssh pve')")), null);
  assert.match(sh(win, h("bash", "ssh pve uptime")), new RegExp(HOSTS));
  assert.match(sh(win, h("sh -s", "./deploy/deploy.sh")), new RegExp(SCRIPTS));
  assert.match(sh(win, h("python3 -", "import os\nos.system('ssh pve uptime')")), new RegExp(HOSTS));
  // An unquoted delimiter: bash runs $(...) and `...` in the body before cat sees it.
  assert.match(sh(win, h("cat > notes.md", "`ssh pve uptime`", "EOF")), new RegExp(HOSTS));
  assert.equal(sh(win, h("cat > notes.md", "`ssh pve uptime`")), null, "quoted: the backticks are text");
});

test("npm run and friends are read through package.json, following pre and post scripts, --prefix and cd", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ac guard ~"));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ scripts: {
    deploy: "sh deploy/deploy.sh", lint: "shellcheck deploy/deploy.sh vm/bootstrap.sh", test: "node --test test/*.test.js",
    ship: "npm run lint && npm run deploy", prerelease: "bash vm/bootstrap.sh --check", release: "echo releasing"
  } }));
  fs.mkdirSync(path.join(dir, "mcp"));
  fs.writeFileSync(path.join(dir, "mcp", "package.json"), JSON.stringify({ scripts: { test: "ssh pve uptime" } }));
  const ctx = { root: dir, config, tempDirs: [] };
  const deploy = sh(ctx, "npm run deploy");
  assert.match(deploy, /\(`npm run deploy` runs `sh deploy\/deploy\.sh`\)/);
  assert.match(deploy, new RegExp(SCRIPTS));
  for (const c of ["npm run ship", "npm run release", "yarn deploy", "yarn run deploy", "pnpm run deploy", "bun run deploy", "npm run deploy -- --dry-run", "npm --prefix mcp test", "npm test --prefix=mcp", "cd mcp && npm test"]) {
    assert.notEqual(sh(ctx, c), null, c);
  }
  assert.match(sh(ctx, "npm test", { cwd: path.join(dir, "mcp") }), new RegExp(HOSTS), "the session's working directory");
  for (const c of ["npm run lint", "npm test", "npm run missing", "npm install", "npx vitest run"]) assert.equal(sh(ctx, c), null, c);
  // A broken package.json is no reason to fail: the command itself is still tested.
  fs.writeFileSync(path.join(dir, "mcp", "package.json"), "{ not json");
  assert.equal(sh(ctx, "npm --prefix mcp test"), null);
});

test("recursive deletes inside the OS temp folder pass; the temp folder itself and the project stay protected", () => {
  const off = { root: "C:\\proj", config: mergeConfig({ git: { push: false } }), tempDirs: ["C:\\Users\\someone\\AppData\\Local\\Temp"] };
  for (const c of [
    "rm -rf /tmp/build", "rm -rf \"$TEMP/autoclaude-test\"", "rm -rf \"${TMPDIR:-/tmp}/x\"", "rm -rf C:/Users/someone/AppData/Local/Temp/x",
    "rm -rf c:\\users\\SOMEONE\\appdata\\local\\temp\\x", "d=$(mktemp -d) && rm -rf \"$d\"", "d=$(mktemp -d -t build.XXXX); rm -rf \"$d\"",
    "cd /tmp && rm -rf build", "rm -rf /tmp/autoclaude-*", "find /tmp/x -name \"*.log\" -delete", "cmd //c \"rd /s /q %TEMP%\\x\""
  ]) assert.equal(sh(off, c), null, c);
  for (const c of ["Remove-Item -Recurse -Force $env:TEMP\\x", "$d = Join-Path $env:TEMP \"x\"; Remove-Item -Recurse $d", "$d = [System.IO.Path]::GetTempPath(); Remove-Item -Recurse \"$d\\x\""]) {
    assert.equal(ps(off, c), null, c);
  }
  for (const c of [
    "rm -rf /tmp", "rm -rf /tmp/", "rm -rf \"$TEMP\"", "rm -rf /tmp/*", "rm -rf \"$TEMP/..\"", "rm -rf /tmp/../x", "d=$(mktemp -d -p ..); rm -rf \"$d\"",
    "rm -rf \"$TEMPLATE/x\"", "rm -rf C:/Users/someone/AppData/Local", "rm -rf ~/AppData/Local/Temp2/x"
  ]) assert.match(sh(off, c), RECURSIVE, c);
  assert.match(ps(off, "Remove-Item -Recurse $env:TEMP"), RECURSIVE);
  // A project inside the temp folder: its neighbours may go, it and its parents may not.
  const inside = { ...off, root: "C:\\Users\\someone\\AppData\\Local\\Temp\\proj" };
  for (const c of ["rm -rf ../other", "rm -rf dist", "rm -rf \"$TEMP/other\""]) assert.equal(sh(inside, c), null, c);
  for (const c of ["rm -rf ..", "rm -rf ../proj", "rm -rf \"$TEMP/proj\"", "rm -rf ../pr*", "rm -rf ../*", "rm -rf ."]) assert.match(sh(inside, c), RECURSIVE, c);
  // POSIX.
  const posix = { root: "/proj", config: off.config, tempDirs: ["/tmp"] };
  for (const c of ["rm -rf /tmp/build", "rm -rf \"$TMPDIR/x\"", "d=$(mktemp -d); rm -rf \"$d\""]) assert.equal(sh(posix, c), null, c);
  for (const c of ["rm -rf /tmp", "rm -rf /var/lib/x", "rm -rf /tmp/*"]) assert.match(sh(posix, c), RECURSIVE, c);
});

test("without tempDirs the guard uses this machine's temp folder, in its short and long forms", () => {
  const root = process.platform === "win32" ? "C:\\proj" : "/proj";
  const ctx = { root, config: mergeConfig({ git: { push: false } }) };
  assert.equal(sh(ctx, `rm -rf "${path.join(os.tmpdir(), "autoclaude-guard-x")}"`), null);
  assert.equal(sh(ctx, `rm -rf "${path.join(fs.realpathSync.native(os.tmpdir()), "autoclaude-guard-x")}"`), null);
  assert.match(sh(ctx, `rm -rf "${os.tmpdir()}"`), RECURSIVE);
});

test("a rule without a usable pattern is skipped, not a deny-all", () => {
  const ctx = { ...win, config: mergeConfig({ guard: { deny: [{ reason: "no pattern" }, { pattern: "", reason: "empty" }] } }) };
  assert.equal(sh(ctx, "npm test"), null);
});

test("ruleTexts: one text per command that runs, with only what matters in it", () => {
  const texts = (c, shell) => ruleTexts(c, shell, { root: "C:\\proj" }).map((t) => t.text);
  assert.deepEqual(texts("grep -n pve a.sh | cut -c1-80; sed -n 1p b.sh"), ["grep", "cut", "sed"]);
  assert.deepEqual(texts("cat deploy.sh | bash"), ["cat", "bash", "cat deploy.sh"]);
  assert.deepEqual(texts("MSYS_NO_PATHCONV=1 docker run --rm -v \"C:/p:/mnt:ro\" koalaman/shellcheck /mnt/a.sh"), ["MSYS_NO_PATHCONV=1 docker run --rm koalaman/shellcheck"]);
  assert.deepEqual(texts("echo hi > out.txt 2>&1"), ["echo > out.txt"]);
  assert.deepEqual(texts("bash -c 'grep pve x && ssh pve'"), ["bash -c", "grep", "ssh pve"]);
  assert.deepEqual(texts("Set-Content -Path a.md -Value 'ssh pve'", "powershell"), ["Set-Content -Path a.md"]);
});

test("parseCommandLine: pipes, heredoc bodies, input files and substitutions", () => {
  const cmds = parseCommandLine("cat a | grep b || echo c");
  assert.deepEqual(cmds.map((c) => [c.words.join(" "), c.pipe]), [["cat a", false], ["grep b", true], ["echo c", false]]);
  const doc = parseCommandLine("cat > x <<'EOF'\nline $(rm -rf /)\nEOF\nls");
  assert.deepEqual(doc.map((c) => c.words.join(" ")), ["cat", "ls"]);
  assert.deepEqual(doc[0].heredocs, [{ delim: "EOF", quoted: true, body: "line $(rm -rf /)" }]);
  assert.ok(parseCommandLine("cat > x <<EOF\n$(date)\nEOF").some((c) => c.words[0] === "date"), "unquoted: the substitution runs");
  assert.ok(parseCommandLine("echo `whoami`").some((c) => c.words[0] === "whoami"));
  assert.ok(!parseCommandLine("echo '`whoami`'").some((c) => c.words[0] === "whoami"));
  assert.ok(!parseCommandLine("echo \\`whoami\\`").some((c) => c.words[0] === "whoami"), "an escaped backtick is text");
  assert.deepEqual(parseCommandLine("wc -l < x.sh")[0].inputs, ["x.sh"]);
  const ps = parseCommandLine("diff <(git show HEAD:a.sh) a.sh");
  assert.deepEqual(ps[0].words, ["diff", "<(git show HEAD:a.sh)", "a.sh"]);
  assert.ok(ps.some((c) => c.words.join(" ") === "git show HEAD:a.sh"));
});

test("the built-in rules now see through heredoc shells, PowerShell assignments and line variables", () => {
  const off = { root: "C:\\proj", config: mergeConfig({ git: { push: false } }), tempDirs: [TEMP] };
  assert.match(sh(off, "bash <<'EOF'\ngit push\nEOF"), /Pushing is off/);
  assert.match(ps(off, "$null = Remove-Item -Recurse -Force C:\\Users\\x"), RECURSIVE);
  assert.match(sh(off, "f=PLAN.md; echo x > \"$f\""), /Shell writes to PLAN\.md/);
  assert.match(sh(off, "echo `rm -rf /`"), RECURSIVE);
  assert.equal(sh(off, "f=notes.md; echo x > \"$f\""), null);
});
