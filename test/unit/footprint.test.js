import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The config loader may read this computer's defaults; keep it away from the real Claude config.
process.env.CLAUDE_CONFIG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fp-cfg-"));

const { recordFootprintStart, finishFootprint, noteFootprint, dockerSnapshot, listSecrets, startFile, endFile, seenFile, footprintLine, hostPath, insideProject, composeName, projectIdentity, ENGINE_WAIT_MS, NOTE_TIMEOUT_MS } = await import("../../plugins/autoclaude/lib/footprint.js");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "autoclaude-fp-"));
const ON = { footprint: { docker: true } };
const T0 = "2026-09-28T10:00:00.123456789Z";
// Docker's creation dates: before the run start (T0), and during the run (the default).
const OLD = "2026-09-01T00:00:00Z";
const NEW = "2026-09-28T10:30:00.5Z";
const secs = (iso) => Math.floor(Date.parse(iso) / 1000);

// Compose's labels on a container of project `project` whose compose file is in `dir`.
const compose = (project, dir) => ({ "com.docker.compose.project": project, "com.docker.compose.project.working_dir": dir });

// A fake Docker: a mutable world and the commands AutoClaude sends it. Nothing reaches the real
// docker CLI. Containers: { id, name, image, state, status, volumes, networks (ids), labels, binds }.
// Volumes are names, with labels in world.volumeLabels; networks { id, name, labels, ingress }. Events are
// Docker's JSON events; the fake returns those whose `time` lies between --since and --until.
function fakeDocker(world) {
  world.engine = world.engine || { ID: "engine-a", Name: "docker-desktop", OSType: "linux", SystemTime: T0 };
  world.events = world.events || [];
  world.volumeLabels = world.volumeLabels || {};
  world.volumeCreated = world.volumeCreated || {};
  const born = (x) => (x && "created" in x ? x.created : NEW);
  const calls = [];
  const limits = [];
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const fail = (stderr) => ({ code: 1, stdout: "", stderr });
  const netName = (id) => (world.networks.find((n) => n.id === id) || {}).name || id;
  const inspectOf = (c) => ({
    Id: c.id,
    Name: `/${c.name}`,
    Created: born(c),
    Config: { Labels: c.labels || {} },
    Mounts: [...(c.volumes || []).map((v) => ({ Type: "volume", Name: v })), ...(c.binds || []).map((s) => ({ Type: "bind", Source: s }))],
    NetworkSettings: { Networks: Object.fromEntries((c.networks || []).map((id) => [netName(id), { NetworkID: id }])) }
  });
  // docker inspect prints the objects it found and fails on the first it did not.
  const inspect = (keys, find, shape) => {
    const found = keys.map(find);
    const missing = keys.filter((_, i) => !found[i]);
    return { code: missing.length ? 1 : 0, stdout: found.filter(Boolean).map((x) => JSON.stringify(shape(x))).join("\n"), stderr: missing.length ? `Error: No such object: ${missing[0]}` : "" };
  };
  const run = async (cmd, opts = {}) => {
    calls.push(cmd);
    limits.push([cmd, opts.timeoutMs]);
    if (world.throws) throw new Error("spawn failed");
    if (world.absent) return { code: 9009, stdout: "", stderr: "'docker' is not recognized as an internal or external command" };
    if (cmd === 'docker version --format "{{.Server.Version}}"') return world.engineDown ? fail("error during connect: the docker engine is not running") : ok("27.3.1\n");
    if (cmd === 'docker info --format "{{json .}}"') return world.infoFails ? fail("Cannot connect to the Docker daemon") : ok(JSON.stringify({ ...world.engine, ServerVersion: "27.3.1" }) + "\n");
    if (cmd === "docker context show") return ok("desktop-linux\n");
    if (cmd === 'docker ps -a --no-trunc --format "{{json .}}"') return ok(world.containers.map((c) => JSON.stringify({ ID: c.id, Names: c.name, Image: c.image, State: c.state, Status: c.status || "" })).join("\n") + "\n");
    if (cmd === 'docker volume ls --format "{{json .}}"') return ok(world.volumes.map((v) => JSON.stringify({ Name: v, Driver: "local" })).join("\n"));
    if (cmd === 'docker network ls --no-trunc --format "{{json .}}"') return ok(world.networks.map((n) => JSON.stringify({ ID: n.id, Name: n.name, Driver: "bridge" })).join("\n"));
    if (cmd === "docker volume ls -q --filter dangling=true") {
      const used = new Set(world.containers.flatMap((c) => c.volumes || []));
      return ok(world.volumes.filter((v) => !used.has(v)).join("\n"));
    }
    let m;
    if ((m = cmd.match(/^docker container inspect --format "\{\{json \.\}\}" (.+)$/))) return inspect(m[1].split(" "), (id) => world.containers.find((c) => c.id === id), inspectOf);
    if ((m = cmd.match(/^docker volume inspect --format "\{\{json \.\}\}" (.+)$/))) return inspect(m[1].split(" "), (v) => (world.volumes.includes(v) ? v : null), (v) => ({ Name: v, Driver: "local", CreatedAt: v in world.volumeCreated ? world.volumeCreated[v] : NEW, Labels: world.volumeLabels[v] || null }));
    if ((m = cmd.match(/^docker network inspect --format "\{\{json \.\}\}" (.+)$/))) return inspect(m[1].split(" "), (id) => world.networks.find((n) => n.id === id), (n) => ({ Id: n.id, Name: n.name, Created: born(n), Labels: n.labels || {}, Ingress: !!n.ingress }));
    if ((m = cmd.match(/^docker events --since (\d+) --until (\d+) --filter type=container --filter type=volume --filter type=network --filter event=create --filter event=mount --filter event=connect --format "\{\{json \.\}\}"$/))) {
      return ok(world.events.filter((e) => e.time >= Number(m[1]) && e.time <= Number(m[2])).map((e) => JSON.stringify(e)).join("\n"));
    }
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
  return { run, calls, limits };
}

const hex = (c) => c.repeat(64);
const BASE = () => ({
  containers: [{ id: hex("a"), name: "owners-db", image: "postgres:16", state: "exited", volumes: ["owners-data"], created: OLD }],
  volumes: ["owners-data", "owners-orphan"],
  volumeCreated: { "owners-data": OLD, "owners-orphan": OLD },
  networks: [{ id: hex("1"), name: "bridge", created: OLD }, { id: hex("2"), name: "host", created: OLD }]
});
const removals = (calls) => calls.filter((c) => / rm /.test(c));
const at = (world, iso) => { world.engine = { ...world.engine, SystemTime: iso }; };

test("start records Docker, its engine and the secrets folder; the finish removes only unused things the run created", async () => {
  const root = tmp();
  fs.mkdirSync(path.join(root, "secrets"));
  fs.writeFileSync(path.join(root, "secrets", "old.env"), "OLD=1\n");
  const world = BASE();
  const { run, calls } = fakeDocker(world);
  const start = await recordFootprintStart(root, { run });
  assert.equal(start.docker.available, true);
  assert.equal(start.docker.version, "27.3.1");
  assert.deepEqual(start.docker.engine, { id: "engine-a", name: "docker-desktop", os: "linux", context: "desktop-linux", time: T0 });
  assert.deepEqual(start.docker.containers.map((c) => [c.name, c.state]), [["owners-db", "exited"]]);
  assert.deepEqual(start.secrets, ["secrets/old.env"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(startFile(root), "utf8")).docker.volumes.map((v) => v.name), ["owners-data", "owners-orphan"]);

  // The run: a running app container on its own network with a data volume, a stopped test
  // container (compose file in a subfolder) with an anonymous volume on a leftover network, and
  // a generated secret.
  world.networks.push({ id: hex("3"), name: "app_default" }, { id: hex("4"), name: "test_net" });
  world.volumes.push("app-data", hex("f"));
  world.containers.push(
    { id: hex("b"), name: "app-db", image: "postgres:16", state: "running", status: "Up 2 hours", volumes: ["app-data"], networks: [hex("3")], labels: compose("app", root) },
    { id: hex("c"), name: "test-db", image: "postgres:16", state: "exited", status: "Exited (0) 5 minutes ago", volumes: [hex("f")], networks: [hex("4")], labels: compose("stack", path.join(root, "test", "stack")) }
  );
  fs.mkdirSync(path.join(root, "secrets", "db"), { recursive: true });
  fs.writeFileSync(path.join(root, "secrets", "db", "password.txt"), "s3cret\n");

  calls.length = 0;
  const r = await finishFootprint(root, { run, config: ON });
  assert.deepEqual(r.removed.map((x) => [x.kind, x.name]), [["container", "test-db"], ["volume", hex("f")], ["network", "test_net"]]);
  assert.deepEqual(r.removed.map((x) => x.attributedBy), ["its compose folder is in the project", "test-db uses it", "test-db uses it"]);
  assert.deepEqual(r.runningCreated.map((x) => [x.name, x.state]), [["app-db", "running"]]);
  assert.deepEqual(r.kept.map((x) => [x.kind, x.name, x.reason]), [["volume", "app-data", "a container uses it"], ["network", "app_default", "1 container uses it"]]);
  assert.deepEqual(r.unattributed, []);
  assert.deepEqual(r.secretsCreated, ["secrets/db/password.txt"]);
  assert.deepEqual(r.errors, []);
  assert.equal(r.dockerChecked, true);
  assert.ok(!JSON.stringify(r).includes("s3cret"), "secret values never appear");
  // Nothing the owner had before is touched: the stopped owners-db and the unused owners-orphan stay.
  assert.ok(world.containers.some((c) => c.name === "owners-db"));
  assert.ok(world.volumes.includes("owners-orphan"));
  assert.ok(!removals(calls).some((c) => c.includes(hex("a")) || c.includes("owners-orphan")), "no removal names what existed at the start");
  assert.ok(!calls.some((c) => /rm .*-f|--force/.test(c)), "never a forced removal");
  assert.equal(JSON.parse(fs.readFileSync(endFile(root), "utf8")).removed.length, 3);
  assert.equal(footprintLine(r), "removed 3 unused Docker objects the run created, 1 container it started still running, kept 2");
});

test("objects another project or the owner made during the run are reported, never removed", async () => {
  const root = tmp();
  const other = tmp();
  const world = BASE();
  const { run, calls } = fakeDocker(world);
  await recordFootprintStart(root, { run });

  // Another project's stack, stopped (`docker compose stop`): an exited container on its network,
  // with its data volume, and one of its containers still running.
  world.networks.push({ id: hex("5"), name: "otherproj_default", labels: { "com.docker.compose.project": "otherproj" } });
  world.volumes.push("otherproj_pgdata");
  world.volumeLabels.otherproj_pgdata = { "com.docker.compose.project": "otherproj" };
  world.containers.push(
    { id: hex("6"), name: "otherproj-db-1", image: "postgres:16", state: "exited", volumes: ["otherproj_pgdata"], networks: [hex("5")], labels: compose("otherproj", other) },
    { id: hex("7"), name: "otherproj-web-1", image: "nginx", state: "running", networks: [hex("5")], labels: compose("otherproj", other) }
  );
  // Another project taken down (`docker compose down` keeps named volumes): a dangling volume.
  world.volumes.push("gone_pgdata");
  world.volumeLabels.gone_pgdata = { "com.docker.compose.project": "gone" };
  // The owner's own `docker run` with an anonymous volume, and a dangling anonymous volume.
  world.volumes.push(hex("8"), hex("9"));
  world.containers.push({ id: hex("d"), name: "scratchpad", image: "alpine", state: "exited", volumes: [hex("9")] });
  // And one of this run's own test containers, which does go, with its volume.
  world.volumes.push("ours_data");
  world.containers.push({ id: hex("e"), name: "ours-db", image: "postgres:16", state: "exited", volumes: ["ours_data"], labels: compose("ours", root) });

  calls.length = 0;
  const r = await finishFootprint(root, { run, config: ON });
  assert.deepEqual(r.removed.map((x) => x.name), ["ours-db", "ours_data"]);
  assert.deepEqual(r.runningCreated, [], "a container another project runs is not listed as started by the run");
  assert.deepEqual(r.kept, []);
  assert.deepEqual(r.unattributed.map((x) => [x.kind, x.name]), [
    ["container", "otherproj-db-1"], ["container", "otherproj-web-1"], ["container", "scratchpad"],
    ["volume", "otherproj_pgdata"], ["volume", "gone_pgdata"], ["volume", hex("8")], ["volume", hex("9")],
    ["network", "otherproj_default"]
  ]);
  const why = Object.fromEntries(r.unattributed.map((x) => [x.name, x.reason]));
  assert.match(why["otherproj-db-1"], new RegExp(`^new since the run started, but its compose folder is outside this project \\(${other.replace(/\\/g, "\\\\")}\\); it may be another project's or yours, so the run left it alone$`));
  assert.match(why.gone_pgdata, /but it belongs to the compose project gone;/);
  assert.match(why.scratchpad, /but nothing ties it to this project;/);
  assert.equal(r.unattributed.find((x) => x.name === "otherproj-web-1").state, "running");
  for (const name of ["otherproj", "gone_pgdata", hex("5"), hex("6"), hex("8"), hex("9"), hex("d")]) {
    assert.ok(!removals(calls).some((c) => c.includes(name)), `nothing removes ${name}`);
  }
  assert.ok(world.volumes.includes("otherproj_pgdata") && world.volumes.includes("gone_pgdata"), "the other projects' data volumes are still there");
  assert.equal(footprintLine(r), "removed 2 unused Docker objects the run created, left alone 8 new Docker objects not tied to this project");
});

test("a note ties a volume whose container is gone by the end; Docker's events tie one whose container came and went between looks", async () => {
  const setup = async (withNote) => {
    const root = tmp();
    const other = tmp();
    const world = BASE();
    const fake = fakeDocker(world);
    await recordFootprintStart(root, { run: fake.run });
    // During a step: this project's stack runs, with an anonymous volume and its network.
    world.networks.push({ id: hex("6"), name: "api_default", labels: {} });
    world.volumes.push(hex("7"));
    world.containers.push({ id: hex("b"), name: "api-1", image: "node:24", state: "running", volumes: [hex("7")], networks: [hex("6")], labels: { ...compose("api", root), "com.docker.compose.project": "api" } });
    at(world, "2026-09-28T11:00:00Z");
    const note = withNote ? await noteFootprint(root, { run: fake.run }) : null;
    // `docker compose down`: the container and the network go, the anonymous volume stays.
    world.containers = world.containers.filter((c) => c.id !== hex("b"));
    world.networks = world.networks.filter((n) => n.id !== hex("6"));
    // Later a test run starts and removes two containers the end never sees: one of this
    // project's, and one of another folder's. Each leaves a volume.
    const t = secs("2026-09-28T11:30:00Z");
    world.events.push(
      { Type: "container", Action: "create", Actor: { ID: hex("c"), Attributes: { ...compose("dbtest", path.join(root, "test")), name: "dbtest-db-1", image: "postgres:16" } }, time: t },
      { Type: "volume", Action: "mount", Actor: { ID: "dbtest_tmp", Attributes: { container: hex("c"), destination: "/data" } }, time: t + 1 },
      { Type: "container", Action: "create", Actor: { ID: hex("d"), Attributes: { ...compose("theirs", other), name: "theirs-1", image: "redis" } }, time: t + 2 },
      { Type: "volume", Action: "mount", Actor: { ID: "their_tmp", Attributes: { container: hex("d"), destination: "/data" } }, time: t + 3 }
    );
    world.volumes.push("dbtest_tmp", "their_tmp");
    at(world, "2026-09-28T12:00:00Z");
    fake.calls.length = 0;
    return { root, world, fake, note, r: await finishFootprint(root, { run: fake.run, config: ON }) };
  };

  const a = await setup(true);
  assert.deepEqual(a.note, { ok: true, containers: 1, volumes: 1, networks: 1 });
  assert.equal(JSON.parse(fs.readFileSync(seenFile(a.root), "utf8")).volumes[hex("7")].why, "api-1 uses it");
  assert.deepEqual(a.r.removed.map((x) => [x.name, x.attributedBy]), [[hex("7"), "api-1 uses it"], ["dbtest_tmp", "dbtest-db-1 used it"]]);
  assert.deepEqual(a.r.unattributed.map((x) => x.name), ["their_tmp"]);
  // The events read at the end starts where the note's stopped, on the engine's own clock.
  assert.ok(a.fake.calls.some((c) => c.startsWith(`docker events --since ${secs("2026-09-28T11:00:00Z") - 5} --until ${secs("2026-09-28T12:00:00Z")} `)));
  assert.ok(!removals(a.fake.calls).some((c) => c.includes("their_tmp")));

  // Without the note nothing ties the anonymous volume any more: it is reported, not removed.
  const b = await setup(false);
  assert.deepEqual(b.r.removed.map((x) => x.name), ["dbtest_tmp"]);
  assert.deepEqual(b.r.unattributed.map((x) => x.name), [hex("7"), "their_tmp"]);
});

test("compose names: the project's compose file names it, a folder name alone proves nothing, and a name another folder also uses ties nothing", async () => {
  const scenario = async ({ files = {}, project, contested = false }) => {
    const root = tmp();
    for (const [f, text] of Object.entries(files)) fs.writeFileSync(path.join(root, f), text);
    const world = BASE();
    const fake = fakeDocker(world);
    await recordFootprintStart(root, { run: fake.run });
    const name = typeof project === "function" ? project(root) : project;
    world.volumes.push(`${name}_data`);
    world.volumeLabels[`${name}_data`] = { "com.docker.compose.project": name };
    if (contested) world.containers.push({ id: hex("9"), name: `${name}-web-1`, image: "nginx", state: "running", labels: compose(name, tmp()) });
    return finishFootprint(root, { run: fake.run, config: ON });
  };

  let r = await scenario({ files: { "compose.yaml": "name: shop\nservices:\n  db:\n    image: postgres:16\n    container_name: other\n" }, project: "shop" });
  assert.deepEqual(r.removed.map((x) => [x.name, x.attributedBy]), [["shop_data", "its compose project, shop, is this project's"]]);

  r = await scenario({ files: { ".env": "COMPOSE_PROJECT_NAME=shop2\n" }, project: "shop2" });
  assert.deepEqual(r.removed.map((x) => x.name), ["shop2_data"], "COMPOSE_PROJECT_NAME in the project's .env");

  r = await scenario({ files: { "compose.yaml": "name: shop\n" }, project: "shop", contested: true });
  assert.deepEqual(r.removed, []);
  assert.deepEqual(r.unattributed.map((x) => x.name), ["shop-web-1", "shop_data"]);
  assert.match(r.unattributed[1].reason, /it belongs to the compose project shop, which a container from another folder also uses;/);

  const byFolder = (root) => composeName(path.basename(root));
  r = await scenario({ project: byFolder });
  assert.deepEqual([r.removed.length, r.unattributed.length], [0, 1], "no compose file: the folder name ties nothing");
  r = await scenario({ files: { "docker-compose.yml": "services: {}\n" }, project: byFolder });
  assert.equal(r.removed.length, 1, "with a compose file, compose's default name from the folder is the project's");
});

test("an object Docker dates before the run start is never the run's, even when the run-start list missed it", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "compose.yaml"), "name: shop\n");
  const world = BASE();
  const fake = fakeDocker(world);
  // The owner's own dev stack of this project, from before the run: a stopped database and its data.
  world.volumes.push("shop_data");
  world.volumeCreated.shop_data = OLD;
  world.volumeLabels.shop_data = { "com.docker.compose.project": "shop" };
  world.containers.push({ id: hex("b"), name: "shop-db-1", image: "postgres:16", state: "exited", volumes: ["shop_data"], labels: compose("shop", root), created: OLD });
  // At the start a cache answered for a waking engine: empty lists, and no error.
  const cached = async (cmd, o) => (/^docker (ps -a --no-trunc|volume ls --format|network ls)/.test(cmd) ? { code: 0, stdout: "", stderr: "" } : fake.run(cmd, o));
  const start = await recordFootprintStart(root, { run: cached });
  assert.deepEqual([start.docker.containers, start.docker.volumes, start.docker.listed.volumes], [[], [], true]);
  // During the run: a new cache volume of the project, and one Docker gives no date for.
  world.volumes.push("shop_cache", "shop_tmp");
  world.volumeLabels.shop_cache = world.volumeLabels.shop_tmp = { "com.docker.compose.project": "shop" };
  world.volumeCreated.shop_tmp = null;
  fake.calls.length = 0;
  const r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(r.removed.map((x) => x.name), ["shop_cache"]);
  assert.ok(world.volumes.includes("shop_data") && world.containers.some((c) => c.name === "shop-db-1"), "the owner's database and its data are still there");
  for (const name of ["shop-db-1", "shop_data", "owners-db", "owners-data", "owners-orphan"]) assert.ok(!removals(fake.calls).some((c) => c.includes(name) || c.includes(hex(name === "shop-db-1" ? "b" : "a"))), name);
  const why = Object.fromEntries(r.unattributed.map((x) => [x.name, x.reason]));
  assert.equal(why["shop-db-1"], `the run-start record does not list it, but Docker dates it ${OLD}, before the run started; the run left it alone`);
  assert.equal(why.shop_data, why["shop-db-1"]);
  assert.equal(why.shop_tmp, "Docker did not say when it was created, so it cannot be shown to be new; the run left it alone");
});

