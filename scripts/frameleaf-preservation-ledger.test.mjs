import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const script = resolve(root, "scripts/frameleaf-preservation-ledger.mjs");
const ledgerPath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/action-preservation-ledger.json",
);
const ledger = JSON.parse(readFileSync(ledgerPath, "utf8"));
const evidence = JSON.parse(
  readFileSync(
    resolve(
      root,
      "docs/docs/developer/frameleaf-plan/preservation-source-evidence.json",
    ),
    "utf8",
  ),
);
const actionRegistry = JSON.parse(
  readFileSync(
    resolve(root, "docs/docs/developer/frameleaf-plan/action-id-registry.json"),
    "utf8",
  ),
);

function validate(candidate, raw) {
  const directory = mkdtempSync(join(tmpdir(), "frameleaf-ledger-"));
  const path = join(directory, "candidate.json");
  writeFileSync(path, raw ?? JSON.stringify(candidate));
  const result = spawnSync(
    process.execPath,
    [script, "--validate-ledger", path],
    { cwd: root, encoding: "utf8" },
  );
  rmSync(directory, { recursive: true, force: true });
  return result;
}

function mutated(change) {
  const value = structuredClone(ledger);
  change(value);
  return validate(value);
}

test("committed ledger is reproducible and valid", () => {
  const result = spawnSync(process.execPath, [script, "--check"], {
    cwd: root,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("every raw inventory row reverse-maps exactly once", () => {
  assert.equal(
    Object.keys(ledger.reverseIndex).length,
    ledger.sourceRows.length,
  );
  assert.equal(
    new Set(ledger.sourceRows.map(({ sourceRowId }) => sourceRowId)).size,
    ledger.sourceRows.length,
  );
});

test("only the twenty reviewed queue concurrency aliases collapse", () => {
  const shared = ledger.requirements.filter(
    ({ sourceRowIds }) => sourceRowIds.length > 1,
  );
  assert.equal(shared.length, 20);
  assert.ok(
    shared.every(
      ({ requirementId, sourceRowIds }) =>
        requirementId.startsWith("setting:system:job.") &&
        sourceRowIds.length === 2,
    ),
  );
});

test("same source module does not merge distinct behavior without a reviewed alias", () => {
  const accountRows = ledger.sourceRows.filter(({ inventoryId }) =>
    inventoryId.startsWith("admin-account:"),
  );
  assert.equal(accountRows.length, 10);
  assert.equal(
    new Set(
      accountRows.map(({ canonicalRequirementId }) => canonicalRequirementId),
    ).size,
    10,
  );
});

test("action sources are complete paths or hash-pinned preserved evidence", () => {
  const sources = evidence.actions.flatMap(({ source }) => source);
  assert.equal(
    sources.some(({ path }) => path.endsWith("(user")),
    false,
  );
  for (const source of sources) {
    if (source.availability.startsWith("accepted-main")) {
      assert.equal(existsSync(resolve(root, source.path)), true, source.path);
    } else {
      assert.match(source.sha256, /^[a-f0-9]{64}$/);
    }
  }
});

test("immutable action registry matches every normalized action", () => {
  assert.equal(actionRegistry.rows.length, 153);
  assert.equal(
    new Set(actionRegistry.rows.map(({ requirementId }) => requirementId)).size,
    153,
  );
  for (const action of evidence.actions) {
    const registered = actionRegistry.rows.find(
      ({ sourceKey }) => sourceKey === action.sourceKey,
    );
    assert.equal(registered?.requirementId, action.id);
    assert.deepEqual(registered?.aliases, action.aliases);
  }
});

test("five candidate-only settings remain explicitly unaccepted", () => {
  const candidate = ledger.sourceRows.filter(
    (row) =>
      row.inventory === "settings" &&
      row.mappings.source.status === "candidate-unaccepted",
  );
  assert.deepEqual(candidate.map(({ inventoryId }) => inventoryId).sort(), [
    "roadmap:care",
    "roadmap:enrichment",
    "roadmap:preservation",
    "roadmap:takeout",
    "system:oauth.frameleafMobileRedirectUri",
  ]);
});

test("rejects a missing source row", () => {
  const result = mutated((value) => value.sourceRows.pop());
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /missing\/extra|stale ledger counts|expected/);
});

test("rejects duplicate IDs and duplicate JSON keys", () => {
  const duplicateId = mutated((value) => {
    value.requirements[1].requirementId = value.requirements[0].requirementId;
  });
  assert.notEqual(duplicateId.status, 0);
  const raw = readFileSync(ledgerPath, "utf8").replace(
    "{",
    '{"schemaVersion":1,',
  );
  const duplicateKey = validate(null, raw);
  assert.notEqual(duplicateKey.status, 0);
  assert.match(duplicateKey.stderr, /duplicate JSON key/);
});

test("rejects unknown fields, statuses, and owners", () => {
  assert.notEqual(
    mutated((value) => {
      value.requirements[0].surprise = true;
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.sourceRows[0].mappings.tests.status = "qualified-by-presence";
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.requirements[0].owners.primary.planId = "UNKNOWN-1";
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.requirements[0].owners.primary = {
        planId: "FN-E01",
        jiraKey: "FL-1",
        url: "https://heroit.atlassian.net/browse/FL-1",
      };
    }).status,
    0,
  );
});

test("rejects baseline, invariant, and secret contract drift", () => {
  assert.notEqual(
    mutated((value) => {
      value.baseline.commit = "0".repeat(40);
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.securityInvariants = [];
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.secretPolicies[0].status = "release-qualified";
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.secretPolicies[0].releaseQualified = true;
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.expectedInventory.settings--;
    }).status,
    0,
  );
});

test("rejects stale hashes and counts", () => {
  assert.notEqual(
    mutated((value) => {
      value.sourceSnapshots.acceptedRoutes.sha256 = "0".repeat(64);
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.counts.settings--;
    }).status,
    0,
  );
});

test("rejects orphan entrypoints and reverse mappings", () => {
  assert.notEqual(
    mutated((value) => {
      value.entrypointIndex[value.requirements[0].entrypoints[0]] = [];
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.reverseIndex[value.sourceRows[0].sourceRowId] = "missing";
    }).status,
    0,
  );
});

test("rejects empty mappings and qualification inflation", () => {
  assert.notEqual(
    mutated((value) => {
      value.sourceRows[0].mappings.tests.evidence = [];
    }).status,
    0,
  );
  assert.notEqual(
    mutated((value) => {
      value.requirements[0].qualification = "implemented";
    }).status,
    0,
  );
});
