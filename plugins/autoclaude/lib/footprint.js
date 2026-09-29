// The run's machine footprint (PLAN.md P8.5, D49). At run start the Docker containers, volumes
// and networks on this computer, the engine that holds them, and the files in the project's
// secrets/ folder are recorded; at plan completion the run removes the unused Docker objects it
// created (stopped containers, volumes no container uses, networks with no containers) and
// reports the rest. A container the run created that is still running is only reported: it may
// be the thing the plan wanted running. The DB rehearsal leaked 33 Docker volumes, which is why
// this exists.
//
// "Created by the run" takes three proofs, never time alone: the object is not in the start
// record, Docker dates its creation after the start, and something ties it to this project (see
// "Attribution" below). A new object nothing ties to the project may be another project's or the
// owner's, so it is only reported (`unattributed`). Nothing that existed at the start is ever
// removed, and nothing at all when the engine that answers at the end is not the one recorded at
// the start.
//
// Docker is reached through the `docker` CLI with --format output. Nothing here throws: Docker
// not installed (or its engine not running) gives an empty report. `run` is an injectable
// command runner, run(command, { timeoutMs }) -> { code, stdout, stderr }, so tests never touch
// Docker. Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { projectPaths } from "./paths.js";
import { readJson, readText, writeJsonAtomic } from "./fsatomic.js";
import { runCommand } from "./proc.js";

export const START_FILE = "footprint-start.json";
export const END_FILE = "footprint-end.json";
export const SEEN_FILE = "footprint-seen.json";
export const SECRETS_DIR = "secrets";
const DOCKER_TIMEOUT_MS = 60000;
// Docker Desktop's Resource Saver stops an idle engine after 5 minutes. `docker version` is then
// answered from a cache, and the first call that needs the engine (listing containers) waits for
// a cold start, measured at 86 to 107 s. That one call gets this long.
export const ENGINE_WAIT_MS = 240000;
// A note between start and end is best effort and runs inside the Stop hook: every call is short.
export const NOTE_TIMEOUT_MS = 20000;
// Ids per inspect command, well under cmd.exe's 8191-character line.
const INSPECT_BATCH = 40;
// Docker ids are hex; names follow Docker's own rule. Anything else is never put in a command.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
// Only these container states are "stopped"; running, restarting and paused are left alone.
const STOPPED = new Set(["exited", "created", "dead"]);
const KINDS = ["containers", "volumes", "networks"];
const LABEL = {
  project: "com.docker.compose.project",
  workingDir: "com.docker.compose.project.working_dir",
  configFiles: "com.docker.compose.project.config_files"
};
const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];
// Docker's own networks, by its own rule (IsPreDefinedNetwork, which `docker network ls --filter
// type=builtin` applies): bridge, host and none on a Linux engine, nat and none on a Windows one.
// Docker makes them itself, and makes the default one again with a new id at every engine start (a
// Resource Saver wake is one), so they are never compared, noted, reported or removed. An engine
// that does not say its OS gets both lists. A swarm's ingress network is left out the same way,
// by the Ingress flag its inspect carries.
const PREDEFINED_NETWORKS = { linux: ["bridge", "host", "none"], windows: ["nat", "none"] };

function predefinedNetwork(name, os) {
  const list = PREDEFINED_NETWORKS[String(os || "").toLowerCase()] || [...PREDEFINED_NETWORKS.linux, ...PREDEFINED_NETWORKS.windows];
  return list.includes(String(name || ""));
}

export function startFile(root) {
  return path.join(projectPaths(root).runtimeDir, START_FILE);
}

export function endFile(root) {
  return path.join(projectPaths(root).runtimeDir, END_FILE);
}

export function seenFile(root) {
  return path.join(projectPaths(root).runtimeDir, SEEN_FILE);
}

// The default runner: the shell command through lib/proc.js, bounded, never rejecting.
export function defaultRunner(root) {
  return async (command, { timeoutMs = DOCKER_TIMEOUT_MS } = {}) => {
    try {
      const r = await runCommand(command, { cwd: root, timeoutMs });
      return { code: r.timedOut ? null : r.code, stdout: r.stdout, stderr: r.timedOut ? `timed out after ${Math.round(timeoutMs / 1000)} s` : r.stderr };
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e && e.message ? e.message : e) };
    }
  };
}

// One docker call, bounded by its own limit and by the caller's deadline (epoch ms), if any.
async function exec(run, command, { timeoutMs = DOCKER_TIMEOUT_MS, deadline = null } = {}) {
  const left = deadline ? deadline - Date.now() : Infinity;
  if (left < 1000) return { ok: false, stdout: "", stderr: "no time was left for it" };
  try {
    const r = await run(command, { timeoutMs: Math.min(timeoutMs, left) });
    return { ok: !!r && r.code === 0, stdout: String((r && r.stdout) || ""), stderr: String((r && r.stderr) || "").trim() };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e && e.message ? e.message : e) };
  }
}

const line1 = (text) => String(text || "").split(/\r?\n/)[0] || "no output";

