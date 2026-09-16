import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

await test("repairs enum defaults using actual member names and is idempotent", async () => {
  const directory = await mkdtemp(join(tmpdir(), "immich-dart-enums-"));
  const path = join(directory, "model.dart");
  const source = `enum Example {
  first._(r'first'),
  renamedValue._(r'renamed-value');
}
const first = const Example._('first');
const last = const Example._('renamed-value');
const other = const Other._('first');
`;
  try {
    await writeFile(path, source);
    const script = new URL("./patch-dart-enum-defaults.mjs", import.meta.url);
    const expected = source
      .replace("const Example._('first')", "Example.first")
      .replace("const Example._('renamed-value')", "Example.renamedValue");
    for (let run = 0; run < 2; run++) {
      execFileSync(process.execPath, [script.pathname, directory]);
      assert.equal(await readFile(path, "utf8"), expected);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
