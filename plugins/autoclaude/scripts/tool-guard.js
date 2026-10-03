// PreToolUse hook: while a run is active, keep the builder inside the rules (PLAN.md 4.2, 4.7).
//   - AskUserQuestion is denied with the section 4.5 guidance (no human is there).
//   - Edits to the plan, autoclaude.config.json, autoclaude.accepted.json (the owner's accepted
//     risks) and .autoclaude/ (the sweep reports included) are denied, and so are edits to this
//     computer's settings the run reads (the AutoClaude defaults and notify files, Claude Code's
//     user settings): the builder must not switch off what verifies it. A run on a generated
//     plan (`run --plan`, P10.7) protects that plan and the project's own plan alike. While the
//     current step is a change under pinned tests (tagged pinned: fixplan.isPinnedStep, P10.9),
//     any write under the characterization test folder is denied as well.
//   - Bash and PowerShell commands that would write, delete or move those files, push while
//     pushing is off, force-push or delete remote refs, change git aliases or push settings,
//     hard-reset, commit or tag, or delete recursively outside the project and the temp folder
//     (or where the guard cannot tell) are denied. A plain push is fine while git.push is on,
//     and so are git commands that only read (git tag -l, git config <key>).
//   - The project's guard.deny rules are tested against each command the line runs, not its
//     data (P8.4, see ruleTexts): the rehearsal's false positives were heredoc bodies, greps
//     and a read-only linter naming a forbidden script. Commands run from inside other programs
//     (inline code that starts processes, sed's e command, a shell in a linter image) count.
// Only the builder session is guarded (lib/builder.js): a person's own session opened in the
// project during a supervised run is left alone. Silent and instant when no run is active.
// Never throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findProjectRoot, claudeConfigDir } from "../lib/paths.js";
import { loadState, STATUS } from "../lib/state.js";
import { loadConfig, ACCEPTED_FILE, RUN_PLAN_ERROR_PATH } from "../lib/config.js";
import { recordDenial } from "../lib/denials.js";
import { notify } from "../lib/notify.js";
import { isBuilderSession } from "../lib/builder.js";

function deny(reason) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } }));
}

// The shell tools and how their command lines are read. Claude Code's Bash tool is Git Bash on
// Windows; the PowerShell tool exists there too and gets exactly the same rules.
const SHELL_TOOLS = { Bash: "bash", PowerShell: "powershell" };