test("a note's tie that rests on a compose name unties when another folder turns out to use the name; a folder's tie stands", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "compose.yaml"), "name: shop\n");
  const world = BASE();
  const fake = fakeDocker(world);
  await recordFootprintStart(root, { run: fake.run });
  world.volumes.push("shop_cache", "shop_data");
  world.containers.push(
    // Tied only by its compose name (no compose folder label).
    { id: hex("b"), name: "shop-old-1", image: "redis", state: "running", volumes: ["shop_cache", "shop_data"], labels: { "com.docker.compose.project": "shop" } },
    // Tied by its compose folder, and using one of the same volumes.
    { id: hex("c"), name: "shop-db-1", image: "postgres:16", state: "running", volumes: ["shop_data"], labels: compose("shop", root) }
  );
  assert.equal((await noteFootprint(root, { run: fake.run })).ok, true);
  const seen = JSON.parse(fs.readFileSync(seenFile(root), "utf8"));
  assert.deepEqual([seen.volumes.shop_cache, seen.volumes.shop_data], [{ why: "shop-old-1 uses it", via: "shop", created: NEW, labels: {} }, { why: "shop-db-1 uses it", created: NEW, labels: {} }], "the folder's tie replaces the name's");
  // Both go (`docker compose down`), and a container of another folder's "shop" project appears.
  world.containers = world.containers.filter((c) => !["shop-old-1", "shop-db-1"].includes(c.name));
  world.containers.push({ id: hex("d"), name: "shop-web-1", image: "nginx", state: "running", labels: compose("shop", tmp()) });
  const r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(r.removed.map((x) => [x.name, x.attributedBy]), [["shop_data", "shop-db-1 uses it"]]);
  assert.deepEqual(r.unattributed.map((x) => x.name), ["shop-web-1", "shop_cache"]);
});

