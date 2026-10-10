// Offline fixtures for the deployment test and the release signing / kill-switch helpers (FL-142/145/146).
const assert = require("node:assert/strict");
const test = require("node:test");
const zlib = require("node:zlib");
const fs = require("node:fs");
const path = require("node:path");
const {
  Api,
  checkInstallation,
  environmentFile,
  listeningOn,
  missingMigrations,
  prepareTestDatabase,
  testImage,
  ADMIN,
} = require("./frameleaf-deploy-test.cjs");
const {
  releaseFlagsBody,
  parsePercent,
  signImages,
  ATTESTATION_TYPE,
} = require("./frameleaf-release.cjs");
require("./frameleaf-install.test.cjs");

const sha = "a".repeat(40);
const example = [
  "UPLOAD_LOCATION=./library",
  "DB_DATA_LOCATION=./postgres",
  "FRAMELEAF_VERSION=release",
  "DB_PASSWORD=postgres",
  "DB_USERNAME=postgres",
].join("\n");

test("the test installation's .env keeps the release example and sets only test values", () => {
  const body = environmentFile(example, "A".repeat(32));
  assert.match(body, /^FRAMELEAF_VERSION=deploy-test$/m);
  assert.match(body, /^DB_PASSWORD=A{32}$/m);
  assert.match(body, /^DB_USERNAME=postgres$/m);
  assert.throws(() => environmentFile(example, "short"));
  assert.throws(
    () => environmentFile("DB_PASSWORD=x", "A".repeat(32)),
    /UPLOAD_LOCATION/,
  );
});

test("the pinned release database is replaced only in disposable compose for archive and source validation", async () => {
  const filename = path.join(__dirname, "../docker/docker-compose.yml");
  const production = fs.readFileSync(filename, "utf8");
  const reference =
    /^\s*image:\s*(ghcr\.io\/frameleaf\/frameleaf-postgres:\S+)\s*$/m.exec(
      production,
    )[1];
  assert.match(reference, /:19beta4-pgvector0\.8\.7@sha256:[a-f0-9]{64}$/);
  const compose = `# Original release dependency: ${reference}\n${production}`;
  const archiveReference = `127.0.0.1:5000/deploy-test/database@sha256:${"a".repeat(64)}`;
  for (const archive of [undefined, "/artifacts/postgres/image.tar"]) {
    const calls = [];
    const loaded = [];
    const result = await prepareTestDatabase(
      compose,
      { root: "/source", workDir: "/test", archive },
      {
        execute: (command, args, options) => {
          calls.push({ command, args, options });
          return "sha256:local-image-id\n";
        },
        load: async (...args) => {
          loaded.push(args);
          return archiveReference;
        },
      },
    );
    assert.equal(
      result.compose,
      compose.replace(
        `image: ${reference}`,
        "image: frameleaf-postgres:deploy-test",
      ),
    );
    assert.ok(
      result.compose.includes(`# Original release dependency: ${reference}`),
    );
    assert.equal(result.image.releaseReference, reference);
    if (archive) {
      assert.deepEqual(loaded, [[archive, "database", "/test"]]);
      assert.deepEqual(
        calls.map(({ command, args }) => [command, ...args]),
        [
          ["docker", "tag", archiveReference, "frameleaf-postgres:deploy-test"],
          [
            "docker",
            "image",
            "inspect",
            "--format",
            "{{.Id}}",
            archiveReference,
          ],
        ],
      );
      assert.equal(result.image.id, "sha256:local-image-id");
    } else {
      assert.deepEqual(loaded, []);
      assert.deepEqual(
        calls.map(({ command, args }) => [command, ...args]),
        [
          ["docker", "pull", "--quiet", reference],
          ["docker", "tag", reference, "frameleaf-postgres:deploy-test"],
        ],
      );
    }
    assert.equal(
      fs.readFileSync(filename, "utf8"),
      production,
      "Production digest must remain unchanged",
    );
  }
});

