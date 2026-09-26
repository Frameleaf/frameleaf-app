import assert from "node:assert/strict";
import * as mdi from "@mdi/js";
import { test } from "node:test";
import { media } from "../src/media.js";
import {
  collectionsKey,
  collectionIconNames,
  createCollectionsState,
  parseCollections,
  loadCollections,
  saveCollections,
  listCollections,
  tree,
  ancestors,
  descendantIds,
  createCollection,
  updateCollection,
  moveCollection,
  deleteCollection,
  setCover,
  inviteMember,
  changeRole,
  removeMember,
  leaveCollection,
  addActivity,
  removeActivity,
  toggleLike,
  toggleComments,
  reevaluateSmart,
  itemCount,
  collectionAssets,
  coverAsset,
  createLink,
  removeLink,
  roleOf,
  canEdit,
  activitySummary,
  formatDate,
  formatDateRange,
  timeAgo,
  plural,
} from "../src/collections-data.mjs";

const NOW = "2026-09-22T10:00:00.000Z";
const seed = () => createCollectionsState();
const users = [
  { id: "taylor", name: "Taylor" },
  { id: "jamie", name: "Jamie" },
  { id: "emma", name: "Emma" },
];
const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    map,
  };
};

test("seed data has the expected collections, nesting, roles and icons", () => {
  const state = seed();
  const ids = state.collections.map((c) => c.id);
  assert.deepEqual(
    ids,
    ["family", "summer-rockies", "winter-2026", "everyday", "trail-camera", "lake-days", "family-space"],
  );
  assert.equal(collectionIconNames.length, 227);
  assert.equal(new Set(collectionIconNames).size, collectionIconNames.length);
  for (const name of collectionIconNames) assert.equal(typeof mdi[name], "string", `${name} is not a Material icon`);
  for (const c of state.collections) assert.ok(collectionIconNames.includes(c.icon), c.id);
  const family = state.collections.find((c) => c.id === "family");
  assert.equal(family.parentId, null);
  assert.equal(family.kind, "collection");
  for (const id of ["summer-rockies", "winter-2026", "everyday"])
    assert.equal(state.collections.find((c) => c.id === id).parentId, "family");
  const trail = state.collections.find((c) => c.id === "trail-camera");
  assert.equal(trail.ownerId, "jamie");
  assert.equal(roleOf(trail, "taylor"), "viewer");
  assert.ok(trail.smart);
  const space = state.collections.find((c) => c.id === "family-space");
  assert.equal(space.kind, "space");
  assert.ok(state.activity["summer-rockies"].length >= 3);
});

test("itemCount, collectionAssets and coverAsset follow album, space and smart membership", () => {
  const state = seed();
  const by = (id) => state.collections.find((c) => c.id === id);
  assert.equal(itemCount(by("summer-rockies"), media), media.length);
  assert.equal(itemCount(by("family"), media), media.length);
  assert.equal(itemCount(by("winter-2026"), media), 0);
  assert.equal(
    itemCount(by("everyday"), media),
    media.filter((a) => a.albumIds.includes("everyday")).length,
  );
  assert.equal(
    itemCount(by("family-space"), media),
    media.filter((a) => a.spaceIds.includes("family-space")).length,
  );
  assert.deepEqual(
    reevaluateSmart(by("trail-camera").smart.rule, media),
    media.filter((a) => a.tags.some((t) => ["wildlife", "pet", "dog", "elk"].includes(t))).map((a) => a.id),
  );
  assert.equal(coverAsset(by("summer-rockies"), media).id, "3");
  const newestFirst = collectionAssets(by("summer-rockies"), media);
  assert.ok(newestFirst[0].takenAt >= newestFirst.at(-1).takenAt);
  const oldestFirst = collectionAssets({ ...by("summer-rockies"), displayOrder: "oldest" }, media);
  assert.ok(oldestFirst[0].takenAt <= oldestFirst.at(-1).takenAt);
  // Cover falls back to the newest item when the chosen cover is gone.
  assert.equal(coverAsset({ ...by("summer-rockies"), coverAssetId: "missing" }, media).id, newestFirst[0].id);
  // Trashed items never count.
  const trashed = media.map((a) => (a.id === "3" ? { ...a, status: "Trashed" } : a));
  assert.equal(itemCount(by("summer-rockies"), trashed), media.length - 1);
});

