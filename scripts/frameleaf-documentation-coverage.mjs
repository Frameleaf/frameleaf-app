#!/usr/bin/env node

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  parseJsonRejectingDuplicateKeys,
  validateContracts,
} from "./frameleaf-delivery-backlog-contracts.mjs";

const repository = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const PLAN = "docs/docs/developer/frameleaf-plan";
const FILES = {
  baseline: "docs/docs/developer/evidence/fl25-working-tree-baseline.json",
  backlog: `${PLAN}/backlog.json`,
  confluence: `${PLAN}/confluence-mirror.json`,
  evidence: `${PLAN}/delivery-backlog-evidence.json`,
  jira: `${PLAN}/jira-map.json`,
  ledger: `${PLAN}/action-preservation-ledger.json`,
  narrative: `${PLAN}/08-reproducibility.md`,
  reconciliation:
    "docs/docs/developer/evidence/fl25-working-tree-reconciliation.json",
  sourceEvidence: `${PLAN}/preservation-source-evidence.json`,
};
const AXES = ["source", "newUi", "api", "native", "tests"];
const REQUIRED_READBACK_SOURCES = new Set([
  ".agents/skills/frameleaf-deploy-release/SKILL.md",
  "AGENTS.md",
  "design/AGENTS.md",
  "design/README.md",
  "design/frameleaf/INTERACTION-REQUIREMENTS.md",
  "design/frameleaf/README.md",
  "design/frameleaf/references/README.md",
  "design/frameleaf/template/README.md",
  "docs/docs/developer/frameleaf-baseline-inventory.md",
  "docs/docs/developer/frameleaf-development.md",
  "docs/docs/developer/frameleaf-library-action-parity.md",
  "docs/docs/developer/frameleaf-plan/00-implementation-plan.md",
  "docs/docs/developer/frameleaf-plan/01-agent-execution.md",
  "docs/docs/developer/frameleaf-plan/02-library-and-administration.md",
  "docs/docs/developer/frameleaf-plan/03-studio-rendering-and-restoration.md",
  "docs/docs/developer/frameleaf-plan/04-native-and-release.md",
  "docs/docs/developer/frameleaf-plan/05-delivery-and-backlog.md",
  "docs/docs/developer/frameleaf-plan/06-brand-assets.md",
  "docs/docs/developer/frameleaf-plan/07-feature-ownership.md",
  "docs/docs/developer/frameleaf-plan/08-high-risk-workflow-designs.md",
  "docs/docs/developer/frameleaf-plan/08-reproducibility.md",
  "docs/docs/developer/frameleaf-plan/09-prototype-to-production.md",
  "docs/docs/developer/frameleaf-plan/10-agent-handoff-2026-09-22.md",
  "docs/docs/developer/frameleaf-settings-inventory.md",
  "docs/docs/developer/frameleaf-toolchain-baseline.md",
  "docs/docs/features/descriptions-and-smart-albums.md",
  "docs/docs/features/fork-privacy-suite.md",
  "docs/docs/features/google-photos-import.md",
  "docs/docs/features/image-enrichment.md",
  "docs/docs/features/library-care.md",
  "studio/README.md",
]);
const SHA256 = /^[a-f0-9]{64}$/u;
const NUMERIC_ID = /^[1-9]\d*$/u;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

const readJson = async (root, file) =>
  parseJsonRejectingDuplicateKeys(
    await readFile(path.join(root, file), "utf8"),
    file,
  );
