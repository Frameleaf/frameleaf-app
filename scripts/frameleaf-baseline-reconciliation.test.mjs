import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildReconciliation,
  parseJsonRejectingDuplicateKeys,
  serializeCanonical,
  validateReconciliation,
} from "./frameleaf-baseline-reconciliation.mjs";

const repository = fileURLToPath(new URL("..", import.meta.url));
const currentMain = "7eab5558e612b44e519052b5bf4da0c628f9093f";
const evidence =
  "docs/docs/developer/evidence/fl25-working-tree-reconciliation.json";

test("reconciles all 3,520 paths without accepting dirty source", () => {
  const report = buildReconciliation({ currentMain, root: repository });
  assert.deepEqual(report.summary, {
    alreadyRepresented: 164,
    mainBlobAbsent: 3164,
    mainBlobDifferent: 192,
    mainBlobIdentical: 164,
    pathCount: 3520,
    preservedOnlyUnaccepted: 3356,
    withFutureOwners: report.summary.withFutureOwners,
    withoutFutureOwners: report.summary.withoutFutureOwners,
  });
  assert.ok(
    report.entries.every(({ disposition }) =>
      ["already-represented", "preserved-only-unaccepted"].includes(
        disposition,
      ),
    ),
  );
  assert.ok(
    report.entries.every(
      ({ disposition, mainBlobRelation }) =>
        (disposition === "already-represented") ===
        (mainBlobRelation === "identical"),
    ),
  );
});

test("checked-in evidence is canonical and exactly regenerates", () => {
  const text = readFileSync(path.join(repository, evidence), "utf8");
  const report = parseJsonRejectingDuplicateKeys(text, evidence);
  assert.equal(text, serializeCanonical(report));
  assert.deepEqual(
    validateReconciliation(report, { currentMain, root: repository }),
    report.summary,
  );
});

test("rejects duplicate JSON keys", () => {
  assert.throws(
    () => parseJsonRejectingDuplicateKeys('{"pathCount":1,"pathCount":2}'),
    /duplicate object key/,
  );
});

test("detects path, hash, disposition, and main-blob drift", () => {
  const original = buildReconciliation({ currentMain, root: repository });
  for (const mutate of [
    (report) => report.entries.shift(),
    (report) => {
      report.entries[0].preservedSha256 = "0".repeat(64);
    },
    (report) => {
      report.entries[0].disposition = "preserved-only-unaccepted";
    },
    (report) => {
      report.entries[0].mainBlobRelation = "different";
    },
  ]) {
    const report = structuredClone(original);
    mutate(report);
    assert.throws(() =>
      validateReconciliation(report, { currentMain, root: repository }),
    );
  }
});