test("reevaluateSmart combines people, tags, dates and media type", () => {
  assert.deepEqual(
    reevaluateSmart({ personIds: ["Emma"] }, media),
    media.filter((a) => a.personIds.includes("Emma")).map((a) => a.id),
  );
  assert.deepEqual(
    reevaluateSmart({ type: "video" }, media),
    media.filter((a) => a.type === "video").map((a) => a.id),
  );
  assert.deepEqual(
    reevaluateSmart({ from: "2026-08-15", to: "2026-08-16", tagIds: ["lake"] }, media),
    media.filter((a) => a.date >= "2026-08-15" && a.date <= "2026-08-16" && a.tags.includes("lake")).map((a) => a.id),
  );
  assert.deepEqual(reevaluateSmart({}, media), media.map((a) => a.id));
  assert.deepEqual(reevaluateSmart(null, []), []);
});

test("listCollections filters by tab and search, sorts and groups", () => {
  const state = seed();
  const all = listCollections(state, { tab: "all", sort: "title" }, media, users);
  assert.equal(all.length, 1);
  assert.deepEqual(
    all[0].entries.map((e) => e.collection.name),
    ["Everyday", "Family", "Family Space", "Lake days", "Summer in the Rockies", "Trail camera", "Winter 2026"],
  );
  const mine = listCollections(state, { tab: "owned" }, media, users)[0].entries;
  assert.ok(mine.every((e) => e.mine && e.collection.ownerId === "taylor"));
  assert.ok(!mine.some((e) => e.collection.id === "trail-camera"));
  const shared = listCollections(state, { tab: "shared" }, media, users)[0].entries;
  assert.ok(shared.every((e) => e.shared));
  assert.ok(!shared.some((e) => e.collection.id === "winter-2026"));
  const search = listCollections(state, { search: "rock" }, media, users)[0].entries;
  assert.deepEqual(search.map((e) => e.collection.id), ["summer-rockies"]);
  const asJamie = listCollections(state, { userId: "jamie" }, media, users)[0].entries;
  assert.ok(!asJamie.some((e) => e.collection.id === "winter-2026"));
  assert.ok(asJamie.some((e) => e.collection.id === "trail-camera"));

  const byItems = listCollections(state, { sort: "items" }, media, users)[0].entries;
  for (let i = 1; i < byItems.length; i++) assert.ok(byItems[i - 1].itemCount >= byItems[i].itemCount);
  const byModified = listCollections(state, { sort: "modified" }, media, users)[0].entries;
  for (let i = 1; i < byModified.length; i++)
    assert.ok(byModified[i - 1].collection.updatedAt >= byModified[i].collection.updatedAt);
  const byCreated = listCollections(state, { sort: "created" }, media, users)[0].entries;
  for (let i = 1; i < byCreated.length; i++)
    assert.ok(byCreated[i - 1].collection.createdAt >= byCreated[i].collection.createdAt);
  const byRecent = listCollections(state, { sort: "recent-photo" }, media, users)[0].entries;
  assert.equal(byRecent.at(-1).collection.id, "winter-2026", "empty collections sort last");
  const byOldest = listCollections(state, { sort: "oldest-photo" }, media, users)[0].entries;
  assert.equal(byOldest.at(-1).collection.id, "winter-2026");
  assert.ok(byOldest[0].earliestAt <= byOldest[1].earliestAt);
  const reversed = listCollections(state, { sort: "title", direction: "desc" }, media, users)[0].entries;
  assert.equal(reversed[0].collection.name, "Winter 2026");

  const byOwner = listCollections(state, { groupBy: "owner" }, media, users);
  assert.deepEqual(byOwner.map((g) => g.label), ["Mine", "Shared by Jamie"]);
  const byYear = listCollections(state, { groupBy: "year" }, media, users);
  assert.ok(byYear.every((g) => /^\d{4}$/.test(g.key)));
  assert.equal(byYear.reduce((n, g) => n + g.entries.length, 0), 7);
});

