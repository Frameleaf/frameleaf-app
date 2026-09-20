import test from "node:test";
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateContracts } from "./frameleaf-studio-contracts.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const fixtureFiles = [
  "docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md",
  "docs/docs/developer/frameleaf-plan/backlog.json",
  "docs/docs/developer/frameleaf-plan/freecut-issue-map.json",
  "docs/docs/developer/frameleaf-plan/studio-backlog.json",
  "studio/dependency-attribution.json",
  "studio/freecut-feature-manifest.json",
  "studio/freecut-provenance.json",
];

async function createFixture(t) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "frameleaf-studio-"));
  t.after(() => rm(fixture, { force: true, recursive: true }));
  for (const file of fixtureFiles) {
    const destination = path.join(fixture, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(path.join(repository, file), destination);
  }
  return fixture;
}

async function mutateJson(fixture, file, mutate) {
  const target = path.join(fixture, file);
  const value = JSON.parse(await readFile(target, "utf8"));
  mutate(value);
  await writeFile(target, `${JSON.stringify(value, null, 2)}\n`);
}

test("Studio preservation contracts remain complete and explicitly unqualified", async () => {
  const result = await validateContracts(repository);
  assert.deepEqual(
    {
      engineRevision: result.engineRevision,
      familySourcePathCount: result.familySourcePathCount,
      featureCount: result.featureCount,
      provenanceFileCount: result.provenanceFileCount,
      issueMapCount: result.issueMapCount,
      epicCount: result.epicCount,
      storyCount: result.storyCount,
      qualification: result.qualification,
      runtimePackageCount: result.runtimePackageCount,
    },
    {
      engineRevision: "4d62e8082c5eb387a96275bcbd323d28f6e41a62",
      familySourcePathCount: 2204,
      featureCount: 210,
      provenanceFileCount: 2646,
      issueMapCount: 210,
      epicCount: 7,
      storyCount: 33,
      qualification: "planned-not-qualified",
      runtimePackageCount: 51,
    },
  );
});

test("specialized dependencies and reviewed guide cannot drift from canonical backlog", async (t) => {
  const dependencyFixture = await createFixture(t);
  await mutateJson(
    dependencyFixture,
    "docs/docs/developer/frameleaf-plan/studio-backlog.json",
    (backlog) => {
      backlog.find(({ id }) => id === "STU-101").dependencies = [];
    },
  );
  await assert.rejects(validateContracts(dependencyFixture));

  const externalFixture = await createFixture(t);
  for (const file of [
    "docs/docs/developer/frameleaf-plan/studio-backlog.json",
    "docs/docs/developer/frameleaf-plan/backlog.json",
  ]) {
    await mutateJson(externalFixture, file, (backlog) => {
      const items = Array.isArray(backlog) ? backlog : backlog.items;
      items.find(({ id }) => id === "STU-101").dependencies = ["FN-999"];
    });
  }
  await assert.rejects(validateContracts(externalFixture));

  const guideFixture = await createFixture(t);
  await mutateJson(
    guideFixture,
    "docs/docs/developer/frameleaf-plan/backlog.json",
    (backlog) => {
      backlog.items.find(({ id }) => id === "STU-100").workstreamGuide =
        "docs/docs/developer/frameleaf-plan/01-agent-execution.md";
    },
  );
  await assert.rejects(validateContracts(guideFixture));
});

test("archive and every ordered provenance row are pinned", async (t) => {
  for (const field of ["archiveUrl", "archiveSha256"]) {
    const fixture = await createFixture(t);
    await mutateJson(
      fixture,
      "studio/freecut-provenance.json",
      (provenance) => {
        provenance[field] = "invalid";
      },
    );
    await assert.rejects(validateContracts(fixture));
  }

  const unreferencedFixture = await createFixture(t);
  const manifest = JSON.parse(
    await readFile(
      path.join(unreferencedFixture, "studio/freecut-feature-manifest.json"),
      "utf8",
    ),
  );
  const referencedPaths = new Set(
    manifest.features.flatMap(({ source }) =>
      source.map(({ path: sourcePath }) =>
        sourcePath.replace(/^vendor\/freecut\//, ""),
      ),
    ),
  );
  await mutateJson(
    unreferencedFixture,
    "studio/freecut-provenance.json",
    (provenance) => {
      const row = provenance.files.find(
        ({ path: sourcePath }) => !referencedPaths.has(sourcePath),
      );
      assert.ok(row, "fixture needs an unreferenced provenance row");
      row.sha256 = "0".repeat(64);
    },
  );
  await assert.rejects(validateContracts(unreferencedFixture));

  const orderFixture = await createFixture(t);
  await mutateJson(
    orderFixture,
    "studio/freecut-provenance.json",
    (provenance) => {
      [provenance.files[0], provenance.files[1]] = [
        provenance.files[1],
        provenance.files[0],
      ];
    },
  );
  await assert.rejects(validateContracts(orderFixture));
});

test("family source inventory exhaustively matches manifest categories and provenance", async (t) => {
  const emptyFixture = await createFixture(t);
  await mutateJson(
    emptyFixture,
    "studio/freecut-feature-manifest.json",
    (manifest) => {
      manifest.familySourceInventory = {};
    },
  );
  await assert.rejects(validateContracts(emptyFixture));

  const corruptFixture = await createFixture(t);
  await mutateJson(
    corruptFixture,
    "studio/freecut-feature-manifest.json",
    (manifest) => {
      manifest.familySourceInventory.Audio[0] = "src/not-in-pinned-source.ts";
    },
  );
  await assert.rejects(
    validateContracts(corruptFixture),
    /outside pinned provenance/,
  );
});

test("runtime package versions and lockfile licenses are immutable", async (t) => {
  for (const [field, value] of [
    ["version", "999.0.0"],
    ["licenseDeclaredByLockfile", "invalid-license"],
  ]) {
    const fixture = await createFixture(t);
    await mutateJson(
      fixture,
      "studio/dependency-attribution.json",
      (attribution) => {
        attribution.runtimePackages[0][field] = value;
      },
    );
    await assert.rejects(validateContracts(fixture));
  }
});

test("all contract JSON rejects duplicate critical keys", async (t) => {
  const fixture = await createFixture(t);
  const target = path.join(fixture, "studio/freecut-provenance.json");
  const provenance = await readFile(target, "utf8");
  const duplicated = provenance.replace(
    /(\s+"archiveSha256": "[a-f0-9]+",)/u,
    '$1\n  "archiveSha256": "0000000000000000000000000000000000000000000000000000000000000000",',
  );
  assert.notEqual(
    duplicated,
    provenance,
    "fixture must duplicate archiveSha256",
  );
  await writeFile(target, duplicated);
  await assert.rejects(validateContracts(fixture), /duplicate object key/);
});
