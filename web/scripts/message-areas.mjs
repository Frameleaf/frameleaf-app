/**
 * FL-1797: splits the translated messages by the part of the app that uses them, as a build step.
 *
 * `i18n/<language>.json` stays one file per language, edited as before (and by every other change
 * that adds a key). At build time this module reads the web source, follows the imports from each
 * group of routes and gives every key to one bundle:
 *  - `core`: named by anything the shell or a page outside the areas below can reach, or by a
 *    route's load function. Loaded at startup, on every page, the sign-in page included;
 *  - an area (`settings`, `studio`, ...): named only by code that area's routes reach. Loaded
 *    when one of its routes is first opened;
 *  - `rest`: named by nothing the app can reach. Fetched only if a page asks for a key that the
 *    bundles it has loaded do not hold, so a key this analysis placed wrongly repairs itself.
 *
 * A key is "named" by a file that holds it as a whole word, or that builds it with a template
 * literal whose fixed parts match it (a title key followed by `_description`).
 *
 * A language that translates at least half the keys gets English merged into its bundles for the
 * keys it lacks, so its readers fetch one file per area and never the English one as well. Smaller
 * languages keep only their own messages and read the English bundle beside them.
 *
 * Used by vite.config.ts (the `virtual:frameleaf-messages` modules) and by message-areas.spec.ts.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * The route folders (under src/routes) of each area; every other route is the core shell. Imports
 * are pages of Settings, so they travel with it.
 */
export const AREAS = {
  settings: ['(user)/user-settings', 'admin'],
  studio: ['(user)/studio', 'studio'],
  clients: ['(user)/photography', 'photography'],
  boards: ['(user)/pro'],
};

/** Every bundle a language can have, in the order the app asks for them. */
export const BUNDLES = ['core', ...Object.keys(AREAS), 'rest'];

/** Nested message files as one level of dotted keys, which is how the app looks them up. */
export const flatten = (messages, prefix = '', out = {}) => {
  for (const [key, value] of Object.entries(messages)) {
    if (value && typeof value === 'object') {
      flatten(value, `${prefix}${key}.`, out);
    } else {
      out[prefix + key] = value;
    }
  }
  return out;
};

const SOURCE = /\.(svelte|ts|js)$/;
const SKIP = /(\.(spec|test)\.ts$)|\/(test-data|__mocks__|__tests__)\//;

const walk = (directory, out = []) => {
  for (const name of readdirSync(directory)) {
    const file = path.join(directory, name);
    if (statSync(file).isDirectory()) {
      walk(file, out);
    } else if (SOURCE.test(name) && !SKIP.test(file)) {
      out.push(file);
    }
  }
  return out;
};

const IMPORT = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"\n]+)\1/g;

const resolver = (src) => {
  const lib = path.join(src, 'lib');
  return (from, specifier) => {
    let base;
    if (specifier.startsWith('$lib/')) {
      base = path.join(lib, specifier.slice(5));
    } else if (specifier.startsWith('.')) {
      base = path.resolve(path.dirname(from), specifier);
    } else {
      return;
    }
    for (const candidate of [base, `${base}.ts`, `${base}.js`, `${base}.svelte.ts`, path.join(base, 'index.ts')]) {
      if (existsSync(candidate) && statSync(candidate).isFile()) {
        return candidate;
      }
    }
  };
};

/** Whole words that could be a key. */
const TOKEN = /[A-Za-z0-9_.]+/g;
const TEMPLATE = /`([^`\n]*\$\{[^`\n]*)`/g;
const escape = (text) => text.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);

/** A template literal as a pattern over keys, when its fixed parts look like part of a key. */
const templatePattern = (body) => {
  const parts = body.split(/\$\{[^}]*\}/);
  const fixed = parts.join('');
  if (fixed.length < 4 || !/^[A-Za-z0-9_.]+$/.test(fixed) || !fixed.includes('_')) {
    return;
  }
  return new RegExp(`^${parts.map((part) => escape(part)).join('.+')}$`);
};

/**
 * The bundle of every key: `areaOf[key]` is 'core', an area or 'rest'. `reached` is the source
 * files each group of routes can load, for the spec that walks them.
 */