test("tree and ancestors reflect nesting and tolerate a filtered set", () => {
  const state = seed();
  const roots = tree(state);
  assert.deepEqual(
    roots.map((n) => n.collection.id),
    ["family", "trail-camera", "lake-days", "family-space"],
  );
  assert.deepEqual(
    roots[0].children.map((n) => [n.collection.id, n.depth]),
    [["summer-rockies", 1], ["winter-2026", 1], ["everyday", 1]],
  );
  // When the parent is filtered out, children become roots.
  const partial = tree(state, ["summer-rockies", "everyday"]);
  assert.deepEqual(partial.map((n) => n.collection.id), ["summer-rockies", "everyday"]);
  assert.deepEqual(ancestors(state, "summer-rockies").map((c) => c.id), ["family"]);
  assert.deepEqual([...descendantIds(state, "family")].sort(), ["everyday", "summer-rockies", "winter-2026"]);
});

test("createCollection validates, slugs ids uniquely and supports smart rules", () => {
  const state = seed();
  const { state: next, collection } = createCollection(
    state,
    { name: "Family", description: "Second family album", icon: "mdiHeartOutline", parentId: "family" },
    NOW,
  );
  assert.equal(collection.id, "family-2");
  assert.equal(collection.parentId, "family");
  assert.equal(collection.icon, "mdiHeartOutline");
  assert.equal(collection.createdAt, NOW);
  assert.deepEqual(collection.members, [{ userId: "taylor", role: "owner" }]);
  assert.equal(next.collections.length, 8);
  assert.throws(() => createCollection(state, { name: "  " }), /name/);
  assert.throws(() => createCollection(state, { name: "x", parentId: "nope" }), /existing/);
  assert.throws(() => createCollection(state, { name: "x", parentId: "family-space" }), /albums/);
  assert.throws(() => createCollection(state, { name: "x", parentId: "trail-camera" }), /Smart/);
  assert.throws(() => createCollection(state, { name: "x", kind: "space", parentId: "family" }), /Spaces/);
  assert.throws(() => createCollection(state, { name: "Empty smart", smart: { rule: {} } }), /rule/);
  const smart = createCollection(state, { name: "Videos", smart: { rule: { type: "video" } } }, NOW).collection;
  assert.deepEqual(smart.smart.rule, { personIds: [], tagIds: [], from: null, to: null, type: "video" });
  assert.equal(itemCount(smart, media), media.filter((a) => a.type === "video").length);
  // Unknown icons fall back safely.
  assert.equal(createCollection(state, { name: "Odd", icon: "mdiNope" }).collection.icon, "mdiImageAlbum");
  assert.equal(createCollection(state, { name: "Trips", kind: "collection" }).collection.icon, "mdiFolderMultipleOutline");
  assert.throws(() => createCollection(state, { name: "x", kind: "collection", smart: { rule: { type: "video" } } }), /Only albums/);
  assert.throws(() => createCollection(state, { name: "x", kind: "collection", parentId: "family" }), /Collections cannot be nested/);
});

