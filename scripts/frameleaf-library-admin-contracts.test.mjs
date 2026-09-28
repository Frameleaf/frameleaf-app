import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  collectRoutes,
  extractCitedSourcePaths,
  normalizeRoute,
  rejectSpecializedLibraryBacklog,
  validateCitedSourcePaths,
  validateContracts,
  validateJiraMappings,
} from "./frameleaf-library-admin-contracts.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const sourceDocuments = [
  "docs/docs/developer/frameleaf-library-action-parity.md",
  "docs/docs/developer/frameleaf-settings-inventory.md",
];

async function makeSourceFixture(t) {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "frameleaf-library-contracts-"),
  );
  t.after(() => rm(fixture, { force: true, recursive: true }));
  for (const document of sourceDocuments) {
    const markdown = await readFile(path.join(repository, document), "utf8");
    await mkdir(path.dirname(path.join(fixture, document)), {
      recursive: true,
    });
    await writeFile(path.join(fixture, document), markdown);
    for (const source of extractCitedSourcePaths(markdown)) {
      const sourceStat = await stat(path.join(repository, source));
      const target = path.join(fixture, source);
      if (sourceStat.isDirectory()) {
        await mkdir(target, { recursive: true });
      } else {
        await mkdir(path.dirname(target), { recursive: true });
        await writeFile(target, "fixture\n");
      }
    }
  }
  return fixture;
}

test("normalizes route groups while preserving typed and optional parameters", () => {
  assert.equal(
    normalizeRoute(
      path.join("(user)", "albums", "[albumId=id]", "[[assetId=id]]"),
    ),
    "/albums/[albumId=id]/[[assetId=id]]",
  );
  assert.equal(
    normalizeRoute(path.join("admin", "users", "(list)", "new")),
    "/admin/users/new",
  );
  assert.equal(normalizeRoute(""), "/");
});

test("committed production routes exclude the remaining dirty-only additions", async () => {
  const routes = await collectRoutes();
  assert.equal(routes.length, 83);
  assert.ok(routes.includes("/admin/users/[id]/edit"));
  assert.ok(routes.includes("/share/[key]/[[photos=photos]]/[[assetId=id]]"));
  assert.ok(routes.includes("/studio"));
  assert.ok(!routes.includes("/spaces"));
  assert.ok(routes.includes("/takeout"));
});

test("library and administration preservation contracts match source and canonical plans", async () => {
  assert.deepEqual(await validateContracts(), {
    adminRouteCount: 20,
    dirtyOnlyRouteCount: 11,
    libraryEpicCount: 8,
    libraryStoryCount: 45,
    personalSettingsCount: 16,
    productionRouteCount: 83,
    sourceCitationCount: 42,
    systemSettingsCount: 22,
  });
});

test("every cited clean source path is enforced", async (t) => {
  const fixture = await makeSourceFixture(t);
  assert.equal((await validateCitedSourcePaths(fixture)).length, 42);
  await unlink(
    path.join(
      fixture,
      "web/src/lib/components/asset-viewer/AssetViewer.svelte",
    ),
  );
  await assert.rejects(
    validateCitedSourcePaths(fixture),
    /AssetViewer\.svelte|ENOENT/,
  );
});

test("the known incomplete specialized library backlog is rejected", async (t) => {
  const fixture = await mkdtemp(
    path.join(os.tmpdir(), "frameleaf-library-backlog-"),
  );
  t.after(() => rm(fixture, { force: true, recursive: true }));
  const rejected = path.join(
    fixture,
    "docs/docs/developer/frameleaf-plan/library-backlog.json",
  );
  await mkdir(path.dirname(rejected), { recursive: true });
  await writeFile(rejected, "[]\n");
  await assert.rejects(
    rejectSpecializedLibraryBacklog(fixture),
    /known incomplete dependency graph/,
  );
});

test("Jira mappings require complete unique FL identities and matching URLs", async () => {
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
  validateJiraMappings(backlog, jira);

  const [firstPlanId, secondPlanId] = Object.keys(jira.issues);
  const wrongUrl = structuredClone(jira);
  wrongUrl.issues[firstPlanId].url =
    "https://heroit.atlassian.net/browse/FL-999999";
  assert.throws(
    () => validateJiraMappings(backlog, wrongUrl),
    /URL does not match its key/,
  );

  const invalidKey = structuredClone(jira);
  invalidKey.issues[firstPlanId].key = "NOT-FL-1";
  invalidKey.issues[firstPlanId].url =
    "https://heroit.atlassian.net/browse/NOT-FL-1";
  assert.throws(
    () => validateJiraMappings(backlog, invalidKey),
    /Jira key is invalid/,
  );

  const duplicateId = structuredClone(jira);
  duplicateId.issues[secondPlanId].id = duplicateId.issues[firstPlanId].id;
  assert.throws(
    () => validateJiraMappings(backlog, duplicateId),
    /Duplicate Jira id/,
  );

  const duplicateKey = structuredClone(jira);
  duplicateKey.issues[secondPlanId].key = duplicateKey.issues[firstPlanId].key;
  duplicateKey.issues[secondPlanId].url = duplicateKey.issues[firstPlanId].url;
  assert.throws(
    () => validateJiraMappings(backlog, duplicateKey),
    /Duplicate Jira key/,
  );

  const invalidId = structuredClone(jira);
  invalidId.issues[firstPlanId].id = "not-numeric";
  assert.throws(
    () => validateJiraMappings(backlog, invalidId),
    /Jira id is invalid/,
  );

  const missingKey = structuredClone(jira);
  delete missingKey.issues[firstPlanId].key;
  assert.throws(
    () => validateJiraMappings(backlog, missingKey),
    /requires key/,
  );
});
