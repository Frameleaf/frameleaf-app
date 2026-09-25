const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  VARIANTS,
  SOURCE,
  INSTALL_FILES,
  validateBuildInput,
  validateIndex,
  validateImageConfig,
  trustedRun,
  chooseTag,
  verifyImage,
  createBundle,
  checkedResponse,
  hash,
  Registry,
  reserveAndStage,
} = require("./frameleaf-release.cjs");
const sha = "a".repeat(40);
const digest = (n) => `sha256:${String(n).repeat(64)}`;
const clone = (v) => structuredClone(v);
function fixture(spec = VARIANTS[0]) {
  const entries = new Map();
  const manifests = spec.platforms.map((platform, i) => {
    const [os, architecture] = platform.split("/");
    const config = {
      os,
      architecture,
      config: {
        Labels: {
          "org.opencontainers.image.source": SOURCE,
          "org.opencontainers.image.revision": sha,
          "org.frameleaf.build.variant": spec.device + spec.suffix,
        },
      },
    };
    const configBytes = JSON.stringify(config);
    const configDigest = hash(configBytes);
    entries.set(configDigest, {
      digest: configDigest,
      json: config,
      size: configBytes.length,
    });
    const manifest = {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: configDigest, size: configBytes.length },
    };
    const manifestBytes = JSON.stringify(manifest);
    const manifestDigest = hash(manifestBytes);
    entries.set(manifestDigest, {
      digest: manifestDigest,
      json: manifest,
      size: manifestBytes.length,
    });
    return {
      mediaType: manifest.mediaType,
      digest: manifestDigest,
      size: manifestBytes.length,
      platform: { os, architecture },
    };
  });
  const index = {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    annotations: {
      "org.opencontainers.image.source": SOURCE,
      "org.opencontainers.image.revision": sha,
      "org.frameleaf.build.variant": spec.device + spec.suffix,
    },
    manifests,
  };
  const result = {
    json: index,
    digest: hash(JSON.stringify(index)),
    size: JSON.stringify(index).length,
  };
  const registry = {
    read: async (_image, ref) =>
      ref.startsWith("commit-") ? result : entries.get(ref),
  };
  return { index, entries, registry, result };
}

test("every supported image variant has an explicit native build contract", () => {
  assert.equal(VARIANTS.length, 7);
  for (const spec of VARIANTS) {
    const env = {
      IMAGE: spec.image,
      SUFFIX: spec.suffix,
      DEVICE: spec.device,
      PLATFORMS: spec.platforms.join(","),
      TARGET: spec.target,
      CONTEXT: spec.context,
      DOCKERFILE: spec.dockerfile,
      SOURCE_SHA: sha,
      GITHUB_SHA: sha,
      GITHUB_REPOSITORY: "Frameleaf/frameleaf-app",
      GITHUB_REF: "refs/heads/fork/main",
      GITHUB_EVENT_NAME: "push",
    };
    assert.deepEqual(
      validateBuildInput(env).map((r) => r.platform),
      spec.platforms,
    );
    for (const patch of [
      { GITHUB_REF: "refs/heads/feature" },
      { GITHUB_EVENT_NAME: "pull_request" },
      { GITHUB_REPOSITORY: "attacker/app" },
      { SOURCE_SHA: "b".repeat(40) },
      { TARGET: "" },
      { CONTEXT: "../other" },
      { PLATFORMS: "linux/ppc64le" },
    ])
      assert.throws(() => validateBuildInput({ ...env, ...patch }));
  }
  assert.equal(
    VARIANTS.some((v) => v.target !== "prod"),
    false,
  );
});

test("index requires every expected platform, once, with actual source metadata", () => {
  const { index } = fixture();
  assert.equal(validateIndex(index, VARIANTS[0], sha).size, 2);
  for (const mutate of [
    (v) => v.manifests.pop(),
    (v) => v.manifests.push(v.manifests[0]),
    (v) => {
      v.annotations["org.opencontainers.image.revision"] = "b".repeat(40);
    },
    (v) => {
      v.annotations["org.opencontainers.image.source"] =
        "https://github.com/immich-app/immich";
    },
    (v) => {
      v.manifests[0].platform.architecture = "ppc64le";
    },
    (v) => {
      v.manifests[0].size = -1;
    },
    (v) => {
      v.mediaType = "application/vnd.oci.image.manifest.v1+json";
    },
  ]) {
    const invalid = clone(index);
    mutate(invalid);
    assert.throws(() => validateIndex(invalid, VARIANTS[0], sha));
  }
});

