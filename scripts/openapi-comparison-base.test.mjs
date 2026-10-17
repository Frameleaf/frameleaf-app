import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { deriveOpenApiComparisonBase } from "./prepare-openapi-comparison-base.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const oasdiffImage = process.env.OASDIFF_IMAGE ?? "tufin/oasdiff:v1.33.0";
const legacyEmailPattern = String.raw`^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;
const equivalentEmailPattern = String.raw`^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;
const base = () => ({
  openapi: "3.0.3",
  info: { title: "Literal compatibility", version: "1" },
  paths: {
    "/value": {
      post: {
        operationId: "setValue",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  point: {
                    type: "array",
                    items: { type: "number" },
                    minItems: 2,
                    maxItems: 2,
                  },
                  unboundedPoints: { type: "array", items: { type: "number" } },
                  email: {
                    type: "string",
                    format: "email",
                    pattern: equivalentEmailPattern,
                  },
                },
              },
            },
          },
        },
        responses: { 200: { description: "OK" } },
      },
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

const requestProperties = (doc) =>
  doc.paths["/value"].post.requestBody.content["application/json"].schema
    .properties;

test("unknown historical bases retain tuple bounds and exact email patterns", () => {
  const input = base();
  const point = {
    type: "array",
    items: { type: "number", minimum: 0, maximum: 1 },
  };
  input.components = {
    schemas: {
      AssetDevelopStroke: {
        type: "object",
        properties: { points: { type: "array", items: point } },
      },
    },
  };
  requestProperties(input).email.pattern = legacyEmailPattern;
  const { document, rewrites } = deriveOpenApiComparisonBase(input);
  assert.deepEqual(document.components, input.components);
  assert.deepEqual(requestProperties(document), requestProperties(input));
  assert.ok(
    !rewrites.some(
      (pointer) =>
        pointer.includes("AssetDevelopStroke") || pointer.includes("email"),
    ),
  );
  const changed = structuredClone(input);
  changed.components.schemas.AssetDevelopStroke.properties.points.items.minItems = 1;
  changed.components.schemas.AssetDevelopStroke.properties.points.items.maxItems = 3;
  assert.deepEqual(
    deriveOpenApiComparisonBase(changed).document.components,
    changed.components,
  );
});

test("the exact historical email pattern pair accepts the same boundary cases", () => {
  const before = new RegExp(legacyEmailPattern);
  const after = new RegExp(equivalentEmailPattern);
  for (const local of [
    "",
    "a",
    ".a",
    "a.",
    "a..b",
    "a'b",
    "a+b",
    "a_b",
    "a-b",
    "a'",
    "a.b",
    "a.b.c",
    "ñ",
    "a\nb",
  ])
    for (const domain of [
      "example.com",
      "example..com",
      "-example.com",
      "example-.com",
      "example.c",
      "example.12",
      "example.com\n",
      "x",
      "example.sub.net",
    ])
      assert.equal(
        before.test(`${local}@${domain}`),
        after.test(`${local}@${domain}`),
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
      "new-unrelated-tuple-bounds",
      (doc) => {
        requestProperties(doc).unboundedPoints.minItems = requestProperties(
          doc,
        ).unboundedPoints.maxItems = 2;
      },
      1,
    ],
    [
      "changed-reviewed-tuple-length",
      (doc) => {
        requestProperties(doc).point.minItems = requestProperties(
          doc,
        ).point.maxItems = 3;
      },
      1,
    ],
    // The unchanged ERR policy reports regex restrictions as WARN; never erase that finding.
    [
      "restrictive-email-pattern",
      (doc) => {
        requestProperties(doc).email.pattern = "^[a-z]+@example\\.com$";
      },
      0,
    ],
    [
      "restrictive-email-warning-control",
      (doc) => {
        requestProperties(doc).email.pattern = "^[a-z]+@example\\.com$";
      },
      1,
      "WARN",
    ],

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
    for (const [name, change, expected, failOn = "ERR"] of cases) {
      const candidate = structuredClone(derived);
      change(candidate);
      writeFileSync(
        path.join(fixtures, `${name}.json`),
        JSON.stringify(candidate),
      );
      const command = [
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
        oasdiffImage,
        "breaking",
        "--format",
        "json",
        "--fail-on",
        "ERR",
        "/fixtures/derived-base.json",
        `/fixtures/${name}.json`,
      ];
      if (failOn === "WARN") command[command.indexOf("--fail-on") + 1] = "WARN";
      const result = spawnSync("docker", command, {
        encoding: "utf8",
        timeout: 120_000,
      });
      assert.ifError(result.error);
      assert.equal(
        result.status,
        expected,
        `${name}: ${result.stdout}\n${result.stderr}`,
      );
      if (expected)
        assert.match(
          result.stdout,
          failOn === "WARN" ? /"level":2/u : /"level":3/u,
        );
      if (name.startsWith("restrictive-email"))
        assert.match(
          result.stdout,
          /"id":\s*"request-property-pattern-changed"/u,
        );
      console.log(`${name}: actual=${result.status} expected=${expected}`);
    }
  } finally {
    rmSync(fixtures, { recursive: true, force: true });
  }
});
