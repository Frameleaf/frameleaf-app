import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import test from "node:test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { load } = createRequire(path.join(root, "server/package.json"))(
  "js-yaml",
);
const read = (name) => readFileSync(path.join(root, name), "utf8");
const workflow = (name) => load(read(`.github/workflows/${name}.yml`));
// Independent fixed oracles from the frozen publisher/mirror manifest audit; no live resolution.
const images = {
  node: "mirror.gcr.io/library/node@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590",
  studio:
    "mirror.gcr.io/library/node@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4",
  postgres:
    "mirror.gcr.io/library/postgres@sha256:288c9defbb13c05fed2bfb55f859f1cf65dbd600f45bc89c91efbdd8f2a1e7b9",
  python:
    "mirror.gcr.io/library/python@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea",
  cuda: "mirror.gcr.io/nvidia/cuda@sha256:94c1577b2cd9dd6c0312dc04dff9cb2fdce2b268018abc3d7c2dbcacf1155000",
  ryuk: "mirror.gcr.io/testcontainers/ryuk@sha256:7c1a8a9a47c780ed0f983770a662f80deb115d95cce3e2daa3d12115b8cd28f0",
  buildkit:
    "mirror.gcr.io/moby/buildkit@sha256:cec9f139f45e93c5c69c60f8b07cfad9f43f4ef6b6a6cd917527fea5ff2e3dea",
  oasdiff:
    "mirror.gcr.io/tufin/oasdiff@sha256:cc59265b995bd19e1e87cf4302ab70b520f730c33ebdf52e3cfa154fe4a3b2fb",
};
const defaults = {
  node: "node:24.21.0-trixie-slim@sha256:db3ae80f5d8df06e04dabdf7b44cbf008d32de168205fa0294444aabbc08c590",
  studio:
    "node:24.21.0-bookworm@sha256:64af3819f9275802414d7cdc38c27e9d82bd564dec4d4da87d008255d36c63b4",
  postgres:
    "docker.io/library/postgres:19beta4-bookworm@sha256:288c9defbb13c05fed2bfb55f859f1cf65dbd600f45bc89c91efbdd8f2a1e7b9",
  python:
    "python:3.12-slim-trixie@sha256:78387bc3881b8273120a12ebe6c1ab22b018ccc2c9adf565ae1ac9b536e184ea",
  cuda: "nvidia/cuda:12.2.2-runtime-ubuntu22.04@sha256:94c1577b2cd9dd6c0312dc04dff9cb2fdce2b268018abc3d7c2dbcacf1155000",
};
const env = (job, key, image) =>
  assert.equal(job.env?.[key], images[image], key);
