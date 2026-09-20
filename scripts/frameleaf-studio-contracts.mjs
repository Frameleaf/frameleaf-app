#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const FREECUT_COMMIT = "4d62e8082c5eb387a96275bcbd323d28f6e41a62";
const FREECUT_ARCHIVE_URL =
  "https://codeload.github.com/walterlow/freecut/tar.gz/4d62e8082c5eb387a96275bcbd323d28f6e41a62";
const FREECUT_ARCHIVE_SHA256 =
  "b4224e5c219a6302586cbe2242e9e6d299dfd1878f1fcd0f2d77ea3db12a5d32";
const FREECUT_LEDGER_SHA256 =
  "a56d57c4bcd2c996c389bb7470216b185caa28de389def109bf4d86fd95e3adb";
const FREECUT_LOCKFILE_SHA256 =
  "b4a86741ce7891da1f63df01b6fdd4ed507e8887d5097c6a0f93fc2ea6f3420e";
const FAMILY_SOURCE_INVENTORY_SHA256 =
  "7188a7e97f2f2af684e453dbf3c073fff97cf85d6ea7ca4d679db8e9890006da";
const RUNTIME_PACKAGES_SHA256 =
  "35fd3987079cae88f39719dad74260a7b2f29d1f6e41d6c1f891066347cc1203";
const EXPECTED_FAMILY_SOURCE_COUNTS = {
  Audio: 556,
  "Effects, Masks & Compositing": 26,
  Export: 150,
  "Keyframe Animation": 185,
  "Local AI & Analysis": 47,
  "Media & Import": 139,
  "Preview & Playback": 430,
  "Projects & Storage": 84,
  "Timeline & Editing": 546,
  Transitions: 41,
};
const EXECUTION_GUIDE =
  "docs/docs/developer/frameleaf-plan/01-agent-execution.md";
const STUDIO_GUIDE =
  "docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md";
const CANONICAL_BACKLOG = "docs/docs/developer/frameleaf-plan/backlog.json";
const EXPECTED_EXTERNAL_DEPENDENCIES = {
  "STU-101": ["FN-101"],
  "STU-102": ["FN-102"],
  "STU-201": ["FN-202", "FN-301"],
  "STU-202": ["FN-301", "FN-304"],
  "STU-401": ["FN-302"],
  "STU-403": ["FN-303"],
  "VID-101": ["FN-101"],
  "VID-090": ["FN-101"],
  "AI-101": ["FN-302"],
};
const CONTRACT_FILES = [
  "docs/docs/developer/frameleaf-plan/freecut-issue-map.json",
  "docs/docs/developer/frameleaf-plan/studio-backlog.json",
  "studio/dependency-attribution.json",
  "studio/freecut-feature-manifest.json",
  "studio/freecut-provenance.json",
];
const NARRATIVE =
  "docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md";
const EVIDENCE_FILES = [NARRATIVE, CANONICAL_BACKLOG, ...CONTRACT_FILES];

const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export function parseJsonRejectingDuplicateKeys(text, source = "JSON input") {
  let index = 0;
  const fail = (message) => {
    throw new SyntaxError(`${source}: ${message} at byte ${index}`);
  };
  const whitespace = () => {
    while (/\s/.test(text[index] ?? "")) index++;
  };
  const string = () => {
    if (text[index] !== '"') fail("expected string");
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") {
        index += 2;
      } else if (text[index++] === '"') {
        return JSON.parse(text.slice(start, index));
      }
    }
    fail("unterminated string");
  };
  const value = () => {
    whitespace();
    if (text[index] === "{") {
      index++;
      whitespace();
      const keys = new Set();
      if (text[index] === "}") {
        index++;
        return;
      }
      while (index < text.length) {
        const key = string();
        if (keys.has(key)) fail(`duplicate object key ${JSON.stringify(key)}`);
        keys.add(key);
        whitespace();
        if (text[index++] !== ":") fail("expected colon");
        value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "}") return;
        if (delimiter !== ",") fail("expected object delimiter");
        whitespace();
      }
      fail("unterminated object");
    }
    if (text[index] === "[") {
      index++;
      whitespace();
      if (text[index] === "]") {
        index++;
        return;
      }
      while (index < text.length) {
        value();
        whitespace();
        const delimiter = text[index++];
        if (delimiter === "]") return;
        if (delimiter !== ",") fail("expected array delimiter");
      }
      fail("unterminated array");
    }
    if (text[index] === '"') {
      string();
      return;
    }
    for (const literal of ["true", "false", "null"]) {
      if (text.startsWith(literal, index)) {
        index += literal.length;
        return;
      }
    }
    const number = text
      .slice(index)
      .match(/^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/u)?.[0];
    if (!number) fail("expected value");
    index += number.length;
  };
  value();
  whitespace();
  if (index !== text.length) fail("unexpected trailing content");
  return JSON.parse(text);
}

