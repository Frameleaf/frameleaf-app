#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * FL-190 (owner decision 2026-09-26): other than the attribution on the About screen, no user-visible
 * surface names Immich, shows its logo or original interface, or sends people to its sites, apps or
 * packages. This scan fails on:
 *
 * - the name ("Immich", "IMMICH") in shipped code, outside comments and specs: web/src, server/src
 *   (including its log and error strings and the email templates), packages/cli/src and the machine
 *   learning service (machine-learning/immich_ml, whose package name is an identifier);
 * - the name in every documentation page and the docs config, README.md, CONTRIBUTING.md,
 *   install.sh, the PWA manifest and security.txt;
 * - any spelling of it in a translation value (i18n/*.json, every locale);
 * - links to Immich's own sites (immich.app and its subdomains, the immich-app GitHub organisation
 *   and its raw files) and to its store, marketplace and chart listings;
 * - a file under web/static or docs/static whose name contains it;
 * - a shipped asset that is byte for byte one of the upstream logos or icons
 *   (frameleaf-upstream-logo-hashes.json, taken from git history).
 *
 * Compatibility identifiers stay (AGENTS.md: "do not globally replace immich strings"): API paths,
 * `IMMICH_*` variables, `x-immich-*` headers, `@immich/*` packages, lowercase container, database,
 * binary, module and folder names, and code identifiers users never see (`ImmichLayout`). None of
 * those is the capitalised name as a word or an Immich site, so none needs an entry here. The
 * `ghcr.io/immich-app` images and the `*.immich.cloud` and `huggingface.co/immich-app` hosts are
 * FL-191's and FL-192's, and are not matched either.
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
/** Store, marketplace and chart listings of the upstream apps, and its founder's repositories. */
export const STORES =
  /(?:apps\.apple\.com|play\.google\.com|marketplace\.digitalocean\.com|vultr\.com)\/\S*immich|alextran/gi;
/** Any spelling at all; translation values are all user-visible. */
export const ANY = /immich/gi;

/**
 * The explicit allowlist. Each entry names the files (or translation keys) it covers, the text it
 * removes before the scan, and why. Nothing else may name Immich.
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
      "README licence notice: the attribution AGPL-3.0 requires for the work Frameleaf is built on",
    files: /^README\.md$/,
    allow:
      /^Frameleaf is built on \[Immich\]\(https:\/\/github\.com\/immich-app\/immich\) and the work of its contributors/g,
  },
  {
    reason:
      "Developer documentation: the upstream repository address the sync and handoff procedures fetch from",
    files: /^docs\/docs\/developer\//,
    allow: /(?:https:\/\/)?github\.com\/immich-app\/immich(?:\.git)?\b/g,
  },
  {
    reason:
      "A released migration is never edited; its irreversible down() names the upstream release to restore",
    files:
      /^server\/src\/schema\/migrations\/1779400000000-UpdateWorkflowTables\.ts$/,
    allow: /downgrade to upstream Immich\./g,
  },
];

const blank = (text) => text.replaceAll(/[^\n]/g, " ");

/** Characters after which a `/` starts a regular expression rather than a division. */
const REGEX_PRECEDES = new Set([..."(,=:[!&|?{};+-*%<>~^", ""]);

/**
 * Removes JavaScript/TypeScript comments, keeping line numbers. String, template and regular
 * expression literals are skipped whole, so a `//` or `/*` inside them is never taken for a comment.
 */
export function stripScriptComments(text) {
  let out = "";
  let index = 0;
  let previous = "";
  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];
    if (char === "/" && next === "/") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = text.indexOf("*/", index + 2);
      const stop = end === -1 ? text.length : end + 2;
      out += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (
      char === '"' ||
      char === "'" ||
      char === "`" ||
      (char === "/" && REGEX_PRECEDES.has(previous))
    ) {
      let end = index + 1;
      let inClass = false;
      while (end < text.length) {
        const current = text[end];
        if (current === "\\") {
          end += 2;
          continue;
        }
        if (char === "/" && current === "[") inClass = true;
        else if (char === "/" && current === "]") inClass = false;
        else if (current === char && !inClass) break;
        else if (current === "\n" && char !== "`") break;
        end += 1;
      }
      out += text.slice(index, end + 1);
      index = end + 1;
      previous = char === "/" ? "/regex" : "string";
      continue;
    }
    out += char;
    if (!/\s/.test(char)) previous = char;
    index += 1;
  }
  return out;
}