test("only attestation descriptors linked to an actual image can have unknown platform", () => {
  const { index } = fixture();
  const attestation = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    size: 200,
    digest: digest(5),
    platform: { os: "unknown", architecture: "unknown" },
    annotations: {
      "vnd.docker.reference.type": "attestation-manifest",
      "vnd.docker.reference.digest": index.manifests[0].digest,
    },
  };
  index.manifests.push(attestation);
  assert.equal(validateIndex(index, VARIANTS[0], sha).size, 2);
  attestation.annotations["vnd.docker.reference.digest"] = digest(9);
  assert.throws(() => validateIndex(index, VARIANTS[0], sha), /Orphan/);
  delete attestation.annotations["vnd.docker.reference.type"];
  assert.throws(
    () => validateIndex(index, VARIANTS[0], sha),
    /not an attestation/,
  );
});

test("full verification follows each platform manifest through its image config", async () => {
  const { registry, result, entries } = fixture();
  const verified = await verifyImage(registry, VARIANTS[0], sha);
  assert.equal(verified.digest, result.digest);
  assert.deepEqual(verified.platforms, ["linux/amd64", "linux/arm64"]);
  const config = [...entries.values()].find((e) => e.json.config?.Labels);
  config.json.config.Labels["org.opencontainers.image.revision"] = "b".repeat(
    40,
  );
  await assert.rejects(
    verifyImage(registry, VARIANTS[0], sha),
    /Wrong image source revision/,
  );
});

test("index labels cannot disguise wrong image configuration or descriptor size", async () => {
  const first = fixture();
  first.index.manifests[0].size++;
  await assert.rejects(
    verifyImage(first.registry, VARIANTS[0], sha),
    /size differs/,
  );
  const second = fixture();
  const config = [...second.entries.values()].find(
    (e) => e.json.config?.Labels,
  );
  config.json.architecture = "s390x";
  await assert.rejects(
    verifyImage(second.registry, VARIANTS[0], sha),
    /platform differs/,
  );
  assert.throws(() =>
    validateImageConfig({ config: { Labels: {} } }, VARIANTS[0], sha),
  );
});

test("all seven ML manifests qualify only for their declared variant/platform set", async () => {
  for (const spec of VARIANTS.slice(1)) {
    const f = fixture(spec);
    const result = await verifyImage(f.registry, spec, sha);
    assert.equal(result.suffix, spec.suffix);
    assert.deepEqual(result.platforms, [...spec.platforms].sort());
    if (spec.suffix)
      assert.throws(() => validateIndex(f.index, VARIANTS[1], sha), /variant/);
  }
});

test("manual releases require a successful canonical exact-SHA Docker run", () => {
  const run = {
    head_sha: sha,
    head_branch: "fork/main",
    head_repository: { full_name: "Frameleaf/frameleaf-app" },
    event: "workflow_dispatch",
    status: "completed",
    conclusion: "success",
    path: ".github/workflows/docker.yml",
  };
  assert.equal(trustedRun(run, sha), true);
  for (const patch of [
    { conclusion: "failure" },
    { event: "pull_request" },
    { path: ".github/workflows/other.yml" },
    { head_sha: "b".repeat(40) },
    { status: "in_progress" },
    { head_repository: { full_name: "attacker/app" } },
  ])
    assert.equal(trustedRun({ ...run, ...patch }, sha), false);
});

