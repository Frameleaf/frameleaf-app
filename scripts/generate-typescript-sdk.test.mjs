import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const generator = fileURLToPath(
  new URL("./generate-typescript-sdk.mjs", import.meta.url),
);
const enums = {
  ProcessingProvenanceVersion: [1],
  ProcessingProvenanceFamily: ["anime4k"],
  ProcessingProvenanceEvidence: ["client-reported"],
  ProcessingProvenanceSourceNamespace: ["freecut-media"],
  StudioImportPublicationState: [
    "registered",
    "preparing",
    "published",
    "aborted",
  ],
  StudioImportPublicationCancelStatus: ["cancelled", "already-published"],
};

for (const malformed of [false, true, "request-shape", "response-shape"]) {
  test(`private SDK projection preserves enum exports and canonical input (malformed=${malformed})`, () => {
    const directory = mkdtempSync(
      path.join(tmpdir(), "frameleaf-sdk-projection-"),
    );
    try {
      const schemas = Object.fromEntries(
        Object.entries(enums).map(([name, values]) => [
          name,
          {
            type: typeof values[0] === "number" ? "integer" : "string",
            enum: values,
            ...(typeof values[0] === "number" ? { format: "int32" } : {}),
          },
        ]),
      );
      schemas.StudioExportShape = {
        type: "string",
        enum: ["original", "vertical", "square"],
      };
      schemas.StudioExportRequestShape = {
        type: "string",
        enum: ["original", "landscape", "vertical", "square"],
        description: "Delivery shape",
      };
      schemas.Evidence = {
        type: "string",
        enum: ["registered-current-originals"],
      };
      schemas.Envelope = {
        type: "object",
        properties: Object.fromEntries(
          [...Object.keys(enums), "Evidence"].map((name) => [
            name,
            {
              $ref: `#/components/schemas/${name}`,
              description: `retained ${name}`,
            },
          ]),
        ),
      };
      const query = {
        $ref: "#/components/schemas/StudioImportPublicationState",
      };
      const spec = {
        openapi: "3.0.3",
        info: { title: "projection", version: "1" },
        paths: {
          "/publications": {
            get: {
              parameters: [{ in: "query", name: "state", schema: query }],
            },
          },
        },
        components: { schemas },
      };
      if (malformed === true) schemas.ProcessingProvenanceVersion.enum = [2];
      if (malformed === "request-shape")
        schemas.StudioExportRequestShape.enum.push("unknown");
      if (malformed === "response-shape")
        schemas.StudioExportShape.enum.push("landscape");
      const input = path.join(directory, "input.json");
      const output = path.join(directory, "output.json");
      const source = JSON.stringify(spec);
      writeFileSync(input, source);
      writeFileSync(
        path.join(directory, "oazapfts"),
        `#!${process.execPath}
const fs = require("node:fs");
fs.copyFileSync(process.argv.at(-2), process.argv.at(-1));
`,
        { mode: 0o755 },
      );
      const result = spawnSync(process.execPath, [generator, input, output], {
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: directory + path.delimiter + process.env.PATH,
        },
      });
      assert.ifError(result.error);
      assert.equal(readFileSync(input, "utf8"), source);
      if (malformed) {
        assert.notEqual(result.status, 0);
        assert.match(
          result.stderr,
          malformed === true
            ? /Structural enum requires generator review/u
            : /Studio export request shape requires generator review/u,
        );
        return;
      }
      assert.equal(result.status, 0, result.stdout + result.stderr);
      const privateInput = JSON.parse(readFileSync(output, "utf8"));
      const projected = privateInput.components.schemas;
      for (const [name, values] of Object.entries(enums)) {
        assert.deepEqual(projected[name], schemas[name]);
        const property = projected.Envelope.properties[name];
        assert.equal(property.$ref, undefined);
        assert.equal(property.enum, undefined);
        assert.equal(property.description, `retained ${name}`);
        assert.deepEqual(
          property.anyOf,
          values.map((value) => ({ type: schemas[name].type, enum: [value] })),
        );
        if (name === "ProcessingProvenanceVersion")
          assert.equal(property.format, "int32");
      }
      assert.deepEqual(projected.StudioExportShape, schemas.StudioExportShape);
      assert.deepEqual(projected.StudioExportRequestShape, {
        description: "Delivery shape",
        anyOf: [
          { $ref: "#/components/schemas/StudioExportShape" },
          { type: "string", enum: ["landscape"] },
        ],
      });
      assert.deepEqual(projected.Evidence, schemas.Evidence);
      assert.deepEqual(
        projected.Envelope.properties.Evidence,
        schemas.Envelope.properties.Evidence,
      );
      const receipt = JSON.parse(result.stdout.trim());
      assert.equal(
        receipt.structuralEnumGeneratorProjections.length,
        Object.keys(enums).length + 1,
      );
      assert.deepEqual(
        privateInput.paths["/publications"].get.parameters[0].schema.anyOf,
        enums.StudioImportPublicationState.map((value) => ({
          type: "string",
          enum: [value],
        })),
      );
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
}
