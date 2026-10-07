#!/usr/bin/env node
// Shared release integrity check; NAS packaging also requires signed build provenance.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createRequire } = require("node:module");
const { isDeepStrictEqual } = require("node:util");
const { load } = createRequire(
  path.resolve(__dirname, "../server/package.json"),
)("js-yaml");
const {
  hash,
  INSTALL_FILES,
  VARIANTS,
  REPOSITORY,
  SOURCE,
  cosign,
  github,
  trustedRun,
  ATTESTATION_TYPE,
  COSIGN_PUBLIC_KEY,
} = require("./frameleaf-release.cjs");

async function verifyBundle(
  directory,
  expectedTag,
  { authenticate = false, run, request = github } = {},
) {
  assert.match(
    expectedTag,
    /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/,
  );
  const names = [
    ...INSTALL_FILES,
    "nas-manifest.json",
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
  assert.equal(manifest.schemaVersion, 3);
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
  const nas = JSON.parse(
    await fs.readFile(path.join(directory, "nas-manifest.json"), "utf8"),
  );
  verifyNasManifest(nas, manifest);
  const env = await fs.readFile(path.join(directory, "example.env"), "utf8");
  assert.deepEqual(
    // FL-294: FRAMELEAF_VERSION only; a leftover IMMICH_VERSION line would be a second, ignored setting
    env.match(
      /^[ \t]*(?:export[ \t]+)?(?:FRAMELEAF|IMMICH)_VERSION[ \t]*(?:=|:).*$/gm,
    ),
    [`FRAMELEAF_VERSION=${expectedTag}`],
    "Environment version differs",
  );
  for (const name of ["docker-compose.yml", "docker-compose.rootless.yml"]) {
    const compose = await fs.readFile(path.join(directory, name), "utf8");
    const services = load(compose)?.services;
    for (const [service, image] of [["database", "postgres"]])
      assert.equal(
        services?.[service]?.image,
        nas.images[image],
        `${name}: NAS ${image} differs`,
      );
    for (const [service, image] of [
      ["frameleaf-server", "frameleaf-server"],
      ["immich-machine-learning", "frameleaf-machine-learning"],
    ])
      assert.equal(
        services?.[service]?.image,
        `ghcr.io/frameleaf/${image}:\${FRAMELEAF_VERSION:-\${IMMICH_VERSION:-${expectedTag}}}`,
        `${name}: ${service} image version differs`,
      );
  }
  for (const name of names.filter((name) => name !== "release-manifest.json"))
    assert.equal(
      manifest.assets?.[name],
      `sha256:${checksums.get(name)}`,
      `${name} authenticated checksum differs`,
    );
  if (authenticate) {
    const key = path.resolve(__dirname, "..", COSIGN_PUBLIC_KEY);
    for (const image of manifest.images) {
      const reference = `${image.image}@${image.digest}`;
      cosign(["verify", "--key", key, reference], run);
      verifyAttestedPredicate(reference, ATTESTATION_TYPE, manifest, run);
    }
    const id = new RegExp(`^${SOURCE}/actions/runs/([0-9]+)$`).exec(
      manifest.buildRun,
    )?.[1];
    assert(
      id &&
        trustedRun(await request(`actions/runs/${id}`), manifest.sourceCommit),
      "Build provenance is not trusted",
    );
  }
  return manifest;
}

function verifyAttestedPredicate(reference, type, predicate, run) {
  const [image, digest] = reference.split("@");
  const envelopes = cosign(
    [
      "verify-attestation",
      "--key",
      path.resolve(__dirname, "..", COSIGN_PUBLIC_KEY),
      "--type",
      type,
      reference,
    ],
    run,
  )
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  assert(
    envelopes.some((envelope) => {
      const statement = JSON.parse(
        Buffer.from(envelope.payload, "base64").toString("utf8"),
      );
      return (
        statement.predicateType === type &&
        statement.subject?.some(
          (subject) =>
            subject.name === image &&
            subject.digest?.sha256 === digest.slice(7),
        ) &&
        isDeepStrictEqual(statement.predicate, predicate)
      );
    }),
    "Signed attestation differs from expected evidence",
  );
}

function verifyNasManifest(nas, release) {
  assert.equal(nas.schemaVersion, 3);
  for (const field of ["tag", "sourceCommit", "buildRun"])
    assert.equal(nas[field], release[field], `NAS ${field} differs`);
  for (const image of release.images) {
    const expected = image.image.endsWith("/frameleaf-server")
      ? nas.images.server
      : image.suffix
        ? nas.images.machineLearningVariants?.[image.suffix.slice(1)]
        : nas.images.machineLearning;
    assert.equal(
      expected,
      `${image.image}@${image.digest}`,
      "NAS release image differs",
    );
  }
  assert.match(
    nas.images.postgres,
    /^ghcr\.io\/frameleaf\/frameleaf-postgres:19beta4-pgvector0\.8\.7@sha256:[a-f0-9]{64}$/,
  );
  assert(
    release.dependencies?.some(
      ({ reference, digest }) =>
        `${reference.split("@")[0]}@${digest}` === nas.images.postgres,
    ),
    "NAS database was not verified for this release",
  );
}

module.exports = { verifyBundle, verifyNasManifest };
if (require.main === module)
  verifyBundle(process.argv[2], process.argv[3])
    .then((manifest) => console.log(`Verified ${manifest.tag} release assets`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
