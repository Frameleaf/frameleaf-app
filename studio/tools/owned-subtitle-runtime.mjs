import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

export const SUBTITLE_RUNTIME_FILES = [
  "subtitle-sidecar.mjs",
  "subtitle-sidecar.d.mts",
];
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Copy owned pure source, never resource approval or external inputs. Preflight both first. */
export async function copySubtitleSidecarRuntime(
  studio,
  destination,
  ownedRoot,
) {
  assert.ok(
    (await lstat(studio)).isDirectory(),
    "Owned Studio root must be a regular directory",
  );
  const source = path.join(await realpath(studio), "runtime");
  assert.ok(
    (await lstat(source)).isDirectory(),
    "Owned runtime must be a regular directory",
  );
  assert.equal(
    await realpath(source),
    source,
    "Owned runtime directory cannot use symlinks",
  );
  const inputs = [];
  for (const name of SUBTITLE_RUNTIME_FILES) {
    const file = path.join(source, name);
    assert.ok(
      (await lstat(file)).isFile(),
      `Owned runtime must be a regular file: ${name}`,
    );
    assert.equal(
      await realpath(file),
      file,
      `Owned runtime cannot use symlinks: ${name}`,
    );
    const bytes = await readFile(file);
    inputs.push({ name, file, bytes, sha256: sha256(bytes) });
  }
  // Neither output is created if either input is missing, irregular or escaping.
  assert.equal(
    typeof ownedRoot,
    "string",
    "An owned destination root is required",
  );
  const relative = path.relative(
    path.resolve(ownedRoot),
    path.resolve(destination),
  );
  assert.ok(
    relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative),
    "Runtime destination escapes owned root",
  );
  await mkdir(ownedRoot, { recursive: true });
  assert.ok(
    (await lstat(ownedRoot)).isDirectory(),
    "Owned output root must be a regular directory",
  );
  let output = await realpath(ownedRoot);
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    output = path.join(output, segment);
    await mkdir(output, { recursive: true });
    assert.ok(
      (await lstat(output)).isDirectory(),
      "Runtime output ancestry must be regular directories",
    );
    assert.equal(
      await realpath(output),
      output,
      "Runtime output ancestry cannot use symlinks",
    );
  }
  for (const { name } of inputs) {
    try {
      assert.ok(
        (await lstat(path.join(output, name))).isFile(),
        `Owned runtime output must be regular: ${name}`,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const input of inputs) {
    const file = path.join(output, input.name);
    await writeFile(file, input.bytes);
    assert.equal(
      sha256(await readFile(file)),
      input.sha256,
      `Owned runtime copy differs: ${input.name}`,
    );
    assert.equal(
      sha256(await readFile(input.file)),
      input.sha256,
      `Owned runtime changed during copy: ${input.name}`,
    );
  }
  return inputs.map(({ name, sha256 }) => ({ name, sha256 }));
}