/** Removes Python comments and docstrings (a triple-quoted string that starts a line). */
export function stripPythonComments(text) {
  let out = "";
  let index = 0;
  let lineStart = true;
  while (index < text.length) {
    const char = text[index];
    const triple = text.slice(index, index + 3);
    if (char === "#") {
      const end = text.indexOf("\n", index);
      const stop = end === -1 ? text.length : end;
      out += blank(text.slice(index, stop));
      index = stop;
      continue;
    }
    if (triple === '"""' || triple === "'''") {
      const end = text.indexOf(triple, index + 3);
      const stop = end === -1 ? text.length : end + 3;
      const literal = text.slice(index, stop);
      out += lineStart ? blank(literal) : literal;
      index = stop;
      lineStart = false;
      continue;
    }
    if (char === '"' || char === "'") {
      let end = index + 1;
      while (end < text.length && text[end] !== char && text[end] !== "\n") {
        end += text[end] === "\\" ? 2 : 1;
      }
      out += text.slice(index, end + 1);
      index = end + 1;
      lineStart = false;
      continue;
    }
    out += char;
    if (char === "\n") lineStart = true;
    else if (!/\s/.test(char)) lineStart = false;
    index += 1;
  }
  return out;
}

/**
 * Removes the comments of a Svelte component or HTML page: HTML comments in the markup, and script
 * comments inside `<script>` and `<style>` blocks. Markup text is kept as it is.
 */
export function stripMarkupComments(text) {
  return text
    .replaceAll(
      /(<(script|style)\b[^>]*>)([\s\S]*?)(<\/\2>)/g,
      (_, open, _tag, body, close) => open + stripScriptComments(body) + close,
    )
    .replaceAll(/<!--[\s\S]*?-->/g, blank);
}

/** Removes shell comment lines (`# …`), keeping the lines themselves. */
export const stripShellComments = (text) =>
  text.replaceAll(/^[ \t]*#.*$/gm, blank);

/** The comment stripper for a file, by its extension. */
export function stripComments(file, text) {
  if (/\.(?:svelte|html)$/.test(file)) return stripMarkupComments(text);
  if (/\.(?:[cm]?[jt]sx?)$/.test(file)) return stripScriptComments(text);
  if (/\.py$/.test(file)) return stripPythonComments(text);
  if (/\.sh$/.test(file)) return stripShellComments(text);
  return text;
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

/** The upstream logos and icons, by SHA-256 of their bytes. */
export const UPSTREAM_LOGOS = new Map(
  Object.entries(
    JSON.parse(
      readFileSync(
        path.resolve(repository, "scripts/frameleaf-upstream-logo-hashes.json"),
        "utf8",
      ),
    ).hashes,
  ),
);

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");

const tracked = (...paths) =>
  execFileSync("git", ["ls-files", "--", ...paths], {
    cwd: repository,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean);

const read = (file) => readFileSync(path.resolve(repository, file), "utf8");

const CODE = /\.(?:svelte|html|[cm]?[jt]sx?|py)$/;
const NOT_SHIPPED =
  /\.(?:spec|test)\.[cm]?[jt]sx?$|^web\/src\/test-data\/|\/__tests__\/|\/test_[^/]*\.py$|\/conftest\.py$/;
const DOC_PAGE = /\.(?:mdx?|tsx?|jsx?|css)$/;
const ASSET = /\.(?:png|jpe?g|gif|webp|svg|ico|avif)$/i;

export function findViolations() {
  const catalogues = tracked("i18n").filter((file) =>
    /^i18n\/[^/]+\.json$/.test(file),
  );
  const code = tracked(
    "web/src",
    "server/src",
    "packages/cli/src",
    "machine-learning/immich_ml",
  ).filter((file) => CODE.test(file) && !NOT_SHIPPED.test(file));
  const text = [
    ...tracked("docs/docs", "docs/src").filter((file) => DOC_PAGE.test(file)),
    "docs/docusaurus.config.js",
    "README.md",
    "CONTRIBUTING.md",
    "web/static/manifest.json",
    "web/static/.well-known/security.txt",
  ];
  const assets = tracked("web/static", "docs/static");
  const images = tracked(
    "web/static",
    "web/src",
    "docs",
    "design",
    "server/src",
    "licenses",
  ).filter((file) => ASSET.test(file));
  const patterns = [NAME, SITES, STORES];

  return [
    ...catalogues.flatMap((file) =>
      scanCatalogue(file, JSON.parse(read(file))),
    ),
    ...[...code, "install.sh"].flatMap((file) =>
      scanText(stripComments(file, read(file)), patterns, { file }),
    ),
    ...text.flatMap((file) => scanText(read(file), patterns, { file })),
    ...assets
      .filter((file) => /immich/i.test(path.basename(file)))
      .map((file) => ({ file, match: path.basename(file) })),
    ...images
      .filter((file) =>
        UPSTREAM_LOGOS.has(
          sha256(readFileSync(path.resolve(repository, file))),
        ),
      )
      .map((file) => ({ file, match: "upstream logo" })),
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
