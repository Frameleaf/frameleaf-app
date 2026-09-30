#!/usr/bin/env node
/**
 * FL-139 (QA-103): a hardware-free performance budget for the web app. For every route it measures
 * the JavaScript and CSS the browser must load before the page can show (the client entry, the
 * route's layouts and its page, with their static imports; lazy `import()` chunks are left out),
 * gzipped, and holds it to the committed baseline plus a margin.
 *
 *   node scripts/frameleaf-web-bundle-budget.mjs            check web/ against web/bundle-budget.json
 *   node scripts/frameleaf-web-bundle-budget.mjs --update   write today's sizes as the new baseline
 *
 * Run after `vite build` in web/. When a route grows on purpose, update the baseline in the same
 * change so the growth is reviewed.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** A route may grow this much over its baseline before the budget fails. */
export const MARGIN = { ratio: 0.05, bytes: 4096 };

/** The route → node table SvelteKit generates: `"/(user)/photos": [page, [layouts...]]`. */
export const parseDictionary = (appJs) => {
  const body = /export const dictionary = \{([\S\s]*?)\n\t*\};/.exec(
    appJs,
  )?.[1];
  if (!body) {
    throw new Error("no route dictionary in the generated app.js");
  }
  const routes = {};
  for (const [, route, entry] of body.matchAll(
    // one route per line; the last has no newline after it inside the captured body
    /"([^"]+)":\s*(\[[^\n]*\]),?(?=\n|$)/g,
  )) {
    // `~7` marks a layout without a load function (the node is the same), and the arrays are sparse
    // (`[,4]`: no error page at that level), which JSON spells null
    const [page, layouts = []] = JSON.parse(
      entry.replaceAll("~", "").replaceAll(/(?<=[,[])(?=[,\]])/g, "null"),
    );
    routes[route] = {
      page,
      layouts: layouts.filter((layout) => layout !== null),
    };
  }
  return routes;
};

/** Every file a manifest entry loads up front: itself, its CSS, and the same for its static imports. */
export const staticClosure = (manifest, keys) => {
  const files = new Set();
  const seen = new Set();
  const visit = (key) => {
    if (seen.has(key)) {
      return;
    }
    seen.add(key);
    const chunk = manifest[key];
    if (!chunk) {
      throw new Error(`the manifest has no chunk ${key}`);
    }
    files.add(chunk.file);
    for (const css of chunk.css ?? []) {
      files.add(css);
    }
    for (const imported of chunk.imports ?? []) {
      visit(imported);
    }
  };
  for (const key of keys) {
    visit(key);
  }
  return files;
};

/** Gzipped bytes each route loads up front, by route. */
export const measure = ({ manifest, dictionary, sizeOf }) => {
  const entries = Object.keys(manifest).filter(
    (key) =>
      manifest[key].isEntry &&
      /\/(entry|app)\.js$/.test(key) &&
      !key.includes("/nodes/"),
  );
  const node = (index) => {
    const key = Object.keys(manifest).find((candidate) =>
      candidate.endsWith(`/nodes/${index}.js`),
    );
    if (!key) {
      throw new Error(`the manifest has no node ${index}`);
    }
    return key;
  };
  const sizes = {};
  for (const [route, { page, layouts }] of Object.entries(dictionary)) {
    const files = staticClosure(manifest, [
      ...entries,
      node(0),
      ...layouts.map(node),
      node(page),
    ]);
    sizes[route] = [...files].reduce((total, file) => total + sizeOf(file), 0);
  }
  return sizes;
};

/** The routes over budget, and those added or gone since the baseline. */
export const compare = (baseline, sizes, margin = MARGIN) => {
  const over = [];
  for (const [route, size] of Object.entries(sizes)) {
    const allowed = baseline[route];
    if (allowed === undefined) {
      continue;
    }
    const limit = Math.max(
      Math.round(allowed * (1 + margin.ratio)),
      allowed + margin.bytes,
    );
    if (size > limit) {
      over.push({ route, size, baseline: allowed, limit });
    }
  }
  const added = Object.keys(sizes).filter(
    (route) => baseline[route] === undefined,
  );
  const removed = Object.keys(baseline).filter(
    (route) => sizes[route] === undefined,
  );
  return { over, added, removed };
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const main = () => {
  const web = join(fileURLToPath(new URL("..", import.meta.url)), "web");
  const client = join(web, ".svelte-kit/output/client");
  const manifest = JSON.parse(
    readFileSync(join(client, ".vite/manifest.json"), "utf8"),
  );
  const dictionary = parseDictionary(
    readFileSync(
      join(web, ".svelte-kit/generated/client-optimized/app.js"),
      "utf8",
    ),
  );
  const sizes = measure({
    manifest,
    dictionary,
    sizeOf: (file) => gzipSync(readFileSync(join(client, file))).length,
  });
  const baselinePath = join(web, "bundle-budget.json");

  if (process.argv.includes("--update")) {
    const sorted = Object.fromEntries(
      Object.entries(sizes).sort(([a], [b]) => a.localeCompare(b)),
    );
    writeFileSync(baselinePath, `${JSON.stringify(sorted, null, 2)}\n`);
    console.log(
      `wrote the initial-load baseline for ${Object.keys(sorted).length} routes to web/bundle-budget.json`,
    );
    return;
  }

  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const { over, added, removed } = compare(baseline, sizes);
  for (const { route, size, baseline: allowed, limit } of over) {
    console.error(
      `${route}: loads ${kb(size)} up front, over its budget of ${kb(limit)} (baseline ${kb(allowed)})`,
    );
  }
  for (const route of added) {
    console.error(`${route}: new route with no budget yet`);
  }
  for (const route of removed) {
    console.error(`${route}: in the budget but no longer built`);
  }
  if (over.length > 0 || added.length > 0 || removed.length > 0) {
    console.error(
      "If the change is intended, run `node scripts/frameleaf-web-bundle-budget.mjs --update` after a web build and commit web/bundle-budget.json.",
    );
    process.exit(1);
  }
  console.log(
    `initial load within budget on all ${Object.keys(sizes).length} routes`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
