import assert from "node:assert/strict";
import test from "node:test";
import {
  ANY,
  findViolations,
  NAME,
  scanCatalogue,
  scanText,
  sha256,
  SITES,
  STORES,
  stripComments,
  UPSTREAM_LOGOS,
} from "./frameleaf-branding.mjs";

/**
 * FL-190: no user-visible surface names Immich, shows its logo or sends people to its sites, apps
 * or packages, except the attribution on the About screen, the README licence notice and the
 * compatibility identifiers listed in the scanner.
 */
test("no user-visible surface names Immich outside the allowlist", () => {
  assert.deepEqual(findViolations(), []);
});

test("the name, the upstream sites and its store listings are found", () => {
  const hits = scanText(
    [
      "Welcome to Immich",
      "IMMICH SERVER",
      "Immich's documentation",
      "See https://docs.immich.app/overview",
      "Source: https://github.com/immich-app/immich",
      "mailto:demo@immich.app",
      "curl https://raw.githubusercontent.com/immich-app/immich/main/install.sh",
      "https://apps.apple.com/us/app/immich/id1613945652",
      "https://play.google.com/store/apps/details?id=app.alextran.immich",
      "https://marketplace.digitalocean.com/apps/immich",
      "https://www.vultr.com/marketplace/apps/immich",
    ].join("\n"),
    [NAME, SITES, STORES],
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
      [8, "apps.apple.com/us/app/immich"],
      [9, "play.google.com/store/apps/details?id=app.alextran.immich"],
      [10, "marketplace.digitalocean.com/apps/immich"],
      [11, "vultr.com/marketplace/apps/immich"],
    ],
  );
});

test("compatibility identifiers and FL-191/FL-192 hosts are not the name", () => {
  const text = [
    "IMMICH_MEDIA_LOCATION=/data",
    "x-immich-checksum",
    "import { getMyUser } from '@frameleaf/sdk';",
    "docker compose logs frameleaf-server",
    "DB_DATABASE_NAME=immich",
    "the immich_fork schema",
    "ImmichLayout and immichApp",
    "from immich_ml.config import log",
    "image: ghcr.io/immich-app/immich-machine-learning:v3.1.0",
    "https://tiles.immich.cloud/v1/style/light.json",
    "https://huggingface.co/immich-app",
    "app.immich:///oauth-callback",
  ].join("\n");
  assert.deepEqual(
    scanText(text, [NAME, SITES, STORES], { file: "docs/docs/example.md" }),
    [],
  );
});