test("a volume's tie is to the one volume the run saw: another made later under the same name is reported, never removed", async () => {
  const runs = { "com.docker.compose.project": "proj", "com.docker.compose.volume": "pgdata" };
  // The run's stack uses a plainly named volume, pgdata, seen by a note or only in Docker's events
  // (a container that came and went between looks). The run's teardown (`down -v`) removes the
  // container and the volume; `again` then makes a pgdata once more, which is unused at the end.
  const scenario = async ({ note = true, byEvents = false, again }) => {
    const root = tmp();
    const world = BASE();
    const fake = fakeDocker(world);
    await recordFootprintStart(root, { run: fake.run });
    const db = { id: hex("b"), name: "proj-db-1", image: "postgres:16", state: "running", volumes: ["pgdata"], labels: compose("proj", root) };
    world.volumes.push("pgdata");
    world.volumeLabels.pgdata = runs;
    if (byEvents) {
      world.events.push(
        { Type: "container", Action: "create", Actor: { ID: db.id, Attributes: { ...db.labels, name: db.name } }, time: secs(NEW) },
        { Type: "volume", Action: "mount", Actor: { ID: "pgdata", Attributes: { container: db.id } }, time: secs(NEW) + 1 }
      );
    } else world.containers.push(db);
    at(world, "2026-09-28T11:00:00Z");
    const noted = note ? await noteFootprint(root, { run: fake.run }) : null;
    world.containers = world.containers.filter((c) => c.id !== db.id);
    world.volumes = world.volumes.filter((v) => v !== "pgdata");
    await again(world, root, () => noteFootprint(root, { run: fake.run }));
    at(world, "2026-09-28T12:00:00Z");
    fake.calls.length = 0;
    return { root, world, calls: fake.calls, noted, r: await finishFootprint(root, { run: fake.run, config: ON }) };
  };
  // A pgdata made again with this date and these labels: by another project or the owner
  // (`docker run --rm -v pgdata:...`), or the very volume the run used when both match.
  const remade = (created, labels = null) => async (world) => { world.volumes.push("pgdata"); world.volumeCreated.pgdata = created; world.volumeLabels.pgdata = labels; };
  const left = (s) => { assert.ok(s.world.volumes.includes("pgdata")); assert.deepEqual(removals(s.calls), [], "nothing is removed"); };

  // The review's case: the note's tie was to the run's pgdata; the one at the end is another's.
  let s = await scenario({ again: remade("2026-09-28T11:40:00Z") });
  assert.deepEqual(s.noted, { ok: true, containers: 1, volumes: 1, networks: 0 });
  assert.deepEqual(JSON.parse(fs.readFileSync(seenFile(s.root), "utf8")).volumes.pgdata, { why: "proj-db-1 uses it", created: NEW, labels: runs }, "the tie says which volume");
  assert.deepEqual(s.r.removed, []);
  assert.deepEqual(s.r.unattributed.map((x) => [x.kind, x.name, x.reason]), [["volume", "pgdata", `new since the run started, but the volume the run noted under this name (proj-db-1 uses it) was another one: Docker made that one ${NEW}, this one 2026-09-28T11:40:00Z; it may be another project's or yours, so the run left it alone`]]);
  left(s);

  // Made again within the same second, but without the run's labels: still another volume.
  s = await scenario({ again: remade(NEW) });
  assert.deepEqual([s.r.removed, s.r.unattributed.map((x) => x.name)], [[], ["pgdata"]]);
  assert.match(s.r.unattributed[0].reason, /\(proj-db-1 uses it\) was another one: their labels differ;/);
  left(s);

  // No note, only the events: a mount before Docker made this pgdata was of another volume.
  s = await scenario({ note: false, byEvents: true, again: remade("2026-09-28T11:40:00Z") });
  assert.deepEqual([s.r.removed, s.r.unattributed.map((x) => [x.name, x.reason])], [[], [["pgdata", "new since the run started, but nothing ties it to this project; it may be another project's or yours, so the run left it alone"]]]);
  left(s);

  // The volume the run used, still there (same date, same labels): it goes, by the events' tie.
  s = await scenario({ note: false, byEvents: true, again: remade(NEW, runs) });
  assert.deepEqual(s.r.removed.map((x) => [x.name, x.attributedBy]), [["pgdata", "proj-db-1 used it"]]);

  // The run makes its pgdata again in a later step and a note sees it: that tie replaces the old one.
  s = await scenario({
    again: async (world, root, note) => {
      await remade("2026-09-28T11:30:00Z", runs)(world);
      world.containers.push({ id: hex("c"), name: "proj-db-1", image: "postgres:16", state: "running", volumes: ["pgdata"], labels: compose("proj", root) });
      at(world, "2026-09-28T11:45:00Z");
      await note();
      world.containers = world.containers.filter((c) => c.id !== hex("c")); // `down` keeps the named volume
    }
  });
  assert.deepEqual(s.r.removed.map((x) => [x.name, x.attributedBy]), [["pgdata", "proj-db-1 uses it"]]);
  assert.equal(JSON.parse(fs.readFileSync(seenFile(s.root), "utf8")).volumes.pgdata.created, "2026-09-28T11:30:00Z");
});

