// PreToolUse hook: while a run is active, keep the builder inside the rules (PLAN.md 4.2, 4.7).
//   - AskUserQuestion is denied with the section 4.5 guidance (no human is there).
//   - Edits to the plan, autoclaude.config.json and .autoclaude/ are denied.
//   - Bash and PowerShell commands that would write, delete or move those files, push while
//     pushing is off, force-push, hard-reset, commit or tag, or delete recursively outside the
//     project are denied.
// Only the builder session is guarded (lib/builder.js): a person's own session opened in the
// project during a supervised run is left alone. Silent and instant when no run is active.
// Never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot } from "../lib/paths.js";
import { loadState, STATUS } from "../lib/state.js";
import { loadConfig } from "../lib/config.js";
import { recordDenial } from "../lib/denials.js";
import { notify } from "../lib/notify.js";
import { isBuilderSession } from "../lib/builder.js";

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

// The shell tools and how their command lines are read. Claude Code's Bash tool is Git Bash on
// Windows; the PowerShell tool exists there too and gets exactly the same rules.
const SHELL_TOOLS = { Bash: "bash", PowerShell: "powershell" };

export function decide(input, { root, config }) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const cli = "autoclaude";
  if (tool === "AskUserQuestion") {
    return `No human is available during an AutoClaude run. Decide it yourself: check the plan's Constraints & decisions and ${config.docs.decisions} first, then ask the decider agent; apply a routine answer and log it in ${config.docs.decisions} as D-###. Only a critical question (secret, paid service, destructive action, contradiction with the plan) stops the run: \`${cli} blocked <step> "<question with options>"\`.`;
  }
  const protectedRel = [config.plan, "autoclaude.config.json"].map((f) => path.resolve(root, f).toLowerCase());
  const runtimeDir = path.resolve(root, ".autoclaude").toLowerCase();
  const isProtected = (file) => {
    if (!file) return false;
    const abs = path.resolve(root, String(file)).toLowerCase();
    return protectedRel.includes(abs) || abs === runtimeDir || abs.startsWith(runtimeDir + path.sep);
  };
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = ti.file_path || ti.notebook_path;
    if (isProtected(file)) return `${path.basename(String(file))} is managed by the gate during a run. Only the gate ticks ${config.plan}; the config and .autoclaude/ are read-only for you. Continue the current step instead.`;
    return null;
  }
  if (SHELL_TOOLS[tool]) return decideShell(String(ti.command || ""), SHELL_TOOLS[tool], { root, config, cwd: input.cwd, cli });
  return null;
}

