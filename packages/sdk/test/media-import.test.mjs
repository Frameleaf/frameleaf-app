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

test("media contracts name new enums and keep retained credentials and replay URLs private", () => {
  for (const name of [
    "MediaHistoryMode",
    "MediaItemKind",
    "MediaImportItemState",
    "MediaImportState",
    "MediaInspectionKind",
    "MediaAuthenticationMethod",
    "MediaConnectionStatus",
    "MediaSubscriptionAction",
    "MediaSubscriptionState",
    "MediaProtocolVersion",
    "MediaIndividualSupport",
    "MediaFeedSupport",
  ]) {
    assert.ok(spec.components.schemas[name]?.enum, name);
    assert.match(client, new RegExp(`export enum ${name} \\{`));
  }
  for (const name of [
    "MediaConnectionResponseDto",
    "MediaImportResponseDto",
    "MediaImportItemResponse",
    "MediaSubscriptionResponseDto",
  ]) {
    const properties = spec.components.schemas[name].properties;
    for (const secret of [
      "session",
      "cookies",
      "encryptedSession",
      "password",
      "accessToken",
      "refreshToken",
      "clientSecret",
      "mediaUrl",
      "extractionUrl",
    ]) {
      assert.equal(
        Object.hasOwn(properties, secret),
        false,
        `${name}.${secret}`,
      );
    }
  }
  assert.deepEqual(
    spec.components.schemas.MediaImportCreateDto.properties.overrideSuppression,
    {
      default: false,
      type: "boolean",
    },
  );
  assert.equal(
    spec.paths["/media-imports"].post["x-immich-permission"],
    "media-import.create",
  );
  assert.equal(
    spec.paths["/media-connections"].post["x-immich-permission"],
    "media-connection.write",
  );
});