const bytesAndHash = async (file) => {
  const bytes = await readFile(file);
  return {
    bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
};
const exists = async (file) => {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
};
const assertRelativePath = (value, label) => {
  assert.equal(typeof value, "string", `${label}: expected string path`);
  assert.ok(value.length > 0, `${label}: empty path`);
  assert.equal(path.isAbsolute(value), false, `${label}: absolute path`);
  assert.equal(
    value.split(/[\\/]/u).includes(".."),
    false,
    `${label}: parent traversal`,
  );
};
const assertNonBlankString = (value, label) => {
  assert.equal(typeof value, "string", `${label}: expected string`);
  assert.ok(value.trim().length > 0, `${label}: blank string`);
};
const assertMappingEvidence = (mappings, label) => {
  for (const axis of AXES) {
    const mapping = mappings?.[axis];
    assertNonBlankString(mapping?.status, `${label}.${axis}.status`);
    assert.ok(
      Array.isArray(mapping.evidence),
      `${label}.${axis}.evidence: expected array`,
    );
    assert.ok(
      mapping.evidence.length > 0,
      `${label}: missing ${axis} evidence`,
    );
    for (const [index, evidence] of mapping.evidence.entries())
      assertNonBlankString(evidence, `${label}.${axis}.evidence[${index}]`);
  }
};

function reduceEdges(items) {
  const byId = new Map(items.map((item) => [item.id, item]));
  const memo = new Map();
  const visiting = new Set();
  const ancestors = (id) => {
    if (memo.has(id)) return memo.get(id);
    assert.ok(!visiting.has(id), `dependency cycle at ${id}`);
    visiting.add(id);
    const result = new Set();
    for (const dependency of byId.get(id)?.dependencies ?? []) {
      assert.ok(
        byId.has(dependency),
        `${id}: unknown dependency ${dependency}`,
      );
      result.add(dependency);
      for (const ancestor of ancestors(dependency)) result.add(ancestor);
    }
    visiting.delete(id);
    memo.set(id, result);
    return result;
  };
  for (const id of byId.keys()) ancestors(id);
  return items.flatMap((item) => {
    const indirect = new Set();
    for (const dependency of item.dependencies)
      for (const ancestor of ancestors(dependency)) indirect.add(ancestor);
    return item.dependencies
      .filter((dependency) => !indirect.has(dependency))
      .map((dependency) => [dependency, item.id]);
  });
}

export async function validateDocumentationCoverage(root = repository) {
  await validateContracts(root);
  const [
    backlog,
    confluence,
    jira,
    ledger,
    sourceEvidence,
    reconciliation,
    baseline,
    deliveryEvidence,
    narrative,
  ] = await Promise.all([
    readJson(root, FILES.backlog),
    readJson(root, FILES.confluence),
    readJson(root, FILES.jira),
    readJson(root, FILES.ledger),
    readJson(root, FILES.sourceEvidence),
    readJson(root, FILES.reconciliation),
    readJson(root, FILES.baseline),
    readJson(root, FILES.evidence),
    readFile(path.join(root, FILES.narrative), "utf8"),
  ]);

  assert.equal(backlog.repository, "Frameleaf/frameleaf-app");
  assert.equal(backlog.defaultBranchObserved, "fork/main");
  const byId = new Map(backlog.items.map((item) => [item.id, item]));
  assert.equal(byId.size, backlog.items.length, "duplicate work ID");
  const trackedPaths = execFileSync(
    "git",
    ["ls-tree", "-r", "--name-only", "-z", "HEAD"],
    { cwd: root, encoding: "utf8" },
  )
    .split("\0")
    .filter(Boolean)
    .sort();
  const canonicalRoot = await realpath(root);

  const reconciliationByPath = new Map(
    reconciliation.entries.map((entry) => [entry.filePath, entry]),
  );
  assert.equal(
    reconciliationByPath.size,
    reconciliation.entries.length,
    "duplicate reconciliation path",
  );
  const baselineByPath = new Map(
    baseline.entries.map((entry) => [entry.filePath, entry]),
  );
  assert.equal(
    baselineByPath.size,
    baseline.entries.length,
    "duplicate baseline path",
  );
  assert.equal(
    reconciliation.sourceInventory.path,
    FILES.baseline,
    "reconciliation points to the wrong source inventory",
  );
  const baselineReceipt = await bytesAndHash(path.join(root, FILES.baseline));
  assert.equal(
    baselineReceipt.sha256,
    reconciliation.sourceInventory.sha256,
    "reconciliation source inventory hash drifted",
  );
  assert.equal(
    reconciliationByPath.size,
    baselineByPath.size,
    "reconciliation does not cover the complete preserved baseline",
  );
  for (const [filePath, entry] of reconciliationByPath) {
    assertRelativePath(filePath, `reconciliation entry ${filePath}`);
    assert.match(
      entry.preservedSha256,
      SHA256,
      `${filePath}: invalid preserved hash`,
    );
    assert.ok(
      Number.isInteger(entry.preservedBytes) && entry.preservedBytes >= 0,
      `${filePath}: invalid preserved byte count`,
    );
    const source = baselineByPath.get(filePath);
    assert.ok(source, `${filePath}: reconciliation row missing from baseline`);
    assert.equal(
      entry.preservedBytes,
      source.bytes,
      `${filePath}: preserved byte drift`,
    );
    assert.equal(
      entry.preservedSha256,
      source.sha256,
      `${filePath}: preserved hash drift`,
    );
    assert.equal(
      entry.preservedReviewState,
      source.reviewState,
      `${filePath}: preserved review-state drift`,
    );
    assert.equal(
      entry.workstream,
      source.workstream,
      `${filePath}: workstream drift`,
    );
  }
  const preservedPaths = [...reconciliationByPath.keys()].sort();
  const sourceAnchors = [];
  for (const source of [
    ...new Set(backlog.items.flatMap(({ paths }) => paths)),
  ].sort()) {
    assertRelativePath(source, `backlog source ${source}`);
    const target = path.join(root, source);
    const prefix = `${source.replace(/\/$/u, "")}/`;
    const trackedReceipts = trackedPaths.filter(
      (candidate) => candidate === source || candidate.startsWith(prefix),
    );
    if (trackedReceipts.length > 0) {
      assert.ok(
        await exists(target),
        `candidate-tracked source is absent: ${source}`,
      );
      const canonicalTarget = await realpath(target);
      assert.ok(
        canonicalTarget === canonicalRoot ||
          canonicalTarget.startsWith(`${canonicalRoot}${path.sep}`),
        `candidate-tracked source escapes repository: ${source}`,
      );
      sourceAnchors.push({
        path: source,
        state: "candidate-tracked",
        trackedPathSha256: digest(trackedReceipts),
      });
      continue;
    }
    const receipts = preservedPaths.filter(
      (candidate) => candidate === source || candidate.startsWith(prefix),
    );
    assert.ok(
      receipts.length > 0,
      `backlog source has no real anchor: ${source}`,
    );
    sourceAnchors.push({
      path: source,
      state: "preserved-dirty-only",
      receiptSha256: digest(
        receipts.map((candidate) => {
          const entry = reconciliationByPath.get(candidate);
          return [candidate, entry.preservedBytes, entry.preservedSha256];
        }),
      ),
    });
  }

  const stories = backlog.items.filter(({ type }) => type === "story");
  const epics = backlog.items.filter(({ type }) => type === "epic");
  for (const item of backlog.items) {
    assert.ok(item.acceptance.length > 0, `${item.id}: no acceptance criteria`);
    assert.ok(item.tests.length > 0, `${item.id}: no test contract`);
    if (item.type === "epic") {
      assert.equal(item.epicId, null, `${item.id}: epic has a parent`);
    } else {
      assert.equal(
        byId.get(item.epicId)?.type,
        "epic",
        `${item.id}: invalid parent ${item.epicId}`,
      );
    }
  }
  const reduced = reduceEdges(backlog.items);
  assert.deepEqual(
    jira.links,
    reduced,
    "Jira link graph is not the dependency DAG reduction",
  );
  const jiraIds = new Set();
  const jiraKeys = new Set();
  for (const item of backlog.items) {
    const issue = jira.issues[item.id];
    assert.ok(issue, `${item.id}: missing Jira identity`);
    assert.match(issue.id, NUMERIC_ID, `${item.id}: invalid Jira id`);
    assert.match(issue.key, /^FL-[1-9]\d*$/u, `${item.id}: invalid Jira key`);
    assert.ok(
      !jiraIds.has(issue.id),
      `${item.id}: duplicate Jira id ${issue.id}`,
    );
    assert.ok(
      !jiraKeys.has(issue.key),
      `${item.id}: duplicate Jira key ${issue.key}`,
    );
    jiraIds.add(issue.id);
    jiraKeys.add(issue.key);
  }
  assert.match(deliveryEvidence.source.normalizedSnapshotSha256, SHA256);
  assert.equal(deliveryEvidence.source.cloudId, jira.cloudId);

  const receiptStates = [];
  const pageGroups = new Map();
  const sourcePaths = new Set();
  for (const page of confluence.pages) {
    assertRelativePath(page.source, `Confluence source ${page.source}`);
    assert.match(page.id, NUMERIC_ID, `${page.source}: invalid Confluence id`);
    assert.match(
      page.url,
      new RegExp(
        `^https://heroit\\.atlassian\\.net/wiki/spaces/FR/pages/${page.id}(?:/[^/]+)?$`,
        "u",
      ),
      `${page.source}: URL does not contain exact page id`,
    );
    assert.match(
      page.sourceSha256,
      SHA256,
      `${page.source}: invalid source hash`,
    );
    assert.ok(
      Number.isInteger(page.bytes) && page.bytes > 0,
      `${page.source}: invalid byte count`,
    );
    assert.ok(
      Number.isInteger(page.version) && page.version > 0,
      `${page.source}: invalid version`,
    );
    assert.ok(
      [
        ...Object.keys(confluence.hubs),
        "design-template",
        "development",
        "plan",
      ].includes(page.category),
      `${page.source}: unknown page category`,
    );
    assert.ok(
      !sourcePaths.has(page.source),
      `${page.source}: duplicate mirror source`,
    );
    sourcePaths.add(page.source);

    const group = pageGroups.get(page.id) ?? [];
    group.push(page);
    pageGroups.set(page.id, group);
    const localPath = path.join(root, page.source);
    const current = (await exists(localPath))
      ? await bytesAndHash(localPath)
      : null;
    const preserved = reconciliationByPath.get(page.source);
    let state;
    if (current?.bytes === page.bytes && current.sha256 === page.sourceSha256) {
      state = "current-source";
    } else if (
      preserved?.preservedBytes === page.bytes &&
      preserved.preservedSha256 === page.sourceSha256
    ) {
      state = "historical-preserved-receipt";
    } else {
      assert.fail(
        `${page.source}: mirror hash/bytes have no exact source receipt`,
      );
    }
    if (REQUIRED_READBACK_SOURCES.has(page.source)) {
      assert.equal(
        page.verified,
        true,
        `${page.source}: missing verified readback flag`,
      );
      assert.equal(
        typeof page.verification,
        "string",
        `${page.source}: incomplete readback statement`,
      );
      assert.match(
        page.verifiedAt,
        /^\d{4}-\d{2}-\d{2}T/u,
        `${page.source}: invalid readback time`,
      );
      assert.match(
        page.verification,
        /read\s*back|readback/iu,
        `${page.source}: missing readback statement`,
      );
    } else {
      assert.equal(
        page.verified,
        undefined,
        `${page.source}: uncontracted verified readback flag`,
      );
      assert.equal(
        page.verification,
        undefined,
        `${page.source}: uncontracted readback statement`,
      );
      assert.equal(
        page.verifiedAt,
        undefined,
        `${page.source}: uncontracted readback time`,
      );
    }
    receiptStates.push({ id: page.id, source: page.source, state });
  }
  for (const [id, pages] of pageGroups) {
    if (pages.length === 1) continue;
    assert.equal(id, "61539021", `unexpected shared Confluence page ${id}`);
    assert.ok(pages.every(({ category }) => category === "design-template"));
    assert.equal(new Set(pages.map(({ title }) => title)).size, 1);
    assert.equal(new Set(pages.map(({ url }) => url)).size, 1);
    assert.equal(new Set(pages.map(({ version }) => version)).size, 1);
  }
  assert.equal(confluence.cloudId, jira.cloudId);
  assert.equal(confluence.spaceId, "61374475");
  assert.equal(confluence.spaceKey, "FR");
  assert.equal(confluence.homePageId, confluence.home.id);
  assert.match(confluence.home.id, NUMERIC_ID);
  assert.match(confluence.home.sourceSha256, SHA256);
  assert.equal(
    confluence.home.url,
    "https://heroit.atlassian.net/wiki/spaces/FR/overview",
  );
  assert.ok(
    Number.isInteger(confluence.home.version) && confluence.home.version > 0,
  );
  const homeReceipt = reconciliationByPath.get(confluence.home.source);
  assert.equal(
    homeReceipt?.preservedSha256,
    confluence.home.sourceSha256,
    "Confluence home source hash has no exact preserved receipt",
  );
  const hubIds = new Set();
  for (const hub of Object.values(confluence.hubs)) {
    assert.match(hub.id, NUMERIC_ID);
    assert.ok(!hubIds.has(hub.id), `duplicate Confluence hub id ${hub.id}`);
    hubIds.add(hub.id);
    assert.ok(Number.isInteger(hub.version) && hub.version > 0);
    assert.equal(
      hub.url.includes(`/pages/${hub.id}/`),
      true,
      `${hub.title}: URL does not contain exact hub id`,
    );
  }
  const historical = receiptStates.filter(({ state }) =>
    state.startsWith("historical"),
  );
  assert.ok(
    historical.length > 0,
    "historical receipts were silently promoted",
  );
  assert.deepEqual(
    new Set(
      receiptStates
        .filter(
          ({ source, state }) =>
            REQUIRED_READBACK_SOURCES.has(source) && state === "current-source",
        )
        .map(({ source }) => source),
    ),
    REQUIRED_READBACK_SOURCES,
    "required readback set is not exactly the current verified source set",
  );
  for (const marker of [
    "Historical source receipt",
    "preserve user-authored additions",
    "read the remote page before every write",
    "Jira remains authoritative for current workflow state",
  ])
    assert.ok(
      narrative.includes(marker),
      `reproducibility narrative lost: ${marker}`,
    );

  assert.equal(ledger.sourceEvidenceSha256, digest(sourceEvidence));
  assert.equal(
    ledger.sourceRows.length,
    Object.keys(ledger.reverseIndex).length,
  );
  const sourceRows = new Map(
    ledger.sourceRows.map((row) => [row.sourceRowId, row]),
  );
  const requirements = new Map(
    ledger.requirements.map((row) => [row.requirementId, row]),
  );
  assert.equal(
    sourceRows.size,
    ledger.sourceRows.length,
    "duplicate ledger source row",
  );
  assert.equal(
    requirements.size,
    ledger.requirements.length,
    "duplicate ledger requirement",
  );
  for (const row of ledger.sourceRows) {
    assert.equal(
      ledger.reverseIndex[row.sourceRowId],
      row.canonicalRequirementId,
      `${row.sourceRowId}: broken reverse mapping`,
    );
    const requirement = requirements.get(row.canonicalRequirementId);
    assert.ok(requirement, `${row.sourceRowId}: missing requirement`);
    assert.ok(
      requirement.sourceRowIds.includes(row.sourceRowId),
      `${row.sourceRowId}: absent from canonical requirement membership`,
    );
    assertNonBlankString(row.qualification, `${row.sourceRowId}.qualification`);
    assertMappingEvidence(row.mappings, row.sourceRowId);
  }
  for (const requirement of ledger.requirements) {
    assertNonBlankString(
      requirement.qualification,
      `${requirement.requirementId}.qualification`,
    );
    assertNonBlankString(
      requirement.disposition?.kind,
      `${requirement.requirementId}.disposition.kind`,
    );
    assertMappingEvidence(requirement.mappings, requirement.requirementId);
    assert.ok(
      requirement.sourceRowIds.length > 0,
      `${requirement.requirementId}: no source evidence`,
    );
    for (const sourceRowId of requirement.sourceRowIds)
      assert.equal(
        sourceRows.get(sourceRowId)?.canonicalRequirementId,
        requirement.requirementId,
        `${requirement.requirementId}: contradictory source evidence ${sourceRowId}`,
      );
    for (const owner of [
      requirement.owners.primary,
      ...requirement.owners.secondary,
    ]) {
      assert.equal(
        byId.get(owner.planId)?.type,
        "story",
        `${requirement.requirementId}: owner is not a story`,
      );
      const issue = jira.issues[owner.planId];
      assert.equal(
        owner.jiraKey,
        issue?.key,
        `${requirement.requirementId}: noncanonical Jira owner key`,
      );
      assert.equal(
        owner.url,
        issue?.url,
        `${requirement.requirementId}: noncanonical Jira owner URL`,
      );
    }
  }

  return {
    confluencePages: confluence.pages.length,
    currentMirrorReceipts: receiptStates.length - historical.length,
    declaredDependencies: backlog.items.reduce(
      (sum, item) => sum + item.dependencies.length,
      0,
    ),
    epics: epics.length,
    historicalMirrorReceipts: historical.length,
    jiraIssues: jiraIds.size,
    jiraLinks: reduced.length,
    ledgerRequirements: requirements.size,
    ledgerSourceRows: sourceRows.size,
    sourceAnchorSha256: digest(sourceAnchors),
    sourceAnchors: sourceAnchors.length,
    stories: stories.length,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2] ? path.resolve(process.argv[2]) : repository;
  const result = await validateDocumentationCoverage(root);
  console.log(
    `Validated ${result.sourceAnchors} source anchors, ${result.jiraIssues} Jira identities/${result.jiraLinks} Blocks links, ${result.confluencePages} Confluence source receipts (${result.currentMirrorReceipts} current, ${result.historicalMirrorReceipts} historical), and ${result.ledgerSourceRows} ledger rows/${result.ledgerRequirements} requirements.`,
  );
}
