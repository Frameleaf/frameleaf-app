import test from "node:test";
import assert from "node:assert/strict";
import {
  createPhysicalDedupState,
  preparePhysicalDedupPlan,
  reviewPhysicalDedupPlan,
  applyPhysicalDedupPlan,
  parsePhysicalDedupState,
  serializePhysicalDedupState,
  physicalDedupPlanError,
  physicalDedupStorageToken,
  DEDUP_SAMPLE_ASSETS,
} from "../src/physical-dedup-data.mjs";
const settings = { physicalDedup: true, advancedDedupMaster: "sample-taylor" };
const at = "2026-09-19T12:00:00.000Z";
const scan = (
  state = createPhysicalDedupState(),
  scope = "all",
  planId = "PD-ONE",
) => preparePhysicalDedupPlan(state, { settings, scope, planId, at });
const review = (state, more = {}) =>
  reviewPhysicalDedupPlan(state, {
    settings,
    scope: "all",
    planId: state.plan.id,
    at,
    ...more,
  });
const apply = (state, more = {}) =>
  applyPhysicalDedupPlan(state, {
    settings,
    scope: "all",
    planId: state.plan.id,
    confirmation: `APPLY ${state.plan.id}`,
    at,
    ...more,
  });

test("a preview uses exact bytes/checksum evidence and protects missing/external files", () => {
  const before = createPhysicalDedupState();
  const state = scan(before);
  assert.deepEqual(before, createPhysicalDedupState());
  assert.deepEqual(state.links, {});
  const eligible = state.plan.rows.filter((row) => row.status === "eligible");
  assert.ok(eligible.length > 0);
  for (const row of eligible) {
    const source = DEDUP_SAMPLE_ASSETS.find(
      (asset) => asset.id === row.assetId,
    );
    const retained = DEDUP_SAMPLE_ASSETS.find(
      (asset) => asset.id === row.retainedId,
    );
    assert.equal(source.checksum, retained.checksum);
    assert.equal(source.bytes, retained.bytes);
    assert.equal(retained.exists, true);
    assert.equal(source.external, false);
    assert.equal(retained.ownerId, "taylor");
  }
  for (const id of ["library-e", "trip-j", "garden-edited"])
    assert.equal(
      state.plan.rows.find((row) => row.assetId === id).status,
      "skipped",
    );
  assert.equal(
    state.plan.estimatedBytes,
    eligible.reduce((sum, row) => sum + row.bytes, 0),
  );
  const lake = eligible.filter((row) => row.retainedId === "lake-t");
  assert.ok(
    lake.every(
      (row) =>
        row.referencesBefore === 1 && row.referencesAfter === lake.length + 1,
    ),
  );
});

test("owner scope includes only that owner's candidates and unknown accounts stay empty", () => {
  const state = scan(undefined, "jamie");
  assert.ok(state.plan.rows.every((row) => row.ownerId === "jamie"));
  assert.equal(scan(undefined, "new-user").plan.rows.length, 0);
  assert.equal(scan(undefined, "taylor").plan.eligibleCount, 0);
  assert.throws(
    () =>
      preparePhysicalDedupPlan(createPhysicalDedupState(), {
        settings: { ...settings, advancedDedupMaster: "unknown" },
        planId: "PD-FAIL",
      }),
    /Choose and save/,
  );
});

test("applying requires review, the exact typed plan ID, enabled policy and unchanged scope/master", () => {
  const state = scan();
  assert.throws(() => apply(state), /Review this plan/);
  const ready = review(state);
  assert.throws(
    () => apply(ready, { confirmation: "APPLY" }),
    /exact confirmation/,
  );
  assert.throws(
    () => apply(ready, { planId: "PD-OTHER", confirmation: "APPLY PD-OTHER" }),
    /replaced/,
  );
  assert.throws(() => apply(ready, { scope: "jamie" }), /scope changed/);
  assert.throws(
    () =>
      apply(ready, {
        settings: { ...settings, advancedDedupMaster: "sample-jamie" },
      }),
    /retained account changed/,
  );
  assert.throws(
    () => apply(ready, { settings: { ...settings, physicalDedup: false } }),
    /Enable/,
  );
  assert.equal(ready.plan.status, "reviewed");
  assert.deepEqual(ready.links, {});
});

test("apply preserves logical owners and retained copies, is single use, and rescans skip shared files", () => {
  const sourceSnapshot = structuredClone(DEDUP_SAMPLE_ASSETS);
  const ready = review(scan());
  const state = apply(ready);
  assert.deepEqual(DEDUP_SAMPLE_ASSETS, sourceSnapshot);
  assert.deepEqual(ready.links, {});
  assert.equal(state.plan.status, "applied");
  for (const [sourceId, retainedId] of Object.entries(state.links)) {
    assert.notEqual(sourceId, retainedId);
    assert.equal(state.links[retainedId], undefined);
    assert.ok(DEDUP_SAMPLE_ASSETS.some((asset) => asset.id === sourceId));
  }
  assert.throws(() => apply(state), /already been applied/);
  const next = scan(state, "all", "PD-TWO");
  assert.equal(next.plan.eligibleCount, 0);
  assert.equal(next.plan.estimatedBytes, 0);
});

test("changed reference evidence or a new preview invalidates the old reviewed plan", () => {
  const ready = review(scan());
  const changed = { ...ready, links: { "lake-j": "lake-t" } };
  assert.match(
    physicalDedupPlanError(changed, settings, "all"),
    /evidence changed/,
  );
  assert.throws(() => apply(changed), /evidence changed/);
  const latest = scan(ready, "all", "PD-TWO");
  assert.throws(() => apply(latest, { planId: ready.plan.id }), /replaced/);
  assert.notEqual(
    physicalDedupStorageToken(latest),
    physicalDedupStorageToken(ready),
  );
});

test("persisted completed, reviewed and applied states replay with server paths never trusted", () => {
  const completed = scan(),
    reviewed = review(completed),
    applied = apply(reviewed);
  for (const state of [completed, reviewed, applied]) {
    assert.deepEqual(
      parsePhysicalDedupState(serializePhysicalDedupState(state)),
      state,
    );
  }
  const persisted = JSON.parse(serializePhysicalDedupState(applied));
  persisted.plan = {
    estimatedBytes: Number.MAX_VALUE,
    rows: [{ path: "/sensitive/file" }],
  };
  persisted.links = { secret: "/somewhere" };
  assert.deepEqual(parsePhysicalDedupState(JSON.stringify(persisted)), applied);
});

test("malformed and oversized history cannot restore links or imply a reviewed plan", () => {
  for (const raw of [
    null,
    "null",
    "{}",
    "[]",
    "{",
    JSON.stringify({ version: 2, events: [] }),
    JSON.stringify({ version: 1, events: [null] }),
    "x".repeat(250_001),
  ]) {
    assert.deepEqual(parsePhysicalDedupState(raw), createPhysicalDedupState());
  }
  const raw = JSON.parse(serializePhysicalDedupState(scan()));
  raw.events.push({
    ...raw.events[0],
    type: "apply",
    confirmation: "APPLY PD-ONE",
  });
  assert.deepEqual(
    parsePhysicalDedupState(JSON.stringify(raw)),
    createPhysicalDedupState(),
  );
});
