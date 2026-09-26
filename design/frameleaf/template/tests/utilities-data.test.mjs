import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialUtilities,
  parseUtilities,
  applyUtilityRecovery,
  applyUtilityAction,
} from "../src/utilities-data.mjs";
const request = (state, id, mode = "replace", extra = {}) => ({
  mode,
  rows: [{ ...state.rows.find((row) => row.id === id) }],
  rootIds: ["backup"],
  candidateIds: { [id]: `${id}:backup` },
  confirmed: true,
  actorId: "taylor",
  admin: true,
  ...extra,
});
test("verified damaged-source recovery preserves owner, provenance and original path through reload", () => {
  const state = initialUtilities();
  const snapshot = structuredClone(state);
  const next = applyUtilityRecovery(state, request(state, "corrupt-video"));
  const row = next.rows.find((row) => row.id === "corrupt-video");
  assert.equal(row.status, "Resolved");
  assert.equal(row.ownerId, "taylor");
  assert.equal(
    row.path,
    snapshot.rows.find((item) => item.id === "corrupt-video").path,
  );
  assert.equal(row.recovery.originalPath, "/mnt/photos/campfire.mov");
  assert.equal(row.recovery.previousSourceRetained, true);
  assert.deepEqual(
    parseUtilities(JSON.stringify(next)).rows.find(
      (item) => item.id === "corrupt-video",
    ).recovery,
    row.recovery,
  );
  assert.deepEqual(state, snapshot);
});
test("recovery rejects wrong checksum, unselected roots, unsupported RAW, and absent consent", () => {
  const state = initialUtilities();
  assert.throws(
    () =>
      applyUtilityRecovery(
        state,
        request(state, "corrupt-video", "replace", { confirmed: false }),
      ),
    /Confirm/,
  );
  assert.throws(
    () =>
      applyUtilityRecovery(
        state,
        request(state, "corrupt-video", "replace", {
          rootIds: ["recovered"],
          candidateIds: { "corrupt-video": "corrupt-video:preview" },
        }),
      ),
    /exact checksum/,
  );
  assert.throws(
    () => applyUtilityRecovery(state, request(state, "corrupt-raw")),
    /confirmed damage/,
  );
  assert.throws(
    () =>
      applyUtilityRecovery(
        state,
        request(state, "corrupt-video", "replace", { rootIds: ["unknown"] }),
      ),
    /configured search root/,
  );
});
test("candidate selection is root-bounded, ownership checked and stale findings refused", () => {
  const state = initialUtilities();
  assert.throws(
    () =>
      applyUtilityRecovery(
        state,
        request(state, "missing-cabin", "locate", { admin: false }),
      ),
    /access/,
  );
  const stale = request(state, "missing-raw", "locate");
  state.rows.find((row) => row.id === "missing-raw").status = "Dismissed";
  assert.throws(() => applyUtilityRecovery(state, stale), /finding changed/);
  const unknown = request(state, "missing-cabin", "locate", {
    candidateIds: { "missing-cabin": "outside" },
  });
  assert.throws(() => applyUtilityRecovery(state, unknown), /candidate within/);
});
test("nonmatching candidates remain review-only and matching selections enable exact relinking", () => {
  const state = initialUtilities();
  const different = applyUtilityRecovery(
    state,
    request(state, "missing-cabin", "locate", {
      rootIds: ["recovered"],
      candidateIds: { "missing-cabin": "missing-cabin:recovered" },
    }),
  );
  assert.throws(
    () =>
      applyUtilityAction(different, {
        action: "relink",
        ids: ["missing-cabin"],
        admin: true,
      }),
    /exact original/,
  );
  const exact = applyUtilityRecovery(
    state,
    request(state, "missing-cabin", "locate"),
  );
  const result = applyUtilityAction(exact, {
    action: "relink",
    ids: ["missing-cabin"],
    admin: true,
  });
  assert.equal(
    result.rows.find((row) => row.id === "missing-cabin").status,
    "Relinked",
  );
  assert.equal(
    parseUtilities(JSON.stringify(result)).rows.find(
      (row) => row.id === "missing-cabin",
    ).candidate,
    "/mnt/backup/photos/Cabin at dusk.jpg",
  );
});

import {
  coordinateBounds,
  pickCoordinates,
  offsetCoordinates,
} from "../src/utilities-data.mjs";
test("coordinate picking follows WGS84 axes and stays inside the displayed region", () => {
  const bounds = coordinateBounds();
  assert.deepEqual(pickCoordinates(bounds, 0, 0), {
    latitude: Number(bounds.north.toFixed(6)),
    longitude: Number(bounds.west.toFixed(6)),
  });
  assert.deepEqual(pickCoordinates(bounds, 1, 1), {
    latitude: Number(bounds.south.toFixed(6)),
    longitude: Number(bounds.east.toFixed(6)),
  });
  assert.deepEqual(pickCoordinates(bounds, -1, 2), {
    latitude: Number(bounds.south.toFixed(6)),
    longitude: Number(bounds.west.toFixed(6)),
  });
  const middle = pickCoordinates(bounds, 0.5, 0.5);
  assert.equal(middle.latitude, 51.36);
  assert.equal(middle.longitude, -116.18);
  assert.throws(() => pickCoordinates(bounds, NaN, 0), /Choose/);
});
test("keyboard and button offsets clamp at geographic limits and zoom maintains a nonempty view", () => {
  assert.deepEqual(offsetCoordinates(90, 180, "north"), {
    latitude: 90,
    longitude: 180,
  });
  assert.deepEqual(offsetCoordinates(-90, -180, "west"), {
    latitude: -90,
    longitude: -180,
  });
  assert.deepEqual(offsetCoordinates(51, -116, "east", 0.01), {
    latitude: 51,
    longitude: -115.99,
  });
  for (const latitude of [-90, 0, 90])
    for (const longitude of [-180, 0, 180]) {
      const bounds = coordinateBounds(latitude, longitude, 8);
      assert.ok(bounds.north > bounds.south);
      assert.ok(bounds.east > bounds.west);
      assert.ok(
        bounds.north <= 90 &&
          bounds.south >= -90 &&
          bounds.east <= 180 &&
          bounds.west >= -180,
      );
    }
  assert.throws(() => offsetCoordinates(NaN, 0, "north"), /valid/);
});

test("Elk.jpg restores from backup once its backup check resolves", async () => {
  const { applyUtilityAction, resolveBackupChecks } = await import("../src/utilities-data.mjs");
  const state = initialUtilities();
  const restore = (current) =>
    applyUtilityAction(current, { action: "restore", ids: ["corrupt-suspect"], actorId: "taylor", admin: true });
  assert.equal(state.rows.find((row) => row.id === "corrupt-suspect").backup.status, "checking");
  assert.throws(() => restore(state), /kept backup/);
  const checked = resolveBackupChecks(state);
  assert.equal(resolveBackupChecks(checked), checked);
  assert.equal(checked.rows.find((row) => row.id === "corrupt-suspect").backup.status, "in-backup");
  const restored = restore(checked);
  assert.equal(restored.rows.find((row) => row.id === "corrupt-suspect").status, "Restored");
  assert.throws(
    () => applyUtilityAction(checked, { action: "restore", ids: ["missing-cabin"], actorId: "taylor", admin: true }),
    /fingerprint/,
  );
  assert.throws(
    () => applyUtilityAction(checked, { action: "restore", ids: ["missing-kayak"], actorId: "taylor", admin: true }),
    /kept backup/,
  );
});