function jsonLines(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith("{")) continue;
    try { out.push(JSON.parse(t)); } catch {}
  }
  return out;
}

function plainLines(text) {
  return String(text || "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

// "running", "exited", ... from State, or from Status on a Docker too old to print State.
function containerState(c) {
  const s = String(c.State || "").trim().toLowerCase();
  if (s) return s;
  const status = String(c.Status || "").trim();
  if (/^up\b/i.test(status)) return /\(paused\)/i.test(status) ? "paused" : "running";
  if (/^exited\b/i.test(status)) return "exited";
  if (/^created\b/i.test(status)) return "created";
  if (/^dead\b/i.test(status)) return "dead";
  if (/^restarting\b/i.test(status)) return "restarting";
  return "unknown";
}

function containersOf(stdout) {
  return jsonLines(stdout).map((x) => ({ id: String(x.ID || ""), name: String(x.Names || ""), image: String(x.Image || ""), state: containerState(x), status: String(x.Status || "") })).filter((x) => x.id);
}

// The engine that answers: { id, name, os, context, time } from `docker info`, or null. `time` is
// the engine's own clock, which bounds the event reads (the computer's clock may differ from it).
function engineOf(info, ctx) {
  if (!info.ok) return null;
  const i = jsonLines(info.stdout)[0];
  if (!i || !i.ID) return null;
  return { id: String(i.ID), name: String(i.Name || ""), os: String(i.OSType || ""), context: ctx && ctx.ok ? plainLines(ctx.stdout)[0] || null : null, time: i.SystemTime ? String(i.SystemTime) : null };
}

const engineLabel = (e) => `${e.name || e.id.slice(0, 12)}${e.context ? `, context ${e.context}` : ""}`;

// Whether the start record and now talk to the same Docker engine. A `docker context use`, a
// DOCKER_HOST, or Docker Desktop's Linux/Windows switch can point the end at another engine, where
// every object would look new.
function engineMatch(start, now, nowError = null) {
  if (!start || !start.id) return { same: false, why: "the run-start record does not say which Docker engine it was taken on" };
  if (!now || !now.id) return { same: false, why: `Docker did not say which engine answers now${nowError ? ` (${nowError})` : ""}` };
  const differs = start.id !== now.id || (start.name && now.name && start.name !== now.name) || (start.os && now.os && start.os !== now.os);
  return differs ? { same: false, why: `Docker now answers from another engine (${engineLabel(now)}) than at run start (${engineLabel(start)})` } : { same: true };
}

// { available, version, engine, listed, containers, volumes, networks, error }. Unavailable when
// the CLI is missing or its engine does not answer; the lists are then empty. `wait` bounds the
// container listing, the first call that needs the engine itself; every other call gets 60 s.
// `listed` says per kind whether its list is complete: a kind that is not is never compared.
export async function dockerSnapshot(run, { wait = ENGINE_WAIT_MS, deadline = null } = {}) {
  const o = { deadline };
  const v = await exec(run, 'docker version --format "{{.Server.Version}}"', o);
  if (!v.ok) return { available: false, version: null, engine: null, containers: [], volumes: [], networks: [], error: (v.stderr || "docker did not answer").split(/\r?\n/)[0].slice(0, 300) };
  const c = await exec(run, 'docker ps -a --no-trunc --format "{{json .}}"', { timeoutMs: wait, deadline });
  const info = await exec(run, 'docker info --format "{{json .}}"', o);
  const vol = await exec(run, 'docker volume ls --format "{{json .}}"', o);
  const net = await exec(run, 'docker network ls --no-trunc --format "{{json .}}"', o);
  const ctx = await exec(run, "docker context show", o);
  const failed = [[c, "containers"], [vol, "volumes"], [net, "networks"]].filter(([r]) => !r.ok).map(([r, what]) => `could not list ${what}: ${line1(r.stderr)}`);
  const engine = engineOf(info, ctx);
  return {
    available: true,
    version: plainLines(v.stdout)[0] || null,
    engine,
    engineError: engine ? null : info.ok ? "it did not give an engine id" : line1(info.stderr),
    listed: { containers: c.ok, volumes: vol.ok, networks: net.ok },
    containers: containersOf(c.stdout),
    volumes: jsonLines(vol.stdout).map((x) => ({ name: String(x.Name || ""), driver: String(x.Driver || "") })).filter((x) => x.name),
    networks: jsonLines(net.stdout).map((x) => ({ id: String(x.ID || ""), name: String(x.Name || ""), driver: String(x.Driver || "") })).filter((x) => x.id),
    error: failed.length ? failed.join("; ") : null
  };
}

// Files under <root>/secrets, as project-relative paths with forward slashes. Names only.
export function listSecrets(root) {
  const base = path.join(root, SECRETS_DIR);
  const out = [];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else out.push(path.relative(root, full).replace(/\\/g, "/"));
    }
  };
  walk(base);
  return out.sort();
}