test("database validation rejects missing, ambiguous, foreign or malformed production pins before Docker", async () => {
  const reference = `ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@sha256:${"b".repeat(64)}`;
  for (const images of [
    [],
    [reference, reference],
    [reference.split("@")[0]],
    [reference.replace(/sha256:.+$/, "sha256:short")],
    [reference.replace("ghcr.io/frameleaf", "ghcr.io/another-owner")],
  ]) {
    const compose = images
      .map((image, index) => `  database${index}:\n    image: ${image}`)
      .join("\n");
    for (const archive of [undefined, "/artifacts/database.tar"]) {
      let calls = 0;
      await assert.rejects(
        prepareTestDatabase(
          compose,
          { root: "/source", workDir: "/test", archive },
          {
            execute: () => {
              calls++;
            },
            load: async () => {
              calls++;
            },
          },
        ),
        /exactly one|digest-pinned/,
      );
      assert.equal(calls, 0);
    }
  }
});

test("database preparation failure never returns a usable test stack", async () => {
  const compose = `services:\n  database:\n    image: ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@sha256:${"b".repeat(64)}\n`;
  for (const archive of [undefined, "/artifacts/database.tar"]) {
    await assert.rejects(
      prepareTestDatabase(
        compose,
        { root: "/source", workDir: "/test", archive },
        {
          execute: () => {
            throw new Error("Docker rejected test image");
          },
          load: async () => {
            throw new Error("Archive unavailable");
          },
        },
      ),
      archive ? /Archive unavailable/ : /Docker rejected test image/,
    );
  }
});

test("the upload is a valid PNG that differs per seed", () => {
  const png = testImage("one");
  assert.deepEqual([...png.subarray(1, 4)], [0x50, 0x4e, 0x47]);
  assert.equal(png.readUInt32BE(16), 64);
  const idat = png.indexOf("IDAT");
  const length = png.readUInt32BE(idat - 4);
  assert.equal(
    zlib.inflateSync(png.subarray(idat + 4, idat + 4 + length)).length,
    64 * (1 + 64 * 3),
  );
  assert(!png.equals(testImage("two")));
});

test("every shipped migration must be recorded", () => {
  assert.deepEqual(
    missingMigrations(
      [
        "1700000000000-Init.js",
        "1700000000000-Init.d.ts",
        "1700000000000-Init.js.map",
        "0000000000204-FrameleafUserLicenses.js",
        "index.js",
      ],
      ["1700000000000-Init"],
    ),
    ["0000000000204-FrameleafUserLicenses"],
  );
});

test("a listening socket on the edge port is read from /proc/net/tcp", () => {
  const header =
    "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode";
  const listen =
    "   0: 00000000:098B 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 1";
  const established =
    "   1: 0100007F:098B 0100007F:D431 01 00000000:00000000 00:00000000 00000000  1000        0 2";
  assert.equal(listeningOn([header, listen].join("\n"), 2443), true);
  assert.equal(listeningOn([header, established].join("\n"), 2443), false);
  assert.equal(listeningOn([header, listen].join("\n"), 2283), false);
});

