// Same-source CLI publication evidence. Importing this module performs no I/O.
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const {
  REPOSITORY,
  SOURCE,
  hash,
  github,
  trustedRun,
  cosign,
  COSIGN_PUBLIC_KEY,
  checkedResponse,
} = require("./frameleaf-release.cjs");
const CLI_IMAGE = "ghcr.io/frameleaf/frameleaf-cli";
const CLI_WORKFLOW = ".github/workflows/cli.yml";
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REQUIRED_CLI_JOBS = Object.freeze([
  "CLI container build (amd64)",
  "CLI container build (arm64)",
  "CLI Publish",
]);
const positive = (value) => Number.isSafeInteger(value) && value > 0;

function validateCliQualification(evidence, sha) {
  assert(
    SHA.test(sha) && positive(evidence?.runId) && positive(evidence.attempt),
    "Invalid CLI qualification identity",
  );
  assert(
    Array.isArray(evidence.jobs) && evidence.jobs.length === 3,
    "Incomplete CLI jobs",
  );
  assert.deepEqual(
    evidence.jobs.map(({ name }) => name),
    REQUIRED_CLI_JOBS,
    "Wrong CLI jobs",
  );
  assert(
    evidence.jobs.every(({ id }) => positive(id)) &&
      new Set(evidence.jobs.map(({ id }) => id)).size === 3,
    "Invalid CLI job identity",
  );
  assert(
    positive(evidence.artifact?.id) && DIGEST.test(evidence.artifact.digest),
    "Invalid CLI artifact identity",
  );
  const receipt = evidence.publication;
  assert.equal(receipt?.image, CLI_IMAGE, "Wrong CLI publication image");
  assert.equal(receipt.sourceCommit, sha, "CLI publication source differs");
  assert.equal(
    receipt.runId,
    String(evidence.runId),
    "CLI publication run differs",
  );
  assert(DIGEST.test(receipt.digest), "Invalid CLI index digest");
  assert(
    Array.isArray(receipt.architectures) && receipt.architectures.length === 2,
    "Incomplete CLI native receipts",
  );
  assert.deepEqual(
    receipt.architectures.map(({ architecture }) => architecture).sort(),
    ["amd64", "arm64"],
    "Wrong CLI architectures",
  );
  assert.equal(
    new Set(receipt.architectures.map(({ digest }) => digest)).size,
    2,
    "Duplicate CLI native digest",
  );
  for (const native of receipt.architectures) {
    assert.equal(native.repository, REPOSITORY, "Wrong CLI receipt repository");
    assert.equal(native.sourceCommit, sha, "CLI native source differs");
    assert.equal(
      native.runId,
      String(evidence.runId),
      "CLI native run differs",
    );
    assert.equal(
      native.runAttempt,
      String(evidence.attempt),
      "CLI native attempt differs",
    );
    assert.equal(native.smoke, "passed", "CLI native smoke did not pass");
    assert(
      DIGEST.test(native.digest) && DIGEST.test(native.configDigest),
      "Invalid CLI native digest",
    );
    assert(
      /^[a-f0-9]{64}$/.test(native.archiveSha256),
      "Invalid CLI native archive hash",
    );
    assert(
      Array.isArray(native.rootfsDiffIds) &&
        native.rootfsDiffIds.length > 0 &&
        native.rootfsDiffIds.every((digest) => DIGEST.test(digest)),
      "Invalid CLI native rootfs",
    );
  }
  return `${CLI_IMAGE}@${receipt.digest}`;
}

