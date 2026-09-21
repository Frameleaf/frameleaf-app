import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as sdk from "../build/index.js";

const response = (value) =>
  new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  });

test("every OpenAPI operation is exported by the generated JavaScript client", async () => {
  const spec = JSON.parse(
    await readFile(
      new URL("../../../open-api/immich-openapi-specs.json", import.meta.url),
    ),
  );
  for (const path of Object.values(spec.paths)) {
    for (const operation of Object.values(path)) {
      if (operation.operationId) {
        assert.equal(
          typeof sdk[operation.operationId],
          "function",
          operation.operationId,
        );
      }
    }
  }
});

test("edit transport preserves future actions and opaque nested parameters", async () => {
  const edit = {
    id: "edit-id",
    action: "future-action",
    parameters: {
      graph: {
        tracks: [null, { expression: "time * 2", enabled: false }],
        optional: null,
      },
    },
  };
  const previousResponse = { assetId: "asset-id", edits: [edit] };
  const received = await sdk.getAssetEdits(
    { id: "asset-id" },
    {
      fetch: async (url) => {
        assert.equal(url, "/api/assets/asset-id/edits");
        return response(previousResponse);
      },
    },
  );
  assert.deepEqual(received, previousResponse);
  await sdk.editAsset(
    { id: received.assetId, assetEditsCreateDto: { edits: received.edits } },
    {
      fetch: async (url, options) => {
        assert.equal(url, "/api/assets/asset-id/edits");
        assert.equal(options.method, "PUT");
        assert.deepEqual(JSON.parse(options.body), { edits: [edit] });
        return response(previousResponse);
      },
    },
  );
});

test("asset upload sends binary bytes as multipart rather than JSON", async () => {
  const bytes = new Uint8Array([0, 255, 128, 34, 10]);
  const file = new File([bytes], "fixture.bin", {
    type: "application/octet-stream",
  });
  const result = await sdk.uploadAsset(
    {
      assetMediaCreateDto: {
        assetData: file,
        deviceAssetId: "fixture",
        deviceId: "test-device",
        fileCreatedAt: "2026-01-01T00:00:00Z",
        fileModifiedAt: "2026-01-01T00:00:00Z",
      },
    },
    {
      fetch: async (_url, options) => {
        assert.equal(options.method, "POST");
        assert.ok(options.body instanceof FormData);
        const uploaded = options.body.get("assetData");
        assert.equal(uploaded.name, file.name);
        assert.deepEqual(new Uint8Array(await uploaded.arrayBuffer()), bytes);
        assert.equal(options.body.get("deviceAssetId"), "fixture");
        return response({ id: "asset-id", status: "created" });
      },
    },
  );
  assert.deepEqual(result, { id: "asset-id", status: "created" });
});