test("Docker's own networks are never the run's: the default one made again by an engine restart, nat on a Windows engine, a swarm's ingress", async () => {
  for (const os of ["linux", "windows"]) {
    const dflt = os === "linux" ? "bridge" : "nat";
    const root = tmp();
    const world = BASE();
    world.engine = { ID: "engine-a", Name: "docker-desktop", OSType: os, SystemTime: T0 };
    world.networks = [{ id: hex("1"), name: dflt, created: OLD }, { id: hex("2"), name: "none", created: OLD }];
    // The owner's cache, running on the default network since before the run.
    world.containers.push({ id: hex("d"), name: "owners-cache", image: "redis", state: "running", networks: [hex("1")], created: OLD });
    const fake = fakeDocker(world);
    await recordFootprintStart(root, { run: fake.run });

    // Resource Saver stopped the idle engine and the next docker call woke it: Docker made its
    // default network again, with a new id and date, and the owner's cache came back on it.
    world.networks[0] = { id: hex("e"), name: dflt, created: "2026-09-28T10:20:00Z" };
    world.containers.find((c) => c.name === "owners-cache").networks = [hex("e")];
    // On a Linux engine nat is a name like any other: a network the run makes under it is the run's.
    const nat = os === "linux" ? [{ id: hex("9"), name: "nat" }] : [];
    world.networks.push(...nat);
    // The run's lint container (a bind mount of the project), stopped, on the default network; a
    // container of the run's that came and went, connected to it; and a swarm the owner started.
    world.containers.push({ id: hex("c"), name: "lint-run", image: "node:24", state: "exited", networks: [hex("e"), ...nat.map((n) => n.id)], binds: [path.join(root, "src")] });
    world.events.push(
      { Type: "container", Action: "create", Actor: { ID: hex("b"), Attributes: { ...compose("proj", root), name: "proj-web-1" } }, time: secs(NEW) },
      { Type: "network", Action: "connect", Actor: { ID: hex("e"), Attributes: { container: hex("b"), name: dflt, type: dflt } }, time: secs(NEW) + 1 }
    );
    world.networks.push({ id: hex("7"), name: "ingress", ingress: true });

    at(world, "2026-09-28T11:00:00Z");
    assert.equal((await noteFootprint(root, { run: fake.run })).ok, true);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(seenFile(root), "utf8")).networks), nat.map((n) => n.id), `${os}: nothing is noted of Docker's own networks`);
    at(world, "2026-09-28T12:00:00Z");
    fake.calls.length = 0;
    const r = await finishFootprint(root, { run: fake.run, config: ON });
    assert.deepEqual(r.removed.map((x) => [x.kind, x.name]), [["container", "lint-run"], ...nat.map((n) => ["network", n.name])], os);
    assert.deepEqual([r.kept, r.unattributed, r.goneSinceStart, r.errors], [[], [], [], []], `${os}: Docker's own networks are not reported at all`);
    assert.ok(!fake.calls.some((c) => c.startsWith("docker network rm") && !nat.some((n) => c.endsWith(n.id))), `${os}: no removal of Docker's own networks`);
    assert.equal(footprintLine(r), `removed ${1 + nat.length} unused Docker object${nat.length ? "s" : ""} the run created`);
  }
});