function fakeServer({
  version = "3.2.0",
  sourceCommit = sha,
  thumbnailAfter = 1,
  isAdmin = true,
  echo = true,
  ping = {
    res: "pong",
    id: "c540026e-6d2f-4054-8be2-d3e537445c18",
    linked: false,
    name: "Frameleaf server",
  },
} = {}) {
  let stored;
  let polls = 0;
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return async (url, init) => {
    const route = url.replace("http://test/api", "");
    if (route === "/server/ping") return json(ping);
    if (route === "/server/version") {
      const [major, minor, patch] = version.split(".").map(Number);
      return json({ major, minor, patch });
    }
    if (route === "/auth/admin-sign-up") {
      assert.equal(JSON.parse(init.body).setupCode, "ABCD-2345");
      return json({ id: "u" }, 201);
    }
    if (route === "/auth/login") {
      assert.equal(JSON.parse(init.body).email, ADMIN.email);
      return json({ accessToken: "token", isAdmin });
    }
    assert.equal(init.headers.Authorization, "Bearer token");
    if (route === "/server/about") return json({ sourceCommit });
    if (route === "/assets" && init.method === "POST") {
      stored = Buffer.from(await init.body.get("assetData").arrayBuffer());
      return json({ id: "asset", status: "created" }, 201);
    }
    if (route === "/assets/asset")
      return json({ originalFileName: "deploy-test.png" });
    if (route === "/assets/asset/original")
      return new Response(echo ? stored : Buffer.from("other"));
    if (route.startsWith("/assets/asset/thumbnail"))
      return ++polls > thumbnailAfter
        ? new Response(Buffer.from("webp"), {
            headers: { "content-type": "image/webp" },
          })
        : json({ message: "not found" }, 404);
    throw new Error(`Unexpected ${route}`);
  };
}
const execFake = (service, command) => {
  if (service === "frameleaf-server" && command.includes("setup-code"))
    return "ABCD-2345\n";
  if (service === "frameleaf-server" && /proc\/net/.test(command.join(" ")))
    return "  sl\n";
  if (service === "frameleaf-server")
    return "1700000000000-Init.js\n1700000000000-Init.js.map\n0000000000204-FrameleafUserLicenses.js\n";
  return "1700000000000-Init\n0000000000204-FrameleafUserLicenses\n";
};
const base = (overrides = {}) => ({
  api: new Api("http://test/api", fakeServer(overrides.server)),
  exec: overrides.exec ?? execFake,
  logs: () =>
    overrides.logs ??
    "Starting api worker\nStarting edge worker\nFrameleaf Microservices is running [v3.2.0]\n",
  expectedVersion: "3.2.0",
  sourceSha: sha,
  password: "password-for-tests",
  wait: async () => {},
});

test("a working installation passes every check and records its evidence", async () => {
  const evidence = await checkInstallation(base());
  assert.equal(evidence.version, "3.2.0");
  assert.equal(evidence.sourceCommit, sha);
  assert.match(evidence.job, /thumbnail generated/);
  assert.match(evidence.migrations, /^2 shipped migrations applied$/);
  assert.deepEqual(evidence.edge, {
    worker: "running (started once)",
    directListening: false,
  });
});

test("each broken installation fails the deployment test", async () => {
  for (const [overrides, message] of [
    [{ server: { ping: { res: "not-pong" } } }, /did not answer ping/],
    [{ server: { version: "3.1.0" } }, /another version/],
    [{ server: { sourceCommit: "b".repeat(40) } }, /another source commit/],
    [{ server: { isAdmin: false } }, /not an administrator/],
    [{ server: { echo: false } }, /read back differs/],
    [
      {
        exec: (s, c) =>
          s === "database" ? "1700000000000-Init\n" : execFake(s, c),
      },
      /Migrations not applied: 0000000000204-FrameleafUserLicenses/,
    ],
    [
      {
        logs: "Frameleaf Microservices is running [v3.2.0]\nStarting edge worker\nedge worker exited\nStarting edge worker\n",
      },
      /edge worker started 2 times/,
    ],
    [
      {
        logs: "Starting api worker\nFrameleaf Microservices is running [v3.2.0]\n",
      },
      /edge worker started 0 times/,
    ],
  ])
    await assert.rejects(checkInstallation(base(overrides)), message);
  let clock = 0;
  await assert.rejects(
    checkInstallation({
      ...base({ server: { thumbnailAfter: Infinity } }),
      now: () => (clock += 60_000),
      jobTimeoutMs: 120_000,
    }),
    /thumbnail job did not run/,
  );
});

