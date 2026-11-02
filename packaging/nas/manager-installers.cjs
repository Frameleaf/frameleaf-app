const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const INSTALLERS = [
  [
    "frameleaf-manager.xml",
    "unraid/frameleaf-manager.xml.in",
    "unraid/templates/frameleaf-manager.xml",
  ],
  [
    "frameleaf-manager.compose.yaml",
    "truenas/manager.compose.yaml.in",
    "truenas/frameleaf-manager.compose.yaml",
  ],
  [
    "frameleaf-manager.hexos.json",
    "hexos/frameleaf-manager.hexos.json.in",
    "hexos/frameleaf-manager.hexos.json",
  ],
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function renderManagerInstallers(manifest) {
  assert.match(
    manifest.image,
    /^ghcr\.io\/frameleaf\/frameleaf-manager@sha256:[a-f0-9]{64}$/,
  );
  const [, version] = manifest.tag.match(/^manager-v(\d+\.\d+\.\d+)$/) ?? [];
  assert(version, "Manager release tag required");
  return INSTALLERS.map(([name, template, destination]) => {
    const body = fs
      .readFileSync(path.join(__dirname, template), "utf8")
      .replaceAll("@MANAGER_VERSION@", version);
    assert(!/@[A-Z_]+@/.test(body), "Unresolved Manager package placeholder");
    return { name, destination, bytes: Buffer.from(body, "utf8") };
  });
}

// The HexOS catalog validator refuses a moving tag on a public app, so its listing is the signed
// Custom Install script with only the image tag set to this release (owner exception, FL-1111).
function renderHexosCatalog(manifest, assets) {
  const asset = assets.find(
    (asset) => asset.name === "frameleaf-manager.hexos.json",
  );
  const body = asset.bytes.toString("utf8");
  const latest = '"tag": "latest"';
  assert.equal(body.split(latest).length, 2, "One HexOS image tag required");
  return Buffer.from(body.replace(latest, `"tag": "${manifest.tag}"`), "utf8");
}

function validateInstallerBinding(manifest, assets) {
  const binding = manifest.installers;
  assert(
    binding && binding.schemaVersion === 1,
    "Manager installer binding required",
  );
  for (const field of ["sourceCommit", "tag", "image"])
    assert.equal(
      binding[field],
      manifest[field],
      `Manager installer ${field} mismatch`,
    );
  assert.match(binding.sourceCommit, /^[a-f0-9]{40}$/);
  assert.match(binding.tag, /^manager-v\d+\.\d+\.\d+$/);
  assert.match(
    binding.image,
    /^ghcr\.io\/frameleaf\/frameleaf-manager@sha256:[a-f0-9]{64}$/,
  );
  assert(
    Array.isArray(binding.files) && binding.files.length === INSTALLERS.length,
    "Every Manager installer must be bound",
  );
  assert.deepEqual(
    binding.files.map((file) => file.name).sort(),
    INSTALLERS.map(([name]) => name).sort(),
    "Invalid Manager installer names",
  );
  for (const file of binding.files)
    assert.match(
      file.sha256,
      /^[a-f0-9]{64}$/,
      "Invalid Manager installer digest",
    );
  if (assets) {
    assert.deepEqual(
      assets.map((asset) => asset.name).sort(),
      INSTALLERS.map(([name]) => name).sort(),
      "Invalid Manager installer assets",
    );
    for (const asset of assets)
      assert.equal(
        sha256(asset.bytes),
        binding.files.find((file) => file.name === asset.name).sha256,
        `Manager installer bytes mismatch: ${asset.name}`,
      );
  }
}

// Producer byte assembly grants no release authority; the workflow authenticates and signs it.
function assembleManagerInstallers(file, output) {
  const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
  const assets = renderManagerInstallers(manifest);
  manifest.installers = {
    schemaVersion: 1,
    sourceCommit: manifest.sourceCommit,
    tag: manifest.tag,
    image: manifest.image,
    files: assets.map((asset) => ({
      name: asset.name,
      sha256: sha256(asset.bytes),
    })),
  };
  validateInstallerBinding(manifest, assets);
  fs.mkdirSync(output, { recursive: true });
  for (const asset of assets)
    fs.writeFileSync(path.join(output, asset.name), asset.bytes);
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

module.exports = {
  INSTALLERS,
  renderManagerInstallers,
  renderHexosCatalog,
  validateInstallerBinding,
  assembleManagerInstallers,
};
if (require.main === module) {
  assert(
    process.argv.length === 4,
    "Usage: node manager-installers.cjs manifest.json output-directory",
  );
  assembleManagerInstallers(process.argv[2], process.argv[3]);
}