async function cliJobs(record, sha, request) {
  assert(
    trustedRun(record, sha, CLI_WORKFLOW) &&
      record.event === "workflow_dispatch" &&
      positive(record.id) &&
      positive(record.run_attempt),
    "CLI publication run is not trusted and successful",
  );
  const response = await request(
    `actions/runs/${record.id}/attempts/${record.run_attempt}/jobs?per_page=100`,
  );
  assert(
    Array.isArray(response.jobs) &&
      Number.isSafeInteger(response.total_count) &&
      response.total_count === response.jobs.length &&
      response.jobs.length < 100,
    "Incomplete CLI jobs response",
  );
  const jobs = REQUIRED_CLI_JOBS.map((name) => {
    const matches = response.jobs.filter((job) => job.name === name);
    assert.equal(matches.length, 1, "Missing or duplicate CLI job");
    const job = matches[0];
    assert(
      positive(job.id) &&
        job.run_id === record.id &&
        job.head_sha === sha &&
        job.head_branch === "fork/main" &&
        job.workflow_name === "CLI Build" &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        (job.run_attempt === undefined ||
          job.run_attempt === record.run_attempt),
      "CLI job is not successful same-source attempt evidence",
    );
    return { id: job.id, name };
  });
  assert.equal(
    new Set(jobs.map(({ id }) => id)).size,
    3,
    "Duplicate CLI job identity",
  );
  return jobs;
}

