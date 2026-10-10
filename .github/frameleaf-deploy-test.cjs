#!/usr/bin/env node
// Frameleaf deployment test (FL-142, owner decision 2026-09-27: "we should do a deployment test before an
// image is pushed"). Runs the release Compose stack (docker/docker-compose.yml: server, machine learning,
// Postgres) from images that are on this runner only, waits for health, and proves a working
// installation: the API answers with the expected version and source, an administrator can be created and
// sign in, an upload reads back byte for byte, a background job (the thumbnail) runs, every migration the
// image ships is applied, and the edge worker is up with its direct port published. Nothing is pushed here;
// callers push only after this exits 0. Importing this module performs no I/O.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");
const { execFileSync } = require("node:child_process");

const SERVER_REPOSITORY = "ghcr.io/frameleaf/frameleaf-server";
const ML_REPOSITORY = "ghcr.io/frameleaf/frameleaf-machine-learning";
const TEST_TAG = "deploy-test";
const DATABASE_TEST_IMAGE = "frameleaf-postgres:deploy-test";
const SHA = /^[a-f0-9]{40}$/;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const EDGE_PORT = 2443;
const ADMIN = Object.freeze({
  email: "deploy-test@frameleaf.invalid",
  name: "Deployment test",
});
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A small, valid, deterministic-per-seed PNG (RGB, 64x64) so the thumbnail job has real work to do.
function crc32(buffer) {
  let crc = ~0;
  for (const byte of buffer) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}
function pngChunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}
function testImage(seed, size = 64) {
  const random = crypto.createHash("sha256").update(seed).digest();
  const rows = [];
  for (let y = 0; y < size; y++) {
    const row = Buffer.alloc(1 + size * 3);
    for (let x = 0; x < size; x++) {
      row[1 + x * 3] = (x * 4 + random[0]) & 0xff;
      row[2 + x * 3] = (y * 4 + random[1]) & 0xff;
      row[3 + x * 3] = (x ^ y ^ random[2]) & 0xff;
    }
    rows.push(row);
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", zlib.deflateSync(Buffer.concat(rows))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

/** The `.env` for the test installation, from the release example with test-only locations and secrets. */
function environmentFile(example, databasePassword) {
  assert.match(databasePassword, /^[A-Za-z0-9]{24,}$/, "Invalid test password");
  const values = {
    UPLOAD_LOCATION: "./library",
    DB_DATA_LOCATION: "./postgres",
    FRAMELEAF_VERSION: TEST_TAG,
    DB_PASSWORD: databasePassword,
  };
  let body = example;
  for (const [key, value] of Object.entries(values)) {
    const line = new RegExp(`^${key}=.*$`, "m");
    assert.match(body, line, `The release example.env has no ${key}`);
    body = body.replace(line, `${key}=${value}`);
  }
  return body;
}

/** Migration names an image ships (compiled `.js` files) that the database has not recorded. */
function missingMigrations(shipped, recorded) {
  const applied = new Set(recorded);
  return shipped
    .filter((file) => /^\d+-[\w-]+\.js$/.test(file))
    .map((file) => file.replace(/\.js$/, ""))
    .filter((name) => !applied.has(name));
}

/** Whether `/proc/net/tcp{,6}` text shows a socket listening on the port. */
function listeningOn(procNet, port) {
  const hex = port.toString(16).toUpperCase().padStart(4, "0");
  return procNet
    .split("\n")
    .slice(1)
    .some((line) => {
      const fields = line.trim().split(/\s+/);
      return fields[1]?.endsWith(`:${hex}`) && fields[3] === "0A";
    });
}

class Api {
  constructor(base, fetchImpl = fetch) {
    this.base = base.replace(/\/+$/, "");
    this.fetch = fetchImpl;
    this.token = null;
  }
  async call(method, route, { body, form, raw = false, ok = true } = {}) {
    const headers = {};
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const response = await this.fetch(`${this.base}${route}`, {
      method,
      headers,
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });
    if (ok && !response.ok)
      throw new Error(
        `${method} ${route} answered ${response.status}: ${(await response.text()).slice(0, 300)}`,
      );
    if (raw) return response;
    const text = await response.text();
    return text ? JSON.parse(text) : null;
  }
}

/**
 * The API checks against a running installation. `exec(service, command)` runs a command in a Compose
 * service and returns its output; `logs()` returns the server's log. Returns the evidence it gathered.
 */
async function checkInstallation({
  api,
  exec,
  logs,
  expectedVersion,
  sourceSha,
  password,
  now = Date.now,
  wait = sleep,
  jobTimeoutMs = 300_000,
  workerTimeoutMs = 900_000,
}) {
  const evidence = {};
  assert.equal(
    (await api.call("GET", "/server/ping")).res,
    "pong",
    "The API did not answer ping",
  );
  const version = await api.call("GET", "/server/version");
  evidence.version = `${version.major}.${version.minor}.${version.patch}`;
  assert.equal(
    evidence.version,
    expectedVersion.replace(/-.*$/, ""),
    "The server reports another version",
  );

  // FL-292: a new server is claimed with the setup code it shows on its console; the admin command
  // line prints it, as it would for a person whose console output is gone
  const setupCode = exec("frameleaf-server", [
    "frameleaf-admin",
    "setup-code",
    "--plain",
  ]).trim();
  await api.call("POST", "/auth/admin-sign-up", {
    body: { ...ADMIN, password, setupCode },
  });
  const login = await api.call("POST", "/auth/login", {
    body: { email: ADMIN.email, password },
  });
  assert(
    typeof login.accessToken === "string" && login.accessToken,
    "Sign-in returned no session",
  );
  assert.equal(
    login.isAdmin,
    true,
    "The seeded administrator is not an administrator",
  );
  api.token = login.accessToken;
  evidence.signIn = "administrator created and signed in";

  const about = await api.call("GET", "/server/about");
  if (sourceSha) {
    assert.equal(
      about.sourceCommit,
      sourceSha,
      "The image reports another source commit",
    );
    evidence.sourceCommit = about.sourceCommit;
  }

  // The API can report healthy while the microservices worker is still applying migrations; jobs queue
  // until it has started. Wait for its bootstrap line before testing a job.
  const workerDeadline = now() + workerTimeoutMs;
  while (!/Frameleaf Microservices is running/.test(logs())) {
    if (now() > workerDeadline)
      throw new Error(
        "The microservices worker did not connect within the time allowed",
      );
    await wait(5_000);
  }
  evidence.worker = "microservices worker running";

  const bytes = testImage(`${sourceSha ?? "local"}:${now()}`);
  const form = new FormData();
  const stamp = new Date(now()).toISOString();
  form.append("fileCreatedAt", stamp);
  form.append("fileModifiedAt", stamp);
  form.append(
    "assetData",
    new Blob([bytes], { type: "image/png" }),
    "deploy-test.png",
  );
  const upload = await api.call("POST", "/assets", { form });
  assert.equal(upload.status, "created", "The upload was not created");
  const asset = await api.call("GET", `/assets/${upload.id}`);
  assert.equal(asset.originalFileName, "deploy-test.png");
  const original = Buffer.from(
    await (
      await api.call("GET", `/assets/${upload.id}/original`, { raw: true })
    ).arrayBuffer(),
  );
  assert(
    original.equals(bytes),
    "The original read back differs from the upload",
  );
  evidence.upload = {
    id: upload.id,
    bytes: bytes.length,
    sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
  };

  // The thumbnail is written by the thumbnail-generation job in the microservices worker.
  const deadline = now() + jobTimeoutMs;
  for (;;) {
    const response = await api.call(
      "GET",
      `/assets/${upload.id}/thumbnail?size=thumbnail`,
      { raw: true, ok: false },
    );
    if (
      response.ok &&
      /^image\//.test(response.headers.get("content-type") ?? "")
    ) {
      evidence.job = `thumbnail generated (${(await response.arrayBuffer()).byteLength} bytes)`;
      break;
    }
    await response.arrayBuffer().catch(() => {});
    if (now() > deadline)
      throw new Error("The thumbnail job did not run within the time allowed");
    await wait(2_000);
  }

  // Every canonical public migration shipped by the image must be recorded as applied.
  const shipped = exec("frameleaf-server", [
    "sh",
    "-c",
    "ls /usr/src/app/server/dist/schema/migrations",
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const recorded = exec("database", [
    "sh",
    "-c",
    `psql -XAt -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT name FROM public.frameleaf_migrations"`,
  ])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const missing = missingMigrations(shipped, recorded);
  assert.deepEqual(
    missing,
    [],
    `Migrations not applied: ${missing.join(", ")}`,
  );
  evidence.migrations = `${shipped.filter((f) => /\.js$/.test(f)).length} shipped migrations applied`;

  // The edge worker (FL-165) runs as its own process. Its direct listener binds 2443 once the server is
  // linked to Frameleaf Cloud and holds a certificate; a fresh, unlinked installation must still start the
  // worker without a crash loop and publish the port.
  const log = logs();
  const starts = log.match(/Starting edge worker/g)?.length ?? 0;
  assert.equal(starts, 1, `The edge worker started ${starts} times`);
  const procNet = exec("frameleaf-server", [
    "sh",
    "-c",
    "cat /proc/net/tcp /proc/net/tcp6 2>/dev/null",
  ]);
  evidence.edge = {
    worker: "running (started once)",
    directListening: listeningOn(procNet, EDGE_PORT),
  };
  return evidence;
}

/** `docker compose ps --format json` output (one object per line, or an array) as service states. */
function serviceStates(output) {
  const text = output.trim();
  if (!text) return [];
  const rows = text.startsWith("[")
    ? JSON.parse(text)
    : text.split("\n").map((line) => JSON.parse(line));
  return rows.map((row) => ({
    service: row.Service,
    state: row.State,
    health: row.Health || "",
  }));
}

async function waitHealthy(
  list,
  timeoutMs,
  { now = Date.now, wait = sleep, services = 3 } = {},
) {
  const deadline = now() + timeoutMs;
  for (;;) {
    const states = serviceStates(list());
    const failed = states.filter((s) => s.state !== "running");
    assert.deepEqual(
      failed,
      [],
      `A service stopped: ${JSON.stringify(failed)}`,
    );
    if (
      states.length === services &&
      states.every((s) => s.health === "healthy")
    )
      return states;
    if (now() > deadline)
      throw new Error(
        `Services not healthy in time: ${JSON.stringify(states)}`,
      );
    await wait(5_000);
  }
}

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

// A throwaway registry on this runner's loopback interface only. Docker's classic image store cannot
// `docker load` an OCI archive whose index carries attestations, so an archive is copied into it
// unchanged (same digest) and pulled from there. Nothing leaves the runner.
const LOCAL_REGISTRY = "127.0.0.1:5000";
const REGISTRY_IMAGE =
  "docker.io/library/registry:2@sha256:a3d8aaa63ed8681a604f1dea0aa03f100d5895b6a58ace528858a7b332415373";
const REGISTRY_CONTAINER = "frameleaf-deploy-test-registry";
let registryStarted = false;
async function startLocalRegistry() {
  if (registryStarted) return;
  run("docker", ["rm", "--force", REGISTRY_CONTAINER], { stdio: "ignore" });
  run("docker", [
    "run",
    "--detach",
    "--rm",
    "--name",
    REGISTRY_CONTAINER,
    "--publish",
    `${LOCAL_REGISTRY}:5000`,
    REGISTRY_IMAGE,
  ]);
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await fetch(`http://${LOCAL_REGISTRY}/v2/`)).ok) {
        registryStarted = true;
        return;
      }
    } catch {
      // not listening yet
    }
    await sleep(1_000);
  }
  throw new Error("The local test registry did not start");
}

