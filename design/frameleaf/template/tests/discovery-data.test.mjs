import assert from "node:assert/strict";
import { test } from "node:test";
import { media, tags } from "../src/media.js";
import {
  project,
  unproject,
  viewportBounds,
  zoomToFit,
  boundsFor,
  boundsCenter,
  clusterAssets,
  placesTree,
  tagTree,
  applyTagChange,
  parseTagOverrides,
  folderTree,
  folderAt,
  folderBreadcrumbs,
  formatBytes,
  memoriesFor,
  findMemory,
  memoryOverrides,
  parseMemoryOverrides,
  filterMapAssets,
  graticuleLines,
  dateRangeLabel,
} from "../src/discovery-data.mjs";

const size = { width: 900, height: 600 };

test("projection round-trips through pixel space and respects Mercator stretching", () => {
  const bounds = boundsFor(media);
  for (const asset of media) {
    const point = project(asset.latitude, asset.longitude, bounds, size);
    assert.ok(point.x >= 0 && point.x <= size.width);
    assert.ok(point.y >= 0 && point.y <= size.height);
    const back = unproject(point.x, point.y, bounds, size);
    assert.ok(Math.abs(back.lat - asset.latitude) < 1e-6);
    assert.ok(Math.abs(back.lng - asset.longitude) < 1e-6);
  }
  // Corners map to the bounds edges.
  const nw = unproject(0, 0, bounds, size);
  const se = unproject(size.width, size.height, bounds, size);
  assert.ok(Math.abs(nw.lat - bounds.north) < 1e-9);
  assert.ok(Math.abs(nw.lng - bounds.west) < 1e-9);
  assert.ok(Math.abs(se.lat - bounds.south) < 1e-9);
  assert.ok(Math.abs(se.lng - bounds.east) < 1e-9);
  // Invalid inputs never throw.
  assert.equal(project(1, 2, null, size), null);
  assert.equal(project(1, 2, bounds, { width: 0, height: 0 }), null);
});

test("viewport bounds and zoom-to-fit agree with each other", () => {
  const extent = boundsFor(media);
  const zoom = zoomToFit(extent, size);
  assert.equal(zoom % 0.5, 0);
  const view = viewportBounds(boundsCenter(extent), zoom, size);
  assert.ok(view.north >= extent.north && view.south <= extent.south);
  assert.ok(view.east >= extent.east && view.west <= extent.west);
  // One more half step would no longer fit.
  const tighter = viewportBounds(boundsCenter(extent), zoom + 0.5, {
    width: size.width - 96,
    height: size.height - 96,
  });
  assert.ok(
    tighter.north < extent.north ||
      tighter.south > extent.south ||
      tighter.east < extent.east ||
      tighter.west > extent.west,
  );
  assert.deepEqual(boundsFor([]), boundsFor([{ id: "x" }]));
  const lines = graticuleLines(view, zoom);
  assert.ok(lines.lat.length > 1 && lines.lng.length > 1);
});

test("clustering merges near points and separates them when zoomed in", () => {
  const near = [
    { id: "a", latitude: 51.1, longitude: -115.5, date: "2026-08-01", image: "/a.png" },
    { id: "b", latitude: 51.101, longitude: -115.501, date: "2026-08-02", image: "/b.png" },
    { id: "c", latitude: 52.9, longitude: -118.1, date: "2026-08-03", image: "/c.png" },
    { id: "d", latitude: null, longitude: null },
  ];
  const wide = viewportBounds({ lat: 52, lng: -116.8 }, 7, size);
  const clusters = clusterAssets(near, { bounds: wide, size, radius: 40 });
  assert.equal(clusters.length, 2);
  const pair = clusters.find((c) => c.count === 2);
  assert.deepEqual(pair.assetIds, ["b", "a"]);
  assert.equal(pair.cover.id, "b");
  assert.ok(pair.id.startsWith("cluster:"));
  const single = clusters.find((c) => c.count === 1);
  assert.equal(single.id, "asset:c");
  const close = viewportBounds({ lat: 51.1005, lng: -115.5005 }, 15, size);
  const split = clusterAssets(near, { bounds: close, size, radius: 40 });
  assert.equal(split.length, 2);
  assert.ok(split.every((c) => c.count === 1));
  // Real sample data collapses to three towns at the fitted zoom.
  const extent = boundsFor(media);
  const view = viewportBounds(boundsCenter(extent), zoomToFit(extent, size), size);
  const towns = clusterAssets(media, { bounds: view, size, radius: 44 });
  assert.equal(towns.reduce((sum, c) => sum + c.count, 0), media.length);
  assert.ok(towns.length >= 3 && towns.length <= 5);
  assert.ok(towns.some((c) => c.place === "Banff"));
});

