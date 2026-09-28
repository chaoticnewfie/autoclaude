import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The config loader may read this computer's defaults; keep it away from the real Claude config.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fp-cfg-"));

const { recordFootprintStart, finishFootprint, dockerSnapshot, listSecrets, startFile, endFile, footprintLine } = await import("../../plugins/autoclaude/lib/footprint.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fp-"));
const ON = { footprint: { docker: true } };

// A fake Docker: a mutable world and the commands AutoClaude sends it. Nothing reaches the real
// docker CLI.
function fakeDocker(world) {
  const calls = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ code: 1, stdout: "", stderr });
  const run = async (cmd) => {
    calls.push(cmd);
    if (world.throws) throw new Error("spawn failed");
    if (world.absent) return { code: 9009, stdout: "", stderr: "'docker' is not recognized as an internal or external command" };
    if (cmd === 'docker version --format "{{.Server.Version}}"') return world.engineDown ? fail("error during connect: the docker engine is not running") : ok("27.3.1\n");
    if (cmd === 'docker ps -a --no-trunc --format "{{json .}}"') return ok(world.containers.map((c) => JSON.stringify({ ID: c.id, Names: c.name, Image: c.image, State: c.state, Status: c.status || "" })).join("\n") + "\n");
    if (cmd === 'docker volume ls --format "{{json .}}"') return ok(world.volumes.map((v) => JSON.stringify({ Name: v, Driver: "local" })).join("\n"));
    if (cmd === 'docker network ls --no-trunc --format "{{json .}}"') return ok(world.networks.map((n) => JSON.stringify({ ID: n.id, Name: n.name, Driver: "bridge" })).join("\n"));
    if (cmd === "docker volume ls -q --filter dangling=true") {
      const used = new Set(world.containers.flatMap((c) => c.volumes || []));
      return ok(world.volumes.filter((v) => !used.has(v)).join("\n"));
    }
    let m;
    if ((m = cmd.match(/^docker ps -a -q --no-trunc --filter network=(\S+)$/))) return ok(world.containers.filter((c) => (c.networks || []).includes(m[1])).map((c) => c.id).join("\n"));
    if ((m = cmd.match(/^docker rm (\S+)$/))) {
      const c = world.containers.find((x) => x.id === m[1]);
      if (!c) return fail(`No such container: ${m[1]}`);
      if (c.state === "running" || world.rmFails) return fail("container is running: stop the container before removing");
      world.containers = world.containers.filter((x) => x !== c);
      return ok(m[1]);
    }
    if ((m = cmd.match(/^docker volume rm (\S+)$/))) { world.volumes = world.volumes.filter((v) => v !== m[1]); return ok(m[1]); }
    if ((m = cmd.match(/^docker network rm (\S+)$/))) { world.networks = world.networks.filter((n) => n.id !== m[1]); return ok(m[1]); }
    return fail(`unexpected command: ${cmd}`);
  };
  return { run, calls };
}

const hex = (c) => c.repeat(64);
const BASE = () => ({
  containers: [{ id: hex("a"), name: "owners-db", image: "postgres:16", state: "exited", volumes: ["owners-data"] }],
  volumes: ["owners-data", "owners-orphan"],
  networks: [{ id: hex("1"), name: "bridge" }, { id: hex("2"), name: "host" }]
});

