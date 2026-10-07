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
const { verifyBundle } = require("./verify-release-bundle.cjs");

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
          ? "FRAMELEAF_VERSION=release\n"
          : name.startsWith("docker-compose")
            ? [
                "services:",
                "  frameleaf-server:",
                "    image: ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}",
                "  immich-machine-learning:",
                "    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}",
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

    for (const name of ["docker-compose.yml", "docker-compose.rootless.yml"])
      for (const image of ["frameleaf-server", "frameleaf-machine-learning"]) {
        const file = path.join(bundle, name);
        const valid = await fs.readFile(file, "utf8");
        await fs.writeFile(
          file,
          valid.replace(
            `ghcr.io/frameleaf/${image}:\${FRAMELEAF_VERSION:-\${IMMICH_VERSION:-${tag}}}`,
            `ghcr.io/frameleaf/${image}:wrong`,
          ) + `# \${FRAMELEAF_VERSION:-\${IMMICH_VERSION:-${tag}}}\n`,
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
