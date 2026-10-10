#!/usr/bin/env node
// Canonical Frameleaf delivery contracts. Importing this module performs no I/O.
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const REPOSITORY = "Frameleaf/frameleaf-app";
const SOURCE = `https://github.com/${REPOSITORY}`;
const MAIN = "fork/main";
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SHA = /^[a-f0-9]{40}$/;
const INDEX_TYPES = new Set([
  "application/vnd.oci.image.index.v1+json",
  "application/vnd.docker.distribution.manifest.list.v2+json",
]);
const IMAGE_TYPES = new Set([
  "application/vnd.oci.image.manifest.v1+json",
  "application/vnd.docker.distribution.manifest.v2+json",
]);
const VARIANTS = Object.freeze(
  [
    {
      image: "frameleaf-server",
      suffix: "",
      device: "cpu",
      platforms: ["linux/amd64", "linux/arm64"],
      target: "prod",
      context: ".",
      dockerfile: "server/Dockerfile",
    },
    {
      image: "frameleaf-machine-learning",
      suffix: "",
      device: "cpu",
      platforms: ["linux/amd64", "linux/arm64"],
      target: "prod",
    },
    {
      image: "frameleaf-machine-learning",
      suffix: "-cuda",
      device: "cuda",
      platforms: ["linux/amd64"],
      target: "prod",
    },
    {
      image: "frameleaf-machine-learning",
      suffix: "-openvino",
      device: "openvino",
      platforms: ["linux/amd64"],
      target: "prod",
    },
    {
      image: "frameleaf-machine-learning",
      suffix: "-armnn",
      device: "armnn",
      platforms: ["linux/arm64"],
      target: "prod",
    },
    {
      image: "frameleaf-machine-learning",
      suffix: "-rknn",
      device: "rknn",
      platforms: ["linux/arm64"],
      target: "prod",
    },
    {
      image: "frameleaf-machine-learning",
      suffix: "-rocm",
      device: "rocm",
      platforms: ["linux/amd64"],
      target: "prod",
    },
  ].map((v) =>
    Object.freeze({
      context: "machine-learning",
      dockerfile: "machine-learning/Dockerfile",
      ...v,
    }),
  ),
);
const INSTALL_FILES = [
  "docker-compose.yml",
  "docker-compose.rootless.yml",
  "example.env",
  "hwaccel.ml.yml",
  "hwaccel.transcoding.yml",
];
// FL-191: Frameleaf images a release depends on besides the versioned server/ML variants. They are
// published separately (Postgres Image and CLI Build dispatches), so promotion proves each exists
// and the bundle pins the database by digest.
const DEPENDENCY_IMAGES = Object.freeze([
  "frameleaf-postgres",
  "frameleaf-cli",
]);
// Referenced by the installation documentation rather than the Compose files.
const REQUIRED_TOOL_IMAGES = Object.freeze([
  "ghcr.io/frameleaf/frameleaf-cli:latest",
]);
// Only the server and ML variants follow the release version; their candidates are verified above.
const RELEASE_MANAGED_IMAGE =
  /^ghcr\.io\/frameleaf\/(?:frameleaf-server|frameleaf-machine-learning):\$\{FRAMELEAF_VERSION:-\$\{IMMICH_VERSION/;
const OWNED_IMAGE =
  /^ghcr\.io\/frameleaf\/([a-z0-9-]+)(?::([A-Za-z0-9_][A-Za-z0-9_.-]{0,127}))?(?:@(sha256:[a-f0-9]{64}))?$/;
const hash = (bytes) =>
  `sha256:${crypto.createHash("sha256").update(bytes).digest("hex")}`;
function installImageReferences(text) {
  return [...text.matchAll(/^\s*image:\s*["']?([^\s"'#]+)/gm)].map(
    (match) => match[1],
  );
}
// Every image an installation pulls must exist before its bundle is promoted. Returns the verified
// digest of each owned dependency reference, keyed by the reference as written.
async function verifyDependencyImages(registry, root) {
  const references = new Set(REQUIRED_TOOL_IMAGES);
  for (const name of INSTALL_FILES.filter((file) => file.endsWith(".yml")))
    for (const reference of installImageReferences(
      await fs.readFile(path.join(root, "docker", name), "utf8"),
    ))
      references.add(reference);
  const resolved = new Map();
  for (const reference of references) {
    assert(
      !/immich-app/.test(reference),
      `${reference}: installations must not pull upstream images`,
    );
    if (RELEASE_MANAGED_IMAGE.test(reference)) continue;
    assert(
      !reference.includes("${"),
      `${reference}: only the Frameleaf server and ML images may follow the release version`,
    );
    const owned = reference.match(OWNED_IMAGE);
    if (!owned) {
      assert.match(
        reference,
        /@sha256:[a-f0-9]{64}$/,
        `${reference}: third-party installation images must be digest-pinned`,
      );
      continue;
    }
    const [, image, tag, pinned] = owned;
    assert(
      DEPENDENCY_IMAGES.includes(image),
      `${reference}: not a known Frameleaf dependency image`,
    );
    assert(tag || pinned, `${reference}: needs a tag or digest`);
    let found;
    try {
      // Anonymous, as an installation pulls it: the job token could also read a private package.
      found = await registry.read(image, tag ?? pinned, "manifests", {
        anonymous: true,
      });
    } catch (error) {
      if ([401, 403].includes(error.status))
        throw new Error(
          `${reference} is not public (anonymous registry status ${error.status}). Make the package public before promoting a release.`,
        );
      if (error.status === 404)
        throw new Error(
          `${reference} is not published (registry status 404). Publish it with its workflow's manual dispatch before promoting a release.`,
        );
      // Integrity failures (digest mismatches) are not transient; report them as they are.
      if (error.code === "ERR_ASSERTION") throw error;
      throw new Error(
        `Transient registry failure reading ${reference} (${error.status ? `status ${error.status}` : error.message}); promotion stopped, retry the release job.`,
      );
    }
    if (pinned)
      assert.equal(
        found.digest,
        pinned,
        `${reference}: tag no longer resolves to the pinned digest`,
      );
    resolved.set(reference, found.digest);
  }
  return resolved;
}
const imageName = (spec) => `ghcr.io/frameleaf/${spec.image}`;
const commitTag = (sha, spec) => `commit-${sha}${spec.suffix}`;
function variant(image, suffix = "") {
  const found = VARIANTS.find((v) => v.image === image && v.suffix === suffix);
  assert(found, "Unsupported Frameleaf image/variant");
  return found;
}
function validateBuildInput(env) {
  const spec = variant(env.IMAGE, env.SUFFIX);
  assert(SHA.test(env.SOURCE_SHA), "Invalid source SHA");
  assert.equal(
    env.SOURCE_SHA,
    env.GITHUB_SHA,
    "Build SHA differs from event SHA",
  );
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY, "Wrong build repository");
  assert.equal(env.GITHUB_REF, `refs/heads/${MAIN}`, "Wrong build branch");
  assert(
    ["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME),
    "Unsupported build event",
  );
  for (const [key, expected] of Object.entries({
    DEVICE: spec.device,
    PLATFORMS: spec.platforms.join(","),
    TARGET: spec.target,
    CONTEXT: spec.context,
    DOCKERFILE: spec.dockerfile,
  })) {
    assert.equal(env[key], expected, `Invalid ${key} for image variant`);
  }
  return spec.platforms.map((platform) => ({
    platform,
    architecture: platform.split("/")[1],
    runner: platform === "linux/amd64" ? "ubuntu-24.04" : "ubuntu-24.04-arm",
  }));
}
function validateIndex(index, spec, sha) {
  assert(SHA.test(sha), "Invalid source SHA");
  assert(
    INDEX_TYPES.has(index.mediaType) && index.schemaVersion === 2,
    "Expected an OCI/Docker image index",
  );
  assert.equal(
    index.annotations?.["org.opencontainers.image.source"],
    SOURCE,
    "Wrong index source repository",
  );
  assert.equal(
    index.annotations?.["org.opencontainers.image.revision"],
    sha,
    "Wrong index source revision",
  );
  assert.equal(
    index.annotations?.["org.frameleaf.build.variant"],
    spec.device + spec.suffix,
    "Wrong index variant",
  );
  assert(
    Array.isArray(index.manifests) &&
      index.manifests.length > 0 &&
      index.manifests.length <= 24,
    "Invalid image index size",
  );
  const platforms = new Map();
  const attestations = [];
  for (const item of index.manifests) {
    assert(
      DIGEST.test(item.digest) &&
        Number.isSafeInteger(item.size) &&
        item.size > 0 &&
        item.size <= 16 * 1024 * 1024,
      "Invalid manifest descriptor",
    );
    assert(IMAGE_TYPES.has(item.mediaType), "Unsupported nested manifest type");
    const platform = `${item.platform?.os}/${item.platform?.architecture}`;
    if (platform === "unknown/unknown") {
      assert.equal(
        item.annotations?.["vnd.docker.reference.type"],
        "attestation-manifest",
        "Unknown platform is not an attestation",
      );
      attestations.push(item);
      continue;
    }
    assert(spec.platforms.includes(platform), "Unexpected platform");
    assert(!platforms.has(platform), "Duplicate platform");
    assert(
      !item.platform.variant ||
        (platform === "linux/arm64" && item.platform.variant === "v8"),
      "Unsupported architecture variant",
    );
    platforms.set(platform, item);
  }
  assert.deepEqual(
    [...platforms.keys()].sort(),
    [...spec.platforms].sort(),
    "Missing required platform",
  );
  const digests = new Set([...platforms.values()].map((p) => p.digest));
  for (const attestation of attestations)
    assert(
      digests.has(attestation.annotations["vnd.docker.reference.digest"]),
      "Orphan attestation",
    );
  return platforms;
}
function validateImageConfig(config, spec, sha) {
  const labels = config.config?.Labels;
  assert.equal(
    labels?.["org.opencontainers.image.source"],
    SOURCE,
    "Wrong image source repository",
  );
  assert.equal(
    labels?.["org.opencontainers.image.revision"],
    sha,
    "Wrong image source revision",
  );
  assert.equal(
    labels?.["org.frameleaf.build.variant"],
    spec.device + spec.suffix,
    "Wrong image variant",
  );
}
function trustedRun(run, sha, workflow = ".github/workflows/docker.yml") {
  return (
    run?.head_sha === sha &&
    run.head_branch === MAIN &&
    run.head_repository?.full_name === REPOSITORY &&
    ["push", "workflow_dispatch"].includes(run.event) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.path === workflow
  );
}
// FL-24: Docker publication does not establish application qualification. The Test workflow must
// complete every non-mobile lane, including each native E2E matrix member, on the same source.
const REQUIRED_TEST_JOBS = Object.freeze([
  "Scripts unit tests",
  "Test & Lint Server",
  "Unit Test CLI",
  "Unit Test CLI (Windows)",
  "Lint Web",
  "Test Web",
  "Test i18n",
  "End-to-End Lint",
  "Medium Tests (Server)",
  "End-to-End Tests (Server & CLI) (ubuntu-24.04)",
  "End-to-End Tests (Server & CLI) (ubuntu-24.04-arm)",
  "End-to-End Tests (Web) (ubuntu-24.04)",
  "End-to-End Tests (Web) (ubuntu-24.04-arm)",
  "End-to-End Tests Success",
  "Unit Test ML",
  ".github Files Formatting",
  "ShellCheck",
  "OpenAPI Clients",
  "SQL Schema Checks",
]);
async function requireTestQualification(sha, request = github, expected) {
  assert(SHA.test(sha), "Test qualification: invalid source SHA");
  const latestRun = async () => {
    // Do not filter to success: a newer failed/running run must never fall back to an older green run.
    const response = await request(
      `actions/workflows/test.yml/runs?head_sha=${sha}&per_page=100`,
    );
    const runs = response.workflow_runs;
    assert(
      Array.isArray(runs) && runs.length > 0,
      "Test qualification: missing run",
    );
    assert(
      Number.isSafeInteger(response.total_count) &&
        response.total_count === runs.length,
      "Test qualification: incomplete runs response",
    );
    assert(
      runs.every(
        (run) =>
          Number.isSafeInteger(run.id) &&
          run.id > 0 &&
          Number.isFinite(Date.parse(run.updated_at)),
      ),
      "Test qualification: invalid run identity",
    );
    // A rerun of an older run ID can be newer evidence than a later-created run.
    const run = [...runs].sort(
      (a, b) =>
        Date.parse(b.updated_at) - Date.parse(a.updated_at) || b.id - a.id,
    )[0];
    assert(
      trustedRun(run, sha, ".github/workflows/test.yml") &&
        Number.isSafeInteger(run.run_attempt) &&
        run.run_attempt > 0,
      "Test qualification: latest same-SHA run is not trusted and successful",
    );
    return run;
  };
  const run = await latestRun();
  const result = await request(
    `actions/runs/${run.id}/attempts/${run.run_attempt}/jobs?per_page=100`,
  );
  // There are 19 required lanes. Fail closed if a response is incomplete instead of certifying a partial page.
  assert(
    Array.isArray(result.jobs) &&
      result.total_count === result.jobs.length &&
      result.jobs.length < 100,
    "Test qualification: incomplete jobs response",
  );
  const jobs = REQUIRED_TEST_JOBS.map((name) => {
    const matches = result.jobs.filter((job) => job.name === name);
    assert.equal(
      matches.length,
      1,
      `Test qualification: missing or duplicate ${name}`,
    );
    const job = matches[0];
    assert(
      Number.isSafeInteger(job.id) &&
        job.id > 0 &&
        job.run_id === run.id &&
        job.head_sha === sha &&
        job.head_branch === MAIN &&
        job.workflow_name === "Test" &&
        job.status === "completed" &&
        job.conclusion === "success" &&
        // GitHub's attempt-specific endpoint is authoritative; reject mismatched attempt metadata if supplied.
        (job.run_attempt === undefined || job.run_attempt === run.run_attempt),
      `Test qualification: ${name} is not successful same-SHA attempt evidence`,
    );
    return { id: job.id, name };
  });
  assert.equal(
    new Set(jobs.map((job) => job.id)).size,
    jobs.length,
    "Test qualification: duplicate job identity",
  );
  // A rerun begun while fetching jobs retires this evidence, even if its previous attempt was green.
  const current = await request(`actions/runs/${run.id}`);
  assert(
    trustedRun(current, sha, ".github/workflows/test.yml") &&
      current.id === run.id &&
      current.run_attempt === run.run_attempt,
    "Test qualification: run changed during validation",
  );
  const latest = await latestRun();
  assert(
    latest.id === run.id && latest.run_attempt === run.run_attempt,
    "Test qualification: latest run changed during validation",
  );
  const evidence = { runId: run.id, attempt: run.run_attempt, jobs };
  if (expected)
    assert.deepEqual(
      evidence,
      expected,
      "Test qualification changed before promotion",
    );
  return evidence;
}
function chooseTag(version, releases, refs, sha) {
  assert(SHA.test(sha), "Invalid source SHA");
  assert(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/.test(version),
    "Unsupported base version",
  );
  const prefix = `frameleaf-v${version}-`;
  const pattern = new RegExp(
    `^${prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\d+)$`,
  );
  const existing = releases.filter(
    (r) => pattern.test(r.tag_name) && r.target_commitish === sha,
  );
  assert(
    existing.length <= 1,
    "Multiple release records for the same source revision",
  );
  if (existing.length) return existing[0].tag_name;
  const numbers = [
    ...releases.map((r) => r.tag_name),
    ...refs.map((r) => r.ref.replace(/^refs\/tags\//, "")),
  ]
    .map((tag) => pattern.exec(tag)?.[1])
    .filter(Boolean)
    .map(Number);
  assert(numbers.every(Number.isSafeInteger), "Invalid release sequence");
  return prefix + (Math.max(0, ...numbers) + 1);
}

async function checkedResponse(response, limit = 16 * 1024 * 1024) {
  if (!response.ok)
    throw Object.assign(
      new Error(`Remote request failed (${response.status})`),
      { status: response.status },
    );
  assert(
    Number(response.headers.get("content-length") || 0) <= limit,
    "Remote payload too large",
  );
  const reader = response.body.getReader();
  const parts = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      throw new Error("Remote payload too large");
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}
class Registry {
  constructor(env = process.env) {
    this.env = env;
    this.tokens = new Map();
  }
  async token(image, anonymous = false) {
    assert(
      VARIANTS.some((v) => v.image === image) ||
        DEPENDENCY_IMAGES.includes(image),
      "Unknown registry image",
    );
    const key = anonymous ? `anonymous:${image}` : image;
    if (!this.tokens.has(key)) {
      const headers = {};
      if (!anonymous) {
        assert(this.env.GITHUB_TOKEN, "GITHUB_TOKEN is required");
        headers.Authorization = `Basic ${Buffer.from(
          `${this.env.GITHUB_ACTOR || "frameleaf"}:${this.env.GITHUB_TOKEN}`,
        ).toString("base64")}`;
      }
      const response = await fetch(
        `https://ghcr.io/token?service=ghcr.io&scope=repository:frameleaf/${image}:pull`,
        { headers, signal: AbortSignal.timeout(60_000) },
      );
      const body = JSON.parse(await checkedResponse(response, 1024 * 1024));
      assert(
        typeof body.token === "string" && body.token.length > 0,
        "Missing registry token",
      );
      this.tokens.set(key, body.token);
    }
    return this.tokens.get(key);
  }
  async read(image, reference, kind = "manifests", { anonymous = false } = {}) {
    assert(
      DIGEST.test(reference) ||
        /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference),
      "Invalid image reference",
    );
    assert(["manifests", "blobs"].includes(kind));
    const response = await fetch(
      `https://ghcr.io/v2/frameleaf/${image}/${kind}/${reference}`,
      {
        headers: {
          Authorization: `Bearer ${await this.token(image, anonymous)}`,
          Accept: [...INDEX_TYPES, ...IMAGE_TYPES].join(","),
        },
        signal: AbortSignal.timeout(60_000),
      },
    );
    const bytes = await checkedResponse(response);
    const digest = hash(bytes);
    if (DIGEST.test(reference))
      assert.equal(digest, reference, "Registry content digest differs");
    const reported = response.headers.get("docker-content-digest");
    if (kind === "manifests")
      assert.equal(reported, digest, "Registry manifest hash differs");
    else if (reported)
      assert.equal(reported, digest, "Registry blob hash differs");
    return { digest, json: JSON.parse(bytes), size: bytes.length };
  }
}
async function verifyImage(
  registry,
  spec,
  sha,
  reference = commitTag(sha, spec),
) {
  const index = await registry.read(spec.image, reference);
  const platforms = validateIndex(index.json, spec, sha);
  for (const [platform, descriptor] of platforms) {
    const manifest = await registry.read(spec.image, descriptor.digest);
    assert.equal(
      manifest.size,
      descriptor.size,
      "Platform manifest size differs",
    );
    assert(
      IMAGE_TYPES.has(manifest.json.mediaType) &&
        manifest.json.schemaVersion === 2,
      "Expected image manifest",
    );
    assert(
      DIGEST.test(manifest.json.config?.digest) &&
        Number.isSafeInteger(manifest.json.config.size) &&
        manifest.json.config.size > 0 &&
        manifest.json.config.size <= 16 * 1024 * 1024,
      "Invalid image configuration",
    );
    const config = await registry.read(
      spec.image,
      manifest.json.config.digest,
      "blobs",
    );
    assert.equal(
      config.size,
      manifest.json.config.size,
      "Image configuration size differs",
    );
    validateImageConfig(config.json, spec, sha);
    assert.equal(
      `${config.json.os}/${config.json.architecture}`,
      platform,
      "Image configuration platform differs",
    );
  }
  return {
    image: imageName(spec),
    suffix: spec.suffix,
    digest: index.digest,
    platforms: [...platforms.keys()].sort(),
    sourceCommit: sha,
    buildSourceCommit: sha,
    buildDigest: index.digest,
  };
}
// Keep the original build identity. Release provenance may advance without rebuilding.
const BUILD_INPUTS = {
  "frameleaf-server": [
    "server",
    "packages",
    "web",
    "i18n",
    "open-api",
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    ".pnpmfile.cjs",
    "mise.toml",
    "mise.lock",
    "LICENSE",
    ".dockerignore",
  ],
  "frameleaf-machine-learning": ["machine-learning"],
};
function identicalBuildInputs(
  spec,
  built,
  qualified,
  git = (...args) => execFileSync("git", args),
) {
  assert(SHA.test(built) && SHA.test(qualified), "Invalid reuse source SHA");
  git("merge-base", "--is-ancestor", built, qualified);
  const inputs = [
    ...BUILD_INPUTS[spec.image],
    ".gitattributes",
    ".github/frameleaf-release.cjs",
    ".github/workflows/docker.yml",
    ".github/workflows/local-multi-runner-build.yml",
  ];
  assert.equal(
    git("diff", "--name-only", built, qualified, "--", ...inputs)
      .toString()
      .trim(),
    "",
    "Image build inputs changed",
  );
}
async function releaseEvidence(tag = "latest") {
  const record = await github(
    tag === "latest"
      ? "releases/latest"
      : `releases/tags/${encodeURIComponent(tag)}`,
  );
  assert(
    !record.draft && !record.prerelease,
    "Reuse requires a published stable release",
  );
  assert(
    /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/.test(record.tag_name),
    "Invalid reuse release tag",
  );
  const asset = record.assets?.find((a) => a.name === "release-manifest.json");
  assert(Number.isSafeInteger(asset?.id), "Missing release manifest");
  const manifest = await github(`releases/assets/${asset.id}`, {
    headers: { Accept: "application/octet-stream" },
  });
  assert.equal(
    manifest.schemaVersion,
    3,
    "Unsupported release manifest version",
  );
  assert.equal(manifest.repository, REPOSITORY, "Foreign reuse repository");
  assert.equal(manifest.tag, record.tag_name, "Reuse release tag differs");
  assert.equal(
    manifest.sourceCommit,
    record.target_commitish,
    "Reuse release source differs",
  );
  const run = new RegExp(`^${SOURCE}/actions/runs/([0-9]+)$`).exec(
    manifest.buildRun,
  );
  assert(
    run &&
      trustedRun(await github(`actions/runs/${run[1]}`), manifest.sourceCommit),
    "Reuse release run is not trusted",
  );
  return manifest;
}
async function verifyReuse(
  registry,
  spec,
  sha,
  manifest,
  checkInputs = identicalBuildInputs,
) {
  assert.equal(
    manifest.schemaVersion,
    3,
    "Unsupported release manifest version",
  );
  assert.equal(manifest.repository, REPOSITORY, "Foreign reuse repository");
  assert(SHA.test(manifest.sourceCommit), "Invalid qualified source");
  checkInputs(spec, manifest.sourceCommit, sha);
  const records = manifest.images?.filter(
    (r) => r.image === imageName(spec) && r.suffix === spec.suffix,
  );
  assert.equal(records?.length, 1, "Missing or duplicate reuse variant");
  const prior = records[0];
  assert.equal(
    prior.sourceCommit,
    manifest.sourceCommit,
    "Reuse image source differs",
  );
  const built = prior.buildSourceCommit || prior.sourceCommit;
  const digest = prior.buildDigest || prior.digest;
  assert(DIGEST.test(digest), "Invalid reusable digest");
  checkInputs(spec, built, sha);
  const image = await verifyImage(registry, spec, built, digest);
  assert.equal(image.digest, digest, "Reuse digest differs");
  return {
    ...image,
    sourceCommit: sha,
    buildSourceCommit: built,
    buildDigest: digest,
    reusedFromRelease: manifest.tag,
  };
}
async function candidateImage(
  registry,
  spec,
  sha,
  evidence = releaseEvidence,
  checkInputs = identicalBuildInputs,
) {
  const index = await registry.read(spec.image, commitTag(sha, spec));
  const tag = index.json.annotations?.["org.frameleaf.reuse.release"];
  if (!tag) return verifyImage(registry, spec, sha, index.digest);
  const image = await verifyReuse(
    registry,
    spec,
    sha,
    await evidence(tag),
    checkInputs,
  );
  assert.equal(
    index.json.annotations["org.frameleaf.reuse.revision"],
    sha,
    "Wrong reuse revision",
  );
  assert.equal(
    index.json.annotations["org.frameleaf.build.digest"],
    image.buildDigest,
    "Wrong original build digest",
  );
  const original = await registry.read(spec.image, image.buildDigest);
  assert.deepEqual(
    index.json.manifests,
    original.json.manifests,
    "Reused manifest content differs",
  );
  const verified = await verifyImage(
    registry,
    spec,
    image.buildSourceCommit,
    index.digest,
  );
  return { ...image, digest: verified.digest };
}
async function planReuse(env = process.env, registry = new Registry(env)) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REF, `refs/heads/${MAIN}`);
  assert(SHA.test(env.GITHUB_SHA));
  if (env.GITHUB_EVENT_NAME === "workflow_dispatch") {
    // Commit tags are immutable. A manual refresh needs an unpublished source
    // revision; reject before spending runners on digests we cannot publish.
    for (const spec of VARIANTS) {
      try {
        await registry.read(spec.image, commitTag(env.GITHUB_SHA, spec));
      } catch (error) {
        if (error.status === 404) continue;
        throw error;
      }
      throw new Error(
        "Manual rebuild requires a new source revision: a candidate already exists for this SHA. Retry failed jobs from the original run to recover publication.",
      );
    }
  }
  let manifest;
  if (env.GITHUB_EVENT_NAME === "push") {
    try {
      manifest = await releaseEvidence();
    } catch (error) {
      console.log(`Build required: ${error.message}`);
    }
  }
  for (const image of Object.keys(BUILD_INPUTS)) {
    let reuse = false;
    if (manifest) {
      try {
        for (const spec of VARIANTS.filter((v) => v.image === image))
          await verifyReuse(registry, spec, env.GITHUB_SHA, manifest);
        reuse = true;
      } catch (error) {
        console.log(`${image}: build required: ${error.message}`);
      }
    }
    const key = image.replace("frameleaf-", "");
    await fs.appendFile(
      env.GITHUB_OUTPUT,
      `${key}=${!reuse}\n${key}-release=${reuse ? manifest.tag : ""}\n`,
    );
  }
}
// `imagetools create` writes a new index and does not carry the source index's own annotations, so
// the reused tag restates the ones validateIndex requires (as mergeCandidate does) besides the
// reuse record; the revision stays the commit the image was built from.
function reuseAnnotations(spec, image, env) {
  return [
    "--annotation",
    `index:org.opencontainers.image.source=${SOURCE}`,
    "--annotation",
    `index:org.opencontainers.image.revision=${image.buildSourceCommit}`,
    "--annotation",
    `index:org.frameleaf.build.variant=${spec.device}${spec.suffix}`,
    "--annotation",
    `index:org.frameleaf.reuse.revision=${env.GITHUB_SHA}`,
    "--annotation",
    `index:org.frameleaf.reuse.release=${env.REUSE_RELEASE}`,
    "--annotation",
    `index:org.frameleaf.build.digest=${image.buildDigest}`,
  ];
}
async function reuseCandidate(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REF, `refs/heads/${MAIN}`);
  assert.equal(env.GITHUB_EVENT_NAME, "push");
  const spec = variant(env.IMAGE, env.SUFFIX);
  assert(/^frameleaf-v/.test(env.REUSE_RELEASE || ""), "Missing reuse release");
  const registry = new Registry(env);
  const image = await verifyReuse(
    registry,
    spec,
    env.GITHUB_SHA,
    await releaseEvidence(env.REUSE_RELEASE),
  );
  const ref = commitTag(env.GITHUB_SHA, spec);
  let exists = true;
  try {
    await registry.read(spec.image, ref);
  } catch (error) {
    if (error.status !== 404) throw error;
    exists = false;
  }
  if (!exists)
    docker(
      "create",
      ...reuseAnnotations(spec, image, env),
      "--tag",
      `${image.image}:${ref}`,
      `${image.image}@${image.buildDigest}`,
    );
  const verified = await candidateImage(registry, spec, env.GITHUB_SHA);
  if (await currentMainline(env.GITHUB_SHA))
    await tagImage(registry, spec, verified, "edge");
  console.log(JSON.stringify(verified));
}
async function github(endpoint, options = {}) {
  const response = await fetch(
    `https://api.github.com/repos/${REPOSITORY}/${endpoint}`,
    {
      ...options,
      headers: {
        Accept: "application/vnd.github+json",
        ...(process.env.GITHUB_TOKEN && {
          Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
        }),
        "X-GitHub-Api-Version": "2022-11-28",
        ...options.headers,
      },
      signal: AbortSignal.timeout(60_000),
    },
  );
  return JSON.parse(await checkedResponse(response));
}
async function currentMainline(sha) {
  const branch = await github(`git/ref/heads/${MAIN}`);
  return branch.object?.sha === sha;
}
async function listAll(endpoint) {
  const rows = [];
  for (let page = 1; page <= 1000; page++) {
    const batch = await github(
      `${endpoint}${endpoint.includes("?") ? "&" : "?"}per_page=100&page=${page}`,
    );
    assert(Array.isArray(batch), "Invalid GitHub pagination response");
    rows.push(...batch);
    if (batch.length < 100) return rows;
  }
  throw new Error("GitHub pagination limit reached");
}
function docker(...args) {
  execFileSync("docker", ["buildx", "imagetools", ...args], {
    stdio: "inherit",
  });
}
async function tagImage(registry, spec, record, tag) {
  docker(
    "create",
    "--tag",
    `${record.image}:${tag}${spec.suffix}`,
    `${record.image}@${record.digest}`,
  );
  const actual = await registry.read(spec.image, `${tag}${spec.suffix}`);
  assert.equal(actual.digest, record.digest, "Promoted tag digest differs");
}
async function mergeCandidate(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert.equal(env.GITHUB_REF, `refs/heads/${MAIN}`);
  assert.equal(env.SOURCE_SHA, env.GITHUB_SHA);
  assert(SHA.test(env.SOURCE_SHA));
  assert(["push", "workflow_dispatch"].includes(env.GITHUB_EVENT_NAME));
  const spec = variant(env.IMAGE, env.SUFFIX);
  const registry = new Registry(env);
  const files = await fs.readdir(env.DIGEST_DIR);
  assert.equal(
    files.length,
    spec.platforms.length,
    "Unexpected digest artifact count",
  );
  const sources = [];
  const platforms = new Set();
  for (const file of files) {
    assert(/^[a-z0-9-]+\.json$/.test(file), "Invalid digest artifact filename");
    const entry = JSON.parse(
      await fs.readFile(path.join(env.DIGEST_DIR, file), "utf8"),
    );
    assert(
      spec.platforms.includes(entry.platform) && !platforms.has(entry.platform),
      "Duplicate/unexpected build platform",
    );
    assert(DIGEST.test(entry.digest), "Invalid build digest");
    platforms.add(entry.platform);
    sources.push(`${imageName(spec)}@${entry.digest}`);
  }
  const ref = commitTag(env.SOURCE_SHA, spec);
  let exists = true;
  try {
    await registry.read(spec.image, ref);
  } catch (error) {
    if (error.status !== 404) throw error;
    exists = false;
  }
  if (!exists) {
    docker(
      "create",
      "--annotation",
      `index:org.opencontainers.image.source=${SOURCE}`,
      "--annotation",
      `index:org.opencontainers.image.revision=${env.SOURCE_SHA}`,
      "--annotation",
      `index:org.frameleaf.build.variant=${spec.device}${spec.suffix}`,
      "--tag",
      `${imageName(spec)}:${ref}`,
      ...sources,
    );
  }
  // An existing index with missing/corrupt child content fails verification; a
  // child 404 must never be mistaken for permission to overwrite its commit tag.
  const result = await verifyImage(registry, spec, env.SOURCE_SHA, ref);
  // A retry never overwrites a previously verified same-SHA commit tag.
  // Only the current mainline tip may advance the edge channel.
  if (await currentMainline(env.SOURCE_SHA))
    await tagImage(registry, spec, result, "edge");
  console.log(
    JSON.stringify({
      ...result,
      provenance:
        "BuildKit metadata and SBOM; no signed attestation is claimed",
    }),
  );
}
// FL-142: the images the deployment test runs on this runner. A built image is the OCI archive its
// build job left (never pushed); an unchanged image is the digest a published release qualified, verified
// exactly as reuse-candidate verifies it. Writes SERVER_*/ML_* for frameleaf-deploy-test.cjs to GITHUB_ENV.
async function deployTestImages(
  env = process.env,
  registry = new Registry(env),
) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert(SHA.test(env.GITHUB_SHA), "Invalid source SHA");
  const lines = [];
  for (const [key, image, built, release, directory] of [
    [
      "SERVER",
      "frameleaf-server",
      env.SERVER_BUILT,
      env.SERVER_RELEASE,
      "server",
    ],
    ["ML", "frameleaf-machine-learning", env.ML_BUILT, env.ML_RELEASE, "ml"],
  ]) {
    if (built === "true") {
      const archive = path.join(env.RUNNER_TEMP, directory, "image.tar");
      await fs.access(archive);
      lines.push(`${key}_ARCHIVE=${archive}`);
      continue;
    }
    if (built === "released") {
      // The integration image pairs its server with the machine-learning image of the latest
      // published release, as recorded in that release's verified manifest (never a rolling tag).
      const manifest = await releaseEvidence();
      const spec = variant(image, "");
      const records = manifest.images.filter(
        (r) => r.image === imageName(spec) && r.suffix === spec.suffix,
      );
      assert.equal(records.length, 1, "Missing or duplicate released image");
      const verified = await verifyImage(
        registry,
        spec,
        records[0].buildSourceCommit || records[0].sourceCommit,
        records[0].digest,
      );
      lines.push(`${key}_IMAGE=${verified.image}@${verified.digest}`);
      if (key === "SERVER")
        lines.push(
          `SERVER_SOURCE_SHA=${records[0].buildSourceCommit || records[0].sourceCommit}`,
        );
      continue;
    }
    assert.equal(built, "false", `Unknown ${key} build plan`);
    assert(/^frameleaf-v/.test(release || ""), `Missing ${key} reuse release`);
    const reused = await verifyReuse(
      registry,
      variant(image, ""),
      env.GITHUB_SHA,
      await releaseEvidence(release),
    );
    lines.push(`${key}_IMAGE=${reused.image}@${reused.buildDigest}`);
    if (key === "SERVER")
      lines.push(`SERVER_SOURCE_SHA=${reused.buildSourceCommit}`);
  }
  await fs.appendFile(env.GITHUB_ENV, lines.join("\n") + "\n");
  console.log(lines.filter((line) => !line.includes("ARCHIVE")).join("\n"));
}

// FL-146 "Deploy production": the verified candidate a dispatch names, by its exact fork/main commit or
// by the digest of its frameleaf-server candidate. Only the current fork/main head with a successful
// same-SHA Deploy run qualifies (the release rules below); rolling tags are never evidence.
async function resolveCandidate(
  env = process.env,
  registry = new Registry(env),
) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  const input = (env.CANDIDATE || "").trim();
  let sha = input;
  const server = variant("frameleaf-server", "");
  if (DIGEST.test(input)) {
    const index = await registry.read(server.image, input);
    sha =
      index.json.annotations?.["org.frameleaf.reuse.revision"] ||
      index.json.annotations?.["org.opencontainers.image.revision"];
    assert(SHA.test(sha || ""), "The digest names no source revision");
    const tagged = await registry.read(server.image, commitTag(sha, server));
    assert.equal(
      tagged.digest,
      input,
      "The digest is not the verified server candidate of its commit",
    );
  }
  assert(
    SHA.test(sha),
    "Give the exact 40-character commit SHA or a sha256 digest",
  );
  assert(await currentMainline(sha), `${sha} is not the current ${MAIN} head`);
  const { workflow_runs: runs } = await github(
    `actions/workflows/docker.yml/runs?head_sha=${sha}&status=success&per_page=100`,
  );
  const run = (Array.isArray(runs) ? runs : []).find((r) => trustedRun(r, sha));
  assert(run, "No successful same-SHA build run exists for this commit");
  const testQualification = await requireTestQualification(sha);
  const images = [];
  for (const spec of VARIANTS)
    images.push(await candidateImage(registry, spec, sha));
  const [serverImage, mlImage] = images;
  const outputs = {
    sha,
    run: String(run.id),
    "test-run": String(testQualification.runId),
    "test-attempt": String(testQualification.attempt),
    "server-image": `${serverImage.image}@${serverImage.digest}`,
    "server-source": serverImage.buildSourceCommit,
    "ml-image": `${mlImage.image}@${mlImage.digest}`,
  };
  if (env.GITHUB_OUTPUT)
    await fs.appendFile(
      env.GITHUB_OUTPUT,
      Object.entries(outputs)
        .map(([key, value]) => `${key}=${value}`)
        .join("\n") + "\n",
    );
  console.log(JSON.stringify({ ...outputs, images }, null, 2));
  return outputs;
}