test("start records Docker and the secrets folder; the finish removes only unused things the run created", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "old.env"), "OLD=1\n");
  const world = BASE();
  const { run, calls } = fakeDocker(world);
  const start = await recordFootprintStart(root, { run });
  assert.equal(start.docker.available, true);
  assert.equal(start.docker.version, "27.3.1");
  assert.deepEqual(start.docker.containers.map((c) => [c.name, c.state]), [["owners-db", "exited"]]);
  assert.deepEqual(start.secrets, ["secrets/old.env"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(startFile(root), "utf8")).docker.volumes.map((v) => v.name), ["owners-data", "owners-orphan"]);

  // The run: a running app container on its own network with a data volume, a stopped test
  // container with an anonymous volume, a leftover network, and a generated secret.
  world.networks.push({ id: hex("3"), name: "app_default" }, { id: hex("4"), name: "test_net" });
  world.volumes.push("app-data", hex("f"));
  world.containers.push(
    { id: hex("b"), name: "app-db", image: "postgres:16", state: "running", status: "Up 2 hours", volumes: ["app-data"], networks: [hex("3")] },
    { id: hex("c"), name: "test-db", image: "postgres:16", state: "exited", status: "Exited (0) 5 minutes ago", volumes: [hex("f")], networks: [hex("4")] }
  );
  fs.mkdirSync(path.join(root, "secrets", "db"), { recursive: true });
  fs.writeFileSync(path.join(root, "secrets", "db", "password.txt"), "s3cret\n");

  calls.length = 0;
  const r = await finishFootprint(root, { run, config: ON });
  assert.deepEqual(r.removed.map((x) => [x.kind, x.name]), [["container", "test-db"], ["volume", hex("f")], ["network", "test_net"]]);
  assert.deepEqual(r.runningCreated.map((x) => [x.name, x.state]), [["app-db", "running"]]);
  assert.deepEqual(r.kept.map((x) => [x.kind, x.name, x.reason]), [["volume", "app-data", "a container uses it"], ["network", "app_default", "1 container uses it"]]);
  assert.deepEqual(r.secretsCreated, ["secrets/db/password.txt"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.dockerChecked, true);
  assert.ok(!JSON.stringify(r).includes("s3cret"), "secret values never appear");
  // Nothing the owner had before is touched: the stopped owners-db and the unused owners-orphan stay.
  assert.ok(world.containers.some((c) => c.name === "owners-db"));
  assert.ok(world.volumes.includes("owners-orphan"));
  assert.ok(!calls.some((c) => c.includes(hex("a")) || c.includes("owners-orphan")), "no command names what existed at the start");
  assert.ok(!calls.some((c) => /rm .*-f|--force/.test(c)), "never a forced removal");
  assert.equal(JSON.parse(fs.readFileSync(endFile(root), "utf8")).removed.length, 3);
  assert.equal(footprintLine(r), "removed 3 unused Docker objects the run created, 1 container it started still running, kept 2");
});

test("footprint.docker off, or remove false: nothing is removed and everything created is reported", async () => {
  for (const opts of [{ config: { footprint: { docker: false } } }, { config: ON, remove: false }]) {
    const root = tmp();
    const world = BASE();
    const { run, calls } = fakeDocker(world);
    await recordFootprintStart(root, { run });
    world.containers.push({ id: hex("c"), name: "test-db", image: "postgres:16", state: "exited" }, { id: hex("d"), name: "web", image: "nginx", state: "running" });
    world.volumes.push("scratch");
    world.networks.push({ id: hex("4"), name: "test_net" });
    calls.length = 0;
    const r = await finishFootprint(root, { run, ...opts });
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.kept.map((x) => x.name), ["test-db", "scratch", "test_net"]);
    assert.match(r.kept[0].reason, opts.remove === false ? /removal was not asked for/ : /footprint\.docker is off/);
    assert.deepEqual(r.runningCreated.map((x) => x.name), ["web"]);
    assert.ok(!calls.some((c) => / rm /.test(c)), "no removal command at all");
  }
});

test("the config switch is read from the project when no config is passed", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, footprint: { docker: false } }));
  const world = BASE();
  const { run } = fakeDocker(world);
  await recordFootprintStart(root, { run });
  world.volumes.push("scratch");
  const r = await finishFootprint(root, { run });
  assert.deepEqual([r.removed.length, r.kept.map((k) => k.name)], [0, ["scratch"]]);
});

test("Docker not installed, or its engine down: an empty report and no throw", async () => {
  for (const flag of ["absent", "engineDown", "throws"]) {
    const root = tmp();
    const world = { ...BASE(), [flag]: true };
    const { run } = fakeDocker(world);
    const start = await recordFootprintStart(root, { run });
    assert.equal(start.docker.available, false, flag);
    const r = await finishFootprint(root, { run, config: ON });
    assert.deepEqual([r.removed, r.kept, r.runningCreated, r.errors, r.dockerChecked], [[], [], [], [], false], flag);
    assert.equal(footprintLine(r), "Docker was not checked (not installed or not running)");
  }
  const snap = await dockerSnapshot(fakeDocker({ absent: true }).run);
  assert.match(snap.error, /not recognized/);
});

