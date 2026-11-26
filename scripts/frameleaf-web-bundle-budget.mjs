#!/usr/bin/env node
/**
 * FL-139 (QA-103): a hardware-free performance budget for the web app. For every route it measures
 * the JavaScript and CSS the browser must load before the page can show (the client entry, the
 * route's layouts and its page, with their static imports; lazy `import()` chunks are left out),
 * gzipped, and holds it to the limit committed in web/bundle-budget.json. The translated messages
 * are measured too, each bundle as its largest language (`messages/core`, `messages/settings`, ...).
 *
 * FL-1799: the limits are limits. A route over its limit fails the check, and a limit only goes up
 * through `--raise` with a reason, which is recorded in the file for review.
 *
 *   node scripts/frameleaf-web-bundle-budget.mjs                      check web/ against its limits
 *   node scripts/frameleaf-web-bundle-budget.mjs --raise "FL-1: why"  lift the limits of routes over
 *                                                                     theirs (and add new routes),
 *                                                                     recording the reason
 *   node scripts/frameleaf-web-bundle-budget.mjs --lower              bring limits down to today's
 *                                                                     sizes after a reduction
 *   node scripts/frameleaf-web-bundle-budget.mjs --measure out.json   write today's sizes, change nothing
 *
 * Run after `vite build` in web/.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";

/** A limit is set this far above the size measured when it is set, so small changes fit. */
export const HEADROOM = 0.02;

const limitFor = (size) => Math.ceil(size * (1 + HEADROOM));

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

/**
 * FL-1797: the translated messages are lazy chunks, one per language and bundle (`core` at startup,
 * an area's when its routes open). Each bundle is held to a limit as its largest language, under
 * `messages/<bundle>`, so a growing `core` fails the check like a growing route does.
 */
export const measureMessages = ({ manifest, sizeOf }) => {
  const sizes = {};
  for (const [key, chunk] of Object.entries(manifest)) {
    const bundle = /^virtual:frameleaf-messages\/[^/]+\/([^/]+)$/.exec(
      key,
    )?.[1];
    if (bundle) {
      const name = `messages/${bundle}`;
      sizes[name] = Math.max(sizes[name] ?? 0, sizeOf(chunk.file));
    }
  }
  return sizes;
};

/** The routes over their limit, and those added or gone since the limits were set. */
export const compare = (limits, sizes) => {
  const over = [];
  for (const [route, size] of Object.entries(sizes)) {
    const limit = limits[route];
    if (limit !== undefined && size > limit) {
      over.push({ route, size, limit });
    }
  }
  const added = Object.keys(sizes).filter(
    (route) => limits[route] === undefined,
  );
  const removed = Object.keys(limits).filter(
    (route) => sizes[route] === undefined,
  );
  return { over, added, removed };
};

const sorted = (limits) =>
  Object.fromEntries(
    Object.entries(limits).sort(([a], [b]) => a.localeCompare(b)),
  );

/**
 * The budget after lifting the limit of every route over its own, adding new routes and dropping
 * those no longer built. The reason must name the issue the growth belongs to; it is recorded with
 * how many routes rose and by how much.
 */
export const raise = (budget, sizes, reason, date) => {
  if (!/[A-Z]+-\d+\b.*\S/.test(reason ?? "")) {
    throw new Error(
      'a raise needs a reason that names its issue, e.g. --raise "FL-123: the new editor toolbar"',
    );
  }
  const { over, added, removed } = compare(budget.limits, sizes);
  if (over.length === 0 && added.length === 0 && removed.length === 0) {
    return budget;
  }
  const limits = { ...budget.limits };
  let bytes = 0;
  for (const { route, size, limit } of over) {
    limits[route] = limitFor(size);
    bytes += limits[route] - limit;
  }
  for (const route of added) {
    limits[route] = limitFor(sizes[route]);
  }
  for (const route of removed) {
    delete limits[route];
  }
  return {
    limits: sorted(limits),
    raises: [
      ...(budget.raises ?? []),
      {
        date,
        reason,
        raised: over.length,
        bytes,
        added: added.length,
        removed: removed.length,
      },
    ],
  };
};

/** The budget with every limit that has more room than the headroom brought down to today's size. */
export const lower = (budget, sizes) => {
  const limits = { ...budget.limits };
  for (const [route, size] of Object.entries(sizes)) {
    if (limits[route] !== undefined && limitFor(size) < limits[route]) {
      limits[route] = limitFor(size);
    }
  }
  return { ...budget, limits: sorted(limits) };
};

const kb = (bytes) => `${(bytes / 1024).toFixed(1)} KB`;

const main = () => {
  const web = join(fileURLToPath(new URL("..", import.meta.url)), "web");
  const client = join(web, ".svelte-kit/output/client");
  const manifest = JSON.parse(
    readFileSync(join(client, ".vite/manifest.json"), "utf8"),
  );
  const app = Object.keys(manifest).find(
    (key) => manifest[key].isEntry && key.endsWith("/app.js"),
  );
  if (!app) throw new Error("the manifest has no generated app entry");
  const dictionary = parseDictionary(readFileSync(join(web, app), "utf8"));
  const sizeOf = (file) => gzipSync(readFileSync(join(client, file))).length;
  const sizes = {
    ...measure({ manifest, dictionary, sizeOf }),
    ...measureMessages({ manifest, sizeOf }),
  };
  const budgetPath = join(web, "bundle-budget.json");
  const write = (budget) =>
    writeFileSync(budgetPath, `${JSON.stringify(budget, null, 2)}\n`);
  const option = (name) => {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : (process.argv[index + 1] ?? "");
  };

  const measureTo = option("--measure");
  if (measureTo !== undefined) {
    writeFileSync(measureTo, `${JSON.stringify(sorted(sizes), null, 2)}\n`);
    console.log(`wrote today's sizes to ${measureTo}`);
    return;
  }

  const budget = JSON.parse(readFileSync(budgetPath, "utf8"));
  const reason = option("--raise");
  if (reason !== undefined) {
    const raised = raise(
      budget,
      sizes,
      reason,
      new Date().toISOString().slice(0, 10),
    );
    if (raised === budget) {
      console.log("every route is within its limit: nothing to raise");
      return;
    }
    write(raised);
    const { raised: count, bytes, added, removed } = raised.raises.at(-1);
    console.log(
      `raised ${count} limits by ${kb(bytes)} in all, added ${added} routes, removed ${removed}; reason recorded in web/bundle-budget.json`,
    );
    return;
  }
  if (process.argv.includes("--lower")) {
    write(lower(budget, sizes));
    console.log("lowered the limits to today's sizes where they had room");
    return;
  }

  const { over, added, removed } = compare(budget.limits, sizes);
  for (const { route, size, limit } of over) {
    console.error(
      `${route}: loads ${kb(size)} up front, over its limit of ${kb(limit)} by ${kb(size - limit)}`,
    );
  }
  for (const route of added) {
    console.error(`${route}: new route with no limit yet`);
  }
  for (const route of removed) {
    console.error(`${route}: has a limit but is no longer built`);
  }
  if (over.length > 0 || added.length > 0 || removed.length > 0) {
    console.error(
      'Load less up front (a lazy `import()` is not counted), or, when the growth is intended, run `node scripts/frameleaf-web-bundle-budget.mjs --raise "FL-123: why"` after a web build and commit web/bundle-budget.json with the reason.',
    );
    process.exit(1);
  }
  console.log(
    `initial load within its limit on all ${Object.keys(sizes).length} routes`,
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main();
}