test("release sequence uses existing refs as well as releases and resumes the same source", () => {
  assert.equal(chooseTag("3.1.0", [], [], sha), "frameleaf-v3.1.0-1");
  assert.equal(
    chooseTag(
      "3.1.0",
      [{ tag_name: "frameleaf-v3.1.0-7" }],
      [{ ref: "refs/tags/frameleaf-v3.1.0-104" }],
      sha,
    ),
    "frameleaf-v3.1.0-105",
  );
  assert.equal(
    chooseTag(
      "3.1.0",
      [{ tag_name: "frameleaf-v3.1.0-7", target_commitish: sha }],
      [],
      sha,
    ),
    "frameleaf-v3.1.0-7",
  );
  assert.equal(
    chooseTag(
      "3.1.0-rc.1",
      [{ tag_name: "frameleaf-v3x1x0-rcx1-999" }],
      [],
      sha,
    ),
    "frameleaf-v3.1.0-rc.1-1",
  );
  assert.throws(() =>
    chooseTag(
      "3.1.0",
      [
        { tag_name: "frameleaf-v3.1.0-1", target_commitish: sha },
        { tag_name: "frameleaf-v3.1.0-2", target_commitish: sha },
      ],
      [],
      sha,
    ),
  );
  for (const invalid of [
    "$(touch surprise)",
    "../3.1.0",
    "3.1",
    "3.1.0+unsafe",
  ])
    assert.throws(() => chooseTag(invalid, [], [], sha));
});