test("places tree groups country, state and city with counts and covers", () => {
  const tree = placesTree([
    ...media,
    { id: "x", city: "", country: "", date: "2026-01-01" },
    { id: "y", city: "Paris", country: "France", latitude: 48.85, longitude: 2.35, date: "2026-01-02", image: "/p.png" },
  ]);
  assert.equal(tree.unplaced, 1);
  assert.equal(tree.total, media.length + 1);
  assert.deepEqual(
    tree.countries.map((c) => [c.name, c.count]),
    [["Canada", media.length], ["France", 1]],
  );
  const alberta = tree.countries[0].children[0];
  assert.equal(alberta.name, "Alberta");
  assert.deepEqual(
    alberta.children.map((c) => c.name),
    ["Banff", "Lake Louise", "Jasper"],
  );
  const banff = alberta.children[0];
  assert.equal(banff.count, 8);
  assert.ok(banff.cover.image);
  assert.ok(Math.abs(banff.latitude - 51.18) < 0.1);
  assert.deepEqual(banff.query, { filter: { city: { eq: "Banff" } } });
  assert.equal(tree.countries[1].children[0].name, "Other");
  assert.equal(tree.cities[0].name, "Banff");
});

test("tag tree includes sample hierarchy and honours overrides", () => {
  const base = tagTree(tags, media, null);
  const trips = base.byId.trips;
  assert.ok(trips && trips.children.some((c) => c.id === "trips/rockies-2026"));
  const rockies = base.byId["trips/rockies-2026"];
  assert.deepEqual(rockies.path, ["trips", "rockies-2026"]);
  assert.ok(rockies.count > 5);
  assert.equal(rockies.children[0].id, "trips/rockies-2026/lakes");
  assert.ok(rockies.total >= rockies.count);
  assert.ok(rockies.query.filter.tagIds.any.includes("lake"));
  const kids = base.byId["family/kids"];
  assert.ok(kids.count >= 2 && kids.count <= 4);
  assert.equal(base.byId.mountains.color, "grey");
  assert.equal(base.byId.mountains.count, media.filter((a) => a.tags.includes("mountains")).length);
  assert.ok(base.roots.every((node) => node.depth === 0));

  const created = applyTagChange(null, { type: "create", name: "Reunion", parent: "family", color: "purple" }, base);
  let overrides = created.overrides;
  assert.throws(() => applyTagChange(overrides, { type: "create", name: "Kids", parent: "family" }, tagTree(tags, media, overrides)), /already exists/);
  assert.throws(() => applyTagChange(overrides, { type: "create", name: "a/b" }, base), /without slashes/);
  overrides = applyTagChange(overrides, { type: "rename", id: "mountains", name: "Peaks" }, base).overrides;
  overrides = applyTagChange(overrides, { type: "color", id: "mountains", color: "green" }, base).overrides;
  overrides = applyTagChange(overrides, { type: "move", id: "mountains", parent: "trips" }, base).overrides;
  overrides = applyTagChange(overrides, { type: "delete", id: "family/pets" }, base).overrides;
  assert.throws(() => applyTagChange(overrides, { type: "move", id: "trips", parent: "trips/rockies-2026" }, base), /inside itself/);
  const next = tagTree(tags, media, overrides);
  const reunion = next.byId[created.id];
  assert.equal(reunion.name, "Reunion");
  assert.equal(reunion.parent, "family");
  assert.equal(reunion.color, "purple");
  assert.equal(reunion.count, 0);
  assert.equal(next.byId.mountains.name, "Peaks");
  assert.equal(next.byId.mountains.color, "green");
  assert.equal(next.byId.mountains.parent, "trips");
  assert.deepEqual(next.byId.mountains.path, ["trips", "Peaks"]);
  assert.equal(next.byId["family/pets"], undefined);
  assert.ok(next.byId.trips.total >= next.byId.mountains.count);
  // Deleting a parent removes descendants too.
  const gone = tagTree(tags, media, applyTagChange(overrides, { type: "delete", id: "trips" }, next).overrides);
  assert.equal(gone.byId["trips/rockies-2026/lakes"], undefined);
  // Persisted shapes are validated field by field.
  const parsed = parseTagOverrides(JSON.stringify({ ...overrides, colors: { mountains: "neon", lake: "teal" }, deleted: [1, "x"], created: [{ id: "tag:1", name: "ok" }, { name: "bad" }] }));
  assert.deepEqual(parsed.colors, { lake: "teal" });
  assert.deepEqual(parsed.deleted, ["x"]);
  assert.deepEqual(parsed.created, [{ id: "tag:1", name: "ok", parent: null }]);
  assert.deepEqual(parseTagOverrides("{nope"), parseTagOverrides({ version: 2 }));
});