const step = (job, name) => job.steps.find((entry) => entry.name === name);
function checkRoutes(workflows) {
  const api = workflows.openapi.jobs["check-openapi"];
  env(api, "OASDIFF_IMAGE", "oasdiff");
  assert.match(
    step(api, "Check for breaking API changes").run,
    /"\$OASDIFF_IMAGE" breaking/,
  );
  for (const name of ["manager", "medium"]) {
    const job =
      name === "manager"
        ? workflows.manager.jobs.manager
        : workflows.tests.jobs["server-medium-tests"];
    env(job, "FRAMELEAF_CI_NODE_IMAGE", "node");
    env(job, "FRAMELEAF_CI_POSTGRES_IMAGE", "postgres");
    const bootstrap = job.steps.find((entry) =>
      /docker\/setup-buildx-action@/.test(entry.uses ?? ""),
    );
    assert.equal(bootstrap.with["driver-opts"], `image=${images.buildkit}`);
    assert.match(
      bootstrap.with["buildkitd-config-inline"],
      /mirrors = \["mirror.gcr.io"\]/,
    );
    const build = job.steps.find((entry) =>
      /docker\/build-push-action@/.test(entry.uses ?? ""),
    );
    assert.ok(
      build.with["build-args"].includes(
        "NODE_IMAGE=${{ env.FRAMELEAF_CI_NODE_IMAGE }}",
      ),
    );
  }
  const manager = workflows.manager.jobs.manager;
  assert.match(
    step(manager, "Build PostgreSQL from the owned pinned source").run,
    /--build-arg POSTGRES_IMAGE="\$FRAMELEAF_CI_POSTGRES_IMAGE"/,
  );
  const medium = workflows.tests.jobs["server-medium-tests"];
  env(medium, "RYUK_CONTAINER_IMAGE", "ryuk");
  const nested = step(medium, "Run all medium tests in the native runner").run;
  assert.match(nested, /--env FRAMELEAF_CI_POSTGRES_IMAGE/);
  assert.match(nested, /--env RYUK_CONTAINER_IMAGE/);
  assert.doesNotMatch(nested, /RYUK_DISABLED/);
  for (const name of ["e2e-tests-server-cli", "e2e-tests-web"]) {
    const job = workflows.tests.jobs[name];
    env(job, "FRAMELEAF_CI_NODE_IMAGE", "node");
    env(job, "FRAMELEAF_CI_STUDIO_NODE_IMAGE", "studio");
    env(job, "FRAMELEAF_CI_POSTGRES_IMAGE", "postgres");
  }
  const sql = workflows.tests.jobs["sql-schema-up-to-date"];
  env(sql, "FRAMELEAF_CI_POSTGRES_IMAGE", "postgres");
  assert.match(
    step(sql, "Start Frameleaf Postgres").run,
    /--build-arg POSTGRES_IMAGE="\$FRAMELEAF_CI_POSTGRES_IMAGE"/,
  );
  const lifecycle = workflows.studio.jobs["lifecycle-evidence"];
  env(lifecycle, "FRAMELEAF_CI_POSTGRES_IMAGE", "postgres");
  env(lifecycle, "RYUK_CONTAINER_IMAGE", "ryuk");
  const ml = workflows.fork.jobs["machine-learning-containers"];
  env(ml, "FRAMELEAF_CI_PYTHON_IMAGE", "python");
  env(ml, "FRAMELEAF_CI_CUDA_IMAGE", "cuda");
  const mlBuild = step(
    ml,
    "Build ML runtime with locked fork dependencies",
  ).run;
  assert.match(mlBuild, /--build-arg CPU_IMAGE="\$FRAMELEAF_CI_PYTHON_IMAGE"/);
  assert.match(mlBuild, /--build-arg CUDA_IMAGE="\$FRAMELEAF_CI_CUDA_IMAGE"/);
}
const workflows = () => ({
  openapi: workflow("check-openapi"),
  manager: workflow("manager"),
  tests: workflow("test"),
  studio: workflow("frameleaf-studio-engine"),
  fork: workflow("fork-integration"),
});

test("eight CI jobs route every observed registry caller to its exact frozen mirror manifest", () =>
  checkRoutes(workflows()));

test("CI route contract rejects missing nested propagation, bootstrap, and digest drift", () => {
  for (const mutate of [
    (w) => {
      delete w.tests.jobs["e2e-tests-web"].env.FRAMELEAF_CI_NODE_IMAGE;
    },
    (w) => {
      w.studio.jobs["lifecycle-evidence"].env.RYUK_CONTAINER_IMAGE =
        "testcontainers/ryuk:0.14.0";
    },
    (w) => {
      w.manager.jobs.manager.steps.find((s) =>
        /setup-buildx/.test(s.uses ?? ""),
      ).with["driver-opts"] = "image=moby/buildkit:buildx-stable-1";
    },
    (w) => {
      const s = step(
        w.tests.jobs["server-medium-tests"],
        "Run all medium tests in the native runner",
      );
      s.run = s.run.replace(
        "--env FRAMELEAF_CI_POSTGRES_IMAGE",
        "--env WRONG_POSTGRES_IMAGE",
      );
    },
    (w) => {
      w.openapi.jobs["check-openapi"].env.OASDIFF_IMAGE =
        images.oasdiff.replace(/.$/, "0");
    },
  ]) {
    const changed = workflows();
    mutate(changed);
    assert.throws(() => checkRoutes(changed));
  }
});

