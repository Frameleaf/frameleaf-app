import test from "node:test";
import assert from "node:assert/strict";
import {
  captureDate,
  localCaptureTime,
  chronologicalAssets,
  timelineGroups,
  timelineMonths,
  exploreSections,
} from "../src/explore-timeline.mjs";
import { media, people } from "../src/media.js";
import { searchSampleAssets } from "../src/search.mjs";

test("capture calendar dates retain source timezone and reject rollover dates", () => {
  assert.equal(
    captureDate({ takenAt: "2026-01-01T00:15:00+14:00" }).day,
    "2026-01-01",
  );
  assert.equal(captureDate({ date: "2026-08-9" }).day, "2026-08-09");
  assert.equal(captureDate({ date: "2026-02-29" }), null);
  assert.equal(captureDate({ date: "2024-02-29" }).day, "2024-02-29");
  for (const date of ["bad", "2026-13-01", "2026-01-00", "0000-01-01"])
    assert.equal(captureDate({ date }), null);
  assert.equal(localCaptureTime({ takenAt: "2026-01-01T23:54:00Z" }), "23:54");
  assert.equal(localCaptureTime({ takenAt: "2026-01-01T25:99:00Z" }), null);
});
test("date groups and month index reconcile across years, with undated records last", () => {
  const assets = [
    { id: "a", date: "2025-12-31" },
    { id: "b", date: "2026-01-01" },
    { id: "c", date: "2026-01-01" },
    { id: "d", date: "invalid" },
  ];
  assert.deepEqual(
    timelineGroups(assets).map((x) => [x.id, x.assets.length]),
    [
      ["2026-01-01", 2],
      ["2025-12-31", 1],
      ["undated", 1],
    ],
  );
  assert.deepEqual(
    timelineGroups(assets, "months").map((x) => x.id),
    ["2026-01", "2025-12", "undated"],
  );
  assert.deepEqual(
    timelineGroups(assets, "years").map((x) => x.id),
    ["2026", "2025", "undated"],
  );
  assert.equal(timelineGroups(assets, "all")[0].assets.length, 4);
  assert.deepEqual(
    timelineMonths(assets).map((x) => [x.id, x.count, x.firstAssetId]),
    [
      ["2026-01", 2, "b"],
      ["2025-12", 1, "a"],
    ],
  );
  assert.deepEqual(
    chronologicalAssets(assets, "asc").map((x) => x.id),
    ["a", "b", "c", "d"],
  );
  assert.equal(assets[0].id, "a");
});
test("Explore only derives supplied scope and never introduces absent or hidden people", () => {
  const scoped = media.filter((a) => a.personIds.includes("Emma"));
  const output = exploreSections(
    scoped,
    [...people, { id: "absent", name: "Absent" }].map((p) =>
      p.id === "Taylor" ? { ...p, isHidden: true } : p,
    ),
  );
  assert.ok(output.assets.every((a) => scoped.includes(a)));
  assert.deepEqual(output.people.map((p) => p.id).sort(), ["Emma", "Jamie"]);
  for (const row of [...output.places, ...output.things, ...output.collections])
    assert.ok(scoped.includes(row.cover));
  assert.equal(output.people.find((p) => p.id === "Emma").count, scoped.length);
});
test("every Explore filter card count matches the actual sample query engine", () => {
  const output = exploreSections(media, people);
  for (const row of [
    ...output.people,
    ...output.places,
    ...output.things,
    ...output.shortcuts,
  ]) {
    assert.equal(
      searchSampleAssets(media, row.query).length,
      row.count,
      row.label,
    );
  }
  for (const memory of output.memories) {
    assert.deepEqual(
      new Set(searchSampleAssets(media, memory.query).map((x) => x.id)),
      new Set(memory.assets.map((x) => x.id)),
    );
  }
});
test("date-derived memories use exclusive next-day boundaries across December", () => {
  const output = exploreSections([
    {
      id: "end",
      date: "2026-12-31",
      takenAt: "2026-12-31T23:58:00",
      type: "IMAGE",
    },
  ]);
  assert.deepEqual(output.memories[0].query.filter.takenAt, {
    gte: "2026-12-31T00:00:00",
    lt: "2027-01-01T00:00:00",
  });
});
test("duplicates do not inflate Explore counts or mutate caller lists", () => {
  const asset = {
    ...media[0],
    tagIds: ["lake", "lake"],
    personIds: ["Jamie", "Jamie"],
  };
  const output = exploreSections([asset, asset], people);
  assert.equal(output.assets.length, 1);
  assert.equal(output.people[0].count, 1);
  assert.equal(output.things[0].count, 1);
  assert.deepEqual(asset.tagIds, ["lake", "lake"]);
});
test("empty and undated scopes do not fabricate people, places or memories", () => {
  const empty = exploreSections([], people);
  for (const key of [
    "assets",
    "people",
    "places",
    "things",
    "collections",
    "memories",
    "best",
  ])
    assert.deepEqual(empty[key], []);
  assert.ok(empty.shortcuts.every((x) => x.count === 0));
  assert.equal(
    exploreSections([{ id: "unknown", type: "VIDEO" }]).memories.length,
    0,
  );
  assert.deepEqual(timelineMonths([]), []);
});