test("folder tree follows originalPath with counts, sizes and breadcrumbs", () => {
  const assets = [
    ...media,
    { id: "z", originalPath: "/photos/2025/Winter/Snow.jpg", fileSizeInBytes: 1024, date: "2025-01-01", image: "/s.png" },
    { id: "q", originalFileName: "loose.jpg", date: "2025-01-02" },
  ];
  const tree = folderTree(assets);
  assert.equal(tree.root.count, assets.length);
  assert.equal(tree.root.directCount, 1);
  const photos = folderAt(tree, "/photos");
  assert.deepEqual(photos.children.map((c) => c.name), ["2025", "2026"]);
  const rockies = folderAt(tree, "/photos/2026/Rockies");
  assert.equal(rockies.count, media.length);
  assert.equal(rockies.size, media.reduce((sum, a) => sum + a.fileSizeInBytes, 0));
  assert.deepEqual(rockies.breadcrumbs.map((b) => b.name), ["All folders", "photos", "2026", "Rockies"]);
  assert.equal(folderAt(tree, "/photos/2025/Winter").size, 1024);
  assert.ok(photos.cover);
  assert.equal(folderAt(tree, "/missing"), null);
  assert.deepEqual(folderBreadcrumbs("/a/b").at(-1), { name: "b", path: "/a/b" });
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1536), "1.5 KB");
  assert.equal(formatBytes(48_300_000), "46 MB");
});

test("memories for 2026-09-22 surface events and best-of, with nothing for today", () => {
  const index = memoriesFor(media, { today: "2026-09-22" });
  assert.deepEqual(index.today, []);
  assert.deepEqual(index.upcoming, []);
  const kinds = index.earlier.map((m) => m.kind);
  assert.ok(kinds.includes("event") && kinds.includes("best-of"));
  const weekend = index.earlier.find((m) => m.title === "Weekend in Banff");
  assert.ok(weekend, "expected a Banff weekend");
  assert.equal(weekend.subtitle, "August 14–16, 2026");
  assert.ok(weekend.count >= 2);
  assert.ok(weekend.cover.image);
  const best = index.earlier.find((m) => m.kind === "best-of");
  assert.equal(best.title, "Best of August 2026");
  assert.ok(best.count >= 3 && best.count <= 8);
  assert.ok(index.earlier.every((m) => m.assetIds.length === m.count));
  assert.ok(index.earlier.some((m) => /^A day in|^A few days in/.test(m.title)));
  // Every event stays within a three-day window at one city.
  for (const memory of index.earlier.filter((m) => m.kind === "event")) {
    const days = memory.assetIds.map((id) => media.find((a) => a.id === id).date).sort();
    assert.ok(
      (Date.parse(days.at(-1)) - Date.parse(days[0])) / 86_400_000 <= 2,
      `${memory.title} spans too long`,
    );
    assert.ok(memory.assetIds.every((id) => media.find((a) => a.id === id).city === memory.place));
  }
});

test("memories for 2027-08-16 produce On this day and One year ago", () => {
  const index = memoriesFor(media, { today: "2027-08-16" });
  const onThisDay = index.today.find((m) => m.kind === "on-this-day");
  assert.ok(onThisDay);
  assert.equal(onThisDay.years, 1);
  assert.deepEqual(onThisDay.assetIds.sort(), ["1", "2", "3", "4"]);
  assert.match(onThisDay.subtitle, /^One year ago · August 16, 2026/);
  const yearAgo = index.today.find((m) => m.kind === "years-ago");
  assert.equal(yearAgo.title, "One year ago");
  assert.ok(!yearAgo.assetIds.some((id) => onThisDay.assetIds.includes(id)));
  assert.ok(yearAgo.assetIds.every((id) => ["2026-08-13", "2026-08-14", "2026-08-15"].includes(media.find((a) => a.id === id).date)));
  assert.equal(memoriesFor(media, { today: "2028-08-16" }).today[0].subtitle.split(" ·")[0], "2 years ago");
  // Upcoming lists the next fortnight in date order.
  const soon = memoriesFor(media, { today: "2027-08-10" });
  assert.deepEqual(
    soon.upcoming.map((m) => [m.upcomingOn, m.inDays]),
    [
      ["2027-08-11", 1],
      ["2027-08-12", 2],
      ["2027-08-13", 3],
      ["2027-08-14", 4],
      ["2027-08-15", 5],
      ["2027-08-16", 6],
    ],
  );
  assert.deepEqual(memoriesFor(media, { today: "2027-08-10", showUpcoming: false }).upcoming, []);
  // A recently passed day remains reachable in Earlier.
  const passed = memoriesFor(media, { today: "2027-08-20" });
  assert.ok(passed.earlier.some((m) => m.id === "on-this-day:2026-08-16" && m.passedDays === 4));
  assert.equal(dateRangeLabel("2026-08-14", "2026-08-16"), "August 14–16, 2026");
  assert.equal(dateRangeLabel("2026-08-30", "2026-09-02"), "August 30 – September 2, 2026");
});