test("a bind mount from the project ties a plain container; a compose folder elsewhere wins over a mount; a mount of a parent folder ties nothing", async () => {
  const root = tmp();
  const world = BASE();
  const fake = fakeDocker(world);
  await recordFootprintStart(root, { run: fake.run });
  world.containers.push(
    { id: hex("b"), name: "e2e", image: "playwright", state: "exited", binds: [path.join(root, "test")] },
    { id: hex("c"), name: "their-tool", image: "alpine", state: "exited", binds: [root], labels: compose("x", tmp()) },
    { id: hex("d"), name: "home-backup", image: "alpine", state: "exited", binds: [path.dirname(root)] },
    { id: hex("e"), name: "sibling", image: "alpine", state: "exited", binds: [`${root}-other`] }
  );
  const r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(r.removed.map((x) => [x.name, x.attributedBy]), [["e2e", `it mounts ${path.join(root, "test")} from the project`]]);
  assert.deepEqual(r.unattributed.map((x) => x.name), ["their-tool", "home-backup", "sibling"]);
});

test("another engine at the end, or no engine on record: nothing is compared or removed", async () => {
  const root = tmp();
  const world = BASE();
  const fake = fakeDocker(world);
  await recordFootprintStart(root, { run: fake.run });
  world.volumes.push("ours_data");
  world.containers.push({ id: hex("b"), name: "ours-db", image: "postgres:16", state: "exited", volumes: ["ours_data"], labels: compose("ours", root) });

  // A deploy step ran `docker context use buildhost`: the end talks to another engine, where
  // everything looks new, including a stack deployed from this very folder whose database is
  // stopped. Its labels tie it to the project; only the engine check keeps it.
  const local = { engine: world.engine, containers: world.containers, volumes: world.volumes, networks: world.networks };
  Object.assign(world, {
    engine: { ID: "engine-b", Name: "buildhost", OSType: "linux", SystemTime: "2026-09-28T12:00:00Z" },
    containers: [{ id: hex("9"), name: "prod-db-1", image: "postgres:16", state: "exited", volumes: ["prod_pgdata"], networks: [hex("8")], labels: compose("prod", root) }],
    volumes: ["prod_pgdata"],
    networks: [{ id: hex("8"), name: "prod_default" }]
  });
  fake.calls.length = 0;
  let r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(removals(fake.calls), []);
  assert.deepEqual([r.removed, r.kept, r.unattributed, r.goneSinceStart], [[], [], [], []]);
  assert.deepEqual(r.errors, ["Docker now answers from another engine (buildhost, context desktop-linux) than at run start (docker-desktop, context desktop-linux), so nothing was compared or removed"]);
  assert.match((await noteFootprint(root, { run: fake.run })).reason, /another engine/, "a note on another engine records nothing");
  assert.ok(!fs.existsSync(seenFile(root)));

  // The engine does not say who it is.
  Object.assign(world, local);
  world.infoFails = true;
  r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.match(r.errors.join("\n"), /Docker did not say which engine answers now \(Cannot connect to the Docker daemon\), so nothing was compared or removed/);
  world.infoFails = false;

  // A start record written before engines were recorded.
  const record = JSON.parse(fs.readFileSync(startFile(root), "utf8"));
  delete record.docker.engine;
  fs.writeFileSync(startFile(root), JSON.stringify(record));
  fake.calls.length = 0;
  r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.match(r.errors[0], /^the run-start record does not say which Docker engine it was taken on, so nothing was compared or removed$/);
  assert.deepEqual(removals(fake.calls), []);
  assert.ok(world.volumes.includes("ours_data"));

  // The same engine again: now it goes.
  record.docker.engine = { id: local.engine.ID, name: "docker-desktop", os: "linux", context: "desktop-linux", time: T0 };
  fs.writeFileSync(startFile(root), JSON.stringify(record));
  r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(r.removed.map((x) => x.name), ["ours-db", "ours_data"]);
});