test("Best Photos uses supplied quality scores independently from manual ratings", () => {
  const assets = [
    { id: "rated", rating: 5, bestPhotosScore: 70 },
    { id: "quality", rating: 0, bestPhotosScore: 95 },
    { id: "unscored", rating: 5 },
    { id: "best", rating: 1, bestPhotosScore: 99 },
  ];
  const result = exploreSections(assets);
  assert.equal(result.hasQualityScores, true);
  assert.deepEqual(
    result.best.map((x) => x.id),
    ["best", "quality"],
  );
  const fallback = exploreSections([
    { id: "low", rating: 3 },
    { id: "rated", rating: 5 },
  ]);
  assert.equal(fallback.hasQualityScores, false);
  assert.deepEqual(
    fallback.best.map((x) => x.id),
    ["rated"],
  );
});

test("scrubber positions months and years in proportion to their item counts", async () => {
  const { assetMonthId, scrubberMonthAt, timelineScrubber } = await import(
    "../src/explore-timeline.mjs"
  );
  const assets = [
    { id: "a", date: "2026-03-01" },
    { id: "b", date: "2026-03-02" },
    { id: "c", date: "2026-03-03" },
    { id: "d", date: "2025-12-01" },
    { id: "e", date: "bad" },
  ];
  const model = timelineScrubber(assets);
  assert.equal(model.total, 4, "undated items are not on the track");
  assert.deepEqual(
    model.months.map((m) => [m.id, m.start, m.end, m.firstAssetId]),
    [
      ["2026-03", 0, 0.75, "c"],
      ["2025-12", 0.75, 1, "d"],
    ],
  );
  assert.deepEqual(
    model.years.map((y) => [y.year, y.start, y.end, y.count]),
    [
      ["2026", 0, 0.75, 3],
      ["2025", 0.75, 1, 1],
    ],
  );
  assert.equal(model.years[0].center, 0.375);
  assert.equal(scrubberMonthAt(model, 0.2).id, "2026-03");
  assert.equal(scrubberMonthAt(model, 0.75).id, "2025-12");
  assert.equal(scrubberMonthAt(model, 1).id, "2025-12", "end of track clamps to the last month");
  assert.equal(scrubberMonthAt(model, -4).id, "2026-03");
  assert.equal(scrubberMonthAt(model, Number.NaN).id, "2026-03");
  assert.equal(scrubberMonthAt(timelineScrubber([]), 0.5), null);
  assert.equal(timelineScrubber([]).total, 0);
  assert.equal(assetMonthId(assets[0]), "2026-03");
  assert.equal(assetMonthId(assets[4]), null);
  const ascending = timelineScrubber(assets, "asc");
  assert.equal(ascending.months[0].id, "2025-12");
  assert.equal(ascending.months[0].firstAssetId, "d");
});
