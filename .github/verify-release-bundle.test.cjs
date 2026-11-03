const assert = require("node:assert/strict");
const test = require("node:test");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createBundle,
  hash,
  INSTALL_FILES,
  VARIANTS,
  REPOSITORY,
} = require("./frameleaf-release.cjs");
const {
  verifyBundle,
  verifyNasManifest,
  verifyDatabaseImageChange,
} = require("./verify-release-bundle.cjs");

test("NAS packaging accepts one complete version-matched release bundle", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frameleaf-bundle-"));
  const tag = "frameleaf-v3.1.0-12";
  const sourceCommit = "a".repeat(40);
  try {
    await fs.mkdir(path.join(root, "docker"));
    await fs.mkdir(path.join(root, "server/src/fork-schema"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "packaging/nas"), { recursive: true });
    for (const name of INSTALL_FILES)
      await fs.writeFile(
        path.join(root, "docker", name),
        name === "example.env"
          ? "FRAMELEAF_VERSION=latest\n"
          : name.startsWith("docker-compose")
            ? [
                "services:",
                "  frameleaf-server:",
                "    image: ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}",
                "  frameleaf-machine-learning:",
                "    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}",
                "  database:",
                `    image: ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7@sha256:${"c".repeat(64)}`,
                "",
              ].join("\n")
            : "services: {}\n",
      );
    const manifest = {
      schemaVersion: 3,
      repository: REPOSITORY,
      tag,
      sourceCommit,
      buildRun: "https://github.com/Frameleaf/frameleaf-app/actions/runs/123",
      dependencies: [
        {
          reference:
            "ghcr.io/frameleaf/frameleaf-postgres:19beta4-pgvector0.8.7",
          digest: `sha256:${"c".repeat(64)}`,
        },
      ],
      images: VARIANTS.map((spec) => ({
        image: `ghcr.io/frameleaf/${spec.image}`,
        suffix: spec.suffix,
        platforms: spec.platforms,
        digest: `sha256:${"b".repeat(64)}`,
        sourceCommit,
      })),
    };
    const bundle = path.join(root, "bundle");
    await createBundle(bundle, root, tag, manifest);
    const sumsFile = path.join(bundle, "SHA256SUMS");
    const originalSums = await fs.readFile(sumsFile, "utf8");
    assert.equal(manifest.schemaVersion, 3);
    const generatedNas = JSON.parse(
      await fs.readFile(path.join(bundle, "nas-manifest.json"), "utf8"),
    );
    assert.equal(generatedNas.schemaVersion, 3);
    assert.equal(generatedNas.buildRun, manifest.buildRun);
    assert.equal(generatedNas.migration, undefined);
    assert.equal(generatedNas.images.valkey, undefined);
    assert.equal(
      await fs.stat(path.join(bundle, "supported-versions.json")).then(
        () => true,
        () => false,
      ),
      false,
    );
    const refreshSums = async () => {
      const lines = await Promise.all(
        originalSums
          .trimEnd()
          .split("\n")
          .map(async (line) => {
            const name = line.split("  ")[1];
            return `${hash(await fs.readFile(path.join(bundle, name))).slice(7)}  ${name}`;
          }),
      );
      await fs.writeFile(sumsFile, lines.join("\n") + "\n");
    };
    assert.equal((await verifyBundle(bundle, tag)).tag, tag);
    await assert.rejects(
      verifyBundle(bundle, "frameleaf-v3.1.0-13"),
      /Release tag differs/,
    );
    const composeFile = path.join(bundle, "docker-compose.yml");
    const originalCompose = await fs.readFile(composeFile, "utf8");
    await fs.appendFile(composeFile, "# changed\n");
    await assert.rejects(verifyBundle(bundle, tag), /checksum differs/);
    await fs.writeFile(composeFile, originalCompose);
    await refreshSums();

    const envFile = path.join(bundle, "example.env");
    const originalEnv = await fs.readFile(envFile, "utf8");
    for (const assignment of [
      "FRAMELEAF_VERSION=other",
      "FRAMELEAF_VERSION = other",
      "FRAMELEAF_VERSION: other",
      "export FRAMELEAF_VERSION=other",
      // a leftover deprecated name is a second setting too
      "IMMICH_VERSION=other",
    ]) {
      await fs.writeFile(envFile, `${originalEnv}${assignment}\n`);
      await refreshSums();
      await assert.rejects(
        verifyBundle(bundle, tag),
        /Environment version differs/,
      );
    }
    await fs.writeFile(envFile, originalEnv);
    await refreshSums();
    // The bundle names its own exact tag beside the latest setting.
    assert.ok(
      originalEnv.includes(
        `# This release: FRAMELEAF_VERSION=${tag}\nFRAMELEAF_VERSION=latest\n`,
      ),
    );
    await fs.writeFile(
      envFile,
      originalEnv.replace(tag, "frameleaf-v3.1.0-13"),
    );
    await refreshSums();
    await assert.rejects(
      verifyBundle(bundle, tag),
      /Environment release tag differs/,
    );
    await fs.writeFile(envFile, originalEnv);
    await refreshSums();

    for (const name of ["docker-compose.yml", "docker-compose.rootless.yml"])
      for (const image of ["frameleaf-server", "frameleaf-machine-learning"]) {
        const file = path.join(bundle, name);
        const valid = await fs.readFile(file, "utf8");
        await fs.writeFile(
          file,
          valid.replace(
            `ghcr.io/frameleaf/${image}:\${FRAMELEAF_VERSION:-\${IMMICH_VERSION:-latest}}`,
            `ghcr.io/frameleaf/${image}:wrong`,
          ) + `# \${FRAMELEAF_VERSION:-\${IMMICH_VERSION:-latest}}\n`,
        );
        await refreshSums();
        await assert.rejects(
          verifyBundle(bundle, tag),
          /image version differs/,
        );
        await fs.writeFile(file, valid);
        await refreshSums();
      }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

// Review M2: the database image tag is taken from the bundle, so a GA (or later beta) PostgreSQL build can
// ship without changing this verifier; the digest and dependency checks stay, and an in-place image change
// must be declared in the signed NAS manifest.
test("the verifier accepts any digest-pinned frameleaf-postgres build the release verified and checks declared image changes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frameleaf-bundle-pg-"));
  const tag = "frameleaf-v3.2.0-1";
  const sourceCommit = "a".repeat(40);
  const image = (name) => `ghcr.io/frameleaf/frameleaf-postgres:${name}`;
  const ga = `${image("19.0-pgvector0.8.7")}@sha256:${"d".repeat(64)}`;
  try {
    await fs.mkdir(path.join(root, "docker/postgres"), { recursive: true });
    for (const name of INSTALL_FILES)
      await fs.writeFile(
        path.join(root, "docker", name),
        name === "example.env"
          ? "FRAMELEAF_VERSION=latest\n"
          : name.startsWith("docker-compose")
            ? [
                "services:",
                "  frameleaf-server:",
                "    image: ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}",
                "  frameleaf-machine-learning:",
                "    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-latest}}",
                "  database:",
                `    image: ${ga}`,
                "",
              ].join("\n")
            : "services: {}\n",
      );
    const manifest = {
      schemaVersion: 3,
      repository: REPOSITORY,
      tag,
      sourceCommit,
      buildRun: "https://github.com/Frameleaf/frameleaf-app/actions/runs/123",
      dependencies: [{ reference: ga.split("@")[0], digest: ga.split("@")[1] }],
      images: VARIANTS.map((spec) => ({
        image: `ghcr.io/frameleaf/${spec.image}`,
        suffix: spec.suffix,
        platforms: spec.platforms,
        digest: `sha256:${"b".repeat(64)}`,
        sourceCommit,
      })),
    };
    const bundle = path.join(root, "bundle");
    await createBundle(bundle, root, tag, manifest);
    const nas = JSON.parse(
      await fs.readFile(path.join(bundle, "nas-manifest.json"), "utf8"),
    );
    assert.equal(nas.images.postgres, ga);
    assert.equal(nas.databaseImageChange, undefined);
    assert.equal((await verifyBundle(bundle, tag)).tag, tag);
    // Tags the verifier accepts, each still digest-pinned and listed as a verified dependency.
    for (const name of [
      "19beta4-pgvector0.8.7",
      "19rc1-pgvector0.8.7",
      "19.0-pgvector0.8.7",
      "19.2-pgvector0.9.1",
      "20beta1-pgvector0.9.0",
    ]) {
      const postgres = `${image(name)}@sha256:${"e".repeat(64)}`;
      verifyNasManifest(
        { ...nas, images: { ...nas.images, postgres } },
        {
          ...manifest,
          dependencies: [
            { reference: image(name), digest: postgres.split("@")[1] },
          ],
        },
      );
    }
    for (const postgres of [
      image("19.0-pgvector0.8.7"),
      `${image("latest")}@sha256:${"e".repeat(64)}`,
      `${image("19.0")}@sha256:${"e".repeat(64)}`,
      `docker.io/library/postgres:19.0-pgvector0.8.7@sha256:${"e".repeat(64)}`,
      `${image("19.0-pgvector0.8.7")}@sha256:${"f".repeat(64)}`, // not the verified digest
    ])
      assert.throws(
        () =>
          verifyNasManifest(
            { ...nas, images: { ...nas.images, postgres } },
            manifest,
          ),
        /NAS database (?:image is not a digest-pinned|was not verified)/,
        postgres,
      );
    // A declared in-place change: same major, exact target, backup required, previous images listed once.
    const declared = {
      strategy: "in-place",
      from: [image("19beta4-pgvector0.8.7"), image("19rc1-pgvector0.8.7")],
      to: image("19.0-pgvector0.8.7"),
      requiresBackup: true,
      notes: "PostgreSQL 19 GA keeps the beta 4 on-disk format.",
    };
    verifyDatabaseImageChange(declared, ga);
    verifyDatabaseImageChange(undefined, ga);
    for (const [label, change] of [
      ["null", null],
      ["array", [declared]],
      ["strategy", { ...declared, strategy: "pg_upgrade" }],
      ["no backup", { ...declared, requiresBackup: false }],
      ["target differs", { ...declared, to: image("19.1-pgvector0.8.7") }],
      ["crosses a major", { ...declared, from: [image("18.4-pgvector0.8.7")] }],
      ["empty from", { ...declared, from: [] }],
      [
        "duplicate from",
        {
          ...declared,
          from: [
            image("19beta4-pgvector0.8.7"),
            image("19beta4-pgvector0.8.7"),
          ],
        },
      ],
      [
        "from is the target",
        { ...declared, from: [image("19.0-pgvector0.8.7")] },
      ],
      [
        "foreign from",
        { ...declared, from: ["docker.io/library/postgres:19beta4"] },
      ],
      ["extra field", { ...declared, pgUpgrade: true }],
      ["notes type", { ...declared, notes: 7 }],
    ])
      assert.throws(
        () => verifyDatabaseImageChange(change, ga),
        /NAS databaseImageChange/,
        label,
      );
    assert.throws(
      () =>
        verifyNasManifest(
          {
            ...nas,
            databaseImageChange: {
              ...declared,
              to: image("19.1-pgvector0.8.7"),
            },
          },
          manifest,
        ),
      /NAS databaseImageChange target differs/,
    );
    // createBundle embeds docker/postgres/database-image-change.json after validating it against the image.
    await fs.writeFile(
      path.join(root, "docker/postgres/database-image-change.json"),
      JSON.stringify(declared),
    );
    const changed = path.join(root, "bundle-change");
    await createBundle(changed, root, tag, manifest);
    const declaredNas = JSON.parse(
      await fs.readFile(path.join(changed, "nas-manifest.json"), "utf8"),
    );
    assert.deepEqual(declaredNas.databaseImageChange, declared);
    assert.equal((await verifyBundle(changed, tag)).tag, tag);
    await fs.writeFile(
      path.join(root, "docker/postgres/database-image-change.json"),
      JSON.stringify({ ...declared, to: image("19.1-pgvector0.8.7") }),
    );
    await assert.rejects(
      createBundle(path.join(root, "bundle-bad"), root, tag, manifest),
      /target differs/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
