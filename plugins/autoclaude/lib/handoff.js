// The hand-back (PLAN.md P8.5, D49): HANDOFF.md in the project root, written at plan completion
// for the owner in plain language. What was built (with commits), what is left for the owner
// with exact commands, secrets the run created (names only, never values), open findings,
// decisions to review, the run's own decisions, the push state and what the run left on this
// computer. The counts come from lib/summary.js, so the completion alert says the same thing.
// Synchronous on purpose, like the other file writers the gate uses. Node built-ins only.
import path from "node:path";
import { spawnSync } from "node:child_process";
import { writeFileAtomic } from "./fsatomic.js";
import { MARKERS } from "./plan.js";
import { collectHandback, pushLine } from "./summary.js";

export const HANDOFF_FILE = "HANDOFF.md";

// Runs git synchronously; { ok, stdout }. Never throws.
function gitSync(root, args, env) {
  try {
    const r = spawnSync("git", args, { cwd: root, env, encoding: "utf8", windowsHide: true, timeout: 30000 });
    return { ok: r.status === 0, stdout: String(r.stdout || "") };
  } catch {
    return { ok: false, stdout: "" };
  }
}

// The run's commits, newest first: [{ sha, subject }]. From the run's start commit when known.
function runCommits(root, base, env) {
  const args = ["log", "--format=%H%x09%s", base ? `${base}..HEAD` : "-n300"];
  const r = gitSync(root, args, env);
  if (!r.ok) return [];
  return r.stdout.split(/\r?\n/).filter(Boolean).map((line) => {
    const i = line.indexOf("\t");
    return i < 0 ? { sha: line, subject: "" } : { sha: line.slice(0, i), subject: line.slice(i + 1) };
  });
}

// Step id -> short commit ids, oldest first, from gate subjects such as "autoclaude(S1.2): Title"
// or "autoclaude(S1.1, S1.2): ..." (a resume committing several at once).
export function commitsByStep(commits) {
  const map = new Map();
  for (const c of [...commits].reverse()) {
    const m = String(c.subject || "").match(/^autoclaude\(([^)]*)\)/);
    if (!m) continue;
    for (const id of m[1].split(/\s*,\s*/).filter(Boolean)) {
      if (!map.has(id)) map.set(id, []);
      map.get(id).push(String(c.sha).slice(0, 7));
    }
  }
  return map;
}

const STATUS_WORDS = {
  [MARKERS.done]: "verified",
  [MARKERS.todo]: "not built",
  [MARKERS.failed]: "failed",
  [MARKERS.blocked]: "blocked",
  "~": "built, not verified yet"
};

function builtSummary(parsed, byStep) {
  const phases = [];
  const loose = [];
  const stepOf = (s) => ({ id: s.id, title: s.title, marker: s.marker, status: STATUS_WORDS[s.marker] || `marker [${s.marker}]`, commits: byStep.get(s.id) || [] });
  for (const ph of parsed.phases || []) phases.push({ num: ph.num, title: ph.title, steps: ph.steps.map(stepOf) });
  for (const s of parsed.steps || []) if (!s.phase) loose.push(stepOf(s));
  const all = [...phases.flatMap((p) => p.steps), ...loose];
  return {
    done: all.filter((s) => s.marker === MARKERS.done).length,
    built: all.filter((s) => s.marker === "~").length,
    total: all.length,
    phases,
    loose
  };
}