// ctx: { root, config } plus mainPlan (the project's own plan when the run works on another one,
// loadConfig's mainPlan), pinned ({ step, dir, pinStep } while the current step must leave the
// tests in `dir` alone, else null) and, for tests, tempDirs (the temp folders; default: this
// machine's), configDir (the Claude config folder; default: this machine's, CLAUDE_CONFIG_DIR
// first as in lib/paths.js) and readFile (how package.json is read for `npm run`).
export function decide(input, { root, config, mainPlan, pinned = null, tempDirs, configDir, readFile }) {
  const tool = input.tool_name || "";
  const ti = input.tool_input || {};
  const cli = "autoclaude";
  if (tool === "AskUserQuestion") {
    return `No human is available during an AutoClaude run. Decide it yourself: check the plan's Constraints & decisions and ${config.docs.decisions} first, then run \`${cli} decide "<the question and the options>"\` in the foreground (Bash timeout 600000) and wait for its JSON answer; apply a routine answer and log it in ${config.docs.decisions} as D-###. Work the plan allows is routine. Only a critical question (something the plan does not cover that only the owner can decide, or a secret this machine cannot generate) stops the run: \`${cli} blocked <step> "<question with options>"\`.`;
  }
  // The project's own plan, when this run works on a generated one (P10.7): read-only as well.
  const otherPlan = typeof mainPlan === "string" && mainPlan.trim() && path.resolve(root, mainPlan).toLowerCase() !== path.resolve(root, config.plan).toLowerCase() ? mainPlan : null;
  const protectedRel = [config.plan, otherPlan, "autoclaude.config.json"].filter(Boolean).map((f) => path.resolve(root, f).toLowerCase());
  const acceptedAbs = path.resolve(root, ACCEPTED_FILE).toLowerCase();
  const runtimeDir = path.resolve(root, ".autoclaude").toLowerCase();
  const isProtected = (file) => {
    if (!file) return false;
    const abs = path.resolve(root, String(file)).toLowerCase();
    return protectedRel.includes(abs) || abs === runtimeDir || abs.startsWith(runtimeDir + path.sep);
  };
  const P = pathApi(root);
  const cfgDir = configDir || claudeConfigDir();
  const pin = pinnedTests(root, pinned);
  if (["Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) {
    const file = ti.file_path || ti.notebook_path;
    if (file && path.resolve(root, String(file)).toLowerCase() === acceptedAbs) return `${ACCEPTED_FILE} is the owner's list of accepted risks and false alarms; only the owner changes it, never a run. Fix the finding the step names instead.`;
    if (file && pin) {
      const abs = path.resolve(root, String(file)).toLowerCase();
      if (abs === pin.abs.toLowerCase() || abs.startsWith(pin.abs.toLowerCase() + path.sep)) return pin.message;
    }
    if (isProtected(file)) return `${path.basename(String(file))} is managed by the gate during a run. Only the gate ticks ${config.plan}${otherPlan ? `, and ${otherPlan} (the project's own plan) is left alone while this run works on ${config.plan}` : ""}; the config and .autoclaude/ are read-only for you. Continue the current step instead.`;
    if (file) {
      const abs = P.resolve(root, String(file));
      if (machineFiles(P, cfgDir).some((m) => sameFile(P, abs, m.abs))) return `${P.basename(abs)} holds this computer's AutoClaude or Claude Code settings, which this run uses; it is read-only during a run. Continue the current step instead.`;
    }
    return null;
  }
  if (SHELL_TOOLS[tool]) return decideShell(String(ti.command || ""), SHELL_TOOLS[tool], { root, config, otherPlan, pin, cwd: input.cwd, cli, tempDirs, cfgDir, readFile });
  return null;
}

// The pinned tests' folder as the guard checks it: { abs, rel, message }, or null when the
// current step is not pinned (or names no folder inside the project).
function pinnedTests(root, pinned) {
  if (!pinned || typeof pinned.dir !== "string" || !pinned.dir.trim()) return null;
  const rel = pinned.dir.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  const abs = path.resolve(root, rel);
  const r = path.relative(path.resolve(root), abs);
  if (!r || r.startsWith("..") || path.isAbsolute(r)) return null;
  const by = pinned.pinStep ? `the pin step ${pinned.pinStep} wrote` : "an earlier step wrote";
  return { abs, rel, message: `${rel}/ holds the characterization tests ${by}. Step ${pinned.step || "?"} changes the code under them and must pass them as they are: they are read-only during this step. Change the code, not the pinned tests.` };
}

// This computer's settings a run reads (D49), in the Claude config folder: the AutoClaude
// defaults (tester, security review, retries for every project that inherits them), the
// notification settings, and Claude Code's user settings (permissions and auto mode, which the
// supervisor's --settings merges with). `code` tells inline code that names one.
function machineFiles(P, dir) {
  const d = P.resolve(String(dir));
  const flat = (s) => s.replace(/\\+/g, "/").toLowerCase();
  return [
    { abs: P.join(d, "autoclaude", "defaults.json"), code: (t) => /autoclaude[\\/]+defaults\.json/i.test(t) },
    { abs: P.join(d, "autoclaude", "notify.json"), code: (t) => /autoclaude[\\/]+notify\.json/i.test(t) },
    { abs: P.join(d, "settings.json"), code: (t) => flat(t).includes(flat(P.join(d, "settings.json"))) }
  ];
}

// The same file, compared where it really is: 8.3 short names, links and junctions resolved.
function sameFile(P, a, b) {
  const key = (p) => (P === path.win32 ? p.toLowerCase() : p);
  return key(a) === key(b) || key(real(P, a)) === key(real(P, b));
}

function decideShell(cmd, shell, { root, config, otherPlan = null, pin = null, cwd, cli, tempDirs, cfgDir, readFile }) {
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
  const expand = (w) => configWord(tempWord(w, tempsNow, P), cfgDir);
  // An effect's path made absolute: the session's cwd, then every cd earlier on the line.
  const where = (item) => resolveTarget(expand(item.path), item.dirs.reduce((from, d) => resolveTarget(expand(d), from, P), base), P);
  // The same, where the file system really leads: through links, junctions and short names.
  const whereReal = (item) => physicalTarget(expand(item.path), item.dirs.reduce((from, d) => physicalTarget(expand(d), from, P), real(P, base)), P);
  const runtime = P.resolve(root, ".autoclaude");
  const machine = machineFiles(P, cfgDir);
  const messages = {
    plan: `Shell writes to ${config.plan} are not allowed; only the gate edits it.`,
    mainPlan: `Shell writes to ${otherPlan} are not allowed; it is the project's own plan, left alone while this run works on ${config.plan}.`,
    accepted: `${ACCEPTED_FILE} is the owner's list of accepted risks and false alarms; it is read-only during a run.`,
    config: "autoclaude.config.json is read-only during a run.",
    runtime: ".autoclaude/ is the gate's state; do not write to it.",
    pinned: pin ? pin.message : "",
    machine: "This computer's AutoClaude and Claude Code settings (autoclaude/defaults.json, autoclaude/notify.json and settings.json in the Claude config folder) are read-only during a run."
  };

  // Git settings handed to git through the environment on this line (GIT_CONFIG_PARAMETERS,
  // GIT_CONFIG_KEY_<n>) can alias a push just like -c can.
  if (fx.git.length && /GIT_CONFIG_(PARAMETERS|KEY_\d+)/i.test(cmd) && GIT_TRICK_TEXT.test(cmd)) return gitTrickMessage("GIT_CONFIG_*");
  for (const g of fx.git) {
    const trick = gitSettingTrick(g);
    if (trick) return gitTrickMessage(trick);
    if (g.sub === "push") {
      const risk = pushRisk(g.args);
      if (risk === "force") return "Force pushes are not allowed during an AutoClaude run.";
      if (risk === "delete") return "Deleting remote branches or tags (--delete, a :ref refspec, --prune) is not allowed during an AutoClaude run. Push with a plain `git push`; the owner removes branches.";
      if (!config.git.push) return "Pushing is off for this run (git.push is false in autoclaude.config.json). The owner pushes after review.";
    }
    if (g.sub === "reset" && g.args.includes("--hard")) return "git reset --hard is not allowed during an AutoClaude run. Undo your own changes file by file instead (edit them back, or `git restore <file>`).";
    if (g.sub === "commit" || (g.sub === "tag" && !tagReadOnly(g.args))) return "The gate commits and tags after each verified step. Do not commit yourself; run `autoclaude ready <step>` when the step is done.";
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
    // A target the guard cannot place is not inside the project: it comes from a command or a
    // variable, a pipe or xargs, brackets or a brace expansion, or a wildcard before a `..` (or
    // in a folder cd went to), which can match a link that leads anywhere.
    const abs = !wildBeforeUp(d) && where(d);
    if (abs && (contains(P, root, abs) || (d.rootOk && same(abs, root)))) continue;
    // Scratch folders under the OS temp folder are the builder's own (the rehearsal's mktemp -d),
    // judged by where the path really leads: a link or junction in the temp folder that points
    // elsewhere, or a `..` after one, is not in the temp folder.
    const phys = abs && whereReal(d);
    if (phys && inTemp(P, phys, tempsNow().map((t) => real(P, t)), real(P, root), same)) continue;
    if (!abs) return "Recursive deletes outside the project are not allowed during an AutoClaude run, and the guard cannot tell where this one's target is: it comes from a command or a variable, a pipe, xargs, brackets, a brace expansion or a wildcard before `..`. Name the path literally, inside the project folder or the temp folder (`rm -rf dist`, `Remove-Item -Recurse -Force .\\build`).";
    return "Recursive deletes outside the project (or of the whole project) are not allowed during an AutoClaude run. Delete only paths inside the project folder, or inside the temp folder.";
  }

  const guarded = [
    { kind: "plan", abs: P.resolve(root, config.plan), name: P.basename(config.plan) },
    ...(otherPlan ? [{ kind: "mainPlan", abs: P.resolve(root, otherPlan), name: P.basename(otherPlan) }] : []),
    { kind: "config", abs: P.resolve(root, "autoclaude.config.json"), name: "autoclaude.config.json" },
    { kind: "accepted", abs: P.resolve(root, ACCEPTED_FILE), name: ACCEPTED_FILE },
    { kind: "runtime", abs: runtime, name: ".autoclaude", dir: true },
    ...(pin ? [{ kind: "pinned", abs: P.resolve(root, pin.rel), name: pin.rel, dir: true }] : [])
  ];
  for (const w of fx.writes) {
    const abs = where(w);
    if (!abs) {
      // A variable we cannot expand: nothing to compare, unless the path plainly ends in one of
      // the machine settings files.
      if (/(^|[\\/])autoclaude[\\/]+(defaults|notify)\.json$/i.test(String(w.path))) return messages.machine;
      continue;
    }
    const hit = guarded.find((g) => touches(P, root, abs, g, w.tree, same));
    if (hit) return messages[hit.kind];
    if (machine.some((m) => touches(P, root, abs, { kind: "machine", abs: m.abs }, w.tree, same) || sameFile(P, abs, m.abs))) return messages.machine;
  }
  // Code run from the command line (node -e, python -c) that writes files and names a protected
  // one (a folder's name with either kind of slash).
  const flat = (s) => String(s).replace(/\\+/g, "/").toLowerCase();
  for (const text of fx.code) {
    const hit = guarded.find((g) => text.toLowerCase().includes(g.name.toLowerCase()) || (g.dir && flat(text).includes(flat(g.name))));
    if (hit) return messages[hit.kind];
    if (machine.some((m) => m.code(text))) return messages.machine;
  }
  return null;
}

// ---- Pushes and git settings ------------------------------------------------------------------

// What a git push would destroy on the remote: "force" (--force or -f in any cluster,
// --force-with-lease, --force-if-includes, --mirror, a +refspec), "delete" (--delete or -d,
// --prune, a :ref refspec), or null for a plain push to any remote. Git takes any unambiguous
// prefix of a long option (--mirr is --mirror), so a prefix counts as the option.
const PUSH_FORCE = ["force", "force-with-lease", "force-if-includes", "mirror"];
const PUSH_DELETE = ["delete", "prune"];
const PUSH_VALUED = /^(--push-option|--repo|--receive-pack|--exec)$/;
function pushRisk(args) {
  let risk = null;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === "--") { options = false; continue; }
    if (options && /^--./.test(a)) {
      const name = a.slice(2).split("=")[0].toLowerCase();
      if (PUSH_FORCE.some((o) => o.startsWith(name))) return "force";
      if (PUSH_DELETE.some((o) => o.startsWith(name))) risk = "delete";
      if (PUSH_VALUED.test(a)) i++;
      continue;
    }
    if (options && /^-./.test(a)) {
      // A cluster of short flags (-uf, -df); -o takes the rest of the word, or the next word.
      for (let k = 1; k < a.length; k++) {
        if (a[k] === "o") { if (k === a.length - 1) i++; break; }
        if (a[k] === "f") return "force";
        if (a[k] === "d") risk = "delete";
      }
      continue;
    }
    // The remote, then refspecs: +src:dst forces, :dst deletes.
    if (a.startsWith("+")) return "force";
    if (/^:./.test(a)) risk = "delete";
  }
  return risk;
}

