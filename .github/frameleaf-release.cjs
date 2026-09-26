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
const RELEASE_MANAGED_IMAGE = /\$\{IMMICH_VERSION/;
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
    if (RELEASE_MANAGED_IMAGE.test(reference)) continue;
    assert(
      !/immich-app/.test(reference),
      `${reference}: installations must not pull upstream images`,
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
      found = await registry.read(image, tag ?? pinned);
    } catch (error) {
      if ([401, 403, 404].includes(error.status))
        throw new Error(
          `${reference} is not published (registry status ${error.status}). Publish it with its workflow's manual dispatch before promoting a release.`,
        );
      throw error;
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
function trustedRun(run, sha) {
  return (
    run?.head_sha === sha &&
    run.head_branch === MAIN &&
    run.head_repository?.full_name === REPOSITORY &&
    ["push", "workflow_dispatch"].includes(run.event) &&
    run.status === "completed" &&
    run.conclusion === "success" &&
    run.path === ".github/workflows/docker.yml"
  );
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
  async token(image) {
    assert(
      VARIANTS.some((v) => v.image === image) ||
        DEPENDENCY_IMAGES.includes(image),
      "Unknown registry image",
    );
    if (!this.tokens.has(image)) {
      assert(this.env.GITHUB_TOKEN, "GITHUB_TOKEN is required");
      const auth = Buffer.from(
        `${this.env.GITHUB_ACTOR || "frameleaf"}:${this.env.GITHUB_TOKEN}`,
      ).toString("base64");
      const response = await fetch(
        `https://ghcr.io/token?service=ghcr.io&scope=repository:frameleaf/${image}:pull`,
        {
          headers: { Authorization: `Basic ${auth}` },
          signal: AbortSignal.timeout(60_000),
        },
      );
      const body = JSON.parse(await checkedResponse(response, 1024 * 1024));
      assert(
        typeof body.token === "string" && body.token.length > 0,
        "Missing registry token",
      );
      this.tokens.set(image, body.token);
    }
    return this.tokens.get(image);
  }
  async read(image, reference, kind = "manifests") {
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
          Authorization: `Bearer ${await this.token(image)}`,
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
// Keep the original build identity. Qualification may advance without rebuilding.
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
  assert.equal(manifest.repository, REPOSITORY, "Foreign reuse repository");
  assert.equal(manifest.tag, record.tag_name, "Reuse release tag differs");
  assert.equal(
    manifest.sourceCommit,
    record.target_commitish,
    "Reuse release source differs",
  );
  const run = new RegExp(`^${SOURCE}/actions/runs/([0-9]+)$`).exec(
    manifest.certifiedBuildRun,
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
    "Reuse image qualification differs",
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
  const tag = index.json.annotations?.["org.frameleaf.qualification.release"];
  if (!tag) return verifyImage(registry, spec, sha, index.digest);
  const image = await verifyReuse(
    registry,
    spec,
    sha,
    await evidence(tag),
    checkInputs,
  );
  assert.equal(
    index.json.annotations["org.frameleaf.qualification.revision"],
    sha,
    "Wrong qualification revision",
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
// qualification record; the revision stays the commit the image was built from.
function reuseAnnotations(spec, image, env) {
  return [
    "--annotation",
    `index:org.opencontainers.image.source=${SOURCE}`,
    "--annotation",
    `index:org.opencontainers.image.revision=${image.buildSourceCommit}`,
    "--annotation",
    `index:org.frameleaf.build.variant=${spec.device}${spec.suffix}`,
    "--annotation",
    `index:org.frameleaf.qualification.revision=${env.GITHUB_SHA}`,
    "--annotation",
    `index:org.frameleaf.qualification.release=${env.REUSE_RELEASE}`,
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
        Authorization: `Bearer ${process.env.GITHUB_TOKEN}`,
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
      assert(/^IMMICH_VERSION=.+$/m.test(body), "Missing version setting");
      body = body.replace(/^IMMICH_VERSION=.+$/m, `IMMICH_VERSION=${tag}`);
    } else if (name.startsWith("docker-compose")) {
      assert(
        body.includes("${IMMICH_VERSION:-release}"),
        "Missing Compose release fallback",
      );
      body = body.replaceAll(
        "${IMMICH_VERSION:-release}",
        "${IMMICH_VERSION:-" + tag + "}",
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
  await fs.copyFile(
    path.join(root, "server/src/fork-schema/supported-versions.json"),
    path.join(directory, "supported-versions.json"),
  );
  files.push("supported-versions.json");
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
  assert(/^\d+$/.test(env.CERTIFIED_RUN_ID), "Missing certified build run");
  assert(
    trustedRun(
      await github(`actions/runs/${env.CERTIFIED_RUN_ID}`),
      env.SOURCE_SHA,
    ),
    "Build run is not trusted",
  );
  assert(await currentMainline(env.SOURCE_SHA), "Stale release candidate");
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
    schemaVersion: 2,
    repository: REPOSITORY,
    sourceCommit: env.SOURCE_SHA,
    tag,
    certifiedBuildRun: `${SOURCE}/actions/runs/${env.CERTIFIED_RUN_ID}`,
    images,
    dependencies: [...dependencies].map(([reference, digest]) => ({
      reference,
      digest,
    })),
    certification:
      "Integration and all three official-container roundtrip lanes passed in the referenced build run.",
    provenance:
      "Image/index revision labels and SHA-256 content verified; BuildKit metadata/SBOM are not a signed provenance claim.",
  };
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
        body: `Certified source: ${env.SOURCE_SHA}\n\nBuild and compatibility evidence: ${manifest.certifiedBuildRun}\n\nUse the attached version-matched installation files and release-manifest.json.`,
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
    else throw new Error("Expected build-matrix, merge-candidate or release");
  })().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
