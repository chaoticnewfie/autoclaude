// PreToolUse hook: while a run is active, keep the builder inside the rules (PLAN.md 4.2, 4.7).
//   - AskUserQuestion is denied with the section 4.5 guidance (no human is there).
//   - Edits to the plan, autoclaude.config.json and .autoclaude/ are denied.
//   - Bash and PowerShell commands that would write, delete or move those files, push while
//     pushing is off, force-push, hard-reset, commit or tag, or delete recursively outside the
//     project and the temp folder are denied.
//   - The project's guard.deny rules are tested against each command the line runs, not its
//     data (P8.4, see ruleTexts): the rehearsal's false positives were heredoc bodies, greps
//     and a read-only linter naming a forbidden script.
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

// ctx: { root, config } plus, for tests, tempDirs (the temp folders; default: this machine's)
// and readFile (how package.json is read for `npm run`).
export function decide(input, { root, config, tempDirs, readFile }) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const cli = "autoclaude";
  if (tool === "AskUserQuestion") {
    return `No human is available during an AutoClaude run. Decide it yourself: check the plan's Constraints & decisions and ${config.docs.decisions} first, then run \`${cli} decide "<the question and the options>"\` in the foreground (Bash timeout 600000) and wait for its JSON answer; apply a routine answer and log it in ${config.docs.decisions} as D-###. Work the plan allows is routine. Only a critical question (something the plan does not cover that only the owner can decide, or a secret this machine cannot generate) stops the run: \`${cli} blocked <step> "<question with options>"\`.`;
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
  if (SHELL_TOOLS[tool]) return decideShell(String(ti.command || ""), SHELL_TOOLS[tool], { root, config, cwd: input.cwd, cli, tempDirs, readFile });
  return null;
}