test("memory overrides hide, favorite and trim memories with defensive parsing", () => {
  let overrides = memoryOverrides.hide(null, "best-of:2026-08");
  let index = memoriesFor(media, { today: "2026-09-22", overrides });
  assert.ok(!index.earlier.some((m) => m.id === "best-of:2026-08"));
  assert.equal(index.hidden[0].id, "best-of:2026-08");
  overrides = memoryOverrides.unhide(overrides, "best-of:2026-08");
  overrides = memoryOverrides.toggleFavorite(overrides, "best-of:2026-08");
  index = memoriesFor(media, { today: "2026-09-22", overrides, onlyFavorites: true });
  assert.deepEqual(index.earlier.map((m) => m.id), ["best-of:2026-08"]);
  assert.equal(index.earlier[0].favorite, true);
  const weekend = memoriesFor(media, { today: "2026-09-22" }).earlier.find((m) => m.title === "Weekend in Banff");
  overrides = memoryOverrides.removeAsset(overrides, weekend.id, weekend.assetIds[0]);
  const trimmed = findMemory(media, weekend.id, { today: "2026-09-22", overrides });
  assert.equal(trimmed.count, weekend.count - 1);
  assert.equal(trimmed.removedCount, 1);
  assert.ok(!trimmed.assetIds.includes(weekend.assetIds[0]));
  overrides = memoryOverrides.restoreAsset(overrides, weekend.id, weekend.assetIds[0]);
  assert.equal(findMemory(media, weekend.id, { today: "2026-09-22", overrides }).count, weekend.count);
  assert.equal(memoryOverrides.toggleFavorite(overrides, "best-of:2026-08").favorites.length, 0);
  const parsed = parseMemoryOverrides(JSON.stringify({ version: 1, hidden: ["a", 3, "a"], favorites: "x", removed: { m: ["1", 2], n: [] }, settings: { showUpcoming: false, onlyFavorites: "yes" } }));
  assert.deepEqual(parsed, {
    version: 1,
    hidden: ["a"],
    favorites: [],
    removed: { m: ["1"] },
    settings: { showUpcoming: false, onlyFavorites: false },
  });
  assert.equal(memoryOverrides.settings(parsed, { onlyFavorites: true }).settings.onlyFavorites, true);
  assert.deepEqual(parseMemoryOverrides("garbage"), parseMemoryOverrides(null));
  assert.equal(findMemory(media, "nope", { today: "2026-09-22" }), null);
});

test("map settings filter by date presets, archive, favorites and partner ownership", () => {
  const assets = [
    ...media,
    { id: "partner", ownerId: "jamie", latitude: 51.2, longitude: -115.6, date: "2026-09-20" },
    { id: "nowhere", ownerId: "taylor", date: "2026-09-20" },
  ];
  const all = filterMapAssets(assets, {}, "2026-09-22");
  assert.ok(all.some((a) => a.id === "partner"));
  assert.ok(!all.some((a) => a.id === "nowhere"));
  assert.ok(!all.some((a) => a.visibility === "archive"));
  assert.ok(filterMapAssets(assets, { includeArchived: true }, "2026-09-22").some((a) => a.visibility === "archive"));
  assert.ok(!filterMapAssets(assets, { includePartner: false }, "2026-09-22").some((a) => a.id === "partner"));
  assert.deepEqual(filterMapAssets(assets, { datePreset: "30d" }, "2026-09-22").map((a) => a.id), ["partner"]);
  assert.equal(filterMapAssets(assets, { datePreset: "year" }, "2026-09-22").length, all.length);
  assert.equal(filterMapAssets(assets, { datePreset: "year" }, "2027-01-05").length, 0);
  assert.equal(
    filterMapAssets(assets, { datePreset: "custom", from: "2026-08-15", to: "2026-08-16" }, "2026-09-22").length,
    media.filter((a) => a.date >= "2026-08-15" && a.visibility !== "archive").length,
  );
  assert.ok(filterMapAssets(assets, { onlyFavorites: true }, "2026-09-22").every((a) => a.favorite));
});
