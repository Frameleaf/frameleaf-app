import test from "node:test";
import assert from "node:assert/strict";
import {
  actionFields,
  actionLabel,
  actionPatch,
  bulkActionGroups,
  bulkActions,
  captureBefore,
  clearSelection,
  groupSelectionState,
  isSelected,
  nextAnchor,
  selectAll,
  selectGroup,
  selectRange,
  toggleSelection,
  undoPatches,
  undoRecord,
} from "../src/selection.mjs";
import { media } from "../src/media.js";

const order = ["a", "b", "c", "d", "e", "f"];

test("toggle adds and removes ids without mutating the input", () => {
  const current = ["a"];
  assert.deepEqual(toggleSelection(current, "b"), ["a", "b"]);
  assert.deepEqual(toggleSelection(current, "a"), []);
  assert.deepEqual(current, ["a"]);
  assert.deepEqual(toggleSelection(new Set(["a", "b"]), "a"), ["b"]);
  assert.deepEqual(toggleSelection(undefined, "z"), ["z"]);
  assert.deepEqual(toggleSelection(["a"], 42), ["a"]);
  assert.equal(isSelected(["a"], "a"), true);
  assert.equal(isSelected(new Set(["a"]), "b"), false);
});

test("range selection is inclusive in either direction and unions with the current set", () => {
  assert.deepEqual(selectRange(order, "b", "d", []), ["b", "c", "d"]);
  assert.deepEqual(selectRange(order, "d", "b", ["f"]), ["f", "b", "c", "d"]);
  assert.deepEqual(selectRange(order, "b", "b", []), ["b"]);
  assert.deepEqual(
    selectRange(order, "missing", "c", ["a"]),
    ["a", "c"],
    "no anchor falls back to the target only",
  );
  assert.deepEqual(selectRange(order, "a", "missing", ["a"]), ["a"]);
  assert.deepEqual(selectRange(null, "a", "b", new Set(["z"])), ["z"]);
});

test("select all, clear and group selection keep order and dedupe", () => {
  assert.deepEqual(selectAll(order, ["c", "zz"]), ["c", "zz", "a", "b", "d", "e", "f"]);
  assert.deepEqual(selectAll(order), order);
  assert.deepEqual(clearSelection(), []);
  assert.deepEqual(selectGroup(["a"], ["b", "c"], true), ["a", "b", "c"]);
  assert.deepEqual(selectGroup(["a", "b", "c"], ["b", "c"], false), ["a"]);
  assert.equal(groupSelectionState(["a", "b"], []), "none");
  assert.equal(groupSelectionState(["a", "b"], ["a"]), "some");
  assert.equal(groupSelectionState(["a", "b"], ["b", "a", "z"]), "all");
  assert.equal(groupSelectionState([], ["a"]), "none");
});

test("the next shift-click anchor follows the last toggled item that is still selected", () => {
  assert.equal(nextAnchor(["a", "b"], "b"), "b");
  assert.equal(nextAnchor(["a"], "b", "a"), "a", "deselecting keeps a valid anchor");
  assert.equal(nextAnchor(["c", "a"], "b", "zz"), "a", "falls back to the last selected");
  assert.equal(nextAnchor([], "b", "a"), null);
});

test("bulk actions cover every library command in group order with availability", () => {
  const assets = media.slice(0, 3);
  const actions = bulkActions({ assets });
  const ids = actions.map((action) => action.id);
  for (const required of [
    "favorite", "unfavorite", "add-to-album", "create-shared-link", "download", "stack", "unstack",
    "link-live-photo", "unlink-live-photo", "change-date", "change-description", "change-location",
    "archive", "unarchive", "mark-sensitive", "unmark-sensitive", "tag", "delete",
    "delete-permanently", "restore", "remove-from-album", "remove-from-shared-link",
    "set-album-cover", "refresh-thumbnails", "refresh-metadata", "refresh-encoded",
  ])
    assert.ok(ids.includes(required), required);
  assert.equal(new Set(ids).size, ids.length);
  const groupOrder = bulkActionGroups.map((group) => group.id);
  const seen = actions.map((action) => groupOrder.indexOf(action.group));
  assert.deepEqual(seen, [...seen].sort((a, b) => a - b), "grouped in order");
  for (const action of actions) {
    assert.equal(typeof action.label, "string");
    assert.ok(action.icon.startsWith("mdi"), action.id);
    assert.equal(typeof action.available, "boolean", action.id);
    assert.equal(typeof action.danger, "boolean");
  }
  const byId = Object.fromEntries(actions.map((action) => [action.id, action]));
  assert.equal(byId.stack.available, true);
  assert.equal(byId.delete.available, true);
  assert.equal(byId.delete.danger, true);
  assert.equal(byId.delete.undoable, true);
  assert.equal(byId.restore.available, false, "not in trash");
  assert.equal(byId["delete-permanently"].available, false);
  assert.equal(byId["remove-from-album"].available, false, "no album context");
  assert.equal(byId["set-album-cover"].available, false);
  assert.equal(byId["remove-from-shared-link"].available, false);
  assert.equal(byId["refresh-encoded"].available, true, "selection has a video");
  assert.equal(byId["change-date"].dialog, true);
});