test("updateCollection applies known fields, rejects unknown ones and bumps updatedAt", () => {
  const state = seed();
  const next = updateCollection(
    state,
    "everyday",
    { name: " Every day ", description: "Line one\nLine two", displayOrder: "oldest", commentsEnabled: false, showOwnerBadges: false },
    NOW,
  );
  const c = next.collections.find((x) => x.id === "everyday");
  assert.equal(c.name, "Every day");
  assert.equal(c.description, "Line one\nLine two");
  assert.equal(c.displayOrder, "oldest");
  assert.equal(c.commentsEnabled, false);
  assert.equal(c.showOwnerBadges, false);
  assert.equal(c.updatedAt, NOW);
  assert.throws(() => updateCollection(state, "everyday", { name: "" }), /name/);
  assert.throws(() => updateCollection(state, "everyday", { icon: "mdiNope" }), /icon/);
  assert.throws(() => updateCollection(state, "everyday", { displayOrder: "random" }), /order/);
  assert.throws(() => updateCollection(state, "everyday", { commentsEnabled: "yes" }), /on or off/);
  assert.throws(() => updateCollection(state, "everyday", { ownerId: "jamie" }), /not a collection setting/);
  assert.throws(() => updateCollection(state, "everyday", {}), /supported/);
  assert.throws(() => updateCollection(state, "missing", { name: "x" }), /no longer exists/);
  assert.throws(() => updateCollection(state, "family", { smart: { rule: { type: "video" } } }), /nested/);
  const smart = updateCollection(state, "winter-2026", { smart: { rule: { tagIds: ["snow"] } } }, NOW);
  assert.deepEqual(smart.collections.find((x) => x.id === "winter-2026").smart.rule.tagIds, ["snow"]);
  const plain = updateCollection(smart, "winter-2026", { smart: null }, NOW);
  assert.equal(plain.collections.find((x) => x.id === "winter-2026").smart, null);
  assert.equal(state.collections.find((x) => x.id === "everyday").name, "Everyday", "input untouched");
});

test("moveCollection re-parents with cycle prevention and no-op on same parent", () => {
  const state = seed();
  const moved = moveCollection(state, "everyday", null, NOW);
  assert.equal(moved.collections.find((c) => c.id === "everyday").parentId, null);
  assert.equal(moved.collections.find((c) => c.id === "everyday").updatedAt, NOW);
  const nested = moveCollection(moved, "everyday", "family", NOW);
  assert.equal(nested.collections.find((c) => c.id === "everyday").parentId, "family");
  assert.throws(() => moveCollection(state, "family", "summer-rockies"), /Collections cannot be nested/);
  assert.throws(() => moveCollection(state, "family", "family"), /Collections cannot be nested/);
  assert.throws(() => moveCollection(state, "everyday", "everyday"), /itself/);
  assert.throws(() => moveCollection(state, "family-space", "family"), /Spaces/);
  assert.throws(() => moveCollection(state, "everyday", "family-space"), /albums/);
  assert.throws(() => moveCollection(state, "everyday", "summer-rockies"), /albums/);
  assert.throws(() => moveCollection(state, "everyday", "trail-camera"), /Smart/);
  assert.throws(() => moveCollection(state, "everyday", "nope"), /existing/);
  assert.equal(moveCollection(state, "everyday", "family"), state, "same parent returns the same state");
  assert.equal(updateCollection(state, "everyday", { parentId: null }, NOW).collections.find((c) => c.id === "everyday").parentId, null);
});

test("deleteCollection keeps assets, re-parents children and drops activity", () => {
  const state = seed();
  const { state: next, assetIds } = deleteCollection(state, "family", { keepAssets: true, assets: media });
  assert.ok(!next.collections.some((c) => c.id === "family"));
  assert.deepEqual(assetIds, media.map((a) => a.id));
  for (const id of ["summer-rockies", "winter-2026", "everyday"])
    assert.equal(next.collections.find((c) => c.id === id).parentId, null);
  assert.equal(next.activity.family, undefined);
  assert.ok(next.activity["summer-rockies"]);
  assert.throws(() => deleteCollection(state, "family", { keepAssets: false }), /keeping/);
  assert.throws(() => deleteCollection(state, "missing"), /no longer exists/);
  const smart = deleteCollection(state, "trail-camera", { assets: media });
  assert.deepEqual(smart.assetIds, [], "smart collections reference no stored asset ids");
});

test("setCover accepts an asset id or clears it", () => {
  const state = seed();
  assert.equal(setCover(state, "everyday", "5", NOW).collections.find((c) => c.id === "everyday").coverAssetId, "5");
  assert.equal(setCover(state, "everyday", null, NOW).collections.find((c) => c.id === "everyday").coverAssetId, null);
  assert.throws(() => setCover(state, "missing", "5"), /no longer exists/);
});

