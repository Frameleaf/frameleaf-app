import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import {
  deriveClaimFileLuts,
  verifyClaimFileLuts,
} from "./render-worker-lut-inputs.mjs";
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const cube = Buffer.from(
  `LUT_3D_SIZE 2\nDOMAIN_MIN -1 2 10\nDOMAIN_MAX 1 4 14\n${Array.from({ length: 8 }, (_, i) => `${i & 1 ? 1 : -1} ${i & 2 ? 2 : -2} ${i & 4 ? 3 : -3}`).join("\n")}\n`,
);
const params = () => ({
  lutId: "grade",
  lutSource: "import",
  lutSize: "0",
  lutData: "",
  lutName: "",
  intensity: 0.5,
});
const specimen = () => {
  const graph = {
    id: "p",
    metadata: { width: 1280, height: 720, fps: 24 },
    timeline: {
      tracks: [],
      items: [
        {
          id: "a",
          type: "shape",
          effects: [
            {
              id: "fx",
              enabled: true,
              effect: {
                type: "gpu-effect",
                gpuEffectType: "gpu-lut",
                params: params(),
              },
            },
          ],
        },
      ],
      compositions: [],
    },
  };
  return {
    operationId: "op",
    claimToken: "claim",
    revisionId: "rev",
    artifactInputDigest: "a".repeat(64),
    snapshot: {
      studio: {
        graph,
        resources: [
          {
            key: "lut:grade",
            kind: "lut",
            id: "grade",
            graphPath: "/timeline/items/0/effects/0/effect/params",
            sourceAccess: "project",
            grant: "render",
            checksum: sha(cube),
          },
        ],
      },
    },
    inputs: new Map([
      [
        "lut:grade",
        {
          kind: "lut",
          resourceId: "grade",
          bytes: Buffer.from(cube),
          declaredChecksum: sha(cube),
          sha256: sha(cube),
        },
      ],
    ]),
  };
};
test("file LUT consumes exact authorized bytes, keeps original graph and binds version/domain/claim", async () => {
  const p = specimen(),
    before = structuredClone(p.snapshot.studio.graph);
  const derived = await deriveClaimFileLuts(p, () => true);
  assert.deepEqual(p.snapshot.studio.graph, before);
  const effect = derived.project.timeline.items[0].effects[0].effect;
  assert.equal(effect.gpuEffectType, "gpu-file-lut-v1");
  assert.equal(effect.params.intensity, 0.5);
  assert.equal(effect.params.fileLutDomainMin, "[-1,2,10]");
  assert.equal(derived.binding.resources[0].sha256, sha(cube));
  await verifyClaimFileLuts(p, derived, () => true);
  derived.project.timeline.items[0].effects[0].effect.params.intensity = 1;
  await assert.rejects(
    verifyClaimFileLuts(p, derived, () => true),
    /FILE_LUT_EXECUTION_CHANGED/,
  );
});
test("server-validated LF, CRLF and bare CR Cube bytes materialize identically", async () => {
  const expected = await deriveClaimFileLuts(specimen(), () => true);
  for (const ending of ["\n", "\r\n", "\r"]) {
    const p = specimen();
    const bytes = Buffer.from(cube.toString("utf8").replaceAll("\n", ending));
    const input = p.inputs.get("lut:grade");
    input.bytes = bytes;
    input.declaredChecksum = sha(bytes);
    input.sha256 = sha(bytes);
    p.snapshot.studio.resources[0].checksum = sha(bytes);
    const actual = await deriveClaimFileLuts(p, () => true);
    assert.deepEqual(actual.project, expected.project);
    assert.equal(actual.binding.resources[0].sha256, sha(bytes));
    await verifyClaimFileLuts(p, actual, () => true);
  }
});
test("all unused/off-range definitions materialize; arbitrary or divergent references do not", async () => {
  const p = specimen();
  p.snapshot.studio.graph.timeline.compositions.push({
    id: "unused",
    items: [structuredClone(p.snapshot.studio.graph.timeline.items[0])],
  });
  const derived = await deriveClaimFileLuts(p, () => true);
  assert.equal(
    derived.project.timeline.compositions[0].items[0].effects[0].effect
      .gpuEffectType,
    "gpu-file-lut-v1",
  );
  p.snapshot.studio.graph.metadata.lutId = "grade";
  await assert.rejects(
    deriveClaimFileLuts(p, () => true),
    /UNCONSUMED_FILE_LUT/,
  );
});
for (const [name, mutate, error] of [
  [
    "changed bytes",
    (p) => {
      p.inputs.get("lut:grade").bytes[0] ^= 1;
    },
    "VERIFIED_INPUT_CHANGED",
  ],
  [
    "forged signed checksum",
    (p) => {
      p.inputs.get("lut:grade").declaredChecksum = "0".repeat(64);
      p.snapshot.studio.resources[0].checksum = "0".repeat(64);
    },
    "INPUT_CHECKSUM_MISMATCH",
  ],
  [
    "revoked grant",
    (p) => {
      p.snapshot.studio.resources[0].grant = "none";
    },
    "FILE_LUT_GRANT_REQUIRED",
  ],
  [
    "wrong resource alias",
    (p) => {
      p.inputs.get("lut:grade").resourceId = "different";
    },
    "RESOURCE_IDENTITY_CHANGED",
  ],
  [
    "wrong source authority",
    (p) => {
      p.snapshot.studio.resources[0].sourceAccess = "deployment";
    },
    "FILE_LUT_SOURCE_CHANGED",
  ],
  [
    "wrong effect",
    (p) => {
      p.snapshot.studio.graph.timeline.items[0].effects[0].effect.gpuEffectType =
        "gpu-brightness";
    },
    "UNCONSUMED_FILE_LUT",
  ],
  [
    "divergent inline",
    (p) => {
      p.snapshot.studio.graph.timeline.items[0].effects[0].effect.params.lutData =
        "AA==";
    },
    "DIVERGENT_FILE_LUT",
  ],
  [
    "malformed bytes",
    (p) => {
      const b = Buffer.from("LUT_3D_SIZE 2\nNaN 0 0");
      Object.assign(p.inputs.get("lut:grade"), {
        bytes: b,
        sha256: sha(b),
        declaredChecksum: sha(b),
      });
      p.snapshot.studio.resources[0].checksum = sha(b);
    },
    "LUT",
  ],
])
  test(name, async () => {
    const p = specimen();
    mutate(p);
    await assert.rejects(
      deriveClaimFileLuts(p, () => true),
      new RegExp(error),
    );
  });
