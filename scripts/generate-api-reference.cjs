#!/usr/bin/env node
// Complete wire contract pages; no new API implementation or runtime dependency.
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const assert = require("node:assert/strict");
const ts = require("../server/node_modules/typescript");
const root = path.resolve(__dirname, "..");
const out = path.join(root, "internal-docs/api-reference");
const specPath = "open-api/immich-openapi-specs.json";
const raw = fs.readFileSync(path.join(root, specPath), "utf8");
const spec = JSON.parse(raw);
const revision =
  process.env.API_REFERENCE_REVISION ||
  (fs.existsSync(path.join(out, "coverage.json"))
    ? JSON.parse(fs.readFileSync(path.join(out, "coverage.json"), "utf8"))
        .sourceRevision
    : undefined);
assert(revision, "Set API_REFERENCE_REVISION to the reviewed source commit");
const source = (file, line) =>
  `https://github.com/Frameleaf/frameleaf-app/blob/${revision}/${file}${line ? "#L" + line : ""}`;
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
const fence = (obj) => "\n```json\n" + JSON.stringify(obj, null, 2) + "\n```\n";
const decorators = (node) =>
  (ts.canHaveDecorators(node) ? ts.getDecorators(node) : []) || [];
const call = (decorator) =>
  ts.isCallExpression(decorator.expression) ? decorator.expression : null;
