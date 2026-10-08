#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { flatten, stripComments } from "./frameleaf-branding.mjs";

/**
 * FL-294 (owner decision 2026-10-01: "our product is called frameleaf, we shouldn't be using the
 * immich name anywhere"): every inherited IMMICH_* environment variable has a FRAMELEAF_* name, and
 * frameleaf-admin / frameleaf-healthcheck replace immich-admin / immich-healthcheck. The old names
 * still work as deprecated aliases, so an unchanged Immich .env and Compose file keep starting the
 * server after the image swap, but nothing people read should teach them.
 *
 * This scan fails on an IMMICH_* variable or an immich-admin / immich-healthcheck command in:
 *
 * - shipped code outside comments (web/src, server/src, packages/cli/src, machine-learning/immich_ml),
 *   which holds the log, error and help messages;
 * - every translation value (i18n/*.json);
 * - the documentation (docs/docs, docs/src), README.md, and the files people install from: the
 *   release Compose files, example.env and docker/README.md, the NAS packages, install.sh and the
 *   restoration worker README.
 *
 * The allowlist below names each exception and why. FL-190's guard (frameleaf-branding.mjs) covers
 * the capitalised product name; this one covers the lowercase identifiers it deliberately leaves.
 */
const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

/** An inherited variable name. `OFFICIAL_IMMICH_TAG` and `PUBLIC_IMMICH_*` are other names. */
export const LEGACY_VARIABLE = /(?<![\w$])IMMICH_[A-Z0-9][A-Z0-9_]*/g;
/** The old admin and healthcheck commands; `x-immich-admin-only` is an API extension key. */
export const LEGACY_COMMAND =
  /(?<![\w./-])immich-(?:admin|healthcheck)(?![\w-])/g;

const variables = (...names) =>
  new RegExp(`(?<![\\w$])IMMICH_(?:${names.join("|")})(?![\\w])`, "g");
const ANY_VARIABLE = /(?<![\w$])IMMICH_[A-Z0-9][A-Z0-9_]*/g;
const DEPRECATED_SENTENCE = /^.*\bdeprecated\b.*$/gi;

/**
 * The explicit allowlist. Each entry names the files (or translation keys) it covers, the text it
 * removes before the scan, and why. `anywhere` entries apply to every scanned file.
 */
export const LEGACY_ALLOWLIST = [
  {
    reason:
      "Inert variables: telemetry and metrics do nothing in Frameleaf, so they keep their old names only (no FRAMELEAF_ name)",
    anywhere: true,
    allow: variables(
      "TELEMETRY_INCLUDE",
      "TELEMETRY_EXCLUDE",
      "API_METRICS_PORT",
      "MICROSERVICES_METRICS_PORT",
    ),
  },
  {
    reason:
      "The alias tables: each deprecated IMMICH_ name next to its FRAMELEAF_ name (server, machine learning, CLI)",
    files:
      /^(?:server\/src\/utils\/env-aliases\.ts|machine-learning\/immich_ml\/env_aliases\.py|packages\/cli\/src\/env-aliases\.ts)$/,
    allow: ANY_VARIABLE,
  },
  {
    reason:
      "Help links: the IMMICH_THIRD_PARTY_* names keep their existing fallback behind FRAMELEAF_DOCS_URL and the other help-link variables",
    files:
      /^(?:server\/src\/utils\/app-releases\.ts|server\/src\/utils\/environment-schema\.ts)$/,
    allow: variables("THIRD_PARTY_[A-Z_]+"),
  },
  {
    reason:
      "The admin command accepts its deprecated name, and drops the old log-level name so it cannot conflict with the level it sets",
    files: /^server\/src\/(?:main|supervisor)\.ts$/,
    allow: /'immich-admin'|process\.env\.IMMICH_LOG_LEVEL/g,
  },
  {
    reason:
      "The health check's throwaway server drops the deprecated IMMICH_HOST and IMMICH_PORT so they cannot conflict with its own address",
    files: /^server\/src\/maintenance\/maintenance-health\.repository\.ts$/,
    allow: /IMMICH_HOST: _host, IMMICH_PORT: _port/g,
  },
  {
    reason:
      "Code identifiers people never see: the listening-message constant and the upstream mobile app's OAuth callback",
    files:
      /^(?:server\/src\/(?:constants|app\.common|maintenance\/maintenance-health\.repository)\.ts|web\/src\/lib\/frameleaf\/oauth-callbacks\.ts)$/,
    allow: /\bIMMICH_(?:SERVER_START|APP_CALLBACK)\b/g,
  },
  {
    reason:
      "Compose files keep IMMICH_VERSION as the fallback of FRAMELEAF_VERSION, so an unchanged Immich .env still selects its image tag",
    files:
      /^docker\/docker-compose(?:\.rootless)?\.yml$/,
    allow: /\$\{FRAMELEAF_VERSION:-\$\{IMMICH_VERSION:-[^}]*\}\}/g,
  },

  {
    reason:
      "Internal identifier for Frameleaf's canonical offline-import journal SQL; never a source schema restore or operator environment variable",
    files: /^server\/src\/immich-import\/state\.ts$/,
    allow: /\bIMMICH_IMPORT_SCHEMA_SQL\b/g,
  },

  {
    reason:
      "Sentences that say an old name is a deprecated alias (README, docker/README.md, example.env)",
    files:
      /^(?:README\.md|docker\/README\.md|docker\/example\.env)$/,
    allow: DEPRECATED_SENTENCE,
  },
];

