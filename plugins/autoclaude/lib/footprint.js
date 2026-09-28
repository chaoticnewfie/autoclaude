// The run's machine footprint (PLAN.md P8.5, D49). At run start the Docker containers, volumes
// and networks on this computer and the files in the project's secrets/ folder are recorded; at
// plan completion the run removes the unused Docker objects it created (stopped containers,
// volumes no container uses, networks with no containers) and reports the rest. A container the
// run created that is still running is only reported: it may be the thing the plan wanted
// running. The DB rehearsal leaked 33 Docker volumes, which is why this exists.
//
// Docker is reached through the `docker` CLI with --format output. Nothing here throws: Docker
// not installed (or its engine not running) gives an empty report. `run` is an injectable
// command runner, run(command) -> { code, stdout, stderr }, so tests never touch Docker.
// Node built-ins only.
import fs from "node:fs";
import path from "node:path";
import { projectPaths } from "./paths.js";
import { readJson, writeJsonAtomic } from "./fsatomic.js";
import { runCommand } from "./proc.js";

export const START_FILE = "footprint-start.json";
export const END_FILE = "footprint-end.json";
export const SECRETS_DIR = "secrets";
const DOCKER_TIMEOUT_MS = 60000;
// Docker ids are hex; names follow Docker's own rule. Anything else is never put in a command.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/;
// Only these container states are "stopped"; running, restarting and paused are left alone.
const STOPPED = new Set(["exited", "created", "dead"]);

export function startFile(root) {
  return path.join(projectPaths(root).runtimeDir, START_FILE);
}

export function endFile(root) {
  return path.join(projectPaths(root).runtimeDir, END_FILE);
}

// The default runner: the shell command through lib/proc.js, bounded, never rejecting.
export function defaultRunner(root) {
  return async (command) => {
    try {
      const r = await runCommand(command, { cwd: root, timeoutMs: DOCKER_TIMEOUT_MS });
      return { code: r.timedOut ? null : r.code, stdout: r.stdout, stderr: r.timedOut ? `timed out after ${DOCKER_TIMEOUT_MS / 1000} s` : r.stderr };
    } catch (e) {
      return { code: null, stdout: "", stderr: String(e && e.message ? e.message : e) };
    }
  };
}

async function exec(run, command) {
  try {
    const r = await run(command);
    return { ok: !!r && r.code === 0, stdout: String((r && r.stdout) || ""), stderr: String((r && r.stderr) || "").trim() };
  } catch (e) {
    return { ok: false, stdout: "", stderr: String(e && e.message ? e.message : e) };
  }
}

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