// Writes .autoclaude/footprint-start.json and returns the record. Never throws.
export async function recordFootprintStart(root, { run = null, now = () => new Date(), wait = ENGINE_WAIT_MS } = {}) {
  // A record or notes left by an earlier run must never stand in for this run's: they go before
  // the snapshot, which can take minutes on a cold engine.
  for (const f of [startFile(root), seenFile(root)]) { try { fs.rmSync(f, { force: true }); } catch {} }
  const runner = run || defaultRunner(root);
  let docker;
  try { docker = await dockerSnapshot(runner, { wait }); } catch (e) { docker = { available: false, version: null, engine: null, containers: [], volumes: [], networks: [], error: String(e && e.message ? e.message : e) }; }
  const record = { at: now().toISOString(), docker, secrets: listSecrets(root) };
  try { writeJsonAtomic(startFile(root), record); } catch (e) { record.writeError = String(e && e.message ? e.message : e); }
  return record;
}

// ---------------------------------------------------------------------------------------------
// Attribution: what ties a Docker object to this project, strongest first.
// - A container's compose folder (com.docker.compose.project.working_dir, or its compose files)
//   inside the project folder. A compose folder outside it rules the container out, whatever
//   else it carries.
// - A container's bind mount from inside the project folder.
// - A compose project name (com.docker.compose.project) that is this project's: named by the
//   project's own compose file or .env, derived from the folder name when the project has a
//   compose file, or learned from a container tied by its folder. A name that a container from
//   another folder also carries is contested and ties nothing.
// - A volume or network used by a tied container (seen now, by an earlier note, or in Docker's
//   recent events), or carrying one of the project's compose names.
// - A volume's tie is to the one volume it saw (Docker's CreatedAt and labels), never to its name
//   alone: a volume made later under a name the run used, by another project or the owner, is
//   another volume.

// A folder as Docker may report it (C:\x, C:/x, /mnt/c/x from WSL, /run/desktop/mnt/host/c/x or
// /host_mnt/c/x from Docker Desktop) in one spelling, compared without case on Windows and macOS.
export function hostPath(p, platform = process.platform) {
  let s = String(p || "").trim().replace(/\\/g, "/");
  if (!s) return null;
  const drive = s.match(/^\/(?:mnt|run\/desktop\/mnt\/host|host_mnt)\/([A-Za-z])(\/.*)?$/);
  if (drive) s = `${drive[1]}:${drive[2] || "/"}`;
  else if (s.startsWith("/host_mnt/")) s = s.slice("/host_mnt".length);
  if (!/^[A-Za-z]:\/$/.test(s) && s !== "/") s = s.replace(/\/+$/, "");
  return platform === "win32" || platform === "darwin" ? s.toLowerCase() : s;
}

// Compose's own rule for a project name: lower case, only a-z 0-9 _ -, no leading _ or -.
export function composeName(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9_-]+/g, "").replace(/^[_-]+/, "");
}

