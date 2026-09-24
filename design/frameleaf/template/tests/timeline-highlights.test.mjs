import test from "node:test";
import assert from "node:assert/strict";
import {
  compareKeyAssets,
  drillTarget,
  firstGroupWithPrefix,
  keyAsset,
  keyAssets,
  placeSummary,
  timelineCards,
  topPlaces,
} from "../src/timeline-highlights.mjs";
import { timelineGroups } from "../src/explore-timeline.mjs";
import { media } from "../src/media.js";

// Synthetic library spanning four years, several months, and undated items.
const cities = ["Banff", "Jasper", "Lisbon", "Kyoto"];
const library = [];
for (const year of [2023, 2024, 2025, 2026])
  for (const month of [1, 4, 8, 12])
    for (let day = 1; day <= 5; day++) {
      const index = library.length;
      library.push({
        id: `${year}-${month}-${day}`,
        takenAt: `${year}-${String(month).padStart(2, "0")}-${String(day * 5).padStart(2, "0")}T0${day}:00:00`,
        image: `/media/${index}.png`,
        city: cities[(index + (day === 1 ? 0 : 1)) % cities.length],
        ...(day === 3 ? { bestPhotosScore: 50 + (index % 40) } : {}),
        ...(day === 4 ? { rating: 5 } : {}),
      });
    }
library.push(
  { id: "undated-a", image: "/media/u.png", country: "Canada" },
  { id: "undated-b", image: "/media/v.png" },
);

test("key photo prefers best-photos score, then rating, then recency", () => {
  const scored = { id: "s", date: "2020-01-01", bestPhotosScore: 70 };
  const better = { id: "b", date: "2020-01-01", bestPhotosScore: 95 };
  const rated = { id: "r", date: "2026-01-01", rating: 5 };
  const lowRated = { id: "l", date: "2026-06-01", rating: 2 };
  const recent = { id: "n", date: "2026-09-01" };
  const old = { id: "o", date: "2019-09-01" };
  const all = [old, recent, lowRated, rated, scored, better];
  assert.deepEqual(
    keyAssets(all, 6).map((asset) => asset.id),
    ["b", "s", "r", "l", "n", "o"],
  );
  assert.equal(keyAsset([old, recent]).id, "n");
  assert.equal(keyAsset([recent, rated]).id, "r");
  // Recency compares the local capture time within a day, then id.
  assert.equal(
    keyAsset([
      { id: "early", takenAt: "2026-01-01T06:00:00" },
      { id: "late", takenAt: "2026-01-01T19:30:00" },
    ]).id,
    "late",
  );
  assert.equal(
    compareKeyAssets(
      { id: "a", date: "2026-01-01" },
      { id: "b", date: "2026-01-01" },
    ) < 0,
    true,
  );
  assert.equal(keyAsset([]), null);
  assert.deepEqual(keyAssets([null, { id: 3 }, { id: "x" }], 5), [{ id: "x" }]);
});

test("the sample library picks its highest scoring photo", () => {
  const best = Math.max(...media.map((asset) => asset.bestPhotosScore));
  assert.equal(keyAsset(media).bestPhotosScore, best);
});

test("places are counted, ranked and summarised", () => {
  const places = topPlaces([
    { city: "Banff" },
    { city: "Jasper" },
    { city: "Banff" },
    { city: " ", state: "Alberta" },
    { country: "Canada" },
    { city: "Jasper" },
    {},
  ]);
  assert.deepEqual(places, ["Banff", "Jasper", "Alberta"]);
  assert.equal(placeSummary(places), "Banff, Jasper and Alberta");
  assert.equal(placeSummary(["Kyoto", "Lisbon"]), "Kyoto and Lisbon");
  assert.equal(placeSummary(["Kyoto"]), "Kyoto");
  assert.equal(placeSummary([]), "");
});

