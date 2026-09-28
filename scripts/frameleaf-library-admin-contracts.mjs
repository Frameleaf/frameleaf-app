#!/usr/bin/env node

import assert from "node:assert/strict";
import { lstat, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SOURCE_DOCUMENTS = [
  {
    path: "docs/docs/developer/frameleaf-library-action-parity.md",
    expectedCount: 37,
  },
  {
    path: "docs/docs/developer/frameleaf-settings-inventory.md",
    expectedCount: 5,
  },
];
const REJECTED_SPECIALIZED_BACKLOG =
  "docs/docs/developer/frameleaf-plan/library-backlog.json";

export function normalizeRoute(relativeDirectory) {
  const segments = relativeDirectory
    .split(path.sep)
    .filter((segment) => segment && !/^\([^/]+\)$/.test(segment));
  return `/${segments.join("/")}`;
}

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? walk(path.join(directory, entry.name))
        : [path.join(directory, entry.name)],
    ),
  );
  return nested.flat().sort();
}

export async function collectRoutes(repository = root) {
  const routeRoot = path.join(repository, "web/src/routes");
  const files = await walk(routeRoot);
  return [
    ...new Set(
      files
        .filter((file) =>
          /\+page\.(?:svelte|ts|js|server\.ts|server\.js)$/.test(file),
        )
        .map((file) =>
          normalizeRoute(path.relative(routeRoot, path.dirname(file))),
        ),
    ),
  ].sort();
}

export function extractCitedSourcePaths(markdown) {
  return [
    ...new Set(
      [...markdown.matchAll(/`((?:server|web)\/[^`\n]+)`/g)].map(
        ([, source]) => source,
      ),
    ),
  ].sort();
}

export async function validateCitedSourcePaths(repository = root) {
  const repositoryRoot = path.resolve(repository);
  const citedSources = [];
  for (const document of SOURCE_DOCUMENTS) {
    const markdown = await readFile(
      path.join(repositoryRoot, document.path),
      "utf8",
    );
    const sources = extractCitedSourcePaths(markdown);
    assert.equal(
      sources.length,
      document.expectedCount,
      `${document.path} source citation count drifted`,
    );
    citedSources.push(...sources);
  }

  const sources = [...new Set(citedSources)].sort();
  for (const source of sources) {
    const resolved = path.resolve(repositoryRoot, source);
    assert.ok(
      resolved.startsWith(`${repositoryRoot}${path.sep}`),
      `Source citation escapes the repository: ${source}`,
    );
    await stat(resolved);
  }
  return sources;
}

export function validateJiraMappings(backlog, jira) {
  assert.equal(jira.projectKey, "FL");
  assert.match(
    jira.cloudId,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    "Jira cloudId must be a UUID",
  );
  assert.ok(
    jira.issues &&
      typeof jira.issues === "object" &&
      !Array.isArray(jira.issues),
    "Jira issues must be keyed by plan ID",
  );

  const backlogIds = backlog.items.map(({ id }) => id).sort();
  assert.deepEqual(
    Object.keys(jira.issues).sort(),
    backlogIds,
    "Jira mappings must exactly cover the consolidated backlog",
  );

  const ids = new Set();
  const keys = new Set();
  const urls = new Set();
  for (const [planId, issue] of Object.entries(jira.issues)) {
    assert.ok(issue && typeof issue === "object" && !Array.isArray(issue));
    for (const field of ["id", "key", "url"]) {
      assert.equal(
        typeof issue[field],
        "string",
        `${planId} Jira mapping requires ${field}`,
      );
      assert.ok(issue[field].length > 0, `${planId} Jira ${field} is empty`);
    }
    assert.match(issue.id, /^[1-9]\d*$/, `${planId} Jira id is invalid`);
    assert.match(issue.key, /^FL-[1-9]\d*$/, `${planId} Jira key is invalid`);
    assert.equal(
      issue.url,
      `https://heroit.atlassian.net/browse/${issue.key}`,
      `${planId} Jira URL does not match its key`,
    );
    assert.ok(!ids.has(issue.id), `Duplicate Jira id ${issue.id}`);
    assert.ok(!keys.has(issue.key), `Duplicate Jira key ${issue.key}`);
    assert.ok(!urls.has(issue.url), `Duplicate Jira URL ${issue.url}`);
    ids.add(issue.id);
    keys.add(issue.key);
    urls.add(issue.url);
  }
}

