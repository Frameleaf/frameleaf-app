import assert from "node:assert/strict";
import test from "node:test";
import {
  ANY,
  findViolations,
  NAME,
  scanCatalogue,
  scanText,
  SITES,
  stripComments,
} from "./frameleaf-branding.mjs";

/**
 * FL-190: no user-visible surface names Immich, shows its logo or links its sites, except the
 * attribution on the About screen and the compatibility identifiers listed in the scanner.
 */
test("no user-visible surface names Immich outside the About attribution", () => {
  assert.deepEqual(findViolations(), []);
});

test("the name and the upstream sites are found", () => {
  const hits = scanText(
    [
      "Welcome to Immich",
      "IMMICH SERVER",
      "Immich's documentation",
      "See https://docs.immich.app/overview",
      "Source: https://github.com/immich-app/immich",
      "mailto:demo@immich.app",
      "curl https://raw.githubusercontent.com/immich-app/immich/main/install.sh",
    ].join("\n"),
    [NAME, SITES],
    { file: "docs/docs/example.md" },
  );
  assert.deepEqual(
    hits.map(({ line, match }) => [line, match]),
    [
      [1, "Immich"],
      [2, "IMMICH"],
      [3, "Immich"],
      [4, "docs.immich.app"],
      [5, "github.com/immich-app"],
      [6, "immich.app"],
      [7, "githubusercontent.com/immich-app"],
    ],
  );
});

test("compatibility identifiers and FL-191 hosts are not the name", () => {
  const text = [
    "IMMICH_MEDIA_LOCATION=/data",
    "x-immich-checksum",
    "import { getMyUser } from '@immich/sdk';",
    "docker compose logs immich-server",
    "DB_DATABASE_NAME=immich",
    "the immich_fork schema",
    "ImmichLayout and immichApp",
    "image: ghcr.io/immich-app/immich-server:v3.1.0",
    "https://tiles.immich.cloud/v1/style/light.json",
    "https://huggingface.co/immich-app",
    "app.immich:///oauth-callback",
  ].join("\n");
  assert.deepEqual(
    scanText(text, [NAME, SITES], { file: "docs/docs/example.md" }),
    [],
  );
});

test("comments are not scanned, and line numbers survive their removal", () => {
  const source = [
    '<script lang="ts">',
    "  /** Replaces the Immich modal. */",
    "  // Immich did this differently",
    "  const url = 'https://example.test/path';",
    "</script>",
    "<!-- the Immich loading mark -->",
    "<p>Immich</p>",
  ].join("\n");
  assert.deepEqual(
    scanText(stripComments(source), [NAME, SITES], {
      file: "web/src/x.svelte",
    }),
    [{ file: "web/src/x.svelte", line: 7, match: "Immich" }],
  );
});

test("every spelling in a translation value is found, keys are not", () => {
  const hits = scanCatalogue("i18n/pl.json", {
    immich_logo: "Logo Frameleaf",
    welcome_to_immich: "Witamy w immich",
    admin: { backup: "Kopia Immicha" },
  });
  assert.deepEqual(
    hits.map(({ key, match }) => [key, match]),
    [
      ["welcome_to_immich", "immich"],
      ["admin.backup", "Immich"],
    ],
  );
});

test("the allowlist covers only the About attribution and its named exceptions", () => {
  assert.deepEqual(
    scanCatalogue("i18n/en.json", {
      frameleaf_about_attribution:
        "Built on <upstream>Immich</upstream>, the open-source photo library (<licence>AGPL-3.0</licence>).",
      frameleaf_other: "Built on <upstream>Immich</upstream>",
      admin: { map_implications: "The map uses tiles.immich.cloud" },
    }).map(({ key }) => key),
    ["frameleaf_other", "admin.map_implications"],
  );
  const about = '<a href="https://github.com/immich-app/immich">x</a>';
  assert.deepEqual(
    scanText(about, [NAME, SITES], {
      file: "web/src/lib/components/frameleaf/AboutDialog.svelte",
    }),
    [],
  );
  assert.equal(
    scanText(about, [NAME, SITES], {
      file: "web/src/lib/components/frameleaf/HelpFeedbackDialog.svelte",
    }).length,
    1,
  );
  const upstreamRemote =
    "git remote add upstream https://github.com/immich-app/immich.git";
  assert.deepEqual(
    scanText(upstreamRemote, [NAME, SITES], {
      file: "docs/docs/developer/setup.md",
    }),
    [],
  );
  assert.equal(
    scanText(upstreamRemote, [NAME, SITES], {
      file: "docs/docs/install/docker-compose.mdx",
    }).length,
    1,
  );
  assert.ok(ANY.flags.includes("i"));
});
