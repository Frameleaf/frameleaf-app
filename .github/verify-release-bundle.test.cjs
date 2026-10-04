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
  SOURCE,
  ATTESTATION_TYPE,
  LEGACY_ATTESTATION_TYPE,
} = require("./frameleaf-release.cjs");
const { verifyBundle } = require("./verify-release-bundle.cjs");
const { syntheticCliQualification } = require("./fixtures/cli-qualification.cjs");

test("NAS packaging verifies strict v3 and authenticated historical v2 contracts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "frameleaf-bundle-"));
  const tag = "frameleaf-v3.1.0-12";
  const sourceCommit = "a".repeat(40);
  try {
    await fs.mkdir(path.join(root, "docker"));
    await fs.mkdir(path.join(root, "server/src/fork-schema"), {
      recursive: true,
    });
    await fs.mkdir(path.join(root, "packaging/nas"), { recursive: true });
    await fs.writeFile(
      path.join(root, "packaging/nas/certified-sources.json"),
      '{"officialImmich":[],"priorFrameleaf":[]}',
    );
    for (const name of INSTALL_FILES)
      await fs.writeFile(
        path.join(root, "docker", name),
        name === "example.env"
          ? "FRAMELEAF_VERSION=release\n"
          : name.startsWith("docker-compose")
            ? [
                "services:",
                "  immich-server:",
                "    image: ghcr.io/frameleaf/frameleaf-server:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}",
                "  immich-machine-learning:",
                "    image: ghcr.io/frameleaf/frameleaf-machine-learning:${FRAMELEAF_VERSION:-${IMMICH_VERSION:-release}}",
                "  database:",
                `    image: ghcr.io/frameleaf/frameleaf-postgres:14@sha256:${"c".repeat(64)}`,
                "  redis:",
                `    image: valkey/valkey:9@sha256:${"d".repeat(64)}`,
                "",
              ].join("\n")
            : "services: {}\n",
      );
    await fs.writeFile(
      path.join(root, "server/src/fork-schema/supported-versions.json"),
      "{}",
    );
    const manifest = {
      schemaVersion: 3,
      repository: REPOSITORY,
      tag,
      sourceCommit,
      certifiedBuildRun: `${SOURCE}/actions/runs/123`,
      cliQualification: syntheticCliQualification(sourceCommit),
      dependencies: [
        {
          reference: "ghcr.io/frameleaf/frameleaf-cli:latest",
          digest: `sha256:${"2".repeat(64)}`,
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
    await createBundle(
      bundle,
      root,
      tag,
      manifest,
      new Map([
        [
          "ghcr.io/frameleaf/frameleaf-cli:latest",
          manifest.cliQualification.publication.digest,
        ],
      ]),
    );
    const sumsFile = path.join(bundle, "SHA256SUMS");
    const originalSums = await fs.readFile(sumsFile, "utf8");
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
    const cliFile = path.join(bundle, "cli-image.txt");
    const cliImage = await fs.readFile(cliFile, "utf8");
    assert.equal(
      cliImage,
      `ghcr.io/frameleaf/frameleaf-cli@${manifest.cliQualification.publication.digest}\n`,
    );
    await fs.writeFile(cliFile, "ghcr.io/frameleaf/frameleaf-cli:latest\n");
    await refreshSums();
    await assert.rejects(verifyBundle(bundle, tag), /CLI install image differs/);
    await fs.writeFile(cliFile, cliImage);
    await refreshSums();
    const manifestFile = path.join(bundle, "release-manifest.json");
    const originalManifest = await fs.readFile(manifestFile, "utf8");
    const changedManifest = JSON.parse(originalManifest);
    changedManifest.dependencies[0].digest = `sha256:${"f".repeat(64)}`;
    await fs.writeFile(manifestFile, JSON.stringify(changedManifest));
    await refreshSums();
    await assert.rejects(verifyBundle(bundle, tag), /CLI bundle dependency differs/);
    await fs.writeFile(manifestFile, originalManifest);
    await refreshSums();
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

    const missingCli = JSON.parse(originalManifest);
    delete missingCli.cliQualification;
    await fs.writeFile(manifestFile, JSON.stringify(missingCli));
    await refreshSums();
    await assert.rejects(verifyBundle(bundle, tag), /CLI qualification/);
    await fs.writeFile(manifestFile, originalManifest);
    await refreshSums();

    // Source-backed historical contract: the v2 producer had these install
    // files, no CLI asset/qualification, and the release-manifest/v2 predicate.
    // This is synthetic signature evidence, not a published release claim.
    const historical = path.join(root, "historical-v2");
    await fs.cp(bundle, historical, { recursive: true });
    const legacy = JSON.parse(originalManifest);
    legacy.schemaVersion = 2;
    delete legacy.cliQualification;
    delete legacy.assets["cli-image.txt"];
    await fs.rm(path.join(historical, "cli-image.txt"));
    const legacyNames = [
      ...INSTALL_FILES,
      "supported-versions.json",
      "nas-manifest.json",
      "release-manifest.json",
    ];
    const writeLegacy = async (value = legacy) => {
      await fs.writeFile(
        path.join(historical, "release-manifest.json"),
        JSON.stringify(value),
      );
      const sums = await Promise.all(
        legacyNames.map(async (name) =>
          `${hash(await fs.readFile(path.join(historical, name))).slice(7)}  ${name}`,
        ),
      );
      await fs.writeFile(
        path.join(historical, "SHA256SUMS"),
        sums.join("\n") + "\n",
      );
    };
    await writeLegacy();
    const trusted = {
      head_sha: sourceCommit,
      head_branch: "fork/main",
      head_repository: { full_name: REPOSITORY },
      event: "push",
      status: "completed",
      conclusion: "success",
      path: ".github/workflows/docker.yml",
    };
    const run = (command, args) => {
      assert.equal(
        command,
        "cosign",
        "Historical v2 must not claim CLI provenance",
      );
      if (args[0] === "verify") return "[]";
      assert.equal(args[4], LEGACY_ATTESTATION_TYPE);
      const [name, digest] = args.at(-1).split("@");
      return (
        JSON.stringify({
          payload: Buffer.from(
            JSON.stringify({
              predicateType: LEGACY_ATTESTATION_TYPE,
              predicate: legacy,
              subject: [{ name, digest: { sha256: digest.slice(7) } }],
            }),
          ).toString("base64"),
        }) + "\n"
      );
    };
    const options = {
      authenticate: true,
      run,
      request: (route) => {
        assert.equal(route, "actions/runs/123");
        return Promise.resolve(trusted);
      },
      registry: {
        read: () => {
          throw Error("Historical v2 has no CLI qualification");
        },
      },
    };
    const verifiedLegacy = await verifyBundle(historical, tag, options);
    assert.equal(verifiedLegacy.schemaVersion, 2);
    assert(!Object.hasOwn(verifiedLegacy, "cliQualification"));
    await assert.rejects(
      createBundle(path.join(root, "legacy-new-release"), root, tag, legacy),
      /New release bundles require the CLI-qualified v3 contract/,
    );
    await assert.rejects(
      fs.stat(path.join(root, "legacy-new-release")),
      { code: "ENOENT" },
    );
    await assert.rejects(
      verifyBundle(historical, tag, {
        ...options,
        run: () => {
          throw Error("Invalid historical signature");
        },
      }),
      /Invalid historical signature/,
    );
    await assert.rejects(
      verifyBundle(historical, tag, {
        ...options,
        run: (command, args) => {
          const result = run(command, args);
          if (args[0] === "verify") return result;
          const envelope = JSON.parse(result);
          const statement = JSON.parse(
            Buffer.from(envelope.payload, "base64").toString("utf8"),
          );
          statement.predicateType = ATTESTATION_TYPE;
          envelope.payload = Buffer.from(JSON.stringify(statement)).toString(
            "base64",
          );
          return JSON.stringify(envelope) + "\n";
        },
      }),
      /Signed attestation differs from expected evidence/,
    );
    await assert.rejects(
      verifyBundle(historical, tag, {
        ...options,
        request: () =>
          Promise.resolve({ ...trusted, head_sha: "b".repeat(40) }),
      }),
      /Build certification is not trusted/,
    );
    await writeLegacy({ ...legacy, dependencies: [] });
    await assert.rejects(
      verifyBundle(historical, tag, options),
      /Signed attestation differs from expected evidence/,
    );
    await writeLegacy();
    await fs.appendFile(
      path.join(historical, "docker-compose.yml"),
      "# changed\n",
    );
    await assert.rejects(
      verifyBundle(historical, tag, options),
      /checksum differs/,
    );
    await fs.copyFile(
      composeFile,
      path.join(historical, "docker-compose.yml"),
    );
    await writeLegacy({ ...legacy, cliQualification: manifest.cliQualification });
    await assert.rejects(
      verifyBundle(historical, tag, options),
      /Historical v2 cannot claim CLI qualification/,
    );
    await writeLegacy({
      ...legacy,
      assets: { ...legacy.assets, "cli-image.txt": hash(cliImage) },
    });
    await assert.rejects(
      verifyBundle(historical, tag, options),
      /Historical v2 cannot carry a CLI asset/,
    );
    await writeLegacy();
    await fs.writeFile(path.join(historical, "cli-image.txt"), cliImage);
    await assert.rejects(
      verifyBundle(historical, tag, options),
      /Historical v2 cannot carry a CLI asset/,
    );
    await fs.rm(path.join(historical, "cli-image.txt"));
    await writeLegacy({ ...legacy, schemaVersion: 4 });
    await assert.rejects(
      verifyBundle(historical, tag, options),
      /Unsupported release manifest version/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