test("a cold engine: the container listing waits longer than every other call; a deadline bounds them all", async () => {
  const root = tmp();
  const world = BASE();
  const fake = fakeDocker(world);
  await recordFootprintStart(root, { run: fake.run });
  const limitOf = (prefix) => fake.limits.filter(([c]) => c.startsWith(prefix)).map(([, ms]) => ms);
  assert.deepEqual(limitOf("docker ps -a --no-trunc"), [ENGINE_WAIT_MS]);
  assert.ok(ENGINE_WAIT_MS >= 180000, "longer than Docker Desktop's measured cold start");
  assert.deepEqual([...new Set(fake.limits.filter(([c]) => !c.startsWith("docker ps -a --no-trunc")).map(([, ms]) => ms))], [60000]);

  fake.limits.length = 0;
  await noteFootprint(root, { run: fake.run });
  assert.deepEqual([...new Set(fake.limits.map(([, ms]) => ms))], [NOTE_TIMEOUT_MS], "a note is short in every call");

  fake.limits.length = 0;
  await finishFootprint(root, { run: fake.run, config: ON, deadline: Date.now() + 30000 });
  assert.ok(fake.limits.length && fake.limits.every(([, ms]) => ms <= 30000), "no call outlives the deadline");

  fake.calls.length = 0;
  const late = await finishFootprint(root, { run: fake.run, config: ON, deadline: Date.now() - 1 });
  assert.deepEqual([fake.calls, late.dockerChecked, late.removed], [[], false, []], "past the deadline, Docker is not called at all");

  // The container listing still timed out at the start: containers are never compared or removed.
  const root2 = tmp();
  const world2 = BASE();
  const fake2 = fakeDocker(world2);
  const cold = async (cmd, o) => (cmd.startsWith("docker ps -a --no-trunc") ? { code: null, stdout: "", stderr: "timed out after 240 s" } : fake2.run(cmd, o));
  const start = await recordFootprintStart(root2, { run: cold });
  assert.deepEqual(start.docker.listed, { containers: false, volumes: true, networks: true });
  world2.containers.push({ id: hex("b"), name: "ours-db", image: "postgres:16", state: "exited", labels: compose("ours", root2) });
  const r = await finishFootprint(root2, { run: fake2.run, config: ON });
  assert.deepEqual(r.removed, []);
  assert.ok(world2.containers.some((c) => c.name === "ours-db"));
  assert.match(r.errors.join("\n"), /containers could not be listed at run start, so none were compared or removed/);
});

