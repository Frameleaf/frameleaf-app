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
  MANAGER_ASSETS,
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
  assert.match(expectedTag, /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  const names = MANAGER_ASSETS.filter((name) => name !== "SHA256SUMS");
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
    ["FRAMELEAF_VERSION=latest"],
    "Environment version differs",
  );
  assert.deepEqual(
    env.match(/^# This release: .*$/gm),
    [`# This release: FRAMELEAF_VERSION=${expectedTag}`],
    "Environment release tag differs",
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
      ["frameleaf-machine-learning", "frameleaf-machine-learning"],
    ])
      assert.equal(
        services?.[service]?.image,
        `ghcr.io/frameleaf/${image}:\${FRAMELEAF_VERSION:-\${IMMICH_VERSION:-latest}}`,
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
  // The database image tag comes from the bundle (review M2): any frameleaf-postgres release build with a
  // PostgreSQL major, optional beta/rc or minor, and its pgvector version, pinned by digest and verified as a
  // dependency of this release. Which tag ships (e.g. the move from a beta to GA) is a release decision
  // declared below, not a constant in this verifier.
  assert.match(
    nas.images.postgres,
    POSTGRES_IMAGE,
    "NAS database image is not a digest-pinned frameleaf-postgres build",
  );
  assert(
    release.dependencies?.some(
      ({ reference, digest }) =>
        `${reference.split("@")[0]}@${digest}` === nas.images.postgres,
    ),
    "NAS database was not verified for this release",
  );
  verifyDatabaseImageChange(nas.databaseImageChange, nas.images.postgres);
}

const POSTGRES_IMAGE =
  /^ghcr\.io\/frameleaf\/frameleaf-postgres:(\d+)(?:beta\d+|rc\d+|\.\d+)?-pgvector\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/;
const POSTGRES_REFERENCE =
  /^ghcr\.io\/frameleaf\/frameleaf-postgres:(\d+)(?:beta\d+|rc\d+|\.\d+)?-pgvector\d+\.\d+\.\d+$/;

/**
 * A release that replaces the database image in place (same PostgreSQL major, no logical restore) must say
 * so in the signed NAS manifest: exactly which previous image references it may replace and that a
 * checkpoint backup precedes the change. Manager moves every undeclared database image change by dump and
 * restore into a new folder (FL-1265). Absent for releases that keep their database image or move it.
 */
function verifyDatabaseImageChange(change, postgres) {
  if (change === undefined) return;
  assert(
    change && typeof change === "object" && !Array.isArray(change),
    "NAS databaseImageChange must be an object",
  );
  assert.deepEqual(
    Object.keys(change)
      .filter((key) => key !== "notes")
      .sort(),
    ["from", "requiresBackup", "strategy", "to"],
    "NAS databaseImageChange has unexpected fields",
  );
  assert.equal(change.strategy, "in-place", "NAS databaseImageChange strategy");
  assert.equal(
    change.requiresBackup,
    true,
    "NAS databaseImageChange must require a backup",
  );
  assert.equal(
    change.to,
    postgres.split("@")[0],
    "NAS databaseImageChange target differs from the database image",
  );
  const major = POSTGRES_REFERENCE.exec(change.to)?.[1];
  assert(
    major,
    "NAS databaseImageChange target is not a frameleaf-postgres reference",
  );
  assert(
    Array.isArray(change.from) &&
      change.from.length > 0 &&
      new Set(change.from).size === change.from.length,
    "NAS databaseImageChange.from must list previous image references",
  );
  for (const previous of change.from) {
    const from = POSTGRES_REFERENCE.exec(previous)?.[1];
    assert(
      from,
      `NAS databaseImageChange.from entry is not a frameleaf-postgres reference: ${previous}`,
    );
    assert.equal(
      from,
      major,
      `NAS databaseImageChange crosses a PostgreSQL major (${previous}); that needs a restore`,
    );
    assert.notEqual(
      previous,
      change.to,
      "NAS databaseImageChange.from repeats the target",
    );
  }
  if (change.notes !== undefined)
    assert.equal(
      typeof change.notes,
      "string",
      "NAS databaseImageChange notes must be text",
    );
}

module.exports = {
  verifyBundle,
  verifyNasManifest,
  verifyAttestedPredicate,
  verifyDatabaseImageChange,
};
if (require.main === module)
  verifyBundle(process.argv[2], process.argv[3])
    .then((manifest) => console.log(`Verified ${manifest.tag} release assets`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
