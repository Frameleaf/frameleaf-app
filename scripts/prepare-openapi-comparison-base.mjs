import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const sha = (value) => createHash("sha256").update(value).digest("hex");
// Reviewed base 0a1a4aae150cbdd97ae4c0dd086ac45bc10d742c, raw spec SHA-256
// 6c99abf3a3500d2ee5488a0c6e9f7361611e0436a04e23dca4f18835dc65d9cb.
// SHA-256 of JSON.stringify(parsed base): formatting changes alone do not change its identity.
const reviewedBaseSha256 = new Set([
  "bcb48357fe0c4808d196da4993330c72e4db5201f03018f0c9b0e00c4e7c4057",
  // PR140 ba3c033f8e retains the same point DTO and email constraints after Takeout updates.
  "ede05156bcab7a9f84ef01ae067bd7e6441b76be1eee9ce9df84572d66456a39",
]);
const pointPointers = [
  "/components/schemas/AssetDevelopStroke/properties/points/items",
  "/components/schemas/DarktableDevelopRecipe/properties/masks/items/properties/strokes/items/properties/points/items",
];
const legacyEmailPattern = String.raw`^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;
const equivalentEmailPattern = String.raw`^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$`;
const emailPointers = [
  "/components/schemas/FrameleafSetupAdminDto/properties/email",
  "/components/schemas/ICloudAuthDto/properties/appleId",
  "/components/schemas/PhotographyBrandDto/properties/brand/properties/email/anyOf/0",
  "/components/schemas/PhotographyBrandSaveDto/properties/brand/properties/email/anyOf/0",
];

/** Derive only the comparison BASE; never normalize or replace the candidate checkpoint. */
export function deriveOpenApiComparisonBase(input) {
  if (!/^3\.0\./u.test(input.openapi ?? ""))
    throw new Error("Expected a legacy OpenAPI 3.0 base");
  const document = structuredClone(input);
  const rewrites = [];
  if (reviewedBaseSha256.has(sha(JSON.stringify(input)))) {
    const at = (pointer) =>
      pointer
        .split("/")
        .slice(1)
        .reduce((value, key) => value?.[key], document);
    // OriginalPointSchema already enforced exactly two bounded numbers in the reviewed base DTO.
    const point = {
      description:
        "A point as [x, y] fractions of the original image (before rotation, flips and crop)",
      items: { format: "double", maximum: 1, minimum: 0, type: "number" },
      type: "array",
    };
    for (const pointer of pointPointers) {
      const value = at(pointer);
      if (!isDeepStrictEqual(value, point))
        throw new Error(`Unexpected reviewed point schema: ${pointer}`);
      value.minItems = value.maxItems = 2;
      rewrites.push(pointer);
    }
    // Both email patterns forbid leading/trailing/adjacent local dots; domain grouping alone differs.
    for (const pointer of emailPointers) {
      const value = at(pointer);
      if (
        value?.type !== "string" ||
        value.format !== "email" ||
        value.pattern !== legacyEmailPattern
      )
        throw new Error(`Unexpected reviewed email schema: ${pointer}`);
      value.pattern = equivalentEmailPattern;
      rewrites.push(`${pointer}/pattern`);
    }
  }

  const schema = (value, pointer) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (Object.hasOwn(value, "const")) {
      const literal = value.const;
      const matches =
        literal === null
          ? value.nullable === true
          : value.type === "string"
            ? typeof literal === "string"
            : value.type === "boolean"
              ? typeof literal === "boolean"
              : value.type === "integer"
                ? Number.isInteger(literal)
                : value.type === "number"
                  ? typeof literal === "number" && Number.isFinite(literal)
                  : false;
      if (
        !["string", "boolean", "integer", "number"].includes(value.type) ||
        !matches ||
        Object.hasOwn(value, "$ref") ||
        Object.hasOwn(value, "enum") ||
        (Object.hasOwn(value, "nullable") &&
          typeof value.nullable !== "boolean")
      ) {
        throw new Error(`Ambiguous legacy const requires review: ${pointer}`);
      }
      value.enum =
        value.nullable === true && literal !== null
          ? [literal, null]
          : [literal];
      delete value.const;
      rewrites.push(pointer);
    }
    for (const key of ["items", "additionalProperties", "not"])
      schema(value[key], `${pointer}/${key}`);
    for (const key of ["properties"]) {
      for (const [name, child] of Object.entries(value[key] ?? {}))
        schema(child, `${pointer}/${key}/${name}`);
    }
    for (const key of ["allOf", "anyOf", "oneOf"]) {
      for (const [index, child] of (value[key] ?? []).entries())
        schema(child, `${pointer}/${key}/${index}`);
    }
  };
  const openApi = (value, pointer) => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      // These contain payload data, not OpenAPI Schema Objects.
      if (
        ["example", "examples", "default", "enum", "const"].includes(key) ||
        key.startsWith("x-")
      )
        continue;
      if (key === "schema") schema(child, `${pointer}/schema`);
      else openApi(child, `${pointer}/${key}`);
    }
  };
  for (const [name, value] of Object.entries(
    document.components?.schemas ?? {},
  ))
    schema(value, `/components/schemas/${name}`);
  openApi(document.paths, "/paths");
  for (const key of [
    "responses",
    "requestBodies",
    "parameters",
    "headers",
    "callbacks",
  ])
    openApi(document.components?.[key], `/components/${key}`);
  return { document, rewrites };
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  const [source, output] = process.argv.slice(2);
  if (!source || !output || resolve(source) === resolve(output))
    throw new Error("Use distinct source and derived comparison-base paths");
  const bytes = await readFile(source);
  const { document, rewrites } = deriveOpenApiComparisonBase(JSON.parse(bytes));
  const derived = JSON.stringify(document, null, 2);
  await writeFile(output, derived, { flag: "wx" });
  console.log(
    JSON.stringify({
      source,
      output,
      sourceSha256: sha(bytes),
      comparisonBaseSha256: sha(derived),
      rewrites,
    }),
  );
}