const values = new Map();
const enumFile = ts.createSourceFile(
  "enum.ts",
  fs.readFileSync(path.join(root, "server/src/enum.ts"), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
for (const node of enumFile.statements)
  if (ts.isEnumDeclaration(node))
    for (const member of node.members)
      if (member.initializer && ts.isStringLiteral(member.initializer))
        values.set(
          `${node.name.text}.${member.name.getText(enumFile)}`,
          member.initializer.text,
        );
const literal = (node, sf) => {
  if (!node) return "";
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return node.text;
  if (ts.isTemplateExpression(node))
    return (
      node.head.text +
      node.templateSpans
        .map((span) => literal(span.expression, sf) + span.literal.text)
        .join("")
    );
  if (values.has(node.getText(sf))) return values.get(node.getText(sf));
  throw new Error("Unresolved route expression: " + node.getText(sf));
};
const handlers = [];
const inputs = {
  [specPath]: hash(raw),
  "server/src/enum.ts": hash(enumFile.text),
};
for (const name of fs
  .readdirSync(path.join(root, "server/src/controllers"))
  .filter((name) => name.endsWith(".controller.ts"))
  .sort()) {
  const file = "server/src/controllers/" + name;
  const text = fs.readFileSync(path.join(root, file), "utf8");
  inputs[file] = hash(text);
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  for (const cls of sf.statements.filter(ts.isClassDeclaration)) {
    const controller = decorators(cls)
      .map(call)
      .find((d) => d && d.expression.getText(sf) === "Controller");
    if (!controller) continue;
    for (const method of cls.members.filter(ts.isMethodDeclaration)) {
      const ds = decorators(method).map(call).filter(Boolean);
      const http = ds.find((d) =>
        /^(Get|Post|Put|Patch|Delete|Head|Options|All)$/.test(
          d.expression.getText(sf),
        ),
      );
      if (!http) continue;
      const route =
        "/" +
        [literal(controller.arguments[0], sf), literal(http.arguments[0], sf)]
          .filter(Boolean)
          .join("/");
      const endpoint = ds.find((d) =>
        ["Endpoint", "ApiOperation"].includes(d.expression.getText(sf)),
      );
      const id =
        endpoint &&
        endpoint.arguments[0] &&
        ts.isObjectLiteralExpression(endpoint.arguments[0]) &&
        endpoint.arguments[0].properties.find(
          (p) =>
            ts.isPropertyAssignment(p) && p.name.getText(sf) === "operationId",
        );
      handlers.push({
        operationId: id ? literal(id.initializer, sf) : method.name.getText(sf),
        method: http.expression.getText(sf).toLowerCase(),
        path: route.replace(/:([A-Za-z0-9_]+)/g, "{$1}"),
        file,
        line: sf.getLineAndCharacterOfPosition(method.getStart(sf)).line + 1,
        class: cls.name.text,
        excluded: ds
          .concat(decorators(cls).map(call).filter(Boolean))
          .some((d) =>
            ["ApiExcludeEndpoint", "ApiExcludeController"].includes(
              d.expression.getText(sf),
            ),
          ),
        decorators: decorators(cls)
          .concat(decorators(method))
          .map((d) => d.getText(sf)),
      });
    }
  }
}
const ops = Object.entries(spec.paths).flatMap(([route, item]) =>
  Object.entries(item)
    .filter(([method]) =>
      /^(get|post|put|patch|delete|head|options|trace)$/.test(method),
    )
    .map(([method, operation]) => ({
      route,
      method,
      operation,
      pathParameters: item.parameters,
    })),
);
assert.equal(
  new Set(ops.map((o) => o.operation.operationId)).size,
  ops.length,
  "operation IDs must be unique",
);
for (const op of ops)
  assert(
    handlers.some(
      (h) =>
        h.operationId === op.operation.operationId &&
        h.method === op.method &&
        h.path === op.route,
    ),
    "Unmapped OpenAPI handler " + op.operation.operationId,
  );
const missing = handlers.filter(
  (h) =>
    !ops.some(
      (o) =>
        o.operation.operationId === h.operationId &&
        o.method === h.method &&
        o.route === h.path,
    ),
);
assert(
  missing.every((h) => h.excluded),
  "Unexplained route missing from OpenAPI: " +
    JSON.stringify(missing.filter((h) => !h.excluded)),
);
const pages = new Map();
const preamble = (title) =>
  `# ${title}\n\nGenerated from the checked-in [server contract](${source(specPath)}). Base path: \`/api\`. Wire names are preserved for client compatibility. Full JSON below retains validation constraints, formats, nullability, media types, status codes, extensions and history.\n\n`;
const schemaNames = Object.keys(spec.components.schemas).sort();
const partitions = (items, render) => {
  const groups = [[]];
  let size = 0;
  for (const item of items) {
    const length = Buffer.byteLength(render(item));
    if (size + length > 48000 && groups.at(-1).length) {
      groups.push([]);
      size = 0;
    }
    groups.at(-1).push(item);
    size += length;
  }
  return groups;
};
const schemaLocation = new Map();
const schemaGroups = partitions(
  schemaNames,
  (name) => `## ${name}\n` + fence(spec.components.schemas[name]),
);
schemaGroups.forEach((names, i) =>
  names.forEach((name) =>
    schemaLocation.set(
      name,
      `models-${String(i + 1).padStart(2, "0")}.md#${slug(name)}`,
    ),
  ),
);
const references = (obj) =>
  [
    ...new Set(
      JSON.stringify(obj).match(/#\/components\/schemas\/[^"\\]+/g) || [],
    ),
  ]
    .map((ref) => ref.replace("#/components/schemas/", ""))
    .sort();
const links = (obj) =>
  references(obj)
    .map((name) => {
      assert(schemaLocation.has(name), "Unresolved schema " + name);
      return `[${name}](${schemaLocation.get(name)})`;
    })
    .join(", ");
schemaGroups.forEach((names, i) =>
  pages.set(
    `models-${String(i + 1).padStart(2, "0")}.md`,
    preamble(`Server API models ${i + 1}`) +
      names
        .map(
          (name) =>
            `## ${name}\n\n${links(spec.components.schemas[name]) ? "Related models: " + links(spec.components.schemas[name]) + ".\n" : ""}` +
            fence(spec.components.schemas[name]),
        )
        .join("\n"),
  ),
);
const tags = new Map();
for (const op of ops) {
  const tag = op.operation.tags?.find((t) => t !== "Deprecated") || "Other";
  if (!tags.has(tag)) tags.set(tag, []);
  tags.get(tag).push(op);
}
const operationLocations = {};
const renderOp = (op) => {
  const h = handlers.find(
    (h) =>
      h.operationId === op.operation.operationId &&
      h.method === op.method &&
      h.path === op.route,
  );
  return (
    `## ${op.operation.operationId}\n\n\`${op.method.toUpperCase()} /api${op.route}\`\n\n[Controller implementation](${source(h.file, h.line)}).\n\n${op.operation.summary ? op.operation.summary.replace(/[<>{}]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "{": "&#123;", "}": "&#125;" })[c]) + "\n\n" : ""}Permission: \`${op.operation["x-immich-permission"] || "See authentication declaration"}\`. Admin only: \`${Boolean(op.operation["x-immich-admin-only"])}\`.\n\n${links(op.operation) ? "Models: " + links(op.operation) + ".\n\n" : ""}Controller access declarations:\n\n\`\`\`typescript\n${h.decorators.join("\n")}\n\`\`\`\n\nComplete operation contract${op.pathParameters ? " (including path-level parameters)" : ""}:\n` +
    fence(
      op.pathParameters
        ? {
            ...op.operation,
            parameters: [
              ...op.pathParameters,
              ...(op.operation.parameters || []),
            ],
          }
        : op.operation,
    )
  );
};
for (const [tag, items] of [...tags].sort(([a], [b]) => a.localeCompare(b))) {
  const groups = partitions(items, renderOp);
  groups.forEach((group, i) => {
    const file = `endpoints-${slug(tag)}${groups.length > 1 ? "-" + (i + 1) : ""}.md`;
    for (const op of group)
      operationLocations[op.operation.operationId] =
        file + "#" + slug(op.operation.operationId);
    pages.set(
      file,
      preamble(`Server API — ${tag}${groups.length > 1 ? " " + (i + 1) : ""}`) +
        group.map(renderOp).join("\n"),
    );
  });
}
pages.set(
  "http-aliases.md",
  `# Server HTTP aliases and discovery\n\nThese ${missing.length} controller routes are intentionally excluded from OpenAPI. Paths below are controller-relative; see the protocol guide for root discovery mounting. They remain inventoried so exclusion does not silently hide an API.\n\n` +
    missing
      .map(
        (h) =>
          `## ${h.operationId}\n\n\`${h.method.toUpperCase()} ${h.path}\` — [source](${source(h.file, h.line)}).\n\n\`\`\`typescript\n${h.decorators.join("\n")}\n\`\`\`\n`,
      )
      .join("\n"),
);
// Protocol guides are reviewed by hand; source drift must invalidate their snapshot too.
for (const name of ["auth-mobile.md", "protocols.md", "worker-wire-models.md"]) {
  const text = fs.readFileSync(path.join(out, name), "utf8");
  for (const [, ref, file] of text.matchAll(/https:\/\/github\.com\/Frameleaf\/frameleaf-app\/blob\/([^/]+)\/([^#)\s]+)(?:#[^)\s]*)?/g)) {
    assert.equal(ref, revision, "Protocol source revision drift: " + name);
    inputs[file] = hash(fs.readFileSync(path.join(root, file), "utf8"));
  }
}
const manifest = {
  sourceRevision: revision,
  openapiVersion: spec.openapi,
  apiVersion: spec.info.version,
  pathCount: Object.keys(spec.paths).length,
  operationCount: ops.length,
  schemaCount: schemaNames.length,
  controllerRouteCount: handlers.length,
  excludedRoutes: missing,
  sourceHashes: inputs,
  operations: operationLocations,
  schemas: Object.fromEntries(schemaLocation),
};
pages.set(
  "index.md",
  `# Complete Frameleaf server API reference\n\nContract snapshot: \`${revision}\`, API \`${spec.info.version}\`. This reference covers **${ops.length} OpenAPI operations**, **${schemaNames.length} schemas**, and **${missing.length} deliberately excluded controller routes**.\n\nStart with [authentication and mobile workflows](auth-mobile.md) and [streaming, workers and other protocols](protocols.md), then the [complete worker wire models](worker-wire-models.md). Separate Frameleaf Cloud control-plane contracts are maintained with the Cloud service. Server URLs are relative to your installation, not the Cloud account host. This complete internal reference is kept outside the public documentation build; it includes administrative, Cloud integration and worker contracts.\n\n## Endpoints by service\n\n` +
    [...pages]
      .filter(([file]) => file.startsWith("endpoints-"))
      .map(([file, body]) => `- [${body.split("\n")[0].slice(2)}](${file})`)
      .join("\n") +
    "\n\n## Models\n\n" +
    schemaGroups
      .map(
        (names, i) =>
          `- [Models ${i + 1}: ${names[0]} through ${names.at(-1)}](models-${String(i + 1).padStart(2, "0")}.md)`,
      )
      .join("\n") +
    "\n\n[HTTP aliases and discovery](http-aliases.md). The complete machine-readable contract lives in `open-api/immich-openapi-specs.json`; `coverage.json` maps every operation and model to its page and records source hashes.\n\n## Keeping this reference current\n\nRun `mise open-api` after changing API definitions, then `API_REFERENCE_REVISION=<source-commit> node scripts/generate-api-reference.cjs`. The source revision is retained in the coverage manifest for subsequent checks. Run `node scripts/generate-api-reference.cjs --check` to verify exact contract coverage and generated content. The TypeScript SDK is in `packages/sdk`; JSON schema references retain their original names. Source-derived access declarations supplement the generated wire contract; model JSON is normative for required fields and validation. This snapshot does not assert that the branch has been deployed.\n",
);
pages.set("coverage.json", JSON.stringify(manifest, null, 2) + "\n");
fs.mkdirSync(out, { recursive: true });
const check = process.argv.includes("--check");
for (const [name, content] of pages)
  if (check)
    assert.equal(
      fs.readFileSync(path.join(out, name), "utf8"),
      content,
      "Generated document drift: " + name,
    );
  else fs.writeFileSync(path.join(out, name), content);
const generated = (name) =>
  /^(endpoints-|models-|coverage\.json$|http-aliases\.md$|index\.md$)/.test(
    name,
  );
for (const name of fs.readdirSync(out).filter(generated))
  assert(pages.has(name), "Obsolete generated page: " + name);
console.log(
  `${check ? "Verified" : "Generated"} ${ops.length} operations, ${schemaNames.length} schemas, ${missing.length} excluded routes in ${pages.size} files`,
);
