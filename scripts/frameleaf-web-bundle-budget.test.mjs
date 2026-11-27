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
  lower,
  measure,
  parseDictionary,
  raise,
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
      JSON.stringify({ limits: { "/": 4096 }, raises: [] }),
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

test("fails a route over its limit, with no margin, and names new and removed routes", () => {
  const { over, added, removed } = compare(
    { "/a": 10_000, "/b": 10_000, "/gone": 1 },
    { "/a": 10_000, "/b": 10_001, "/new": 5 },
  );
  assert.deepEqual(
    over.map(({ route }) => route),
    ["/b"],
  );
  assert.deepEqual(added, ["/new"]);
  assert.deepEqual(removed, ["/gone"]);
});

test("raises only what is over, with a reason that names its issue, and records it", () => {
  const budget = {
    limits: { "/a": 10_000, "/b": 10_000, "/gone": 1 },
    raises: [],
  };
  const sizes = { "/a": 9000, "/b": 11_000, "/new": 100 };
  assert.throws(() => raise(budget, sizes, undefined, "2026-11-26"), /reason/);
  assert.throws(
    () => raise(budget, sizes, "bigger now", "2026-11-26"),
    /reason/,
  );
  assert.throws(() => raise(budget, sizes, "FL-1", "2026-11-26"), /reason/);
  assert.throws(() => raise(budget, sizes, "FL-1:", "2026-11-26"), /reason/);
  assert.throws(
    () => raise(budget, sizes, "oops FL-1 grew", "2026-11-26"),
    /reason/,
  );
  const raised = raise(budget, sizes, "FL-1: the new toolbar", "2026-11-26");
  // the route with room keeps its limit; the others get today's size plus the headroom
  assert.deepEqual(raised.limits, { "/a": 10_000, "/b": 11_220, "/new": 102 });
  assert.deepEqual(raised.raises, [
    {
      date: "2026-11-26",
      reason: "FL-1: the new toolbar",
      raised: 1,
      bytes: 1220,
      added: 1,
      removed: 1,
      routes: { "/b": 1220 },
    },
  ]);
  // nothing over: nothing changes and nothing is recorded
  assert.equal(raise(raised, sizes, "FL-2: again", "2026-11-27"), raised);
});

test("lowers limits to today's sizes and never lifts one", () => {
  const budget = { limits: { "/a": 10_000, "/b": 10_000 }, raises: [] };
  assert.deepEqual(lower(budget, { "/a": 5000, "/b": 11_000 }).limits, {
    "/a": 5100,
    "/b": 10_000,
  });
});
