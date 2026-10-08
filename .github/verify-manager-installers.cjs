const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { constants } = require("node:fs");
const path = require("node:path");
const { verifyManagerRelease } = require("./verify-manager-release.cjs");
const {
  INSTALLERS,
  validateInstallerBinding,
} = require("../packaging/nas/manager-installers.cjs");

async function verifyManagerInstallers(file, directory, verification) {
  const manifest = await verifyManagerRelease(file, verification);
  validateInstallerBinding(manifest);
  assert(
    (await fs.lstat(directory)).isDirectory(),
    "Installer directory must not be a symlink",
  );
  const assets = [];
  for (const [name] of INSTALLERS) {
    const handle = await fs.open(
      path.join(directory, name),
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    try {
      assert(
        (await handle.stat()).isFile(),
        "Installer must be a regular file",
      );
      assets.push({ name, bytes: await handle.readFile() });
    } finally {
      await handle.close();
    }
  }
  validateInstallerBinding(manifest, assets);
  return manifest;
}
module.exports = { verifyManagerInstallers };
if (require.main === module)
  verifyManagerInstallers(process.argv[2], process.argv[3])
    .then((manifest) =>
      console.log(`Verified authenticated installer bytes for ${manifest.tag}`),
    )
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
