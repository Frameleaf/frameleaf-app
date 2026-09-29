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

test("edit transport preserves future fields, nulls and omitted optional parameters", async () => {
  const edit = {
    id: "edit-id",
    action: "future-action",
    futureMetadata: { version: 2 },
    futureNullable: null,
    parameters: {
      graph: {
        tracks: [null, { expression: "time * 2", enabled: false }],
        optional: null,
      },
    },
  };
  const speedEdit = {
    id: "speed-edit-id",
    action: "speed",
    parameters: { rate: 2 },
  };
  const previousResponse = {
    assetId: "asset-id",
    edits: [edit, speedEdit],
    futureMetadata: { version: 2 },
    futureNullable: null,
  };
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
  assert.equal(Object.hasOwn(received.edits[1].parameters, "startMs"), false);
  assert.equal(Object.hasOwn(received.edits[1].parameters, "endMs"), false);
  const updated = await sdk.editAsset(
    { id: received.assetId, assetEditsCreateDto: { edits: received.edits } },
    {
      fetch: async (url, options) => {
        assert.equal(url, "/api/assets/asset-id/edits");
        assert.equal(options.method, "PUT");
        const sent = JSON.parse(options.body);
        assert.deepEqual(sent, { edits: [edit, speedEdit] });
        assert.equal(Object.hasOwn(sent.edits[1].parameters, "startMs"), false);
        assert.equal(Object.hasOwn(sent.edits[1].parameters, "endMs"), false);
        return response(previousResponse);
      },
    },
  );
  assert.deepEqual(updated, previousResponse);
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

test("Takeout chunks preserve raw bytes and resumable offsets through Fetch", async () => {
  const bytes = new Uint8Array([0, 255, 128, 34, 10]);
  const body = new Blob([bytes]);
  const signal = new AbortController().signal;
  for (const offset of [0, 2 ** 32 + 1]) {
    const source = { id: "archive-id", uploadedBytes: offset + bytes.length };
    const result = await sdk.uploadTakeoutArchiveChunk(
      { id: "import-id", archiveId: "archive-id", offset, body },
      {
        headers: { "X-Upload-Test": "retained" },
        signal,
        fetch: async (url, options) => {
          assert.equal(
            url,
            `/api/takeout/import-id/archives/archive-id/chunks?offset=${offset}`,
          );
          assert.equal(options.signal, signal);
          const request = new Request(`https://photos.example.com${url}`, options);
          assert.equal(request.method, "PUT");
          assert.equal(request.headers.get("content-type"), "application/octet-stream");
          assert.equal(request.headers.get("x-upload-test"), "retained");
          assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes);
          return response(source);
        },
      },
    );
    assert.deepEqual(result, source);
  }
});

test("Takeout content-type defaults retain global and per-request header precedence", async () => {
  const previousHeaders = sdk.defaults.headers;
  sdk.defaults.headers = {
    "Content-Type": "application/octet-stream; global=1",
    "X-Global": "retained",
  };
  try {
    for (const headers of [
      undefined,
      { "content-type": "application/octet-stream; request=1" },
      [["Content-Type", "application/octet-stream; request=1"]],
      new Headers({ "content-type": "application/octet-stream; request=1" }),
    ]) {
      await sdk.uploadTakeoutArchiveChunk(
        { id: "import-id", archiveId: "archive-id", offset: 0, body: new Blob(["part"]) },
        {
          headers,
          fetch: async (url, options) => {
            const request = new Request(`https://photos.example.com${url}`, options);
            assert.equal(
              request.headers.get("content-type"),
              headers ? "application/octet-stream; request=1" : "application/octet-stream; global=1",
            );
            assert.equal(request.headers.get("x-global"), "retained");
            return response({ id: "archive-id", uploadedBytes: 4 });
          },
        },
      );
    }
    assert.deepEqual(sdk.defaults.headers, {
      "Content-Type": "application/octet-stream; global=1",
      "X-Global": "retained",
    });
  } finally {
    sdk.defaults.headers = previousHeaders;
  }
});

test("Takeout offset conflicts retain the server response for resume recovery", async () => {
  const conflict = { message: "The archive upload offset has changed" };
  await assert.rejects(
    sdk.uploadTakeoutArchiveChunk(
      { id: "import-id", archiveId: "archive-id", offset: 5, body: new Blob(["part"]) },
      {
        headers: { "Content-Type": "application/octet-stream" },
        fetch: async () => new Response(JSON.stringify(conflict), {
          status: 409,
          headers: { "content-type": "application/json" },
        }),
      },
    ),
    (error) => {
      assert.equal(error.status, 409);
      assert.deepEqual(error.data, conflict);
      return true;
    },
  );
});
