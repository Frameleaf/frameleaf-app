import test from "node:test";
import assert from "node:assert/strict";
import { media } from "../src/media.js";
import {
  libraryAssetsKey,
  parseLibraryAssets,
  readLibraryAssets,
  mergeLibraryAssets,
  changeLibraryAsset,
  trashLibraryAsset,
} from "../src/library-assets.mjs";
import { parseUtilities, utilityStorageKey } from "../src/utilities-data.mjs";
import {
  applyTrashAction,
  reviewTrashAction,
  deriveTrashRows,
} from "../src/trash-data.mjs";
import { visibleAssets } from "../src/locked-content.mjs";
function storage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    values,
  };
}
const reload = (store) =>
  mergeLibraryAssets(
    readLibraryAssets(store),
    parseUtilities(store.getItem(utilityStorageKey)),
  );
const byId = (store, id) => reload(store).find((asset) => asset.id === id);
function trashAction(store, id, action, unlocked = false) {
  const state = parseUtilities(store.getItem(utilityStorageKey));
  const review = reviewTrashAction(state, {
    action,
    ids: [`library-${id}`],
    actorId: "taylor",
    unlocked,
  });
  const next = applyTrashAction(state, {
    ...review,
    unlocked,
    confirmed: action !== "restore",
    at: "2026-09-19T19:00:00Z",
  });
  store.setItem(utilityStorageKey, JSON.stringify(next));
  return next;
}

