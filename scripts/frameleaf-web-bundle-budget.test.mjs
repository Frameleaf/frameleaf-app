import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  compare,
  measure,
  parseDictionary,
  staticClosure,
} from "./frameleaf-web-bundle-budget.mjs";

test("reads the route table, sparse error-page arrays and layouts without a load included", () => {
  const appJs = `export const dictionary = {
\t\t"/": [9],
\t\t"/(user)/photos": [37,[2],[,4]],
\t\t"/admin": [~64,[~8]],
\t};`;
  assert.deepEqual(parseDictionary(appJs), {
    "/": { page: 9, layouts: [] },
    "/(user)/photos": { page: 37, layouts: [2] },
    "/admin": { page: 64, layouts: [8] },
  });
});

const manifest = {
  "kit/entry.js": { file: "entry.js", isEntry: true, imports: ["_shared.js"] },
  ".svelte-kit/generated/client-optimized/app.js": {
    file: "app.js",
    isEntry: true,
  },
  ".svelte-kit/generated/client-optimized/nodes/0.js": {
    file: "n0.js",
    isEntry: true,
    css: ["root.css"],
  },
  ".svelte-kit/generated/client-optimized/nodes/2.js": {
    file: "n2.js",
    isEntry: true,
    imports: ["_shared.js"],
  },
  ".svelte-kit/generated/client-optimized/nodes/9.js": {
    file: "n9.js",
    isEntry: true,
    imports: ["_page.js"],
    dynamicImports: ["_lazy.js"],
  },
  "_shared.js": { file: "shared.js" },
  "_page.js": { file: "page.js", css: ["page.css"] },
  "_lazy.js": { file: "lazy.js" },
};

test("checks the built app path from a SvelteKit 3 manifest without the old generated directory", () => {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "frameleaf-kit3-budget-")),
  );
  const script = join(root, "scripts/frameleaf-web-bundle-budget.mjs");
  const web = join(root, "web");
  const client = join(web, ".svelte-kit/output/client");
  const generated = join(web, ".svelte-kit/generated/build/client");
  try {
    for (const dir of [
      join(root, "scripts"),
      join(client, ".vite"),
      generated,
    ]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(
      script,
      readFileSync(
        new URL("./frameleaf-web-bundle-budget.mjs", import.meta.url),
      ),
    );
    writeFileSync(
      join(client, ".vite/manifest.json"),
      JSON.stringify(manifest).replaceAll("client-optimized", "build/client"),
    );
    writeFileSync(
      join(generated, "app.js"),
      'export const dictionary = {\n\t"/": [9,[2]],\n\t};',
    );
    for (const chunk of Object.values(manifest)) {
      for (const file of [chunk.file, ...(chunk.css ?? [])])
        writeFileSync(join(client, file), "built content");
    }
    writeFileSync(
      join(web, "bundle-budget.json"),
      JSON.stringify({ "/": 4096 }),
    );
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1 routes/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("counts what loads up front, CSS included, and never a lazy chunk", () => {
  const files = staticClosure(manifest, [
    ".svelte-kit/generated/client-optimized/nodes/9.js",
  ]);
  assert.deepEqual([...files].sort(), ["n9.js", "page.css", "page.js"]);
});

test("sums the entry, root layout, route layouts and page for each route, each file once", () => {
  const sizes = measure({
    manifest,
    dictionary: { "/": { page: 9, layouts: [2] } },
    sizeOf: () => 10,
  });
  // entry, app, shared (once), n0, root.css, n2, n9, page, page.css; not lazy
  assert.deepEqual(sizes, { "/": 90 });
});

test("fails a route that grows past its margin, and names new and removed routes", () => {
  const margin = { ratio: 0.05, bytes: 100 };
  const baseline = { "/a": 10_000, "/b": 10_000, "/gone": 1 };
  const { over, added, removed } = compare(
    baseline,
    { "/a": 10_500, "/b": 10_501, "/new": 5 },
    margin,
  );
  assert.deepEqual(
    over.map(({ route }) => route),
    ["/b"],
  );
  assert.deepEqual(added, ["/new"]);
  assert.deepEqual(removed, ["/gone"]);
  // a small route may grow by the byte allowance even when that is more than the ratio
  assert.deepEqual(
    compare({ "/small": 1000 }, { "/small": 1100 }, margin).over,
    [],
  );
});
