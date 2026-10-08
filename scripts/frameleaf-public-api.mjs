import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Only reviewed, local application areas are published. New tags are private by default.
const publicTags = new Set([
  "Activities",
  "Users (admin)",
  "Database Backups (admin)",
  "File trash (admin)",
  "Maintenance (admin)",
  "Notifications (admin)",
  "Album sources",
  "Albums",
  "Analytics",
  "Assets",
  "Asset files",
  "Views",
  "Cluster groups",
  "Documents",
  "Download",
  "Duplicates",
  "Enrichment",
  "Faces",
  "Item shares",
  "Jobs",
  "Libraries",
  "Live Photo",
  "Map",
  "Media Health",
  "Media operations",
  "Memories",
  "Notifications",
  "Partners",
  "People",
  "Pets",
  "Studio projects",
  "Plugins",
  "Preservation",
  "Queues",
  "Search",
  "Server",
  "Sessions",
  "Shared links",
  "Shared spaces",
  "Stacks",
  "Studio previews",
  "Tags",
  "Timeline",
  "Trash",
  "Users",
  "Workflows",
]);
const privateContract =
  /cloud|buddy|license|licence|remoteaccess|remoteconnection|remotehostname|renderworker|mldestination|configcredential/i;
const privateRoute =
  /cloud|buddy|licen[cs]e|\/oauth|\/auth|\/config|render-workers|ml-destinations|\/sync|system-metadata/i;
const visitorRoutes = new Set(["/shared-links/login", "/shared-links/me"]);
const permissionFree = new Set(["getWorkflowTriggers"]); // @Authenticated({ permission: false })
const methods = new Set(["get", "post", "put", "patch", "delete", "head", "options"]);

function references(value) {
  return [...JSON.stringify(value).matchAll(/"\$ref":"(#\/components\/[^" ]+)"/g)].map((match) => match[1]);
}

function privateStructure(value) {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(privateStructure);
  if (Object.keys(value.properties ?? {}).some((key) => privateContract.test(key))) return true;
  if ((value.enum ?? []).some((item) => typeof item === "string" && privateContract.test(item))) return true;
  return Object.values(value).some(privateStructure);
}

function clean(value) {
  if (Array.isArray(value)) return value.map(clean);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, item]) => {
      if (key === "externalDocs" || key === "x-immich-history" || key === "x-immich-state") return [];
      if (key.startsWith("x-immich-")) return [[key.replace("x-immich-", "x-frameleaf-"), clean(item)]];
      // Editorial text can be rebranded; wire field names and enum values must stay accurate.
      if (["description", "summary", "title"].includes(key) && typeof item === "string") {
        return [[key, item.replace(/\bImmich\b/gi, "Frameleaf").replace(/\bFL-\d+:?\s*/g, "")]];
      }
      return [[key, clean(item)]];
    }),
  );
}

export function publicApi(source) {
  const paths = {},
    components = { securitySchemes: { api_key: source.components.securitySchemes.api_key } };
  for (const [path, item] of Object.entries(source.paths)) {
    if (privateRoute.test(path) || visitorRoutes.has(path)) continue;
    for (const [method, operation] of Object.entries(item)) {
      if (!methods.has(method) || !publicTags.has(operation.tags?.[0])) continue;
      if (
        operation.tags.some((tag) => privateContract.test(tag)) ||
        privateStructure([item.parameters ?? [], operation])
      )
        continue;
      const security = operation.security ?? source.security ?? [];
      if (security.length && !security.some((scheme) => "api_key" in scheme)) continue;
      const reachable = new Map(),
        queue = references([item.parameters ?? [], operation]);
      let privateReference = false;
      while (queue.length) {
        const ref = queue.pop();
        if (reachable.has(ref)) continue;
        const [, , section, name] = ref.split("/");
        const schema = source.components[section]?.[name];
        assert(schema, `Unresolved API reference: ${ref}`);
        reachable.set(ref, schema);
        // Never expose a Cloud contract indirectly through a general settings or job endpoint.
        if (privateContract.test(name) || privateStructure(schema)) {
          privateReference = true;
        }
        queue.push(...references(schema));
      }
      if (privateReference) continue;
      const published = clean(operation);
      published.security = security.length ? [{ api_key: [] }] : [];
      if (security.length && published["x-frameleaf-permission"] === undefined) {
        published["x-frameleaf-permission"] = permissionFree.has(operation.operationId) ? false : "all";
      }
      published.parameters = clean([...(item.parameters ?? []), ...(operation.parameters ?? [])]);
      // Optional legacy checksum header is unnecessary for the documented upload flow.
      published.parameters = published.parameters.filter((parameter) => parameter.name !== "x-immich-checksum");
      (paths[path] ??= {})[method] = published;
      for (const [ref, schema] of reachable) {
        const [, , section, name] = ref.split("/");
        (components[section] ??= {})[name] = clean(schema);
      }
    }
  }
  return {
    openapi: source.openapi,
    info: {
      title: "Frameleaf Server API",
      version: source.info.version,
      description:
        "Selected self-hosted library and administration endpoints for API-key integrations. Cloud services, account linking, internal worker protocols and mixed Cloud configuration contracts are excluded. This is a public subset, not the complete application API.",
    },
    servers: [{ url: "/api", description: "Your Frameleaf server" }],
    paths,
    components,
  };
}