// { available, version, containers, volumes, networks, error }. Unavailable when the CLI is
// missing or its engine does not answer; the lists are then empty.
export async function dockerSnapshot(run) {
  const v = await exec(run, 'docker version --format "{{.Server.Version}}"');
  if (!v.ok) return { available: false, version: null, containers: [], volumes: [], networks: [], error: (v.stderr || "docker did not answer").split(/\r?\n/)[0].slice(0, 300) };
  const [c, vol, net] = [
    await exec(run, 'docker ps -a --no-trunc --format "{{json .}}"'),
    await exec(run, 'docker volume ls --format "{{json .}}"'),
    await exec(run, 'docker network ls --no-trunc --format "{{json .}}"')
  ];
  const failed = [[c, "containers"], [vol, "volumes"], [net, "networks"]].filter(([r]) => !r.ok).map(([r, what]) => `could not list ${what}: ${r.stderr.split(/\r?\n/)[0] || "no output"}`);
  return {
    available: true,
    version: plainLines(v.stdout)[0] || null,
    // A kind whose list failed is never compared: everything of it would look new.
    listed: { containers: c.ok, volumes: vol.ok, networks: net.ok },
    containers: jsonLines(c.stdout).map((x) => ({ id: String(x.ID || ""), name: String(x.Names || ""), image: String(x.Image || ""), state: containerState(x), status: String(x.Status || "") })).filter((x) => x.id),
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
export async function recordFootprintStart(root, { run = null, now = () => new Date() } = {}) {
  const runner = run || defaultRunner(root);
  let docker;
  try { docker = await dockerSnapshot(runner); } catch (e) { docker = { available: false, version: null, containers: [], volumes: [], networks: [], error: String(e && e.message ? e.message : e) }; }
  const record = { at: now().toISOString(), docker, secrets: listSecrets(root) };
  try { writeJsonAtomic(startFile(root), record); } catch (e) { record.writeError = String(e && e.message ? e.message : e); }
  return record;
}

function emptyReport() {
  return { removed: [], kept: [], runningCreated: [], secretsCreated: [], goneSinceStart: [], errors: [], dockerChecked: false };
}

const label = (o) => `${o.kind} ${o.name || o.id.slice(0, 12)}`;

// Compares with the start record, removes what the run created and nothing uses (when
// footprint.docker is on and remove is not false), and returns { removed, kept, runningCreated,
// secretsCreated, goneSinceStart, errors, dockerChecked }. Each Docker item is { kind, id, name,
// image?, state?, reason? }; secretsCreated holds paths, never contents. Also written to
// .autoclaude/footprint-end.json. Never throws.
export async function finishFootprint(root, { run = null, remove = true, config = null } = {}) {
  const report = emptyReport();
  try {
    await finish(root, { run: run || defaultRunner(root), remove, config }, report);
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

async function finish(root, { run, remove, config }, report) {
  let start = null;
  try { start = readJson(startFile(root), null); } catch { start = null; }
  if (!start || typeof start !== "object") {
    report.errors.push(`no footprint was recorded at run start (${path.join(".autoclaude", START_FILE)} is missing), so nothing was removed`);
    return;
  }
  const startSecrets = new Set(Array.isArray(start.secrets) ? start.secrets : []);
  report.secretsCreated = listSecrets(root).filter((f) => !startSecrets.has(f));

  const now = await dockerSnapshot(run);
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

  // Compare only the kinds listed both times; a record without `listed` counts as listed when it
  // had no error at all.
  const listed = (snap, kind) => (snap.listed ? !!snap.listed[kind] : !snap.error);
  const comparable = {};
  for (const kind of ["containers", "volumes", "networks"]) {
    comparable[kind] = listed(before, kind) && listed(now, kind);
    if (!comparable[kind]) report.errors.push(`${kind} could not be listed ${listed(before, kind) ? "now" : "at run start"}, so none were compared or removed`);
  }
  const had = {
    containers: new Set((before.containers || []).map((c) => c.id)),
    volumes: new Set((before.volumes || []).map((v) => v.name)),
    networks: new Set((before.networks || []).map((n) => n.id))
  };
  const nowIds = {
    containers: new Set(now.containers.map((c) => c.id)),
    volumes: new Set(now.volumes.map((v) => v.name)),
    networks: new Set(now.networks.map((n) => n.id))
  };
  if (comparable.containers) for (const c of before.containers || []) if (!nowIds.containers.has(c.id)) report.goneSinceStart.push({ kind: "container", id: c.id, name: c.name, image: c.image });
  if (comparable.volumes) for (const v of before.volumes || []) if (!nowIds.volumes.has(v.name)) report.goneSinceStart.push({ kind: "volume", id: v.name, name: v.name });
  if (comparable.networks) for (const n of before.networks || []) if (!nowIds.networks.has(n.id)) report.goneSinceStart.push({ kind: "network", id: n.id, name: n.name });

  const created = {
    containers: comparable.containers ? now.containers.filter((c) => !had.containers.has(c.id)).map((c) => ({ kind: "container", ...c })) : [],
    volumes: comparable.volumes ? now.volumes.filter((v) => !had.volumes.has(v.name)).map((v) => ({ kind: "volume", id: v.name, name: v.name, driver: v.driver })) : [],
    networks: comparable.networks ? now.networks.filter((n) => !had.networks.has(n.id)).map((n) => ({ kind: "network", ...n })) : []
  };

  const enabled = await dockerSwitch(root, config);
  const why = !enabled ? "footprint.docker is off, so the run removes nothing" : remove === false ? "removal was not asked for" : null;

  // Containers first: removing a stopped one frees its volumes and networks for the next passes.
  for (const c of created.containers) {
    if (!STOPPED.has(c.state)) { report.runningCreated.push(c); continue; }
    if (why) { report.kept.push({ ...c, reason: why }); continue; }
    if (!SAFE_NAME.test(c.id)) { report.kept.push({ ...c, reason: "its id is not one AutoClaude will put in a command" }); continue; }
    const r = await exec(run, `docker rm ${c.id}`);
    if (r.ok) report.removed.push(c);
    else { report.kept.push({ ...c, reason: `docker rm failed: ${r.stderr.split(/\r?\n/)[0] || "no output"}` }); report.errors.push(`could not remove ${label(c)}: ${r.stderr.split(/\r?\n/)[0] || "no output"}`); }
  }

  let dangling = null;
  if (!why && created.volumes.length) {
    const d = await exec(run, "docker volume ls -q --filter dangling=true");
    if (d.ok) dangling = new Set(plainLines(d.stdout));
    else report.errors.push(`could not tell which volumes are unused: ${d.stderr.split(/\r?\n/)[0] || "no output"}`);
  }
  for (const v of created.volumes) {
    if (why) { report.kept.push({ ...v, reason: why }); continue; }
    if (!dangling) { report.kept.push({ ...v, reason: "could not tell whether a container uses it" }); continue; }
    if (!dangling.has(v.name)) { report.kept.push({ ...v, reason: "a container uses it" }); continue; }
    if (!SAFE_NAME.test(v.name)) { report.kept.push({ ...v, reason: "its name is not one AutoClaude will put in a command" }); continue; }
    const r = await exec(run, `docker volume rm ${v.name}`);
    if (r.ok) report.removed.push(v);
    else { report.kept.push({ ...v, reason: `docker volume rm failed: ${r.stderr.split(/\r?\n/)[0] || "no output"}` }); report.errors.push(`could not remove ${label(v)}: ${r.stderr.split(/\r?\n/)[0] || "no output"}`); }
  }

  for (const n of created.networks) {
    if (why) { report.kept.push({ ...n, reason: why }); continue; }
    if (!SAFE_NAME.test(n.id)) { report.kept.push({ ...n, reason: "its id is not one AutoClaude will put in a command" }); continue; }
    // -a: a stopped container attached to the network counts as a user too.
    const users = await exec(run, `docker ps -a -q --no-trunc --filter network=${n.id}`);
    if (!users.ok) { report.kept.push({ ...n, reason: "could not tell whether a container uses it" }); continue; }
    const count = plainLines(users.stdout).length;
    if (count) { report.kept.push({ ...n, reason: `${count} container${count === 1 ? "" : "s"} use${count === 1 ? "s" : ""} it` }); continue; }
    const r = await exec(run, `docker network rm ${n.id}`);
    if (r.ok) report.removed.push(n);
    else { report.kept.push({ ...n, reason: `docker network rm failed: ${r.stderr.split(/\r?\n/)[0] || "no output"}` }); report.errors.push(`could not remove ${label(n)}: ${r.stderr.split(/\r?\n/)[0] || "no output"}`); }
  }
}

// One line for alerts and logs: "removed 3, kept 1, 2 still running".
export function footprintLine(report) {
  if (!report) return null;
  const bits = [];
  if (report.removed && report.removed.length) bits.push(`removed ${report.removed.length} unused Docker object${report.removed.length === 1 ? "" : "s"} the run created`);
  if (report.runningCreated && report.runningCreated.length) bits.push(`${report.runningCreated.length} container${report.runningCreated.length === 1 ? "" : "s"} it started still running`);
  if (report.kept && report.kept.length) bits.push(`kept ${report.kept.length}`);
  if (report.errors && report.errors.length) bits.push(`${report.errors.length} problem${report.errors.length === 1 ? "" : "s"}`);
  if (bits.length) return bits.join(", ");
  return report.dockerChecked ? "nothing left behind in Docker" : "Docker was not checked (not installed or not running)";
}