// { roots, names, platform }: the project folder in every spelling Docker may report it, and the
// compose project names the project itself declares.
export function projectIdentity(root, { platform = process.platform } = {}) {
  const abs = path.resolve(root);
  let real = abs;
  try { real = fs.realpathSync.native(abs); } catch {}
  const roots = [...new Set([abs, real].map((p) => hostPath(p, platform)).filter(Boolean))];
  const names = new Set();
  const read = (f) => { try { return readText(path.join(abs, f), null); } catch { return null; } };
  let hasCompose = false;
  for (const f of COMPOSE_FILES) {
    const text = read(f);
    if (text === null) continue;
    hasCompose = true;
    const m = text.match(/^name:[ \t]*["']?([^"'\s#]+)/m);
    if (m && !m[1].includes("$")) names.add(composeName(m[1]));
  }
  // Without a compose file of its own, a folder name proves nothing: another folder may share it.
  if (hasCompose) for (const p of [abs, real]) names.add(composeName(path.basename(p)));
  const env = read(".env");
  const m = env && env.match(/^[ \t]*COMPOSE_PROJECT_NAME[ \t]*=[ \t]*["']?([^"'\s#]+)/m);
  if (m && !m[1].includes("$")) names.add(composeName(m[1]));
  names.delete("");
  return { roots, names, platform };
}

// Whether a path Docker reports lies in the project folder (or is it).
export function insideProject(p, identity) {
  const inRoots = (h) => !!h && identity.roots.some((r) => h === r || h.startsWith(r.endsWith("/") ? r : `${r}/`));
  if (inRoots(hostPath(p, identity.platform))) return true;
  // The same folder by another name on this computer (an 8.3 short name, a link).
  try { return fs.existsSync(p) && inRoots(hostPath(fs.realpathSync.native(p), identity.platform)); } catch { return false; }
}

// One container from its labels and bind-mount sources: { tied, why, project, outside }. tied is
// null when neither its folder nor its mounts decide; its compose project name may still do.
function judgeContainer(labels, binds, identity) {
  const project = labels[LABEL.project] ? String(labels[LABEL.project]) : null;
  const wd = labels[LABEL.workingDir] ? String(labels[LABEL.workingDir]) : "";
  const files = String(labels[LABEL.configFiles] || "").split(",").map((f) => f.trim()).filter(Boolean);
  if (wd || files.length) {
    const where = wd || files[0];
    const inside = wd ? insideProject(wd, identity) : files.every((f) => insideProject(f, identity));
    return inside
      ? { tied: true, why: `its compose folder is in the project`, project }
      : { tied: false, why: `its compose folder is outside this project (${where})`, project, outside: true };
  }
  const bind = binds.find((b) => insideProject(b, identity));
  if (bind) return { tied: true, why: `it mounts ${bind} from the project`, project };
  return { tied: null, why: null, project };
}

// `docker container inspect` for many ids: Map id -> { name, labels, binds, volumes, networks }.
// A container gone since the listing fails the command, not the other lines.
async function inspectContainers(run, ids, o, report) {
  const out = new Map();
  const safe = ids.filter((id) => SAFE_NAME.test(id));
  for (let i = 0; i < safe.length; i += INSPECT_BATCH) {
    const batch = safe.slice(i, i + INSPECT_BATCH);
    const r = await exec(run, `docker container inspect --format "{{json .}}" ${batch.join(" ")}`, o);
    const rows = jsonLines(r.stdout);
    if (!r.ok && !rows.length && report) report.errors.push(`could not inspect containers: ${line1(r.stderr)}`);
    for (const x of rows) {
      const id = String(x.Id || x.ID || "");
      if (!id) continue;
      const mounts = Array.isArray(x.Mounts) ? x.Mounts : [];
      const nets = (x.NetworkSettings && x.NetworkSettings.Networks) || {};
      out.set(id, {
        name: String(x.Name || "").replace(/^\//, ""),
        created: String(x.Created || ""),
        labels: (x.Config && x.Config.Labels) || {},
        binds: mounts.filter((m) => m.Type === "bind" && m.Source).map((m) => String(m.Source)),
        volumes: mounts.filter((m) => m.Type === "volume" && m.Name).map((m) => String(m.Name)),
        networks: Object.entries(nets).map(([name, n]) => ({ name, id: String((n && n.NetworkID) || "") }))
      });
    }
  }
  return out;
}

// Volumes or networks by name or id: Map key -> { labels, created, ingress }.
async function inspectMeta(run, kind, keys, o) {
  const out = new Map();
  const safe = keys.filter((k) => SAFE_NAME.test(k));
  for (let i = 0; i < safe.length; i += INSPECT_BATCH) {
    const r = await exec(run, `docker ${kind} inspect --format "{{json .}}" ${safe.slice(i, i + INSPECT_BATCH).join(" ")}`, o);
    for (const x of jsonLines(r.stdout)) {
      const key = kind === "volume" ? String(x.Name || "") : String(x.Id || x.ID || "");
      if (key) out.set(key, { labels: x.Labels || {}, created: String(x.CreatedAt || x.Created || ""), ingress: x.Ingress === true });
    }
  }
  return out;
}

const secondsOf = (t) => { const ms = Date.parse(String(t || "")); return Number.isFinite(ms) ? Math.floor(ms / 1000) : null; };

// Whether a volume's tie (or two inspects) is about the same volume: the same creation date and the
// same labels, which Docker never changes on a volume. A tie that does not say when its volume was
// made is about no volume in particular.
const labelKey = (l) => JSON.stringify(Object.entries(l && typeof l === "object" ? l : {}).map(([k, v]) => [k, String(v)]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
const sameTime = (a, b) => { const x = Date.parse(String(a || "")), y = Date.parse(String(b || "")); return Number.isFinite(x) && Number.isFinite(y) ? x === y : a === b; };
const sameVolume = (tie, m) => !!(tie && tie.created) && sameTime(tie.created, m && m.created) && labelKey(tie.labels) === labelKey(m && m.labels);

// Why a volume's tie does not hold for the volume of that name now, for the report.
function otherVolume(tie, m) {
  const was = `the volume the run noted under this name (${tie.why})`;
  if (!tie.created || !m.created) return `${was} cannot be shown to be this one: ${tie.created ? "Docker did not say when this one was made" : "the note does not say when Docker made it"}`;
  if (!sameTime(tie.created, m.created)) return `${was} was another one: Docker made that one ${tie.created}, this one ${m.created}`;
  return `${was} was another one: their labels differ`;
}

// Notes kept between start and end, or a fresh set. Notes of another run or engine are not this run's.
function loadSeen(root, start) {
  const engine = start.docker.engine.id;
  let s = null;
  try { s = readJson(seenFile(root), null); } catch { s = null; }
  if (!s || typeof s !== "object" || s.startAt !== start.at || s.engine !== engine) {
    return { startAt: start.at, engine, eventsUntil: start.docker.engine.time || null, containers: {}, volumes: {}, networks: {}, projects: [], contested: [] };
  }
  for (const k of KINDS) if (!s[k] || typeof s[k] !== "object" || Array.isArray(s[k])) s[k] = {};
  for (const k of ["projects", "contested"]) if (!Array.isArray(s[k])) s[k] = [];
  return s;
}

function hadSets(before) {
  return {
    containers: new Set((before.containers || []).map((c) => c.id)),
    volumes: new Set((before.volumes || []).map((v) => v.name)),
    networks: new Set((before.networks || []).map((n) => n.id))
  };
}

// Looks at the containers now and at Docker's events since the last look, and adds to `seen`
// what ties to the project: containers not there at the start, the new volumes and networks
// tied containers use, and the compose names learned or contested. A tie that rests on a compose
// name records it (`via`), so a name contested later unties it. Docker keeps only its latest few
// hundred events and forgets them when the engine restarts: they fill gaps, never prove anything
// absent. `known` holds volumes already inspected (Map name -> { labels, created }). Returns the
// current containers' judgements, Map id -> judgement.
async function observe(run, { identity, had, seen, current, engineNow, o, report = null, known = new Map() }) {
  const details = await inspectContainers(run, current.map((c) => c.id), o, report);
  const judged = new Map();
  for (const [id, d] of details) judged.set(id, { ...judgeContainer(d.labels, d.binds, identity), name: d.name, created: d.created, volumes: d.volumes, networks: d.networks });
  const os = engineNow && engineNow.os;

  const uses = []; // [kind, key, containerId, when (epoch s)] from events
  const since = secondsOf(seen.eventsUntil);
  const until = secondsOf(engineNow && engineNow.time);
  if (since !== null && until !== null && until > since) {
    const r = await exec(run, `docker events --since ${since - 5} --until ${until} --filter type=container --filter type=volume --filter type=network --filter event=create --filter event=mount --filter event=connect --format "{{json .}}"`, o);
    for (const e of jsonLines(r.stdout)) {
      const actor = e.Actor || {};
      const a = actor.Attributes || {};
      const id = String(actor.ID || e.id || "");
      const action = String(e.Action || e.status || "");
      if (!id) continue;
      // A container's labels come with its create event, so one removed since is still judged.
      if (e.Type === "container" && action === "create" && !judged.has(id)) judged.set(id, { ...judgeContainer(a, [], identity), name: String(a.name || ""), volumes: [], networks: [] });
      else if (e.Type === "volume" && action === "mount" && a.container) uses.push(["volumes", id, String(a.container), Number(e.time)]);
      else if (e.Type === "network" && action === "connect" && a.container && !predefinedNetwork(a.name, os)) uses.push(["networks", id, String(a.container), Number(e.time)]);
    }
    if (r.ok) seen.eventsUntil = engineNow.time;
  }

  const learned = new Set(seen.projects);
  const contested = new Set(seen.contested);
  for (const j of judged.values()) {
    if (j.project && j.tied === true) learned.add(j.project);
    if (j.project && j.outside) contested.add(j.project);
  }
  const names = new Set([...identity.names, ...learned].filter((n) => !contested.has(n)));
  for (const j of judged.values()) {
    if (j.tied === null && j.project && names.has(j.project)) Object.assign(j, { tied: true, why: `its compose project, ${j.project}, is this project's`, via: j.project });
  }
  seen.projects = [...learned];
  seen.contested = [...contested];

  const tag = (why, via) => (via ? { why, via } : { why });
  // The first tie stands, except that one resting on no compose name replaces one that does, and
  // a tie to another volume of the same name (the run's own, removed and made again) gives way.
  const put = (kind, key, t) => {
    const cur = seen[kind][key];
    if (!had[kind].has(key) && (!cur || (cur.via && !t.via) || (kind === "volumes" && "created" in t && !sameVolume(cur, t)))) seen[kind][key] = t;
  };
  const vols = []; // [name, tie, when it was used (epoch s), or null for now]
  for (const [id, j] of judged) {
    if (j.tied !== true) continue;
    put("containers", id, { name: j.name, ...tag(j.why, j.via) });
    const who = j.name || id.slice(0, 12);
    for (const v of j.volumes) vols.push([v, tag(`${who} uses it`, j.via), null]);
    for (const n of j.networks) if (n.id && !predefinedNetwork(n.name, os)) put("networks", n.id, tag(`${who} uses it`, j.via));
  }
  for (const [kind, key, cid, when] of uses) {
    const j = judged.get(cid);
    const c = j && j.tied === true ? { name: j.name, via: j.via } : seen.containers[cid];
    if (!c) continue;
    const t = tag(`${c.name || cid.slice(0, 12)} used it`, c.via);
    if (kind === "volumes") vols.push([key, t, when]);
    else put(kind, key, t);
  }

  // Each volume's tie records which volume it was, by Docker's CreatedAt and labels. A volume gone
  // already cannot be told and is not noted; one Docker made after the use an event reports is
  // another volume of that name. A name AutoClaude will not put in a command is never inspected:
  // its tie says nothing of which volume, and it is only ever kept, never removed.
  const fresh = vols.filter(([v]) => !had.volumes.has(v));
  const ask = [...new Set(fresh.map(([v]) => v).filter((v) => SAFE_NAME.test(v) && !known.has(v)))];
  const vmeta = ask.length ? new Map([...known, ...(await inspectMeta(run, "volume", ask, o))]) : known;
  for (const [v, t, when] of fresh) {
    if (!SAFE_NAME.test(v)) { put("volumes", v, t); continue; }
    const m = vmeta.get(v);
    if (!m) continue;
    const born = secondsOf(m.created);
    if (Number.isFinite(when) && born !== null && born > when) continue;
    put("volumes", v, { ...t, created: m.created, labels: m.labels });
  }
  return { judged, names, contested };
}

// A note's or a seen record's tie, unless the compose name it rests on is contested by now.
const valid = (t, contested) => (t && !(t.via && contested.has(t.via)) ? t : null);

// Between start and end: notes which new Docker objects tie to this project while they still
// exist, so the end can still remove a volume whose container is gone by then. The gate calls it
// after each verification's checks. Best effort and bounded (NOTE_TIMEOUT_MS per call, and
// `deadline`, epoch ms, when given); never throws and never removes anything. Returns
// { ok, containers, volumes, networks } (how many are noted so far) or { ok: false, reason }.
export async function noteFootprint(root, { run = null, deadline = null } = {}) {
  try {
    let start = null;
    try { start = readJson(startFile(root), null); } catch { start = null; }
    const before = start && start.docker;
    if (!before || !before.available || !before.engine || !before.engine.id) return { ok: false, reason: "no run-start record with a Docker engine" };
    const runner = run || defaultRunner(root);
    const o = { timeoutMs: NOTE_TIMEOUT_MS, deadline };
    const c = await exec(runner, 'docker ps -a --no-trunc --format "{{json .}}"', o);
    if (!c.ok) return { ok: false, reason: `could not list containers: ${line1(c.stderr)}` };
    const info = await exec(runner, 'docker info --format "{{json .}}"', o);
    const engine = engineOf(info, null);
    const m = engineMatch(before.engine, engine, info.ok ? null : line1(info.stderr));
    if (!m.same) return { ok: false, reason: m.why };
    const seen = loadSeen(root, start);
    await observe(runner, { identity: projectIdentity(root), had: hadSets(before), seen, current: containersOf(c.stdout), engineNow: engine, o });
    seen.at = new Date().toISOString();
    writeJsonAtomic(seenFile(root), seen);
    return { ok: true, containers: Object.keys(seen.containers).length, volumes: Object.keys(seen.volumes).length, networks: Object.keys(seen.networks).length };
  } catch (e) {
    return { ok: false, reason: String(e && e.message ? e.message : e) };
  }
}

function emptyReport() {
  return { removed: [], kept: [], runningCreated: [], unattributed: [], secretsCreated: [], goneSinceStart: [], errors: [], dockerChecked: false };
}

const label = (o) => `${o.kind} ${o.name || o.id.slice(0, 12)}`;

// Compares with the start record, removes what the run created and nothing uses (when
// footprint.docker is on and remove is not false), and returns { removed, kept, runningCreated,
// unattributed, secretsCreated, goneSinceStart, errors, dockerChecked }. Each Docker item is
// { kind, id, name, image?, state?, reason?, attributedBy? }: removed, kept and runningCreated
// hold only what ties to this project (attributedBy says what tied it); unattributed holds what
// is new since the start but not tied to the project, never removed. secretsCreated holds paths,
// never contents. Also written to .autoclaude/footprint-end.json. `deadline` (epoch ms) bounds
// every Docker call; `wait` the first one that needs the engine. Never throws.
export async function finishFootprint(root, { run = null, remove = true, config = null, deadline = null, wait = ENGINE_WAIT_MS } = {}) {
  const report = emptyReport();
  try {
    await finish(root, { run: run || defaultRunner(root), remove, config, deadline, wait }, report);
  } catch (e) {
    report.errors.push(`footprint check failed: ${String(e && e.message ? e.message : e)}`);
  }
  try { writeJsonAtomic(endFile(root), { at: new Date().toISOString(), ...report }); } catch {}
  return report;
}

async function dockerSwitch(root, config) {
  let cfg = config;
  if (!cfg) {
    try {
      const { loadConfig } = await import("./config.js");
      cfg = loadConfig(root).config;
    } catch { cfg = null; }
  }
  const v = cfg && cfg.footprint ? cfg.footprint.docker : undefined;
  return v !== false; // the built-in default is on
}

async function finish(root, { run, remove, config, deadline, wait }, report) {
  let start = null;
  try { start = readJson(startFile(root), null); } catch { start = null; }
  if (!start || typeof start !== "object") {
    report.errors.push(`no footprint was recorded at run start (${path.join(".autoclaude", START_FILE)} is missing), so nothing was removed`);
    return;
  }
  const startSecrets = new Set(Array.isArray(start.secrets) ? start.secrets : []);
  report.secretsCreated = listSecrets(root).filter((f) => !startSecrets.has(f));

  const o = { deadline };
  const now = await dockerSnapshot(run, { wait, deadline });
  if (!now.available) return; // Docker absent or stopped: nothing to compare, nothing to report
  report.dockerChecked = true;
  if (now.error) report.errors.push(now.error);
  const before = start.docker || {};
  if (!before.available) {
    // Without a baseline nothing can be told apart from what was already there, so nothing goes.
    const n = now.containers.length + now.volumes.length + now.networks.length;
    report.errors.push(`Docker did not answer at run start, so what the run created cannot be told apart; nothing was removed (${n} Docker object${n === 1 ? "" : "s"} on this computer now)`);
    return;
  }
  const engine = engineMatch(before.engine, now.engine, now.engineError);
  if (!engine.same) {
    report.errors.push(`${engine.why}, so nothing was compared or removed`);
    return;
  }

  // Compare only the kinds listed both times; a record without `listed` counts as listed when it
  // had no error at all.
  const listed = (snap, kind) => (snap.listed ? !!snap.listed[kind] : !snap.error);
  const comparable = {};
  for (const kind of KINDS) {
    comparable[kind] = listed(before, kind) && listed(now, kind);
    if (!comparable[kind]) report.errors.push(`${kind} could not be listed ${listed(before, kind) ? "now" : "at run start"}, so none were compared or removed`);
  }
  const had = hadSets(before);
  const nowIds = {
    containers: new Set(now.containers.map((c) => c.id)),
    volumes: new Set(now.volumes.map((v) => v.name)),
    networks: new Set(now.networks.map((n) => n.id))
  };
  // Docker's own networks are never compared: the default one's new id after an engine restart
  // would read as one the run made, and its old id as one gone since the start.
  const own = (n) => predefinedNetwork(n.name, now.engine.os || before.engine.os);
  if (comparable.containers) for (const c of before.containers || []) if (!nowIds.containers.has(c.id)) report.goneSinceStart.push({ kind: "container", id: c.id, name: c.name, image: c.image });
  if (comparable.volumes) for (const v of before.volumes || []) if (!nowIds.volumes.has(v.name)) report.goneSinceStart.push({ kind: "volume", id: v.name, name: v.name });
  if (comparable.networks) for (const n of before.networks || []) if (!nowIds.networks.has(n.id) && !own(n)) report.goneSinceStart.push({ kind: "network", id: n.id, name: n.name });

  const created = {
    containers: comparable.containers ? now.containers.filter((c) => !had.containers.has(c.id)).map((c) => ({ kind: "container", ...c })) : [],
    volumes: comparable.volumes ? now.volumes.filter((v) => !had.volumes.has(v.name)).map((v) => ({ kind: "volume", id: v.name, name: v.name, driver: v.driver })) : [],
    networks: comparable.networks ? now.networks.filter((n) => !had.networks.has(n.id) && !own(n)).map((n) => ({ kind: "network", ...n })) : []
  };
  if (!created.containers.length && !created.volumes.length && !created.networks.length) return;

  const volMeta = created.volumes.length ? await inspectMeta(run, "volume", created.volumes.map((v) => v.name), o) : new Map();
  const netMeta = created.networks.length ? await inspectMeta(run, "network", created.networks.map((n) => n.id), o) : new Map();
  created.networks = created.networks.filter((n) => !(netMeta.get(n.id) || {}).ingress);

  // What ties each new object to this project: now, from earlier notes, and from recent events.
  const seen = loadSeen(root, start);
  const { judged, names, contested } = await observe(run, { identity: projectIdentity(root), had, seen, current: now.containers, engineNow: now.engine, o, report, known: volMeta });
  const meta = (item) => (item.kind === "container" ? judged.get(item.id) : (item.kind === "volume" ? volMeta : netMeta).get(item.id)) || {};
  const tie = (item) => {
    if (item.kind === "container") {
      const j = judged.get(item.id);
      if (j && j.tied === true) return { tied: true, why: j.why };
      if (j && j.tied === false) return { tied: false, why: j.why };
      const t = valid(seen.containers[item.id], contested);
      if (t) return { tied: true, why: t.why };
      return { tied: false, why: j && j.project ? `it belongs to the compose project ${j.project}${contested.has(j.project) ? ", which a container from another folder also uses" : ""}` : null };
    }
    const t = valid(seen[`${item.kind}s`][item.id], contested);
    // A volume's tie holds only for the volume it saw, not for one made since under its name.
    const other = !!t && item.kind === "volume" && SAFE_NAME.test(item.name) && !sameVolume(t, meta(item));
    if (t && !other) return { tied: true, why: t.why };
    const labels = meta(item).labels || {};
    const p = labels[LABEL.project] ? String(labels[LABEL.project]) : null;
    if (p && names.has(p)) return { tied: true, why: `its compose project, ${p}, is this project's` };
    return { tied: false, why: p ? `it belongs to the compose project ${p}${contested.has(p) ? ", which a container from another folder also uses" : ""}` : other ? otherVolume(t, meta(item)) : null };
  };
  // Docker's own creation date, on the engine's clock like the start record's time, is a second
  // proof that a tied object is new: a run-start list that missed something (a cache answering
  // for a waking engine) can never make an older object the run's.
  const startMs = Date.parse(String(before.engine.time || ""));
  const predates = (item) => {
    const born = Date.parse(String(meta(item).created || ""));
    if (Number.isFinite(born) && Number.isFinite(startMs)) return born < startMs ? `the run-start record does not list it, but Docker dates it ${meta(item).created}, before the run started` : null;
    return "Docker did not say when it was created, so it cannot be shown to be new";
  };
  // Not tied, or not provably new: listed for the owner, never removed. A name AutoClaude will not
  // put in a command is never inspected either; the removal passes keep it with that reason.
  const sortOut = (items) => items.filter((x) => {
    const t = tie(x);
    const old = t.tied && SAFE_NAME.test(x.kind === "volume" ? x.name : x.id) ? predates(x) : null;
    if (t.tied && !old) { x.attributedBy = t.why; return true; }
    report.unattributed.push({ ...x, reason: old ? `${old}; the run left it alone` : `new since the run started, but ${t.why || "nothing ties it to this project"}; it may be another project's or yours, so the run left it alone` });
    return false;
  });
  const ours = { containers: sortOut(created.containers), volumes: sortOut(created.volumes), networks: sortOut(created.networks) };

  const enabled = await dockerSwitch(root, config);
  const why = !enabled ? "footprint.docker is off, so the run removes nothing" : remove === false ? "removal was not asked for" : null;

  // Containers first: removing a stopped one frees its volumes and networks for the next passes.
  for (const c of ours.containers) {
    if (!STOPPED.has(c.state)) { report.runningCreated.push(c); continue; }
    if (why) { report.kept.push({ ...c, reason: why }); continue; }
    if (!SAFE_NAME.test(c.id)) { report.kept.push({ ...c, reason: "its id is not one AutoClaude will put in a command" }); continue; }
    const r = await exec(run, `docker rm ${c.id}`, o);
    if (r.ok) report.removed.push(c);
    else { report.kept.push({ ...c, reason: `docker rm failed: ${line1(r.stderr)}` }); report.errors.push(`could not remove ${label(c)}: ${line1(r.stderr)}`); }
  }

  let dangling = null;
  if (!why && ours.volumes.length) {
    const d = await exec(run, "docker volume ls -q --filter dangling=true", o);
    if (d.ok) dangling = new Set(plainLines(d.stdout));
    else report.errors.push(`could not tell which volumes are unused: ${line1(d.stderr)}`);
  }
  for (const v of ours.volumes) {
    if (why) { report.kept.push({ ...v, reason: why }); continue; }
    if (!dangling) { report.kept.push({ ...v, reason: "could not tell whether a container uses it" }); continue; }
    if (!dangling.has(v.name)) { report.kept.push({ ...v, reason: "a container uses it" }); continue; }
    if (!SAFE_NAME.test(v.name)) { report.kept.push({ ...v, reason: "its name is not one AutoClaude will put in a command" }); continue; }
    const r = await exec(run, `docker volume rm ${v.name}`, o);
    if (r.ok) report.removed.push(v);
    else { report.kept.push({ ...v, reason: `docker volume rm failed: ${line1(r.stderr)}` }); report.errors.push(`could not remove ${label(v)}: ${line1(r.stderr)}`); }
  }

  for (const n of ours.networks) {
    if (why) { report.kept.push({ ...n, reason: why }); continue; }
    if (!SAFE_NAME.test(n.id)) { report.kept.push({ ...n, reason: "its id is not one AutoClaude will put in a command" }); continue; }
    // -a: a stopped container attached to the network counts as a user too.
    const users = await exec(run, `docker ps -a -q --no-trunc --filter network=${n.id}`, o);
    if (!users.ok) { report.kept.push({ ...n, reason: "could not tell whether a container uses it" }); continue; }
    const count = plainLines(users.stdout).length;
    if (count) { report.kept.push({ ...n, reason: `${count} container${count === 1 ? "" : "s"} use${count === 1 ? "s" : ""} it` }); continue; }
    const r = await exec(run, `docker network rm ${n.id}`, o);
    if (r.ok) report.removed.push(n);
    else { report.kept.push({ ...n, reason: `docker network rm failed: ${line1(r.stderr)}` }); report.errors.push(`could not remove ${label(n)}: ${line1(r.stderr)}`); }
  }
}

// One line for alerts and logs: "removed 3, kept 1, 2 still running".
export function footprintLine(report) {
  if (!report) return null;
  const bits = [];
  if (report.removed && report.removed.length) bits.push(`removed ${report.removed.length} unused Docker object${report.removed.length === 1 ? "" : "s"} the run created`);
  if (report.runningCreated && report.runningCreated.length) bits.push(`${report.runningCreated.length} container${report.runningCreated.length === 1 ? "" : "s"} it started still running`);
  if (report.kept && report.kept.length) bits.push(`kept ${report.kept.length}`);
  if (report.unattributed && report.unattributed.length) bits.push(`left alone ${report.unattributed.length} new Docker object${report.unattributed.length === 1 ? "" : "s"} not tied to this project`);
  if (report.errors && report.errors.length) bits.push(`${report.errors.length} problem${report.errors.length === 1 ? "" : "s"}`);
  if (bits.length) return bits.join(", ");
  return report.dockerChecked ? "nothing left behind in Docker" : "Docker was not checked (not installed or not running)";
}