function verify(spec) {
  assert(Object.keys(spec.paths).length, "No public endpoints");
  assert(!privateStructure(spec), "Private inline contract");
  for (const ref of references(spec)) {
    const [, , section, name] = ref.split("/");
    assert(spec.components[section]?.[name], `Unresolved public reference: ${ref}`);
    assert(!privateContract.test(name), `Private schema: ${name}`);
  }
  for (const [path, item] of Object.entries(spec.paths)) {
    assert(!privateRoute.test(path) && !visitorRoutes.has(path), `Private or visitor route: ${path}`);
    for (const operation of Object.values(item)) {
      assert(operation.tags.every((tag) => !privateContract.test(tag)));
    }
  }
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv.includes("--test")) {
  const operation = {
    tags: ["Assets"],
    operationId: "getAsset",
    responses: {
      200: { description: "OK", content: { "application/json": { schema: { $ref: "#/components/schemas/Asset" } } } },
    },
    security: [{ api_key: [] }, { cookie: [] }],
  };
  const fixture = {
    openapi: "3.0.3",
    info: { version: "1" },
    paths: {
      "/assets": { get: operation },
      "/admin/cloud/secret": { get: operation },
      "/new-private": { get: { ...operation, tags: ["New private area"] } },
      "/mixed": { get: { ...operation, responses: { 200: { schema: { $ref: "#/components/schemas/Mixed" } } } } },
    },
    components: {
      securitySchemes: { api_key: { type: "apiKey", in: "header", name: "x-api-key" } },
      schemas: {
        Asset: { type: "object", properties: { id: { type: "string" } } },
        Mixed: { properties: { nested: { $ref: "#/components/schemas/CloudSecret" } } },
        CloudSecret: { type: "object" },
        UnusedPrivate: { type: "object" },
      },
    },
  };
  const result = publicApi(fixture);
  assert.deepEqual(Object.keys(result.paths), ["/assets"]);
  assert.deepEqual(Object.keys(result.components.schemas), ["Asset"]);
  assert.deepEqual(result.paths["/assets"].get.security, [{ api_key: [] }]);
  verify(result);
  assert.equal(result.paths["/assets"].get["x-frameleaf-permission"], "all");
  fixture.paths["/shared-links/me"] = { get: operation };
  fixture.paths["/shared-links/login"] = { post: operation };
  fixture.paths["/workflows/triggers"] = { get: { ...operation, operationId: "getWorkflowTriggers" } };
  assert.equal(publicApi(fixture).paths["/shared-links/me"], undefined);
  assert.equal(publicApi(fixture).paths["/shared-links/login"], undefined);
  assert.equal(publicApi(fixture).paths["/workflows/triggers"].get["x-frameleaf-permission"], false);
  delete fixture.paths["/workflows/triggers"];
  fixture.components.schemas.Asset.properties.buddyBackup = { type: "string" };
  assert.deepEqual(publicApi(fixture).paths, {});
  delete fixture.components.schemas.Asset.properties.buddyBackup;
  fixture.components.schemas.Asset.properties.destination = { $ref: "#/components/schemas/Destination" };
  fixture.components.schemas.Destination = { enum: ["local", "frameleaf-cloud"] };
  assert.deepEqual(publicApi(fixture).paths, {});
  fixture.components.schemas.Asset.properties = { id: { type: "string" } };
  for (const schema of [
    { properties: { cloudToken: { type: "string" } } },
    { properties: { summary: { properties: { cloudToken: { type: "string" } } } } },
    { properties: { nested: { properties: { buddyKey: { type: "string" } } } } },
    { properties: { destination: { enum: ["local", "frameleaf-cloud"] } } },
  ]) {
    fixture.paths["/inline"] = {
      get: { ...operation, responses: { 200: { content: { "application/json": { schema } } } } },
    };
    assert.equal(publicApi(fixture).paths["/inline"], undefined);
  }
  console.log(
    "Public API checks passed: private routes, new tags, indirect schemas, mixed contracts and unused components are excluded.",
  );
} else {
  const source = JSON.parse(readFileSync(resolve(root, "open-api/immich-openapi-specs.json"), "utf8"));
  const spec = publicApi(source);
  verify(spec);
  const output = resolve(process.argv[2] ?? resolve(root, "docs/static/openapi.json"));
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, `${JSON.stringify(spec, null, 2)}\n`);
  console.log(
    `Published ${Object.values(spec.paths).reduce((sum, item) => sum + Object.keys(item).length, 0)} local operations and ${Object.keys(spec.components.schemas).length} schemas to ${output}`,
  );
}