async function downloadCliPublication(
  artifact,
  { run = execFileSync, fetcher = fetch } = {},
) {
  // Follow the authenticated API redirect without forwarding the token to artifact storage.
  const response = await fetcher(
    `https://api.github.com/repos/${REPOSITORY}/actions/artifacts/${artifact.id}/zip`,
    {
      headers: {
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    },
  );
  assert.equal(response.status, 302, "CLI artifact download did not redirect");
  const location = new URL(response.headers.get("location"));
  assert(
    location.protocol === "https:" && !location.username && !location.password,
    "Invalid CLI artifact redirect",
  );
  const bytes = await checkedResponse(
    await fetcher(location.href, {
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
    }),
    1024 * 1024,
  );
  assert.equal(
    hash(bytes),
    artifact.digest,
    "CLI artifact archive digest differs",
  );
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frameleaf-cli-publication-"),
  );
  try {
    const archive = path.join(directory, "publication.zip");
    await fs.writeFile(archive, bytes);
    const options = {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const names = run("unzip", ["-Z1", archive], options).trim().split("\n");
    assert.deepEqual(
      names,
      ["cli-publication.json"],
      "Unexpected CLI artifact entries",
    );
    return JSON.parse(
      run("unzip", ["-p", archive, "cli-publication.json"], options),
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function verifyCliQualification(
  registry,
  sha,
  evidence,
  { run = execFileSync } = {},
) {
  const reference = validateCliQualification(evidence, sha);
  const receipt = evidence.publication;
  const read = (digest, kind) =>
    registry.read("frameleaf-cli", digest, kind, { anonymous: true });
  const index = await read(receipt.digest, "manifests");
  assert.equal(index.digest, receipt.digest, "CLI immutable index differs");
  assert(
    index.json.schemaVersion === 2 &&
      index.json.mediaType === "application/vnd.oci.image.index.v1+json",
    "CLI publication is not an OCI index",
  );
  assert.equal(
    index.json.annotations?.["org.opencontainers.image.source"],
    SOURCE,
    "CLI index repository differs",
  );
  assert.equal(
    index.json.annotations?.["org.opencontainers.image.revision"],
    sha,
    "CLI index source differs",
  );
  assert(
    Array.isArray(index.json.manifests) && index.json.manifests.length === 2,
    "CLI index native children incomplete",
  );
  const key = path.resolve(__dirname, "..", COSIGN_PUBLIC_KEY);
  cosign(["verify", "--key", key, reference], run);
  for (const native of receipt.architectures) {
    const descriptors = index.json.manifests.filter(
      (item) =>
        item.platform?.os === "linux" &&
        item.platform.architecture === native.architecture,
    );
    assert.equal(
      descriptors.length,
      1,
      "CLI native descriptor missing or duplicated",
    );
    const descriptor = descriptors[0];
    assert.equal(
      descriptor.digest,
      native.digest,
      "CLI native child differs from smoke receipt",
    );
    assert.equal(
      descriptor.mediaType,
      "application/vnd.oci.image.manifest.v1+json",
      "Wrong CLI native manifest type",
    );
    assert(!descriptor.platform.variant, "Unexpected CLI architecture variant");
    const child = await read(native.digest, "manifests");
    assert.equal(child.digest, native.digest, "CLI immutable child differs");
    assert.equal(child.size, descriptor.size, "CLI child size differs");
    assert(
      child.json.schemaVersion === 2 &&
        child.json.mediaType === descriptor.mediaType,
      "Wrong CLI child manifest",
    );
    assert.equal(
      child.json.config?.digest,
      native.configDigest,
      "CLI native config differs",
    );
    const config = await read(native.configDigest, "blobs");
    assert.equal(
      config.digest,
      native.configDigest,
      "CLI immutable config differs",
    );
    assert.equal(
      config.size,
      child.json.config.size,
      "CLI config size differs",
    );
    assert.equal(config.json.os, "linux", "Wrong CLI native OS");
    assert.equal(
      config.json.architecture,
      native.architecture,
      "Wrong CLI native architecture",
    );
    assert.equal(
      config.json.config?.Labels?.["org.opencontainers.image.source"],
      SOURCE,
      "CLI config repository differs",
    );
    assert.equal(
      config.json.config?.Labels?.["org.opencontainers.image.revision"],
      sha,
      "CLI config source differs",
    );
    assert.deepEqual(
      config.json.rootfs?.diff_ids,
      native.rootfsDiffIds,
      "CLI executed rootfs differs",
    );
    assert(
      Array.isArray(child.json.layers) &&
        child.json.layers.length === native.rootfsDiffIds.length &&
        child.json.layers.every(
          (layer) =>
            DIGEST.test(layer.digest) &&
            positive(layer.size) &&
            layer.mediaType === "application/vnd.oci.image.layer.v1.tar+gzip",
        ),
      "Invalid CLI native layers",
    );
    cosign(["verify", "--key", key, `${CLI_IMAGE}@${native.digest}`], run);
  }
  const commandOptions = {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  };
  const version = /^gh version (\d+)\.(\d+)\.(\d+)(?:\s|$)/.exec(
    run("gh", ["--version"], commandOptions),
  );
  assert(
    version &&
      (Number(version[1]) > 2 ||
        (Number(version[1]) === 2 && Number(version[2]) >= 102)),
    "CLI provenance requires patched gh >=2.102.0",
  );
  const identity = `${SOURCE}/${CLI_WORKFLOW}@refs/heads/fork/main`;
  const verified = JSON.parse(
    run(
      "gh",
      [
        "attestation",
        "verify",
        `oci://${reference}`,
        "--repo",
        REPOSITORY,
        "--cert-identity",
        identity,
        "--cert-oidc-issuer",
        "https://token.actions.githubusercontent.com",
        "--source-digest",
        sha,
        "--source-ref",
        "refs/heads/fork/main",
        "--signer-digest",
        sha,
        "--deny-self-hosted-runners",
        "--format",
        "json",
      ],
      commandOptions,
    ),
  );
  // Inspect only gh's successful verification result. Certificate field names come from
  // sigstore-go/docs/verification.md; gh_attestation_verify documents verificationResult.
  // Exact ref/identity checks also avoid the former signer-workflow prefix acceptance.
  assert(
    Array.isArray(verified) &&
      verified.some(({ verificationResult: result }) => {
        const certificate = result?.signature?.certificate;
        return (
          certificate?.subjectAlternativeName?.value === identity &&
          certificate.issuer ===
            "https://token.actions.githubusercontent.com" &&
          certificate.sourceRepositoryURI === SOURCE &&
          certificate.sourceRepositoryDigest === sha &&
          certificate.sourceRepositoryRef === "refs/heads/fork/main" &&
          certificate.buildSignerURI === identity &&
          certificate.buildSignerDigest === sha &&
          certificate.runnerEnvironment === "github-hosted" &&
          certificate.runInvocationURI ===
            `${SOURCE}/actions/runs/${evidence.runId}/attempts/${evidence.attempt}` &&
          result.statement?.predicateType ===
            "https://slsa.dev/provenance/v1" &&
          result.statement.subject?.some(
            (subject) =>
              subject.name === CLI_IMAGE &&
              subject.digest?.sha256 === receipt.digest.slice(7),
          )
        );
      }),
    "CLI provenance differs from workflow/source/run attempt",
  );
  return reference;
}

async function requireCliQualification(
  registry,
  sha,
  {
    request = github,
    run = execFileSync,
    download = downloadCliPublication,
  } = {},
  expected,
) {
  assert(SHA.test(sha), "Invalid CLI qualification source");
  const response = await request(
    `actions/workflows/cli.yml/runs?head_sha=${sha}&per_page=100`,
  );
  const runs = response.workflow_runs;
  assert(
    Array.isArray(runs) &&
      runs.length > 0 &&
      Number.isSafeInteger(response.total_count) &&
      response.total_count === runs.length,
    "Missing or incomplete CLI runs response",
  );
  assert(
    runs.every(
      (record) =>
        positive(record.id) && Number.isFinite(Date.parse(record.updated_at)),
    ),
    "Invalid CLI run identity",
  );
  assert.equal(
    new Set(runs.map(({ id }) => id)).size,
    runs.length,
    "Duplicate CLI run identity",
  );
  const record = [...runs].sort(
    (a, b) =>
      Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id,
  )[0];
  const jobs = await cliJobs(record, sha, request);
  const artifacts = await request(
    `actions/runs/${record.id}/artifacts?per_page=100`,
  );
  assert(
    Array.isArray(artifacts.artifacts) &&
      Number.isSafeInteger(artifacts.total_count) &&
      artifacts.total_count === artifacts.artifacts.length &&
      artifacts.artifacts.length < 100,
    "Incomplete CLI artifacts response",
  );
  const matches = artifacts.artifacts.filter(
    (artifact) => artifact.name === "cli-publication",
  );
  assert.equal(
    matches.length,
    1,
    "Missing or duplicate CLI publication artifact",
  );
  const artifact = matches[0];
  assert(
    positive(artifact.id) &&
      artifact.expired === false &&
      positive(artifact.size_in_bytes) &&
      artifact.size_in_bytes <= 1024 * 1024 &&
      DIGEST.test(artifact.digest),
    "Invalid or expired CLI publication artifact",
  );
  assert(
    record.repository?.full_name === REPOSITORY &&
      positive(record.repository.id) &&
      artifact.workflow_run?.id === record.id &&
      artifact.workflow_run.head_sha === sha &&
      artifact.workflow_run.head_branch === "fork/main" &&
      artifact.workflow_run.repository_id === record.repository.id &&
      artifact.workflow_run.head_repository_id === record.repository.id,
    "CLI artifact belongs to another source/run/repository",
  );
  const evidence = {
    runId: record.id,
    attempt: record.run_attempt,
    jobs,
    artifact: { id: artifact.id, digest: artifact.digest },
    publication: await download(artifact, { run }),
  };
  await verifyCliQualification(registry, sha, evidence, { run });
  const current = await request(`actions/runs/${record.id}`);
  assert(
    trustedRun(current, sha, CLI_WORKFLOW) &&
      current.event === "workflow_dispatch" &&
      current.id === record.id &&
      current.run_attempt === record.run_attempt,
    "CLI run changed during qualification",
  );
  if (expected)
    assert.deepEqual(
      evidence,
      expected,
      "CLI qualification changed before promotion",
    );
  return evidence;
}

module.exports = {
  CLI_IMAGE,
  REQUIRED_CLI_JOBS,
  validateCliQualification,
  verifyCliQualification,
  requireCliQualification,
  downloadCliPublication,
};
