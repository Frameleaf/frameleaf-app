import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyLocked,
  visibleAssets,
  lockedAccessSnapshot,
  validSamplePin,
} from "../src/locked-content.mjs";
import { createResourceState } from "../src/account-library-data.mjs";
import {
  applyLockedRules,
  LOCKED_PEOPLE,
  lockedTagId,
  resolveLockedRules,
} from "../src/locked-rules.mjs";

const fixtures = [
  { id: "ordinary", ownerId: "taylor", visibility: "timeline" },
  { id: "manual", ownerId: "taylor", visibility: "locked" },
  { id: "rule", ownerId: "taylor", suppressed: true },
  { id: "marked", ownerId: "taylor", isNsfw: true },
  { id: "both", ownerId: "taylor", locked: true, suppressed: true },
  { id: "foreign", ownerId: "jamie", visibility: "locked" },
];
const ids = (rows) => rows.map((row) => row.id);

test("Locked combines manual visibility and resolved rule matches without changing input", () => {
  const before = structuredClone(fixtures);
  assert.deepEqual(fixtures.map(classifyLocked), [
    false,
    true,
    true,
    true,
    true,
    true,
  ]);
  assert.equal(classifyLocked({ privacy: { isNsfw: true } }), true);
  assert.equal(classifyLocked(null), false);
  assert.deepEqual(fixtures, before);
});
test("ordinary views reveal marks and rules after unlock while preserving legacy locked visibility", () => {
  assert.deepEqual(ids(visibleAssets(fixtures)), ["ordinary"]);
  assert.deepEqual(ids(visibleAssets(fixtures, { unlocked: true })), [
    "ordinary",
    "rule",
    "marked",
    "both",
  ]);
  assert.deepEqual(ids(visibleAssets(fixtures, { unlocked: "true" })), [
    "ordinary",
  ]);
});
test("Sensitive and Locked compatibility marks retain album membership and ordinary visibility", () => {
  for (const flag of ["isSensitive", "isNsfw", "isLocked", "locked"]) {
    const original = {
      id: "album-photo",
      ownerId: "taylor",
      visibility: "timeline",
      albumIds: ["holiday", "family"],
      [flag]: true,
    };
    assert.deepEqual(visibleAssets([original]), []);
    assert.deepEqual(visibleAssets([original], { unlocked: true }), [original]);
    assert.deepEqual(
      visibleAssets([original], { unlocked: true, scope: "locked" }),
      [original],
    );
    assert.equal(original.visibility, "timeline");
    assert.deepEqual(original.albumIds, ["holiday", "family"]);
  }
});
test("Locked requires explicit session elevation and never includes another account's originals", () => {
  assert.deepEqual(visibleAssets(fixtures, { scope: "locked" }), []);
  assert.deepEqual(
    ids(visibleAssets(fixtures, { scope: "locked", unlocked: true })),
    ["manual", "rule", "marked", "both"],
  );
  assert.deepEqual(
    ids(
      visibleAssets(fixtures, {
        scope: "locked",
        unlocked: true,
        actorId: "jamie",
      }),
    ),
    ["foreign"],
  );
  assert.deepEqual(
    visibleAssets(fixtures, { scope: "all", unlocked: true }),
    [],
  );
});
test("unknown owners, revoked content, removed items, and malformed privacy metadata fail closed", () => {
  const cases = [
    null,
    { id: "no-owner" },
    ...[
      { accessRevoked: true },
      { deletedAt: "2026-09-19" },
      { isTrashed: true },
      { status: "Deleted" },
      { visibility: "hidden" },
      { suppressed: "false" },
      { privacy: null },
      { privacy: { isNsfw: "false" } },
    ].map((extra) => ({ id: "bad", ownerId: "taylor", ...extra })),
  ];
  assert.deepEqual(visibleAssets(cases, { unlocked: true }), []);
  assert.deepEqual(visibleAssets(undefined), []);
});
test("account snapshot invalidates when own PIN/session changes but not another account's preferences", () => {
  const resources = createResourceState();
  const first = lockedAccessSnapshot(resources);
  assert.equal(first.available, true);
  assert.equal(first.pinEnabled, true);
  resources.users[1].preferences.people.enabled = false;
  assert.deepEqual(lockedAccessSnapshot(resources), first);
  resources.users[0].pinResetAt = "2026-09-19T20:00:00Z";
  assert.notEqual(lockedAccessSnapshot(resources).token, first.token);
  resources.sessions[0].revokedAt = "2026-09-19T20:01:00Z";
  assert.equal(lockedAccessSnapshot(resources).available, false);
  assert.equal(lockedAccessSnapshot({}).available, false);
});
test("sample PIN challenge accepts exactly six digits without coercing or retaining a secret", () => {
  assert.equal(validSamplePin("123456"), true);
  for (const input of [
    123456,
    "12345",
    "1234567",
    "12x456",
    "１２３４５６",
    " 123456",
    null,
  ])
    assert.equal(validSamplePin(input), false);
});
test("canonical rules hide matching own sample people/tags and removal clears only computed matches", () => {
  const prefs = createResourceState().users[0].preferences;
  prefs.privacy.suppression.personIds = [LOCKED_PEOPLE[0].id];
  prefs.privacy.suppression.tagIds = [lockedTagId("medical")];
  const source = [
    { id: "p", ownerId: "taylor", people: ["Emma"] },
    { id: "t", ownerId: "taylor", tags: ["medical"] },
    { id: "f", ownerId: "jamie", people: ["Emma"] },
    { id: "m", ownerId: "taylor", isSuppressed: true },
  ];
  const flagged = applyLockedRules(source, prefs);
  assert.deepEqual(flagged.map(classifyLocked), [true, true, false, true]);
  assert.equal(source[0].lockedByRule, undefined);
  prefs.privacy.suppression = { personIds: [], tagIds: [], scope: "owned" };
  assert.deepEqual(applyLockedRules(flagged, prefs).map(classifyLocked), [
    false,
    false,
    false,
    true,
  ]);
});
test("legacy name-based rules migrate into canonical IDs once, preserving established private rules", () => {
  const prefs = createResourceState().users[0].preferences;
  const legacy = JSON.stringify({
    people: ["emma"],
    tags: ["medical"],
    scope: "visible",
  });
  assert.deepEqual(resolveLockedRules(prefs, legacy), {
    personIds: [LOCKED_PEOPLE[0].id],
    tagIds: [lockedTagId("medical")],
    scope: "visible",
  });
  assert.deepEqual(
    resolveLockedRules(
      prefs,
      JSON.stringify({ version: 2, tags: ["medical"] }),
    ),
    prefs.privacy.suppression,
  );
  prefs.privacy.suppression.tagIds = ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"];
  assert.deepEqual(
    resolveLockedRules(prefs, legacy),
    prefs.privacy.suppression,
  );
});