function decideShell(cmd, shell, { root, config, cwd, cli }) {
  // The project's own off-limits list first (guard.deny in autoclaude.config.json, D37).
  const rules = (config.guard && Array.isArray(config.guard.deny)) ? config.guard.deny : [];
  for (const rule of rules) {
    let re;
    try { re = new RegExp(rule.pattern, "i"); } catch { continue; }
    // A reason written as a sentence keeps its own full stop; do not add a second one.
    const why = String(rule.reason || `it matches the guard.deny rule /${rule.pattern}/`).trim().replace(/[.!]+$/, "");
    if (re.test(cmd)) return `This project does not allow that command during an AutoClaude run: ${why}. Find another way that stays inside the project, or if the step truly needs it, run \`${cli} blocked <step> "<why, with the options>"\`.`;
  }

  const fx = shellEffects(cmd, shell);
  const P = pathApi(root);
  const key = (p) => (P === path.win32 ? p.toLowerCase() : p);
  const same = (a, b) => key(a) === key(b);
  const base = cwd && P.isAbsolute(String(cwd)) ? String(cwd) : root;
  // An effect's path made absolute: the session's cwd, then every cd earlier on the line.
  const where = (item) => resolveTarget(item.path, item.dirs.reduce((from, d) => resolveTarget(d, from, P), base), P);
  const runtime = P.resolve(root, ".autoclaude");
  const messages = {
    plan: `Shell writes to ${config.plan} are not allowed; only the gate edits it.`,
    config: "autoclaude.config.json is read-only during a run.",
    runtime: ".autoclaude/ is the gate's state; do not write to it."
  };

  for (const g of fx.git) {
    if (g.sub === "push") {
      const force = g.args.some((a) => /^--(force|force-with-lease|force-if-includes|mirror)$/.test(a) || /^-[a-zA-Z]*f[a-zA-Z]*$/.test(a) || /^\+./.test(a));
      if (force) return "Force pushes are not allowed during an AutoClaude run.";
      if (!config.git.push) return "Pushing is off for this run (git.push is false in autoclaude.config.json). The owner pushes after review.";
    }
    if (g.sub === "reset" && g.args.includes("--hard")) return "git reset --hard is not allowed during an AutoClaude run. Undo your own changes file by file instead (edit them back, or `git restore <file>`).";
    if (g.sub === "commit" || g.sub === "tag") return "The gate commits and tags after each verified step. Do not commit yourself; run `autoclaude ready <step>` when the step is done.";
    // git clean -x also removes ignored files, and .autoclaude/ is ignored.
    if (g.sub === "clean" && g.args.some((a) => /^-[a-zA-Z]*x/i.test(a))) {
      const ops = operands(g.args, { takesValue: [/^(-e|--exclude)$/] });
      for (const t of ops.length ? ops : ["."]) {
        const abs = where({ path: t, dirs: g.dirs });
        if (!abs || same(abs, runtime) || contains(P, abs, runtime)) return messages.runtime;
      }
    }
  }

  for (const d of fx.recursive) {
    const abs = where(d);
    if (!abs || !(contains(P, root, abs) || (d.rootOk && same(abs, root)))) return "Recursive deletes outside the project (or of the whole project) are not allowed during an AutoClaude run. Delete only paths inside the project folder.";
  }

  const guarded = [
    { kind: "plan", abs: P.resolve(root, config.plan), name: P.basename(config.plan) },
    { kind: "config", abs: P.resolve(root, "autoclaude.config.json"), name: "autoclaude.config.json" },
    { kind: "runtime", abs: runtime, name: ".autoclaude" }
  ];
  for (const w of fx.writes) {
    const abs = where(w);
    if (!abs) continue; // a variable we cannot expand: nothing to compare
    const hit = guarded.find((g) => touches(P, root, abs, g, w.tree, same));
    if (hit) return messages[hit.kind];
  }
  // Code run from the command line (node -e, python -c) that writes files and names a protected one.
  for (const text of fx.code) {
    const hit = guarded.find((g) => text.toLowerCase().includes(g.name.toLowerCase()));
    if (hit) return messages[hit.kind];
  }
  return null;
}

// True when a shell command line writes to, deletes or moves a path containing `target`.
export function writesTo(cmd, target, shell = "bash") {
  const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();
  const t = norm(target).replace(/\/+$/, "");
  return shellEffects(cmd, shell).writes.some((w) => norm(w.path).includes(t));
}

// ---- Reading a command line (best effort, readable over complete) --------------------------