export const analyse = ({ src, keys }) => {
  src = path.resolve(src);
  const files = walk(src);
  const resolve = resolver(src);
  const keySet = new Set(keys);
  const imports = new Map();
  const literal = new Map(); // file -> keys
  const patterns = []; // [file, RegExp]
  const joins = []; // [file, prefix, suffix, words]: a template with one placeholder, too short for a pattern
  for (const file of files) {
    const text = readFileSync(file, 'utf8');
    const targets = new Set();
    for (const [, , specifier] of text.matchAll(IMPORT)) {
      const target = resolve(file, specifier);
      if (target) {
        targets.add(target);
      }
    }
    imports.set(file, targets);
    const found = new Set();
    for (const token of text.match(TOKEN) ?? []) {
      if (keySet.has(token)) {
        found.add(token);
      }
    }
    literal.set(file, found);
    let words;
    for (const [, body] of text.matchAll(TEMPLATE)) {
      const pattern = templatePattern(body);
      if (pattern) {
        patterns.push([file, pattern]);
        continue;
      }
      // `${base}_by`: too short to match keys on its own, so join it to the words of the same file,
      // where its base is written out (`'frameleaf_ledger_deleted'`).
      const parts = body.split(/\$\{[^}]*\}/);
      if (parts.length === 2 && /^[A-Za-z0-9_.]*$/.test(parts.join('')) && parts.join('').length > 0) {
        words ??= new Set(text.match(TOKEN) ?? []);
        joins.push([file, parts[0], parts[1], words]);
      }
    }
  }
  // keys named only through a template literal
  const users = new Map(); // key -> Set<file>
  const use = (key, file) => {
    let set = users.get(key);
    if (!set) {
      users.set(key, (set = new Set()));
    }
    set.add(file);
  };
  for (const [file, found] of literal) {
    for (const key of found) {
      use(key, file);
    }
  }
  const sources = patterns.map(([file, pattern]) => [file, pattern.source]);
  const unique = new Map();
  for (const [file, source] of sources) {
    let set = unique.get(source);
    if (!set) {
      unique.set(source, (set = new Set()));
    }
    set.add(file);
  }
  for (const [source, patternFiles] of unique) {
    const pattern = new RegExp(source);
    for (const key of keys) {
      if (pattern.test(key)) {
        for (const file of patternFiles) {
          use(key, file);
        }
      }
    }
  }

  for (const [file, prefix, suffix, words] of joins) {
    for (const word of words) {
      const key = `${prefix}${word}${suffix}`;
      if (keySet.has(key)) {
        use(key, file);
      }
    }
  }

  const routes = path.join(src, 'routes');
  const areaOfFile = (file) => {
    const relative = path.relative(routes, file).split(path.sep).join('/');
    if (relative.startsWith('..')) {
      return;
    }
    for (const [area, prefixes] of Object.entries(AREAS)) {
      if (prefixes.some((prefix) => relative.startsWith(`${prefix}/`))) {
        return area;
      }
    }
    return 'core';
  };
  const reach = (entries) => {
    const seen = new Set(entries);
    const queue = [...entries];
    while (queue.length > 0) {
      for (const target of imports.get(queue.pop()) ?? []) {
        if (!seen.has(target)) {
          seen.add(target);
          queue.push(target);
        }
      }
    }
    return seen;
  };
  const isLoad = (file) => /\/\+(page|layout)(\.server)?\.ts$/.test(file);
  const entries = { core: [] };
  for (const area of Object.keys(AREAS)) {
    entries[area] = [];
  }
  const loadFiles = new Set();
  for (const file of files) {
    const area = areaOfFile(file);
    if (area) {
      entries[area].push(file);
      if (isLoad(file)) {
        loadFiles.add(file);
      }
    }
  }
  // app-level files outside routes that always run
  for (const name of ['hooks.client.ts', 'hooks.ts', 'service-worker/index.ts']) {
    const file = path.join(src, name);
    if (existsSync(file)) {
      entries.core.push(file);
    }
  }
  const reached = Object.fromEntries(Object.entries(entries).map(([area, list]) => [area, reach(list)]));
  const areaOf = {};
  for (const key of keys) {
    const keyUsers = users.get(key);
    if (!keyUsers) {
      areaOf[key] = 'rest';
      continue;
    }
    const list = [...keyUsers];
    if (list.some((file) => reached.core.has(file) || loadFiles.has(file))) {
      areaOf[key] = 'core';
      continue;
    }
    const areas = Object.keys(AREAS).filter((area) => list.some((file) => reached[area].has(file)));
    areaOf[key] = areas.length === 1 ? areas[0] : areas.length === 0 ? 'rest' : 'core';
  }
  return { areaOf, reached, literal };
};

/** The language codes with a message file, in name order. */
export const languageCodes = (directory) =>
  readdirSync(directory)
    .filter((name) => /^\w+\.json$/.test(name))
    .map((name) => name.slice(0, -5))
    .sort();

/** One language's messages by dotted key, without the ones left empty. */
export const readLanguage = (directory, code) =>
  Object.fromEntries(
    Object.entries(flatten(JSON.parse(readFileSync(path.join(directory, `${code}.json`), 'utf8')))).filter(
      ([, message]) => message !== '',
    ),
  );

/**
 * One language's bundles. `areaOf` is from `analyse`; without it every message is in `core`
 * (the development server and unit tests, where the split is not worth a source scan per change).
 */
export const bundlesFor = ({ code, own, en, areaOf }) => {
  const translated = Object.keys(en).filter((key) => key in own).length;
  const merged = code !== 'en' && translated * 2 >= Object.keys(en).length;
  const bundles = {};
  // English decides which keys exist: a key it dropped is dropped from every language.
  for (const key of Object.keys(en)) {
    const message = own[key] ?? (merged ? en[key] : undefined);
    if (message !== undefined) {
      const bundle = areaOf?.[key] ?? 'core';
      (bundles[bundle] ??= {})[key] = message;
    }
  }
  return { merged, bundles };
};
