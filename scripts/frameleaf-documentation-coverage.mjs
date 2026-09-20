#!/usr/bin/env node

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
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
    if (await exists(target)) {
      sourceAnchors.push({ path: source, state: "accepted-main" });
      continue;
    }
    const prefix = `${source.replace(/\/$/u, "")}/`;
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
    if (page.verified || page.verification || page.verifiedAt) {
      if (Object.hasOwn(page, "verified"))
        assert.equal(
          page.verified,
          true,
          `${page.source}: false readback receipt`,
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
    assert.ok(
      requirements.has(row.canonicalRequirementId),
      `${row.sourceRowId}: missing requirement`,
    );
    for (const axis of AXES) {
      assert.equal(
        typeof row.mappings[axis]?.status,
        "string",
        `${row.sourceRowId}: missing ${axis} status`,
      );
      assert.ok(
        row.mappings[axis].evidence?.length > 0,
        `${row.sourceRowId}: missing ${axis} evidence`,
      );
    }
  }
  for (const requirement of ledger.requirements) {
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