test("lease loss and claim/revision substitution are refused before consumption", async () => {
  const p = specimen();
  await assert.rejects(
    deriveClaimFileLuts(p, () => false),
    /LEASE_LOST/,
  );
  const derived = await deriveClaimFileLuts(p, () => true);
  p.revisionId = "other";
  await assert.rejects(
    verifyClaimFileLuts(p, derived, () => true),
    /FILE_LUT_EXECUTION_CHANGED/,
  );
});

test("authored intensity keyframes map only the consuming item/effect in its own composition", async () => {
  const p = specimen(),
    graph = p.snapshot.studio.graph;
  graph.timeline.keyframes = [
    {
      itemId: "a",
      properties: [
        {
          property: "effect:gpu-lut:fx:intensity",
          keyframes: [
            { frame: 0, value: 0 },
            { frame: 10, value: 1 },
          ],
        },
      ],
    },
    {
      itemId: "other",
      properties: [{ property: "effect:gpu-lut:fx:intensity", keyframes: [] }],
    },
  ];
  const derived = await deriveClaimFileLuts(p, () => true);
  assert.equal(
    derived.project.timeline.keyframes[0].properties[0].property,
    "effect:gpu-file-lut-v1:fx:intensity",
  );
  assert.equal(
    derived.project.timeline.keyframes[1].properties[0].property,
    "effect:gpu-lut:fx:intensity",
  );
  assert.equal(
    graph.timeline.keyframes[0].properties[0].property,
    "effect:gpu-lut:fx:intensity",
  );
});
test("aggregate float/encoded expansion refuses before allocating two full size65 occurrences", async () => {
  const p = specimen(),
    b = Buffer.from("LUT_3D_SIZE 65\n" + "0 0 0\n".repeat(65 ** 3));
  Object.assign(p.inputs.get("lut:grade"), {
    bytes: b,
    sha256: sha(b),
    declaredChecksum: sha(b),
  });
  p.snapshot.studio.resources[0].checksum = sha(b);
  p.snapshot.studio.graph.timeline.items.push(
    structuredClone(p.snapshot.studio.graph.timeline.items[0]),
  );
  await assert.rejects(
    deriveClaimFileLuts(p, () => true),
    /FILE_LUT_ALLOCATION_LIMIT/,
  );
});

test("actual claim adapter admits file resources separately from media and retains the revision", async () => {
  const { createClaimImageInputs } =
    await import("./render-worker-image-inputs.mjs");
  const p = specimen();
  p.snapshot.studio.graph.timeline.items[0].trackId = "v1";
  p.snapshot.studio.graph.timeline.tracks = [{ id: "v1", kind: "video" }];
  p.snapshot.studio.graph.timeline.items[0].from = 0;
  p.snapshot.studio.graph.timeline.items[0].durationInFrames = 24;
  let live = true;
  const adapter = await createClaimImageInputs(p, () => live);
  try {
    assert.deepEqual(adapter.input.project, p.snapshot.studio.graph);
    assert.equal(adapter.input.media.length, 0);
    assert.equal(adapter.fileLuts.binding.resources.length, 1);
    assert.equal(
      adapter.fileLuts.project.timeline.items[0].effects[0].effect
        .gpuEffectType,
      "gpu-file-lut-v1",
    );
    live = false;
    await assert.rejects(adapter.createHarness(), /LEASE_LOST/);
  } finally {
    await adapter.dispose();
  }
});

test("opaque server input digest is required and independently binds LUT execution", async () => {
  const p = specimen();
  const derived = await deriveClaimFileLuts(p, () => true);
  assert.equal(derived.binding.artifactInputDigest, p.artifactInputDigest);
  assert.ok(!Object.hasOwn(derived.binding.resources[0], "ownerId"));
  p.artifactInputDigest = "b".repeat(64);
  await assert.rejects(
    verifyClaimFileLuts(p, derived, () => true),
    /FILE_LUT_EXECUTION_CHANGED/,
  );
  for (const invalid of [undefined, "", "x".repeat(64), "a".repeat(63)]) {
    p.artifactInputDigest = invalid;
    await assert.rejects(
      deriveClaimFileLuts(p, () => true),
      /INPUT_DIGEST_REQUIRED/,
    );
  }
});