/** The archive's single image index digest, from its OCI layout. */
function archiveDigest(indexJson) {
  const index = JSON.parse(indexJson);
  assert.equal(
    index.manifests?.length,
    1,
    "The archive must hold exactly one image index",
  );
  const { digest } = index.manifests[0];
  assert.match(digest, /^sha256:[a-f0-9]{64}$/, "Invalid archive digest");
  return digest;
}

/** Load an OCI archive built on this runner (never pushed anywhere) and return a pullable reference. */
async function loadArchive(file, name, workDir) {
  const layout = path.join(workDir, `layout-${name}`);
  await fs.rm(layout, { recursive: true, force: true });
  await fs.mkdir(layout, { recursive: true });
  run("tar", ["-xf", file, "-C", layout]);
  const digest = archiveDigest(
    await fs.readFile(path.join(layout, "index.json"), "utf8"),
  );
  await startLocalRegistry();
  const reference = `${LOCAL_REGISTRY}/deploy-test/${name}@${digest}`;
  run("oras", [
    "cp",
    "--to-plain-http",
    "--from-oci-layout",
    `${layout}@${digest}`,
    reference,
  ]);
  run("docker", ["pull", "--quiet", reference]);
  await fs.rm(layout, { recursive: true, force: true });
  return reference;
}

