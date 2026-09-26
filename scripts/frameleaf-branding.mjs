#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * FL-190 (owner decision 2026-09-26): other than the attribution on the About screen, no user-visible
 * surface names Immich, shows its logo or links its sites. This scan fails on:
 *
 * - the name ("Immich", "IMMICH") in web/src code and markup (comments and specs excluded),
 *   server/src/emails, and every documentation page;
 * - any spelling of it in a translation value (i18n/*.json, every locale);
 * - links to Immich's own sites (immich.app and its subdomains, github.com/immich-app);
 * - a file under web/static or docs/static whose name contains it.
 *
 * Compatibility identifiers stay (AGENTS.md: "do not globally replace immich strings"): API paths,
 * `IMMICH_*` variables, `x-immich-*` headers, `@immich/*` packages, lowercase container, database,
 * binary and folder names, and code identifiers users never see. None of those is the capitalised
 * name or an Immich site, so none needs an entry here. The `ghcr.io/immich-app` images and the
 * `*.immich.cloud` and `huggingface.co/immich-app` hosts are FL-191's, and are not matched either.
 */
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** The product name as a word, in title or upper case (`IMMICH_*` variables continue with `_`). */
export const NAME = /\bImmich\b|\bIMMICH\b/g;
/** Immich's own sites: immich.app and its subdomains, and the immich-app GitHub organisation (and its raw files). */
export const SITES =
  /(?<![\w-])(?:[a-z0-9-]+\.)*immich\.app\b|(?:github|githubusercontent)\.com\/immich-app\b/gi;
/** Any spelling at all; translation values are all user-visible. */
export const ANY = /immich/gi;

/**
 * The explicit allowlist. Each entry names the files it covers, the text it removes before the
 * scan, and why. Nothing else may name Immich.
 */
export const ALLOWLIST = [
  {
    reason: "About attribution: the upstream link and its licence (web)",
    files: /^web\/src\/lib\/components\/frameleaf\/AboutDialog\.svelte$/,
    allow:
      /https:\/\/github\.com\/immich-app\/immich(?:\/blob\/main\/LICENSE)?/g,
  },
  {
    reason:
      "About attribution: the one sentence that names the upstream project (translations)",
    keys: /^frameleaf_about_attribution$/,
    allow: /<upstream>Immich<\/upstream>/g,
  },
  {
    reason:
      "Acknowledgements page: generated attribution and licence notices (scripts/frameleaf-acknowledgements.mjs)",
    files: /^docs\/docs\/overview\/acknowledgements\.md$/,
    allow: /.+/g,
  },
  {
    reason:
      "Developer documentation: the upstream repository address the sync and handoff procedures fetch from",
    files: /^docs\/docs\/developer\//,
    allow: /(?:https:\/\/)?github\.com\/immich-app\/immich(?:\.git)?\b/g,
  },
  {
    reason: "FL-191 owns the map tile host until it is replaced",
    keys: /^admin\.map_implications$/,
    allow: /tiles\.immich\.cloud/g,
  },
];

const blank = (text) => text.replaceAll(/[^\n]/g, " ");

/** Removes comments, keeping line numbers, so that notes for developers are not scanned. */
export function stripComments(text) {
  return text
    .replaceAll(/<!--[\s\S]*?-->/g, blank)
    .replaceAll(/\/\*[\s\S]*?\*\//g, blank)
    .replaceAll(
      /(^|[^:'"`\w\\])(\/\/.*)$/gm,
      (_, before, comment) => before + blank(comment),
    );
}

function allowed(text, { file, key }) {
  let result = text;
  for (const entry of ALLOWLIST) {
    if (entry.files && !(file && entry.files.test(file))) continue;
    if (entry.keys && !(key && entry.keys.test(key))) continue;
    result = result.replaceAll(entry.allow, "");
  }
  return result;
}

/** Every match of the patterns in `text`, after the allowlist, with its line. */
export function scanText(text, patterns, context = {}) {
  const hits = [];
  for (const [index, line] of text.split("\n").entries()) {
    const remaining = allowed(line, context);
    for (const pattern of patterns) {
      for (const match of remaining.matchAll(pattern)) {
        hits.push({ ...context, line: index + 1, match: match[0] });
      }
    }
  }
  return hits;
}

/** Every string of a catalogue with its dotted key, including nested groups such as `admin`. */
export const flatten = (value, prefix = "") =>
  Object.entries(value).flatMap(([key, child]) =>
    child !== null && typeof child === "object"
      ? flatten(child, `${prefix}${key}.`)
      : [[`${prefix}${key}`, String(child)]],
  );

export function scanCatalogue(file, catalogue) {
  return flatten(catalogue).flatMap(([key, value]) =>
    scanText(value, [ANY], { file, key }),
  );
}

const tracked = (...paths) =>
  execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: repository,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

const read = (file) => readFileSync(path.resolve(repository, file), "utf8");

const WEB_SOURCE = /\.(?:svelte|ts|js|html)$/;
const NOT_SHIPPED = /\.(?:spec|test)\.ts$|^web\/src\/test-data\//;
const DOC_PAGE = /\.(?:mdx?|tsx?|jsx?|css)$/;

export function findViolations() {
  const catalogues = tracked("i18n").filter((file) =>
    /^i18n\/[^/]+\.json$/.test(file),
  );
  const web = tracked("web/src").filter(
    (file) => WEB_SOURCE.test(file) && !NOT_SHIPPED.test(file),
  );
  const emails = tracked("server/src/emails").filter(
    (file) => /\.tsx?$/.test(file) && !NOT_SHIPPED.test(file),
  );
  const docs = [
    ...tracked("docs/docs", "docs/src").filter((file) => DOC_PAGE.test(file)),
    "docs/docusaurus.config.js",
  ];
  const assets = tracked("web/static", "docs/static");

  return [
    ...catalogues.flatMap((file) =>
      scanCatalogue(file, JSON.parse(read(file))),
    ),
    ...[...web, ...emails].flatMap((file) =>
      scanText(stripComments(read(file)), [NAME, SITES], { file }),
    ),
    ...docs.flatMap((file) => scanText(read(file), [NAME, SITES], { file })),
    ...assets
      .filter((file) => /immich/i.test(path.basename(file)))
      .map((file) => ({ file, match: path.basename(file) })),
  ];
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findViolations();
  for (const { file, key, line, match } of violations) {
    console.log(
      `${file}${key ? ` ${key}` : ""}${line ? `:${line}` : ""}: ${match}`,
    );
  }
  console.log(`${violations.length} branding violation(s)`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