test("install bundle pins both Compose fallbacks and env while preserving data configuration", async () => {
  const root = await fs.mkdtemp(
    path.join(os.tmpdir(), "frameleaf-bundle-test-"),
  );
  try {
    await fs.mkdir(path.join(root, "docker"));
    await fs.mkdir(path.join(root, "server/src/fork-schema"), {
      recursive: true,
    });
    for (const name of INSTALL_FILES) {
      const text = name.startsWith("docker-compose")
        ? "image: ghcr.io/frameleaf/frameleaf-server:${IMMICH_VERSION:-release}\nvolumes: [model-cache]\n"
        : name === "example.env"
          ? "IMMICH_VERSION=v3\nUPLOAD_LOCATION=./library\nDB_DATA_LOCATION=./postgres\n"
          : "services: {}\n";
      await fs.writeFile(path.join(root, "docker", name), text);
    }
    await fs.writeFile(
      path.join(root, "server/src/fork-schema/supported-versions.json"),
      '{"certifiedTags":["v3.1.0"]}',
    );
    const dir = path.join(root, "bundle");
    const tag = "frameleaf-v3.1.0-12";
    const files = await createBundle(dir, root, tag, { sourceCommit: sha });
    assert.equal(files.length, 8);
    const env = await fs.readFile(path.join(dir, "example.env"), "utf8");
    assert(
      env.includes(`IMMICH_VERSION=${tag}\n`) &&
        env.includes("DB_DATA_LOCATION=./postgres"),
    );
    const compose = await fs.readFile(
      path.join(dir, "docker-compose.yml"),
      "utf8",
    );
    assert(
      compose.includes("${IMMICH_VERSION:-" + tag + "}") &&
        compose.includes("model-cache"),
    );
    const original = await fs.readFile(
      path.join(root, "docker/example.env"),
      "utf8",
    );
    assert(original.includes("IMMICH_VERSION=v3"));
    const sums = (await fs.readFile(path.join(dir, "SHA256SUMS"), "utf8"))
      .trim()
      .split("\n");
    assert.equal(sums.length, 7);
    for (const line of sums) {
      const [expected, name] = line.split("  ");
      assert.equal(
        hash(await fs.readFile(path.join(dir, name))).slice(7),
        expected,
      );
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("registry reads reject errors and oversized chunked responses without printing credentials", async () => {
  await assert.rejects(
    checkedResponse(new Response("denied", { status: 403 })),
    /403/,
  );
  await assert.rejects(
    checkedResponse(new Response("too big"), 3),
    /too large/,
  );
  await assert.rejects(
    checkedResponse(
      new Response("ok", { headers: { "content-length": "1024" } }),
      10,
    ),
    /too large/,
  );
  assert.equal(
    (await checkedResponse(new Response("valid"))).toString(),
    "valid",
  );
});

test("registry verifies SHA-256 against the actual received manifest bytes", async (t) => {
  const body = JSON.stringify({ schemaVersion: 2 });
  let reported = hash(body);
  let responseBody = body;
  t.mock.method(globalThis, "fetch", async (url) => {
    if (String(url).startsWith("https://ghcr.io/token?"))
      return new Response(JSON.stringify({ token: "test-token" }));
    assert(
      String(url).startsWith(
        "https://ghcr.io/v2/frameleaf/frameleaf-server/manifests/",
      ),
    );
    return new Response(responseBody, {
      headers: { "docker-content-digest": reported },
    });
  });
  const client = new Registry({
    GITHUB_TOKEN: "not-a-real-token",
    GITHUB_ACTOR: "test",
  });
  assert.equal(
    (await client.read("frameleaf-server", "commit-" + sha)).digest,
    hash(body),
  );
  reported = digest(9);
  await assert.rejects(
    client.read("frameleaf-server", "commit-" + sha),
    /manifest hash differs/,
  );
  reported = hash(body);
  responseBody = body + " ";
  await assert.rejects(
    client.read("frameleaf-server", hash(body)),
    /content digest differs/,
  );
  await assert.rejects(
    client.read("other-owner/other-image", "release"),
    /Unknown registry image/,
  );
});

test("a partial version alias failure reserves its sequence before a newer candidate", async () => {
  const releases = [];
  const aliases = new Map();
  const events = [];
  const tag = chooseTag("3.1.0", releases, [], sha);
  const specs = VARIANTS.slice(0, 3);
  const images = specs.map((_, i) => ({ digest: digest(i + 1) }));
  await assert.rejects(
    reserveAndStage({
      sha,
      tag,
      images,
      specs,
      reserve: async () => {
        const record = { tag_name: tag, target_commitish: sha, draft: true };
        events.push("reserve");
        releases.push(record);
        return record;
      },
      readVersion: async (spec, ref) => {
        const value = aliases.get(spec.image + ":" + ref);
        if (!value) throw Object.assign(new Error("missing"), { status: 404 });
        return value;
      },
      writeVersion: async (spec, image) => {
        events.push("alias");
        if (events.length === 3)
          throw new Error("interrupted after first alias");
        aliases.set(spec.image + ":" + tag + spec.suffix, image);
      },
    }),
    /interrupted/,
  );
  assert.deepEqual(events, ["reserve", "alias", "alias"]);
  assert.equal(aliases.size, 1);
  assert.equal(
    chooseTag("3.1.0", releases, [], "b".repeat(40)),
    "frameleaf-v3.1.0-2",
  );
  assert.equal(chooseTag("3.1.0", releases, [], sha), tag);
  let resumed = 0;
  await reserveAndStage({
    existing: releases[0],
    sha,
    tag,
    images,
    specs,
    reserve: async () => {
      throw new Error("must reuse reserved release");
    },
    readVersion: async (spec, ref) => {
      const value = aliases.get(spec.image + ":" + ref);
      if (!value) throw Object.assign(new Error("missing"), { status: 404 });
      return value;
    },
    writeVersion: async (spec, image) => {
      aliases.set(spec.image + ":" + tag + spec.suffix, image);
      resumed++;
    },
  });
  assert.equal(resumed, 2);
});

test("reserved release mismatch and existing version conflicts never overwrite aliases", async () => {
  const args = {
    sha,
    tag: "frameleaf-v3.1.0-1",
    images: [{ digest: digest(1) }],
    specs: [VARIANTS[0]],
    reserve: async () => {
      throw new Error("not expected");
    },
    readVersion: async () => ({ digest: digest(2) }),
    writeVersion: async () => assert.fail("must not overwrite"),
  };
  await assert.rejects(
    reserveAndStage({
      ...args,
      existing: {
        tag_name: args.tag,
        target_commitish: "b".repeat(40),
        draft: true,
      },
    }),
    /another target/,
  );
  await assert.rejects(
    reserveAndStage({
      ...args,
      existing: { tag_name: args.tag, target_commitish: sha, draft: true },
    }),
    /different content/,
  );
});

test("qualified unchanged reuse retains immutable build source and rejects altered evidence", async () => {
  const { verifyReuse } = require("./frameleaf-release.cjs");
  const f = fixture();
  f.entries.set(f.result.digest, f.result);
  const qualified = "b".repeat(40);
  const manifest = {
    repository: "Frameleaf/frameleaf-app",
    tag: "frameleaf-v3.2.0-1",
    sourceCommit: sha,
    images: [
      {
        image: "ghcr.io/frameleaf/frameleaf-server",
        suffix: "",
        sourceCommit: sha,
        digest: f.result.digest,
      },
    ],
  };
  const inputs = [];
  const result = await verifyReuse(
    f.registry,
    VARIANTS[0],
    qualified,
    manifest,
    (_spec, built, current) => inputs.push([built, current]),
  );
  assert.equal(result.sourceCommit, qualified);
  assert.equal(result.buildSourceCommit, sha);
  assert.equal(result.buildDigest, f.result.digest);
  assert.equal(f.index.annotations["org.opencontainers.image.revision"], sha);
  assert.deepEqual(inputs, [
    [sha, qualified],
    [sha, qualified],
  ]);
  await assert.rejects(
    verifyReuse(f.registry, VARIANTS[0], qualified, manifest, () => {
      throw Error("Image build inputs changed");
    }),
    /inputs changed/,
  );
  for (const mutate of [
    (m) => {
      m.repository = "foreign/app";
    },
    (m) => {
      m.images[0].sourceCommit = qualified;
    },
    (m) => {
      m.images.push(m.images[0]);
    },
    (m) => {
      m.images[0].buildDigest = "latest";
    },
    (m) => {
      m.images[0].buildSourceCommit = qualified;
    },
  ]) {
    const invalid = clone(manifest);
    mutate(invalid);
    await assert.rejects(
      verifyReuse(f.registry, VARIANTS[0], qualified, invalid, () => {}),
    );
  }
  const config = [...f.entries.values()].find((e) => e.json.config?.Labels);
  config.json.config.Labels["org.opencontainers.image.source"] =
    "https://github.com/foreign/app";
  await assert.rejects(
    verifyReuse(f.registry, VARIANTS[0], qualified, manifest, () => {}),
    /source repository/,
  );
});

test("reuse compares original inputs and ancestry, including non-obvious Docker inputs", () => {
  const { identicalBuildInputs } = require("./frameleaf-release.cjs");
  const calls = [];
  identicalBuildInputs(VARIANTS[0], sha, "b".repeat(40), (...args) => {
    calls.push(args);
    return Buffer.from("");
  });
  assert.deepEqual(calls[0], [
    "merge-base",
    "--is-ancestor",
    sha,
    "b".repeat(40),
  ]);
  for (const input of [
    ".pnpmfile.cjs",
    "mise.toml",
    "mise.lock",
    "LICENSE",
    ".dockerignore",
    "packages",
    ".github/workflows/local-multi-runner-build.yml",
  ])
    assert(calls[1].includes(input), input);
  assert.throws(
    () =>
      identicalBuildInputs(VARIANTS[0], sha, "b".repeat(40), (...args) => {
        if (args[0] === "merge-base") throw Error("Non-ancestor stale source");
        return Buffer.from("");
      }),
    /Non-ancestor/,
  );
  assert.throws(
    () =>
      identicalBuildInputs(VARIANTS[0], sha, "b".repeat(40), (...args) =>
        Buffer.from(args[0] === "diff" ? "server/Dockerfile" : ""),
      ),
    /inputs changed/,
  );
});

test("a reused candidate restates the index annotations validateIndex requires", () => {
  const release = require("./frameleaf-release.cjs");
  const spec = release.variant("frameleaf-server", "");
  const image = {
    buildSourceCommit: "a".repeat(40),
    buildDigest: `sha256:${"b".repeat(64)}`,
  };
  const args = release.reuseAnnotations(spec, image, {
    GITHUB_SHA: "c".repeat(40),
    REUSE_RELEASE: "frameleaf-v1.0.0",
  });
  const values = args.filter((_, index) => index % 2 === 1);
  assert.ok(
    args.every((arg, index) => index % 2 === 1 || arg === "--annotation"),
  );
  assert.deepEqual(values, [
    `index:org.opencontainers.image.source=${release.SOURCE}`,
    `index:org.opencontainers.image.revision=${"a".repeat(40)}`,
    `index:org.frameleaf.build.variant=${spec.device}${spec.suffix}`,
    `index:org.frameleaf.qualification.revision=${"c".repeat(40)}`,
    "index:org.frameleaf.qualification.release=frameleaf-v1.0.0",
    `index:org.frameleaf.build.digest=sha256:${"b".repeat(64)}`,
  ]);
});

test("release accepts truthful reused candidate index and rejects changed qualification or children", async () => {
  const { candidateImage } = require("./frameleaf-release.cjs");
  const f = fixture();
  f.entries.set(f.result.digest, f.result);
  const qualified = "b".repeat(40);
  const manifest = {
    repository: "Frameleaf/frameleaf-app",
    tag: "frameleaf-v3.2.0-1",
    sourceCommit: sha,
    images: [
      {
        image: "ghcr.io/frameleaf/frameleaf-server",
        suffix: "",
        sourceCommit: sha,
        digest: f.result.digest,
      },
    ],
  };
  const index = clone(f.index);
  Object.assign(index.annotations, {
    "org.frameleaf.qualification.release": manifest.tag,
    "org.frameleaf.qualification.revision": qualified,
    "org.frameleaf.build.digest": f.result.digest,
  });
  const candidate = {
    json: index,
    digest: hash(JSON.stringify(index)),
    size: JSON.stringify(index).length,
  };
  f.entries.set(candidate.digest, candidate);
  const registry = {
    read: async (image, reference) =>
      reference === `commit-${qualified}`
        ? candidate
        : f.registry.read(image, reference),
  };
  const result = await candidateImage(
    registry,
    VARIANTS[0],
    qualified,
    async () => manifest,
    () => {},
  );
  assert.equal(result.digest, candidate.digest);
  assert.equal(result.buildDigest, f.result.digest);
  assert.equal(result.buildSourceCommit, sha);
  assert.equal(result.sourceCommit, qualified);
  index.annotations["org.frameleaf.qualification.revision"] = sha;
  await assert.rejects(
    candidateImage(
      registry,
      VARIANTS[0],
      qualified,
      async () => manifest,
      () => {},
    ),
    /qualification revision/,
  );
  index.annotations["org.frameleaf.qualification.revision"] = qualified;
  index.manifests.pop();
  await assert.rejects(
    candidateImage(
      registry,
      VARIANTS[0],
      qualified,
      async () => manifest,
      () => {},
    ),
    /manifest content/,
  );
});

test("manual dispatch rejects existing fresh or reused same-SHA candidates before scheduling builds", async () => {
  const { planReuse } = require("./frameleaf-release.cjs");
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "frameleaf-manual-"),
  );
  const output = path.join(directory, "outputs");
  const env = {
    GITHUB_REPOSITORY: "Frameleaf/frameleaf-app",
    GITHUB_REF: "refs/heads/fork/main",
    GITHUB_SHA: sha,
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_OUTPUT: output,
  };
  try {
    for (const reused of [false, true]) {
      const f = fixture();
      if (reused)
        f.index.annotations["org.frameleaf.qualification.revision"] =
          "b".repeat(40);
      await fs.writeFile(output, "");
      await assert.rejects(
        planReuse(
          { ...env, GITHUB_SHA: reused ? "b".repeat(40) : sha },
          { read: async () => f.result },
        ),
        /requires a new source revision/,
      );
      assert.equal(await fs.readFile(output, "utf8"), "");
    }
    const refs = [];
    await planReuse(env, {
      read: async (image, ref) => {
        refs.push([image, ref]);
        throw Object.assign(Error("Missing"), { status: 404 });
      },
    });
    assert.equal(refs.length, VARIANTS.length);
    assert.equal(
      await fs.readFile(output, "utf8"),
      "server=true\nserver-release=\nmachine-learning=true\nmachine-learning-release=\n",
    );
    await fs.writeFile(output, "");
    await assert.rejects(
      planReuse(env, {
        read: async () => {
          throw Object.assign(Error("Forbidden"), { status: 403 });
        },
      }),
      /Forbidden/,
    );
    assert.equal(await fs.readFile(output, "utf8"), "");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