/** Only the disposable test stack uses a local tag; release installation pins stay unchanged. */
async function prepareTestDatabase(
  compose,
  { root, workDir, archive },
  { execute = run, load = loadArchive } = {},
) {
  const pattern =
    /^(\s*image:\s*)(ghcr\.io\/frameleaf\/frameleaf-postgres:\S+)(\s*)$/gm;
  const references = [...compose.matchAll(pattern)];
  assert.equal(
    references.length,
    1,
    "Expected exactly one Frameleaf database image",
  );
  const releaseReference = references[0][2];
  assert.match(
    releaseReference,
    /^ghcr\.io\/frameleaf\/frameleaf-postgres:[A-Za-z0-9_.-]+@sha256:[a-f0-9]{64}$/,
    "The release database image must be digest-pinned",
  );
  let image;
  if (archive) {
    const source = await load(archive, "database", workDir);
    execute("docker", ["tag", source, DATABASE_TEST_IMAGE]);
    image = {
      source: `archive ${path.basename(archive)}`,
      id: execute("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        source,
      ]).trim(),
    };
  } else {
    execute("docker", ["pull", "--quiet", releaseReference]);
    execute("docker", ["tag", releaseReference, DATABASE_TEST_IMAGE]);
    image = { source: releaseReference };
  }
  return {
    compose: compose.replace(
      pattern,
      (_line, prefix, _reference, suffix) =>
        `${prefix}${DATABASE_TEST_IMAGE}${suffix}`,
    ),
    image: { ...image, releaseReference },
  };
}