test("a new run clears the last run's record and notes before its slow snapshot; notes of another run tie nothing", async () => {
  const root = tmp();
  fs.mkdirSync(path.dirname(startFile(root)), { recursive: true });
  fs.writeFileSync(startFile(root), JSON.stringify({ at: "2026-01-01T00:00:00.000Z", docker: { available: true, containers: [], volumes: [], networks: [] }, secrets: [] }));
  fs.writeFileSync(seenFile(root), "{}");
  const world = BASE();
  const fake = fakeDocker(world);
  const leftovers = [];
  const watch = async (cmd, o) => { leftovers.push(fs.existsSync(startFile(root)) || fs.existsSync(seenFile(root))); return fake.run(cmd, o); };
  const start = await recordFootprintStart(root, { run: watch });
  assert.ok(leftovers.length && leftovers.every((x) => x === false), "no earlier record exists while the snapshot runs");
  assert.ok(!fs.existsSync(seenFile(root)));

  // Notes written for another run (another start time) are ignored.
  world.volumes.push("stale_vol");
  fs.writeFileSync(seenFile(root), JSON.stringify({ startAt: "2026-01-01T00:00:00.000Z", engine: "engine-a", containers: {}, volumes: { stale_vol: { why: "old-1 uses it" } }, networks: {}, projects: [], contested: [] }));
  let r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual([r.removed, r.unattributed.map((x) => x.name)], [[], ["stale_vol"]]);
  // This run's note without the volume's date (as 0.10.1 wrote them) does not say which volume it saw.
  fs.writeFileSync(seenFile(root), JSON.stringify({ startAt: start.at, engine: "engine-a", containers: {}, volumes: { stale_vol: { why: "old-1 uses it" } }, networks: {}, projects: [], contested: [] }));
  r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual([r.removed, r.unattributed.map((x) => x.reason)], [[], ["new since the run started, but the volume the run noted under this name (old-1 uses it) cannot be shown to be this one: the note does not say when Docker made it; it may be another project's or yours, so the run left it alone"]]);
  // The same notes for this run, with the volume's date, do tie it.
  fs.writeFileSync(seenFile(root), JSON.stringify({ startAt: start.at, engine: "engine-a", containers: {}, volumes: { stale_vol: { why: "old-1 uses it", created: NEW } }, networks: {}, projects: [], contested: [] }));
  r = await finishFootprint(root, { run: fake.run, config: ON });
  assert.deepEqual(r.removed.map((x) => x.name), ["stale_vol"]);
});

test("hostPath and insideProject read Docker's spellings of a folder; composeName follows compose's rule", () => {
  assert.equal(hostPath("C:\\Work\\App\\", "win32"), "c:/work/app");
  assert.equal(hostPath("/mnt/c/Work/App/sub", "win32"), "c:/work/app/sub");
  assert.equal(hostPath("/run/desktop/mnt/host/c/Work/App", "win32"), "c:/work/app");
  assert.equal(hostPath("/host_mnt/c/Work/App", "win32"), "c:/work/app");
  assert.equal(hostPath("C:\\", "win32"), "c:/");
  assert.equal(hostPath("/host_mnt/Users/me/app", "darwin"), "/users/me/app");
  assert.equal(hostPath("/home/Me/app/", "linux"), "/home/Me/app");
  const id = { roots: [hostPath("C:\\Work\\App", "win32")], platform: "win32" };
  assert.equal(insideProject("/mnt/c/work/app/test", id), true);
  assert.equal(insideProject("C:/WORK/APP", id), true);
  assert.equal(insideProject("C:\\Work\\AppOther", id), false, "a sibling that shares the prefix is not inside");
  assert.equal(insideProject("C:\\Work", id), false, "the parent is not inside");
  assert.equal(composeName("My App!"), "myapp");
  assert.equal(composeName("_-x.y"), "xy");

  const root = tmp();
  assert.deepEqual([...projectIdentity(root).names], [], "no compose file, no .env: no names");
  fs.writeFileSync(path.join(root, ".env"), "# x\nCOMPOSE_PROJECT_NAME=Shop_X\n");
  fs.writeFileSync(path.join(root, "compose.yml"), "name: ${NAME:-x}\n");
  assert.deepEqual([...projectIdentity(root).names].sort(), [composeName(path.basename(root)), "shop_x"].sort(), "an interpolated name is not read");
});