test("no baseline: nothing is removed, and the report says why", async () => {
  // No start file at all (a run started before this existed).
  let root = tmp();
  let world = BASE();
  let r = await finishFootprint(root, { run: fakeDocker(world).run, config: ON });
  assert.equal(r.removed.length, 0);
  assert.match(r.errors[0], /no footprint was recorded at run start/);

  // Docker came up during the run: what was there before cannot be told apart.
  root = tmp();
  world = { ...BASE(), engineDown: true };
  const fake = fakeDocker(world);
  await recordFootprintStart(root, { run: fake.run });
  world.engineDown = false;
  world.volumes.push("new-volume");
  fake.calls.length = 0;
  r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.equal(r.removed.length, 0);
  assert.match(r.errors[0], /Docker did not answer at run start.*nothing was removed \(6 Docker objects/);
  assert.ok(!fake.calls.some((c) => / rm /.test(c)));
});

test("a failed removal is kept with the reason; a name unsafe for a command is never used; things gone since the start are listed", async () => {
  const root = tmp();
  const world = BASE();
  const { run, calls } = fakeDocker(world);
  await recordFootprintStart(root, { run });
  world.rmFails = true;
  world.containers.push({ id: hex("c"), name: "test-db", image: "postgres:16", state: "exited" });
  world.volumes.push("bad name & calc");
  world.volumes = world.volumes.filter((v) => v !== "owners-orphan");
  const r = await finishFootprint(root, { run, config: ON });
  assert.deepEqual(r.kept.map((k) => [k.name, k.reason.split(":")[0]]), [["test-db", "docker rm failed"], ["bad name & calc", "its name is not one AutoClaude will put in a command"]]);
  assert.match(r.errors[0], /could not remove container test-db: container is running/);
  assert.ok(!calls.some((c) => c.includes("calc")), "the unsafe name never reaches a command");
  assert.deepEqual(r.goneSinceStart.map((g) => [g.kind, g.name]), [["volume", "owners-orphan"]]);
});

test("a kind that could not be listed at the start is never compared, so nothing of it looks new and nothing of it goes", async () => {
  const root = tmp();
  const world = BASE();
  const fake = fakeDocker(world);
  const flaky = async (cmd) => (cmd.startsWith("docker volume ls --format") ? { code: 1, stdout: "", stderr: "Error response from daemon: context deadline exceeded" } : fake.run(cmd));
  const start = await recordFootprintStart(root, { run: flaky });
  assert.deepEqual(start.docker.listed, { containers: true, volumes: false, networks: true });
  world.containers.push({ id: hex("c"), name: "test-db", image: "postgres:16", state: "exited" });
  fake.calls.length = 0;
  const r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(r.removed.map((x) => x.name), ["test-db"], "containers were listed both times");
  assert.ok(world.volumes.includes("owners-orphan"), "the owner's unused volume looked new but was not touched");
  assert.ok(!fake.calls.some((c) => c.startsWith("docker volume rm")));
  assert.match(r.errors.join("\n"), /volumes could not be listed at run start, so none were compared or removed/);
});

test("listSecrets lists names only, recursively, with forward slashes", () => {
  const root = tmp();
  assert.deepEqual(listSecrets(root), []);
  fs.mkdirSync(path.join(root, "secrets", "a"), { recursive: true });
  fs.writeFileSync(path.join(root, "secrets", "a", "k.pem"), "x");
  fs.writeFileSync(path.join(root, "secrets", "z.env"), "x");
  assert.deepEqual(listSecrets(root), ["secrets/a/k.pem", "secrets/z.env"]);
});

test("an old Docker without a State field: running and stopped are read from Status", async () => {
  const run = async (cmd) => {
    if (cmd.startsWith("docker version")) return { code: 0, stdout: "19.03\n", stderr: "" };
    if (cmd.startsWith("docker ps")) return { code: 0, stdout: [{ ID: "1", Names: "a", Status: "Up 3 minutes (Paused)" }, { ID: "2", Names: "b", Status: "Exited (1) 2 hours ago" }, { ID: "3", Names: "c", Status: "Up 1 second" }].map((x) => JSON.stringify(x)).join("\n"), stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  const snap = await dockerSnapshot(run);
  assert.deepEqual(snap.containers.map((c) => c.state), ["paused", "exited", "running"]);
});
