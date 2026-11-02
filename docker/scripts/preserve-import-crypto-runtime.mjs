import assert from "node:assert/strict";
import { cp, mkdir, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Restore only Argon2's required platform binding after the optional-free production deploy. */
export async function preserveImportCryptoRuntime(source, destination) {
  assert(
    ["linux", "darwin"].includes(process.platform),
    "Unsupported Argon2 build platform",
  );
  if (process.platform === "linux")
    assert(
      process.report.getReport().header.glibcVersionRuntime,
      "Production Argon2 requires glibc",
    );
  const require = createRequire(resolve(source, "package.json"));
  const wrapper = require.resolve("@node-rs/argon2/package.json");
  const nativeRequire = createRequire(wrapper);
  const name = `@node-rs/argon2-${process.platform}-${process.arch}${process.platform === "linux" ? "-gnu" : ""}`;
  const native = nativeRequire.resolve(`${name}/package.json`);
  const wrapperManifest = JSON.parse(await readFile(wrapper, "utf8"));
  const nativeManifest = JSON.parse(await readFile(native, "utf8"));
  assert.equal(
    nativeManifest.version,
    wrapperManifest.version,
    "Argon2 native version mismatch",
  );
  const target = resolve(destination, "node_modules", name);
  await mkdir(dirname(target), { recursive: true });
  await cp(dirname(native), target, {
    recursive: true,
    dereference: true,
    errorOnExist: true,
    force: false,
  });
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await preserveImportCryptoRuntime(process.argv[2], process.argv[3]);