test("noteFootprint: nothing without a usable start record; never removes; notes only what is new", async () => {
  const root = tmp();
  const world = BASE();
  const fake = fakeDocker(world);
  assert.equal((await noteFootprint(root, { run: fake.run })).ok, false, "no start record");
  assert.deepEqual(fake.calls, [], "no start record: Docker is not called");
  await recordFootprintStart(root, { run: fake.run });
  // A container of this project that was already there at the start is not noted.
  world.containers[0].labels = compose("owners", root);
  world.containers.push({ id: hex("b"), name: "ours-web", image: "nginx", state: "running", volumes: ["owners-data"], labels: compose("ours", root) });
  fake.calls.length = 0;
  const n = await noteFootprint(root, { run: fake.run });
  assert.deepEqual(n, { ok: true, containers: 1, volumes: 0, networks: 0 });
  assert.deepEqual(removals(fake.calls), []);
  const seen = JSON.parse(fs.readFileSync(seenFile(root), "utf8"));
  assert.deepEqual(Object.keys(seen.containers), [hex("b")]);
  assert.deepEqual(seen.projects.sort(), ["ours", "owners"]);
  const absent = fakeDocker({ ...BASE(), absent: true });
  assert.equal((await noteFootprint(root, { run: absent.run })).ok, false, "Docker gone: nothing noted, no throw");
});

test("footprint.docker off, or remove false: nothing is removed and everything created is reported", async () => {
  for (const opts of [{ config: { footprint: { docker: false } } }, { config: ON, remove: false }]) {
    const root = tmp();
    const world = BASE();
    const { run, calls } = fakeDocker(world);
    await recordFootprintStart(root, { run });
    world.containers.push(
      { id: hex("c"), name: "test-db", image: "postgres:16", state: "exited", volumes: ["scratch"], networks: [hex("4")], labels: compose("t", root) },
      { id: hex("d"), name: "web", image: "nginx", state: "running", labels: compose("t", root) }
    );
    world.volumes.push("scratch", "stray");
    world.networks.push({ id: hex("4"), name: "test_net" });
    calls.length = 0;
    const r = await finishFootprint(root, { run, ...opts });
    assert.deepEqual(r.removed, []);
    assert.deepEqual(r.kept.map((x) => x.name), ["test-db", "scratch", "test_net"]);
    assert.match(r.kept[0].reason, opts.remove === false ? /removal was not asked for/ : /footprint\.docker is off/);
    assert.deepEqual(r.runningCreated.map((x) => x.name), ["web"]);
    assert.deepEqual(r.unattributed.map((x) => x.name), ["stray"]);
    assert.deepEqual(removals(calls), [], "no removal command at all");
  }
});

test("the config switch is read from the project when no config is passed", async () => {
  const root = tmp();
  fs.writeFileSync(path.join(root, "autoclaude.config.json"), JSON.stringify({ version: 1, footprint: { docker: false } }));
  fs.writeFileSync(path.join(root, "compose.yaml"), "name: demo\n");
  const world = BASE();
  const { run } = fakeDocker(world);
  await recordFootprintStart(root, { run });
  world.volumes.push("scratch");
  world.volumeLabels.scratch = { "com.docker.compose.project": "demo" };
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
    assert.deepEqual([r.removed, r.kept, r.runningCreated, r.unattributed, r.errors, r.dockerChecked], [[], [], [], [], [], false], flag);
    assert.equal(footprintLine(r), "Docker was not checked (not installed or not running)");
  }
  const snap = await dockerSnapshot(fakeDocker({ ...BASE(), absent: true }).run);
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
  assert.deepEqual(removals(fake.calls), []);
});

test("a failed removal is kept with the reason; a name unsafe for a command is never used; things gone since the start are listed", async () => {
  const root = tmp();
  const world = BASE();
  const { run, calls } = fakeDocker(world);
  await recordFootprintStart(root, { run });
  world.rmFails = true;
  world.containers.push({ id: hex("c"), name: "test-db", image: "postgres:16", state: "exited", labels: compose("t", root) });
  // A volume this project's container mounted before it went (from Docker's events), whose name
  // AutoClaude would never put in a command.
  const t = secs(T0) + 60;
  world.events.push(
    { Type: "container", Action: "create", Actor: { ID: hex("e"), Attributes: { ...compose("t", root), name: "t-1" } }, time: t },
    { Type: "volume", Action: "mount", Actor: { ID: "bad name & calc", Attributes: { container: hex("e") } }, time: t + 1 }
  );
  at(world, "2026-09-28T11:00:00Z");
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
  const flaky = async (cmd, o) => (cmd.startsWith("docker volume ls --format") ? { code: 1, stdout: "", stderr: "Error response from daemon: context deadline exceeded" } : fake.run(cmd, o));
  const start = await recordFootprintStart(root, { run: flaky });
  assert.deepEqual(start.docker.listed, { containers: true, volumes: false, networks: true });
  world.containers.push({ id: hex("c"), name: "test-db", image: "postgres:16", state: "exited", labels: compose("t", root) });
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
  assert.equal(snap.engine, null, "no engine id: nothing will be removed at the end");
});
