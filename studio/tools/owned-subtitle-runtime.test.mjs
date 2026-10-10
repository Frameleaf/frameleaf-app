import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SUBTITLE_RUNTIME_FILES,
  copySubtitleSidecarRuntime,
} from "./owned-subtitle-runtime.mjs";
const canonical = new URL("../runtime/", import.meta.url);
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "fl105-owned-runtime-"));
  const studio = path.join(root, "studio");
  await mkdir(path.join(studio, "runtime"), { recursive: true });
  for (const name of SUBTITLE_RUNTIME_FILES)
    await copyFile(
      new URL(name, canonical),
      path.join(studio, "runtime", name),
    );
  return { root, studio, output: path.join(root, "output") };
}
test("literal canonical module/declaration copies and replaces stale regular outputs", async () => {
  const f = await fixture();
  try {
    await copySubtitleSidecarRuntime(f.studio, f.output, f.root);
    await writeFile(path.join(f.output, SUBTITLE_RUNTIME_FILES[0]), "stale");
    const result = await copySubtitleSidecarRuntime(f.studio, f.output, f.root);
    assert.equal(result.length, 2);
    for (const name of SUBTITLE_RUNTIME_FILES)
      assert.deepEqual(
        await readFile(path.join(f.output, name)),
        await readFile(new URL(name, canonical)),
      );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
for (const mode of ["missing", "symlink", "directory"])
  test(`both inputs preflight before outputs for ${mode} second file`, async () => {
    const f = await fixture();
    try {
      const second = path.join(f.studio, "runtime", SUBTITLE_RUNTIME_FILES[1]);
      await rm(second);
      if (mode === "symlink")
        await symlink(new URL(SUBTITLE_RUNTIME_FILES[1], canonical), second);
      if (mode === "directory") await mkdir(second);
      await assert.rejects(
        copySubtitleSidecarRuntime(f.studio, f.output, f.root),
      );
      await assert.rejects(lstat(f.output), { code: "ENOENT" });
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  });
test("refuses an output file symlink before replacing either existing output", async () => {
  const f = await fixture();
  try {
    await mkdir(f.output);
    await writeFile(
      path.join(f.output, SUBTITLE_RUNTIME_FILES[0]),
      "untouched",
    );
    await symlink(
      new URL(SUBTITLE_RUNTIME_FILES[1], canonical),
      path.join(f.output, SUBTITLE_RUNTIME_FILES[1]),
    );
    await assert.rejects(
      copySubtitleSidecarRuntime(f.studio, f.output, f.root),
    );
    assert.equal(
      await readFile(path.join(f.output, SUBTITLE_RUNTIME_FILES[0]), "utf8"),
      "untouched",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
test("refuses escaping destination and linked output ancestry before touching foreign files", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      copySubtitleSidecarRuntime(
        f.studio,
        path.join(f.root, "../escape"),
        f.root,
      ),
      /escapes/,
    );
    const foreign = path.join(f.root, "foreign");
    await mkdir(foreign);
    await symlink(foreign, f.output);
    await assert.rejects(
      copySubtitleSidecarRuntime(
        f.studio,
        path.join(f.output, "nested"),
        f.root,
      ),
    );
    await assert.rejects(lstat(path.join(foreign, "nested")), {
      code: "ENOENT",
    });
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
