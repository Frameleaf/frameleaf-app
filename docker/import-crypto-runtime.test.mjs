import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

test("the pruned Server retains its native imported-password verifier without restoring unrelated optional packages", async () => {
  const root = await mkdtemp(resolve(tmpdir(), "frameleaf-import-crypto-"));
  try {
    const source = resolve("server");
    const sourceRequire = createRequire(resolve(source, "package.json"));
    const wrapper = dirname(
      sourceRequire.resolve("@node-rs/argon2/package.json"),
    );
    const target = resolve(root, "node_modules/@node-rs/argon2");
    await mkdir(dirname(target), { recursive: true });
    await cp(wrapper, target, { recursive: true });
    const targetRequire = createRequire(resolve(root, "package.json"));
    assert.throws(
      () => targetRequire("@node-rs/argon2"),
      /Cannot find native binding/,
    );
    const { preserveImportCryptoRuntime } =
      await import("./scripts/preserve-import-crypto-runtime.mjs");
    await preserveImportCryptoRuntime(source, root);
    const { hashRaw } = targetRequire("@node-rs/argon2");
    assert.equal(
      (
        await hashRaw("synthetic password", {
          memoryCost: 1024,
          timeCost: 1,
          parallelism: 1,
          salt: Buffer.alloc(16, 1),
        })
      ).length,
      32,
    );
    const packageJson = JSON.parse(
      await readFile(resolve(target, "package.json"), "utf8"),
    );
    assert.equal(packageJson.version, "2.2.1");
    await assert.rejects(
      readFile(
        resolve(
          root,
          "node_modules/@img/sharp-libvips-linux-arm64/package.json",
        ),
      ),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the production image restores and verifies native password support after pruning", async () => {
  const dockerfile = await readFile("server/Dockerfile", "utf8");
  const prune = dockerfile.indexOf("deploy /output/server-pruned");
  const preserve = dockerfile.indexOf(
    "RUN node /build/preserve-import-crypto-runtime.mjs /usr/src/app/server /output/server-pruned",
  );
  const verify = dockerfile.indexOf(
    "RUN node /build/verify-server-package.mjs /output/server-pruned",
  );
  assert.ok(prune >= 0 && preserve > prune && verify > preserve);
});