test("Dockerfile override seams preserve all original customer default identities and stage counts", () => {
  for (const file of [
    "server/Dockerfile",
    "server/Dockerfile.dev",
    "manager/Dockerfile",
    "packages/e2e-auth-server/Dockerfile",
  ]) {
    const source = read(file);
    assert.ok(source.includes(`ARG NODE_IMAGE=${defaults.node}\n`), file);
    assert.equal(
      [...source.matchAll(/^FROM \$\{NODE_IMAGE\}(?:\s|$)/gm)].length,
      file.endsWith("e2e-auth-server/Dockerfile") ||
        file.endsWith("Dockerfile.dev")
        ? 1
        : 2,
    );
    assert.doesNotMatch(source, /mirror.gcr.io/);
  }
  assert.ok(
    read("server/Dockerfile").includes(
      `ARG STUDIO_NODE_IMAGE=${defaults.studio}\n`,
    ),
  );
  assert.match(
    read("server/Dockerfile"),
    /^FROM \$\{STUDIO_NODE_IMAGE\} AS studio-engine$/m,
  );
  const ml = read("machine-learning/Dockerfile");
  for (const [argument, key] of [
    ["CPU_IMAGE", "python"],
    ["CUDA_IMAGE", "cuda"],
  ]) {
    assert.ok(ml.includes(`ARG ${argument}=${defaults[key]}\n`));
    assert.equal(
      [...ml.matchAll(new RegExp(`^FROM \\$\\{${argument}\\}`, "gm"))].length,
      2,
    );
  }
  assert.doesNotMatch(ml, /mirror.gcr.io/);
  assert.ok(
    read("docker/postgres/Dockerfile").includes(
      `ARG POSTGRES_IMAGE=${defaults.postgres}\n`,
    ),
  );
});

test("Compose routes fixture and all transitive bases with exact original fallbacks", () => {
  const compose = load(read("e2e/docker-compose.yml")).services;
  const fallback = (name, key) => "${" + name + ":-" + defaults[key] + "}";
  assert.equal(
    compose["e2e-auth-server"].build.args.NODE_IMAGE,
    fallback("FRAMELEAF_CI_NODE_IMAGE", "node"),
  );
  assert.ok(
    compose["frameleaf-server"].build.args.includes(
      "NODE_IMAGE=" + fallback("FRAMELEAF_CI_NODE_IMAGE", "node"),
    ),
  );
  assert.ok(
    compose["frameleaf-server"].build.args.includes(
      "STUDIO_NODE_IMAGE=" +
        fallback("FRAMELEAF_CI_STUDIO_NODE_IMAGE", "studio"),
    ),
  );
  assert.equal(
    compose.database.build.args.POSTGRES_IMAGE,
    fallback("FRAMELEAF_CI_POSTGRES_IMAGE", "postgres"),
  );
  for (const [file, service] of [
    ["ml", "immich-machine-learning-fixture"],
    ["frameleaf-cloud", "frameleaf-cloud-fixture"],
    ["icloud-bridge", "icloud-bridge-fixture"],
  ]) {
    const fixture = load(read(`e2e/docker-compose.${file}-fixture.yml`))
      .services[service];
    assert.equal(fixture.image, fallback("FRAMELEAF_CI_NODE_IMAGE", "node"));
  }
});

test("native medium and both OpenAPI policy callers consume the explicit override without changing local defaults", () => {
  const setup = read("server/test/medium/globalSetup.ts");
  assert.match(
    setup,
    /\.withBuildArgs\(\s*process.env.FRAMELEAF_CI_POSTGRES_IMAGE\s*\? \{ POSTGRES_IMAGE: process.env.FRAMELEAF_CI_POSTGRES_IMAGE \}\s*: \{\},?\s*\)/,
  );
  assert.doesNotMatch(setup, /mirror.gcr.io|RYUK_DISABLED/);
  const buildArgs = setup
    .match(/\.withBuildArgs\(\s*([\s\S]*?)\s*\)\s*\.build/)[1]
    .trim()
    .replace(/,$/, "");
  for (const [value, expected] of [
    [undefined, {}],
    ["", {}],
    [images.postgres, { POSTGRES_IMAGE: images.postgres }],
  ]) {
    const actual = runInNewContext(`(${buildArgs})`, {
      process: { env: { FRAMELEAF_CI_POSTGRES_IMAGE: value } },
    });
    assert.deepEqual(JSON.parse(JSON.stringify(actual)), expected);
  }
  for (const file of [
    "scripts/frameleaf-openapi-policy.test.mjs",
    "scripts/openapi-comparison-base.test.mjs",
  ]) {
    const source = read(file);
    assert.match(
      source,
      /const oasdiffImage = process.env.OASDIFF_IMAGE \?\? "tufin\/oasdiff:v1.31.0";/,
    );
    assert.match(
      source,
      /oasdiffImage,\s*"breaking",\s*"--format",\s*"json",\s*"--fail-on",\s*"ERR"/,
    );
  }
});