// Git settings that change what a later plain git command does: an alias (git -c
// alias.p='push --force' p), a remote's push refspecs or mirror flag, push.default, and an
// included config file that could set any of them.
const GIT_TRICK = /^(alias\..|remote\..+\.(push|mirror)$|push\.default$|include\.path$|includeif\..)/i;
const GIT_TRICK_TEXT = /(^|[\s'"=])(alias\.[\w-]|remote\.\S+\.(push|mirror)\b|push\.default\b|include\.path\b|includeif\.)/i;

// The setting a git command sets that GIT_TRICK names (through -c, --config-env or git config),
// or null. Reading (git config <key> with no value included), listing and unsetting are fine.
function gitSettingTrick(g) {
  for (const kv of g.configs) {
    const k = String(kv).split("=")[0].trim();
    if (GIT_TRICK.test(k)) return k;
  }
  if (g.sub !== "config") return null;
  const ops = operands(g.args, { takesValue: [/^(-f|--file|--blob|--type|--default|--comment|--value|--url)$/] });
  const reads = g.args.some((a) => /^(--get\S*|-l|--list|--unset\S*|--remove-section)$/.test(a)) || /^(get|list|unset|remove-section)$/.test(ops[0] || "") || ops.length === 1;
  return reads ? null : ops.find((o) => GIT_TRICK.test(o)) || null;
}

// git tag that only lists or verifies: no tag name (git tag, git tag --sort=-v:refname), or
// -l/--list, -n, --contains, --no-contains, --points-at, --merged, --no-merged or -v/--verify.
// -d/--delete, and a name with anything else, make or delete a tag. Git takes a prefix of a long
// option; one that fits both kinds is ambiguous, and git stops.
const TAG_LISTS = ["list", "contains", "no-contains", "points-at", "merged", "no-merged", "verify"];
const TAG_VALUED = /^(-[mFu]|--(message|file|local-user|cleanup|sort|format|trailer))$/;
function tagReadOnly(args) {
  let lists = false;
  let names = 0;
  let options = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (options && a === "--") { options = false; continue; }
    if (options && /^--./.test(a)) {
      const name = a.slice(2).split("=")[0].toLowerCase();
      if ("delete".startsWith(name)) return false;
      if (TAG_LISTS.some((o) => o.startsWith(name))) lists = true;
      if (TAG_VALUED.test(a)) i++;
      continue;
    }
    if (options && /^-./.test(a)) {
      // A cluster of short flags: -n takes the rest of the word as its number, -m/-F/-u a value.
      for (let k = 1; k < a.length; k++) {
        const f = a[k];
        if (f === "d") return false;
        if (f === "l" || f === "v" || f === "n") lists = true;
        if (f === "n") break;
        if ("mFu".includes(f)) { if (k === a.length - 1) i++; break; }
      }
      continue;
    }
    names++;
  }
  return lists || names === 0;
}

function gitTrickMessage(setting) {
  return `Changing git aliases or push settings (${setting}) is not allowed during an AutoClaude run. Run git commands by their own names; push, when this run allows it, with a plain \`git push\`.`;
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

// Splits a command line into simple commands, each { words, quoted, redirects, inputs, heredocs,
// pipe }. Separators are ; (not in cmd.exe) & | and newlines, plus ( ) { } so subshells and
// script blocks are looked at too; the bodies of $(...), `...` and <(...) are read as commands of their own. A
// command whose words run straight into a bracket is `open`: more of its arguments are in there
// (PowerShell's (...), @(...) and { }, a bash brace expansion). Quotes group a word and are
// removed; `quoted` tells, word by word, whether one had a quote or an escape. Backslashes stay
// literal (Windows paths), except that bash escapes a space, a quote, a backtick, a dot or a
// slash with one (so `.\.` is `..`, as bash reads it); PowerShell escapes with a backtick and cmd
// with a caret. bash's $"..." is a double-quoted string; its $'...' keeps the `$'` in the word,
// since the escapes in it can spell anything.
// `>`, `>>`, `2>`, `*>` and `&>` make the next word a redirect target, `2>&1` writes nothing, `<`
// names an input file, and a `#` that starts a word starts a comment. Heredoc bodies and
// here-strings are data: they land in `heredocs` ({ delim, quoted, body }), never in the
// commands, except that bash still runs the $(...) and `...` inside an unquoted heredoc. `pipe`
// is true when the command reads the output of the one before it. `sep` is what came before
// the command (null, ";", "&", "&&", "||", "|", a newline or a bracket; && and || outlast a
// newline or a bracket after them), and `scope` names the ( ) and { } groups it sits in, as
// "/" at the top and "/1/", "/1/2/" inside: a variable set in a group may not be set after it.
export function parseCommandLine(cmd, shell = "bash") {
  const s = String(cmd || "");
  const escape = shell === "powershell" ? "`" : shell === "cmd" ? "^" : "\\";
  const bash = shell === "bash";
  const commands = [];
  const nested = [];
  const waiting = []; // heredocs whose body starts at the next newline
  let words = [];
  let marks = []; // `quoted` for each word
  let redirects = [];
  let inputs = [];
  let docs = [];
  let word = null;
  let quoted = false; // the current word had a quote or an escape in it (a quoted heredoc delimiter)
  let pending = null; // "out": the next word is a redirect target; "in": an input; "heredoc": a delimiter; "string": a here-string
  let piped = false;
  let quote = null;
  let sep = null;
  let ended = false; // the last endCommand produced a command
  const groups = [];
  let groupCount = 0;
  const endWord = () => {
    if (word === null) return;
    if (pending === "out") redirects.push(word);
    else if (pending === "in") inputs.push(word);
    else if (pending === "heredoc") {
      const doc = { delim: word.replace(/\\/g, ""), quoted: quoted || word.includes("\\"), body: null };
      waiting.push(doc);
      docs.push(doc);
    } else if (pending === "string") docs.push({ delim: null, quoted: true, body: word });
    else { words.push(word); marks.push(quoted); }
    pending = null;
    word = null;
    quoted = false;
  };
  const endCommand = () => {
    endWord();
    pending = null;
    if (words.length || redirects.length || inputs.length || docs.length) {
      commands.push({ words, quoted: marks, redirects, inputs, heredocs: docs, pipe: piped, sep, scope: `/${groups.map((g) => `${g}/`).join("")}` });
      piped = false;
      ended = true;
    }
    words = [];
    marks = [];
    redirects = [];
    inputs = [];
    docs = [];
  };
  const separator = (kind) => {
    endCommand();
    if (ended || (sep !== "&&" && sep !== "||")) sep = kind;
    ended = false;
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
    if (bash && !quote && c === "$" && (next === "'" || next === '"')) {
      if (next === "'") word = (word ?? "") + "$'";
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
      if (shell !== "bash" || /[\s'"`./]/.test(next)) { word = (word ?? "") + next; quoted = true; i++; continue; }
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
      separator("\n");
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
      if (next === "|") { i++; separator("||"); continue; } // ||: the next command runs on failure, no pipe
      if (next === "&") i++; // |& pipes stderr as well
      separator("|");
      piped = true;
      continue;
    }
    if (c === "&" && next === "&") { i++; separator("&&"); continue; }
    if (c === "(" || c === "{") {
      endCommand();
      if (ended) commands[commands.length - 1].open = true;
      separator(c);
      groups.push(++groupCount);
      continue;
    }
    if (c === ")" || c === "}") { separator(c); groups.pop(); continue; }
    // cmd reads ; , = inside a command as argument delimiters, and they end a redirect's file name:
    // `type nul > PLAN.md;` writes PLAN.md.
    if (shell === "cmd" && (pending === "out" || pending === "in") && word !== null && (c === ";" || c === "," || c === "=")) { endWord(); continue; }
    if ((c === ";" && shell !== "cmd") || c === "&") { separator(c); continue; } // cmd reads ; inside a command
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
// targets earlier on the line in `dirs`: { git: [{ sub, args, dirs, configs }],
// recursive: [{ path, dirs }], writes: [{ path, dirs, tree }], code: [text] }. A write with tree
// set (a delete or a move) also counts when it takes a protected path along with a folder.
// Variables set earlier on the line (d=$(mktemp -d), S=C:/x, $d = Join-Path $env:TEMP x) are
// expanded into later paths; one set from a command's output is unknown (see valueOf), and see
// walk for the ones set conditionally. A recursive delete whose targets the line does not show
// (piped in, from xargs, in brackets, splatted) has the unknown target UNKNOWN_VALUE.
export function shellEffects(cmd, shell = "bash") {
  const out = { git: [], recursive: [], writes: [], code: [] };
  walk(parseCommandLine(cmd, shell), { dirs: [], sdirs: [], vars: new Map(), sure: new Map(), shell }, 0, out);
  for (const m of String(cmd || "").matchAll(DOTNET_WRITERS)) out.writes.push({ path: m[1].trim(), dirs: [], tree: true });
  return out;
}

// A cd whose target is not sure: the paths after it cannot be placed.
const UNKNOWN_DIR = "${cd}";
// A value or a target the guard cannot know. No variable can expand into it or out of it.
const UNKNOWN_VALUE = "${?}";

// Variables and cd: `vars` and `dirs` hold what was set last, which a write is checked against.
// `sure` and `sdirs` keep only what holds whatever ran, for recursive deletes: a value set after
// || is unknown from then on, and one set after &&, in an if/while/until/for/select/case body or
// inside ( ) or { } is unknown once that part of the line ends. So
// `d=/x; [ -d "$d" ] || d=$(mktemp -d); rm -rf "$d"` is not taken for a temp folder.
function walk(commands, ctx, depth, out) {
  let { dirs, sdirs } = ctx;
  const { vars, sure } = ctx;
  const blocks = []; // the bash bodies open here, by number
  let blockCount = 0;
  let chain = 0; // numbers each run of commands joined by && (or a pipe)
  const scoped = []; // sure values that hold only where they were set: { names, cwd, scope, blocks, chain }
  for (const c of commands) {
    if (c.sep !== "&&" && c.sep !== "|") chain++;
    // Shell keywords in front of the command open, switch and close bodies.
    let lead = 0;
    for (; lead < c.words.length; lead++) {
      const k = c.words[lead];
      if (k === "if" || k === "while" || k === "until") blocks.push(++blockCount);
      else if (k === "elif" || k === "else") { blocks.pop(); blocks.push(++blockCount); }
      else if (ENDS.has(k)) blocks.pop();
      else if (!KEYWORDS.has(k)) break;
    }
    const header = ["for", "select", "case"].includes(c.words[lead]);
    if (header) blocks.push(++blockCount);
    const scope = c.scope || "/";
    const bscope = `/${blocks.map((b) => `${b}/`).join("")}`;
    for (let k = scoped.length - 1; k >= 0; k--) {
      const s = scoped[k];
      if (scope.startsWith(s.scope) && bscope.startsWith(s.blocks) && (!s.chain || s.chain === chain)) continue;
      for (const n of s.names) sure.delete(n);
      if (s.cwd) sdirs = [...sdirs, UNKNOWN_DIR];
      scoped.splice(k, 1);
    }
    const partial = scope !== "/" || blocks.length > 0 || c.sep === "&&";
    const hold = (entry) => scoped.push({ names: [], cwd: false, ...entry, scope, blocks: bscope, chain: c.sep === "&&" ? chain : 0 });

    for (const r of c.redirects) out.writes.push({ path: expandVars(r, vars), dirs, tree: false });
    if (header) {
      // for x in ...: the loop sets x.
      const v = /^[A-Za-z_]\w*$/.test(c.words[lead + 1] || "") ? c.words[lead + 1].toLowerCase() : null;
      if (v && c.words[lead] !== "case") { vars.delete(v); sure.delete(v); }
      continue;
    }
    const cw = c.words.slice(lead);
    const how = { paths: true, quoted: (c.quoted || []).slice(lead) };
    const set = assignment(cw, vars, how);
    const names = new Map();
    assignment(cw, names, how);
    if (names.size) {
      if (c.sep === "||") for (const n of names.keys()) sure.delete(n);
      else {
        assignment(cw, sure, how);
        if (partial) hold({ names: [...names.keys()] });
      }
    }
    if (set === true) continue;
    const run = Array.isArray(set) ? set : cw;
    const lw = stripWrappers(run.map((w) => expandVars(w, vars)));
    const words = splitOptions(lw.words);
    if (!words.length) continue;
    const name = commandName(words[0]);
    const args = words.slice(1);
    // The same words with only the sure values in them.
    const ls = stripWrappers(run.map((w) => expandVars(w, sure)));
    const sargs = splitOptions(ls.words).slice(1);
    // env -C and sudo -D run the command somewhere the paths cannot be placed from.
    const here = lw.moved ? [...dirs, UNKNOWN_DIR] : dirs;
    const shere = ls.moved ? [...sdirs, UNKNOWN_DIR] : sdirs;
    const add = (p, tree = false) => out.writes.push({ path: p, dirs: here, tree });
    const nest = (text, sh) => walk(parseCommandLine(text, sh), { dirs, sdirs, vars: new Map(vars), sure: new Map(sure), shell: sh }, depth + 1, out);

    if (CD.has(name)) {
      const d = operands(args)[0];
      if (d && d !== "-") dirs = [...dirs, d];
      const sd = operands(sargs)[0];
      if (sd && sd !== "-") {
        sdirs = [...sdirs, c.sep === "||" ? UNKNOWN_DIR : sd];
        if (c.sep !== "||" && partial) hold({ cwd: true });
      }
    } else if (name === "git") {
      gitEffect(args, here, out);
    } else if (DELETE.has(name)) {
      const cmdStyle = CMD_STYLE.has(name);
      const opts = { takesValue: PS_VALUE, slashSwitches: cmdStyle };
      // PowerShell reads `a, b` and `a,b` as a list of paths (cmd.exe splits at , ; and = too),
      // and @p passes splatted parameters (Recurse among them, perhaps).
      const ps = ctx.shell === "powershell";
      const splat = ps && args.some((a) => a.startsWith("@"));
      const list = ps ? /,/ : ctx.shell === "cmd" ? /[,;=]/ : null;
      const targets = (ts) => (list ? ts.flatMap((t) => t.split(list)).filter(Boolean) : ts);
      const recursive = splat || args.some(isRecursiveFlag) || (cmdStyle && args.some((a) => /^\/\/?s$/i.test(a)));
      for (const t of targets(operands(args, opts))) add(t, true);
      if (recursive) {
        // Targets the line does not show: piped into Remove-Item, added by xargs, in brackets.
        if (splat || c.open || ls.fed || (ps && c.pipe)) out.recursive.push({ path: UNKNOWN_VALUE, dirs: shere });
        for (const t of targets(operands(sargs, opts))) out.recursive.push({ path: t, dirs: shere });
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
      const starts = (list) => {
        const s = [];
        for (const a of list) { if (/^[-(!]/.test(a)) break; s.push(a); }
        return s.length ? s : ["."];
      };
      const deletes = args.includes("-delete") || args.some((a, i) => /^-(exec|execdir|ok)$/.test(a) && DELETE.has(commandName(args[i + 1] || "")));
      const filtered = args.some((a) => /^-(i?name|i?path|i?wholename|i?regex|type|newer|mtime|mmin|size|empty)$/.test(a));
      if (deletes) {
        if (!filtered) for (const t of starts(args)) add(t, true);
        for (const t of starts(sargs)) out.recursive.push({ path: t, dirs: shere, rootOk: filtered });
      }
    } else if (CODE_RUNNERS.has(name)) {
      if (CODE_WRITERS.test(words.join(" "))) out.code.push(words.join(" "));
    } else if (depth < 3) {
      // A shell inside the shell: read the command it runs the same way. PowerShell joins the
      // words after -Command with spaces; cmd /c takes the rest of the line as it was typed.
      // The body is read twice when a variable in it is not sure: once as written with the last
      // values (for writes), once with only the sure ones (for recursive deletes).
      const both = (bodyOf, sh) => {
        const body = bodyOf(args);
        const sbody = bodyOf(sargs);
        if (body) nest(body, sh);
        if (sbody && sbody !== body) nest(sbody, sh);
        return body;
      };
      if (SHELLS.has(name) || name === "eval") {
        const body = both((a) => {
          if (name === "eval") return a.join(" ");
          const k = a.findIndex((x) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(x));
          return k >= 0 ? a[k + 1] : null;
        }, "bash");
        // bash <<EOF ... EOF: the heredoc is the script.
        if (!body && name !== "eval" && !scriptOperand(args)) {
          for (const doc of c.heredocs) if (doc.body) nest(doc.body, "bash");
        }
      } else if (name === "cmd") {
        both((a) => {
          const k = a.findIndex((x) => /^\/\/?[ck]$/i.test(x));
          const rest = k >= 0 ? a.slice(k + 1) : [];
          return rest.length === 1 ? rest[0] : rest.map((x) => (/\s/.test(x) ? `"${x}"` : x)).join(" ");
        }, "cmd");
      } else if (["powershell", "pwsh", "invoke-expression", "iex"].includes(name)) {
        both((a) => {
          if (name.startsWith("i")) return operands(a).join(" ");
          const k = a.findIndex((x) => /^-c(o(m(m(a(n(d)?)?)?)?)?)?$/i.test(x));
          return k >= 0 ? a.slice(k + 1).join(" ") : null;
        }, "powershell");
      }
    }
  }
}

// git [global options] <sub> <args>: the subcommand and where it sits. -C <dir> moves where the
// paths after it resolve; configs holds the name=value of every -c and --config-env.
function gitSub(args) {
  let i = 0;
  const dirs = [];
  const configs = [];
  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (a === "-C") { if (args[i + 1] !== undefined) dirs.push(args[i + 1]); i += 2; }
    else if (a === "-c" || a === "--config-env") { if (args[i + 1] !== undefined) configs.push(args[i + 1]); i += 2; }
    else if (/^(--git-dir|--work-tree|--namespace|--super-prefix)$/.test(a)) i += 2;
    else i++;
  }
  return { sub: String(args[i] || "").toLowerCase(), at: i, dirs, configs };
}

function gitEffect(args, dirs, out) {
  const g = gitSub(args);
  const gdirs = [...dirs, ...g.dirs];
  const rest = args.slice(g.at + 1);
  out.git.push({ sub: g.sub, args: rest, dirs: gdirs, configs: g.configs });
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

// The wrappers' options that take the next word as their value, and the ones that run the
// command in another folder (env -C, sudo -D) or another root (sudo -R).
const WRAPPER_VALUED = {
  sudo: /^(-[ugCDhprtUTR]|--(user|group|close-from|chdir|host|prompt|role|type|other-user|command-timeout|chroot))$/,
  env: /^(-u|--unset|-C|--chdir)$/,
  nice: /^(-n|--adjustment)$/,
  xargs: /^(-[adEILnPs]|--(arg-file|delimiter|eof|replace|max-lines|max-args|max-procs|max-chars|process-slot-var))$/,
  time: /^(-f|--format|-o|--output)$/,
  exec: /^-a$/,
  timeout: /^(-s|-k|--signal|--kill-after)$/
};
const WRAPPER_MOVES = { env: /^(-C|--chdir)(=|$)/, sudo: /^(-D|--chdir|-R|--chroot)(=|$)/ };

// sudo, env, xargs, timeout 30, FOO=bar and friends in front of the real command: { words, fed,
// moved }. An option's value is skipped (sudo -u root, nice -n 5, xargs -n 1), and env -S splits
// its string into the command's words. fed: xargs adds arguments it reads from its input; moved:
// the command runs somewhere else (WRAPPER_MOVES).
function stripWrappers(words) {
  const w = [...words];
  let i = 0;
  let fed = false;
  let moved = false;
  while (i < w.length) {
    if (/^[A-Za-z_]\w*=/.test(w[i])) { i++; continue; }
    const n = commandName(w[i]);
    if (n !== "timeout" && !WRAPPERS.has(n)) break;
    i++;
    if (n === "xargs") fed = true;
    while (i < w.length && w[i].startsWith("-")) {
      const a = w[i++];
      if (WRAPPER_MOVES[n]?.test(a)) moved = true;
      if (n === "env" && /^(-S|--split-string)(=|$)/.test(a)) {
        const v = a.includes("=") ? a.slice(a.indexOf("=") + 1) : w[i++];
        w.splice(i, 0, ...String(v ?? "").split(/\s+/).filter(Boolean));
        break;
      }
      if (WRAPPER_VALUED[n]?.test(a)) i++;
    }
    if (n === "timeout") i++; // the duration
  }
  return { words: w.slice(i), fed, moved };
}

function commandName(word) {
  return String(word).split(/[\\/]/).pop().toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

// ---- Variables set on the line ----------------------------------------------------------------

// A variable assignment. Records the value in `vars` (names in lower case) and returns true when
// nothing runs (NAME=value, $name = "text"), the words that still run for PowerShell's
// `$x = <command>` (a bare word there is a command: $d = Get-Location), or null when the command
// is not a bare assignment (export X=1 is recorded but still runs, since it changes the
// environment of what follows). `quoted` is the parser's, word by word; with `paths` a value the
// guard cannot know as a path is recorded as UNKNOWN_VALUE (see valueOf).
function assignment(words, vars, { paths = false, quoted = [] } = {}) {
  if (!words.length) return null;
  const ps = /^\$([A-Za-z_]\w*)$/.exec(words[0]);
  // PowerShell: one quoted string or one variable is a value; anything else is computed.
  const computed = (ws, q) => ws.length !== 1 || !(q[0] || ws[0].startsWith("$"));
  if (ps && words[1] === "=") {
    const rhs = words.slice(2);
    const made = computed(rhs, quoted.slice(2));
    vars.set(ps[1].toLowerCase(), valueOf(rhs.map((w) => expandVars(w, vars)), { computed: made, paths }));
    return rhs.length > 1 || (made && rhs.length === 1 && !/^[[\d@(+-]/.test(rhs[0])) ? rhs : true;
  }
  const one = /^\$([A-Za-z_]\w*)=(.+)$/.exec(words[0]);
  if (one && words.length === 1) { vars.set(one[1].toLowerCase(), valueOf([expandVars(one[2], vars)], { computed: computed([one[2]], quoted), paths })); return true; }
  const lead = /^(export|local|declare|typeset|readonly)$/.test(words[0]) ? 1 : 0;
  const pairs = words.slice(lead).filter((w) => !/^[-+]/.test(w));
  if (!pairs.length || !pairs.every((w) => /^[A-Za-z_]\w*=/.test(w))) return null;
  for (const w of pairs) {
    const k = w.indexOf("=");
    vars.set(w.slice(0, k).toLowerCase(), valueOf([expandVars(w.slice(k + 1), vars)], { paths }));
  }
  return lead ? null : true;
}

// A value as a path: $(mktemp ...) becomes a path in the temp folder (or the -p folder), and
// PowerShell's GetTempPath() and Join-Path $env:TEMP x become $env:TEMP paths. With `paths`, any
// other value made by a command is UNKNOWN_VALUE: a command substitution ($(...), `...`) and a
// `computed` PowerShell right-hand side (a command, if/switch/try, an expression). So is one that
// names the working folder ($PWD, $(pwd)): the shell fixes it here, and a cd before the delete
// would move where the guard places it.
function valueOf(ws, { computed = false, paths = false } = {}) {
  const v = ws.join(" ");
  const mk = /^(?:\$\(|`)\s*mktemp\b([^)`]*)[)`]$/.exec(v);
  if (mk) return mktempPath(mk[1].trim().split(/\s+/).filter(Boolean).map((a) => a.replace(/^["']|["']$/g, "")));
  if (/^\[(System\.)?IO\.Path\]::GetTempPath$/i.test(v)) return "$env:TEMP";
  let value = v;
  if (/^join-path$/i.test(ws[0] || "")) {
    // PowerShell 7 joins every child path it is given: Join-Path $env:TEMP x ..\..
    const ops = operands(ws.slice(1));
    if (ops.length >= 2) value = ops.join("\\");
    else if (paths) return UNKNOWN_VALUE;
  } else if (paths && computed) {
    return UNKNOWN_VALUE;
  }
  if (paths && /`|\$\(|\$\{?PWD\b/i.test(value)) return UNKNOWN_VALUE;
  return value;
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
const INLINE = { node: /^(-e|-p|--eval|--print|-pe)$/, deno: /^(-e|--eval)$/, bun: /^(-e|--eval|-p|--print)$/, python: /^-[bBdEiIOPqsSuvx]*c$/, python3: /^-[bBdEiIOPqsSuvx]*c$/, py: /^-[bBdEiIOPqsSuvx]*c$/, ruby: /^-[a-zA-Z]*e$/, perl: /^-[a-zA-Z]*[eE]$/, php: /^-r$/, lua: /^-e$/ };
// Code that starts other programs: only then is inline or heredoc code tested as a command, raw
// (a file it only reads is not run). system/exec/spawn count with or without parentheses
// (Perl's and Ruby's `system "ssh ..."`), and Perl, Ruby and PHP also run what is in backticks,
// qx(), %x() or a piped open.
const SPAWNS = /\bsubprocess\b|\bcreate_subprocess_\w+|\bos\.(system|popen|exec\w*|spawn\w*|posix_spawn\w*)\b|\bpty\.spawn\b|\bchild_process\b|\b(execSync|execFileSync|spawnSync|execFile|execa)\b|\bPopen\b|\bProcess\.Start\b|\bStart-Process\b|\bInvoke-Expression\b|\b(shell_exec|passthru|proc_open|popen|system)\s*\(|(?<![.\w$])(system|exec|spawn|popen)\s*[("'`$]|\b(Kernel|Process)\.(system|exec|spawn)\b|\bIO\.popen\b|\bOpen3\b|\bPTY\.spawn\b|\bDeno\.(run|Command)\b|\bBun\.(spawn|\$)/;
const SHELL_OUT = /`[^`]*`|\bqx\s*[^\w\s]|%x\s*[^\w\s]|\bopen\b[^;]*["'][^"']*\|[^"']*["']/;
function startsProcesses(name, code) {
  return SPAWNS.test(code) || (/^(perl|ruby|php)$/.test(name) && SHELL_OUT.test(code));
}
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
    const set = assignment(c.words, vars, { quoted: c.quoted || [] });
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
      if (i >= 0) { push(startsProcesses(name, args[i + 1] || "") ? [rest[0], ...args.slice(0, i + 2)] : [rest[0], ...args.slice(0, i)]); continue; }
      const ops = operands(args, { takesValue: [/^(-W|-X|-r|--require|--import|--loader|--experimental-loader|--input-type|-I)$/] });
      if (args.includes("-m") || (ops.length && ops[0] !== "-")) { push(dropValues(rest)); continue; }
      push([...rest, ...inputs]);
      for (const b of docs) if (startsProcesses(name, b)) out.push({ text: `${rest[0]} ${b}`, via: st.via });
      fed();
      continue;
    }
    if (name === "sed") {
      // GNU sed runs commands too: its scripts are tested then (and an `e command` is read as a
      // command line), the files it reads are not.
      const scripts = sedScripts(args).filter(sedRuns);
      if (scripts.length) {
        push([rest[0], ...scripts]);
        for (const s of scripts) for (const m of s.matchAll(SED_E_TEXT)) deeper(m[1], "bash");
        continue;
      }
    }
    if (name === "git") {
      const g = gitSub(args);
      if (GIT_LOCAL.has(g.sub)) push([rest[0], ...args.slice(0, g.at + 1), ...args.slice(g.at + 1).filter(isRemote)]);
      else push(dropValues(rest, GIT_MESSAGE.has(g.sub)));
      continue;
    }
    if (name === "docker" || name === "podman") {
      const lint = linterRun(args);
      if (!lint) { push(dropValues(rest)); continue; }
      // After the image: the linter's own options and the files it reads, or a command the image
      // runs (shellcheck-alpine and the hadolint *-debian images have a shell). A first word that
      // is not an option, a linter or a file name is that command, and is read like one.
      const [first] = lint.after;
      const command = first !== undefined && !first.startsWith("-") && !LINTER_IMAGE.test(commandName(first)) && !/\.\w+$|(^|[\\/])(Dockerfile|Containerfile)[^\\/]*$/i.test(first);
      push([rest[0], ...lint.keep, ...(command ? [] : lint.after.filter(isRemote))]);
      if (command && st.depth < 4) collectTexts([{ words: lint.after, redirects: [], inputs: [], heredocs: [], pipe: false }], { ...st, depth: st.depth + 1 }, new Map(vars), out);
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

// The scripts a sed command line gives inline: every -e (--expression) value, else the first
// operand. A script from -f is not seen.
function sedScripts(args) {
  const out = [];
  let file = false;
  const ops = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const e = /^-[nErsuz]*e(.*)$/.exec(a) || /^--expression(?:=(.*))?$/.exec(a);
    if (e) { const v = e[1] ? e[1] : args[++i]; if (v !== undefined) out.push(v); continue; }
    if (/^(-[nErsuz]*f|--file)(=|$)/.test(a)) { file = true; if (/^(-[nErsuz]*f|--file)$/.test(a)) i++; continue; }
    if (/^(-l|--line-length)$/.test(a)) { i++; continue; }
    if (a.startsWith("-") && a !== "-") continue;
    ops.push(a);
  }
  if (!out.length && !file && ops.length) out.push(ops[0]);
  return out;
}

// GNU sed's e command (`e cmd` runs cmd, a bare `e` runs the line) and the e flag of s, which
// runs what the substitution produced. An address may come first: 1e, $e, /re/e, 1,3e.
const SED_ADDR = String.raw`(?:(?:\d+|\$|/(?:\\.|[^\\/])*/[IM]*)(?:\s*[,~]\s*\+?(?:\d+|\$|/(?:\\.|[^\\/])*/[IM]*))?)?\s*!?\s*`;
const SED_E = new RegExp(String.raw`(?:^|[;\n{}])\s*${SED_ADDR}e(?=\s|;|}|$)`);
const SED_E_TEXT = new RegExp(String.raw`(?:^|[;\n{}])\s*${SED_ADDR}e[ \t]+([^\n]+)`, "g");
const SED_S_E = new RegExp(String.raw`(?:^|[;\n{}])\s*${SED_ADDR}s(.)(?:\\.|(?!\1)[^\\])*\1(?:\\.|(?!\1)[^\\])*\1[gpiImM0-9]*e`);
function sedRuns(script) {
  return SED_E.test(script) || SED_S_E.test(script);
}

// Read-only in this invocation: a reader, sed without -i or a command it runs, awk that neither
// writes, pipes nor runs anything, find without an action, `command -v`.
function readsOnly(name, args) {
  if (READERS.has(name) || name === "command") return true;
  if (name === "sed") return !args.some((a) => /^(-[a-zA-Z]*i|--in-place)/.test(a)) && !sedScripts(args).some(sedRuns);
  if (["awk", "gawk", "mawk", "nawk"].includes(name)) {
    if (args.some((a) => /^-f/.test(a) || a === "--file")) return false;
    const program = operands(args, { takesValue: [/^-(v|F)$/, /^--(assign|field-separator)$/] })[0];
    return program !== undefined && !/\bsystem\s*\(|\||\bprintf?\b[^;}\n]*>/.test(program);
  }
  if (name === "find") return !args.some((a) => FIND_ACTIONS.test(a));
  return false;
}

// docker run of a linter image with every mount read-only: { keep, after }, the options up to
// the image without the mounts, and the words after the image; null when it is anything else.
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
  return { keep, after: args.slice(i + 1) };
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
// something that cannot be known here (a relative path with no known `from` included). Git
// Bash's /c/... is C:\...; ~, $HOME, $env:USERPROFILE, $PWD and $(pwd) are expanded.
export function resolveTarget(word, from, P = path) {
  const s = splitTarget(word, from, P);
  return s && P.resolve(s.start, s.rest);
}

// resolveTarget in two parts: { start, rest }, the folder the path starts from and the rest as
// written (absolute or not, `..` still in it), or null.
function splitTarget(word, from, P) {
  const known = from !== null && from !== undefined;
  let t = String(word);
  const home = /^(~|\$HOME|\$\{HOME\}|\$env:HOME|\$env:USERPROFILE|%USERPROFILE%)(?=$|[\\/])/i.exec(t);
  const here = /^(\$PWD|\$\{PWD\}|\$\(pwd\)|\$\(Get-Location\))(?=$|[\\/])/i.exec(t);
  if (here && !known) return null;
  const start = home ? os.homedir() : here ? from : null;
  if (start !== null) t = t.slice((home || here)[0].length);
  // Left to the shell: a variable, a command substitution ($(...), `...`, bash's $'...'), %NAME%,
  // ~user, ~+ and ~-, and a PowerShell provider path or a drive named by more than a letter
  // (FileSystem::C:\, HKCU:\, a New-PSDrive name).
  if (/\$[\w{(:']|%\w+%|`|::/.test(t) || (start === null && /^~|^[^\\/:]{2,}:/.test(t))) return null;
  if (start !== null) return { start, rest: `.${t}` };
  if (P === path.win32) {
    const m = /^\/(?:cygdrive\/|mnt\/)?([A-Za-z])(?=\/|$)/.exec(t);
    if (m) t = `${m[1]}:/${t.slice(m[0].length)}`;
  } else if (/^[A-Za-z]:[\\/]|^\\\\/.test(t)) {
    return null; // a Windows path on a POSIX machine
  }
  if (!known && !P.isAbsolute(t)) return null;
  return { start: known ? from : P.resolve(P.parse(t).root), rest: t };
}

// The path as the file system reaches it: each existing folder on the way is resolved through
// links, junctions and 8.3 short names before the next name or `..` is applied, so a link in
// the temp folder that points elsewhere, and `..` after one, land where they really lead. Only a
// path in this machine's own style can be looked up; any other stays as resolveTarget has it.
function physicalTarget(word, from, P) {
  const s = splitTarget(word, from, P);
  if (!s) return null;
  if (P !== path || UNC.test(s.rest) || (!P.isAbsolute(s.rest) && UNC.test(s.start))) return P.resolve(s.start, s.rest);
  const root = P.isAbsolute(s.rest) ? P.parse(s.rest).root : "";
  let cur = root ? P.resolve(root) : real(P, P.resolve(s.start));
  for (const name of s.rest.slice(root.length).split(P.sep === "\\" ? /[\\/]+/ : /\/+/)) {
    if (!name || name === ".") continue;
    if (name === "..") { cur = P.dirname(cur); continue; }
    cur = P.join(cur, name);
    if (!/[*?[]/.test(name)) { try { cur = fs.realpathSync.native(cur); } catch {} }
  }
  return cur;
}

// An absolute path with its deepest existing folder resolved as the file system has it (links,
// junctions, 8.3 short names), and the rest, which does not exist yet, as written. A network
// path is left alone: looking one up can wait on an unreachable server.
const UNC = /^[\\/]{2}/;
function real(P, abs) {
  if (P !== path || UNC.test(abs)) return abs;
  const tail = [];
  for (let d = abs; ; d = P.dirname(d)) {
    try { return P.join(fs.realpathSync.native(d), ...tail.reverse()); } catch {}
    if (P.dirname(d) === d) return abs;
    tail.push(P.basename(d));
  }
}

// $CLAUDE_CONFIG_DIR (and its PowerShell and cmd forms) at the start of a path word, replaced by
// the Claude config folder.
const CONFIG_VAR = /^(?:\$\{CLAUDE_CONFIG_DIR\}|\$CLAUDE_CONFIG_DIR(?!\w)|\$env:CLAUDE_CONFIG_DIR(?!\w)|%CLAUDE_CONFIG_DIR%)/i;
function configWord(word, dir) {
  const w = String(word);
  const m = CONFIG_VAR.exec(w);
  return m ? String(dir) + w.slice(m[0].length) : w;
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
// may not reach the project, nor stand for all or most of the temp folder (see broadGlob).
function inTemp(P, abs, temps, root, same) {
  if (same(abs, root) || contains(P, abs, root)) return false;
  if (/[*?]/.test(abs)) {
    const re = globRegex(P, abs);
    for (let d = root; ; d = P.dirname(d)) {
      if (re.test(d)) return false;
      if (P.dirname(d) === d) break;
    }
  }
  return temps.some((t) => contains(P, t, abs) && !broadGlob(P.relative(t, abs).split(P.sep)[0]));
}

// A first-level name in the temp folder that is a wildcard for most of it: *, *.*, [a-z]*, ??
// and the like, with fewer than three letters or digits of its own (autoclaude-* and *.log are
// narrow enough). Other programs and other sessions keep their files there too.
function broadGlob(name) {
  if (!/[*?[]/.test(name)) return false;
  return name.replace(/\[[^\]]*\]?|[*?]/g, "").replace(/[^A-Za-z0-9]/g, "").length < 3;
}

// A recursive delete's target with a wildcard in a folder name before a `..`, or after a cd to a
// wildcard folder: one of the matches may be a link or junction, and the `..` then leads out of
// wherever it points.
function wildBeforeUp(item) {
  const wild = (w) => /[*?[]/.test(w);
  if (item.dirs.some(wild)) return true;
  const names = String(item.path).split(/[\\/]+/);
  const k = names.findIndex(wild);
  return k >= 0 && names.slice(k + 1).includes("..");
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
// inside a guarded folder (.autoclaude, the pinned tests while they are pinned) counts; a
// wildcard counts when it could match.
function touches(P, root, abs, g, tree, same) {
  const folder = g.dir || g.kind === "runtime";
  const wild = abs.search(/[*?]/);
  if (wild < 0) {
    if (same(abs, g.abs)) return true;
    if (folder && contains(P, g.abs, abs)) return true;
    return !!tree && contains(P, abs, g.abs);
  }
  // A wildcard: the fixed folder in front of it, then the pattern against the guarded path and,
  // for a delete or a move, against every folder between the root and it.
  const fixedDir = P.dirname(abs.slice(0, wild) + "x");
  if (folder && (same(fixedDir, g.abs) || contains(P, g.abs, fixedDir))) return true;
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
  // A broken run-plan override leaves config.plan at the project's own plan: still guard that.
  if (cfg.errors.some((e) => e.path !== RUN_PLAN_ERROR_PATH)) return;
  const reason = decide(input, { root, config: cfg.config, mainPlan: cfg.mainPlan, pinned: await pinnedStep(root, cfg.config, state) });
  if (reason) {
    deny(reason);
    const r = recordDenial(root, { kind: "guard", tool: input.tool_name, detail: JSON.stringify(input.tool_input || {}), reason });
    if (r.notify) {
      await notify({ title: `AutoClaude: ${r.count} denials in the last hour`, message: `The run on ${state.currentStep || "?"} keeps trying things the rules forbid (latest: ${input.tool_name}). It may be stuck. Look at .autoclaude/logs/denials.log.`, priority: "high" }, { logFile: path.join(root, ".autoclaude", "logs", "notify.log"), stdout: { write() { return true; } } });
    }
  }
}

// The current step, when it is a change under pinned tests: { step, dir, pinStep } for decide,
// else null. The plan libraries load only here, during a run, so a session with no run never
// pays for them; anything unreadable leaves the step unpinned (its Accept lines still say the
// pinned tests are unchanged, and the gate checks them).
export async function pinnedStep(root, config, state) {
  if (!state || !state.currentStep) return null;
  try {
    const { parsePlan, stepById } = await import("../lib/plan.js");
    const { isPinnedStep, CHARACTERIZATION_DIR } = await import("../lib/fixplan.js");
    const step = stepById(parsePlan(fs.readFileSync(path.join(root, config.plan), "utf8")), state.currentStep);
    if (!step || !isPinnedStep(step)) return null;
    return { step: step.id, dir: CHARACTERIZATION_DIR, pinStep: step.depends[0] || null };
  } catch {
    return null;
  }
}

// fileURLToPath, not URL.pathname: a plugin path with a space or a tilde is percent-encoded in
// the URL, and the comparison would silently fail and leave the guard off.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch {}
}
