import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Derive only the comparison BASE; never normalize or replace the candidate checkpoint. */
export function deriveOpenApiComparisonBase(input) {
  if (!/^3\.0\./u.test(input.openapi ?? ""))
    throw new Error("Expected a legacy OpenAPI 3.0 base");
  const document = structuredClone(input);
  const rewrites = [];
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
  const sha = (value) => createHash("sha256").update(value).digest("hex");
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
