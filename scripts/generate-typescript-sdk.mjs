import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// oazapfts 7.5.0 enum mode emits an invalid uninitialized enum member for null.
// Its nullable flag already produces `Enum | null`. Adapt only its private input;
// the canonical validated OpenAPI checkpoint must retain null in nullable enums.
const [
  source = "open-api/immich-openapi-specs.json",
  output = "packages/sdk/src/fetch-client.ts",
] = process.argv.slice(2);
if (resolve(source) === resolve(output))
  throw new Error("SDK output must not overwrite the canonical checkpoint");
const document = JSON.parse(await readFile(source));
const projections = [];
function schema(value, pointer) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  if (
    value.nullable === true &&
    Array.isArray(value.enum) &&
    value.enum.includes(null)
  ) {
    const nonNull = value.enum.filter((item) => item !== null);
    if (
      !nonNull.length ||
      Object.hasOwn(value, "x-enumNames") ||
      Object.hasOwn(value, "x-enum-varnames")
    ) {
      throw new Error(`Nullable enum requires generator review: ${pointer}`);
    }
    value.enum = nonNull;
    projections.push(pointer);
  }
  for (const key of ["items", "additionalProperties", "not"])
    schema(value[key], `${pointer}/${key}`);
  for (const [name, child] of Object.entries(value.properties ?? {}))
    schema(child, `${pointer}/properties/${name}`);
  for (const key of ["allOf", "anyOf", "oneOf"])
    for (const [index, child] of (value[key] ?? []).entries())
      schema(child, `${pointer}/${key}/${index}`);
}
function openApi(value, pointer) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (
      ["example", "examples", "default", "enum", "const"].includes(key) ||
      key.startsWith("x-")
    )
      continue;
    if (key === "schema") schema(child, `${pointer}/schema`);
    else openApi(child, `${pointer}/${key}`);
  }
}
for (const [name, value] of Object.entries(document.components?.schemas ?? {}))
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
const directory = await mkdtemp(join(tmpdir(), "frameleaf-sdk-input-"));
try {
  const input = join(directory, "openapi.json");
  await writeFile(input, JSON.stringify(document));
  console.log(
    JSON.stringify({
      source,
      output,
      nullableEnumGeneratorProjections: projections,
    }),
  );
  const result = spawnSync(
    "oazapfts",
    [
      "--optimistic",
      "--argumentStyle=object",
      "--useEnumType",
      "--allSchemas",
      input,
      resolve(output),
    ],
    { stdio: "inherit" },
  );
  if (result.error) throw result.error;
  if (result.status !== 0)
    throw new Error(`oazapfts failed: ${result.status ?? result.signal}`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