export async function rejectSpecializedLibraryBacklog(repository = root) {
  const rejectedPath = path.join(repository, REJECTED_SPECIALIZED_BACKLOG);
  try {
    await lstat(rejectedPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }
  assert.fail(
    `${REJECTED_SPECIALIZED_BACKLOG} is a known incomplete dependency graph and must remain absent`,
  );
}

export async function validateContracts(repository = root) {
  const inventory = JSON.parse(
    await readFile(
      path.join(
        repository,
        "docs/docs/developer/frameleaf-route-inventory.json",
      ),
      "utf8",
    ),
  );
  assert.equal(inventory.schemaVersion, 2);
  assert.equal(
    inventory.baselineCommit,
    "7cfa62336f394189c0450533c30618c66366d868",
  );
  assert.deepEqual(
    await collectRoutes(repository),
    inventory.productionRoutes,
    "Production web route inventory drifted",
  );
  assert.ok(
    inventory.dirtyOnlyEvidence.every(
      (route) => !inventory.productionRoutes.includes(route),
    ),
    "Dirty-only evidence must not be reported as clean production",
  );

  const backlog = JSON.parse(
    await readFile(
      path.join(repository, "docs/docs/developer/frameleaf-plan/backlog.json"),
      "utf8",
    ),
  );
  const jira = JSON.parse(
    await readFile(
      path.join(repository, "docs/docs/developer/frameleaf-plan/jira-map.json"),
      "utf8",
    ),
  );
  const libraryItems = backlog.items.filter(
    (item) => item.workstream === "library",
  );
  assert.equal(libraryItems.filter((item) => item.type === "epic").length, 8);
  assert.equal(libraryItems.filter((item) => item.type === "story").length, 45);
  assert.ok(
    libraryItems.every((item) => item.status === "planned-not-qualified"),
  );
  validateJiraMappings(backlog, jira);
  const ids = new Set(backlog.items.map((item) => item.id));
  assert.ok(
    libraryItems.every((item) =>
      item.dependencies.every((dependency) => ids.has(dependency)),
    ),
    "Library dependencies must resolve in the consolidated backlog",
  );

  const systemSettings = await readFile(
    // FL-71: the server settings moved with the one Command Center; `/admin/system-settings` redirects.
    path.join(
      repository,
      "web/src/routes/(user)/user-settings/SystemSettings.svelte",
    ),
    "utf8",
  );
  const personalSettings = await readFile(
    path.join(
      repository,
      "web/src/routes/(user)/user-settings/UserSettingsList.svelte",
    ),
    "utf8",
  );
  // FL-74 adds "Originals & preservation" to Import & protection and to every account's own
  // settings (preservation is per account); FL-75 adds "Move or export your library" under
  // Storage & originals. Both are placed where the September 22 prototype places them.
  // FL-71: 23 -> 22. The one Command Center mounts imports and preservation once, as account
  // sections of Import & protection (they were a server copy and an account copy: -2), and adds the
  // template's Server & updates "Configuration transfer" section (+1). 22 -> 21: queue concurrency
  // is edited only in the Job manager's concurrency dialog, as in the template, so the separate
  // job settings form is gone (FL-71 re-review).
  assert.equal(
    (systemSettings.match(/^\s{6}component:\s*[A-Za-z][A-Za-z0-9]*/gm) ?? [])
      .length,
    21,
  );
  // FL-71: the account settings are Command Center sections drawn one at a time, no longer
  // accordion groups; the same 16 sections (now counted by their section branch). FL-158 adds the
  // account's own Frameleaf account section (Your preferences → Frameleaf account): 16 -> 17.
  assert.equal(
    (personalSettings.match(/\{(?:#|:else )if section === '/g) ?? []).length,
    17,
  );

  await rejectSpecializedLibraryBacklog(repository);
  const citedSources = await validateCitedSourcePaths(repository);

  return {
    adminRouteCount: inventory.productionRoutes.filter(
      (route) => route === "/admin" || route.startsWith("/admin/"),
    ).length,
    dirtyOnlyRouteCount: inventory.dirtyOnlyEvidence.length,
    libraryEpicCount: 8,
    libraryStoryCount: 45,
    personalSettingsCount: 16,
    productionRouteCount: inventory.productionRoutes.length,
    sourceCitationCount: citedSources.length,
    systemSettingsCount: 22,
  };
}

async function main() {
  assert.deepEqual(
    process.argv.slice(2),
    [],
    "Usage: node scripts/frameleaf-library-admin-contracts.mjs",
  );
  const result = await validateContracts();
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