test("year cards cover a multi-year library in timeline order", () => {
  const cards = timelineCards(library, "years");
  assert.deepEqual(
    cards.map((card) => card.id),
    ["2026", "2025", "2024", "2023", "undated"],
  );
  const groups = timelineGroups(library, "year");
  cards.forEach((card, index) => {
    assert.equal(card.kind, "year");
    assert.equal(card.count, groups[index].assets.length);
    assert.equal(card.firstAssetId, groups[index].assets[0].id);
    assert.deepEqual(card.highlights, []);
    assert.equal(card.key.id, keyAsset(groups[index].assets).id);
  });
  assert.equal(cards[0].count, 20);
  assert.equal(cards[0].title, "2026");
  assert.equal(cards[0].year, "2026");
  // Scored photos win over rated ones inside each year.
  for (const card of cards.slice(0, 4))
    assert.ok(Number.isFinite(card.key.bestPhotosScore));
  assert.ok(cards[0].places.length > 0 && cards[0].places.length <= 3);
  assert.equal(cards[0].placeLabel, placeSummary(cards[0].places));
  const undated = cards.at(-1);
  assert.equal(undated.title, "Date unknown");
  assert.equal(undated.year, null);
  assert.equal(undated.count, 2);
  assert.deepEqual(undated.places, ["Canada"]);
});

test("month cards carry a key photo and up to four highlights", () => {
  const cards = timelineCards(library, "months");
  assert.equal(cards.length, 17);
  assert.equal(cards[0].id, "2026-12");
  assert.equal(cards[0].title, "December 2026");
  assert.equal(cards[0].year, "2026");
  for (const card of cards.slice(0, -1)) {
    assert.equal(card.kind, "month");
    assert.equal(card.count, 5);
    assert.equal(card.highlights.length, 4);
    // The key photo is the scored one and is not repeated in the strip.
    assert.ok(Number.isFinite(card.key.bestPhotosScore));
    assert.ok(!card.highlights.some((asset) => asset.id === card.key.id));
    // Highlights run in capture order (newest first for the default order).
    const times = card.highlights.map((asset) => asset.takenAt);
    assert.deepEqual(times, [...times].sort().reverse());
  }
  assert.equal(
    timelineCards(library, "months", { highlightCount: 2 })[0].highlights
      .length,
    2,
  );
  const ascending = timelineCards(library, "months", { order: "asc" });
  assert.equal(ascending[0].id, "2023-01");
  const times = ascending[0].highlights.map((asset) => asset.takenAt);
  assert.deepEqual(times, [...times].sort());
  // A month with a single item has a key photo and no highlights.
  const single = timelineCards([{ id: "only", date: "2022-02-02" }], "months");
  assert.equal(single[0].key.id, "only");
  assert.deepEqual(single[0].highlights, []);
  assert.deepEqual(timelineCards([], "months"), []);
});

test("opening a card steps one level finer at that period", () => {
  const [year] = timelineCards(library, "years");
  assert.deepEqual(drillTarget(year), {
    grouping: "months",
    groupPrefix: "2026",
  });
  const months = timelineCards(library, "months").map((card) => card.id);
  assert.equal(firstGroupWithPrefix(months, "2025"), "2025-12");
  const [, month] = timelineCards(library, "months");
  assert.deepEqual(drillTarget(month), {
    grouping: "days",
    groupPrefix: "2026-08",
  });
  const days = timelineGroups(library, "day").map((group) => group.id);
  assert.equal(firstGroupWithPrefix(days, "2026-08"), "2026-08-25");
  assert.equal(firstGroupWithPrefix(days, "undated"), "undated");
  assert.equal(firstGroupWithPrefix(days, "2019"), null);
  assert.equal(firstGroupWithPrefix(days, ""), null);
  // "2026-0" must not match "2026-08": prefixes stop at a separator.
  assert.equal(firstGroupWithPrefix(["2026-08-01"], "2026-0"), null);
  assert.equal(drillTarget(null), null);
});