test("availability follows the selected assets and the screen context", () => {
  const favorite = { id: "1", type: "photo", favorite: true };
  const plain = { id: "2", type: "photo", favorite: false };
  const byId = (context) =>
    Object.fromEntries(bulkActions(context).map((action) => [action.id, action]));

  let actions = byId({ assets: [favorite] });
  assert.equal(actions.favorite.available, false);
  assert.equal(actions.unfavorite.available, true);
  assert.equal(actions.stack.available, false, "needs two items");
  assert.equal(actions.unstack.available, false);
  assert.equal(actions["refresh-encoded"].available, false, "no video");

  actions = byId({ assets: [favorite, plain] });
  assert.equal(actions.favorite.available, true, "mixed selection can favorite");
  assert.equal(actions.unfavorite.available, true);

  actions = byId({
    assets: [
      { id: "p", type: "photo" },
      { id: "v", type: "video" },
    ],
  });
  assert.equal(actions["link-live-photo"].available, true);
  assert.equal(actions["unlink-live-photo"].available, false);
  actions = byId({ assets: [{ id: "p", type: "photo", isLivePhoto: true }] });
  assert.equal(actions["unlink-live-photo"].available, true);
  actions = byId({ assets: [{ id: "s", type: "photo", stackId: "x" }] });
  assert.equal(actions.unstack.available, true);

  actions = byId({ assets: [{ id: "a", visibility: "archive", isSensitive: true }] });
  assert.equal(actions.archive.available, false);
  assert.equal(actions.unarchive.available, true);
  assert.equal(actions["mark-sensitive"].available, false);
  assert.equal(actions["unmark-sensitive"].available, true);

  actions = byId({ assets: [plain], albumId: "summer", sharedLink: true });
  assert.equal(actions["remove-from-album"].available, true);
  assert.equal(actions["remove-from-album"].albumId, "summer");
  assert.equal(actions["set-album-cover"].available, true);
  assert.equal(actions["remove-from-shared-link"].available, true);
  actions = byId({ assets: [plain, favorite], albumId: "summer" });
  assert.equal(actions["set-album-cover"].available, false, "single only");

  actions = byId({ assets: [plain], trash: true });
  assert.equal(actions.restore.available, true);
  assert.equal(actions["delete-permanently"].available, true);
  assert.equal(actions["delete-permanently"].confirm, true);
  assert.equal(actions.delete.available, false);
  assert.equal(actions.favorite.available, false);
  assert.equal(actions.archive.available, false);
  assert.equal(actions.download.available, true, "download still works from trash");

  actions = byId({ count: 4 });
  assert.equal(actions.favorite.available, true, "count-only context");
  assert.equal(actions.stack.available, true);
  actions = byId({});
  assert.ok(Object.values(actions).every((action) => !action.available));
});

test("undo records snapshot only the changed fields and revert through patches", () => {
  const assets = media.slice(0, 2);
  const before = captureBefore(assets, actionFields("favorite"));
  assert.deepEqual(before, {
    [assets[0].id]: { favorite: assets[0].favorite },
    [assets[1].id]: { favorite: assets[1].favorite },
  });
  assert.deepEqual(actionPatch("favorite"), { favorite: true });
  assert.deepEqual(actionPatch("archive"), { visibility: "archive" });
  assert.deepEqual(actionPatch("unarchive"), { visibility: "timeline" });
  assert.equal(actionPatch("change-date"), null);
  assert.deepEqual(actionFields("change-location"), [
    "city", "state", "country", "latitude", "longitude",
  ]);
  assert.deepEqual(actionFields("unknown"), []);

  const record = undoRecord("favorite", [assets[0].id, assets[0].id, assets[1].id], before);
  assert.deepEqual(record.ids, [assets[0].id, assets[1].id]);
  assert.equal(record.label, "Added 2 items to favorites");
  assert.deepEqual(undoPatches(record), [
    [assets[0].id, { favorite: assets[0].favorite }],
    [assets[1].id, { favorite: assets[1].favorite }],
  ]);
  record.before[assets[0].id].favorite = "mutated";
  assert.equal(before[assets[0].id].favorite, assets[0].favorite, "record copies snapshots");
  assert.deepEqual(undoPatches(null), []);
  assert.deepEqual(undoRecord("delete", ["x"], null).before, {});

  const tagBefore = captureBefore([{ id: "t", tagIds: ["a"] }], ["tagIds"]);
  tagBefore.t.tagIds.push("b");
  assert.deepEqual(tagBefore.t.tagIds, ["a", "b"], "arrays are copied");
  assert.deepEqual(captureBefore([{ id: "m" }], ["city"]), { m: { city: null } });
  assert.deepEqual(captureBefore([null, { noId: true }], ["city"]), {});
});

test("status copy pluralizes and has a fallback", () => {
  assert.equal(actionLabel("delete", 1), "Moved 1 item to trash");
  assert.equal(actionLabel("delete", 3), "Moved 3 items to trash");
  assert.equal(actionLabel("tag", 2), "Tagged 2 items");
  assert.equal(actionLabel("set-album-cover", 1), "Album cover updated");
  assert.equal(actionLabel("mystery", 2), "Updated 2 items");
  assert.doesNotMatch(actionLabel("download", 2), /!/);
});
