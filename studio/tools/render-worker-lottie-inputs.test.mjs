import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import test from "node:test";
import { deriveClaimVectors } from "./render-worker-lottie-inputs.mjs";
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const { tsImport } = require("tsx/esm/api");
const { ownedLottieArchive } = await tsImport(
  new URL("../../server/test/fixtures/studio-lottie.ts", import.meta.url).href,
  { parentURL: import.meta.url, tsconfig: false },
);
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const id = "11111111-1111-4111-8111-111111111111";
const specimen = (version) => {
  const bytes = ownedLottieArchive(version);
  const resource = {
    key: `vector-graphic:${id}`,
    kind: "vector-graphic",
    id,
    checksum: sha(bytes),
  };
  const first = {
    type: "lottie",
    mediaId: id,
    animationId: "first",
    sourceWidth: 64,
    sourceHeight: 32,
    frameRate: 24,
    totalFrames: 48,
  };
  const second = {
    type: "lottie",
    mediaId: id,
    animationId: "selected",
    sourceWidth: 32,
    sourceHeight: 64,
    frameRate: 30,
    totalFrames: 90,
  };
  return {
    operationId: "owned-operation",
    claimToken: "owned-claim",
    revisionId: "owned-revision",
    artifactInputDigest: "a".repeat(64),
    snapshot: {
      studio: {
        graph: {
          metadata: { fps: 24, retained: "unchanged" },
          history: ["original"],
          timeline: {
            items: [first],
            compositions: [{ id: "unused", items: [second] }],
          },
        },
        resources: [resource],
      },
    },
    inputs: new Map([
      [
        resource.key,
        {
          kind: resource.kind,
          resourceId: id,
          declaredChecksum: resource.checksum,
          sha256: resource.checksum,
          bytes,
        },
      ],
    ]),
  };
};

for (const version of ["1", "2"]) {
  test(`v${version} independently validates different root/composition uses before immutable archive deduplication`, async () => {
    const prepared = specimen(version),
      before = JSON.stringify(prepared.snapshot),
      original = Buffer.from(prepared.inputs.values().next().value.bytes);
    const output = await deriveClaimVectors(prepared, () => true);
    try {
      assert.equal(output.sources.length, 1);
      assert.equal(
        output.sources[0].metadata.mimeType,
        "application/lottie+json",
      );
      assert.equal(output.sources[0].metadata.fileName, "animation.lottie");
      assert.equal(output.sources[0].parentSha256, sha(original));
      assert.equal(JSON.stringify(prepared.snapshot), before);
      assert.deepEqual(prepared.inputs.values().next().value.bytes, original);
      assert.deepEqual(output.resources, [`vector-graphic:${id}`]);
    } finally {
      for (const source of output.sources) source.bytes.fill(0);
    }
  });
  test(`v${version} refuses unknown selection and changed second-use dimensions/timing without first-use fallback`, async () => {
    for (const [key, value] of [
      ["animationId", "unknown"],
      ["sourceWidth", 999],
      ["sourceHeight", 999],
      ["frameRate", 999],
      ["totalFrames", 999],
    ]) {
      const prepared = specimen(version);
      prepared.snapshot.studio.graph.timeline.compositions[0].items[0][key] =
        value;
      const before = JSON.stringify(prepared.snapshot);
      await assert.rejects(deriveClaimVectors(prepared, () => true));
      assert.equal(JSON.stringify(prepared.snapshot), before);
    }
  });
}
