import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  resolveStudioProjectSource,
  StudioSourceParentKind,
} from "../build/index.js";

const schema = JSON.parse(
  await readFile(
    new URL("../../../open-api/immich-openapi-specs.json", import.meta.url),
    "utf8",
  ),
);
const route = "/studio/projects/{id}/source-resolutions";
test("one canonical source resolution operation has exact request and result schemas", () => {
  const operations = Object.entries(schema.paths).flatMap(([path, methods]) =>
    Object.entries(methods)
      .filter(
        ([, operation]) =>
          operation?.operationId === "resolveStudioProjectSource",
      )
      .map(([method]) => ({ path, method })),
  );
  assert.deepEqual(operations, [{ path: route, method: "post" }]);
  for (const [name, properties] of [
    [
      "StudioSourceResolutionRequestDto",
      ["revision", "graphDigest", "parent", "selection"],
    ],
    [
      "StudioSourceResolutionDto",
      [
        "projectId",
        "revision",
        "graphDigest",
        "manifestDigest",
        "parent",
        "expiresAt",
        "archive",
        "files",
        "selection",
      ],
    ],
    ["StudioSourceFileDto", ["path", "sha256", "base64"]],
    ["StudioSourceParentDto", ["kind", "id", "checksum"]],
  ]) {
    const dto = schema.components.schemas[name];
    assert.ok(dto, name);
    assert.equal(dto.additionalProperties, false, name);
    assert.deepEqual(
      Object.keys(dto.properties).sort(),
      properties.sort(),
      name,
    );
    assert.deepEqual([...dto.required].sort(), properties.sort(), name);
  }
  assert.deepEqual(
    schema.components.schemas.StudioSourceParentDto.properties.kind,
    { $ref: "#/components/schemas/StudioSourceParentKind" },
  );
  assert.deepEqual(schema.components.schemas.StudioSourceParentKind, {
    enum: ["project-import", "vector-graphic"],
    type: "string",
  });
  assert.deepEqual(StudioSourceParentKind, {
    ProjectImport: "project-import",
    VectorGraphic: "vector-graphic",
  });
  const result = schema.components.schemas.StudioSourceResolutionDto;
  assert.equal(result.files, undefined);
  assert.equal(result.properties.files.maxItems, 256);
  assert.equal(result.properties.graphDigest.pattern, "^[a-f0-9]{64}$");
  assert.equal(result.properties.manifestDigest.pattern, "^[a-f0-9]{64}$");
});

test("generated canonical SDK preserves saved revision acknowledgement and full result", async () => {
  const id = "019a0000-0000-7000-8000-000000000001";
  const body = {
    revision: 2,
    graphDigest: "a".repeat(64),
    parent: {
      kind: "project-import",
      id: "10000000-0000-4000-8000-000000000001",
      checksum: "b".repeat(64),
    },
    selection: { animationId: "main" },
  };
  const response = {
    projectId: id,
    ...body,
    manifestDigest: "c".repeat(64),
    expiresAt: "2026-10-11T00:00:00.000Z",
    archive: true,
    files: [
      { path: "animations/main.json", sha256: "d".repeat(64), base64: "e30=" },
    ],
  };
  const result = await resolveStudioProjectSource(
    { id, studioSourceResolutionRequestDto: body },
    {
      fetch: async (url, options) => {
        assert.equal(url, `/api/studio/projects/${id}/source-resolutions`);
        assert.equal(options.method, "POST");
        assert.deepEqual(JSON.parse(options.body), body);
        return new Response(JSON.stringify(response), {
          headers: { "content-type": "application/json" },
        });
      },
    },
  );
  assert.deepEqual(result, response);
});
