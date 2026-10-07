import assert from "node:assert/strict";
import test from "node:test";
import {
  findLegacyNameViolations,
  LEGACY_ALLOWLIST,
  LEGACY_COMMAND,
  LEGACY_VARIABLE,
  scanLegacyText,
  unusedLegacyAllowlist,
} from "./frameleaf-legacy-names.mjs";

/**
 * FL-294: the product is Frameleaf. Docs, messages, translations and the files people install from
 * name the FRAMELEAF_* variables and the frameleaf-admin / frameleaf-healthcheck commands. The
 * IMMICH_* names and immich-* commands still work as aliases, and appear only where the allowlist
 * says why.
 */
test("no user-facing IMMICH_ variable or immich-admin mention outside the allowlist", () => {
  assert.deepEqual(findLegacyNameViolations(), []);
});

test("every allowlist entry still covers something", () => {
  assert.deepEqual(unusedLegacyAllowlist(), []);
});

test("old variables and commands are found; similar identifiers are not", () => {
  const hits = scanLegacyText(
    [
      "Set IMMICH_LOG_LEVEL=debug",
      "run `immich-admin list-users`",
      "test: [CMD, immich-healthcheck]",
      "docker exec frameleaf_server immich-admin reset-admin-password",
      "image: ghcr.io/frameleaf/frameleaf-server:${IMMICH_VERSION:-release}",
      // not old names
      "FRAMELEAF_LOG_LEVEL=debug",
      "frameleaf-admin list-users",
      "x-immich-admin-only",
      "OFFICIAL_IMMICH_TAG=v3.1.0",
      "PUBLIC_IMMICH_HOSTNAME",
      "IMMICH_*",
      "docker compose logs frameleaf-server",
    ].join("\n"),
    { file: "docs/docs/example.md" },
  );
  assert.deepEqual(
    hits.map(({ line, match }) => [line, match]),
    [
      [1, "IMMICH_LOG_LEVEL"],
      [2, "immich-admin"],
      [3, "immich-healthcheck"],
      [4, "immich-admin"],
      [5, "IMMICH_VERSION"],
    ],
  );
});

test("the allowlist is narrow: an exception in one file does not cover another", () => {
  // the inert metrics variables keep their old names everywhere
  assert.deepEqual(
    scanLegacyText("IMMICH_API_METRICS_PORT=8081", {
      file: "docs/docs/example.md",
    }),
    [],
  );
  // the alias table may name old variables, a docs page may not
  assert.deepEqual(
    scanLegacyText("IMMICH_PORT", { file: "server/src/utils/env-aliases.ts" }),
    [],
  );
  assert.equal(
    scanLegacyText("IMMICH_PORT", { file: "docs/docs/example.md" }).length,
    1,
  );
  // the alias table does not excuse a command name
  assert.equal(
    scanLegacyText("immich-admin", { file: "server/src/utils/env-aliases.ts" })
      .length,
    1,
  );
  // a deprecated-alias sentence on the commands page is allowed, a new example there is not
  assert.deepEqual(
    scanLegacyText(
      "The old names `immich-admin`, `immich` and `immich-healthcheck` still work as deprecated aliases.",
      { file: "docs/docs/administration/server-commands.md" },
    ),
    [],
  );
  assert.equal(
    scanLegacyText("docker exec -it frameleaf_server immich-admin list-users", {
      file: "docs/docs/administration/server-commands.md",
    }).length,
    1,
  );
});

test("every allowlist entry gives its reason and a pattern", () => {
  for (const entry of LEGACY_ALLOWLIST) {
    assert.ok(entry.reason.length > 20, entry.reason);
    assert.ok(
      entry.allow instanceof RegExp && entry.allow.global,
      entry.reason,
    );
    assert.ok(
      entry.files instanceof RegExp ||
        entry.keys instanceof RegExp ||
        entry.anywhere,
      entry.reason,
    );
  }
  assert.ok(LEGACY_VARIABLE.global && LEGACY_COMMAND.global);
});

test("the importer journal identifier is internal and allowed only in its defining file", () => {
  const file = "server/src/immich-import/state.ts";
  assert.deepEqual(
    scanLegacyText(
      "export const IMMICH_IMPORT_SCHEMA_SQL = `CREATE TABLE public.frameleaf_immich_import`",
      { file },
    ),
    [],
  );
  assert.deepEqual(
    scanLegacyText("IMMICH_IMPORT_SCHEMA_SQL IMMICH_IMPORT_DATABASE_URL", {
      file,
    }).map(({ match }) => match),
    ["IMMICH_IMPORT_DATABASE_URL"],
  );
  for (const other of [
    "server/src/immich-import/importer.ts",
    "docs/docs/administration/import-immich.md",
  ]) {
    assert.equal(
      scanLegacyText("IMMICH_IMPORT_SCHEMA_SQL", { file: other }).length,
      1,
    );
  }
  assert.equal(
    scanLegacyText("process.env.IMMICH_MEDIA_LOCATION", {
      file: "server/src/schema/migrations/1752759108283-ConvertToAbsolutePaths.ts",
    }).length,
    1,
  );
});

test("the offline import alias allowance does not excuse other commands, variables or documentation", () => {
  const file = "docs/docs/administration/import-immich.md";
  for (const command of [
    "immich-admin import-immich preflight --config /path/config.json",
    "immich-admin import-immich run --config /path/config.json",
    "immich-admin import-immich status",
    "immich-admin import-immich resume --config /path/config.json",
    "immich-admin import-immich verify --config /path/config.json",
  ]) {
    assert.deepEqual(scanLegacyText(command, { file }), []);
    assert.equal(
      scanLegacyText(command, { file: "docs/docs/example.md" }).length,
      1,
    );
  }
  for (const command of [
    "immich-admin reset-admin-password",
    "immich-admin import-immich delete",
    "immich-admin import-immich status && immich-admin list-users",
    "IMMICH_PORT=2283 immich-admin import-immich status",
  ]) {
    assert.ok(scanLegacyText(command, { file }).length > 0, command);
  }
  const alias =
    "`frameleaf-admin import-immich` (also available through the current `immich-admin` alias)";
  assert.deepEqual(
    scanLegacyText(alias, {
      file: "docs/docs/administration/server-commands.md",
    }),
    [],
  );
  assert.equal(
    scanLegacyText(alias, { file: "docs/docs/example.md" }).length,
    1,
  );
  assert.equal(
    scanLegacyText(`${alias} IMMICH_PORT=2283`, {
      file: "docs/docs/administration/server-commands.md",
    }).length,
    1,
  );
});