test("member management enforces roles and ownership", () => {
  const state = seed();
  const invited = inviteMember(state, "winter-2026", "jamie", "editor", NOW);
  const c = () => invited.collections.find((x) => x.id === "winter-2026");
  assert.deepEqual(c().members, [{ userId: "taylor", role: "owner" }, { userId: "jamie", role: "editor" }]);
  assert.equal(c().updatedAt, NOW);
  assert.ok(canEdit(c(), "jamie"));
  assert.throws(() => inviteMember(state, "winter-2026", "taylor", "viewer"), /already/);
  assert.throws(() => inviteMember(state, "winter-2026", "jamie", "owner"), /Editor or Viewer/);
  assert.throws(() => inviteMember(state, "winter-2026", "", "viewer"), /person/);
  const demoted = changeRole(invited, "winter-2026", "jamie", "viewer", NOW);
  assert.equal(roleOf(demoted.collections.find((x) => x.id === "winter-2026"), "jamie"), "viewer");
  assert.throws(() => changeRole(invited, "winter-2026", "taylor", "viewer"), /owner/);
  assert.throws(() => changeRole(invited, "winter-2026", "emma", "viewer"), /do not have access/);
  const removed = removeMember(invited, "winter-2026", "jamie", NOW);
  assert.equal(roleOf(removed.collections.find((x) => x.id === "winter-2026"), "jamie"), null);
  assert.throws(() => removeMember(invited, "winter-2026", "taylor"), /owner/);
  const left = leaveCollection(state, "trail-camera", "taylor", NOW);
  assert.equal(roleOf(left.collections.find((x) => x.id === "trail-camera"), "taylor"), null);
  assert.throws(() => leaveCollection(state, "trail-camera", "jamie"), /Owners cannot leave/);
});

test("activity supports comments, likes, removal and the comments toggle", () => {
  const state = seed();
  const commented = addActivity(state, "everyday", { userId: "taylor", type: "comment", text: "Lovely light." }, NOW);
  const list = commented.activity.everyday;
  assert.equal(list.length, 1);
  assert.equal(list[0].text, "Lovely light.");
  assert.equal(list[0].assetId, null);
  assert.equal(list[0].at, NOW);
  assert.equal(commented.collections.find((c) => c.id === "everyday").updatedAt, NOW);
  assert.throws(() => addActivity(state, "everyday", { userId: "taylor", type: "comment", text: "   " }), /Write a comment/);
  assert.throws(() => addActivity(state, "everyday", { userId: "taylor", type: "shout" }), /valid activity/);
  const liked = toggleLike(commented, "everyday", "taylor", "10", NOW);
  assert.equal(liked.activity.everyday.filter((a) => a.type === "like").length, 1);
  const likedAgain = toggleLike(liked, "everyday", "taylor", "10", NOW);
  assert.equal(likedAgain.activity.everyday.filter((a) => a.type === "like").length, 0, "second like removes it");
  const duplicate = addActivity(liked, "everyday", { userId: "taylor", type: "like", assetId: "10" }, NOW);
  assert.equal(duplicate, liked, "duplicate like is a no-op");
  const removed = removeActivity(commented, "everyday", list[0].id);
  assert.equal(removed.activity.everyday.length, 0);
  assert.equal(removeActivity(commented, "everyday", "nope"), commented);
  const off = toggleComments(state, "everyday", NOW);
  assert.equal(off.collections.find((c) => c.id === "everyday").commentsEnabled, false);
  assert.throws(() => addActivity(off, "everyday", { userId: "taylor", type: "like" }), /turned off/);
  const summary = activitySummary(state, "summer-rockies", "jamie");
  assert.deepEqual(summary, { likes: 1, comments: 3, liked: false });
});

