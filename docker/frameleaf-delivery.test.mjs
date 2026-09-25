import assert from "node:assert/strict";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
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
const databaseImage =
  "ghcr.io/immich-app/postgres:14-vectorchord0.4.3-pgvectors0.2.0@sha256:bcf63357191b76a916ae5eb93464d65c07511da41e3bf7a8416db519b40b1c23";

for (const [filename, project, rootless] of [
  ["docker-compose.yml", "immich", false],
  ["docker-compose.rootless.yml", "immich", true],
]) {
  test(`${filename}: Frameleaf images preserve installed storage and network contracts`, () => {
    const config = compose(`docker/${filename}`);
    assert.equal(config.name, project);
    assert.deepEqual(Object.keys(config.services), [
      "immich-server",
      "immich-machine-learning",
      "redis",
      "database",
    ]);
    const server = config.services["immich-server"];
    const ml = config.services["immich-machine-learning"];
    assert.equal(
      server.image,
      "ghcr.io/frameleaf/frameleaf-server:${IMMICH_VERSION:-release}",
    );
    assert.equal(
      ml.image,
      "ghcr.io/frameleaf/frameleaf-machine-learning:${IMMICH_VERSION:-release}",
    );
    assert.equal(server.container_name, "frameleaf_server");
    assert.equal(ml.container_name, "frameleaf_machine_learning");
    assert.equal(config.services.database.container_name, "frameleaf_postgres");
    assert.equal(config.services.redis.container_name, "frameleaf_redis");
    assert.deepEqual(server.volumes, [
      "${UPLOAD_LOCATION}:/data",
      "/etc/localtime:/etc/localtime:ro",
    ]);
    assert.deepEqual(config.services.database.volumes, [
      "${DB_DATA_LOCATION}:/var/lib/postgresql/data",
    ]);
    assert.deepEqual(ml.volumes, [
      rootless ? "./ml-model-cache:/cache" : "model-cache:/cache",
    ]);
    assert.equal(config.services.database.image, databaseImage);
    assert.equal(
      config.services.database.environment.POSTGRES_DB,
      "${DB_DATABASE_NAME}",
    );
    assert.equal(
      config.services.database.environment.POSTGRES_USER,
      "${DB_USERNAME}",
    );
    assert.deepEqual(server.depends_on, ["redis", "database"]);
    assert.deepEqual(server.env_file, [".env"]);
    assert.deepEqual(server.ports, ["2283:2283"]);
    if (rootless) {
      assert.equal(server.user, "1000:1000");
      assert.equal(ml.user, "1000:1000");
      assert.deepEqual(config.services.redis.volumes, ["./redis:/data"]);
    } else {
      assert.deepEqual(config.volumes, { "model-cache": null });
    }
  });
}

