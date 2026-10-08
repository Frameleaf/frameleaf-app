// The immutable revision is authority; this private execution copy is always recomputed.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { timelineViews } from "./render-worker-video-inputs.mjs";
const require = createRequire(
  new URL("../engine/package.json", import.meta.url),
);
const { tsImport } = require("tsx/esm/api");
const sha = (value) => createHash("sha256").update(value).digest("hex");
const GRAPH_LIMIT = 8 * 1024 * 1024;
const TABLE_LIMIT = 8 * 1024 * 1024;

export async function deriveClaimFileLuts(prepared, isLeaseActive) {
  assert.ok(isLeaseActive(), "LEASE_LOST");
  assert.ok(
    prepared.operationId && prepared.claimToken && prepared.revisionId,
    "CLAIM_BINDING_REQUIRED",
  );
  assert.ok(
    typeof prepared.artifactInputDigest === "string" &&
      /^[a-f0-9]{64}$/.test(prepared.artifactInputDigest),
    "INPUT_DIGEST_REQUIRED",
  );
  const original = prepared.snapshot.studio.graph;
  const serialized = JSON.stringify(original);
  assert.ok(
    Buffer.byteLength(serialized) <= GRAPH_LIMIT,
    "GRAPH_RESOURCE_LIMIT",
  );
  const project = structuredClone(original);
  const consumers = [];
  const allowedParams = new Set();
  const views = timelineViews(project);
  for (let v = 0; v < views.length; v++) {
    const base = v === 0 ? "/timeline" : `/timeline/compositions/${v - 1}`;
    for (const [i, item] of views[v].items.entries()) {
      for (const [j, wrapper] of (item.effects ?? []).entries()) {
        const effect = wrapper.effect;
        if (
          effect?.type !== "gpu-effect" ||
          effect.gpuEffectType !== "gpu-lut" ||
          !Object.hasOwn(effect.params ?? {}, "lutId")
        )
          continue;
        const p = effect.params;
        assert.ok(
          typeof p.lutId === "string" &&
            p.lutId.length > 0 &&
            ["catalog", "import"].includes(p.lutSource),
          "INVALID_FILE_LUT_REFERENCE",
        );
        assert.ok(
          p.lutSize === "0" && p.lutData === "" && p.lutName === "",
          "DIVERGENT_FILE_LUT",
        );
        assert.ok(
          p.intensity === undefined ||
            (typeof p.intensity === "number" &&
              Number.isFinite(p.intensity) &&
              p.intensity >= 0 &&
              p.intensity <= 1),
          "INVALID_FILE_LUT_INTENSITY",
        );
        allowedParams.add(p);
        consumers.push({
          effect,
          params: p,
          view: v,
          itemId: item.id,
          effectId: wrapper.id,
          key: `lut:${p.lutId}`,
          source: p.lutSource,
          path: `${base}/items/${i}/effects/${j}/effect/params`,
        });
      }
    }
  }
  // Generic resource discovery must not admit an arbitrary LUT-shaped object as an effect.
  const pending = [project];
  while (pending.length) {
    const node = pending.pop();
    if (!node || typeof node !== "object") continue;
    assert.ok(
      node.gpuEffectType !== "gpu-file-lut-v1",
      "PRIVATE_FILE_LUT_IN_REVISION",
    );
    if (Object.hasOwn(node, "lutId"))
      assert.ok(allowedParams.has(node), "UNCONSUMED_FILE_LUT");
    assert.ok(node.$resource?.kind !== "lut", "UNCONSUMED_FILE_LUT");
    pending.push(...Object.values(node));
  }
  const entries = prepared.snapshot.studio.resources.filter(
    (entry) => entry.kind === "lut",
  );
  const keys = new Set(consumers.map((consumer) => consumer.key));
  assert.equal(entries.length, keys.size, "UNCONSUMED_FILE_LUT");
  const resources = [];
  let allocated = 0;
  let expansion = Buffer.byteLength(serialized);
  let modules;
  for (const key of keys) {
    assert.ok(isLeaseActive(), "LEASE_LOST");
    const uses = consumers.filter((consumer) => consumer.key === key);
    const entry = entries.find((value) => value.key === key);
    assert.ok(entry?.grant === "render", "FILE_LUT_GRANT_REQUIRED");
    assert.ok(
      entry.id === uses[0].params.lutId &&
        entry.key === `lut:${entry.id}` &&
        uses.some((use) => use.path === entry.graphPath),
      "RESOURCE_IDENTITY_CHANGED",
    );
    assert.ok(
      uses.every((use) => use.source === uses[0].source) &&
        entry.sourceAccess ===
          (uses[0].source === "import" ? "project" : "deployment"),
      "FILE_LUT_SOURCE_CHANGED",
    );
    const input = prepared.inputs.get(key);
    assert.ok(
      input?.kind === "lut" &&
        input.resourceId === entry.id &&
        Buffer.isBuffer(input.bytes),
      "RESOURCE_IDENTITY_CHANGED",
    );
    assert.equal(
      input.declaredChecksum,
      entry.checksum,
      "RESOURCE_CHECKSUM_CHANGED",
    );
    assert.equal(sha(input.bytes), input.sha256, "VERIFIED_INPUT_CHANGED");
    assert.ok(input.bytes.length <= 16 * 1024 * 1024, "FILE_LUT_BYTE_LIMIT");
    const hex = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(input.declaredChecksum);
    const checksum = Buffer.from(
      input.declaredChecksum,
      hex ? "hex" : "base64",
    );
    assert.ok(
      [20, 32].includes(checksum.length) &&
        (hex || checksum.toString("base64") === input.declaredChecksum),
      "INVALID_INPUT_CHECKSUM",
    );
    assert.ok(
      createHash(checksum.length === 20 ? "sha1" : "sha256")
        .update(input.bytes)
        .digest()
        .equals(checksum),
      "INPUT_CHECKSUM_MISMATCH",
    );
    if (!modules)
      modules = await Promise.all([
        tsImport(
          new URL("../../server/src/utils/studio-imports.ts", import.meta.url)
            .pathname,
          { parentURL: import.meta.url, tsconfig: false },
        ),
        tsImport(
          new URL(
            "../engine/src/infrastructure/gpu-effects/lut/file-lut.ts",
            import.meta.url,
          ).pathname,
          { parentURL: import.meta.url, tsconfig: false },
        ),
      ]);
    assert.ok(isLeaseActive(), "LEASE_LOST");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(input.bytes);
    const descriptor = modules[0].validateStudioCubeLut(text);
    const bytes = descriptor.size ** 3 * 16;
    allocated += bytes * uses.length;
    expansion += uses.length * (4 * Math.ceil(bytes / 3) + 512);
    assert.ok(
      allocated <= TABLE_LIMIT && expansion <= GRAPH_LIMIT,
      "FILE_LUT_ALLOCATION_LIMIT",
    );
    const materialized = modules[1].materializeCubeFileLut(text, descriptor);
    const materializationSha256 = sha(JSON.stringify(materialized));
    for (const use of uses) {
      use.effect.gpuEffectType = "gpu-file-lut-v1";
      use.effect.params = {
        ...materialized,
        intensity: use.params.intensity ?? 1,
      };
      const container =
        use.view === 0
          ? project.timeline
          : project.timeline.compositions[use.view - 1];
      for (const itemKeys of container.keyframes ?? []) {
        if (itemKeys.itemId !== use.itemId) continue;
        for (const property of itemKeys.properties ?? [])
          if (property.property === `effect:gpu-lut:${use.effectId}:intensity`)
            property.property = `effect:gpu-file-lut-v1:${use.effectId}:intensity`;
      }
    }
    resources.push({
      key,
      id: entry.id,
      sourceAccess: entry.sourceAccess,
      checksum: entry.checksum,
      source: uses[0].source,
      paths: uses.map((use) => use.path),
      sha256: input.sha256,
      materializationSha256,
    });
    assert.ok(isLeaseActive(), "LEASE_LOST");
  }
  // No authorized LUT bytes may survive without an exact consuming effect.
  for (const [key, input] of prepared.inputs)
    if (input.kind === "lut") assert.ok(keys.has(key), "UNCONSUMED_FILE_LUT");
  const execution = JSON.stringify(project);
  assert.ok(
    Buffer.byteLength(execution) <= GRAPH_LIMIT,
    "GRAPH_RESOURCE_LIMIT",
  );
  assert.ok(isLeaseActive(), "LEASE_LOST");
  return {
    project,
    binding: {
      version: 1,
      operationId: prepared.operationId,
      claimToken: prepared.claimToken,
      revisionId: prepared.revisionId,
      artifactInputDigest: prepared.artifactInputDigest,
      originalSha256: sha(serialized),
      executionSha256: sha(execution),
      resources,
    },
  };
}

export async function verifyClaimFileLuts(prepared, derived, isLeaseActive) {
  const recomputed = await deriveClaimFileLuts(prepared, isLeaseActive);
  assert.deepEqual(derived, recomputed, "FILE_LUT_EXECUTION_CHANGED");
  return recomputed.project;
}
