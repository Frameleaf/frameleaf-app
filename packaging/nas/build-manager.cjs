const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  verifyManagerRelease,
} = require("../../.github/verify-manager-release.cjs");
const {
  renderManagerInstallers,
  validateInstallerBinding,
} = require("./manager-installers.cjs");

async function buildManager(file, output, verification = {}) {
  const manifest = await verifyManagerRelease(file, verification);
  const assets = renderManagerInstallers(manifest);
  if (manifest.installers !== undefined)
    validateInstallerBinding(manifest, assets);
  const files = assets.map((asset) => [asset.destination, asset.bytes]);
  for (const name of ["ca_profile.xml", "README.md"])
    files.push([
      `unraid/${name}`,
      fs.readFileSync(path.join(__dirname, "unraid", name)),
    ]);
  files.push([
    "unraid/LICENSE",
    fs.readFileSync(path.join(__dirname, "../../LICENSE")),
  ]);
  files.push([
    "manager-manifest.json",
    JSON.stringify(manifest, null, 2) + "\n",
  ]);
  const write = (name, body) => {
    const target = path.join(output, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, body);
  };
  for (const [name, bytes] of files) write(name, bytes);
}
module.exports = { buildManager };
if (require.main === module) {
  assert(
    process.argv.length === 4,
    "Usage: node build-manager.cjs manager-manifest.json output-directory",
  );
  buildManager(process.argv[2], process.argv[3]).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
