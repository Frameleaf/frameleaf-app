import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { verifyStudioSubtitleRuntime } from "./verify-server-package.mjs";
const canonical = fileURLToPath(
  new URL("../../studio/runtime/", import.meta.url),
);
const deployed = process.env.FRAMELEAF_DEPLOYED_SERVER;
test(
  "actual emitted pruned helper resolves owned implementation and long-offset authored golden",
  { skip: !deployed && "Requires actual pnpm deployed server, no substitute" },
  async () => {
    await verifyStudioSubtitleRuntime(deployed, canonical);
  },
);
for (const missing of ["subtitle-sidecar.mjs", "subtitle-sidecar.d.mts"])
  test(`missing ${missing} refuses before execution`, async () => {
    const root = await mkdtemp(
      path.join(os.tmpdir(), "fl105-package-negative-"),
    );
    try {
      await mkdir(path.join(root, "resources/studio"), { recursive: true });
      for (const name of ["subtitle-sidecar.mjs", "subtitle-sidecar.d.mts"])
        if (name !== missing)
          await cp(
            path.join(canonical, name),
            path.join(root, "resources/studio", name),
          );
      await assert.rejects(verifyStudioSubtitleRuntime(root, canonical), {
        code: "ENOENT",
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
test("tampered packaged producer refuses without opening emitted helper", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "fl105-package-negative-"));
  try {
    await cp(canonical, path.join(root, "resources/studio"), {
      recursive: true,
    });
    const file = path.join(root, "resources/studio/subtitle-sidecar.mjs");
    await writeFile(file, (await readFile(file, "utf8")) + "\n// tampered\n");
    await assert.rejects(
      verifyStudioSubtitleRuntime(root, canonical),
      /differs from owned/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