async function main(env = process.env) {
  // The release files under test: this checkout, or a checkout of the candidate commit.
  const root = path.resolve(env.SOURCE_ROOT || path.join(__dirname, ".."));
  const workDir = path.resolve(
    env.WORK_DIR ||
      path.join(env.RUNNER_TEMP || ".cache", "frameleaf-deploy-test"),
  );
  for (const key of ["SOURCE_SHA", "SERVER_SOURCE_SHA"])
    if (env[key]) assert.match(env[key], SHA, `Invalid ${key}`);
  const expectedVersion =
    env.EXPECTED_VERSION ||
    JSON.parse(await fs.readFile(path.join(root, "server/package.json")))
      .version;
  assert.match(expectedVersion, VERSION, "Invalid expected version");

  // The images under test: archives built on this runner (never pushed), or verified registry digests.
  const images = {};
  for (const [key, repository, archive, reference] of [
    ["server", SERVER_REPOSITORY, env.SERVER_ARCHIVE, env.SERVER_IMAGE],
    ["ml", ML_REPOSITORY, env.ML_ARCHIVE, env.ML_IMAGE],
  ]) {
    assert(
      Boolean(archive) !== Boolean(reference),
      `Give exactly one of ${key.toUpperCase()}_ARCHIVE or ${key.toUpperCase()}_IMAGE`,
    );
    let source = reference;
    if (archive) source = await loadArchive(archive, key, workDir);
    else {
      assert.match(
        reference,
        /^[a-z0-9./-]+(?::[\w.-]+)?@sha256:[a-f0-9]{64}$|^[a-z0-9./-]+:[\w.-]+$/,
        `Invalid ${key} image reference`,
      );
      if (/@sha256:/.test(reference))
        run("docker", ["pull", "--quiet", reference]);
    }
    run("docker", ["tag", source, `${repository}:${TEST_TAG}`]);
    images[key] = {
      source: archive ? `archive ${path.basename(archive)}` : reference,
      id: run("docker", [
        "image",
        "inspect",
        "--format",
        "{{.Id}}",
        source,
      ]).trim(),
    };
  }

  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  const compose = await fs.readFile(
    path.join(root, "docker/docker-compose.yml"),
    "utf8",
  );
  const databasePassword = crypto
    .randomBytes(24)
    .toString("base64url")
    .replace(/[^A-Za-z0-9]/g, "a");
  await fs.writeFile(
    path.join(workDir, ".env"),
    environmentFile(
      await fs.readFile(path.join(root, "docker/example.env"), "utf8"),
      databasePassword,
    ),
    { mode: 0o600 },
  );

  // Integration uses the runner's archive; release validation pulls the Compose digest pin.
  const database = await prepareTestDatabase(compose, {
    root,
    workDir,
    archive: env.DATABASE_ARCHIVE,
  });
  await fs.writeFile(
    path.join(workDir, "docker-compose.yml"),
    database.compose,
  );
  images.database = database.image;

  const composeArgs = [
    "compose",
    "--project-directory",
    workDir,
    "--file",
    path.join(workDir, "docker-compose.yml"),
    // Local rehearsal only (for example Docker Desktop, whose bind mounts Postgres rejects); CI never sets it.
    ...(env.COMPOSE_OVERRIDE
      ? ["--file", path.resolve(env.COMPOSE_OVERRIDE)]
      : []),
  ];
  const docker = (...args) =>
    run("docker", [...composeArgs, ...args], { cwd: workDir });
  let evidence;
  let failed = true;
  try {
    docker("up", "--detach", "--pull", "missing");
    // A fresh installation runs every migration before the server reports healthy, which can outlast
    // its health check's start period; wait for every service to be healthy rather than failing on the
    // first unhealthy report. A container that exits or restarts fails at once.
    await waitHealthy(
      () => docker("ps", "--all", "--format", "json"),
      Number(env.WAIT_SECONDS || 900) * 1000,
    );
    const mapped = docker("port", "frameleaf-server", String(EDGE_PORT)).trim();
    assert.match(
      mapped,
      new RegExp(`:${EDGE_PORT}$`),
      "The edge port is not published",
    );
    evidence = await checkInstallation({
      api: new Api(env.API_URL || "http://127.0.0.1:2283/api"),
      exec: (service, command) => docker("exec", "-T", service, ...command),
      logs: () => docker("logs", "--no-color", "frameleaf-server"),
      expectedVersion,
      sourceSha: env.SERVER_SOURCE_SHA || env.SOURCE_SHA,
      password: crypto.randomBytes(18).toString("base64url"),
    });
    evidence.edge.published = mapped;
    failed = false;
  } finally {
    if (failed) {
      try {
        console.log(docker("ps", "--all"));
        console.log(docker("logs", "--no-color", "--tail", "400"));
      } catch (error) {
        console.log(`Could not collect diagnostics: ${error.message}`);
      }
    }
    if (registryStarted)
      run("docker", ["rm", "--force", REGISTRY_CONTAINER], { stdio: "ignore" });
    if (env.KEEP_STACK !== "1") {
      try {
        docker("down", "--volumes", "--remove-orphans");
        // The stack wrote the library and database as root; remove them with the image under test.
        run("docker", [
          "run",
          "--rm",
          "--entrypoint",
          "rm",
          "--volume",
          `${workDir}:/work`,
          `${SERVER_REPOSITORY}:${TEST_TAG}`,
          "-rf",
          "/work/library",
          "/work/postgres",
        ]);
      } catch (error) {
        console.log(
          `::warning::Could not remove the test stack: ${error.message}`,
        );
      }
    }
  }
  const report = {
    expectedVersion,
    sourceCommit: env.SOURCE_SHA || null,
    images,
    ...evidence,
  };
  console.log(JSON.stringify(report, null, 2));
  if (env.GITHUB_STEP_SUMMARY)
    await fs.appendFile(
      env.GITHUB_STEP_SUMMARY,
      `### Deployment test passed\n\n\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`,
    );
  return report;
}

module.exports = {
  Api,
  archiveDigest,
  loadArchive,
  checkInstallation,
  environmentFile,
  listeningOn,
  missingMigrations,
  prepareTestDatabase,
  serviceStates,
  testImage,
  waitHealthy,
  ADMIN,
};
if (require.main === module) {
  main().catch((error) => {
    console.error(`Deployment test failed: ${error.message}`);
    process.exitCode = 1;
  });
}
