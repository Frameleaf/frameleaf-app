import assert from "node:assert/strict";
import { test } from "node:test";
import {
  initialUtilities,
  applyUtilityAction,
} from "../src/utilities-data.mjs";
import {
  deriveTrashRows,
  trashAge,
  trashMediaType,
  reviewTrashAction,
  applyTrashAction,
} from "../src/trash-data.mjs";
const at = "2026-09-19T12:00:00Z";
function trashState() {
  let state = initialUtilities();
  // This fixture isolates utility-origin trash; dedicated Trash seeds are covered in DOM tests.
  state.rows = state.rows.filter((row) => row.tool !== "trash");
  state = applyUtilityAction(state, {
    action: "trash",
    ids: ["dup-jpg", "large-lake"],
    actorId: "taylor",
  });
  state = applyUtilityAction(state, {
    action: "trash",
    ids: ["dup-hike"],
    actorId: "jamie",
  });
  return state;
}
const review = (state, action, more = {}) =>
  reviewTrashAction(state, {
    action,
    ids: ["dup-jpg"],
    actorId: "taylor",
    ...more,
  });
const apply = (state, request, extra = {}) =>
  applyTrashAction(state, { ...request, confirmed: true, at, ...extra });
test("Locked trash names and counts stay hidden and actions recheck elevation", () => {
  const state = trashState();
  state.rows.find((row) => row.id === "dup-jpg").visibility = "locked";
  assert.deepEqual(
    deriveTrashRows(state.rows).map((row) => row.id),
    ["large-lake"],
  );
  assert.throws(() => review(state, "empty"), /Unlock/);
  assert.throws(() => review(state, "restore"), /Unlock/);
  const request = review(state, "restore", { unlocked: true });
  assert.throws(() => apply(state, request), /Unlock/);
  assert.equal(
    apply(state, request, { unlocked: true }).rows.find(
      (row) => row.id === "dup-jpg",
    ).status,
    "Restored",
  );
});
test("a new Locked rule invalidates an existing trash review before publication", () => {
  const state = trashState();
  const request = review(state, "delete");
  const changed = structuredClone(state);
  changed.rows.find((row) => row.id === "dup-jpg").lockedByRule = true;
  assert.throws(() => apply(changed, request), /Unlock/);
  assert.throws(
    () => apply(changed, request, { unlocked: true }),
    /changed since/,
  );
});

test("all-account trash views reveal only the signed-in owner's assets", () => {
  const state = trashState();
  const rows = deriveTrashRows(state.rows, { owner: "all" });
  assert.deepEqual(
    rows.map((row) => row.id),
    ["dup-jpg", "large-lake"],
  );
  assert.ok(rows.every((row) => row.ownerId === "taylor" && row.editable));
  assert.deepEqual(deriveTrashRows(state.rows, { owner: "jamie" }), []);
  assert.deepEqual(deriveTrashRows(state.rows, { owner: "new-user" }), []);
  assert.deepEqual(deriveTrashRows(state.rows, { actorId: "" }), []);
});

test("query and media filters narrow rows without changing the complete own-trash scope", () => {
  const state = trashState();
  assert.deepEqual(
    deriveTrashRows(state.rows, { query: "moraine", type: "image" }).map(
      (row) => row.id,
    ),
    ["dup-jpg"],
  );
  assert.deepEqual(
    deriveTrashRows(state.rows, { type: "video" }).map((row) => row.id),
    ["large-lake"],
  );
  assert.equal(deriveTrashRows(state.rows, { query: "jamie" }).length, 0);
  assert.equal(deriveTrashRows(state.rows, { type: "unsupported" }).length, 0);
  assert.equal(trashMediaType({ name: "capture.ARW" }), "image");
  assert.equal(trashMediaType({ name: "clip.HEVC", type: "VIDEO" }), "video");
  assert.equal(trashMediaType({ name: "file.unknown" }), "other");
});