const readJson = async (root, file) =>
  parseJsonRejectingDuplicateKeys(
    await readFile(path.join(root, file), "utf8"),
    file,
  );

export async function validateContracts(root) {
  const [issueMap, backlog, attribution, manifest, provenance] =
    await Promise.all(CONTRACT_FILES.map((file) => readJson(root, file)));
  const canonicalBacklog = await readJson(root, CANONICAL_BACKLOG);
  const narrative = await readFile(path.join(root, NARRATIVE), "utf8");
  for (const record of [issueMap, attribution, manifest]) {
    assert.equal(record.engineRevision, FREECUT_COMMIT);
  }
  assert.equal(provenance.commit, FREECUT_COMMIT);
  assert.equal(provenance.repository, "https://github.com/walterlow/freecut");
  assert.equal(provenance.archiveUrl, FREECUT_ARCHIVE_URL);
  assert.equal(provenance.archiveSha256, FREECUT_ARCHIVE_SHA256);
  assert.equal(provenance.orderedFilesSha256, FREECUT_LEDGER_SHA256);
  assert.equal(provenance.license, "MIT");
  assert.equal(provenance.licensePath, "vendor/freecut/LICENSE");
  assert.deepEqual(provenance.modifications, []);
  assert.equal(provenance.files.length, 2646);
  assert.equal(new Set(provenance.files.map(({ path }) => path)).size, 2646);
  assert.ok(
    provenance.files.every(
      ({ path, sha256 }) =>
        typeof path === "string" &&
        !path.startsWith("/") &&
        !path.split("/").includes("..") &&
        /^[a-f0-9]{64}$/.test(sha256),
    ),
  );
  for (const row of provenance.files) {
    assert.deepEqual(Object.keys(row).sort(), ["path", "sha256"]);
  }
  assert.equal(digest(JSON.stringify(provenance.files)), FREECUT_LEDGER_SHA256);
  const provenanceByPath = new Map(
    provenance.files.map((entry) => [entry.path, entry.sha256]),
  );
  assert.deepEqual(
    manifest.familySourceInventoryContract,
    {
      categories: EXPECTED_FAMILY_SOURCE_COUNTS,
      pathReferences: 2204,
      sha256: FAMILY_SOURCE_INVENTORY_SHA256,
      uniquePaths: 1659,
    },
    "Family source inventory contract drifted",
  );
  const familyEntries = Object.entries(manifest.familySourceInventory);
  assert.deepEqual(
    familyEntries.map(([category]) => category),
    Object.keys(EXPECTED_FAMILY_SOURCE_COUNTS),
    "Family source inventory categories drifted",
  );
  const familyPaths = [];
  for (const [category, paths] of familyEntries) {
    assert.equal(
      paths.length,
      EXPECTED_FAMILY_SOURCE_COUNTS[category],
      `${category} family source count drifted`,
    );
    assert.equal(
      new Set(paths).size,
      paths.length,
      `${category} family source inventory contains duplicates`,
    );
    for (const sourcePath of paths) {
      assert.ok(
        typeof sourcePath === "string" &&
          sourcePath.length > 0 &&
          !sourcePath.startsWith("/") &&
          !sourcePath.split("/").includes(".."),
        `${category} has invalid ${sourcePath}`,
      );
      assert.ok(
        provenanceByPath.has(sourcePath),
        `${category} source is outside pinned provenance: ${sourcePath}`,
      );
      familyPaths.push(sourcePath);
    }
  }
  assert.equal(familyPaths.length, 2204);
  assert.equal(new Set(familyPaths).size, 1659);
  assert.equal(
    digest(JSON.stringify(manifest.familySourceInventory)),
    FAMILY_SOURCE_INVENTORY_SHA256,
  );

  assert.equal(manifest.features.length, 210);
  assert.equal(manifest.counts.features, 210);
  assert.equal(
    manifest.features.filter(({ id }) => id.startsWith("readme.")).length,
    manifest.counts.readme,
  );
  assert.equal(
    manifest.features.filter(({ id }) => id.startsWith("effect.")).length,
    manifest.counts.effects,
  );
  assert.equal(
    manifest.features.filter(({ id }) => id.startsWith("transition.")).length,
    manifest.counts.transitions,
  );
  assert.equal(
    manifest.features.filter(({ id }) => id.startsWith("blend.")).length,
    manifest.counts.blendModes,
  );
  assert.equal(
    manifest.features.filter(({ id }) => id.startsWith("command.")).length,
    manifest.counts.commands,
  );
  assert.equal(new Set(manifest.features.map(({ id }) => id)).size, 210);
  assert.deepEqual(
    [
      ...new Set(
        manifest.features
          .filter(({ id }) => id.startsWith("readme."))
          .map(({ category }) => category),
      ),
    ].sort(),
    Object.keys(EXPECTED_FAMILY_SOURCE_COUNTS).sort(),
    "README feature categories and family source inventory must match",
  );
  for (const feature of manifest.features) {
    assert.ok(
      feature.source.length > 0,
      `${feature.id} has no source evidence`,
    );
    for (const source of feature.source) {
      const relative = source.path.replace(/^vendor\/freecut\//, "");
      assert.ok(source.url.includes(FREECUT_COMMIT));
      assert.equal(
        provenanceByPath.get(relative),
        source.sha256,
        `${feature.id} source is outside the pinned provenance ledger`,
      );
    }
    assert.equal(feature.status.native, "not-implemented-in-frameleaf");
    assert.equal(feature.status.test.execution, "not-run");
    assert.notEqual(feature.status.render, "qualified");
  }

  assert.equal(issueMap.manifestPath, "studio/freecut-feature-manifest.json");
  assert.equal(
    issueMap.backlogPath,
    "docs/docs/developer/frameleaf-plan/studio-backlog.json",
  );
  assert.equal(issueMap.rows.length, 210);
  assert.deepEqual(
    issueMap.rows.map(({ id }) => id).sort(),
    manifest.features.map(({ id }) => id).sort(),
  );
  assert.ok(
    issueMap.rows.every(({ status }) => status === "planned-not-qualified"),
  );
  const backlogIds = new Set(backlog.map(({ id }) => id));
  assert.equal(backlog.filter(({ type }) => type === "epic").length, 7);
  assert.equal(backlog.filter(({ type }) => type === "story").length, 33);
  for (const row of issueMap.rows) {
    assert.ok(row.issueIds.length > 0, `${row.id} has no delivery owner`);
    for (const issueId of row.issueIds) {
      assert.ok(
        backlogIds.has(issueId),
        `${row.id} references unknown ${issueId}`,
      );
    }
  }
  const canonicalStudioItems = canonicalBacklog.items.filter(
    ({ workstream }) => workstream === "studio",
  );
  assert.equal(canonicalStudioItems.length, 40);
  const canonicalIds = new Set(canonicalBacklog.items.map(({ id }) => id));
  const externalDependencies = Object.fromEntries(
    backlog
      .map((item) => [
        item.id,
        item.dependencies.filter((dependency) => !backlogIds.has(dependency)),
      ])
      .filter(([, dependencies]) => dependencies.length > 0),
  );
  assert.deepEqual(externalDependencies, EXPECTED_EXTERNAL_DEPENDENCIES);
  assert.equal(Object.keys(externalDependencies).length, 9);
  for (const [itemId, dependencies] of Object.entries(externalDependencies)) {
    for (const dependency of dependencies) {
      assert.ok(
        canonicalIds.has(dependency),
        `${itemId} depends on missing canonical item ${dependency}`,
      );
    }
  }
  const specializedProjection = canonicalStudioItems.map((item) => ({
    acceptance: item.acceptance,
    dependencies: item.dependencies,
    ...(item.epicId === null ? {} : { epicId: item.epicId }),
    id: item.id,
    objective: item.objective,
    paths: item.paths,
    phase: item.sourcePhase,
    risks: item.risks,
    tests: item.tests,
    title: item.title,
    type: item.type,
  }));
  assert.deepEqual(
    backlog,
    specializedProjection,
    "Specialized Studio backlog must exactly match the canonical Studio projection",
  );
  assert.ok(
    canonicalStudioItems.every(
      (item) =>
        item.executionGuide === EXECUTION_GUIDE &&
        item.workstreamGuide === STUDIO_GUIDE &&
        !("pendingWorkstreamGuide" in item) &&
        !("workstreamGuideStatus" in item),
    ),
    "Canonical Studio records must point to the reviewed Studio guide",
  );
  const narrativeRows = [
    ...narrative.matchAll(/^\|\s+`([^`]+)`\s+\|.*\|\s+([A-Z]+-\d+)\s+\|$/gm),
  ].map(([, id, issueId]) => ({ id, issueId }));
  assert.equal(narrativeRows.length, 210);
  assert.deepEqual(
    narrativeRows,
    issueMap.rows.map(({ id, issueIds }) => ({ id, issueId: issueIds[0] })),
  );
  assert.equal(attribution.upstreamLicense.spdx, "MIT");
  assert.equal(attribution.dolbyTools.included, false);
  assert.match(attribution.dolbyTools.access, /until .*terms verified/i);
  assert.deepEqual(attribution.runtimePackageContract, {
    rowCount: 51,
    rowsSha256: RUNTIME_PACKAGES_SHA256,
    sourceLockfile: "vendor/freecut/package-lock.json",
    sourceLockfileSha256: FREECUT_LOCKFILE_SHA256,
  });
  assert.equal(
    provenanceByPath.get("package-lock.json"),
    FREECUT_LOCKFILE_SHA256,
    "Runtime package contract must name the pinned source lockfile",
  );
  assert.equal(attribution.runtimePackages.length, 51);
  assert.equal(
    digest(JSON.stringify(attribution.runtimePackages)),
    RUNTIME_PACKAGES_SHA256,
  );
  assert.equal(
    new Set(attribution.runtimePackages.map(({ name }) => name)).size,
    51,
  );
  assert.deepEqual(
    attribution.runtimePackages.map(({ name }) => name),
    attribution.runtimePackages.map(({ name }) => name).sort(),
    "Runtime package rows must remain ordered by package name",
  );
  for (const row of attribution.runtimePackages) {
    assert.deepEqual(Object.keys(row).sort(), [
      "basis",
      "distributionReview",
      "licenseDeclaredByLockfile",
      "name",
      "version",
    ]);
    assert.equal(row.basis, "vendor/freecut/package-lock.json");
    assert.equal(
      row.distributionReview,
      "required-before-application-bundling",
    );
    assert.match(row.name, /\S/u);
    assert.match(
      row.version,
      /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u,
      `${row.name} has invalid locked version`,
    );
    assert.match(
      row.licenseDeclaredByLockfile,
      /\S/u,
      `${row.name} has no lockfile license`,
    );
  }

  const files = [];
  for (const file of EVIDENCE_FILES) {
    files.push({ file, sha256: digest(await readFile(path.join(root, file))) });
  }
  return {
    engineRevision: FREECUT_COMMIT,
    featureCount: manifest.features.length,
    familySourcePathCount: familyPaths.length,
    provenanceFileCount: provenance.files.length,
    issueMapCount: issueMap.rows.length,
    epicCount: backlog.filter(({ type }) => type === "epic").length,
    storyCount: backlog.filter(({ type }) => type === "story").length,
    qualification: "planned-not-qualified",
    runtimePackageCount: attribution.runtimePackages.length,
    files,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const repositoryIndex = args.indexOf("--repository");
  const repository = path.resolve(
    repositoryIndex >= 0 ? args[repositoryIndex + 1] : ".",
  );
  process.stdout.write(
    `${JSON.stringify(await validateContracts(repository))}\n`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await main();
}
