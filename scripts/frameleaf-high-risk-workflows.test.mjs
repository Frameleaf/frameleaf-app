import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(import.meta.dirname, "..");
const receiptPath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/high-risk-workflow-design-evidence.json",
);
const ledgerPath = resolve(
  root,
  "docs/docs/developer/frameleaf-plan/action-preservation-ledger.json",
);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function imageDimensions(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"))) {
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }
  assert.equal(bytes.readUInt16BE(0), 0xffd8, "expected PNG or JPEG evidence");
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
        0xcf,
      ].includes(marker)
    ) {
      return {
        height: bytes.readUInt16BE(offset + 5),
        width: bytes.readUInt16BE(offset + 7),
      };
    }
    const length = bytes.readUInt16BE(offset + 2);
    assert.ok(length >= 2, "invalid JPEG evidence segment");
    offset += length + 2;
  }
  assert.fail("evidence image dimensions not found");
}

test("FL-27 evidence covers five flows and seven adverse-state classes without qualification inflation", async () => {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.issue, "FL-27");
  assert.equal(receipt.planId, "FN-103");
  assert.deepEqual(receipt.baseline, {
    repository: "Frameleaf/frameleaf-app",
    defaultBranch: "fork/main",
    commit: "da508755cc59c178dcd8354f0f4a3a794f896d39",
  });
  assert.equal(receipt.status, "interaction-designed-production-not-qualified");
  assert.equal(receipt.flows.length, 5);
  assert.equal(receipt.prototype.caseCount, 35);
  assert.equal(
    receipt.prototype.domTest,
    "design/frameleaf/template/tests/high-risk-workflows.dom.test.mjs",
  );
  assert.match(
    receipt.prototype.actionContract,
    /bounded structural review regions/,
  );
  assert.match(receipt.prototype.keyboardContract, /focuses its heading/);
  assert.equal(receipt.browserVerification.inviteSurface, "invite-review");
  assert.equal(receipt.browserVerification.inviteRows, 3);
  assert.equal(receipt.browserVerification.inviteCancelRemovedSurface, true);
  assert.equal(receipt.browserVerification.inviteCancelRestoredFocus, true);
  assert.equal(
    receipt.browserVerification.revisionSurface,
    "revision-comparison",
  );
  assert.deepEqual(receipt.browserVerification.revisionIncludes, [
    "Revision 18",
    "Revision 19",
    "Overwrite blocked",
  ]);
  assert.equal(
    receipt.browserVerification.recoverySurface,
    "recovery-retry-checkpoint",
  );
  assert.equal(receipt.browserVerification.recoveryUnresolvedRows, 2);
  assert.equal(
    receipt.browserVerification.recoveredItemExcludedFromCheckpoint,
    "Lake morning.mov",
  );
  assert.equal(receipt.browserVerification.recoveryClosedMarker, true);
  assert.equal(
    receipt.browserVerification.keyboardInitialActiveElement,
    "BUTTON Apply with Enter",
  );
  assert.equal(receipt.browserVerification.keyboardInitialFocusVisible, true);
  assert.equal(receipt.browserVerification.keyboardEnterActiveElement, "H2");
  assert.equal(receipt.browserVerification.keyboardEnterFocusVisible, true);
  assert.equal(receipt.browserVerification.keyboardEscapeRemovedSurface, true);
  assert.equal(receipt.browserVerification.keyboardEscapeRestoredFocus, true);
  assert.equal(receipt.sourceAnchorReconciliation.length, 3);
  assert.ok(
    receipt.sourceAnchorReconciliation.every(
      ({ availability }) => availability === "absent-on-fresh-baseline",
    ),
  );
  assert.deepEqual(receipt.prototype.statesPerFlow, [
    "normal",
    "empty",
    "forbidden",
    "stale",
    "retry",
    "keyboard",
    "narrow",
  ]);
  assert.ok(
    Object.values(receipt.qualification).every((value) => value === false),
  );
});

test("every accepted browser capture has the recorded current-run hash", async () => {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.screenshots.length, 11);
  for (const screenshot of receipt.screenshots) {
    const bytes = await readFile(
      resolve(
        root,
        "docs/docs/developer/evidence/fl27-design-audit",
        screenshot.file,
      ),
    );
    assert.equal(sha256(bytes), screenshot.sha256, screenshot.file);
    assert.deepEqual(
      imageDimensions(bytes),
      { width: screenshot.width, height: screenshot.height },
      screenshot.file,
    );
    assert.ok(screenshot.width >= 680, screenshot.file);
    assert.ok(screenshot.height >= 720, screenshot.file);
  }
});

test("every mapped action row retains production qualification and cites the FL-27 design receipt", async () => {
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  const byId = new Map(
    ledger.requirements.map((row) => [row.requirementId, row]),
  );
  for (const flow of receipt.flows) {
    for (const id of flow.requirementIds) {
      const row = byId.get(id);
      assert.ok(row, id);
      assert.equal(row.qualification, "planned-not-qualified", id);
      assert.ok(
        row.mappings.newUi.evidence.includes(
          "docs/docs/developer/frameleaf-plan/high-risk-workflow-design-evidence.json",
        ),
        id,
      );
      assert.ok(
        row.mappings.tests.evidence.includes(
          "scripts/frameleaf-high-risk-workflows.test.mjs",
        ),
        id,
      );
    }
  }
});
