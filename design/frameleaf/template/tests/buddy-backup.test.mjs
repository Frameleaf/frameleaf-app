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
  unlockBuddyKey,
  verifyBuddyRecovery,
  attachBuddyRecovery,
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

test("key checks and restore verification preserve stopped partnerships", () => {
  const ending = previewBuddyScenario(createBuddyState(), "ending");
  const verified = verifyBuddyRecovery(ending, "2 Oct, 13:42");
  assert.deepEqual(verified, { ...ending, lastVerified: "2 Oct, 13:42" });
  assert.equal(buddyStatus(verified).canSend, false);
  assert.equal(buddyStatus(verified).receiving, "Read window only");
  assert.equal(unlockBuddyKey(ending), ending);

  for (const scenario of ["blocked", "auth", "offline"]) {
    const restricted = previewBuddyScenario(createBuddyState(), scenario);
    assert.equal(unlockBuddyKey(restricted), restricted);
    assert.equal(verifyBuddyRecovery(restricted, "2 Oct, 13:42"), restricted);
    assert.equal(buddyStatus(restricted).canRestore, false);
  }
  const keyWaiting = {
    ...createBuddyState(),
    scenario: "key",
    sendingPaused: true,
  };
  const unlocked = unlockBuddyKey(keyWaiting);
  assert.equal(unlocked.scenario, "current");
  assert.equal(unlocked.sendingPaused, true);
  assert.equal(buddyStatus(unlocked).canSend, false);
});

test("a fresh replacement server can attach its own backup without pairing", () => {
  const fresh = previewBuddyScenario(createBuddyState(), "unpaired");
  const authorization = {
    cloudAuthorized: true,
    verificationCode: SAMPLE_RECOVERY_KIT.verificationCode,
  };
  assert.equal(buddyStatus(fresh).canRestore, false);
  assert.equal(buddyStatus(fresh).canAttachRecovery, true);
  assert.equal(
    attachBuddyRecovery(fresh, { ...authorization, cloudAuthorized: false }),
    fresh,
  );
  assert.equal(
    attachBuddyRecovery(fresh, { ...authorization, verificationCode: "wrong" }),
    fresh,
  );

  const attached = attachBuddyRecovery(fresh, authorization);
  assert.equal(attached.paired, false);
  assert.equal(attached.hasRecoveryPoint, true);
  assert.equal(buddyStatus(attached).canRestore, true);
  assert.equal(buddyStatus(attached).canSend, false);
  assert.equal(buddyStatus(attached).receiving, "Not hosting");
  assert.equal(buddyStatus(attached).label, "Recovery only");
  assert.equal(
    buddyStatus(loadBuddyState({ getItem: () => JSON.stringify(attached) }))
      .canRestore,
    true,
  );

  for (const scenario of ["blocked", "auth", "offline"]) {
    const restricted = previewBuddyScenario(fresh, scenario);
    assert.equal(buddyStatus(restricted).canAttachRecovery, false);
    assert.equal(attachBuddyRecovery(restricted, authorization), restricted);
  }
  const ending = attachBuddyRecovery(
    previewBuddyScenario(fresh, "ending"),
    authorization,
  );
  assert.equal(ending.scenario, "ending");
  assert.equal(buddyStatus(ending).canSend, false);
  assert.equal(buddyStatus(ending).receiving, "Read window only");
});

test("subscription expiry stops transfers but preserves authorized replacement recovery", () => {
  const expired = previewBuddyScenario(createBuddyState(), "subscription");
  assert.equal(
    loadBuddyState({ getItem: () => JSON.stringify(expired) }).scenario,
    "subscription",
  );
  assert.equal(buddyStatus(expired).canRestore, true);
  assert.equal(buddyStatus(expired).canSend, false);
  assert.equal(buddyStatus(expired).canReceive, false);
  assert.equal(unlockBuddyKey(expired), expired);

  const replacement = { ...expired, paired: false, hasRecoveryPoint: false };
  const attached = attachBuddyRecovery(replacement, {
    cloudAuthorized: true,
    verificationCode: SAMPLE_RECOVERY_KIT.verificationCode,
  });
  assert.equal(attached.scenario, "subscription");
  assert.equal(attached.paired, false);
  assert.equal(buddyStatus(attached).canRestore, true);
  assert.equal(buddyStatus(attached).canSend, false);
  assert.equal(buddyStatus(attached).canReceive, false);
  const verified = verifyBuddyRecovery(attached, "2 Oct, 13:42");
  assert.equal(verified.scenario, "subscription");
  assert.equal(buddyStatus(verified).canSend, false);
  assert.equal(buddyStatus(verified).canReceive, false);
});
