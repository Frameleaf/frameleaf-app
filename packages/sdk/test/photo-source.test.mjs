import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  publishPhotoSourceReference,
  PhotoSourceReferenceAssetType,
} from "../build/index.js";
const spec = JSON.parse(
  readFileSync(
    new URL("../../../open-api/immich-openapi-specs.json", import.meta.url),
  ),
);
const client = readFileSync(
  new URL("../src/fetch-client.ts", import.meta.url),
  "utf8",
);
test("photo source schemas use named enums without renumbering existing client exports", () => {
  for (const [name, values] of Object.entries({
    PhotoSourceKind: ["folder"],
    ApplePhotosSourceKind: ["apple-photos"],
    PhotoSourceCopyMode: ["copy", "reference"],
    PhotoSourceRunState: ["open", "paused", "cancelled", "complete"],
    PhotoSourceItemState: ["planned", "verified"],
    PhotoSourceStorage: ["managed"],
  })) {
    assert.deepEqual(spec.components.schemas[name]?.enum, values);
    assert.match(client, new RegExp(`export enum ${name} \\{`));
  }
  assert.match(
    client,
    /export enum Mode2 \{\s+EditedDelivery = "edited-delivery"/,
  );
  assert.match(client, /ApplePhotos = "apple-photos"/);
  assert.match(client, /export enum Kind9 \{\s+Print = "print"/);
  assert.deepEqual(
    spec.components.schemas.PhotoSourceCreateDto.properties.mode,
    { $ref: "#/components/schemas/PhotoSourceCopyMode" },
  );
  for (const [kind, dtos] of [
    ["PhotoSourceKind", ["PhotoSourceCreateDto", "PhotoSourceResponseDto"]],
    [
      "ApplePhotosSourceKind",
      ["ApplePhotosSourceCreateDto", "ApplePhotosSourceResponseDto"],
    ],
  ]) {
    for (const dto of dtos) {
      assert.deepEqual(spec.components.schemas[dto].properties.kind, {
        $ref: `#/components/schemas/${kind}`,
      });
    }
  }
  assert.equal(
    spec.paths["/photo-sources"].post.operationId,
    "createPhotoSource",
  );
  assert.equal(
    spec.paths["/photo-sources/apple-photos"].post.operationId,
    "createApplePhotosSource",
  );
});

test("reference publication transports only metadata and keeps session credentials in headers", async () => {
  const sourceId = "11111111-1111-4111-8111-111111111111";
  const runId = "22222222-2222-4222-8222-222222222222";
  const itemId = "33333333-3333-4333-8333-333333333333";
  const body = {
    assetId: "44444444-4444-4444-8444-444444444444",
    type: PhotoSourceReferenceAssetType.Image,
    previous: {
      resourceId: sourceId,
      version: "c".repeat(64),
      sha256: "d".repeat(64),
    },
    originalFileName: "original.jpg",
    fileCreatedAt: "2026-10-01T00:00:00.000Z",
    fileModifiedAt: "2026-10-02T00:00:00.000Z",
  };
  const receipt = {
    sourceId,
    runId,
    itemId,
    assetId: body.assetId,
    ownerId: sourceId,
    serverId: "synthetic-server",
    resourceId: itemId,
    version: "a".repeat(64),
    sha256: "b".repeat(64),
    bytes: 5,
    publishedAt: "2026-10-03T00:00:00.000Z",
    storage: "reference",
  };
  const result = await publishPhotoSourceReference(
    { id: sourceId, runId, itemId, photoSourceReferenceDto: body },
    {
      headers: { Authorization: "Bearer synthetic-photo-session" },
      fetch: async (url, options) => {
        assert.equal(
          url,
          `/api/photo-sources/${sourceId}/runs/${runId}/items/${itemId}/reference`,
        );
        assert.equal(options.method, "POST");
        assert.equal(
          new Headers(options.headers).get("authorization"),
          "Bearer synthetic-photo-session",
        );
        assert.deepEqual(JSON.parse(options.body), body);
        assert.ok(!options.body.includes("synthetic-photo-session"));
        return new Response(JSON.stringify(receipt), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.deepEqual(result, receipt);
});

test("reference replacement keeps the prior-resource fence optional and strict in the API", () => {
  const dto = spec.components.schemas.PhotoSourceReferenceDto;
  assert.ok(!dto.required.includes("previous"));
  assert.deepEqual(dto.properties.previous.required.toSorted(), [
    "resourceId",
    "sha256",
    "version",
  ]);
  assert.equal(dto.properties.previous.additionalProperties, false);
  assert.equal(dto.properties.previous.properties.resourceId.format, "uuid");
  assert.equal(
    dto.properties.previous.properties.version.pattern,
    "^[a-f0-9]{64}$",
  );
  assert.equal(
    dto.properties.previous.properties.sha256.pattern,
    "^[a-f0-9]{64}$",
  );
});
