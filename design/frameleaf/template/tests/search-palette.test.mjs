import assert from "node:assert/strict";
import { test } from "node:test";
import {
  dateHistogram,
  parseSearchInput,
  removeSearchToken,
  suggestSearchTokens,
} from "../src/search-palette.mjs";
import { searchSampleAssets } from "../src/search.mjs";

const catalog = {
  people: [
    { id: "p-jamie", name: "Jamie", count: 6 },
    { id: "p-emma", name: "Emma", count: 4 },
  ],
  tags: [{ id: "water", label: "Water", count: 3 }],
  places: [
    { value: "Banff", count: 8 },
    { value: "Lake Louise", count: 7 },
  ].map((place) => place.value),
  makes: ["Apple", "Sony"],
  models: ["iPhone 16 Pro", "α7 IV"],
};

test("operators compile to engine filters and leave free text", () => {
  const parsed = parseSearchInput(
    'sunrise person:jamie -person:Emma place:"lake louise" type:video rating:4 is:fav year:2026',
    catalog,
  );
  assert.equal(parsed.text, "sunrise");
  assert.deepEqual(parsed.filter.personIds, {
    all: ["p-jamie"],
    none: ["p-emma"],
  });
  assert.deepEqual(parsed.filter.city, { eq: "Lake Louise" });
  assert.deepEqual(parsed.filter.type, { eq: "VIDEO" });
  assert.deepEqual(parsed.filter.rating, { gte: 4 });
  assert.deepEqual(parsed.filter.isFavorite, { eq: true });
  assert.deepEqual(parsed.filter.takenAt, {
    gte: "2026-01-01T00:00:00.000Z",
    lt: "2027-01-01T00:00:00.000Z",
  });
  assert.equal(parsed.tokens.length, 7);
  assert.equal(parsed.tokens[1].label, "Not Emma");
});

test("unknown people, bad values and unknown operators stay as text", () => {
  const parsed = parseSearchInput(
    "person:Nobody rating:9 color:red month:2026-13",
    catalog,
  );
  assert.deepEqual(parsed.filter, {});
  assert.equal(parsed.text, "person:Nobody rating:9 color:red month:2026-13");
});

test("camera resolves make before model, then falls back to a contains match", () => {
  assert.deepEqual(parseSearchInput("camera:sony", catalog).filter.make, {
    eq: "Sony",
  });
  assert.deepEqual(parseSearchInput("camera:iphone", catalog).filter.model, {
    eq: "iPhone 16 Pro",
  });
  assert.deepEqual(parseSearchInput("camera:leica", catalog).filter.make, {
    like: "%leica%",
  });
});

test("date operators combine into one range", () => {
  const { filter } = parseSearchInput(
    "after:2026-08-12 before:2026-08-15",
    catalog,
  );
  assert.deepEqual(filter.takenAt, {
    gte: "2026-08-13T00:00:00.000Z",
    lt: "2026-08-15T00:00:00.000Z",
  });
  assert.deepEqual(parseSearchInput("month:2026-08", catalog).filter.takenAt, {
    gte: "2026-08-01T00:00:00.000Z",
    lt: "2026-09-01T00:00:00.000Z",
  });
});

test("parsed filters run through the sample search engine", () => {
  const assets = [
    {
      id: "a",
      name: "a.jpg",
      type: "photo",
      personIds: ["p-jamie"],
      city: "Banff",
      takenAt: "2026-08-12T10:00:00Z",
    },
    {
      id: "b",
      name: "b.mov",
      type: "video",
      personIds: ["p-emma"],
      city: "Banff",
      takenAt: "2026-08-14T10:00:00Z",
    },
  ];
  const { filter, text } = parseSearchInput(
    "person:Jamie place:Banff",
    catalog,
  );
  const results = searchSampleAssets(
    assets,
    { text, filter },
    { people: catalog.people },
  );
  assert.deepEqual(
    results.map((asset) => asset.id),
    ["a"],
  );
});

test("removeSearchToken deletes only the chosen token", () => {
  assert.equal(
    removeSearchToken("lake person:Jamie type:video", "person:Jamie"),
    "lake type:video",
  );
});

test("suggestions complete names and operator values", () => {
  const people = catalog.people;
  const byName = suggestSearchTokens("hiking ja", { ...catalog, people });
  assert.equal(byName[0].detail, "person:Jamie");
  assert.equal(byName[0].insert, "hiking person:Jamie ");
  const scoped = suggestSearchTokens("place:la", catalog);
  assert.deepEqual(
    scoped.map((item) => item.detail),
    ['place:"Lake Louise"'],
  );
  const operators = suggestSearchTokens("cam", catalog);
  assert.ok(
    operators.some(
      (item) => item.kind === "operator" && item.insert === "camera:",
    ),
  );
  assert.ok(
    suggestSearchTokens("-emm", catalog)[0].insert.startsWith("-person:Emma"),
  );
  assert.deepEqual(suggestSearchTokens("", catalog), []);
});

test("histogram picks a granularity and keeps empty buckets", () => {
  const days = dateHistogram([
    { takenAt: "2026-08-12T10:00:00Z" },
    { takenAt: "2026-08-14T09:00:00Z" },
    { takenAt: "2026-08-14T11:00:00Z" },
  ]);
  assert.equal(days.unit, "day");
  assert.deepEqual(
    days.buckets.map((bucket) => bucket.count),
    [1, 0, 2],
  );
  assert.equal(days.buckets[0].start, "2026-08-12T00:00:00.000Z");
  assert.equal(days.buckets[0].end, "2026-08-13T00:00:00.000Z");
  const years = dateHistogram([
    { takenAt: "2019-03-01T00:00:00Z" },
    { takenAt: "2026-01-01T00:00:00Z" },
  ]);
  assert.equal(years.unit, "year");
  assert.equal(years.buckets.length, 8);
  assert.deepEqual(dateHistogram([]), { unit: null, buckets: [] });
});

test("typed person suggestions skip unnamed people, who have no name to type", () => {
  const people = [
    { id: "p1", name: "Jamie", count: 6 },
    { id: "cluster-unnamed-1", name: "", count: 4 },
  ];
  assert.deepEqual(
    suggestSearchTokens("person:", { people }).map((item) => item.label),
    ["Jamie"],
  );
});
