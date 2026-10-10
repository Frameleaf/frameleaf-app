import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deriveOpenApiComparisonBase } from "./prepare-openapi-comparison-base.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const base = () => ({
  openapi: "3.0.3",
  info: { title: "Literal compatibility", version: "1" },
  paths: {
    "/value": {
      get: {
        operationId: "getValue",
        responses: {
          200: {
            description: "OK",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["label", "flag"],
                  properties: {
                    label: {
                      type: "string",
                      const: "literal",
                      nullable: true,
                      maxLength: 10,
                    },
                    flag: { type: "boolean", const: false },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});
const properties = (doc) =>
  doc.paths["/value"].get.responses[200].content["application/json"].schema
    .properties;

test("derived base preserves raw input, nullable values and all other constraints; ambiguous schemas fail closed", () => {
  const input = base();
  input.paths["/value"].get.responses[200].content["application/json"].example =
    { type: "string", const: "payload" };
  const saved = structuredClone(input);
  const { document, rewrites } = deriveOpenApiComparisonBase(input);
  assert.deepEqual(input, saved);
  const expected = structuredClone(input);
  delete properties(expected).label.const;
  properties(expected).label.enum = ["literal", null];
  delete properties(expected).flag.const;
  properties(expected).flag.enum = [false];
  assert.deepEqual(document, expected);
  assert.equal(rewrites.length, 2);
  for (const change of [
    (doc) => {
      properties(doc).label.enum = ["other"];
    },
    (doc) => {
      properties(doc).flag.const = "false";
    },
    (doc) => {
      doc.openapi = "3.1.0";
    },
  ]) {
    const ambiguous = base();
    change(ambiguous);
    assert.throws(() => deriveOpenApiComparisonBase(ambiguous));
  }
  const nullOnly = base();
  properties(nullOnly).label.const = null;
  assert.deepEqual(
    properties(deriveOpenApiComparisonBase(nullOnly).document).label.enum,
    [null],
  );
});

test("pinned compatibility gate accepts equivalent legacy literals and rejects actual contract breaks", () => {
  const fixtures = mkdtempSync(
    path.join(tmpdir(), "frameleaf-openapi-derived-base-"),
  );
  const derived = deriveOpenApiComparisonBase(base()).document;
  const cases = [
    ["same-value", (doc) => {}, 0],
    [
      "changed-literal",
      (doc) => {
        properties(doc).label.enum = ["changed", null];
      },
      1,
    ],
    [
      "added-nullable-value",
      (doc) => {
        properties(doc).flag.enum = [false, null];
        properties(doc).flag.nullable = true;
      },
      1,
    ],
    [
      "nonnullable-to-nullable",
      (doc) => {
        properties(doc).flag.nullable = true;
      },
      1,
    ],
    [
      "removed-operation",
      (doc) => {
        delete doc.paths["/value"];
      },
      1,
    ],
    [
      "removed-operation-id",
      (doc) => {
        delete doc.paths["/value"].get.operationId;
      },
      1,
    ],
    [
      "removed-property",
      (doc) => {
        delete properties(doc).label;
      },
      1,
    ],
    [
      "required-parameter",
      (doc) => {
        doc.paths["/value"].get.parameters = [
          {
            name: "new",
            in: "query",
            required: true,
            schema: { type: "string" },
          },
        ];
      },
      1,
    ],
  ];
  try {
    writeFileSync(
      path.join(fixtures, "derived-base.json"),
      JSON.stringify(derived),
    );
    for (const [name, change, expected] of cases) {
      const candidate = structuredClone(derived);
      change(candidate);
      writeFileSync(
        path.join(fixtures, `${name}.json`),
        JSON.stringify(candidate),
      );
      const result = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--name",
          `fl24-base-policy-${process.pid}-${name}`,
          "--network",
          "none",
          "-e",
          "OASDIFF_INTERNAL=1",
          "-v",
          `${root}:/workspace:ro`,
          "-v",
          `${fixtures}:/fixtures:ro`,
          "-w",
          "/workspace",
          "tufin/oasdiff:v1.31.0",
          "breaking",
          "--format",
          "json",
          "--fail-on",
          "ERR",
          "/fixtures/derived-base.json",
          `/fixtures/${name}.json`,
        ],
        { encoding: "utf8", timeout: 120_000 },
      );
      assert.ifError(result.error);
      assert.equal(
        result.status,
        expected,
        `${name}: ${result.stdout}\n${result.stderr}`,
      );
      if (expected) assert.match(result.stdout, /"level":3/u);
      console.log(`${name}: actual=${result.status} expected=${expected}`);
    }
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
});