function decideShell(cmd, shell, { root, config, cwd, cli, tempDirs, readFile }) {
  const P = pathApi(root);
  const base = cwd && P.isAbsolute(String(cwd)) ? String(cwd) : root;

  // The project's own off-limits list first (guard.deny in autoclaude.config.json, D37).
  const hit = matchDenyRule(cmd, shell, { root, config, cwd: base, readFile });
  if (hit) return `This project does not allow that command during an AutoClaude run${hit.via ? ` (\`${hit.via}\` runs \`${hit.text}\`)` : ""}: ${hit.why}. Find another way that stays inside the project, or if the step truly needs it, run \`${cli} blocked <step> "<why, with the options>"\`.`;

  const fx = shellEffects(cmd, shell);
  const key = (p) => (P === path.win32 ? p.toLowerCase() : p);
  const same = (a, b) => key(a) === key(b);
  // The temp folders, read only when a command names one ($TEMP, /tmp, a mktemp result).
  let temps = null;
  const tempsNow = () => (temps ??= tempRoots(P, tempDirs));
  const expand = (w) => tempWord(w, tempsNow, P);
  // An effect's path made absolute: the session's cwd, then every cd earlier on the line.
  const where = (item) => resolveTarget(expand(item.path), item.dirs.reduce((from, d) => resolveTarget(expand(d), from, P), base), P);
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
    if (abs && (contains(P, root, abs) || (d.rootOk && same(abs, root)))) continue;
    // Scratch folders under the OS temp folder are the builder's own (the rehearsal's mktemp -d).
    if (abs && inTemp(P, abs, tempsNow(), root, same)) continue;
    return "Recursive deletes outside the project (or of the whole project) are not allowed during an AutoClaude run. Delete only paths inside the project folder, or inside the temp folder.";
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

// The first guard.deny rule that matches a command on the line: { text, via, why } or null.
function matchDenyRule(cmd, shell, { root, config, cwd, readFile }) {
  const rules = [];
  for (const rule of Array.isArray(config.guard && config.guard.deny) ? config.guard.deny : []) {
    if (!rule || typeof rule.pattern !== "string" || !rule.pattern) continue;
    let re;
    try { re = new RegExp(rule.pattern, "i"); } catch { continue; }
    // A reason written as a sentence keeps its own full stop; do not add a second one.
    rules.push({ re, why: String(rule.reason || `it matches the guard.deny rule /${rule.pattern}/`).trim().replace(/[.!]+$/, "") });
  }
  if (!rules.length) return null;
  let texts;
  // A line the reader cannot take apart is tested whole, as before P8.4: never fail open.
  try { texts = ruleTexts(cmd, shell, { root, cwd, readFile }); } catch { texts = [{ text: String(cmd), via: "" }]; }
  for (const r of rules) for (const t of texts) if (r.re.test(t.text)) return { ...t, why: r.why };
  return null;
}

// True when a shell command line writes to, deletes or moves a path containing `target`.
export function writesTo(cmd, target, shell = "bash") {
  const norm = (s) => String(s).replace(/\\/g, "/").toLowerCase();
  const t = norm(target).replace(/\/+$/, "");
  return shellEffects(cmd, shell).writes.some((w) => norm(w.path).includes(t));
}

// ---- Reading a command line (best effort, readable over complete) --------------------------

// Splits a command line into simple commands, each { words, redirects, inputs, heredocs, pipe }.
// Separators are ; & | and newlines, plus ( ) { } so subshells and script blocks are looked at
// too; the bodies of $(...), `...` and <(...) are read as commands of their own. Quotes group a
// word and are removed. Backslashes stay literal (Windows paths), except that bash escapes a
// space, a quote or a backtick with one; PowerShell escapes with a backtick and cmd with a caret.
// `>`, `>>`, `2>`, `*>` and `&>` make the next word a redirect target, `2>&1` writes nothing, `<`
// names an input file, and a `#` that starts a word starts a comment. Heredoc bodies and
// here-strings are data: they land in `heredocs` ({ delim, quoted, body }), never in the
// commands, except that bash still runs the $(...) and `...` inside an unquoted heredoc. `pipe`
// is true when the command reads the output of the one before it.
export function parseCommandLine(cmd, shell = "bash") {
  const s = String(cmd || "");
  const escape = shell === "powershell" ? "`" : shell === "cmd" ? "^" : "\\";
  const bash = shell === "bash";
  const commands = [];
  const nested = [];
  const waiting = []; // heredocs whose body starts at the next newline
  let words = [];
  let redirects = [];
  let inputs = [];
  let docs = [];
  let word = null;
  let quoted = false; // the current word had a quote or an escape in it (a quoted heredoc delimiter)
  let pending = null; // "out": the next word is a redirect target; "in": an input; "heredoc": a delimiter; "string": a here-string
  let piped = false;
  let quote = null;
  const endWord = () => {
    if (word === null) return;
    if (pending === "out") redirects.push(word);
    else if (pending === "in") inputs.push(word);
    else if (pending === "heredoc") {
      const doc = { delim: word.replace(/\\/g, ""), quoted: quoted || word.includes("\\"), body: null };
      waiting.push(doc);
      docs.push(doc);
    } else if (pending === "string") docs.push({ delim: null, quoted: true, body: word });
    else words.push(word);
    pending = null;
    word = null;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (words.length || redirects.length || inputs.length || docs.length) {
      commands.push({ words, redirects, inputs, heredocs: docs, pipe: piped });
      piped = false;
    }
    words = [];
    redirects = [];
    inputs = [];
    docs = [];
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
    // bash backticks are command substitution too (not inside single quotes).
    if (bash && c === "`" && quote !== "'") {
      let j = i + 1;
      while (j < s.length && s[j] !== "`") j += s[j] === "\\" ? 2 : 1;
      nested.push(s.slice(i + 1, j));
      word = (word ?? "") + s.slice(i, j + 1);
      i = j;
      continue;
    }
    // Process substitution <(...) and >(...): the word stands for a file, the body is a command.
    if (bash && !quote && (c === "<" || c === ">") && next === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < s.length; j++) {
        if (s[j] === "(") depth++;
        else if (s[j] === ")" && --depth === 0) break;
      }
      nested.push(s.slice(i + 2, j));
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
    if (c === "'" || c === '"') { quote = c; word = word ?? ""; quoted = true; continue; }
    if (c === escape && next !== undefined) {
      if (next === "\n" || next === "\r") { endWord(); i += next === "\r" && s[i + 2] === "\n" ? 2 : 1; continue; } // line continuation
      if (shell !== "bash" || /[\s'"`]/.test(next)) { word = (word ?? "") + next; quoted = true; i++; continue; }
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
      if (s[i + 1] === "<" && s[i + 2] === "<") { i += 2; pending = "string"; continue; } // here-string: data
      if (s[i + 1] === "<") { i++; if (s[i + 1] === "-") i++; pending = "heredoc"; continue; }
      pending = "in";
      continue;
    }
    if (c === "&" && next === ">") { endWord(); continue; } // &> file: the > follows
    if (c === "\n") {
      endCommand();
      // Heredoc bodies: every line up to its delimiter is data, not commands.
      for (const doc of waiting.splice(0)) {
        const lines = [];
        let j = i + 1;
        for (;;) {
          const eol = s.indexOf("\n", j);
          const line = s.slice(j, eol < 0 ? s.length : eol).replace(/\r$/, "");
          if (line.trim() === doc.delim) { i = eol < 0 ? s.length : eol; break; }
          lines.push(line);
          if (eol < 0) { i = s.length; break; }
          j = eol + 1;
        }
        doc.body = lines.join("\n");
        // An unquoted delimiter: bash still runs the $(...) and `...` in the body.
        if (bash && !doc.quoted) nested.push(...substitutions(doc.body));
      }
      continue;
    }
    if (c === "|") {
      if (next === "|") { i++; endCommand(); continue; } // ||: the next command runs on failure, no pipe
      if (next === "&") i++; // |& pipes stderr as well
      endCommand();
      piped = true;
      continue;
    }
    if (";&(){}".includes(c)) { endCommand(); continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    word = (word ?? "") + c;
  }
  endCommand();
  for (const inner of nested) commands.push(...parseCommandLine(inner, shell));
  return commands;
}

// The $(...) and `...` bodies bash expands in a piece of text (an unquoted heredoc body).
function substitutions(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === "\\") { i++; continue; }
    if (c === "$" && text[i + 1] === "(") {
      let depth = 0;
      let j = i + 1;
      for (; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")" && --depth === 0) break;
      }
      out.push(text.slice(i + 2, j));
      i = j;
    } else if (c === "`") {
      let j = i + 1;
      while (j < text.length && text[j] !== "`") j += text[j] === "\\" ? 2 : 1;
      out.push(text.slice(i + 1, j));
      i = j;
    }
  }
  return out;
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
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh", "ash"]);
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
// counts when it takes a protected path along with a folder. Variables set earlier on the line
// (d=$(mktemp -d), S=C:/x, $d = Join-Path $env:TEMP x) are expanded into later paths.
export function shellEffects(cmd, shell = "bash") {
  const out = { git: [], recursive: [], writes: [], code: [] };
  walk(parseCommandLine(cmd, shell), [], 0, out, new Map());
  for (const m of String(cmd || "").matchAll(DOTNET_WRITERS)) out.writes.push({ path: m[1].trim(), dirs: [], tree: true });
  return out;
}

function walk(commands, dirs, depth, out, vars) {
  for (const c of commands) {
    for (const r of c.redirects) out.writes.push({ path: expandVars(r, vars), dirs, tree: false });
    const set = assignment(c.words, vars);
    if (set === true) continue;
    const raw = (Array.isArray(set) ? set : c.words).map((w) => expandVars(w, vars));
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
      if (SHELLS.has(name) || name === "eval") {
        const k = name === "eval" ? -1 : args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
        const body = name === "eval" ? args.join(" ") : k >= 0 ? args[k + 1] : null;
        if (body) walk(parseCommandLine(body, "bash"), dirs, depth + 1, out, new Map(vars));
        // bash <<EOF ... EOF: the heredoc is the script.
        else if (name !== "eval" && !scriptOperand(args)) {
          for (const doc of c.heredocs) if (doc.body) walk(parseCommandLine(doc.body, "bash"), dirs, depth + 1, out, new Map(vars));
        }
      } else if (name === "cmd") {
        const k = args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
        const rest = k >= 0 ? args.slice(k + 1) : [];
        const body = rest.length === 1 ? rest[0] : rest.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
        if (body) walk(parseCommandLine(body, "cmd"), dirs, depth + 1, out, new Map(vars));
      } else if (["powershell", "pwsh", "invoke-expression", "iex"].includes(name)) {
        const k = name.startsWith("i") ? -1 : args.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a));
        const body = name.startsWith("i") ? operands(args).join(" ") : k >= 0 ? args.slice(k + 1).join(" ") : null;
        if (body) walk(parseCommandLine(body, "powershell"), dirs, depth + 1, out, new Map(vars));
      }
    }
  }
}

