import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const routesRoot = resolve(root, "web/src/routes");
const inventory = JSON.parse(
  readFileSync(
    resolve(root, "docs/docs/developer/frameleaf-route-inventory.json"),
    "utf8",
  ),
);
const evidence = JSON.parse(
  readFileSync(
    resolve(
      root,
      "docs/docs/developer/frameleaf-plan/preservation-source-evidence.json",
    ),
    "utf8",
  ),
);

function pageFiles(directory, result = []) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) pageFiles(path, result);
    else if (/^\+page\.(?:svelte|ts)$/.test(entry.name)) result.push(path);
  }
  return result;
}

function routeForPage(path) {
  const segments = relative(routesRoot, dirname(path))
    .split(sep)
    .filter((segment) => segment && !/^\(.+\)$/.test(segment));
  return `/${segments.join("/")}`;
}

test("committed Svelte routes exactly match the accepted 83-route inventory", () => {
  const actual = [...new Set(pageFiles(routesRoot).map(routeForPage))].sort();
  assert.equal(actual.length, 83);
  assert.deepEqual(actual, [...inventory.productionRoutes].sort());
});

test("dirty-only evidence remains separate and complete", () => {
  assert.equal(inventory.dirtyOnlyEvidence.length, 11);
  assert.equal(new Set(inventory.dirtyOnlyEvidence).size, 11);
  assert.deepEqual(
    inventory.dirtyOnlyEvidence.filter((route) =>
      inventory.productionRoutes.includes(route),
    ),
    [],
  );
  assert.equal(
    inventory.dirtyOnlyStatus,
    "absent-from-clean-baseline-unreviewed",
  );
});

test("ownership evidence covers all 94 routes and nine shared loaders", () => {
  const accepted = [
    ...inventory.productionRoutes,
    ...inventory.dirtyOnlyEvidence,
  ].sort();
  assert.deepEqual(evidence.routes.map(({ id }) => id).sort(), accepted);
  const loaders = new Set(evidence.routes.flatMap(({ loaders }) => loaders));
  assert.equal(loaders.size, 9);
});
