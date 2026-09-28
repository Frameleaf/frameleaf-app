#!/usr/bin/env node
// Offline integrity and version check for release assets before NAS packaging.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { load } = createRequire(
  path.resolve(__dirname, "../server/package.json"),
)("js-yaml");
const {
  hash,
  INSTALL_FILES,
  VARIANTS,
  REPOSITORY,
} = require("./frameleaf-release.cjs");

async function verifyBundle(directory, expectedTag) {
  assert.match(
    expectedTag,
    /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/,
  );
  const names = [
    ...INSTALL_FILES,
    "supported-versions.json",
    "release-manifest.json",
  ];
  const lines = (await fs.readFile(path.join(directory, "SHA256SUMS"), "utf8"))
    .trimEnd()
    .split("\n");
  assert.equal(lines.length, names.length, "Incomplete release checksums");
  const checksums = new Map();
  for (const line of lines) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9.-]+)$/.exec(line);
    assert(
      match && names.includes(match[2]),
      `Invalid checksum entry: ${line}`,
    );
    assert(!checksums.has(match[2]), `Duplicate checksum: ${match[2]}`);
    checksums.set(match[2], match[1]);
  }
  for (const name of names) {
    const file = path.join(directory, name);
    assert((await fs.lstat(file)).isFile(), `${name} is not a regular file`);
    assert.equal(
      hash(await fs.readFile(file)).slice(7),
      checksums.get(name),
      `${name} checksum differs`,
    );
  }
  const manifest = JSON.parse(
    await fs.readFile(path.join(directory, "release-manifest.json"), "utf8"),
  );
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.repository, REPOSITORY);
  assert.equal(manifest.tag, expectedTag, "Release tag differs");
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  assert.equal(
    manifest.images?.length,
    VARIANTS.length,
    "Incomplete image set",
  );
  for (const spec of VARIANTS) {
    const image = manifest.images.find(
      (item) =>
        item.image === `ghcr.io/frameleaf/${spec.image}` &&
        item.suffix === spec.suffix,
    );
    assert(image, `Missing ${spec.image}${spec.suffix}`);
    assert.match(image.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      image.sourceCommit,
      manifest.sourceCommit,
      "Image source differs",
    );
  }
  const env = await fs.readFile(path.join(directory, "example.env"), "utf8");
  assert.deepEqual(
    env.match(/^[ \t]*(?:export[ \t]+)?IMMICH_VERSION[ \t]*(?:=|:).*$/gm),
    [`IMMICH_VERSION=${expectedTag}`],
    "Environment version differs",
  );
  for (const name of ["docker-compose.yml", "docker-compose.rootless.yml"]) {
    const compose = await fs.readFile(path.join(directory, name), "utf8");
    const services = load(compose)?.services;
    for (const [service, image] of [
      ["immich-server", "frameleaf-server"],
      ["immich-machine-learning", "frameleaf-machine-learning"],
    ])
      assert.equal(
        services?.[service]?.image,
        `ghcr.io/frameleaf/${image}:\${IMMICH_VERSION:-${expectedTag}}`,
        `${name}: ${service} image version differs`,
      );
  }
  return manifest;
}

module.exports = { verifyBundle };
if (require.main === module)
  verifyBundle(process.argv[2], process.argv[3])
    .then((manifest) => console.log(`Verified ${manifest.tag} release assets`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