// FL-145: every promoted image digest is signed with the Frameleaf cosign key (the production
// environment's COSIGN_PRIVATE_KEY/COSIGN_PASSWORD; cosign reads them from the environment and they are
// never passed on a command line or printed), the release manifest is attached as an attestation, and
// both are verified against the committed public key before anything is promoted.
const COSIGN_PUBLIC_KEY = "cosign.pub";
const ATTESTATION_TYPE =
  "https://frameleaf.app/attestations/release-manifest/v3";
function cosign(args, run = execFileSync) {
  return run("cosign", args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
}
function signImages(images, manifestFile, run = execFileSync) {
  const signed = [];
  for (const image of images) {
    assert(DIGEST.test(image.digest), "Invalid image digest to sign");
    const reference = `${image.image}@${image.digest}`;
    cosign(
      [
        "sign",
        "--yes",
        "--recursive",
        "--key",
        "env://COSIGN_PRIVATE_KEY",
        reference,
      ],
      run,
    );
    cosign(
      [
        "attest",
        "--yes",
        "--key",
        "env://COSIGN_PRIVATE_KEY",
        "--type",
        ATTESTATION_TYPE,
        "--predicate",
        manifestFile,
        reference,
      ],
      run,
    );
    cosign(["verify", "--key", COSIGN_PUBLIC_KEY, reference], run);
    cosign(
      [
        "verify-attestation",
        "--key",
        COSIGN_PUBLIC_KEY,
        "--type",
        ATTESTATION_TYPE,
        reference,
      ],
      run,
    );
    signed.push(reference);
  }
  return signed;
}

// FL-142 staged rollout and kill switch: lines in the GitHub release body that servers read
// (server/src/utils/frameleaf-release.ts parseReleaseBodyFlags) and the release feed passes on.
function releaseFlagsBody(body, { rolloutPercent, withdrawnReason } = {}) {
  let text = (body || "")
    .split("\n")
    .filter(
      (line) =>
        !/^[ \t]*rollout:/i.test(line) &&
        !(withdrawnReason !== undefined && /^[ \t]*withdrawn:/i.test(line)),
    )
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
  const flags = [];
  if (withdrawnReason !== undefined) {
    const reason = String(withdrawnReason).replace(/\s+/g, " ").trim();
    assert(
      reason.length > 0 && reason.length <= 300,
      "A withdrawal needs a reason of at most 300 characters",
    );
    flags.push(`withdrawn: ${reason}`);
  }
  if (rolloutPercent !== undefined && rolloutPercent !== null) {
    assert(
      Number.isInteger(rolloutPercent) &&
        rolloutPercent >= 0 &&
        rolloutPercent <= 100,
      "Rollout must be a whole percentage from 0 to 100",
    );
    if (rolloutPercent < 100) flags.push(`rollout: ${rolloutPercent}%`);
  }
  return flags.length
    ? `${flags.join("\n")}\n\n${text}`.trim() + "\n"
    : text + "\n";
}
function parsePercent(value) {
  if (value === undefined || value === "") return undefined;
  assert(
    /^\d{1,3}$/.test(String(value).trim()),
    "Rollout must be a whole percentage from 0 to 100",
  );
  return Number(value);
}

// Deploy production's rollout and withdraw actions. Withdraw marks the release withdrawn and a
// prerelease (servers stop offering it), and restores an earlier published release: its verified image
// digests are re-verified from its manifest, signed if they predate signing, and become `release` and
// `latest` again; the GitHub release is marked latest. Nothing is rebuilt or deleted.
async function releaseFlags(
  env = process.env,
  registry = new Registry(env),
  run = execFileSync,
) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  const tag = env.RELEASE_TAG;
  assert(
    /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/.test(tag || ""),
    "Invalid release tag",
  );
  const record = await github(`releases/tags/${encodeURIComponent(tag)}`);
  assert(!record.draft, "The release is still a draft");
  const dryRun = env.DRY_RUN === "true";
  if (env.ACTION === "rollout") {
    const body = releaseFlagsBody(record.body, {
      rolloutPercent: parsePercent(env.ROLLOUT_PERCENT),
    });
    console.log(
      `${dryRun ? "Would set" : "Setting"} ${tag} rollout to ${env.ROLLOUT_PERCENT}%`,
    );
    if (!dryRun)
      await github(`releases/${record.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ body }),
      });
    return;
  }
  assert.equal(env.ACTION, "withdraw", "Expected rollout or withdraw");
  const restoreTag = env.RESTORE_TAG;
  assert.notEqual(
    restoreTag,
    tag,
    "Restore another release than the one withdrawn",
  );
  const evidence = await releaseEvidence(restoreTag);
  const restore = [];
  for (const spec of VARIANTS) {
    const records = evidence.images.filter(
      (r) => r.image === imageName(spec) && r.suffix === spec.suffix,
    );
    assert.equal(
      records.length,
      1,
      `${restoreTag}: missing or duplicate ${spec.image}${spec.suffix}`,
    );
    assert.equal(
      records[0].sourceCommit,
      evidence.sourceCommit,
      "Restored image source differs",
    );
    const digest = records[0].digest;
    const verified = await verifyImage(
      registry,
      spec,
      records[0].buildSourceCommit || records[0].sourceCommit,
      digest,
    );
    assert.equal(verified.digest, digest, "Restored digest differs");
    restore.push({ spec, record: verified });
  }
  const body = releaseFlagsBody(record.body, { withdrawnReason: env.REASON });
  console.log(
    `${dryRun ? "Would withdraw" : "Withdrawing"} ${tag} and restore ${restoreTag} (${restore.length} verified images)`,
  );
  if (dryRun) return;
  await github(`releases/${record.id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body, prerelease: true, make_latest: "false" }),
  });
  for (const { spec, record: image } of restore) {
    const reference = `${image.image}@${image.digest}`;
    try {
      cosign(["verify", "--key", COSIGN_PUBLIC_KEY, reference], run);
    } catch {
      cosign(
        [
          "sign",
          "--yes",
          "--recursive",
          "--key",
          "env://COSIGN_PRIVATE_KEY",
          reference,
        ],
        run,
      );
    }
    await tagImage(registry, spec, image, "release");
    await tagImage(registry, spec, image, "latest");
  }
  run("gh", ["release", "edit", restoreTag, "--repo", REPOSITORY, "--latest"], {
    stdio: "inherit",
  });
  console.log(`Withdrew ${tag}; ${restoreTag} is release and latest again.`);
}