test("release bodies carry the rollout and withdrawal lines servers read", () => {
  assert.equal(releaseFlagsBody("Notes", { rolloutPercent: 100 }), "Notes\n");
  assert.equal(
    releaseFlagsBody("Notes", { rolloutPercent: 25 }),
    "rollout: 25%\n\nNotes\n",
  );
  assert.equal(
    releaseFlagsBody("rollout: 25%\n\nNotes\n", { rolloutPercent: 60 }),
    "rollout: 60%\n\nNotes\n",
  );
  assert.equal(
    releaseFlagsBody("rollout: 25%\n\nNotes", {
      withdrawnReason: " Upgrade\nfails ",
    }),
    "withdrawn: Upgrade fails\n\nNotes\n",
  );
  assert.equal(
    releaseFlagsBody("withdrawn: broken upgrade\nrollout: 25%\n\nNotes", {
      rolloutPercent: 60,
    }),
    "rollout: 60%\n\nwithdrawn: broken upgrade\n\nNotes\n",
  );
  assert.throws(() => releaseFlagsBody("Notes", { withdrawnReason: "" }));
  assert.throws(() => releaseFlagsBody("Notes", { rolloutPercent: 101 }));
  assert.equal(parsePercent("40"), 40);
  assert.equal(parsePercent(""), undefined);
  for (const bad of ["-1", "4.5", "1000", "all"])
    assert.throws(() => parsePercent(bad));
});

test("each image digest is signed, attested and verified with the committed key, never with a key on the command line", () => {
  const calls = [];
  const digest = `sha256:${"b".repeat(64)}`;
  signImages(
    [{ image: "ghcr.io/frameleaf/frameleaf-server", digest }],
    "/tmp/release-manifest.json",
    (command, args) => {
      calls.push([command, ...args]);
      return "";
    },
  );
  const reference = `ghcr.io/frameleaf/frameleaf-server@${digest}`;
  assert.deepEqual(calls, [
    [
      "cosign",
      "sign",
      "--yes",
      "--recursive",
      "--key",
      "env://COSIGN_PRIVATE_KEY",
      reference,
    ],
    [
      "cosign",
      "attest",
      "--yes",
      "--key",
      "env://COSIGN_PRIVATE_KEY",
      "--type",
      ATTESTATION_TYPE,
      "--predicate",
      "/tmp/release-manifest.json",
      reference,
    ],
    ["cosign", "verify", "--key", "cosign.pub", reference],
    [
      "cosign",
      "verify-attestation",
      "--key",
      "cosign.pub",
      "--type",
      ATTESTATION_TYPE,
      reference,
    ],
  ]);
  assert.throws(() =>
    signImages([{ image: "x", digest: "latest" }], "m", () => ""),
  );
});

test("the stack is ready only when all three services are healthy, and a stopped service fails at once", async () => {
  const { serviceStates, waitHealthy } = require("./frameleaf-deploy-test.cjs");
  const row = (Service, Health, State = "running") =>
    JSON.stringify({ Service, State, Health });
  const all = (health) =>
    ["frameleaf-server", "immich-machine-learning", "database"]
      .map((s) => row(s, health))
      .join("\n");
  assert.deepEqual(serviceStates(`[${row("database", "healthy")}]`), [
    { service: "database", state: "running", health: "healthy" },
  ]);
  const outputs = [all("starting"), all("unhealthy"), all("healthy")];
  const states = await waitHealthy(() => outputs.shift(), 60_000, {
    wait: async () => {},
  });
  assert.equal(states.length, 3);
  await assert.rejects(
    waitHealthy(() => row("frameleaf-server", "", "restarting"), 60_000, {
      wait: async () => {},
    }),
    /A service stopped/,
  );
  let clock = 0;
  await assert.rejects(
    waitHealthy(() => all("starting"), 10_000, {
      wait: async () => {},
      now: () => (clock += 6_000),
    }),
    /not healthy in time/,
  );
});