test("library override parser rejects foreign IDs and ownership fields without mutating source assets", () => {
  const before = structuredClone(media);
  const overrides = parseLibraryAssets({
    version: 1,
    assets: {
      1: {
        favorite: false,
        ownerId: "jamie",
        image: "/private.jpg",
        albumIds: ["family", "unknown", "../escape", "Bad Id", 42],
        sharedWith: ["Jamie", "Taylor", "intruder"],
      },
      unknown: { visibility: "locked" },
    },
  });
  assert.deepEqual(Object.keys(overrides), ["1"]);
  assert.deepEqual(overrides["1"], {
    favorite: false,
    albumIds: ["family", "unknown"],
    sharedWith: ["Jamie"],
  });
  assert.deepEqual(media, before);
  for (const raw of [
    null,
    "{",
    {},
    { version: 2, assets: {} },
    { version: 1, assets: null },
  ])
    assert.deepEqual(parseLibraryAssets(raw), {});
});
test("favorites, archive and collection edits survive reload and preserve prior edits on other assets", () => {
  const store = storage();
  changeLibraryAsset(
    "1",
    { favorite: false, visibility: "archive" },
    "taylor",
    store,
  );
  changeLibraryAsset(
    "2",
    { favorite: true, albumIds: ["family", "winter-2026"] },
    "taylor",
    store,
  );
  changeLibraryAsset("1", { sharedWith: ["Jamie"] }, "taylor", store);
  assert.equal(byId(store, "1").favorite, false);
  assert.equal(byId(store, "1").visibility, "archive");
  assert.deepEqual(byId(store, "1").sharedWith, ["Jamie"]);
  assert.equal(byId(store, "2").favorite, true);
  assert.deepEqual(byId(store, "2").albumIds, ["family", "winter-2026"]);
  assert.equal(byId(store, "1").ownerId, "taylor");
  assert.ok(visibleAssets(reload(store)).some((a) => a.id === "1")); // Archive is a library view filter, not locked authorization.
});
test("unknown and foreign-owner mutations leave both persisted namespaces unchanged", () => {
  const store = storage();
  for (const [id, actor] of [
    ["unknown", "taylor"],
    ["1", "jamie"],
    ["1", ""],
  ]) {
    assert.throws(
      () => changeLibraryAsset(id, { favorite: true }, actor, store),
      /available/,
    );
    assert.throws(() => trashLibraryAsset(id, actor, store), /available/);
  }
  assert.equal(store.values.size, 0);
});
test("a storage failure throws instead of reporting an optimistic saved mutation", () => {
  const store = storage();
  changeLibraryAsset("1", { favorite: false }, "taylor", store);
  const before = store.getItem(libraryAssetsKey);
  store.setItem = () => {
    throw Error("Storage full");
  };
  assert.throws(
    () => changeLibraryAsset("1", { favorite: true }, "taylor", store),
    /Storage full/,
  );
  assert.equal(store.getItem(libraryAssetsKey), before);
  assert.throws(() => trashLibraryAsset("1", "taylor", store), /Storage full/);
  assert.equal(store.getItem(utilityStorageKey), null);
});
test("legacy locked visibility remains readable while marks return to their original ordinary views", () => {
  const store = storage();
  store.setItem(
    libraryAssetsKey,
    JSON.stringify({
      version: 1,
      assets: { 1: { visibility: "locked", isLocked: true } },
    }),
  );
  changeLibraryAsset("2", { isSuppressed: true }, "taylor", store);
  const assets = reload(store);
  assert.ok(!visibleAssets(assets).some((a) => ["1", "2"].includes(a.id)));
  assert.deepEqual(visibleAssets(assets, { scope: "locked" }), []);
  assert.ok(
    !visibleAssets(assets, { unlocked: true }).some((a) => a.id === "1"),
  );
  assert.ok(
    visibleAssets(assets, { unlocked: true }).some((a) => a.id === "2"),
  );
  assert.ok(
    visibleAssets(assets, { unlocked: true, scope: "locked" }).some(
      (a) => a.id === "1",
    ),
  );
  assert.ok(
    visibleAssets(assets, { unlocked: true, scope: "locked" }).some(
      (a) => a.id === "2",
    ),
  );
});
test("trashing a library item disappears from every library scope across reload", () => {
  const store = storage();
  trashLibraryAsset("1", "taylor", store);
  assert.equal(byId(store, "1").status, "Trashed");
  assert.ok(byId(store, "1").deletedAt);
  assert.ok(
    !visibleAssets(reload(store), { unlocked: true }).some((a) => a.id === "1"),
  );
  assert.ok(
    deriveTrashRows(parseUtilities(store.getItem(utilityStorageKey)).rows).some(
      (row) => row.id === "library-1",
    ),
  );
  assert.throws(() => trashLibraryAsset("1", "taylor", store), /available/);
});
test("restore reappears with favorite, archive, collection and ownership choices intact", () => {
  const store = storage();
  changeLibraryAsset(
    "1",
    { favorite: false, visibility: "archive", albumIds: ["everyday"] },
    "taylor",
    store,
  );
  trashLibraryAsset("1", "taylor", store);
  trashAction(store, "1", "restore");
  const restored = byId(store, "1");
  assert.equal(restored.favorite, false);
  assert.equal(restored.visibility, "archive");
  assert.deepEqual(restored.albumIds, ["everyday"]);
  assert.equal(restored.ownerId, "taylor");
  assert.ok(!restored.deletedAt);
  assert.notEqual(restored.status, "Trashed");
  assert.ok(visibleAssets(reload(store)).some((asset) => asset.id === "1"));
  assert.ok(
    !deriveTrashRows(
      parseUtilities(store.getItem(utilityStorageKey)).rows,
    ).some((row) => row.id === "library-1"),
  );
});
test("marked and rule-hidden trash flags survive utility parsing and restoration", () => {
  const store = storage();
  changeLibraryAsset("1", { isLocked: true }, "taylor", store);
  changeLibraryAsset("2", { isSuppressed: true }, "taylor", store);
  trashLibraryAsset("1", "taylor", store);
  trashLibraryAsset("2", "taylor", store);
  const state = parseUtilities(store.getItem(utilityStorageKey));
  assert.equal(state.rows.find((row) => row.id === "library-1").isLocked, true);
  assert.equal(
    state.rows.find((row) => row.id === "library-2").isSuppressed,
    true,
  );
  const lockedSessionTrash = deriveTrashRows(
    state.rows.filter((row) => !row.isLocked && !row.isSuppressed),
  );
  assert.ok(
    !lockedSessionTrash.some((row) =>
      ["library-1", "library-2"].includes(row.id),
    ),
  );
  assert.throws(() => trashAction(store, "1", "restore"), /Unlock/);
  trashAction(store, "1", "restore", true);
  trashAction(store, "2", "restore", true);
  assert.ok(
    !visibleAssets(reload(store)).some((a) => ["1", "2"].includes(a.id)),
  );
  assert.ok(
    visibleAssets(reload(store), { scope: "locked", unlocked: true }).some(
      (a) => a.id === "1",
    ),
  );
});
test("missing or malformed saved privacy flags retain the original protection in trash", () => {
  const original = parseUtilities(null);
  const protectedRows = original.rows.filter(
    (row) => row.tool === "library" && (row.isLocked || row.isSuppressed),
  );
  assert.ok(protectedRows.length > 0);
  for (const invalid of [undefined, null, "false", 0]) {
    const parsed = parseUtilities({
      version: 1,
      rows: protectedRows.map((row) => ({
        id: row.id,
        status: "Trashed",
        isLocked: invalid,
        isSuppressed: invalid,
      })),
    });
    for (const originalRow of protectedRows) {
      const row = parsed.rows.find((item) => item.id === originalRow.id);
      assert.equal(row.isLocked, originalRow.isLocked);
      assert.equal(row.isSuppressed, originalRow.isSuppressed);
    }
    assert.ok(
      !deriveTrashRows(parsed.rows).some((row) =>
        protectedRows.some((originalRow) => originalRow.id === row.id),
      ),
    );
  }
});
test("permanent deletion remains terminal after utility reload and cannot restore into a collection", () => {
  const store = storage();
  trashLibraryAsset("1", "taylor", store);
  trashAction(store, "1", "delete");
  assert.equal(byId(store, "1").status, "Deleted");
  assert.ok(
    !visibleAssets(reload(store), { unlocked: true }).some((a) => a.id === "1"),
  );
  assert.throws(() => trashAction(store, "1", "restore"), /no longer in trash/);
});