// Splits a command line into simple commands, each { words, redirects }. Separators are ; & |
// and newlines, plus ( ) { } so subshells and script blocks are looked at too; the body of
// $(...) is read as a command of its own. Quotes group a word and are removed. Backslashes stay
// literal (Windows paths), except that bash escapes a space or a quote with one; PowerShell
// escapes with a backtick and cmd with a caret. `>`, `>>`, `2>`, `*>` and `&>` make the next
// word a redirect target, `2>&1` writes nothing, `<` input and heredoc bodies are skipped, and a
// `#` that starts a word starts a comment.
export function parseCommandLine(cmd, shell = "bash") {
  const s = String(cmd || "");
  const escape = shell === "powershell" ? "`" : shell === "cmd" ? "^" : "\\";
  const commands = [];
  const nested = [];
  const heredocs = [];
  let words = [];
  let redirects = [];
  let word = null;
  let pending = null; // "out": the next word is a redirect target; "in": input; "heredoc": a delimiter
  let quote = null;
  const endWord = () => {
    if (word === null) return;
    if (pending === "out") redirects.push(word);
    else if (pending === "heredoc") heredocs.push(word);
    else if (!pending) words.push(word);
    pending = null;
    word = null;
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (words.length || redirects.length) commands.push({ words, redirects });
    words = [];
    redirects = [];
  };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    const next = s[i + 1];
    // $(...) and ${...} stay whole in the word; the body of $(...) is also a command.
    if (c === "$" && (next === "(" || next === "{") && quote !== "'") {
      const close = next === "(" ? ")" : "}";
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === next) depth++;
        else if (s[j] === close && --depth === 0) break;
      }
      if (next === "(") nested.push(s.slice(i + 2, j));
      word = (word ?? "") + s.slice(i, j + 1);
      i = j;
      continue;
    }
    if (quote) {
      if (c === quote) quote = null;
      else if (c === escape && quote === '"' && next !== undefined && (shell !== "bash" || /["\\$`]/.test(next))) { word += next; i++; }
      else word += c;
      continue;
    }
    // PowerShell here-strings: @" ... "@ and @' ... '@ are data.
    if (c === "@" && (next === '"' || next === "'") && /\r?\n/.test(s.slice(i + 2, i + 4))) {
      const end = s.indexOf(`\n${next}@`, i + 2);
      word = (word ?? "") + "(here-string)";
      i = end < 0 ? s.length : end + 2;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word = word ?? ""; continue; }
    if (c === escape && next !== undefined) {
      if (next === "\n" || next === "\r") { endWord(); i += next === "\r" && s[i + 2] === "\n" ? 2 : 1; continue; } // line continuation
      if (shell !== "bash" || /[\s'"]/.test(next)) { word = (word ?? "") + next; i++; continue; }
    }
    if (word === null && c === "#") { while (i + 1 < s.length && s[i + 1] !== "\n") i++; continue; }
    if (c === ">") {
      if (word !== null && /^(\d|\*)$/.test(word)) word = null; // 2> and *>: the stream number is not a word
      else endWord();
      if (s[i + 1] === ">") i++;
      if (s[i + 1] === "&") { i++; while (/[\d-]/.test(s[i + 1] || "")) i++; continue; } // 2>&1, >&2
      pending = "out";
      continue;
    }
    if (c === "<") {
      endWord();
      if (s[i + 1] === "<" && s[i + 2] === "<") { i += 2; pending = "in"; continue; } // here-string: data
      if (s[i + 1] === "<") { i++; if (s[i + 1] === "-") i++; pending = "heredoc"; continue; }
      pending = "in";
      continue;
    }
    if (c === "&" && next === ">") { endWord(); continue; } // &> file: the > follows
    if (c === "\n") {
      endCommand();
      // Skip heredoc bodies: every line up to its delimiter is data, not commands.
      for (const delim of heredocs.splice(0)) {
        let j = i + 1;
        for (;;) {
          const eol = s.indexOf("\n", j);
          const line = s.slice(j, eol < 0 ? s.length : eol).replace(/\r$/, "");
          if (line.trim() === delim || eol < 0) { i = eol < 0 ? s.length : eol; break; }
          j = eol + 1;
        }
      }
      continue;
    }
    if (";&|(){}".includes(c)) { endCommand(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word = (word ?? "") + c;
  }
  endCommand();
  for (const inner of nested) commands.push(...parseCommandLine(inner, shell));
  return commands;
}

// Commands whose operands the guard looks at. Names are lower case, without a path or .exe;
// PowerShell cmdlets and their aliases sit next to the POSIX and cmd.exe names.
const CD = new Set(["cd", "chdir", "pushd", "set-location", "sl", "push-location"]);
const DELETE = new Set(["rm", "unlink", "del", "erase", "rd", "rmdir", "remove-item", "ri"]);
const MOVE = new Set(["mv", "move", "move-item", "mi", "ren", "rename", "rename-item", "rni"]);
const COPY = new Set(["cp", "copy", "copy-item", "cpi", "xcopy", "robocopy", "install", "rsync"]);
const WRITE = new Set(["tee", "tee-object", "set-content", "sc", "add-content", "ac", "out-file", "clear-content", "clc", "new-item", "ni", "set-item", "si", "truncate"]);
const CMD_STYLE = new Set(["del", "erase", "rd", "rmdir", "move", "ren", "rename", "copy", "xcopy", "robocopy"]);
const WRAPPERS = new Set(["sudo", "command", "builtin", "exec", "nohup", "time", "nice", "env", "xargs", "call"]);
// PowerShell parameters whose value is data, not a path.
const PS_VALUE = [/^-(value|encoding|inputobject|itemtype|type|filter|include|exclude|credential|stream|width|delimiter)$/i];
// Source code run from the command line (node -e, python -c) that writes or removes files.
const CODE_RUNNERS = new Set(["node", "python", "python3", "py", "ruby", "deno", "bun", "php"]);
const CODE_WRITERS = /\b(?:write|append)File(?:Sync)?\b|\b(?:rm|unlink|rename|copyFile|cp|truncate)Sync\b|\bopen\s*\([^)]*,\s*['"][wax]|\b(?:os\.remove|os\.rename|os\.replace|shutil\.\w+|write_text|unlink)\b/;
// .NET file calls from PowerShell: [IO.File]::WriteAllText("PLAN.md", ...) and friends.
const DOTNET_WRITERS = /\[(?:System\.)?IO\.(?:File|Directory)\]::(?:WriteAll\w*|AppendAll\w*|Delete|Move|Replace|Create\w*)\s*\(\s*["']?([^"',)]+)/gi;

// What a command line does that the guard cares about. Paths are as written, with the cd
// targets earlier on the line in `dirs`: { git: [{ sub, args, dirs }], recursive: [{ path, dirs }],
// writes: [{ path, dirs, tree }], code: [text] }. A write with tree set (a delete or a move) also
// counts when it takes a protected path along with a folder.
export function shellEffects(cmd, shell = "bash") {
  const out = { git: [], recursive: [], writes: [], code: [] };
  walk(parseCommandLine(cmd, shell), [], 0, out);
  for (const m of String(cmd || "").matchAll(DOTNET_WRITERS)) out.writes.push({ path: m[1].trim(), dirs: [], tree: true });
  return out;
}

function walk(commands, dirs, depth, out) {
  for (const { words: raw, redirects } of commands) {
    for (const r of redirects) out.writes.push({ path: r, dirs, tree: false });
    const words = splitOptions(stripWrappers(raw));
    if (!words.length) continue;
    const name = commandName(words[0]);
    const args = words.slice(1);
    const add = (p, tree = false) => out.writes.push({ path: p, dirs, tree });

    if (CD.has(name)) {
      const d = operands(args)[0];
      if (d && d !== "-") dirs = [...dirs, d];
    } else if (name === "git") {
      gitEffect(args, dirs, out);
    } else if (DELETE.has(name)) {
      const cmdStyle = CMD_STYLE.has(name);
      const recursive = args.some(isRecursiveFlag) || (cmdStyle && args.some((a) => /^\/\/?s$/i.test(a)));
      for (const t of operands(args, { takesValue: PS_VALUE, slashSwitches: cmdStyle })) {
        add(t, true);
        if (recursive) out.recursive.push({ path: t, dirs });
      }
    } else if (MOVE.has(name)) {
      for (const t of operands(args, { takesValue: PS_VALUE, slashSwitches: CMD_STYLE.has(name) })) add(t, true);
    } else if (COPY.has(name)) {
      const destFlag = /^(-t|--target-directory|-dest\w*)$/i;
      const k = args.findIndex((a) => destFlag.test(a));
      const ops = operands(args, { takesValue: [...PS_VALUE, destFlag], slashSwitches: CMD_STYLE.has(name) });
      const dest = k >= 0 ? args[k + 1] : name === "robocopy" ? ops[1] : ops.length >= 2 ? ops[ops.length - 1] : null;
      if (dest) add(dest);
    } else if (WRITE.has(name)) {
      for (const t of operands(args, { takesValue: [...PS_VALUE, /^-s$/] })) add(t);
    } else if ((name === "sed" || name === "perl") && args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a))) {
      for (const t of operands(args, { takesValue: [/^-(e|f)$/, /^--(expression|file)$/] })) add(t);
    } else if (name === "dd") {
      for (const a of args) if (/^of=./.test(a)) add(a.slice(3));
    } else if (name === "find" && args.some((a) => /^-(delete|exec|execdir|ok)$/.test(a))) {
      // find <start>... -delete / -exec rm: what matches under each start point goes. The project
      // root is a fine start point when a test narrows the match; with none, everything goes.
      const starts = [];
      for (const a of args) { if (/^[-(!]/.test(a)) break; starts.push(a); }
      const deletes = args.includes("-delete") || args.some((a, i) => /^-(exec|execdir|ok)$/.test(a) && DELETE.has(commandName(args[i + 1] || "")));
      const filtered = args.some((a) => /^-(i?name|i?path|i?wholename|i?regex|type|newer|mtime|mmin|size|empty)$/.test(a));
      if (deletes) {
        for (const t of starts.length ? starts : ["."]) {
          if (!filtered) add(t, true);
          out.recursive.push({ path: t, dirs, rootOk: filtered });
        }
      }
    } else if (CODE_RUNNERS.has(name)) {
      if (CODE_WRITERS.test(words.join(" "))) out.code.push(words.join(" "));
    } else if (depth < 3) {
      // A shell inside the shell: read the command it runs the same way. PowerShell joins the
      // words after -Command with spaces; cmd /c takes the rest of the line as it was typed.
      if (["bash", "sh", "zsh", "dash", "ksh", "eval"].includes(name)) {
        const k = name === "eval" ? -1 : args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        const body = name === "eval" ? args.join(" ") : k >= 0 ? args[k + 1] : null;
        if (body) walk(parseCommandLine(body, "bash"), dirs, depth + 1, out);
      } else if (name === "cmd") {
        const k = args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
        const rest = k >= 0 ? args.slice(k + 1) : [];
        const body = rest.length === 1 ? rest[0] : rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
        if (body) walk(parseCommandLine(body, "cmd"), dirs, depth + 1, out);
      } else if (["powershell", "pwsh", "invoke-expression", "iex"].includes(name)) {
        const k = name.startsWith("i") ? -1 : args.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a));
        const body = name.startsWith("i") ? operands(args).join(" ") : k >= 0 ? args.slice(k + 1).join(" ") : null;
        if (body) walk(parseCommandLine(body, "powershell"), dirs, depth + 1, out);
      }
    }
  }
}

// git [global options] <sub> <args>. -C <dir> moves where the paths after it resolve.
function gitEffect(args, dirs, out) {
  let i = 0;
  let gdirs = dirs;
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-C") { if (args[i + 1] !== undefined) gdirs = [...gdirs, args[i + 1]]; i += 2; }
    else if (/^(-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/.test(a)) i += 2;
    else i++;
  }
  const sub = String(args[i] || "").toLowerCase();
  const rest = args.slice(i + 1);
  out.git.push({ sub, args: rest, dirs: gdirs });
  // Restoring, removing or moving a file through git rewrites it like any other writer.
  if (["checkout", "restore", "rm", "mv"].includes(sub)) {
    const valued = [/^(-s|--source|-b|-B|--orphan|-m|--conflict|--pathspec-from-file)$/];
    for (const t of operands(rest, { takesValue: valued })) out.writes.push({ path: t, dirs: gdirs, tree: sub === "rm" || sub === "mv" });
  }
}

// The operands of a command: the words that are not options. `--` ends the options, options
// matching `takesValue` swallow the next word, and with slashSwitches `/s`-style switches (cmd.exe
// built-ins) are options too. $true, $false and $null are never paths.
function operands(args, { takesValue = [], slashSwitches = false } = {}) {
  const out = [];
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === "--") { options = false; continue; }
    if (options && /^-./.test(a)) { if (takesValue.some((re) => re.test(a))) i++; continue; }
    if (options && slashSwitches && /^\/\/?[A-Za-z?]$/.test(a)) continue;
    if (/^\$(true|false|null)$/i.test(a)) continue;
    out.push(a);
  }
  return out;
}

// -r, -R, -rf, -fr, -Rf, --recursive, and PowerShell's -Recurse with any abbreviation (-r, -rec).
// -Force is not recursive, although it has an r in it.
function isRecursiveFlag(a) {
  return /^--recursive$/i.test(a) || /^-r(e(c(u(r(s(e)?)?)?)?)?)?$/i.test(a) || /^-[fiIrRdv]*[rR][fiIrRdv]*$/.test(a);
}

// --name=value and PowerShell's -Name:value become two words.
function splitOptions(words) {
  const out = [];
  for (const w of words) {
    const m = /^(--[A-Za-z][\w-]*)=(.*)$/.exec(w) || /^(-[A-Za-z][\w-]*):(.+)$/.exec(w);
    if (m) out.push(m[1], m[2]);
    else out.push(w);
  }
  return out;
}

// sudo, env, xargs, FOO=bar and friends in front of the real command.
function stripWrappers(words) {
  let i = 0;
  while (i < words.length) {
    if (/^[A-Za-z_]\w*=/.test(words[i])) { i++; continue; }
    if (!WRAPPERS.has(commandName(words[i]))) break;
    i++;
    while (i < words.length && words[i].startsWith("-")) i++;
  }
  return words.slice(i);
}

function commandName(word) {
  return String(word).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

// ---- Paths ------------------------------------------------------------------------------------

// Windows path rules for a Windows project root (on any OS, so the tests agree), POSIX otherwise.
function pathApi(root) {
  return /^[A-Za-z]:[\\/]|^\\\\/.test(String(root)) ? path.win32 : path.posix;
}

// A path word as the shell would see it, made absolute against `from`, or null when it depends on
// a variable that cannot be known here. Git Bash's /c/... is C:\...; ~, $HOME, $env:USERPROFILE,
// $PWD and $(pwd) are expanded.
export function resolveTarget(word, from, P = path) {
  if (from === null || from === undefined) return null;
  let t = String(word);
  const home = /^(~|\$HOME|\$\{HOME\}|\$env:HOME|\$env:USERPROFILE|%USERPROFILE%)(?=$|[\\/])/i.exec(t);
  const here = /^(\$PWD|\$\{PWD\}|\$\(pwd\)|\$\(Get-Location\))(?=$|[\\/])/i.exec(t);
  const start = home ? os.homedir() : here ? from : null;
  if (start !== null) t = t.slice((home || here)[0].length);
  if (/\$[\w{(:]|%\w+%/.test(t)) return null;
  if (start !== null) return P.resolve(start, `.${t}`);
  if (P === path.win32) {
    const m = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?=\/|$)/.exec(t);
    if (m) t = `${m[1]}:/${t.slice(m[0].length)}`;
  } else if (/^[A-Za-z]:[\\/]|^\\\\/.test(t)) {
    return null; // a Windows path on a POSIX machine
  }
  return P.resolve(from, t);
}

// True when `child` is strictly inside `parent`.
function contains(P, parent, child) {
  const rel = P.relative(parent, child);
  return !!rel && rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel);
}

// Does writing (or, with tree, deleting or moving) `abs` touch the guarded path g? Anything
// inside .autoclaude counts; a wildcard counts when it could match.
function touches(P, root, abs, g, tree, same) {
  const wild = abs.search(/[*?]/);
  if (wild < 0) {
    if (same(abs, g.abs)) return true;
    if (g.kind === "runtime" && contains(P, g.abs, abs)) return true;
    return !!tree && contains(P, abs, g.abs);
  }
  // A wildcard: the fixed folder in front of it, then the pattern against the guarded path and,
  // for a delete or a move, against every folder between the root and it.
  const fixedDir = P.dirname(abs.slice(0, wild) + "x");
  if (g.kind === "runtime" && (same(fixedDir, g.abs) || contains(P, g.abs, fixedDir))) return true;
  const flags = P === path.win32 ? "i" : "";
  const re = new RegExp(`^${abs.split(/([*?])/).map((part) => (part === "*" ? "[^\\\\/]*" : part === "?" ? "[^\\\\/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`, flags);
  const candidates = [g.abs];
  if (tree) for (let d = P.dirname(g.abs); contains(P, root, d); d = P.dirname(d)) candidates.push(d);
  return candidates.some((c) => re.test(c));
}

async function main() {
  if (process.env.AUTOCLAUDE_ROLE) return; // nested runs have their own narrow tool list
  let raw = "";
  try { raw = fs.readFileSync(0, "utf8"); } catch {}
  let input = {};
  try { input = JSON.parse(raw); } catch {}
  const root = findProjectRoot(input.cwd || process.cwd());
  if (!root) return;
  const state = loadState(root);
  if (state.status !== STATUS.running) return;
  if (!isBuilderSession(root)) return; // a person's own session in the project: not ours to guard
  const cfg = loadConfig(root);
  if (cfg.errors.length) return;
  const reason = decide(input, { root, config: cfg.config });
  if (reason) {
    deny(reason);
    const r = recordDenial(root, { kind: "guard", tool: input.tool_name, detail: JSON.stringify(input.tool_input || {}), reason });
    if (r.notify) {
      await notify({ title: `AutoClaude: ${r.count} denials in the last hour`, message: `The run on ${state.currentStep || "?"} keeps trying things the rules forbid (latest: ${input.tool_name}). It may be stuck. Look at .autoclaude/logs/denials.log.`, priority: "high" }, { logFile: path.join(root, ".autoclaude", "logs", "notify.log"), stdout: { write() { return true; } } });
    }
  }
}

// fileURLToPath, not URL.pathname: a plugin path with a space or a tilde is percent-encoded in
// the URL, and the comparison would silently fail and leave the guard off.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
