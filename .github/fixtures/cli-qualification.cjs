// Synthetic receipts for source regression tests; these are not registry or hosted evidence.
function syntheticCliQualification(sha, digest = `sha256:${"2".repeat(64)}`) {
  return {
    runId: 17,
    attempt: 1,
    jobs: [
      { id: 101, name: "CLI container build (amd64)" },
      { id: 102, name: "CLI container build (arm64)" },
      { id: 103, name: "CLI Publish" },
    ],
    artifact: { id: 27, digest: `sha256:${"7".repeat(64)}` },
    publication: {
      image: "ghcr.io/frameleaf/frameleaf-cli",
      digest,
      sourceCommit: sha,
      runId: "17",
      architectures: ["amd64", "arm64"].map((architecture, index) => ({
        sourceCommit: sha,
        repository: "Frameleaf/frameleaf-app",
        runId: "17",
        runAttempt: "1",
        architecture,
        digest: `sha256:${String(index + 3).repeat(64)}`,
        configDigest: `sha256:${String(index + 5).repeat(64)}`,
        rootfsDiffIds: [`sha256:${"8".repeat(64)}`],
        archiveSha256: "9".repeat(64),
        smoke: "passed",
      })),
    },
  };
}
function syntheticCliRegistry(evidence) {
  const records = new Map();
  const put = (digest, json) => {
    const record = {
      digest,
      json,
      size: Buffer.byteLength(JSON.stringify(json)),
    };
    records.set(digest, record);
    return record;
  };
  const descriptors = evidence.publication.architectures.map((native) => {
    const config = put(native.configDigest, {
      os: "linux",
      architecture: native.architecture,
      config: {
        Labels: {
          "org.opencontainers.image.source":
            "https://github.com/Frameleaf/frameleaf-app",
          "org.opencontainers.image.revision": native.sourceCommit,
        },
      },
      rootfs: { diff_ids: native.rootfsDiffIds },
    });
    const child = put(native.digest, {
      schemaVersion: 2,
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      config: { digest: config.digest, size: config.size },
      layers: native.rootfsDiffIds.map(() => ({
        digest: `sha256:${"f".repeat(64)}`,
        size: 12,
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
      })),
    });
    return {
      digest: child.digest,
      size: child.size,
      mediaType: child.json.mediaType,
      platform: { os: "linux", architecture: native.architecture },
    };
  });
  put(evidence.publication.digest, {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    annotations: {
      "org.opencontainers.image.source":
        "https://github.com/Frameleaf/frameleaf-app",
      "org.opencontainers.image.revision": evidence.publication.sourceCommit,
    },
    manifests: descriptors,
  });
  return { read: (image, digest) => Promise.resolve(records.get(digest)) };
}

function syntheticCliProvenance(evidence) {
  const source = "https://github.com/Frameleaf/frameleaf-app";
  const identity = `${source}/.github/workflows/cli.yml@refs/heads/fork/main`;
  const sha = evidence.publication.sourceCommit;
  return [
    {
      verificationResult: {
        signature: {
          certificate: {
            subjectAlternativeName: { value: identity },
            issuer: "https://token.actions.githubusercontent.com",
            sourceRepositoryURI: source,
            sourceRepositoryDigest: sha,
            sourceRepositoryRef: "refs/heads/fork/main",
            buildSignerURI: identity,
            buildSignerDigest: sha,
            runnerEnvironment: "github-hosted",
            runInvocationURI: `${source}/actions/runs/${evidence.runId}/attempts/${evidence.attempt}`,
          },
        },
        statement: {
          predicateType: "https://slsa.dev/provenance/v1",
          subject: [
            {
              name: evidence.publication.image,
              digest: { sha256: evidence.publication.digest.slice(7) },
            },
          ],
        },
      },
    },
  ];
}

module.exports = {
  syntheticCliQualification,
  syntheticCliRegistry,
  syntheticCliProvenance,
};