test("stale library mutations recheck trash and permanent deletion before writing", () => {
  const store = storage();
  changeLibraryAsset("1", { favorite: false }, "taylor", store);
  trashLibraryAsset("1", "taylor", store);
  const before = store.getItem(libraryAssetsKey);
  for (const patch of [
    { favorite: true },
    { visibility: "archive" },
    { sharedWith: ["Jamie"] },
  ])
    assert.throws(
      () => changeLibraryAsset("1", patch, "taylor", store),
      /no longer available/,
    );
  assert.equal(store.getItem(libraryAssetsKey), before);
  trashAction(store, "1", "delete");
  assert.throws(
    () => changeLibraryAsset("1", { favorite: true }, "taylor", store),
    /no longer available/,
  );
});
test("invalid patches cannot silently clear a saved lock or mutate ownership", () => {
  const store = storage();
  changeLibraryAsset("1", { isLocked: true }, "taylor", store);
  const before = store.getItem(libraryAssetsKey);
  for (const patch of [
    { isLocked: "false" },
    { visibility: "hidden" },
    { visibility: "locked" },
    { favorite: 1 },
    { ownerId: "jamie" },
    { albumIds: ["../escape"] },
    { albumIds: [42] },
    { sharedWith: ["Taylor"] },
    { description: "x".repeat(5000) },
    { latitude: 120 },
    { tagIds: ["ok", ""] },
    null,
    [],
    {},
  ])
    assert.throws(
      () => changeLibraryAsset("1", patch, "taylor", store),
      /supported/,
    );
  assert.equal(store.getItem(libraryAssetsKey), before);
  assert.equal(byId(store, "1").isLocked, true);
});
test("sharing rechecks current locked and suppression state and accepts an explicit unlock", () => {
  const store = storage();
  changeLibraryAsset("1", { isSuppressed: true }, "taylor", store);
  assert.throws(
    () => changeLibraryAsset("1", { sharedWith: ["Jamie"] }, "taylor", store),
    /Sensitive mark/,
  );
  changeLibraryAsset(
    "1",
    { isSuppressed: false, visibility: "timeline", isLocked: false },
    "taylor",
    store,
  );
  changeLibraryAsset("1", { sharedWith: ["Jamie", "Jamie"] }, "taylor", store);
  assert.deepEqual(byId(store, "1").sharedWith, ["Jamie"]);
});
test("parser and merger ignore inherited/accessor properties and untrusted immutable fields", () => {
  let accessed = false;
  const entry = {};
  Object.defineProperty(entry, "visibility", {
    enumerable: true,
    get() {
      accessed = true;
      return "locked";
    },
  });
  assert.deepEqual(parseLibraryAssets({ version: 1, assets: { 1: entry } }), {
    1: {},
  });
  assert.equal(accessed, false);
  const merged = mergeLibraryAssets(
    { 1: { ownerId: "jamie", image: "/other-account.png", favorite: false } },
    parseUtilities(null),
  );
  assert.equal(merged[0].ownerId, "taylor");
  assert.equal(merged[0].image, media[0].image);
  assert.equal(merged[0].favorite, false);
});

test("Sensitive marks retain albums and visibility through reload, trash, restore, and unmark", () => {
  for (const flag of ["isSensitive", "isNsfw"]) {
    const store = storage();
    const original = byId(store, "1");
    changeLibraryAsset("1", { [flag]: true }, "taylor", store);
    const marked = byId(store, "1");
    assert.deepEqual(marked.albumIds, original.albumIds);
    assert.equal(marked.visibility, original.visibility);
    assert.equal(marked[flag], true);
    assert.ok(!visibleAssets(reload(store)).some((asset) => asset.id === "1"));
    assert.ok(
      visibleAssets(reload(store), { unlocked: true }).some(
        (asset) => asset.id === "1",
      ),
    );
    trashLibraryAsset("1", "taylor", store);
    const rows = parseUtilities(store.getItem(utilityStorageKey)).rows;
    assert.equal(rows.find((row) => row.id === "library-1")[flag], true);
    assert.ok(!deriveTrashRows(rows).some((row) => row.id === "library-1"));
    trashAction(store, "1", "restore", true);
    assert.equal(byId(store, "1")[flag], true);
    changeLibraryAsset("1", { [flag]: false }, "taylor", store);
    assert.equal(byId(store, "1")[flag], false);
    assert.deepEqual(byId(store, "1").albumIds, original.albumIds);
    assert.equal(byId(store, "1").visibility, original.visibility);
    assert.ok(visibleAssets(reload(store)).some((asset) => asset.id === "1"));
  }
});

test("Sensitive marker persistence rejects malformed flags without clearing protected fixtures", () => {
  for (const invalid of ["false", null, 0, undefined]) {
    assert.deepEqual(
      parseLibraryAssets({
        version: 1,
        assets: { 1: { isSensitive: invalid, isNsfw: invalid } },
      })["1"],
      {},
    );
    const store = storage();
    assert.throws(
      () => changeLibraryAsset("1", { isSensitive: invalid }, "taylor", store),
      /supported/,
    );
  }
});
