import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createBuddyState,
  loadBuddyState,
  previewBuddyScenario,
  buddyStatus,
  validateBuddyAgreement,
  validateBuddyControls,
  OWN_BACKUP_ITEMS,
  SAMPLE_RECOVERY_KIT,
} from "../src/buddy-backup.mjs";

test("Buddy design keeps independent directions, enforces capacity, and gates recovery", () => {
  const state = createBuddyState();
  assert.equal(buddyStatus(state).canRestore, true);
  assert.equal(
    buddyStatus({ ...state, sendingPaused: true }).receiving,
    "Ready to receive",
  );
  assert.equal(buddyStatus({ ...state, receivingPaused: true }).canSend, true);
  for (const scenario of [
    "unpaired",
    "initial",
    "blocked",
    "key",
    "auth",
    "offline",
  ])
    assert.equal(
      buddyStatus(previewBuddyScenario(state, scenario)).canRestore,
      false,
      scenario,
    );
  assert.equal(
    buddyStatus(previewBuddyScenario(state, "ending")).canRestore,
    true,
  );
  assert.equal(
    buddyStatus(previewBuddyScenario(state, "ending")).canSend,
    false,
  );
  assert.match(
    validateBuddyAgreement({ outgoingQuotaGB: 600, incomingQuotaGB: 750 }),
    /684.2/,
  );
  assert.match(
    validateBuddyAgreement({ outgoingQuotaGB: 1000, incomingQuotaGB: 951 }),
    /950/,
  );
  assert.match(
    validateBuddyAgreement({ outgoingQuotaGB: 1000, incomingQuotaGB: 400 }),
    /412.8/,
  );
  assert.equal(
    validateBuddyAgreement({ outgoingQuotaGB: 1000, incomingQuotaGB: 750 }),
    "",
  );
  assert.equal(validateBuddyControls(state.controls), "");
  assert.match(
    validateBuddyControls({ ...state.controls, sendMbps: "NaN" }),
    /Mbit/,
  );
  assert.match(
    validateBuddyControls({ ...state.controls, concurrent: 3 }),
    /one or two/,
  );
  assert.match(
    validateBuddyControls({ ...state.controls, start: "25:00" }),
    /times/,
  );
  assert.match(
    validateBuddyControls({ ...state.controls, monthly: 0 }),
    /Retention/,
  );
  assert.deepEqual(loadBuddyState({ getItem: () => "{" }), state);
  assert.equal(SAMPLE_RECOVERY_KIT.demoOnly, true);
  assert.equal("encryptionKey" in SAMPLE_RECOVERY_KIT, false);
  assert.ok(OWN_BACKUP_ITEMS.every((item) => !Object.hasOwn(item, "buddy")));
});