const ALIAS_HINT = /\b(?:still works?|keep working|aliases?)\b/i;

function allowed(text, { file, key }) {
  let result = text;
  for (const entry of LEGACY_ALLOWLIST) {
    if (!entry.anywhere) {
      if (entry.files && !(file && entry.files.test(file))) continue;
      if (entry.keys && !(key && entry.keys.test(key))) continue;
    }
    if (entry.allow === DEPRECATED_SENTENCE) {
      // only a line that says the old name still works, not any line with "deprecated" in it
      if (!ALIAS_HINT.test(result) && !/\bdeprecated alias/i.test(result))
        continue;
    }
    const before = result;
    result = result.replaceAll(entry.allow, "");
    if (result !== before) used.add(entry);
  }
  return result;
}

const used = new Set();

/** Every old variable or command in `text`, after the allowlist, with its line. */
export function scanLegacyText(text, context = {}) {
  const hits = [];
  for (const [index, line] of text.split("\n").entries()) {
    const remaining = allowed(line, context);
    for (const pattern of [LEGACY_VARIABLE, LEGACY_COMMAND]) {
      for (const match of remaining.matchAll(pattern)) {
        hits.push({ ...context, line: index + 1, match: match[0] });
      }
    }
  }
  return hits;
}

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

export function findLegacyNameViolations() {
  used.clear();
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
    "README.md",
    "install.sh",
    "docker/README.md",
    "docker/example.env",
    "docker/docker-compose.yml",
    "docker/docker-compose.rootless.yml",
    "docker/docker-compose.restoration.yml",
    "machine-learning/video-restoration/README.md",
    ...tracked("packaging/nas").filter(
      (file) => !/\.(?:test\.)?c?js$|\.py$|\.json$/.test(file),
    ),
  ];

  return [
    ...catalogues.flatMap((file) =>
      flatten(JSON.parse(read(file))).flatMap(([key, value]) =>
        scanLegacyText(value, { file, key }),
      ),
    ),
    ...code.flatMap((file) =>
      scanLegacyText(stripComments(file, read(file)), { file }),
    ),
    ...text.flatMap((file) => scanLegacyText(read(file), { file })),
  ];
}

/** Allowlist entries that no longer remove anything from the repository. */
export function unusedLegacyAllowlist() {
  findLegacyNameViolations();
  return LEGACY_ALLOWLIST.filter((entry) => !used.has(entry)).map(
    (entry) => entry.reason,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = findLegacyNameViolations();
  for (const { file, key, line, match } of violations) {
    console.log(
      `${file}${key ? ` ${key}` : ""}${line ? `:${line}` : ""}: ${match}`,
    );
  }
  console.log(`${violations.length} legacy name(s)`);
  process.exitCode = violations.length > 0 ? 1 : 0;
}