test("local builds retain projects/storage and build ordinary ML from the prod stage", () => {
  for (const [filename, project, cache] of [
    ["docker-compose.prod.yml", "immich-prod", "model-cache"],
    ["docker-compose.dev.yml", "immich-dev", "model_cache"],
  ]) {
    const config = compose(`docker/${filename}`);
    assert.equal(config.name, project);
    assert.ok(
      config.services["immich-server"].volumes.includes(
        "${UPLOAD_LOCATION}/photos:/data",
      ),
    );
    assert.deepEqual(config.services.database.volumes, [
      "${UPLOAD_LOCATION}/postgres:/var/lib/postgresql/data",
    ]);
    assert.equal(config.services.database.image, databaseImage);
    assert.equal(
      config.services["immich-machine-learning"].build.target,
      "prod",
    );
    assert.ok(
      config.services["immich-machine-learning"].volumes.includes(
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
  for (const path of [
    ".devcontainer/server/container-compose-overrides.yml",
    ".devcontainer/mobile/container-compose-overrides.yml",
  ]) {
    assert.equal(
      compose(path).services["immich-server"].image,
      dev.services["immich-server"].image,
    );
  }
  assert.equal(
    dev.services["immich-server"].environment.IMMICH_SOURCE_COMMIT,
    "",
  );
  assert.equal(dev.services["immich-server"].environment.IMMICH_BUILD, "");
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
    worker.environment.IMMICH_ML_AUTH_TOKEN,
    "${FRAMELEAF_RESTORATION_TOKEN:-}",
  );
  assert.ok(
    worker.volumes.some((volume) =>
      volume.endsWith(":/restoration/config:ro"),
    ),
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
    const env = line.match(/^ENV (IMMICH_[A-Z_]+)=(.*)$/);
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
      BUILD_SOURCE_REF: "fork/main",
      BUILD_IMAGE: `ghcr.io/frameleaf/${image}:edge`,
    };
    const values = metadata(file, inputs);
    assert.equal(values.IMMICH_REPOSITORY, "Frameleaf/frameleaf-app");
    assert.equal(values.IMMICH_BUILD_IMAGE, inputs.BUILD_IMAGE);
    assert.equal(
      values.IMMICH_BUILD_URL,
      "https://github.com/Frameleaf/frameleaf-app/actions/runs/12345",
    );
    assert.equal(
      values.IMMICH_BUILD_IMAGE_URL,
      `https://github.com/Frameleaf/frameleaf-app/pkgs/container/${image}`,
    );
    assert.equal(
      values.IMMICH_SOURCE_URL,
      `https://github.com/Frameleaf/frameleaf-app/commit/${inputs.BUILD_SOURCE_COMMIT}`,
    );
    assert.equal(values.IMMICH_SOURCE_REF, "fork/main");
    const custom = metadata(file, {
      ...inputs,
      BUILD_SOURCE_REPOSITORY: "Frameleaf/test-build",
      BUILD_IMAGE_NAME: "test-image",
    });
    assert.equal(
      custom.IMMICH_BUILD_IMAGE_URL,
      "https://github.com/Frameleaf/test-build/pkgs/container/test-image",
    );
    assert.equal(custom.IMMICH_REPOSITORY, "Frameleaf/test-build");
    assert.doesNotMatch(
      read(file),
      /^ENV IMMICH_.*(?:immich-app\/immich|adamtaylor152)/m,
    );
    assert.match(
      read(file),
      /LABEL org\.opencontainers\.image\.source="https:\/\/github.com\/\$\{BUILD_SOURCE_REPOSITORY\}"/,
    );
  });
}

test("pinned build dependencies, runtime identity and orphan adoption remain compatible", () => {
  assert.match(
    read("server/Dockerfile"),
    /^FROM ghcr\.io\/immich-app\/base-server-prod:[^\n]+@sha256:[a-f0-9]{64} AS prod$/m,
  );
  assert.match(
    read("server/Dockerfile"),
    /^HEALTHCHECK CMD immich-healthcheck$/m,
  );
  assert.match(
    read("machine-learning/Dockerfile"),
    /^CMD \["python", "-m", "immich_ml"\]$/m,
  );
  assert.doesNotMatch(read("machine-learning/Dockerfile"), /AS prod-runpod/);
  assert.ok(
    read("server/src/dtos/config.dto.ts").includes(
      "'http://immich-machine-learning:3003'",
    ),
  );
  assert.match(read("docker/example.env"), /^IMMICH_VERSION=release$/m);
  assert.match(read("docker/example.env"), /^DB_DATABASE_NAME=immich$/m);
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
      "DB_DATABASE_NAME=immich",
      "IMMICH_VERSION=frameleaf-v3.1.0-7",
    ].join("\n");
    writeFileSync(resolve(directory, ".env"), env);
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
        result.services["immich-server"].container_name,
        "frameleaf_server",
      );
      assert.equal(result.services.database.environment.POSTGRES_DB, "immich");
      if (!filename.includes(".dev.") && !filename.includes(".prod.")) {
        assert.equal(
          result.services["immich-server"].image,
          "ghcr.io/frameleaf/frameleaf-server:frameleaf-v3.1.0-7",
        );
        assert.equal(
          result.services["immich-machine-learning"].image,
          "ghcr.io/frameleaf/frameleaf-machine-learning:frameleaf-v3.1.0-7",
        );
      }
    }
    writeFileSync(
      resolve(directory, "hardware.yml"),
      [
        "services:",
        "  immich-server:",
        "    extends:",
        "      file: hwaccel.transcoding.yml",
        "      service: nvenc",
        "  immich-machine-learning:",
        "    extends:",
        "      file: hwaccel.ml.yml",
        "      service: cuda",
        "    image: ghcr.io/frameleaf/frameleaf-machine-learning:${IMMICH_VERSION}-cuda",
        "",
      ].join("\n"),
    );
    const hardware = run(["docker-compose.yml", "hardware.yml"]);
    assert.equal(
      hardware.services["immich-machine-learning"].image,
      "ghcr.io/frameleaf/frameleaf-machine-learning:frameleaf-v3.1.0-7-cuda",
    );
    assert.equal(
      hardware.services["immich-server"].deploy.resources.reservations
        .devices[0].driver,
      "nvidia",
    );
    assert.equal(
      hardware.services["immich-machine-learning"].deploy.resources.reservations
        .devices[0].driver,
      "nvidia",
    );
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});