test("links are created and removed on the collection", () => {
  const state = seed();
  const { state: next, link } = createLink(state, "everyday", { allowUpload: true, expiresAt: "2026-12-01T00:00:00.000Z" }, NOW);
  const c = next.collections.find((x) => x.id === "everyday");
  assert.equal(c.links.length, 1);
  assert.equal(link.allowUpload, true);
  assert.equal(link.expiresAt, "2026-12-01T00:00:00.000Z");
  assert.equal(link.createdAt, NOW);
  assert.equal(removeLink(next, "everyday", link.id, NOW).collections.find((x) => x.id === "everyday").links.length, 0);
  assert.equal(removeLink(next, "everyday", "nope"), next);
});

test("parseCollections is defensive about stored shapes", () => {
  const seedState = seed();
  assert.deepEqual(parseCollections("not json"), seedState);
  assert.deepEqual(parseCollections(null), seedState);
  assert.deepEqual(parseCollections({ version: 2, collections: [] }), seedState);
  assert.deepEqual(parseCollections({ version: 1, collections: [] }).collections, []);
  const parsed = parseCollections({
    version: 1,
    collections: [
      { id: "ok", name: "  Kept ", ownerId: "taylor", icon: "mdiNope", parentId: "ghost", displayOrder: "sideways", kind: "weird", members: [{ userId: "jamie", role: "owner" }, { userId: "emma", role: "viewer" }, { userId: "emma", role: "editor" }, "junk"], links: [{ id: "l1", createdAt: "bad" }, { id: "l2", createdAt: NOW }], smart: { rule: { type: "video", tagIds: ["a", 3, "a"] } }, createdAt: "junk", commentsEnabled: "no" },
      { id: "a", name: "A", ownerId: "taylor", parentId: "b" },
      { id: "b", name: "B", ownerId: "taylor", parentId: "a" },
      { id: "ok", name: "Duplicate id", ownerId: "taylor" },
      { name: "No id", ownerId: "taylor" },
      { id: "bad\u0000", name: "Control chars", ownerId: "taylor" },
      { id: "sp", name: "Space", ownerId: "taylor", kind: "space", parentId: "ok" },
      { id: "legacy", name: "Legacy parent", ownerId: "taylor" },
      { id: "inside", name: "Inside legacy", ownerId: "taylor", parentId: "legacy" },
      { id: "__proto__", name: "Proto", ownerId: "taylor" },
      null,
      42,
    ],
    activity: {
      ok: [
        { id: "x1", userId: "jamie", type: "comment", text: "Hi", at: NOW, assetId: 7 },
        { id: "x1", userId: "jamie", type: "comment", text: "Dup", at: NOW },
        { id: "x2", userId: "jamie", type: "comment", text: "", at: NOW },
        { id: "x3", userId: "emma", type: "like", at: "nope" },
        { id: "x4", userId: "emma", type: "like", at: NOW, text: "ignored" },
      ],
      ghost: [{ id: "g", userId: "jamie", type: "like", at: NOW }],
      ["__proto__"]: [{ id: "p", userId: "jamie", type: "like", at: NOW }],
    },
  });
  const ok = parsed.collections.find((c) => c.id === "ok");
  assert.equal(ok.name, "Kept");
  assert.equal(ok.icon, "mdiFolderOutline");
  assert.equal(ok.parentId, null, "missing parents are dropped");
  assert.equal(ok.displayOrder, "newest");
  assert.equal(ok.kind, "album");
  assert.equal(ok.commentsEnabled, true);
  assert.deepEqual(ok.members, [
    { userId: "taylor", role: "owner" },
    { userId: "jamie", role: "editor" },
    { userId: "emma", role: "viewer" },
  ]);
  assert.deepEqual(ok.links.map((l) => l.id), ["l2"]);
  assert.deepEqual(ok.smart.rule, { personIds: [], tagIds: ["a"], from: null, to: null, type: "video" });
  assert.ok(Number.isFinite(Date.parse(ok.createdAt)));
  const a = parsed.collections.find((c) => c.id === "a");
  const b = parsed.collections.find((c) => c.id === "b");
  assert.ok(a.parentId === null || b.parentId === null, "cycles are broken");
  assert.equal(parsed.collections.filter((c) => c.id === "ok").length, 1);
  assert.ok(!parsed.collections.some((c) => c.name === "No id" || c.name === "Control chars"));
  assert.equal(parsed.collections.find((c) => c.id === "sp").parentId, null, "spaces never nest");
  assert.equal(parsed.collections.find((c) => c.id === "legacy").kind, "collection", "an album holding albums becomes a collection");
  assert.equal(parsed.collections.find((c) => c.id === "inside").parentId, "legacy");
  assert.deepEqual(parsed.activity.ok.map((e) => e.id), ["x1", "x4"]);
  assert.equal(parsed.activity.ok[0].assetId, null);
  assert.equal(parsed.activity.ok[1].text, "");
  assert.equal(parsed.activity.ghost, undefined);
  assert.equal(Object.hasOwn(parsed.activity, "__proto__"), false);
  assert.ok(!parsed.collections.some((c) => c.id === "__proto__"), "reserved ids are dropped");
  assert.equal(Object.getPrototypeOf(parsed.activity), Object.prototype);
  assert.equal(createCollection(seedState, { name: "constructor" }).collection.id, "constructor-2");
  const ordered = tree(seedState, ["everyday", "family", "summer-rockies"]);
  assert.deepEqual(ordered.map((n) => n.collection.id), ["family"]);
  assert.deepEqual(ordered[0].children.map((n) => n.collection.id), ["everyday", "summer-rockies"]);
});

