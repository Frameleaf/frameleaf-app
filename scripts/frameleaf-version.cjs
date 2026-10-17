#!/usr/bin/env node
// Frameleaf application versions are independent of import-source and component versions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const PACKAGES = [
  "package.json",
  "server/package.json",
  "web/package.json",
  "packages/sdk/package.json",
  "packages/cli/package.json",
  "e2e/package.json",
];

function versionFiles(root, version) {
  assert.match(
    version,
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:alpha|beta|rc)\.(0|[1-9]\d*))?$/,
  );
  const files = new Map();
  for (const name of PACKAGES) {
    const body = fs.readFileSync(path.join(root, name), "utf8");
    assert.match(body, /^  "version": "[^"]+"/m, `Missing version: ${name}`);
    files.set(
      name,
      body.replace(/^  "version": "[^"]+"/m, `  "version": "${version}"`),
    );
  }
  const pythonVersion = version
    .replace(/-alpha\./, "a")
    .replace(/-beta\./, "b")
    .replace(/-rc\./, "rc");
  for (const name of [
    "machine-learning/pyproject.toml",
    "machine-learning/uv.lock",
  ]) {
    const body = fs.readFileSync(path.join(root, name), "utf8");
    const pattern = /(name = "frameleaf-ml"\nversion = ")[^"]+("\n)/;
    assert.match(body, pattern, `Missing ML version: ${name}`);
    files.set(name, body.replace(pattern, `$1${pythonVersion}$2`));
  }
  const spec = "open-api/immich-openapi-specs.json";
  const body = fs.readFileSync(path.join(root, spec), "utf8");
  const document = JSON.parse(body);
  assert.equal(document.info.title, "Frameleaf");
  document.info.version = version;
  files.set(spec, JSON.stringify(document, null, 2));
  const sdk = "packages/sdk/src/fetch-client.ts";
  const client = fs.readFileSync(path.join(root, sdk), "utf8");
  assert.match(client, / \* Frameleaf\n \* [^\n]+\n/);
  files.set(sdk, client.replace(/( \* Frameleaf\n \* )[^\n]+/, `$1${version}`));
  return files;
}

function setVersion(root, version, check = false) {
  const files = versionFiles(root, version);
  const changed = [...files].filter(
    ([name, body]) => fs.readFileSync(path.join(root, name), "utf8") !== body,
  );
  if (check)
    assert.equal(
      changed.length,
      0,
      `Version drift: ${changed.map(([name]) => name).join(", ")}`,
    );
  else
    for (const [name, body] of changed)
      fs.writeFileSync(path.join(root, name), body);
  return version;
}

module.exports = { setVersion, versionFiles, PACKAGES };
if (require.main === module) {
  const root = path.resolve(__dirname, "..");
  const [argument, ...rest] = process.argv.slice(2);
  assert.equal(
    rest.length,
    0,
    "Usage: node scripts/frameleaf-version.cjs <version|--check>",
  );
  const check = argument === "--check";
  const version = check
    ? JSON.parse(fs.readFileSync(path.join(root, "package.json"))).version
    : argument;
  setVersion(root, version, check);
  console.log(
    `Frameleaf ${version}: application versions ${check ? "verified" : "updated"}`,
  );
}
