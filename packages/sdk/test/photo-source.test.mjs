import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
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
    PhotoSourceCopyMode: ["copy"],
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