function fmtWhen(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtDuration(ms) {
  if (!(ms >= 0)) return null;
  const min = Math.round(ms / 60000);
  if (min < 90) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const code = (s) => "`" + String(s).replace(/`/g, "'") + "`";
const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();

// Docker commands the owner can copy, by what the item is. Names first: they read better.
function dockerRemoveCommand(item) {
  const ref = item.name && item.kind !== "network" ? item.name.split(",")[0] : item.id;
  if (item.kind === "container") return `docker rm -f ${ref}`;
  if (item.kind === "volume") return `docker volume rm ${ref}`;
  return `docker network rm ${item.name || item.id}`;
}

function describeDocker(item) {
  // Anonymous volumes are named by a 64-hex id; 12 characters identify one, as `docker` shows it.
  const raw = item.name ? item.name.split(",")[0] : String(item.id);
  const name = /^[0-9a-f]{64}$/.test(raw) ? raw.slice(0, 12) : raw;
  const extra = item.kind === "container" && item.image ? ` (image ${item.image})` : "";
  return `${item.kind} ${code(name)}${extra}`;
}

// Secret files that are in git already. The gate never stages secrets/ (git.commitAll), so one
// here was committed some other way, and may have been pushed with the run branch.
function tracked(root, files, env) {
  if (!files.length) return [];
  const r = gitSync(root, ["ls-files", "--", ...files], env);
  if (!r.ok) return [];
  const inGit = new Set(r.stdout.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, "/")).filter(Boolean));
  return files.filter((f) => inGit.has(f));
}

// Which secret files git would pick up: a secrets/ folder that is not ignored is a leak waiting
// for the owner's next `git add -A`. Returns the paths git does not ignore; [] when git cannot tell.
function notIgnored(root, files, env) {
  if (!files.length) return [];
  const r = gitSync(root, ["check-ignore", "--no-index", "--", ...files], env);
  if (!r.ok && r.stdout.trim() === "") {
    // Exit 1 with no output means none of them is ignored; any other failure means unknown.
    const probe = gitSync(root, ["rev-parse", "--is-inside-work-tree"], env);
    return probe.ok ? [...files] : [];
  }
  const ignored = new Set(r.stdout.split(/\r?\n/).map((l) => l.trim().replace(/\\/g, "/")).filter(Boolean));
  return files.filter((f) => !ignored.has(f));
}

// Writes HANDOFF.md and returns { path, summary } with summary = { built, ownerItems,
// secretsCreated, openFindings, ownerReviewDecisions, runDecisions, push, footprint }.
// runDecisions is a count. A write failure comes back as { path: null, summary, error }.
export function writeHandoff({ root, config, state, parsed, footprint = null, now = new Date(), env = process.env, commits = null }) {
  const st = state || {};
  const got = collectHandback({ root, config, state: st, parsed });
  const log = Array.isArray(commits) ? commits : runCommits(root, st.baseCommit || null, env);
  const built = builtSummary(parsed, commitsByStep(log));
  const secretsCreated = footprint && Array.isArray(footprint.secretsCreated) ? footprint.secretsCreated : [];
  const summary = {
    built,
    ownerItems: got.ownerItems,
    secretsCreated,
    openFindings: got.openFindings,
    ownerReviewDecisions: got.ownerReviewDecisions,
    runDecisions: got.runDecisions.length,
    push: st.pushState || null,
    footprint: footprint || null
  };
  const branchRes = gitSync(root, ["rev-parse", "--abbrev-ref", "HEAD"], env);
  const branch = (st.pushState && st.pushState.branch) || (branchRes.ok ? branchRes.stdout.trim() : "") || null;
  const committed = tracked(root, secretsCreated, env);
  const exposed = notIgnored(root, secretsCreated, env).filter((f) => !committed.includes(f));
  const text = renderHandoff({ config, state: st, parsed, got, summary, branch, exposed, committed, now });
  const file = path.join(root, HANDOFF_FILE);
  try {
    writeFileAtomic(file, text);
  } catch (e) {
    return { path: null, summary, error: String(e && e.message ? e.message : e) };
  }
  return { path: file, summary };
}

export function renderHandoff({ config, state, parsed, got, summary, branch, exposed = [], committed = [], now = new Date() }) {
  const L = [];
  const b = summary.built;
  const title = parsed.title ? parsed.title.replace(/\s+plan\s*$/i, "").trim() || parsed.title : "this plan";
  const started = state.startedAt ? Date.parse(state.startedAt) : NaN;
  const took = Number.isFinite(started) ? fmtDuration(now.getTime() - started) : null;
  const base = state.baseCommit ? String(state.baseCommit).slice(0, 7) : null;
  const fp = summary.footprint;

  L.push(`# Hand-back: ${title}`, "");
  L.push(`AutoClaude finished this run on ${fmtWhen(now)}${took ? ` after ${took}` : ""}. ${b.done} of ${b.total} steps are verified${b.built ? ` and ${b.built} are built but not verified yet` : ""}${branch ? `, on the branch ${code(branch)}` : ""}. This file is what the run hands back: what is left for you, what to look at before you merge, and what it left on this computer. It is rewritten at the end of every run.`, "");

  L.push("## At a glance", "");
  L.push(`- Built: ${b.done} of ${b.total} steps verified, in ${plural(b.phases.length, "feature")}.`);
  L.push(`- Left for you: ${summary.ownerItems.length ? plural(summary.ownerItems.length, "item") : "nothing"}.`);
  if (summary.secretsCreated.length) {
    const warn = [committed.length ? `${committed.length} COMMITTED to git` : null, exposed.length ? `${exposed.length} NOT ignored by git` : null].filter(Boolean).join(", ");
    L.push(`- Secrets the run created: ${plural(summary.secretsCreated.length, "file")} in ${code("secrets/")}${warn ? ` (${warn})` : ""}.`);
  }
  L.push(`- Decisions for you to review: ${summary.ownerReviewDecisions.length || "none"}.`);
  const sec = summary.openFindings.filter((f) => f.source === "security").length;
  L.push(`- Open findings: ${summary.openFindings.length ? `${summary.openFindings.length} (${[sec ? plural(sec, "security finding") : null, summary.openFindings.length - sec ? plural(summary.openFindings.length - sec, "follow-up") : null].filter(Boolean).join(", ")})` : "none"}.`);
  L.push(`- Decisions the run made: ${summary.runDecisions}.`);
  L.push(`- ${pushLine(summary.push, config)}`);
  L.push(`- This computer: ${footprintSummary(fp)}.`, "");

  // What the owner has to do comes first.
  L.push("## Left for you", "");
  const afterRun = got.afterRun ? stripIntro(got.afterRun) : "";
  const planItems = summary.ownerItems.filter((i) => i.from === "plan");
  if (planItems.length) {
    L.push(`From the plan's "After the run" section (${config.plan}):`, "", afterRun, "");
  }
  if (got.leftRows.length) {
    L.push("Handed to you by the run (rows whose status says they are left for the owner):", "");
    for (const r of got.leftRows) L.push(`- ${flat(r.text)}. Status: ${flat(r.status)}. (${r.file})`);
    L.push("");
  }
  if (!planItems.length && !got.leftRows.length) L.push("Nothing. The plan lists nothing for after the run, and the run left nothing for you.", "");

  L.push("## Push", "");
  L.push(pushLine(summary.push, config), "");
  const ps = summary.push;
  const remote = (ps && ps.remote) || "origin";
  if (ps && !ps.ok && !ps.skipped) {
    const tags = Array.isArray(ps.unpushedTags) ? ps.unpushedTags : [];
    L.push("To push what is missing, from the project folder:", "", "```");
    L.push(`git push ${remote} ${ps.branch || branch || "<run branch>"}`);
    if (tags.length) L.push(`git push ${remote} ${tags.join(" ")}`);
    L.push("```", "");
  } else if (!ps && branch) {
    L.push(`To put the run branch on your remote after your review: ${code(`git push -u ${remote} ${branch}`)}.`, "");
  }

  if (summary.secretsCreated.length) {
    L.push("## Secrets the run created", "");
    L.push("The run generated these files for what it set up. Their values are not repeated here or anywhere else; open the files on this computer when you need them, and keep them out of git.", "");
    for (const f of summary.secretsCreated) {
      const warn = committed.includes(f)
        ? " - WARNING: this file is in git (the run never commits secrets/, so it got there another way). Treat the secret as exposed: change it where it is used, and take the file out of the branch before you push or merge."
        : exposed.includes(f) ? " - WARNING: git does not ignore this file, so the next `git add -A` commits it. Add `secrets/` to `.gitignore` first." : "";
      L.push(`- ${code(f)}${warn}`);
    }
    L.push("");
  }

  L.push("## Decisions for you to review", "");
  if (summary.ownerReviewDecisions.length) {
    L.push(`These are marked "Owner review: yes" in ${config.docs.decisions}: each accepts a risk the run could not rule out. Look at them before you merge.`, "");
    for (const d of summary.ownerReviewDecisions) {
      const f = d.fields || {};
      const bits = [f.choice && `Choice: ${flat(f.choice)}`, f.why && `Why: ${flat(f.why)}`, f["reverse by"] && `Reverse by: ${flat(f["reverse by"])}`, f.by && `By: ${flat(f.by)}`].filter(Boolean);
      L.push(`- **${d.id}**${d.date || d.step ? ` (${[d.date, d.step].filter(Boolean).join(", ")})` : ""} ${flat(d.title)}${bits.length ? `. ${bits.join(". ")}` : ""}`);
    }
  } else {
    L.push("None.");
  }
  L.push("");

  L.push("## Open findings", "");
  if (summary.openFindings.length) {
    L.push("Rows still open in the findings files, most severe first. Close one by changing its status there.", "");
    for (const f of summary.openFindings) L.push(`- ${f.source === "security" ? "Security" : "Follow-up"}${f.date ? ` (${f.date})` : ""}: ${flat(f.text)}${f.fix ? `. Fix: ${flat(f.fix)}` : ""}. Status: ${flat(f.status) || "open"}. (${f.file})`);
  } else {
    L.push("None.");
  }
  L.push("");

  L.push("## What was built", "");
  for (const ph of b.phases) {
    L.push(`### Phase ${ph.num}: ${ph.title}`, "");
    for (const s of ph.steps) L.push(stepLine(s));
    L.push("");
  }
  if (b.loose.length) {
    L.push("### Steps outside a phase", "");
    for (const s of b.loose) L.push(stepLine(s));
    L.push("");
  }
  if (base && branch) L.push(`Every commit of this run: ${code(`git log --oneline ${base}..${branch}`)}. The whole change: ${code(`git diff --stat ${base}..${branch}`)}.`, "");

  L.push("## What the run left on this computer", "");
  L.push(...footprintSection(fp), "");

  L.push("## Decisions the run made", "");
  if (got.runDecisions.length) {
    L.push(`${plural(got.runDecisions.length, "decision")} logged during the run, in ${config.docs.decisions}:`, "");
    const shown = got.runDecisions.slice(0, 50);
    for (const d of shown) L.push(`- ${d.id}${d.step ? ` (${d.step}${d.fields && d.fields.by ? `, by ${flat(d.fields.by)}` : ""})` : ""} ${flat(d.title)}`);
    if (got.runDecisions.length > shown.length) L.push(`- ... and ${got.runDecisions.length - shown.length} more in ${config.docs.decisions}`);
  } else {
    L.push("None: everything the run needed was settled in the plan.");
  }
  L.push("");

  L.push("## Before you merge", "");
  L.push("1. Do what \"Left for you\" lists, and look at the decisions for your review.");
  L.push(`2. Read the commits${base && branch ? ` (${code(`git log --oneline ${base}..${branch}`)})` : ""} and try the result yourself.`);
  L.push(`3. Merge ${branch ? code(branch) : "the run branch"} the way you normally do.`);
  return L.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function stepLine(s) {
  const commits = s.commits.length ? `, ${s.commits.length === 1 ? "commit" : "commits"} ${s.commits.join(", ")}` : "";
  return `- ${s.id} ${flat(s.title)}: ${s.status}${commits}`;
}

// The section minus the template's opening paragraph: from the first list item on, when there is
// one, so only the owner's actual list and its commands are copied.
function stripIntro(section) {
  const lines = section.split("\n");
  const first = lines.findIndex((l) => /^(?:[-*+]|\d+[.)])[ \t]+/.test(l));
  return (first > 0 ? lines.slice(first) : lines).join("\n").trim();
}

function footprintSummary(fp) {
  if (!fp) return "not checked";
  const bits = [];
  if (fp.removed && fp.removed.length) bits.push(`removed ${fp.removed.length} unused Docker ${fp.removed.length === 1 ? "object" : "objects"} the run created`);
  if (fp.runningCreated && fp.runningCreated.length) bits.push(`${plural(fp.runningCreated.length, "container")} the run started still running`);
  if (fp.kept && fp.kept.length) bits.push(`kept ${fp.kept.length}`);
  if (fp.errors && fp.errors.length) bits.push(plural(fp.errors.length, "problem"));
  if (bits.length) return bits.join(", ");
  return fp.dockerChecked === false ? "Docker not checked (not installed or not running)" : "nothing left behind in Docker";
}

function footprintSection(fp) {
  const out = [];
  if (!fp) return ["Not checked: the run did not record its footprint."];
  if (fp.dockerChecked === false && !(fp.errors && fp.errors.length)) out.push("Docker was not checked: it is not installed here, or it was not running when the run ended.", "");
  if (fp.runningCreated && fp.runningCreated.length) {
    out.push("Still running, started by the run. They were left alone because the plan may have wanted them running. If one is not wanted, the command next to it stops and removes it:", "");
    for (const c of fp.runningCreated) out.push(`- ${describeDocker(c)}, ${c.state || "running"}: ${code(dockerRemoveCommand(c))}`);
    out.push("");
  }
  if (fp.kept && fp.kept.length) {
    out.push("Created by the run and kept:", "");
    for (const k of fp.kept) out.push(`- ${describeDocker(k)}: ${flat(k.reason || "kept")}. To remove it: ${code(dockerRemoveCommand(k))}`);
    out.push("");
  }
  if (fp.removed && fp.removed.length) {
    out.push("Removed: unused things the run created.", "");
    for (const r of fp.removed) out.push(`- ${describeDocker(r)}`);
    out.push("");
  }
  if (fp.goneSinceStart && fp.goneSinceStart.length) {
    out.push("Gone since the run started (they existed before it; the run or something else removed them):", "");
    for (const g of fp.goneSinceStart) out.push(`- ${describeDocker(g)}`);
    out.push("");
  }
  if (fp.errors && fp.errors.length) {
    out.push("Problems while checking:", "");
    for (const e of fp.errors) out.push(`- ${flat(e)}`);
    out.push("");
  }
  if (!out.length) out.push("Nothing: the run left no Docker containers, volumes or networks behind.");
  return out;
}
