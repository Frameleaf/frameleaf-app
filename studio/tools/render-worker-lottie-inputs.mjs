// Recomputed from the immutable claim, never from an uploaded execution table.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { timelineViews } from "./render-worker-video-inputs.mjs";
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const { tsImport } = require("tsx/esm/api");
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function deriveClaimVectors(
  prepared,
  isLeaseActive,
  waitForLease,
) {
  if (waitForLease) await waitForLease();
  assert.ok(isLeaseActive(), "LEASE_LOST");
  const original = prepared.snapshot?.studio?.graph;
  const items = timelineViews(original)
    .flatMap((view) => view.items)
    .filter((item) => item.type === "lottie");
  if (!items.length) return { sources: [], resources: [], digest: null };
  assert.ok(
    prepared.operationId && prepared.claimToken && prepared.revisionId,
    "CLAIM_BINDING_REQUIRED",
  );
  assert.match(
    prepared.artifactInputDigest ?? "",
    /^[a-f0-9]{64}$/,
    "INPUT_DIGEST_REQUIRED",
  );
  const {
    classifyStudioLottieParent,
    readStudioVectorBindings,
    materializeStudioLottieSource,
    selectStudioLottieDocument,
    validateStudioLottieItem,
    validateStudioVectorClosure,
  } = await tsImport(
    new URL(
      "../../server/src/utils/studio-lottie-source.ts",
      import.meta.url,
    ).href,
    { parentURL: import.meta.url, tsconfig: false },
  );
  if (waitForLease) await waitForLease();
  const entries = prepared.snapshot.studio.resources;
  const bindings = readStudioVectorBindings(original);
  const resourceKeys = new Set();
  const read = async (entry, maximum = 16 * 1024 * 1024) => {
    if (waitForLease) await waitForLease();
    assert.ok(isLeaseActive(), "LEASE_LOST");
    const input = prepared.inputs.get(entry.key);
    assert.ok(
      input?.kind === entry.kind &&
        input.resourceId === entry.id &&
        Buffer.isBuffer(input.bytes),
      "AUTHORIZED_VECTOR_INPUT_REQUIRED",
    );
    assert.equal(
      input.declaredChecksum,
      entry.checksum,
      "RESOURCE_CHECKSUM_CHANGED",
    );
    assert.ok(
      input.bytes.length <= maximum,
      "VECTOR_EXECUTION_ALLOCATION_LIMIT",
    );
    assert.equal(sha(input.bytes), input.sha256, "VERIFIED_INPUT_CHANGED");
    resourceKeys.add(entry.key);
    return input.bytes;
  };
  await validateStudioVectorClosure(original, entries, read);
  if (waitForLease) await waitForLease();
  const sources = [];
  const byId = new Map();
  let allocated = 0;
  try {
    for (const item of items) {
      assert.ok(
        typeof item.mediaId === "string" && !item.src,
        "VECTOR_RESOURCE_ID_REQUIRED",
      );
      // The claim resolver has already selected the resource namespace. There is no local import/library lookup fallback.
      const roots = entries.filter(
        (entry) =>
          entry.id === item.mediaId &&
          ["project-import", "vector-graphic"].includes(entry.kind),
      );
      assert.ok(
        roots.length > 0 &&
          roots.every((entry) => entry.checksum === roots[0].checksum),
        "AUTHORIZED_VECTOR_PARENT_REQUIRED",
      );
      const declaredRoots = roots.filter((root) =>
        bindings.some(
          (binding) =>
            `${binding.parent.kind}:${binding.parent.id}` === root.key,
        ),
      );
      assert.ok(declaredRoots.length <= 1, "AMBIGUOUS_VECTOR_PARENT");
      const root = declaredRoots[0] ?? roots[0];
      const input = prepared.inputs.get(root.key);
      const bytes = await read(root);
      if (waitForLease) await waitForLease();
      for (const otherRoot of roots.filter((other) => other !== root)) {
        const otherBytes = await read(otherRoot);
        if (waitForLease) await waitForLease();
        assert.deepEqual(otherBytes, bytes, "AMBIGUOUS_VECTOR_PARENT");
      }
      const type = classifyStudioLottieParent(bytes);
      const parsed = await materializeStudioLottieSource(
        original,
        root,
        bytes,
        type.contentType,
        entries,
        read,
      );
      const document = selectStudioLottieDocument(parsed, item.animationId);
      if (item.themeId)
        assert.ok(
          parsed.archive?.themes.has(item.themeId),
          "VECTOR_THEME_UNAVAILABLE",
        );
      for (const key of ["w", "h", "fr", "op"])
        assert.ok(
          Number.isFinite(document[key]) && document[key] > 0,
          "VECTOR_METADATA_REFUSED",
        );
      assert.ok(
        Number.isFinite(document.ip) &&
          document.ip >= 0 &&
          document.op > document.ip,
        "VECTOR_METADATA_REFUSED",
      );
      assert.ok(
        Number.isSafeInteger(document.op - document.ip),
        "VECTOR_SOURCE_TIMING_UNAVAILABLE",
      );
      assert.equal(item.frameRate, document.fr, "VECTOR_SOURCE_TIMING_CHANGED");
      assert.equal(
        item.totalFrames,
        document.op - document.ip,
        "VECTOR_SOURCE_TIMING_CHANGED",
      );
      assert.ok(
        Number.isSafeInteger(document.w) &&
          Number.isSafeInteger(document.h) &&
          document.w * document.h <= 64_000_000,
        "VECTOR_PIXEL_LIMIT",
      );
      assert.equal(
        item.sourceWidth,
        document.w,
        "VECTOR_SOURCE_DIMENSIONS_CHANGED",
      );
      assert.equal(
        item.sourceHeight,
        document.h,
        "VECTOR_SOURCE_DIMENSIONS_CHANGED",
      );
      // Every root/composition use is validated above before deduplicating the immutable container.
      validateStudioLottieItem(parsed, item);
      if (byId.has(item.mediaId)) continue;
      let materialized;
      if (parsed.archive) {
        const { zipSync } = require("fflate");
        materialized = Buffer.from(zipSync(parsed.archive.files, { level: 0 }));
      } else materialized = Buffer.from(JSON.stringify(document));
      allocated += materialized.length;
      assert.ok(
        allocated <= 16 * 1024 * 1024,
        "VECTOR_EXECUTION_ALLOCATION_LIMIT",
      );
      const source = {
        id: item.mediaId,
        totalFrames: document.op - document.ip,
        bytes: materialized,
        sha256: sha(materialized),
        parentSha256: input.sha256,
        metadata: {
          id: item.mediaId,
          storageType: "workspace",
          fileName: parsed.archive ? "animation.lottie" : "animation.json",
          fileSize: materialized.length,
          mimeType: "application/lottie+json",
          width: document.w,
          height: document.h,
          fps: document.fr,
          duration: (document.op - document.ip) / document.fr,
          codec: "lottie",
          bitrate: 0,
        },
      };
      sources.push(source);
      byId.set(item.mediaId, source);
    }
    if (waitForLease) await waitForLease();
    assert.ok(isLeaseActive(), "LEASE_LOST");
    const resources = [...resourceKeys].sort();
    const digest = sha(
      JSON.stringify({
        version: 1,
        operationId: prepared.operationId,
        claimToken: prepared.claimToken,
        revisionId: prepared.revisionId,
        artifactInputDigest: prepared.artifactInputDigest,
        graphSha256: sha(JSON.stringify(original)),
        bindings,
        resources,
        sources: sources.map((source) => ({
          id: source.id,
          parentSha256: source.parentSha256,
          sha256: source.sha256,
        })),
      }),
    );
    return { sources, resources, digest };
  } catch (error) {
    for (const source of sources) source.bytes.fill(0);
    throw error;
  }
}
