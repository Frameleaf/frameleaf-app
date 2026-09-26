import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";
import {
  auditDocPath,
  buildEvidence,
  evidencePath,
  STATUS_VOCABULARY,
} from "./frameleaf-conformance-evidence.mjs";

const root = resolve(import.meta.dirname, "..");
const committed = JSON.parse(readFileSync(evidencePath, "utf8"));
const ledger = JSON.parse(
  readFileSync(
    resolve(
      root,
      "docs/docs/developer/frameleaf-plan/action-preservation-ledger.json",
    ),
    "utf8",
  ),
);
const inventory = JSON.parse(
  readFileSync(
    resolve(root, "docs/docs/developer/frameleaf-route-inventory.json"),
    "utf8",
  ),
);
const auditDoc = readFileSync(resolve(root, auditDocPath), "utf8");
const mirror = JSON.parse(
  readFileSync(
    resolve(root, "docs/docs/developer/frameleaf-plan/confluence-mirror.json"),
    "utf8",
  ),
);

const rows = [...committed.webActions, ...committed.routes];
const mentions = (id) =>
  new RegExp(
    `(^|[^A-Za-z0-9-])${id.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9-])`,
    "m",
  ).test(auditDoc);

test("the committed conformance evidence is what the generator produces (drift fails, rows are never dropped)", async () => {
  const generated = await buildEvidence(root);
  assert.deepEqual(committed, generated);
});

test("every web action in the preservation ledger has exactly one conformance row, and nothing else does", () => {
  const expected = ledger.requirements
    .filter((row) => row.kinds.includes("web-action"))
    .map((row) => row.requirementId)
    .sort();
  const actual = committed.webActions.map((row) => row.requirementId).sort();
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
});

test("every committed route has exactly one conformance row, and nothing else does", () => {
  const expected = [...inventory.productionRoutes].sort();
  const actual = committed.routes.map((row) => row.route).sort();
  assert.deepEqual(actual, expected);
  assert.equal(new Set(actual).size, actual.length);
});

test("every row cites prototype modules and production files that exist", () => {
  for (const row of rows) {
    const id = row.requirementId ?? row.route;
    assert.ok(row.prototype.length > 0, `${id}: no prototype module`);
    assert.ok(row.production.length > 0, `${id}: no production counterpart`);
    for (const path of row.prototype) {
      assert.ok(
        path.startsWith("design/frameleaf/template/src/"),
        `${id}: ${path} is not a prototype module`,
      );
      assert.ok(
        existsSync(resolve(root, path)),
        `${id}: missing prototype file ${path}`,
      );
    }
    for (const path of row.production) {
      assert.ok(
        path.startsWith("web/src/"),
        `${id}: ${path} is not a production path`,
      );
      assert.ok(
        existsSync(resolve(root, path)),
        `${id}: missing production file ${path}`,
      );
    }
  }
});

test("statuses come from the vocabulary and unresolved rows name their gaps and follow-up in the audit document", () => {
  assert.deepEqual(committed.statusVocabulary, STATUS_VOCABULARY);
  for (const row of rows) {
    const id = row.requirementId ?? row.route;
    assert.ok(
      STATUS_VOCABULARY.includes(row.status),
      `${id}: unknown status ${row.status}`,
    );
    if (["partial", "missing", "fixed"].includes(row.status)) {
      assert.ok(row.gaps.length > 0, `${id}: ${row.status} without a gap id`);
      assert.ok(row.followUp, `${id}: ${row.status} without a follow-up`);
    }
    for (const gap of row.gaps) {
      assert.ok(
        mentions(gap),
        `${id}: gap ${gap} is not recorded in ${auditDocPath}`,
      );
    }
  }
});

test("the audit document exists, is not Confluence-mirrored and claims no release readiness", () => {
  assert.ok(existsSync(resolve(root, auditDocPath)));
  assert.equal(
    mirror.pages.some((page) => page.source === auditDocPath),
    false,
    "the conformance audit is a repository-only working document",
  );
  assert.equal(committed.auditDocument, auditDocPath);
  assert.match(committed.status, /not-qualified/);
  assert.doesNotMatch(auditDoc, /release[- ]ready/i);
});
