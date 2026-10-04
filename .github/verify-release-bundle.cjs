#!/usr/bin/env node
// Shared release integrity check; NAS packaging also requires signed provenance and qualification.
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
  LEGACY_ATTESTATION_TYPE,
  COSIGN_PUBLIC_KEY,
  Registry,
} = require("./frameleaf-release.cjs");
const {
  CLI_IMAGE,
  validateCliQualification,
  verifyCliQualification,
} = require("./frameleaf-cli-qualification.cjs");

async function verifyBundle(
  directory,
  expectedTag,
  { authenticate = false, run, request = github, registry = new Registry() } = {},
) {
  assert.match(
    expectedTag,
    /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/,
  );
  const manifestFile = path.join(directory, "release-manifest.json");
  assert(
    (await fs.lstat(manifestFile)).isFile(),
    "release-manifest.json is not a regular file",
  );
  const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
  assert(
    manifest.schemaVersion === 2 || manifest.schemaVersion === 3,
    "Unsupported release manifest version",
  );
  const cliQualified = manifest.schemaVersion === 3;
  if (!cliQualified) {
    assert(
      !Object.hasOwn(manifest, "cliQualification"),
      "Historical v2 cannot claim CLI qualification",
    );
    assert(
      !Object.hasOwn(manifest.assets || {}, "cli-image.txt"),
      "Historical v2 cannot carry a CLI asset",
    );
    const cliFile = await fs
      .lstat(path.join(directory, "cli-image.txt"))
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
    assert.equal(cliFile, null, "Historical v2 cannot carry a CLI asset");
  }
  const names = [
    ...INSTALL_FILES,
    "supported-versions.json",
    "nas-manifest.json",
    "release-manifest.json",
    ...(cliQualified ? ["cli-image.txt"] : []),
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
  assert.equal(manifest.repository, REPOSITORY);
  assert.equal(manifest.tag, expectedTag, "Release tag differs");
  assert.match(manifest.sourceCommit, /^[a-f0-9]{40}$/);
  if (cliQualified) {
    const cliReference = validateCliQualification(
      manifest.cliQualification,
      manifest.sourceCommit,
    );
    const cliDependencies = manifest.dependencies?.filter(
      ({ reference }) => reference === `${CLI_IMAGE}:latest`,
    );
    assert.equal(
      cliDependencies?.length,
      1,
      "Missing or duplicate CLI bundle dependency",
    );
    assert.equal(
      cliDependencies[0].digest,
      manifest.cliQualification.publication.digest,
      "CLI bundle dependency differs",
    );
    assert.equal(
      await fs.readFile(path.join(directory, "cli-image.txt"), "utf8"),
      cliReference + "\n",
      "CLI install image differs from qualification",
    );
  }
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
    for (const [service, image] of [
      ["database", "postgres"],
      ["redis", "valkey"],
    ])
      assert.equal(
        services?.[service]?.image,
        nas.images[image],
        `${name}: NAS ${image} differs`,
      );
    for (const [service, image] of [
      ["immich-server", "frameleaf-server"],
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
      verifyAttestedPredicate(
        reference,
        cliQualified ? ATTESTATION_TYPE : LEGACY_ATTESTATION_TYPE,
        manifest,
        run,
      );
    }
    const id = new RegExp(`^${SOURCE}/actions/runs/([0-9]+)$`).exec(
      manifest.certifiedBuildRun,
    )?.[1];
    assert(
      id &&
        trustedRun(await request(`actions/runs/${id}`), manifest.sourceCommit),
      "Build certification is not trusted",
    );
    if (cliQualified)
      await verifyCliQualification(
        registry,
        manifest.sourceCommit,
        manifest.cliQualification,
        { run },
      );
  }
  return manifest;
}

const NAS_ATTESTATION_TYPE =
  "https://frameleaf.app/attestations/nas-qualification/v1";
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

async function verifyNasCertification(
  nas,
  release,
  receipts,
  { request = github, run } = {},
) {
  assert.equal(nas.schemaVersion, 1);
  for (const field of ["tag", "sourceCommit", "certifiedBuildRun"])
    assert.equal(nas[field], release[field], `NAS ${field} differs`);
  for (const image of release.images) {
    const reference = `${image.image}@${image.digest}`;
    const expected = image.image.endsWith("/frameleaf-server")
      ? nas.images.server
      : image.suffix
        ? nas.images.machineLearningVariants?.[image.suffix.slice(1)]
        : nas.images.machineLearning;
    assert.equal(expected, reference, "NAS release image differs");
  }
  assert.match(
    nas.images.postgres,
    /^ghcr\.io\/frameleaf\/frameleaf-postgres(?::[^@\s]+)?@sha256:[a-f0-9]{64}$/,
  );
  assert(
    release.dependencies?.some(
      ({ reference, digest }) =>
        `${reference.split("@")[0]}@${digest}` === nas.images.postgres,
    ),
    "NAS database was not verified for this release",
  );
  for (const family of ["officialImmich", "priorFrameleaf"]) {
    const versions = nas.migration?.[family];
    assert(
      Array.isArray(versions) &&
        versions.length &&
        versions.every((version) => typeof version === "string"),
      `${family} migration version allowlist is required`,
    );
    const sources = receipts?.[family];
    assert(
      Array.isArray(sources),
      `${family} migration qualification receipts are required`,
    );
    assert.deepEqual(
      sources.map((source) => source.version).sort(),
      [...versions].sort(),
      "Migration receipts differ from release allowlist",
    );
    for (const source of sources) {
      assert(
        source && typeof source === "object",
        "Migration qualification needs an evidence receipt",
      );
      assert.match(
        source.version,
        family === "officialImmich"
          ? /^v\d+\.\d+\.\d+$/
          : /^frameleaf-v\d+\.\d+\.\d+-\d+$/,
      );
      const evidence = source.evidence;
      assert.match(evidence?.commit ?? "", /^[a-f0-9]{40}$/);
      assert.match(
        evidence?.path ?? "",
        /^packaging\/nas\/qualification\/[a-z0-9-]+\.json$/,
      );
      assert.match(evidence?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
      const file = await request(
        `contents/${evidence.path}?ref=${evidence.commit}`,
      );
      assert.equal(
        file.encoding,
        "base64",
        "Missing migration qualification report",
      );
      const bytes = Buffer.from(file.content, "base64");
      assert.equal(
        hash(bytes),
        evidence.digest,
        "Migration evidence checksum differs",
      );
      const report = JSON.parse(bytes);
      assert.equal(report.schemaVersion, 1);
      assert.equal(report.environment, "sanitized-production-shaped");
      assert.equal(report.sourceVersion, source.version);
      assert.equal(
        report.targetServer,
        nas.images.server,
        "Migration target server differs",
      );
      assert.equal(
        report.targetPostgres,
        nas.images.postgres,
        "Migration target database differs",
      );
      assert.deepEqual(report.checks, {
        preflight: "passed",
        backupRestore: "passed",
        migration: "passed",
        rollback: "passed",
      });
      // Qualification runs after image publication. Its separately signed receipt need not be in the release commit.
      verifyAttestedPredicate(
        nas.images.server,
        NAS_ATTESTATION_TYPE,
        report,
        run,
      );
      assert.match(report.sourceCommit, /^[a-f0-9]{40}$/);
      const id = new RegExp(`^${SOURCE}/actions/runs/([0-9]+)$`).exec(
        report.run,
      )?.[1];
      assert(
        id &&
          trustedRun(
            await request(`actions/runs/${id}`),
            report.sourceCommit,
            ".github/workflows/nas-qualification.yml",
          ),
        "Migration evidence run is not trusted",
      );
      const jobs = await request(
        `actions/runs/${id}/jobs?filter=latest&per_page=100`,
      );
      assert(jobs.total_count <= 100, "Migration evidence jobs are incomplete");
      const job = jobs.jobs?.find(
        (job) =>
          job.name === `NAS qualification (${family}, ${source.version})`,
      );
      assert(
        job?.conclusion === "success" &&
          ["Preflight", "Backup and restore", "Migration", "Rollback"].every(
            (name) =>
              job.steps?.some(
                (step) => step.name === name && step.conclusion === "success",
              ),
          ),
        "Missing successful migration qualification steps",
      );
    }
  }
}

module.exports = { verifyBundle, verifyNasCertification, NAS_ATTESTATION_TYPE };
if (require.main === module)
  verifyBundle(process.argv[2], process.argv[3])
    .then((manifest) => console.log(`Verified ${manifest.tag} release assets`))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