test("comments are not scanned, strings are, and line numbers survive", () => {
  const svelte = [
    '<script lang="ts">',
    "  /** Replaces the Immich modal. */",
    "  // Immich did this differently",
    "  const url = 'https://example.test/path'; // Immich note",
    "  const label = 'Built on Immich';",
    "</script>",
    "<!-- the Immich loading mark -->",
    "<p>Immich</p>",
  ].join("\n");
  assert.deepEqual(
    scanText(stripComments("x.svelte", svelte), [NAME], { file: "x.svelte" }),
    [
      { file: "x.svelte", line: 5, match: "Immich" },
      { file: "x.svelte", line: 8, match: "Immich" },
    ],
  );

  // A `//` or `/*` inside a string, template or regular expression is not a comment.
  const script = [
    "const a = 'https://x.test/Immich'; const b = `/* Immich */`;",
    "const c = /\\/\\/ Immich/; const d = '/* not a comment */ Immich';",
    "logger.log(`Immich ${value} // still text`); // real comment Immich",
  ].join("\n");
  assert.deepEqual(
    scanText(stripComments("x.ts", script), [NAME], { file: "x.ts" }).map(
      ({ line }) => line,
    ),
    [1, 1, 2, 2, 3],
  );

  const python = [
    '"""Module docstring naming Immich."""',
    "# Immich comment",
    'log.info("Frameleaf ML")  # was Immich ML',
    'return {"message": "Immich ML"}',
    "def f():",
    '    """Docstring: Immich."""',
    '    return f"""multi {Immich}"""',
  ].join("\n");
  assert.deepEqual(
    scanText(stripComments("x.py", python), [NAME], { file: "x.py" }).map(
      ({ line }) => line,
    ),
    [4, 7],
  );

  // JSX text is not a comment: a URL or `//` in an email template's text is scanned.
  const jsx = [
    "export const Footer = () => (",
    "  <Text>Visit https://immich.app for help</Text>",
    "  <Text>//Immich</Text>",
    ");",
    "const note = 1; // Immich comment",
  ].join("\n");
  assert.deepEqual(
    scanText(stripComments("server/src/emails/x.tsx", jsx), [NAME, SITES], {
      file: "server/src/emails/x.tsx",
    }).map(({ line, match }) => [line, match]),
    [
      [2, "immich.app"],
      [3, "Immich"],
    ],
  );

  // Only real docstrings are dropped: a triple-quoted argument that starts a line is scanned.
  const docstrings = [
    "def handler(",
    "    request: Request,",
    ") -> Response:",
    '    """Handles Immich requests."""',
    "    log.info(",
    '        """Immich is ready"""',
    "    )",
    "class Model:",
    "    # comment first",
    '    """Model for Immich."""',
    '    name = """Immich ML"""',
  ].join("\n");
  assert.deepEqual(
    scanText(stripComments("x.py", docstrings), [NAME], { file: "x.py" }).map(
      ({ line }) => line,
    ),
    [6, 11],
  );

  const shell = ["# Immich installer", 'echo "Starting Immich"'].join("\n");
  assert.deepEqual(
    scanText(stripComments("install.sh", shell), [NAME], {
      file: "install.sh",
    }).map(({ line }) => line),
    [2],
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

test("the allowlist covers only the attribution and its named exceptions", () => {
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
  const licence =
    "Frameleaf is built on [Immich](https://github.com/immich-app/immich) and the work of its contributors, and is available as open source.";
  assert.deepEqual(scanText(licence, [NAME, SITES], { file: "README.md" }), []);
  assert.equal(
    scanText(`See ${licence}`, [NAME, SITES], { file: "README.md" }).length,
    2,
  );
  assert.ok(ANY.flags.includes("i"));
});

test("the upstream logo list is present and not what Frameleaf ships", () => {
  assert.ok(UPSTREAM_LOGOS.size >= 20);
  assert.ok(
    [...UPSTREAM_LOGOS.keys()].every((hash) => /^[0-9a-f]{64}$/.test(hash)),
  );
  assert.equal(UPSTREAM_LOGOS.has(sha256(Buffer.from("frameleaf"))), false);
});

test("offline source-import wording is permitted only in its named context", () => {
  const passages = [
    [
      "docs/docs/administration/import-immich.md",
      "The importer copies content from a stopped Immich installation into a fresh canonical Frameleaf PostgreSQL 19 database.",
    ],
    [
      "docs/docs/install/upgrading.md",
      "Do not replace an Immich server image with Frameleaf while pointing it at the original Immich database.",
    ],
    [
      "docs/docs/developer/fork-integration.md",
      "Immich stable 3.x through 3.2.4 is a frozen, read-only source for the one-time [offline importer](../administration/import-immich.md).",
    ],
    [
      "server/src/immich-import/types.ts",
      "super(`Immich import refused: ${code}`);",
    ],
    [
      "server/src/commands/import-immich.command.ts",
      "console.error('Immich import connection cleanup failed.');",
    ],
    [
      "server/src/services/database-backup.service.ts",
      "This is not a canonical Frameleaf backup. Use import-immich for a supported Immich library.",
    ],
    [
      "server/src/repositories/database.repository.ts",
      "Frameleaf requires an empty PostgreSQL 19 database. Use import-immich with a separate read-only source; existing Immich or legacy Frameleaf databases cannot be adopted.",
    ],
  ];
  for (const [file, passage] of passages) {
    assert.deepEqual(
      scanText(passage, [NAME, SITES, STORES], { file }),
      [],
      file,
    );
    assert.ok(
      scanText(passage, [NAME, SITES, STORES], {
        file: "web/src/lib/components/frameleaf/Welcome.svelte",
      }).length > 0,
      `import context cannot authorize product copy: ${file}`,
    );
    assert.deepEqual(
      scanText(`${passage} Welcome to Immich`, [NAME], { file }).map(
        ({ match }) => match,
      ),
      ["Immich"],
      `an allowed passage cannot hide adjacent branding: ${file}`,
    );
    assert.equal(
      scanText("Visit https://immich.app", [SITES], { file }).length,
      1,
      `import context cannot authorize upstream service links: ${file}`,
    );
  }
  assert.equal(
    scanText(
      "Supported sources are stable Immich 3.x through 3.2.5; prereleases and later versions are rejected.",
      [NAME],
      {
        file: "docs/docs/administration/import-immich.md",
      },
    ).length,
    1,
    "changing supported source versions requires explicit review",
  );
});

test("source provenance does not authorize arbitrary developer links or deleted migrations", () => {
  for (const file of [
    "docs/docs/developer/setup.md",
    "docs/docs/developer/fork-integration.md",
    "docs/docs/developer/architecture.mdx",
  ]) {
    assert.equal(
      scanText(
        "Download https://github.com/immich-app/immich/releases/latest",
        [SITES],
        { file },
      ).length,
      1,
      file,
    );
    assert.equal(
      scanText("Welcome to Immich", [NAME], { file }).length,
      1,
      file,
    );
  }
  assert.equal(
    scanText("downgrade to upstream Immich.", [NAME], {
      file: "server/src/schema/migrations/1779400000000-UpdateWorkflowTables.ts",
    }).length,
    1,
  );
});