// git [global options] <sub> <args>: the subcommand and where it sits. -C <dir> moves where the
// paths after it resolve.
function gitSub(args) {
  let i = 0;
  const dirs = [];
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-C") { if (args[i + 1] !== undefined) dirs.push(args[i + 1]); i += 2; }
    else if (/^(-c|--git-dir|--work-tree|--namespace|--config-env|--super-prefix)$/.test(a)) i += 2;
    else i++;
  }
  return { sub: String(args[i] || "").toLowerCase(), at: i, dirs };
}

function gitEffect(args, dirs, out) {
  const g = gitSub(args);
  const gdirs = [...dirs, ...g.dirs];
  const rest = args.slice(g.at + 1);
  out.git.push({ sub: g.sub, args: rest, dirs: gdirs });
  // Restoring, removing or moving a file through git rewrites it like any other writer.
  if (["checkout", "restore", "rm", "mv"].includes(g.sub)) {
    const valued = [/^(-s|--source|-b|-B|--orphan|-m|--conflict|--pathspec-from-file)$/];
    for (const t of operands(rest, { takesValue: valued })) out.writes.push({ path: t, dirs: gdirs, tree: g.sub === "rm" || g.sub === "mv" });
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

// The script a shell runs, if it names one (bash x.sh); none, or `-`, means it reads stdin.
function scriptOperand(args) {
  return operands(args, { takesValue: [/^[-+]o$/, /^--(rcfile|init-file)$/] }).filter((a) => a !== "-")[0] || null;
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

// ---- Variables set on the line ----------------------------------------------------------------

// A variable assignment. Records the value in `vars` (names in lower case) and returns true when
// nothing runs (NAME=value, $name = "text"), the words that still run for PowerShell's
// `$x = <command>`, or null when the command is not a bare assignment (export X=1 is recorded
// but still runs, since it changes the environment of what follows).
function assignment(words, vars) {
  if (!words.length) return null;
  const ps = /^\$([A-Za-z_]\w*)$/.exec(words[0]);
  if (ps && words[1] === "=") {
    const rhs = words.slice(2);
    vars.set(ps[1].toLowerCase(), valueOf(rhs.map((w) => expandVars(w, vars))));
    return rhs.length > 1 ? rhs : true;
  }
  const one = /^\$([A-Za-z_]\w*)=(.+)$/.exec(words[0]);
  if (one && words.length === 1) { vars.set(one[1].toLowerCase(), valueOf([expandVars(one[2], vars)])); return true; }
  const lead = /^(export|local|declare|typeset|readonly)$/.test(words[0]) ? 1 : 0;
  const pairs = words.slice(lead).filter((w) => !/^[-+]/.test(w));
  if (!pairs.length || !pairs.every((w) => /^[A-Za-z_]\w*=/.test(w))) return null;
  for (const w of pairs) {
    const k = w.indexOf("=");
    vars.set(w.slice(0, k).toLowerCase(), valueOf([expandVars(w.slice(k + 1), vars)]));
  }
  return lead ? null : true;
}

// A value as a path: $(mktemp ...) becomes a path in the temp folder (or the -p folder), and
// PowerShell's GetTempPath() and Join-Path $env:TEMP x become $env:TEMP paths.
function valueOf(ws) {
  const v = ws.join(" ");
  const mk = /^(?:\$\(|`)\s*mktemp\b([^)`]*)[)`]$/.exec(v);
  if (mk) return mktempPath(mk[1].trim().split(/\s+/).filter(Boolean).map((a) => a.replace(/^["']|["']$/g, "")));
  if (/^\[(System\.)?IO\.Path\]::GetTempPath$/i.test(v)) return "$env:TEMP";
  if (/^join-path$/i.test(ws[0] || "")) {
    const ops = operands(ws.slice(1));
    if (ops.length >= 2) return `${ops[0]}\\${ops[1]}`;
  }
  return v;
}

function mktempPath(args) {
  let dir = null;
  let template = null;
  let inTmp = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p") { dir = args[++i] || null; continue; }
    const m = /^--tmpdir=(.+)$/.exec(a);
    if (m) { dir = m[1]; continue; }
    if (a === "-t" || a === "--tmpdir") { inTmp = true; continue; }
    if (a.startsWith("-")) continue;
    template = a;
  }
  const name = template ? template.split(/[\\/]/).pop() : "tmp.XXXXXXXXXX";
  if (dir) return `${dir}/${name}`;
  if (template && /[\\/]/.test(template) && !inTmp) return template;
  return `$TMPDIR/${name}`;
}

// $NAME, ${NAME} and %NAME% for the variables the line set; everything else stays as written.
function expandVars(word, vars) {
  const w = String(word);
  if (!vars.size || !/[$%]/.test(w)) return w;
  return w.replace(/\$\{(\w+)\}|\$(\w+)|%(\w+)%/g, (m, a, b, c) => {
    const k = (a || b || c).toLowerCase();
    return vars.has(k) ? vars.get(k) : m;
  });
}

// ---- What a guard.deny rule is tested against (P8.4) ---------------------------------------
//
// Each command the line runs becomes one text: its words joined by spaces (quotes removed),
// with any `> target` it writes to. A rule matches the commands, not the data around them:
//   - heredoc bodies and here-strings are left out, unless a shell or an interpreter reads its
//     script from them (bash <<EOF, python - <<EOF when the code starts processes);
//   - echo, printf and Write-Output text, comments, a PowerShell -Value and a git message are
//     left out;
//   - commands that only read the files they name (grep, cat, sed -n, awk, git show/log/diff,
//     shellcheck, a linter in docker with its files mounted read-only, and the like) keep only
//     their name and any operand that names another machine (a UNC path or a URL);
//   - what runs is kept: a script run through a shell, ./x, source, powershell -File, a file
//     piped or redirected into an interpreter, and the package.json script `npm run x` maps to.
// Returns [{ text, via }], where via names the npm command a text came from.
export function ruleTexts(cmd, shell = "bash", { root = null, cwd = null, readFile = readText } = {}) {
  const out = [];
  const P = pathApi(root || cwd || process.cwd());
  collectTexts(parseCommandLine(cmd, shell), { P, base: cwd || root, readFile, depth: 0, via: "" }, new Map(), out);
  return out;
}

// Commands that only read, list or look up what they name.
const READERS = new Set([
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "cat", "head", "tail", "less", "more", "wc", "cut", "sort", "uniq",
  "diff", "cmp", "comm", "file", "stat", "ls", "dir", "tree", "du", "nl", "tac", "od", "xxd", "hexdump", "strings",
  "column", "jq", "bat", "md5sum", "sha1sum", "sha256sum", "sha512sum", "cksum", "basename", "dirname", "realpath",
  "readlink", "which", "where", "whereis", "type", "test", "[", "[[",
  "shellcheck", "shfmt", "hadolint", "actionlint", "yamllint", "markdownlint", "markdownlint-cli2", "codespell",
  "get-content", "gc", "select-string", "sls", "findstr", "get-item", "gi", "get-childitem", "gci", "test-path",
  "get-filehash", "format-hex", "get-command", "gcm", "measure-object", "resolve-path", "split-path", "invoke-scriptanalyzer"
]);
// Commands that print their arguments: the arguments are text.
const PRINTERS = new Set(["echo", "printf", "write", "write-output", "write-host", "write-information", "write-warning", "write-error", "write-verbose", "write-debug", "out-host", ":", "true", "false"]);
// git subcommands that read the repository or only change the working tree: the files they name
// are not run.
const GIT_LOCAL = new Set(["status", "show", "log", "diff", "ls-files", "blame", "grep", "cat-file", "rev-parse", "shortlog", "ls-tree", "describe", "whatchanged", "reflog", "check-ignore", "check-attr", "diff-tree", "diff-files", "diff-index", "name-rev", "merge-base", "show-ref", "for-each-ref", "count-objects", "add", "restore", "checkout", "switch", "stash"]);
const GIT_MESSAGE = new Set(["commit", "tag", "notes", "merge"]);
const KEYWORDS = new Set(["if", "then", "else", "elif", "while", "until", "do", "!"]);
const ENDS = new Set(["fi", "done", "esac"]);
const HEADERS = new Set(["for", "select", "case", "foreach", "function"]);
// The flag that gives an interpreter its code on the command line.
const INLINE = { node: /^(-e|-p|--eval|--print|-pe)$/, deno: /^(-e|--eval)$/, bun: /^(-e|--eval|-p|--print)$/, python: /^-c$/, python3: /^-c$/, py: /^-c$/, ruby: /^-[a-zA-Z]*e$/, perl: /^-[a-zA-Z]*[eE]$/, php: /^-r$/ };
// Code that starts other programs: only then is inline or heredoc code tested as a command.
const SPAWNS = /\bsubprocess\b|\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bpty\.spawn\b|\bchild_process\b|\b(execSync|execFileSync|spawnSync|execFile|execa)\b|\bPopen\b|\bProcess\.Start\b|\bStart-Process\b|\bInvoke-Expression\b|\b(shell_exec|passthru|proc_open|popen|system)\s*\(|\bOpen3\b|\bDeno\.(run|Command)\b|\bBun\.(spawn|\$)/;
const LINTER_IMAGE = /^(shellcheck|shfmt|hadolint|actionlint|yamllint|markdownlint(-cli2?)?|jsonlint|codespell|typos|editorconfig-checker|psscriptanalyzer)([-_.][\w.-]*)?$/i;
const DOCKER_VALUED = /^(-v|--volume|--mount|-e|--env|--env-file|-w|--workdir|--network|--net|--name|-u|--user|--entrypoint|-p|--publish|--platform|-l|--label|--label-file|--add-host|--cpus|-m|--memory|--memory-swap|--tmpfs|--cap-add|--cap-drop|--device|-h|--hostname|--pull|--restart|--log-driver|--log-opt|--security-opt|--ulimit|--gpus|--shm-size|--stop-timeout|--stop-signal|--dns|--ipc|--pid|--userns|--cidfile|--runtime|--isolation|--cpuset-cpus|--expose|--link|--volumes-from|-a|--attach)$/;
const FIND_ACTIONS = /^-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls)$/;
const LIFECYCLE = { test: "test", t: "test", tst: "test", start: "start", stop: "stop", restart: "restart" };
// PowerShell host parameters that take a value (-ExecutionPolicy Bypass, -WindowStyle Hidden).
const PS_HOST_VALUE = /^-(e\w*|w\w*|o\w*|i\w*|v\w*|conf\w*|settingsfile|custompipename)$/i;

function collectTexts(commands, st, vars, out) {
  let dirs = [];
  const deeper = (text, sh, extra = {}) => {
    if (text && st.depth < 4) collectTexts(parseCommandLine(text, sh), { ...st, depth: st.depth + 1, ...extra }, new Map(vars), out);
  };
  for (let k = 0; k < commands.length; k++) {
    const c = commands[k];
    const set = assignment(c.words, vars);
    if (set === true) continue;
    const words = (Array.isArray(set) ? set : c.words).map((w) => expandVars(w, vars));
    const rest = unwrap(words);
    const prefix = words.slice(0, words.length - rest.length);
    const writes = c.redirects.map((r) => `> ${expandVars(r, vars)}`);
    const push = (parts) => {
      const text = [...prefix, ...parts, ...writes].join(" ").trim();
      if (text) out.push({ text, via: st.via });
    };
    if (!rest.length) { push([]); continue; }
    const name = commandName(rest[0]);
    const args = rest.slice(1);
    // What an interpreter reading its standard input runs: its heredocs and input files, and
    // what the command piped into it prints (with that command's own heredocs).
    const prev = c.pipe && k > 0 ? commands[k - 1] : null;
    const docs = [...c.heredocs, ...(prev ? prev.heredocs : [])].map((d) => d.body).filter(Boolean);
    const inputs = c.inputs.map((f) => `< ${expandVars(f, vars)}`);
    const fed = () => { if (prev) out.push({ text: prev.words.map((w) => expandVars(w, vars)).join(" "), via: st.via }); };

    if (ENDS.has(name)) continue;
    if (HEADERS.has(name)) { push([rest[0]]); continue; }
    if (CD.has(name)) {
      const d = operands(args)[0];
      if (d && d !== "-") dirs = [...dirs, d];
      push([rest[0], ...args.filter(isRemote)]);
      continue;
    }
    if (name === "eval") { push([rest[0]]); deeper(args.join(" "), "bash"); continue; }
    if (name === "invoke-expression" || name === "iex") {
      push([rest[0]]);
      const body = operands(args).join(" ");
      if (body) deeper(body, "powershell");
      else fed();
      continue;
    }
    if (name === "cmd") {
      const i = args.findIndex((a) => /^\/\/?[ck]$/i.test(a));
      if (i < 0) { push(rest); continue; }
      push([rest[0], ...args.slice(0, i + 1)]);
      const body = args.slice(i + 1);
      deeper(body.length === 1 ? body[0] : body.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" "), "cmd");
      continue;
    }
    if (name === "powershell" || name === "pwsh") {
      const i = args.findIndex((a) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(a));
      if (i >= 0 && args[i + 1] !== undefined && args[i + 1] !== "-") {
        push([rest[0], ...args.slice(0, i + 1)]);
        deeper(args.slice(i + 1).join(" "), "powershell");
        continue;
      }
      const file = args.some((a) => /^-f(i(l(e)?)?)?$/i.test(a)) || (i < 0 && operands(args, { takesValue: [PS_HOST_VALUE] }).some((a) => a !== "-"));
      push([...rest, ...inputs]);
      if (!file) { for (const b of docs) deeper(b, "powershell"); fed(); }
      continue;
    }
    if (SHELLS.has(name)) {
      const i = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a));
      if (i >= 0) { push([rest[0], ...args.slice(0, i + 1)]); deeper(args[i + 1], "bash"); continue; }
      if (args.some((a) => /^-[a-zA-Z]*n[a-zA-Z]*$/.test(a))) { push([rest[0]]); continue; } // -n: a syntax check, nothing runs
      push([...rest, ...inputs]);
      if (!scriptOperand(args) || args.some((a) => /^-[a-zA-Z]*s[a-zA-Z]*$/.test(a))) { for (const b of docs) deeper(b, "bash"); fed(); }
      continue;
    }
    if (name === "npm" || name === "pnpm" || name === "yarn" || (name === "bun" && args[0] === "run")) {
      push(dropValues(rest));
      const from = dirs.reduce((f, d) => resolveTarget(d, f, st.P), st.base);
      for (const s of packageScripts(name, args, from, st)) deeper(s.command, "bash", { via: `${name} run ${s.name}`, base: s.dir });
      continue;
    }
    if (INLINE[name]) {
      const i = args.findIndex((a) => INLINE[name].test(a));
      if (i >= 0) { push(SPAWNS.test(args[i + 1] || "") ? [rest[0], ...args.slice(0, i + 2)] : [rest[0], ...args.slice(0, i)]); continue; }
      const ops = operands(args, { takesValue: [/^(-W|-X|-r|--require|--import|--loader|--experimental-loader|--input-type|-I)$/] });
      if (args.includes("-m") || (ops.length && ops[0] !== "-")) { push(dropValues(rest)); continue; }
      push([...rest, ...inputs]);
      for (const b of docs) if (SPAWNS.test(b)) out.push({ text: `${rest[0]} ${b}`, via: st.via });
      fed();
      continue;
    }
    if (name === "git") {
      const g = gitSub(args);
      if (GIT_LOCAL.has(g.sub)) push([rest[0], ...args.slice(0, g.at + 1), ...args.slice(g.at + 1).filter(isRemote)]);
      else push(dropValues(rest, GIT_MESSAGE.has(g.sub)));
      continue;
    }
    if (name === "docker" || name === "podman") {
      const lint = linterRun(args);
      push(lint ? [rest[0], ...lint] : dropValues(rest));
      continue;
    }
    if (readsOnly(name, args)) { push([rest[0], ...args.filter(isRemote)]); continue; }
    if (PRINTERS.has(name)) { push([rest[0]]); continue; }
    push(dropValues(rest));
  }
}

// Wrappers, FOO=bar assignments and shell keywords in front of the real command.
function unwrap(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const n = commandName(w);
    if (/^[A-Za-z_]\w*=/.test(w) || KEYWORDS.has(w)) { i++; continue; }
    if (n === "command" && /^-[vV]$/.test(words[i + 1] || "")) break; // command -v: a lookup
    if (n === "timeout") {
      i++;
      while (i < words.length && words[i].startsWith("-")) i += /^(-s|-k|--signal|--kill-after)$/.test(words[i]) ? 2 : 1;
      i++; // the duration
      continue;
    }
    if (!WRAPPERS.has(n)) break;
    i++;
    while (i < words.length && words[i].startsWith("-")) i++;
  }
  return words.slice(i);
}

// Read-only in this invocation: a reader, sed without -i, awk that neither writes, pipes nor
// runs anything, find without an action, `command -v`.
function readsOnly(name, args) {
  if (READERS.has(name) || name === "command") return true;
  if (name === "sed") return !args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a));
  if (["awk", "gawk", "mawk", "nawk"].includes(name)) {
    if (args.some((a) => /^-f/.test(a) || a === "--file")) return false;
    const program = operands(args, { takesValue: [/^-(v|F)$/, /^--(assign|field-separator)$/] })[0];
    return program !== undefined && !/\bsystem\s*\(|\||\bprintf?\b[^;}\n]*>/.test(program);
  }
  if (name === "find") return !args.some((a) => FIND_ACTIONS.test(a));
  return false;
}

// docker run of a linter image with every mount read-only: the options up to the image, without
// the mounts, or null when it is anything else.
function linterRun(args) {
  let i = args[0] === "container" ? 1 : 0;
  if (args[i] !== "run") return null;
  const keep = args.slice(0, i + 1);
  for (i++; i < args.length && args[i].startsWith("-"); i++) {
    const a = args[i];
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const flag = eq > 0 ? a.slice(0, eq) : a;
    const inline = eq > 0 ? a.slice(eq + 1) : null;
    const value = inline !== null ? inline : DOCKER_VALUED.test(flag) ? args[++i] : null;
    if (flag === "-v" || flag === "--volume") {
      if (!/:(?:[\w,]*,)?(ro|readonly)(?:,[\w,]*)?$/i.test(value || "")) return null;
      continue;
    }
    if (flag === "--mount") {
      if (!/(^|,)(readonly|ro)(=(true|1))?(,|$)/i.test(value || "")) return null;
      continue;
    }
    if (flag === "--volumes-from" || flag === "--entrypoint") return null;
    keep.push(a);
    if (inline === null && value !== null) keep.push(value);
  }
  const image = args[i];
  if (!image || !LINTER_IMAGE.test(image.split("/").pop().split(/[:@]/)[0])) return null;
  keep.push(image);
  return keep;
}

// A PowerShell -Value or -InputObject is data in any command; so is a git commit message.
function dropValues(words, gitMessage = false) {
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (/^-(value|inputobject):/i.test(w) || (gitMessage && /^--message=/.test(w))) continue;
    if (/^-(value|inputobject)$/i.test(w)) { i++; continue; }
    if (gitMessage && /^(-[a-zA-Z]*m|--message)$/.test(w)) { out.push(w); i++; continue; }
    out.push(w);
  }
  return out;
}

// An operand that names another machine: a UNC path, a URL or user@host:path.
function isRemote(w) {
  return /^(\\\\|\/\/)[^\\/\s]+[\\/]/.test(w) || /^[a-z][\w+.-]*:\/\//i.test(w) || /^[\w.-]+@[\w.-]+:/.test(w);
}

// The package.json scripts a package-manager command runs, [{ name, command, dir }], read from
// the folder it runs in (--prefix, -C, --dir, --cwd). npm also runs pre<name> and post<name>.
function packageScripts(pm, args, cwd, { P, readFile }) {
  if (!cwd) return [];
  let dir = null;
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--") break;
    const eq = /^(--prefix|--dir|--cwd)=(.+)$/.exec(a);
    if (eq) { dir = eq[2]; continue; }
    if (/^(--prefix|-C|--dir|--cwd)$/.test(a)) { dir = args[++i]; continue; }
    if (/^(-w|--workspace|--filter|-F)$/.test(a)) { i++; continue; }
    if (a.startsWith("-")) continue;
    pos.push(a);
  }
  const pkgDir = dir ? resolveTarget(dir, cwd, P) : cwd;
  if (!pkgDir) return [];
  let scripts;
  try { scripts = JSON.parse(readFile(P.join(pkgDir, "package.json")) || "{}").scripts; } catch { return []; }
  if (!scripts || typeof scripts !== "object") return [];
  const [sub, target] = pos;
  let script = null;
  if (["run", "run-script", "rum", "urn"].includes(sub)) script = target;
  else if (Object.hasOwn(LIFECYCLE, sub || "")) script = LIFECYCLE[sub];
  else if (pm !== "npm" && sub && Object.hasOwn(scripts, sub)) script = sub; // yarn x, pnpm x
  if (!script) return [];
  const names = pm === "npm" ? [`pre${script}`, script, `post${script}`] : [script];
  return names.filter((n) => Object.hasOwn(scripts, n) && typeof scripts[n] === "string").map((n) => ({ name: n, command: scripts[n], dir: pkgDir }));
}

function readText(file) {
  try { return fs.readFileSync(file, "utf8"); } catch { return null; }
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

// The OS temp folders for this path style: os.tmpdir() (and its long form: TEMP often holds a
// short 8.3 name), TEMP, TMP and TMPDIR, plus /tmp and /var/tmp on POSIX. Git Bash's /tmp is
// %TEMP%. A drive or / itself never counts. `given` replaces the lookup (tests).
function tempRoots(P, given) {
  const win = P === path.win32;
  const list = [];
  const add = (p) => {
    if (!p || typeof p !== "string") return;
    if (win ? !/^[A-Za-z]:[\\/]|^\\\\/.test(p) : !p.startsWith("/")) return;
    const r = P.resolve(p);
    if (P.dirname(r) === r) return;
    if (!list.some((x) => (win ? x.toLowerCase() === r.toLowerCase() : x === r))) list.push(r);
  };
  if (Array.isArray(given)) given.forEach(add);
  else {
    add(os.tmpdir());
    try { add(fs.realpathSync.native(os.tmpdir())); } catch {}
    for (const k of ["TEMP", "TMP", "TMPDIR"]) add(process.env[k]);
    if (!win) { add("/tmp"); add("/var/tmp"); }
  }
  return list;
}

// $TEMP, ${TMPDIR:-/tmp}, $env:TEMP, %TEMP% (and Git Bash's /tmp on Windows) at the start of a
// path word, replaced by the temp folder. `temps` is a function so the lookup happens only then.
const TEMP_VAR = /^(?:\$\{(?:TMPDIR|TEMP|TMP)(?::?-[^}]*)?\}|\$(?:TMPDIR|TEMP|TMP)(?!\w)|\$env:(?:TEMP|TMP)(?!\w)|%(?:TEMP|TMP)%)/i;
function tempWord(word, temps, P) {
  const w = String(word);
  const m = TEMP_VAR.exec(w) || (P === path.win32 ? /^\/tmp(?=$|[\\/])/.exec(w) : null);
  if (!m) return w;
  const t = temps();
  return t.length ? t[0] + w.slice(m[0].length) : w;
}

// Strictly inside a temp folder, and neither the project nor a folder that holds it. A wildcard
// may not stand for a whole first-level name (all of the temp folder) or reach the project.
function inTemp(P, abs, temps, root, same) {
  if (same(abs, root) || contains(P, abs, root)) return false;
  if (/[*?]/.test(abs)) {
    const re = globRegex(P, abs);
    for (let d = root; ; d = P.dirname(d)) {
      if (re.test(d)) return false;
      if (P.dirname(d) === d) break;
    }
  }
  return temps.some((t) => contains(P, t, abs) && !/^[*?]+$/.test(P.relative(t, abs).split(P.sep)[0]));
}

// True when `child` is strictly inside `parent`.
function contains(P, parent, child) {
  const rel = P.relative(parent, child);
  return !!rel && rel !== ".." && !rel.startsWith(`..${P.sep}`) && !P.isAbsolute(rel);
}

// A path with * and ? as a regular expression over whole paths (a wildcard stays in one folder).
function globRegex(P, pattern) {
  const flags = P === path.win32 ? "i" : "";
  return new RegExp(`^${pattern.split(/([*?])/).map((part) => (part === "*" ? "[^\\\\/]*" : part === "?" ? "[^\\\\/]" : part.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("")}$`, flags);
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
  const re = globRegex(P, abs);
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
