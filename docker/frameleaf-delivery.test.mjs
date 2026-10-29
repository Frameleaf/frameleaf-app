import assert from "node:assert/strict";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const { load } = createRequire(resolve(root, "server/package.json"))("js-yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
// These standalone assertions inspect literal values, not Compose merge rules.
// Actual multi-file resolution is a separate Compose CLI validation gate.
const compose = (path) =>
  load(read(path).replace(/!(?:reset|override)\b/g, ""));
// FL-191: Frameleaf publishes its own database image, built from docker/postgres.
const databaseImage =
  "ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@sha256:7b155ed85302ab66c1022309f1f70f0b79f98f70bd52af8d7d3611a0cbf08cf0";

test("server identifiers use Frameleaf throughout the tracked source", () => {
  const result = spawnSync(
    "git",
    ["grep", "-n", "-I", "-i", "-e", "immich[-]server", "--", "."],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 1, result.stdout || result.stderr);
});

for (const [filename, project, rootless] of [
  ["docker-compose.yml", "frameleaf", false],
  ["docker-compose.rootless.yml", "frameleaf", true],
]) {
  test(`${filename}: Frameleaf images preserve installed storage and network contracts`, () => {
    const config = compose(`docker/${filename}`);
    assert.equal(config.name, project);
    assert.deepEqual(Object.keys(config.services), [
      "frameleaf-server",
      ...(!rootless ? ["frameleaf-lan-discovery"] : []),
      "frameleaf-machine-learning",
      "database",
    ]);
    const server = config.services["frameleaf-server"];
    const ml = config.services["frameleaf-machine-learning"];
    assert.equal(
      server.image,
      "ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}",
    );
    assert.equal(
      ml.image,
      "ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}",
    );
    assert.equal(server.container_name, "frameleaf_server");
    assert.equal(ml.container_name, "frameleaf_machine_learning");
    assert.equal(config.services.database.container_name, "frameleaf_postgres");
    // FL-408: the bundled Studio worker's enrolment, written by the server, read-only for ML
    const trust = rootless ? "./studio-worker" : "studio-worker";
    assert.deepEqual(server.volumes, [
      "${UPLOAD_LOCATION}:/data",
      "/etc/localtime:/etc/localtime:ro",
      `${trust}:/run/frameleaf/studio-worker`,
    ]);
    assert.deepEqual(config.services.database.volumes, [
      "${DB_DATA_LOCATION}:/var/lib/postgresql",
    ]);
    assert.deepEqual(ml.volumes, [
      rootless ? "./ml-model-cache:/cache" : "model-cache:/cache",
      `${trust}:/run/frameleaf/studio-worker:ro`,
    ]);
    // the library is never mounted into the inference container
    assert.ok(!ml.volumes.some((volume) => volume.includes("UPLOAD_LOCATION")));
    assert.equal(config.services.database.image, databaseImage);
    assert.equal(
      config.services.database.environment.POSTGRES_DB,
      "${DB_DATABASE_NAME}",
    );
    assert.equal(
      config.services.database.environment.POSTGRES_USER,
      "${DB_USERNAME}",
    );
    // A fresh database restarts once after initdb; the server waits for it instead of crash-looping.
    assert.deepEqual(server.depends_on, {
      database: { condition: "service_healthy" },
    });
    const health = config.services.database.healthcheck;
    // the socket answers during initdb before TCP does, so the check must use TCP
    assert.match(health.test[1], /^pg_isready --host=127\.0\.0\.1 /);
    assert.match(health.test[1], /&& \/usr\/local\/bin\/healthcheck\.sh$/);
    assert.deepEqual(server.env_file, [".env"]);
    // FL-165: the edge worker's direct HTTPS listener for LAN names and direct remote connections.
    assert.deepEqual(server.ports, [
      "${FRAMELEAF_HOST_PORT:-2283}:2283",
      "${FRAMELEAF_HOST_HTTPS_PORT:-2443}:2443",
    ]);
    if (!rootless)
      assert.equal(
        config.services["frameleaf-lan-discovery"].environment
          .FRAMELEAF_DISCOVERY_URL,
        "http://127.0.0.1:${FRAMELEAF_HOST_PORT:-2283}",
      );
    if (rootless) {
      assert.equal(server.user, "1000:1000");
      assert.equal(ml.user, "1000:1000");
    } else {
      assert.deepEqual(config.volumes, {
        "model-cache": null,
        "studio-worker": null,
      });
    }
  });
}

// FL-291: the stop grace period must exceed FRAMELEAF_SHUTDOWN_DEADLINE_SECONDS (9 s by default) so Docker
// does not kill the server during its graceful stop. Engines differ in their default stop timeout.
test("every server service gives the graceful stop its 10 s", () => {
  for (const filename of [
    "docker-compose.yml",
    "docker-compose.rootless.yml",
    "docker-compose.prod.yml",
    "docker-compose.dev.yml",
  ]) {
    assert.equal(
      compose(`docker/${filename}`).services["frameleaf-server"]
        .stop_grace_period,
      "10s",
      filename,
    );
  }
});

test("local builds retain projects/storage and build ordinary ML from the prod stage", () => {
  for (const [filename, project, cache] of [
    ["docker-compose.prod.yml", "immich-prod", "model-cache"],
    ["docker-compose.dev.yml", "immich-dev", "model_cache"],
  ]) {
    const config = compose(`docker/${filename}`);
    assert.equal(config.name, project);
    assert.ok(
      config.services["frameleaf-server"].volumes.includes(
        "${UPLOAD_LOCATION}/photos:/data",
      ),
    );
    assert.deepEqual(config.services.database.volumes, [
      "${UPLOAD_LOCATION}/postgres19:/var/lib/postgresql",
    ]);
    // Local stacks build the database from source, so they work before any publication.
    assert.equal(config.services.database.image, "frameleaf-postgres:local");
    assert.deepEqual(config.services.database.build, {
      context: "./postgres",
      dockerfile: "Dockerfile",
    });
    assert.equal(
      config.services["frameleaf-machine-learning"].build.target,
      "prod",
    );
    assert.ok(
      config.services["frameleaf-machine-learning"].volumes.includes(
        `${cache}:/cache`,
      ),
    );
    assert.ok(Object.hasOwn(config.volumes, cache));
    for (const service of Object.values(config.services)) {
      if (service.container_name)
        assert.match(service.container_name, /^frameleaf_/);
    }
  }
  const dev = compose("docker/docker-compose.dev.yml");
  for (const path of [".devcontainer/server/container-compose-overrides.yml"]) {
    assert.equal(
      compose(path).services["frameleaf-server"].image,
      dev.services["frameleaf-server"].image,
    );
  }
  assert.equal(
    dev.services["frameleaf-server"].environment.FRAMELEAF_SOURCE_COMMIT,
    "",
  );
  assert.equal(
    dev.services["frameleaf-server"].environment.FRAMELEAF_BUILD,
    "",
  );
  // FL-294: the development stack uses the FRAMELEAF_* names only
  assert.deepEqual(
    Object.keys(dev.services["frameleaf-server"].environment).filter((key) =>
      key.startsWith("IMMICH_"),
    ),
    [],
  );
});

test("the restoration overlay adds a separate worker and leaves library analysis alone (FL-72)", () => {
  const overlay = compose("docker/docker-compose.restoration.yml");
  assert.deepEqual(Object.keys(overlay.services), ["frameleaf-restoration"]);
  const worker = overlay.services["frameleaf-restoration"];
  assert.equal(worker.container_name, "frameleaf_restoration");
  // Built from source: no restoration image is published until a model is qualified.
  assert.equal(worker.build.dockerfile, "Dockerfile.video-restoration");
  assert.equal(worker.build.target, "worker");
  assert.doesNotMatch(worker.image, /^ghcr\.io\//);
  // Reached on the Compose network only, with its own bearer and read-only model inputs.
  assert.equal(worker.ports, undefined);
  assert.equal(
    worker.environment.FRAMELEAF_ML_AUTH_TOKEN,
    "${FRAMELEAF_RESTORATION_TOKEN:-}",
  );
  assert.ok(
    worker.volumes.some((volume) => volume.endsWith(":/restoration/config:ro")),
  );
  assert.ok(
    worker.volumes.some((volume) =>
      volume.endsWith(":/restoration/weights:ro"),
    ),
  );
  // Its own GPU, chosen by the operator (no default), never "any GPU" next to the ML container.
  const [gpu] = worker.deploy.resources.reservations.devices;
  assert.match(gpu.device_ids[0], /^\$\{FRAMELEAF_RESTORATION_GPU:\?/);
  assert.equal(gpu.count, undefined);
  assert.ok(Object.hasOwn(overlay.volumes, "restoration-work"));
});

function metadata(path, inputs) {
  const variables = { ...inputs };
  const result = {};
  const expand = (value) =>
    value.replace(/\$\{([A-Z_]+)\}/g, (_, key) => variables[key] ?? "");
  for (const line of read(path).split("\n")) {
    const arg = line.match(/^ARG ([A-Z_]+)(?:=(.*))?$/);
    if (arg && !Object.hasOwn(variables, arg[1]))
      variables[arg[1]] = arg[2] ?? "";
    const env = line.match(/^ENV ((?:FRAMELEAF|IMMICH)_[A-Z_]+)=(.*)$/);
    if (env) result[env[1]] = expand(env[2]);
  }
  return result;
}

for (const [file, image] of [
  ["server/Dockerfile", "frameleaf-server"],
  ["machine-learning/Dockerfile", "frameleaf-machine-learning"],
]) {
  test(`${file}: embedded provenance identifies the actual Frameleaf build`, () => {
    const inputs = {
      BUILD_ID: "12345",
      BUILD_SOURCE_COMMIT: "a".repeat(40),
      BUILD_SOURCE_REF: "main",
      BUILD_IMAGE: `ghcr.io/frameleaf/${image}:edge`,
    };
    const values = metadata(file, inputs);
    assert.equal(values.FRAMELEAF_REPOSITORY, "Frameleaf/frameleaf-app");
    assert.equal(values.FRAMELEAF_BUILD_IMAGE, inputs.BUILD_IMAGE);
    assert.equal(
      values.FRAMELEAF_BUILD_URL,
      "https://github.com/Frameleaf/frameleaf-app/actions/runs/12345",
    );
    assert.equal(
      values.FRAMELEAF_BUILD_IMAGE_URL,
      `https://github.com/Frameleaf/frameleaf-app/pkgs/container/${image}`,
    );
    assert.equal(
      values.FRAMELEAF_SOURCE_COMMIT_URL,
      `https://github.com/Frameleaf/frameleaf-app/commit/${inputs.BUILD_SOURCE_COMMIT}`,
    );
    assert.equal(values.FRAMELEAF_SOURCE_REF, "main");
    const custom = metadata(file, {
      ...inputs,
      BUILD_SOURCE_REPOSITORY: "Frameleaf/test-build",
      BUILD_IMAGE_NAME: "test-image",
    });
    assert.equal(
      custom.FRAMELEAF_BUILD_IMAGE_URL,
      "https://github.com/Frameleaf/test-build/pkgs/container/test-image",
    );
    assert.equal(custom.FRAMELEAF_REPOSITORY, "Frameleaf/test-build");
    assert.doesNotMatch(
      read(file),
      /^ENV (?:FRAMELEAF|IMMICH)_.*(?:immich-app\/immich|adamtaylor152)/m,
    );
    // FL-294: the image sets the FRAMELEAF_* names only
    assert.deepEqual(
      Object.keys(values).filter((key) => key.startsWith("IMMICH_")),
      [],
    );
    assert.match(
      read(file),
      /LABEL org\.opencontainers\.image\.source="https:\/\/github.com\/\$\{BUILD_SOURCE_REPOSITORY\}"/,
    );
  });
}

test("pinned build dependencies, runtime identity and orphan adoption remain compatible", () => {
  assert.match(read("server/Dockerfile"), /^FROM base-server-prod AS prod$/m);
  assert.match(read("server/Dockerfile"), /^FROM base-server-dev AS builder$/m);
  assert.match(
    read("server/Dockerfile"),
    /^HEALTHCHECK CMD frameleaf-healthcheck$/m,
  );
  assert.match(
    read("machine-learning/Dockerfile"),
    /^CMD \["python", "-m", "frameleaf_ml"\]$/m,
  );
  assert.doesNotMatch(read("machine-learning/Dockerfile"), /AS prod-runpod/);
  assert.ok(
    read("server/src/dtos/config.dto.ts").includes(
      "'http://frameleaf-machine-learning:3003'",
    ),
  );
  assert.match(read("docker/example.env"), /^FRAMELEAF_VERSION=latest$/m);
  assert.doesNotMatch(read("docker/example.env"), /^IMMICH_/m);
  // FL-294: both command names are on the image's PATH (server/bin), the old ones as aliases
  for (const name of [
    "frameleaf-admin",
    "frameleaf-healthcheck",
    "immich-admin",
    "immich-healthcheck",
  ])
    assert.ok(existsSync(resolve(root, "server/bin", name)), name);
  assert.match(
    read("server/Dockerfile"),
    /^RUN ln -s \.\.\/\.\.\/cli\/bin\/frameleaf server\/bin\/frameleaf && ln -s \.\.\/\.\.\/cli\/bin\/immich server\/bin\/immich$/m,
  );
  assert.match(read("docker/example.env"), /^DB_DATABASE_NAME=frameleaf$/m);
});

test("the selective server build admits owned SQL-tools and retains its production runtime closure", () => {
  const ignore = read(".dockerignore").split(/\r?\n/);
  assert.ok(
    ignore.includes("**/dist/"),
    "Unrelated local build outputs must stay excluded",
  );
  assert.ok(ignore.includes("!packages/sql-tools/dist/"));
  assert.ok(ignore.includes("!packages/sql-tools/dist/**"));
  assert.deepEqual(
    ignore.filter((line) => line.startsWith("!") && line.includes("dist")),
    [
      "!packages/sql-tools/dist/",
      "!packages/sql-tools/dist/**",
      "!packages/ui/dist/",
      "!packages/ui/dist/**",
    ],
    "No blanket exception for other generated dist directories",
  );
  const manifest = JSON.parse(read("packages/sql-tools/package.json"));
  assert.equal(manifest.name, "@frameleaf/sql-tools");
  for (const path of [
    manifest.exports["."].types,
    manifest.exports["."].default,
    manifest.bin["sql-tools"],
  ]) {
    assert.ok(existsSync(resolve(root, "packages/sql-tools", path)), path);
  }
  const server = read("server/Dockerfile")
    .split("FROM plugin-sdk AS server\n")[1]
    .split("FROM base-server-prod AS native-raw-validation")[0];
  const copy = server.indexOf(
    "COPY ./packages/sql-tools ./packages/sql-tools/",
  );
  const install = server.indexOf(
    "pnpm --filter 'frameleaf...' install --frozen-lockfile",
  );
  const deploy = server.indexOf("deploy /output/server-pruned");
  const sharp = server.indexOf(
    "--dir /output/server-pruned/node_modules/sharp exec npm run build",
  );
  const verify = server.indexOf(
    "RUN node /build/verify-server-package.mjs /output/server-pruned",
  );
  assert.ok(
    copy >= 0 &&
      install > copy &&
      deploy > install &&
      sharp > deploy &&
      verify > sharp,
  );
  assert.match(
    server,
    /^COPY \.\/docker\/scripts\/verify-server-package\.mjs \/build\/verify-server-package\.mjs$/m,
  );
  const files = JSON.parse(read("server/package.json")).files;
  assert.ok(
    files.includes("dist"),
    "Compiled Sharp child and canonical provider must be deployed",
  );
  const assets = JSON.parse(
    read("server/nest-cli.json"),
  ).compilerOptions.assets.map((asset) => asset.include);
  for (const required of [
    "schema/migrations/ORDER",
    "schema/catalog/*.json",
    "schema/catalog/*.sql",
  ]) {
    assert.ok(
      assets.includes(required),
      `Canonical production artifact rule missing: ${required}`,
    );
  }
});

test("installation points to Frameleaf release artifacts, not another application distribution", () => {
  for (const path of [
    "docker/README.md",
    "docs/docs/partials/_docker-compose-install-steps.mdx",
    "docs/docs/install/unraid.md",
  ]) {
    assert.ok(
      read(path).includes(
        "https://github.com/Frameleaf/frameleaf-app/releases",
      ),
    );
    assert.ok(
      !read(path).includes(
        "https://github.com/immich-app/immich/releases/latest/download/",
      ),
    );
  }
  assert.ok(
    !read("docs/docs/partials/_compose-builder.mdx").includes(
      "https://immich.app/docker-compose-builder",
    ),
  );
});

test("operational examples use stable service names and owned application images", () => {
  const backup = read("docs/docs/administration/backup-and-restore.md");
  assert.ok(backup.includes("docker compose exec -T database pg_dump"));
  assert.ok(backup.includes("docker compose exec -T database psql"));
  assert.ok(backup.includes("docker compose up -d database"));
  assert.match(
    backup,
    /pg_dump[^\n]*--no-owner[^\n]*--no-acl[^\n]*--dbname=frameleaf/,
  );
  assert.match(
    backup,
    /psql[^\n]*--set=ON_ERROR_STOP=on[^\n]*--single-transaction/,
  );
  assert.match(backup, /fresh, isolated database/);
  assert.match(
    backup,
    /Frameleaf's recovery interface for an operational restore/,
  );
  assert.match(
    backup,
    /without `public\.frameleaf_migrations` before destructive restore/,
  );
  for (const path of [
    "docs/docs/administration/backup-and-restore.md",
    "docs/docs/administration/server-commands.md",
    "docs/docs/features/libraries.md",
    "docs/docs/features/ml-hardware-acceleration.md",
  ])
    assert.doesNotMatch(
      read(path),
      /docker (?:exec|start)[^\n`]*immich_(?:server|postgres|machine_learning)/,
    );
  for (const [path, image] of [
    ["docs/docs/features/hardware-transcoding.md", "frameleaf-server"],
    [
      "docs/docs/features/ml-hardware-acceleration.md",
      "frameleaf-machine-learning",
    ],
  ]) {
    assert.ok(read(path).includes(`ghcr.io/frameleaf/${image}:`));
    assert.doesNotMatch(
      read(path),
      /ghcr\.io\/immich-app\/immich-(?:server|machine-learning):/,
    );
  }
});

test("Compose resolves all deployment files and hardware overlays without a daemon or user environment", () => {
  const temporary = mkdtempSync(resolve(tmpdir(), "frameleaf-compose-config-"));
  try {
    const directory = resolve(temporary, "docker");
    mkdirSync(directory);
    const files = [
      "docker-compose.yml",
      "docker-compose.rootless.yml",
      "docker-compose.prod.yml",
      "docker-compose.dev.yml",
    ];
    for (const filename of [
      ...files,
      "docker-compose.ml-isolated.yml",
      "hwaccel.ml.yml",
      "hwaccel.transcoding.yml",
    ]) {
      copyFileSync(
        resolve(root, "docker", filename),
        resolve(directory, filename),
      );
    }
    const env = [
      `UPLOAD_LOCATION=${temporary}/media`,
      `DB_DATA_LOCATION=${temporary}/database`,
      "DB_PASSWORD=fixture-only",
      "DB_USERNAME=postgres",
      "DB_DATABASE_NAME=frameleaf",
      "IMMICH_VERSION=frameleaf-v3.1.0-7",
    ].join("\n");
    writeFileSync(resolve(directory, ".env"), env);
    // The isolated DOCKER_CONFIG keeps user credentials and contexts out of the run, but
    // Docker Desktop installs the compose plugin under the user's config directory, so link
    // just that plugin directory in when it exists (Linux runners use the system plugin path).
    const userPlugins = resolve(
      process.env.DOCKER_CONFIG || resolve(homedir(), ".docker"),
      "cli-plugins",
    );
    if (existsSync(userPlugins))
      symlinkSync(userPlugins, resolve(temporary, "cli-plugins"));
    const cli = process.env.FRAMELEAF_COMPOSE_BIN || "docker";
    const prefix = process.env.FRAMELEAF_COMPOSE_BIN ? [] : ["compose"];
    const run = (filenames) => {
      const result = spawnSync(
        cli,
        [
          ...prefix,
          "--env-file",
          ".env",
          ...filenames.flatMap((name) => ["-f", name]),
          "config",
          "--format",
          "json",
        ],
        {
          cwd: directory,
          encoding: "utf8",
          env: {
            PATH: process.env.PATH,
            DOCKER_CONFIG: temporary,
            DOCKER_HOST: `unix://${temporary}/no-daemon.sock`,
          },
        },
      );
      assert.equal(result.status, 0, result.error?.message || result.stderr);
      return JSON.parse(result.stdout);
    };
    for (const filename of files) {
      const result = run([filename]);
      assert.equal(
        result.services["frameleaf-server"].container_name,
        "frameleaf_server",
      );
      assert.equal(
        result.services.database.environment.POSTGRES_DB,
        "frameleaf",
      );
      if (!filename.includes(".dev.") && !filename.includes(".prod.")) {
        assert.equal(
          result.services["frameleaf-server"].image,
          "ghcr.io/frameleaf/frameleaf-server:frameleaf-v3.1.0-7",
        );
        assert.equal(
          result.services["frameleaf-machine-learning"].image,
          "ghcr.io/frameleaf/frameleaf-machine-learning:frameleaf-v3.1.0-7",
        );
      }
    }
    writeFileSync(
      resolve(directory, "hardware.yml"),
      [
        "services:",
        "  frameleaf-server:",
        "    extends:",
        "      file: hwaccel.transcoding.yml",
        "      service: nvenc",
        "  frameleaf-machine-learning:",
        "    extends:",
        "      file: hwaccel.ml.yml",
        "      service: cuda",
        "    image: ghcr.io/frameleaf/frameleaf-machine-learning:${IMMICH_VERSION}-cuda",
        "",
      ].join("\n"),
    );
    const hardware = run(["docker-compose.yml", "hardware.yml"]);
    assert.equal(
      hardware.services["frameleaf-machine-learning"].image,
      "ghcr.io/frameleaf/frameleaf-machine-learning:frameleaf-v3.1.0-7-cuda",
    );
    assert.equal(
      hardware.services["frameleaf-server"].deploy.resources.reservations
        .devices[0].driver,
      "nvidia",
    );
    assert.equal(
      hardware.services["frameleaf-machine-learning"].deploy.resources
        .reservations.devices[0].driver,
      "nvidia",
    );
    // FL-294: the .env above is an unchanged Immich one (IMMICH_VERSION). FRAMELEAF_VERSION is the
    // name to use now and wins when both are set.
    for (const [versionLines, tag] of [
      [["FRAMELEAF_VERSION=frameleaf-v3.2.0-1"], "frameleaf-v3.2.0-1"],
      [
        [
          "IMMICH_VERSION=frameleaf-v3.1.0-7",
          "FRAMELEAF_VERSION=frameleaf-v3.2.0-1",
        ],
        "frameleaf-v3.2.0-1",
      ],
    ]) {
      writeFileSync(
        resolve(directory, ".env"),
        [
          ...env
            .split("\n")
            .filter((line) => !line.startsWith("IMMICH_VERSION=")),
          ...versionLines,
        ].join("\n"),
      );
      for (const filename of [
        "docker-compose.yml",
        "docker-compose.rootless.yml",
      ]) {
        const result = run([filename]);
        assert.equal(
          result.services["frameleaf-server"].image,
          `ghcr.io/frameleaf/frameleaf-server:${tag}`,
        );
        assert.equal(
          result.services["frameleaf-machine-learning"].image,
          `ghcr.io/frameleaf/frameleaf-machine-learning:${tag}`,
        );
      }
    }
    // Fresh installs are project "frameleaf" on the default ports.
    writeFileSync(resolve(directory, ".env"), env);
    for (const filename of [
      "docker-compose.yml",
      "docker-compose.rootless.yml",
    ]) {
      const fresh = run([filename]);
      assert.equal(fresh.name, "frameleaf");
      assert.deepEqual(
        fresh.services["frameleaf-server"].ports.map((port) => port.published),
        ["2283", "2443"],
      );
    }
    assert.equal(
      run(["docker-compose.yml"]).volumes["model-cache"].name,
      "frameleaf_model-cache",
    );
    // FL-566: the ML-isolated overlay resolves on both base files and keeps each one's cache.
    const cacheOf = (config, service) =>
      config.services[service].volumes.find(
        (mount) => mount.target === "/cache",
      );
    for (const [filename, cacheLine, type, source] of [
      ["docker-compose.yml", [], "volume", "model-cache"],
      ["docker-compose.rootless.yml", [], "volume", "model-cache"],
      [
        "docker-compose.rootless.yml",
        ["FRAMELEAF_ML_CACHE=./ml-model-cache"],
        "bind",
        resolve(realpathSync(directory), "ml-model-cache"),
      ],
    ]) {
      writeFileSync(
        resolve(directory, ".env"),
        [env, "COMPOSE_PROFILES=model-staging", ...cacheLine].join("\n"),
      );
      const isolated = run([filename, "docker-compose.ml-isolated.yml"]);
      const inference = cacheOf(isolated, "frameleaf-machine-learning");
      assert.deepEqual(
        [inference.type, inference.source, inference.read_only],
        [type, source, true],
        filename,
      );
      const staging = cacheOf(isolated, "frameleaf-model-staging");
      assert.deepEqual([staging.type, staging.source], [type, source]);
      // An unused default volume is dropped, so a bind-mounted cache leaves no empty volume behind.
      assert.equal(
        isolated.volumes?.["model-cache"]?.name,
        type === "volume" ? "frameleaf_model-cache" : undefined,
      );
    }
    // Earlier stacks keep project "immich" (containers, network and volumes) and can move ports.
    writeFileSync(
      resolve(directory, ".env"),
      [
        env,
        "COMPOSE_PROJECT_NAME=immich",
        "FRAMELEAF_HOST_PORT=8283",
        "FRAMELEAF_HOST_HTTPS_PORT=8443",
      ].join("\n"),
    );
    const upgraded = run(["docker-compose.yml"]);
    assert.equal(upgraded.name, "immich");
    assert.equal(upgraded.volumes["model-cache"].name, "immich_model-cache");
    assert.equal(
      upgraded.volumes["studio-worker"].name,
      "immich_studio-worker",
    );
    assert.deepEqual(
      upgraded.services["frameleaf-server"].ports.map((port) => port.published),
      ["8283", "8443"],
    );
    assert.equal(
      upgraded.services["frameleaf-lan-discovery"].environment
        .FRAMELEAF_DISCOVERY_URL,
      "http://127.0.0.1:8283",
    );
    // docker-compose.override.yml beside the bundle is merged by default.
    writeFileSync(
      resolve(directory, "docker-compose.override.yml"),
      [
        "services:",
        "  frameleaf-server:",
        "    environment:",
        "      TZ: Europe/Paris",
        "",
      ].join("\n"),
    );
    const overridden = run([]);
    assert.equal(
      overridden.services["frameleaf-server"].environment.TZ,
      "Europe/Paris",
    );
    assert.equal(
      overridden.services["frameleaf-server"].container_name,
      "frameleaf_server",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

// Frameleaf operational paths use owned images; frozen attribution records remain historical.
const upstreamRegistry = ["ghcr.io", "immich-app"].join("/");
// Dated records of what was used when they were written; new files are never exempt.
const historicalRecords = new Set([
  ".superpowers/sdd/task-3-report.md",
  ".superpowers/sdd/task-6-report.md",
  "docs/docs/developer/evidence/fl25-toolchain-baseline.jsonl",
  "docs/superpowers/plans/2026-07-15-upstream-reversion-compatible-fork-schema.md",
  "docs/superpowers/plans/2026-07-16-fork-handoff-return-prerequisite.md",
  "docs/superpowers/plans/2026-07-16-task-6-certification-corrections.md",
]);
// Branding guard needles (FL-190): these files define the upstream strings their own guard rejects.
const guardNeedleFiles = new Set([
  "scripts/frameleaf-branding.mjs",
  "scripts/frameleaf-branding.test.mjs",
  "scripts/frameleaf-upstream-logo-hashes.json",
]);
const historicalRecord = (file) =>
  historicalRecords.has(file) || guardNeedleFiles.has(file);
const trackedFilesContaining = (needle) => {
  const result = spawnSync("git", ["grep", "-l", "-F", needle, "--", "."], {
    cwd: root,
    encoding: "utf8",
  });
  assert.ok(
    result.status === 0 || result.status === 1,
    result.error?.message || result.stderr,
  );
  return result.stdout.split("\n").filter(Boolean);
};

test("operational paths do not pull upstream images", () => {
  const unexpected = trackedFilesContaining(upstreamRegistry).filter(
    (file) => !historicalRecord(file),
  );
  assert.deepEqual(unexpected, []);
});

test("installation files and instructions come from Frameleaf releases, not upstream ones", () => {
  // Historical upstream release notes may be cited; nothing may download upstream release assets or scripts.
  const citations = new Set([
    "docker/frameleaf-delivery.test.mjs",
    "docs/docs/administration/backup-and-restore.md",
    "server/src/main.ts",
    // The About dialog links the upstream licence as part of the "Built on Immich" attribution.
    "web/src/lib/components/frameleaf/AboutDialog.svelte",
  ]);
  for (const needle of [
    ["github.com", "immich-app", "immich", "releases"].join("/"),
    ["github.com", "immich-app", "immich", "blob"].join("/") + "/",
    ["raw.githubusercontent.com", "immich-app"].join("/"),
  ]) {
    const unexpected = trackedFilesContaining(needle).filter(
      (file) => !citations.has(file) && !historicalRecord(file),
    );
    assert.deepEqual(unexpected, [], needle);
  }
  for (const file of citations) {
    if (file.endsWith(".mjs")) continue;
    for (const [url] of read(file).matchAll(
      /https:\/\/github\.com\/immich-app\/immich\/releases\S*/g,
    ))
      assert.match(url, /\/releases\/tag\/v1\.\d+\.\d+/, `${file}: ${url}`);
    for (const [url] of read(file).matchAll(
      /https:\/\/github\.com\/immich-app\/immich\/blob\/\S*/g,
    ))
      assert.match(url, /\/blob\/main\/LICENSE\b/, `${file}: ${url}`);
  }
  assert.doesNotMatch(
    read("docs/docs/install/kubernetes.md"),
    /immich-charts|helm install/i,
  );
  assert.match(
    read("install.sh"),
    /RepoUrl='https:\/\/github\.com\/Frameleaf\/frameleaf-app\/releases\/latest\/download'/,
  );
});

test("the server base is built in-repo and identical in the production and development Dockerfiles", () => {
  const block = (file) => {
    const match = read(file).match(
      /^# BEGIN frameleaf-server-base\n[\s\S]*?^# END frameleaf-server-base$/m,
    );
    assert.ok(match, `${file}: missing server base block`);
    return match[0];
  };
  assert.equal(block("server/Dockerfile.dev"), block("server/Dockerfile"));
  assert.match(read("server/Dockerfile.dev"), /^FROM base-server-dev AS dev$/m);
  for (const file of ["server/Dockerfile", "server/Dockerfile.dev"]) {
    assert.match(block(file), /\$\{VERSION_CODENAME\}-pgdg main 19/);
    assert.match(block(file), /^  postgresql-client-19 \\$/m);
    assert.doesNotMatch(block(file), /postgresql-client-(?:14|15|16|17|18)\b/);
    for (const [, image] of read(file).matchAll(/^FROM\s+(\S+)/gm)) {
      assert.ok(
        !image.includes("/") || /@sha256:[a-f0-9]{64}$/.test(image),
        `${file}: external base ${image} must be digest-pinned`,
      );
      assert.doesNotMatch(image, /immich-app/);
    }
    for (const [, source] of read(file).matchAll(
      /^COPY (server\/base-image\/\S+)/gm,
    ))
      assert.ok(existsSync(resolve(root, source)), `${file}: ${source}`);
  }
  // Every remote input is pinned: downloads by checksum, geodata to a fixed snapshot and date.
  const server = read("server/Dockerfile");
  for (const [line] of server.matchAll(/^ADD .*https:\/\/.*$/gm))
    assert.match(line, /--checksum=sha256:[a-f0-9]{64} /, line);
  assert.doesNotMatch(server, /^ADD (?:--\S+ )*https:\/\/download\.geonames/m);
  assert.match(server, /^ARG GEODATA_DATE=\d{4}-\d{2}-\d{2}T[\d:]+\+00:00$/m);
  const snapshot = server.match(
    /^ARG GEODATA_SNAPSHOT=(\d{4}-\d{2}-\d{2})$/m,
  )?.[1];
  assert.ok(snapshot, "geodata snapshot directory");
  const lock = read("server/base-image/geodata/geodata.lock");
  assert.ok(
    lock.includes(`https://static.frameleaf.cloud/geodata/${snapshot}/<file>`),
  );
  const entries = lock
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => line.split(/\s+/));
  assert.deepEqual(
    entries.map(([, name]) => name),
    [
      "cities500.zip",
      "admin1CodesASCII.txt",
      "admin2Codes.txt",
      "countryInfo.txt",
      "ne_10m_admin_0_countries.geojson",
      "landmarks.ndjson.gz",
    ],
  );
  for (const [sum, name, capture] of entries) {
    assert.match(sum, /^[a-f0-9]{64}$/, name);
    assert.match(
      capture,
      /^https:\/\/(?:web\.archive\.org\/web\/\d{14}id_\/|raw\.githubusercontent\.com\/nvkelso\/natural-earth-vector\/v5\.1\.2\/|raw\.githubusercontent\.com\/Frameleaf\/frameleaf-app\/[a-f0-9]{40}\/server\/base-image\/geodata\/landmarks\/)/,
      name,
    );
  }
  assert.match(lock, /CC BY 4\.0/);
  const fetch = read("server/base-image/geodata/fetch.sh");
  assert.match(
    fetch,
    /primary="https:\/\/static\.frameleaf\.cloud\/geodata\/\$\{GEODATA_SNAPSHOT\}"/,
  );
  assert.match(fetch, /sha256sum --strict --quiet -c -/);
  assert.doesNotMatch(server, /date --iso-8601/);
  assert.equal(
    (server.match(/^ {2}'[a-f0-9]{64} {2}[^']+\.deb' \\$/gm) ?? []).length,
    7,
    "every Intel driver package has a checksum",
  );
  assert.match(server, /sha256sum --strict -c intel-drivers\.sha256/);
  const driverPackages = [
    ...server.matchAll(/^  '[a-f0-9]{64}  ([^']+\.deb)' \\$/gm),
  ].map(([, name]) => name);
  const igcVersion = server.match(/^ARG IGC_VERSION=(.+)$/m)[1];
  const runtimeVersion = server.match(/^ARG COMPUTE_RUNTIME_VERSION=(.+)$/m)[1];
  const gmmVersion = server.match(/^ARG GMMLIB_VERSION=(.+)$/m)[1];
  assert.deepEqual(driverPackages, [
    "intel-igc-core_1.0.17537.24_amd64.deb",
    "intel-igc-opencl_1.0.17537.24_amd64.deb",
    "intel-opencl-icd-legacy1_24.35.30872.36_amd64.deb",
    `intel-igc-core-2_${igcVersion}_amd64.deb`,
    `intel-igc-opencl-2_${igcVersion}_amd64.deb`,
    `intel-opencl-icd_${runtimeVersion}_amd64.deb`,
    `libigdgmm12_${gmmVersion}_amd64.deb`,
  ]);

  // An unreachable package index fails the build instead of warning, and the HTTPS PostgreSQL source
  // keeps the CA certificates it needs in the runtime image.
  assert.doesNotMatch(server, /apt-get update/);
  assert.match(
    read("server/base-image/apt-update-strict.sh"),
    /apt-get update -o APT::Update::Error-Mode=any/,
  );
  assert.doesNotMatch(server, /apt-get remove[^\n]*ca-certificates/);
  // FL-281: the CLI is built alongside the pinned library; container stages execute ldd to
  // reject a missing dependency or a system LibRaw instead of the packaged /usr/local build.
  assert.doesNotMatch(server, /apt-get install[^\n]*libraw-bin/);
  assert.match(
    read("server/base-image/sources/libraw.sh"),
    /configure --enable-examples/,
  );
  for (const file of ["server/Dockerfile", "server/Dockerfile.dev"]) {
    assert.match(
      read(file),
      /COPY --from=base-server-libraw \/usr\/local\/bin\/dcraw_emu/,
    );
    assert.match(read(file), /ldd \/usr\/local\/bin\/dcraw_emu/);
  }
  assert.match(
    server,
    /COPY --from=base-server-dev \/usr\/local\/bin\/dcraw_emu/,
  );
  // The vendored build pins every compiled library to an exact revision.
  for (const name of [
    "imagemagick",
    "jpegli",
    "libheif",
    "libjxl",
    "libraw",
    "libvips",
  ]) {
    const pin = JSON.parse(read(`server/base-image/sources/${name}.json`));
    assert.match(pin.revision, /^[a-f0-9]{40}$/, name);
  }
  const ffmpeg = JSON.parse(read("server/base-image/packages/ffmpeg.json"));
  assert.match(ffmpeg.sha256.amd64, /^[a-f0-9]{64}$/);
  assert.match(ffmpeg.sha256.arm64, /^[a-f0-9]{64}$/);
  const ffmpegInstaller = read("server/base-image/packages/ffmpeg.sh");
  assert.match(
    ffmpegInstaller,
    /FFMPEG_PACKAGE="jellyfin-ffmpeg\$\{FFMPEG_VERSION%%\.\*\}_/,
  );
  assert.doesNotMatch(ffmpegInstaller, /jellyfin-ffmpeg[0-9]+_/);
  assert.match(ffmpegInstaller, /sha256sum -c ffmpeg\.sha256/);
  assert.match(
    ffmpegInstaller,
    /apt-get -yqq -f install "\.\/\$FFMPEG_PACKAGE"/,
  );
});

test("the owned Postgres image uses PG19 and pgvector only", () => {
  const dockerfile = read("docker/postgres/Dockerfile");
  assert.match(dockerfile, /postgres:19beta4/);
  assert.match(dockerfile, /0\.8\.7/);
  assert.doesNotMatch(dockerfile, /VECTORCHORD|PGVECTORS/);
  // Every test stack builds this image instead of pulling a database image.
  for (const [file, context] of [
    ["e2e/docker-compose.yml", "../docker/postgres"],
  ]) {
    const database = compose(file).services.database;
    assert.equal(database.build.context, context, file);
    assert.doesNotMatch(database.image, /\//, file);
  }
  assert.match(
    read("server/test/medium/globalSetup.ts"),
    /GenericContainer\.fromDockerfile\(postgresImageContext\)/,
  );
});

test("the Postgres workflow publishes the tested image once, by dispatch, without moving a version tag", () => {
  const workflow = load(read(".github/workflows/postgres.yml"));
  const { build, publish } = workflow.jobs;
  assert.deepEqual(build.permissions, { contents: "read" });
  const buildStep = build.steps.find(
    (step) => step.name === "Build without publishing",
  );
  assert.equal(buildStep.with.push, false);
  assert.equal(buildStep.with.context, "docker/postgres");
  assert.match(buildStep.with.outputs, /^type=docker,dest=/);
  // Releases are created with the workflow token and never trigger workflows.
  assert.equal(workflow.on.release, undefined);
  assert.deepEqual(publish.needs, "build");
  assert.match(publish.if, /vars\.FRAMELEAF_ENABLE_POSTGRES_PUBLISH == 'true'/);
  assert.match(publish.if, /github\.event_name == 'workflow_dispatch'/);
  assert.match(publish.if, /github\.ref == 'refs\/heads\/main'/);
  assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
  assert.equal(publish.env.IMAGE, "ghcr.io/frameleaf/frameleaf-postgres");
  // No rebuild after testing: the publisher only loads and pushes the tested archives.
  assert.ok(
    !publish.steps.some(
      (step) =>
        step.uses?.startsWith("docker/build-push-action@") ||
        step.uses?.startsWith("docker/setup-qemu-action@"),
    ),
  );
  const push = publish.steps.find((step) => step.id === "publish");
  assert.match(push.run, /docker load -i/);
  assert.match(push.run, /is not the tested/);
  assert.match(push.run, /already points to/);
  assert.match(push.run, /not found\|manifest unknown/);
  assert.match(push.run, /"amd64 arm64 "/);
  assert.ok(
    ["amd64", "arm64"].every((architecture) =>
      publish.steps.some(
        (step) =>
          step.uses?.startsWith("actions/attest-sbom@") &&
          step.with["subject-digest"].includes(`digest-${architecture}`),
      ),
    ),
  );
  assert.equal(publish.outputs.digest, "${{ steps.publish.outputs.digest }}");
  assert.ok(
    publish.steps.some(
      (step) =>
        step.uses?.startsWith("actions/upload-artifact@") &&
        step.with.name === "frameleaf-postgres-digest",
    ),
  );
  for (const action of [
    "anchore/sbom-action@",
    "actions/attest-sbom@",
    "actions/attest-build-provenance@",
  ])
    assert.ok(publish.steps.some((step) => step.uses?.startsWith(action)));
  const guard = publish.steps.findIndex(
    (step) =>
      step.name === "Verify release commit is the current delivery branch",
  );
  const login = publish.steps.findIndex(
    (step) => step.name === "Login to owned GHCR namespace",
  );
  assert.ok(guard >= 0 && guard < login);
});

test("release Compose files pull only digest-pinned or promotion-verified images", () => {
  const release = createRequire(import.meta.url)(
    "../.github/frameleaf-release.cjs",
  );
  for (const name of release.INSTALL_FILES.filter((file) =>
    file.startsWith("docker-compose"),
  )) {
    for (const [serviceName, service] of Object.entries(
      compose(`docker/${name}`).services,
    )) {
      const images =
        name === "docker-compose.ml-isolated.yml" && service.image === undefined
          ? ["docker-compose.yml", "docker-compose.rootless.yml"].map(
              (base) => compose(`docker/${base}`).services[serviceName]?.image,
            )
          : [service.image];
      for (const image of images) {
        assert.equal(typeof image, "string", `${name}:${serviceName}`);
        if (image.includes("${FRAMELEAF_VERSION")) continue;
        const owned = image.match(/^ghcr\.io\/frameleaf\/([a-z0-9-]+)[:@]/);
        // An unpinned Frameleaf dependency is only allowed because promotion verifies that it is
        // published and pins the bundled copy to the verified digest.
        if (owned && !/@sha256:[a-f0-9]{64}$/.test(image))
          assert.ok(release.DEPENDENCY_IMAGES.includes(owned[1]), image);
        else assert.match(image, /@sha256:[a-f0-9]{64}$/, image);
      }
    }
  }
  assert.equal(typeof release.verifyDependencyImages, "function");
  const dependencyVerification =
    /\bawait\s+verifyDependencyImages\s*\(\s*registry\s*,\s*process\.cwd\s*\(\s*\)\s*,?\s*\)/;
  assert.match(read(".github/frameleaf-release.cjs"), dependencyVerification);
  for (const invalid of [
    "const dependencies = [];",
    "verifyDependencyImages(registry, process.cwd())",
    "await verifyDependencyImages(otherRegistry, process.cwd())",
    "await verifyDependencyImages(registry, otherRoot)",
    "await verifyDependencyImages(registry)",
    "await verifyDependencyImages(registry, process.cwd(), extra)",
  ])
    assert.doesNotMatch(invalid, dependencyVerification);
});

test("canonical deployment uses PostgreSQL jobs with no cache service", () => {
  assert.doesNotMatch(
    read("server/bin/start.sh"),
    /REDIS_|VALKEY_|BULLMQ_|IOREDIS_|\b(?:redis|valkey|bullmq|ioredis)\b/i,
  );
  for (const file of [
    "docker/docker-compose.yml",
    "docker/docker-compose.rootless.yml",
    "docker/docker-compose.dev.yml",
    "docker/docker-compose.prod.yml",
    "e2e/docker-compose.yml",
    "e2e/docker-compose.dev.yml",
    "e2e/docker-compose.buddy.yml",
  ]) {
    const body = read(file);
    assert.doesNotMatch(body, /REDIS_|redis:|valkey|vchord/);
    assert.doesNotMatch(body, /\/var\/lib\/postgresql\/data/);
    for (const service of Object.values(compose(file).services)) {
      const deps = service.depends_on || [];
      assert(!Object.keys(deps).some((name) => name.startsWith("redis")));
    }
  }
  assert.match(read("docker/example.env"), /^DB_DATABASE_NAME=frameleaf$/m);
  const workflow = load(read(".github/workflows/postgres.yml"));
  // #312: frameleaf-app builds on GitHub-hosted runners.
  assert.deepEqual(workflow.jobs.build.strategy.matrix.runner, [
    "ubuntu-24.04",
    "ubuntu-24.04-arm",
  ]);
  const probe = workflow.jobs.build.steps.find(
    (step) => step.name === "Verify PostgreSQL and extension versions",
  );
  assert.equal(probe.env.EXPECTED_PG_MAJOR, "19");
  assert.equal(probe.env.EXPECTED_PGVECTOR, "0.8.7");
  assert.match(probe.run, /USING hnsw/);
});