test("deleted age is explicitly unavailable without a valid past timestamp", () => {
  for (const deletedAt of [
    undefined,
    null,
    "invalid",
    "123",
    "2099-01-01T00:00:00Z",
  ]) {
    assert.deepEqual(trashAge({ deletedAt }, at), {
      trashedAt: null,
      deletedAgeDays: null,
      deletedAgeLabel: "Date unavailable",
    });
  }
  assert.equal(
    trashAge({ deletedAt: "2026-09-17T12:00:00Z" }, at).deletedAgeDays,
    2,
  );
  assert.equal(
    trashAge({ deletedAt: "2026-09-19T10:00:00Z" }, at).deletedAgeLabel,
    "Today",
  );
  assert.ok(
    deriveTrashRows(trashState().rows).every(
      (row) => row.deletedAgeDays === null,
    ),
  );
});

test("restoring clears deletion metadata and closes utility review without changing ownership", () => {
  const state = trashState();
  state.rows.find((row) => row.id === "dup-jpg").deletedAt =
    "2026-09-18T12:00:00Z";
  const before = structuredClone(state);
  const next = apply(state, review(state, "restore"), { confirmed: false });
  assert.deepEqual(state, before);
  const row = next.rows.find((item) => item.id === "dup-jpg");
  assert.equal(row.status, "Restored");
  assert.equal(row.deletedAt, null);
  assert.equal(row.ownerId, "taylor");
  assert.equal(row.group, "lake");
  assert.equal(deriveTrashRows(next.rows).length, 1);
  assert.equal(
    next.rows.find((item) => item.id === "dup-hike").status,
    "Trashed",
  );
});

test("permanent selection deletion needs confirmation and cannot be restored", () => {
  const state = trashState(),
    request = review(state, "delete");
  assert.throws(
    () => apply(state, request, { confirmed: false }),
    /Confirm permanent deletion/,
  );
  const next = apply(state, request);
  assert.equal(next.rows.find((row) => row.id === "dup-jpg").status, "Deleted");
  assert.equal(
    next.rows.find((row) => row.id === "large-lake").status,
    "Trashed",
  );
  assert.throws(() => review(next, "restore"), /no longer in trash/);
  assert.equal(next.rows.length, state.rows.length);
});

test("empty trash always captures every own item, never the filtered selection or other owners", () => {
  const state = trashState();
  const visible = deriveTrashRows(state.rows, { type: "image" });
  const request = review(state, "empty", { ids: visible.map((row) => row.id) });
  assert.equal(request.scope, "all-owned");
  assert.equal(request.count, 2);
  const next = apply(state, request);
  assert.equal(deriveTrashRows(next.rows).length, 0);
  assert.equal(
    next.rows.find((row) => row.id === "dup-hike").status,
    "Trashed",
  );
  assert.throws(() => review(next, "empty"), /already empty/);
});

test("foreign ownership, stale status, changed sources and duplicate references are rejected", () => {
  const state = trashState(),
    request = review(state, "delete");
  assert.throws(
    () => review(state, "delete", { ids: ["dup-hike"] }),
    /original owner/,
  );
  for (const mutation of [
    (next) => {
      next.rows.find((row) => row.id === "dup-jpg").status = "Restored";
    },
    (next) => {
      next.rows.find((row) => row.id === "dup-jpg").ownerId = "jamie";
    },
    (next) => {
      next.rows.find((row) => row.id === "dup-jpg").checksum = "changed";
    },
    (next) => {
      next.rows.find((row) => row.id === "dup-jpg").deletedAt = at;
    },
    (next) => {
      next.rows.push({ ...next.rows.find((row) => row.id === "dup-jpg") });
    },
  ]) {
    const changed = structuredClone(state);
    mutation(changed);
    assert.throws(() => apply(changed, request), /changed|owner|review/);
  }
  assert.throws(
    () => apply(state, { ...request, expectedRows: undefined }),
    /review/,
  );
});

test("empty-trash review rejects new own trash but unrelated account changes remain untouched", () => {
  const state = trashState(),
    request = review(state, "empty");
  const added = applyUtilityAction(state, {
    action: "trash",
    ids: ["dup-forest-copy"],
    actorId: "taylor",
  });
  assert.throws(() => apply(added, request), /Trash changed/);
  const changed = applyUtilityAction(state, {
    action: "trash",
    ids: ["dup-hike-copy"],
    actorId: "jamie",
  });
  const next = apply(changed, request);
  assert.equal(
    next.rows.find((row) => row.id === "dup-hike-copy").status,
    "Trashed",
  );
  assert.deepEqual(next.history.slice(1), changed.history.slice(0, 29));
});