test("loadCollections and saveCollections round-trip through storage", () => {
  const storage = memoryStorage();
  assert.deepEqual(loadCollections(storage), seed());
  const next = updateCollection(seed(), "everyday", { name: "Renamed" }, NOW);
  assert.equal(saveCollections(next, storage), true);
  assert.ok(storage.map.has(collectionsKey));
  assert.equal(loadCollections(storage).collections.find((c) => c.id === "everyday").name, "Renamed");
  storage.setItem(collectionsKey, "{broken");
  assert.deepEqual(loadCollections(storage), seed());
  assert.deepEqual(loadCollections(null), seed());
  assert.equal(saveCollections(next, null), false);
  const throwing = { getItem() { throw new Error("nope"); }, setItem() { throw new Error("nope"); } };
  assert.deepEqual(loadCollections(throwing), seed());
  assert.equal(saveCollections(next, throwing), false);
});

test("formatting helpers produce calm, readable copy", () => {
  assert.equal(formatDateRange("2026-08-12", "2026-08-16"), "Aug 12 – Aug 16, 2026");
  assert.equal(formatDateRange("2026-08-16T07:14:00", "2026-08-16T09:00:00"), "Aug 16, 2026");
  assert.equal(formatDateRange("2025-12-30", "2026-01-02"), "Dec 30, 2025 – Jan 2, 2026");
  assert.equal(formatDateRange(null, null), "");
  assert.equal(formatDateRange(null, "2026-08-16"), "Aug 16, 2026");
  assert.equal(formatDate("nonsense"), "");
  const now = Date.parse("2026-09-22T10:00:00.000Z");
  assert.equal(timeAgo("2026-09-22T09:59:50.000Z", now), "just now");
  assert.equal(timeAgo("2026-09-22T09:30:00.000Z", now), "30 minutes ago");
  assert.equal(timeAgo("2026-09-22T07:00:00.000Z", now), "3 hours ago");
  assert.equal(timeAgo("2026-09-21T09:00:00.000Z", now), "yesterday");
  assert.equal(timeAgo("2026-09-19T09:00:00.000Z", now), "3 days ago");
  assert.equal(timeAgo("2026-09-01T09:00:00.000Z", now), "Sep 1, 2026");
  assert.equal(timeAgo(undefined, now), "");
  assert.equal(plural(1, "item"), "1 item");
  assert.equal(plural(3, "item"), "3 items");
});