async function createBundle(
  directory,
  root,
  tag,
  manifest,
  dependencies = new Map(),
) {
  assert(
    /^frameleaf-v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-\d+$/.test(tag),
    "Invalid release tag",
  );
  await fs.mkdir(directory, { recursive: true });
  const files = [];
  for (const name of INSTALL_FILES) {
    let body = await fs.readFile(path.join(root, "docker", name), "utf8");
    if (name === "example.env") {
      assert(/^FRAMELEAF_VERSION=.+$/m.test(body), "Missing version setting");
      body = body.replace(
        /^FRAMELEAF_VERSION=.+$/m,
        `FRAMELEAF_VERSION=${tag}`,
      );
    } else if (name.startsWith("docker-compose")) {
      assert(
        body.includes("${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}"),
        "Missing Compose release fallback",
      );
      body = body.replaceAll(
        "${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}",
        "${FRAMELEAF_VERSION:-${IMMICH_VERSION:-" + tag + "}}",
      );
    }
    if (name.endsWith(".yml")) {
      // Pin each verified Frameleaf dependency (the database) to the digest promotion checked.
      body = body.replace(
        /^(\s*image:\s*)(\S+)$/gm,
        (line, prefix, reference) => {
          const verified = dependencies.get(reference);
          return verified && !reference.includes("@")
            ? `${prefix}${reference}@${verified}`
            : line;
        },
      );
      for (const reference of installImageReferences(body)) {
        const owned = reference.match(OWNED_IMAGE);
        if (owned && !RELEASE_MANAGED_IMAGE.test(reference))
          assert(
            owned[3],
            `${name}: ${reference} was not verified and pinned by digest`,
          );
      }
    }
    await fs.writeFile(path.join(directory, name), body);
    files.push(name);
  }
  const compose = await fs.readFile(
    path.join(directory, "docker-compose.yml"),
    "utf8",
  );
  const dependency = (service) => {
    const section = compose.match(
      new RegExp(
        `^  ${service}:\\n([\\s\\S]*?)(?=^  [a-z-]+:|^volumes:|(?![\\s\\S]))`,
        "m",
      ),
    )?.[1];
    const image = section?.match(/^    image: (\S+)$/m)?.[1];
    assert(
      image && /@sha256:[a-f0-9]{64}$/.test(image),
      `Unpinned ${service} image`,
    );
    return image;
  };
  const server = manifest.images.find(
    (image) =>
      image.image === "ghcr.io/frameleaf/frameleaf-server" &&
      image.suffix === "",
  );
  const ml = manifest.images.find(
    (image) =>
      image.image === "ghcr.io/frameleaf/frameleaf-machine-learning" &&
      image.suffix === "",
  );
  assert(
    server && ml && DIGEST.test(server.digest) && DIGEST.test(ml.digest),
    "Missing NAS images",
  );
  const nas = {
    schemaVersion: 3,
    tag,
    sourceCommit: manifest.sourceCommit,
    buildRun: manifest.buildRun,
    images: {
      server: `${server.image}@${server.digest}`,
      machineLearning: `${ml.image}@${ml.digest}`,
      machineLearningVariants: Object.fromEntries(
        manifest.images
          .filter((image) => image.image === ml.image && image.suffix)
          .map((image) => [
            image.suffix.slice(1),
            `${image.image}@${image.digest}`,
          ]),
      ),
      postgres: dependency("database"),
    },
    platforms: server.platforms.filter((platform) =>
      ml.platforms.includes(platform),
    ),
    minimumVersions: {
      synologyDsm: "7.2.1",
      truenas: "24.10.2.2",
      unraid: "7.0",
    },
  };
  await fs.writeFile(
    path.join(directory, "nas-manifest.json"),
    JSON.stringify(nas, null, 2) + "\n",
  );
  files.push("nas-manifest.json");
  // The image attestation authenticates these hashes, including NAS image references.
  manifest.assets = Object.fromEntries(
    await Promise.all(
      files.map(async (name) => [
        name,
        hash(await fs.readFile(path.join(directory, name))),
      ]),
    ),
  );
  await fs.writeFile(
    path.join(directory, "release-manifest.json"),
    JSON.stringify(manifest, null, 2) + "\n",
  );
  files.push("release-manifest.json");
  const sums = [];
  for (const name of files)
    sums.push(
      `${hash(await fs.readFile(path.join(directory, name))).slice(7)}  ${name}`,
    );
  await fs.writeFile(
    path.join(directory, "SHA256SUMS"),
    sums.join("\n") + "\n",
  );
  files.push("SHA256SUMS");
  return files.map((name) => path.join(directory, name));
}
async function reserveAndStage({
  existing,
  sha,
  tag,
  images,
  reserve,
  readVersion,
  writeVersion,
  specs = VARIANTS,
}) {
  assert.equal(images.length, specs.length, "Incomplete release image set");
  // Reserve the sequence in GitHub first. A crash after one registry write must
  // not strand that sequence where a newer source would choose it again.
  const record = existing || (await reserve());
  assert.equal(
    record.target_commitish,
    sha,
    "Existing release has another target",
  );
  assert.equal(record.tag_name, tag, "Reserved release has another tag");
  for (let i = 0; i < specs.length; i++) {
    try {
      const prior = await readVersion(specs[i], tag + specs[i].suffix);
      assert.equal(
        prior.digest,
        images[i].digest,
        "Version tag already references different content",
      );
    } catch (error) {
      if (error.status !== 404) throw error;
      // A published release cannot silently grow/repair missing image aliases.
      assert(record.draft, "Published release is missing a versioned image");
      await writeVersion(specs[i], images[i], tag);
    }
  }
  return record;
}
async function release(env = process.env) {
  assert.equal(env.GITHUB_REPOSITORY, REPOSITORY);
  assert(SHA.test(env.SOURCE_SHA));
  assert(/^\d+$/.test(env.BUILD_RUN_ID), "Missing build run");
  assert(
    trustedRun(
      await github(`actions/runs/${env.BUILD_RUN_ID}`),
      env.SOURCE_SHA,
    ),
    "Build run is not trusted",
  );
  assert(await currentMainline(env.SOURCE_SHA), "Stale release candidate");
  const testQualification = await requireTestQualification(env.SOURCE_SHA);
  const registry = new Registry(env);
  const images = [];
  // Verify every source before creating any release or floating image alias.
  for (const spec of VARIANTS)
    images.push(await candidateImage(registry, spec, env.SOURCE_SHA));
  // The database and CLI images are published separately; a bundle that names a missing image is
  // never reserved, tagged or promoted.
  const dependencies = await verifyDependencyImages(registry, process.cwd());
  const version = JSON.parse(await fs.readFile("server/package.json")).version;
  const releases = await listAll("releases");
  const refs = await github("git/matching-refs/tags/frameleaf-v");
  assert(Array.isArray(refs), "Invalid tag reference response");
  const tag = chooseTag(version, releases, refs, env.SOURCE_SHA);
  let existing = releases.find((r) => r.tag_name === tag);
  const matchingRef = refs.find((r) => r.ref === `refs/tags/${tag}`);
  if (matchingRef)
    assert.equal(
      matchingRef.object?.sha,
      env.SOURCE_SHA,
      "Release tag targets another commit",
    );
  const manifest = {
    schemaVersion: 3,
    repository: REPOSITORY,
    sourceCommit: env.SOURCE_SHA,
    tag,
    buildRun: `${SOURCE}/actions/runs/${env.BUILD_RUN_ID}`,
    testRun: `${SOURCE}/actions/runs/${testQualification.runId}/attempts/${testQualification.attempt}`,
    testValidation: testQualification,
    images,
    dependencies: [...dependencies].map(([reference, digest]) => ({
      reference,
      digest,
    })),
    provenance:
      env.SIGN === "1"
        ? `Image/index revision labels and SHA-256 content verified; every image digest is signed with the Frameleaf cosign key (${COSIGN_PUBLIC_KEY}) and carries this manifest as a ${ATTESTATION_TYPE} attestation.`
        : "Image/index revision labels and SHA-256 content verified; BuildKit metadata/SBOM are not a signed provenance claim.",
  };
  if (env.DEPLOY_RUN_ID) {
    assert(/^\d+$/.test(env.DEPLOY_RUN_ID), "Invalid deployment run");
    manifest.deploymentRun = `${SOURCE}/actions/runs/${env.DEPLOY_RUN_ID}`;
  }
  const rolloutPercent = parsePercent(env.ROLLOUT_PERCENT);
  assert(
    await currentMainline(env.SOURCE_SHA),
    "Mainline changed during candidate verification",
  );
  existing = await reserveAndStage({
    existing,
    sha: env.SOURCE_SHA,
    tag,
    images,
    reserve: async () => {
      const body = {
        tag_name: tag,
        target_commitish: env.SOURCE_SHA,
        name: tag,
        draft: true,
        generate_release_notes: true,
        body: releaseFlagsBody(
          `Source: ${env.SOURCE_SHA}\n\nBuild evidence: ${manifest.buildRun}\n\nUse the attached version-matched installation files and release-manifest.json. Verify an image with: cosign verify --key ${COSIGN_PUBLIC_KEY} <image>@<digest>`,
          { rolloutPercent },
        ),
      };
      return github("releases", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
    },
    readVersion: (spec, reference) => registry.read(spec.image, reference),
    writeVersion: (spec, image, versionTag) =>
      tagImage(registry, spec, image, versionTag),
  });
  if (!existing.draft) {
    console.log(
      `Release ${tag} already exists for this verified source; existing installation assets are retained.`,
    );
    return;
  }
  const directory = path.join(
    env.RUNNER_TEMP || ".cache",
    "frameleaf-release",
    tag,
  );
  const assets = await createBundle(
    directory,
    process.cwd(),
    tag,
    manifest,
    dependencies,
  );
  if (env.SIGN === "1") {
    const signed = signImages(
      images,
      path.join(directory, "release-manifest.json"),
    );
    console.log(`Signed and verified ${signed.length} image digests.`);
  }
  await requireTestQualification(env.SOURCE_SHA, github, testQualification);
  assert(
    await currentMainline(env.SOURCE_SHA),
    "Mainline changed before promotion; draft/version tags retained for inspection",
  );
  // Registry aliases cannot be atomic across eight repositories/variants.
  // Install assets pin a version tag that this workflow refuses to overwrite; a retry resumes any partial alias update.
  execFileSync(
    "gh",
    ["release", "upload", tag, ...assets, "--repo", REPOSITORY, "--clobber"],
    { stdio: "inherit" },
  );
  for (let i = 0; i < VARIANTS.length; i++) {
    await tagImage(registry, VARIANTS[i], images[i], "release");
    await tagImage(registry, VARIANTS[i], images[i], "latest");
  }
  execFileSync(
    "gh",
    ["release", "edit", tag, "--repo", REPOSITORY, "--draft=false", "--latest"],
    { stdio: "inherit" },
  );
  console.log(
    `Published ${tag} with ${images.length} verified image variants and ${assets.length} installation assets.`,
  );
}
module.exports = {
  reuseAnnotations,
  REPOSITORY,
  SOURCE,
  VARIANTS,
  INSTALL_FILES,
  variant,
  validateBuildInput,
  validateIndex,
  validateImageConfig,
  trustedRun,
  requireTestQualification,
  chooseTag,
  verifyImage,
  createBundle,
  DEPENDENCY_IMAGES,
  verifyDependencyImages,
  hash,
  checkedResponse,
  Registry,
  reserveAndStage,
  identicalBuildInputs,
  verifyReuse,
  candidateImage,
  planReuse,
  deployTestImages,
  resolveCandidate,
  releaseFlagsBody,
  releaseFlags,
  signImages,
  cosign,
  github,
  COSIGN_PUBLIC_KEY,
  parsePercent,
  ATTESTATION_TYPE,
};
if (require.main === module) {
  (async () => {
    if (process.argv[2] === "build-matrix") {
      const matrix = validateBuildInput(process.env);
      await fs.appendFile(
        process.env.GITHUB_OUTPUT,
        `matrix=${JSON.stringify(matrix)}\n`,
      );
    } else if (process.argv[2] === "merge-candidate") await mergeCandidate();
    else if (process.argv[2] === "release") await release();
    else if (process.argv[2] === "plan-reuse") await planReuse();
    else if (process.argv[2] === "reuse-candidate") await reuseCandidate();
    else if (process.argv[2] === "deploy-test-images") await deployTestImages();
    else if (process.argv[2] === "resolve-candidate") await resolveCandidate();
    else if (process.argv[2] === "release-flags") await releaseFlags();
    else
      throw new Error(
        "Expected build-matrix, merge-candidate, plan-reuse, reuse-candidate, deploy-test-images, resolve-candidate, release or release-flags",
      );
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
