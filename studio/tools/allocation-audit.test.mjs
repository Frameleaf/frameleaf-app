import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";

async function inspect(source, sites = []) {
  const temporary = await realpath(
    await mkdtemp(path.join(os.tmpdir(), "allocation-audit-")),
  );
  try {
    await mkdir(path.join(temporary, "tools"));
    await mkdir(path.join(temporary, "engine/src/runtime"), {
      recursive: true,
    });
    await writeFile(
      path.join(temporary, "tools/allocation-audit.mjs"),
      await readFile(new URL("./allocation-audit.mjs", import.meta.url)),
    );
    await writeFile(
      path.join(temporary, "engine/src/runtime/intermediate.ts"),
      source,
    );
    await writeFile(
      path.join(temporary, "graph-allocation-audit.json"),
      JSON.stringify({ sites }),
    );
    const { audit } = await import(
      pathToFileURL(path.join(temporary, "tools/allocation-audit.mjs")).href
    );
    return await audit();
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("rejects an undeclared texture format", async () => {
  const result = await inspect(
    "const descriptor = { format: 'rgba8unorm' };\n",
  );
  assert.equal(result.sites.length, 1);
  assert.match(result.problems.join("\n"), /Undeclared allocation site/);
});

test("rejects undeclared direct Canvas2D contexts, including optional and double-quoted calls", async () => {
  const result = await inspect(
    [
      "const offscreen = new OffscreenCanvas(2, 2).getContext('2d');",
      'const display = canvas?.getContext( "2d", { willReadFrequently: true });',
    ].join("\n"),
  );
  assert.equal(result.sites.length, 2);
  assert.equal(result.problems.length, 2);
  assert.ok(
    result.problems.every((problem) =>
      problem.startsWith("Undeclared allocation site"),
    ),
  );
});

test("requires exact context declarations and rejects vanished contexts", async () => {
  const code = "const context = canvas.getContext('2d');";
  const site = {
    file: "runtime/intermediate.ts",
    code,
    class: "canvas2d-context",
    reason: "Pixel route remains separately qualified.",
  };
  assert.deepEqual((await inspect(code, [site])).problems, []);
  assert.match(
    (await inspect("const value = 1;", [site])).problems.join("\n"),
    /Declared site no longer present/,
  );
});
