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
    readStudioVectorBindings,
    parseStudioLottieDependencies,
    validateStudioVectorClosure,
  } = await tsImport(
    new URL(
      "../../server/src/utils/studio-vector-dependencies.ts",
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
      if (byId.has(item.mediaId)) {
        const known = byId.get(item.mediaId);
        assert.equal(
          item.frameRate,
          known.metadata.fps,
          "VECTOR_SOURCE_TIMING_CHANGED",
        );
        assert.equal(
          item.totalFrames,
          known.totalFrames,
          "VECTOR_SOURCE_TIMING_CHANGED",
        );
        assert.equal(
          item.sourceWidth,
          known.metadata.width,
          "VECTOR_SOURCE_DIMENSIONS_CHANGED",
        );
        assert.equal(
          item.sourceHeight,
          known.metadata.height,
          "VECTOR_SOURCE_DIMENSIONS_CHANGED",
        );
        continue;
      }
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
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      const parsed = parseStudioLottieDependencies(text);
      const parentBindings = bindings.filter(
        (binding) => `${binding.parent.kind}:${binding.parent.id}` === root.key,
      );
      assert.equal(
        parsed.dependencies.length,
        parentBindings.length,
        "INCOMPLETE_VECTOR_DEPENDENCIES",
      );
      // Upper-bound the JSON-safe data URLs before allocating any base64 strings.
      let expanded = Buffer.byteLength(JSON.stringify(parsed.document));
      for (const binding of parentBindings) {
        const entry = entries.find(
          (entry) => entry.key === `${binding.child.kind}:${binding.child.id}`,
        );
        assert.ok(entry, "AUTHORIZED_VECTOR_CHILD_REQUIRED");
        const child = await read(entry);
        if (waitForLease) await waitForLease();
        expanded += 4 * Math.ceil(child.length / 3) + 128;
        assert.ok(
          allocated + expanded <= 16 * 1024 * 1024,
          "VECTOR_EXECUTION_ALLOCATION_LIMIT",
        );
      }
      for (const binding of parentBindings) {
        const entry = entries.find(
          (entry) => entry.key === `${binding.child.kind}:${binding.child.id}`,
        );
        assert.ok(entry, "AUTHORIZED_VECTOR_CHILD_REQUIRED");
        const child = await read(entry);
        if (waitForLease) await waitForLease();
        const parts = binding.location.pointer.split("/").slice(1);
        let container = parsed.document;
        for (const part of parts.slice(0, -1)) container = container[part];
        assert.ok(
          container && typeof container === "object",
          "VECTOR_LOCATION_CHANGED",
        );
        if (binding.location.role === "image") {
          const { sniffStudioImport } = await tsImport(
            new URL("../../server/src/utils/studio-imports.ts", import.meta.url)
              .href,
            { parentURL: import.meta.url, tsconfig: false },
          );
          if (waitForLease) await waitForLease();
          const type = sniffStudioImport(child.subarray(0, 1024));
          assert.equal(type.kind, "image", "VECTOR_IMAGE_MIME_REFUSED");
          container.p = `data:${type.contentType};base64,${child.toString("base64")}`;
          container.u = "";
          container.e = 1;
        } else {
          const magic = child.toString("ascii", 0, 4);
          const mime =
            magic === "wOF2"
              ? "font/woff2"
              : magic === "wOFF"
                ? "font/woff"
                : magic === "OTTO"
                  ? "font/otf"
                  : child.length >= 4 && child.readUInt32BE(0) === 0x00010000
                    ? "font/ttf"
                    : null;
          assert.ok(mime, "VECTOR_FONT_MIME_REFUSED");
          container.fPath = `data:${mime};base64,${child.toString("base64")}`;
        }
      }
      const document = parsed.document;
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
      const materialized = Buffer.from(JSON.stringify(document));
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
          fileName: "animation.json",
          fileSize: materialized.length,
          mimeType: "application/json",
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
