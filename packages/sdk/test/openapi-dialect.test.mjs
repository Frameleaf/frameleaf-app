import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("OpenAPI 3.0 checkpoint preserves literal contracts and valid HTTP bearer security", async () => {
  const spec = JSON.parse(
    await readFile(
      new URL("../../../open-api/immich-openapi-specs.json", import.meta.url),
    ),
  );
  assert.match(spec.openapi, /^3\.0\./u);
  const schemas = spec.components.schemas;
  const execution =
    schemas.ICloudIdentityReuseAuthorityStatusDto.properties.executionAvailable;
  assert.equal(execution.type, "boolean");
  assert.deepEqual(execution.enum, [false]);
  assert.equal(Object.hasOwn(execution, "const"), false);
  const label =
    schemas.ICloudEditEvidenceResponseDto.properties.items.items.properties
      .receipts.items.properties.suggestedAdministrativeLabel;
  assert.equal(label.type, "string");
  assert.equal(label.nullable, true);
  assert.deepEqual(label.enum, ["administrative-original"]);
  assert.equal(Object.hasOwn(label, "const"), false);
  const bearer = spec.components.securitySchemes.bearer;
  assert.equal(bearer.type, "http");
  assert.equal(bearer.scheme, "bearer");
  assert.equal(Object.hasOwn(bearer, "in"), false);
});
