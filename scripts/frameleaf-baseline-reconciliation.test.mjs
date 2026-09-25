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
    epicRoutingReferences: 49,
    mainBlobAbsent: 3164,
    mainBlobDifferent: 192,
    mainBlobIdentical: 164,
    pathCount: 3520,
    pathsWithEpicRouting: 40,
    preservedOnlyUnaccepted: 3356,
    uniqueEpicRoutingIds: 20,
    withSourceBackedRouting: 1925,
    withoutExactRouting: 1595,
    withoutExactRoutingLocalEvidence: 1,
    withoutExactRoutingUnreviewedLocalChange: 1594,
  });
  assert.ok(
    report.entries.every(({ disposition }) =>
      ["already-represented", "preserved-only-unaccepted"].includes(
        disposition,
      ),
    ),
  );
  const epicRouting = report.entries.flatMap(
    ({ filePath, sourceBackedRouting }) =>
      sourceBackedRouting
        .filter(({ issueType }) => issueType === "epic")
        .map(({ planId }) => ({ filePath, planId })),
  );
  assert.equal(epicRouting.length, 49);
  assert.equal(new Set(epicRouting.map(({ filePath }) => filePath)).size, 40);
  assert.equal(new Set(epicRouting.map(({ planId }) => planId)).size, 20);
  assert.ok(
    report.entries.every(({ sourceBackedRouting }) =>
      sourceBackedRouting.every(({ issueType }) =>
        ["epic", "story"].includes(issueType),
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

test("documents FL-25 acceptance separately from FL-26 ownership", () => {
  const inventory = readFileSync(
    path.join(
      repository,
      "docs/docs/developer/frameleaf-baseline-inventory.md",
    ),
    "utf8",
  );
  const delivery = readFileSync(
    path.join(
      repository,
      "docs/docs/developer/frameleaf-plan/05-delivery-and-backlog.md",
    ),
    "utf8",
  );
  const toolchain = readFileSync(
    path.join(
      repository,
      "docs/docs/developer/frameleaf-toolchain-baseline.md",
    ),
    "utf8",
  );
  const mirrorPath =
    "docs/docs/developer/frameleaf-plan/confluence-mirror.json";
  const mirror = parseJsonRejectingDuplicateKeys(
    readFileSync(path.join(repository, mirrorPath), "utf8"),
    mirrorPath,
  );

  for (const criterion of [
    "Verify Frameleaf repository ownership and the literal default branch",
    "Record old local remotes and authorized remote/branch changes",
    "Preserve and classify every modified or untracked path",
    "Record tool versions and the exact reviewed baseline",
  ])
    assert.ok(inventory.includes(criterion), `Missing criterion: ${criterion}`);

  for (const statement of [
    "1,603 paths lack exact source-backed routing",
    "informational triage statistic, not an FL-25 acceptance gap",
    "44 epic references across 36 paths and 17 unique epic IDs",
    "Raw-path Jira ownership is not required to accept FL-25",
    "FL-26 owns action- and requirement-level preservation coverage",
    "bulk copying the dirty checkout is forbidden",
    "ffmpeg 9.0.1, Node.js 24.19.0, and Python 3.9.6",
  ])
    assert.ok(inventory.includes(statement), `Missing boundary: ${statement}`);

  assert.ok(
    delivery.includes("FL-26 owns action- and requirement-level coverage"),
  );
  assert.ok(
    delivery.includes(
      "Raw-path Jira routing is not an FL-25 acceptance prerequisite",
    ),
  );
  assert.ok(toolchain.includes("satisfy the tool-version evidence criterion"));
  assert.doesNotMatch(
    `${inventory}\n${delivery}\n${toolchain}`,
    /Resolving those paths remains explicit FL-25 acceptance work|wider dirty-source reconciliation is incomplete|wider preserved working tree is reviewed and accepted/,
  );

  assert.deepEqual(
    Object.fromEntries(
      mirror.pages
        .filter(({ id }) => ["61407624", "61407916", "61407947"].includes(id))
        .map(({ id, sourceSha256, version }) => [
          id,
          { sourceSha256, version },
        ]),
    ),
    {
      61407624: {
        sourceSha256:
          "7bedfc6608e125f5ffe821a41307903098f51ba9a1ad1e2a30ce3d5566889707",
        version: 7,
      },
      61407916: {
        sourceSha256:
          "c1df5d16a750cbede362659748ec84389b6832d75d2a0997e9f86f66a7eec2e5",
        version: 6,
      },
      61407947: {
        sourceSha256:
          "48a3826427b0ee18c5e3bec50f9fe7e3e9ea31e2cd547d343947059c6b677bbb",
        version: 2,
      },
    },
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
