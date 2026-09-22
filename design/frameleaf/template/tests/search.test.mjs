import assert from "node:assert/strict";
import { test } from "node:test";
import {
  descriptionStatus,
  descriptionStatuses,
  normalizeSearchQuery,
  pageSummary,
  paginate,
  resolveSamplePhrase,
  sampleFacets,
  searchChips,
  searchSampleAssets,
  sampleSearchModeDescriptions,
  sensitiveStatus,
  sensitiveStatuses,
  statusLabels,
} from "../src/search.mjs";

const people = [
  { id: "Jamie", name: "Jamie" },
  { id: "Emma", name: "Emma" },
  { id: "Taylor", name: "Taylor" },
];
const tags = [
  { id: "water", label: "Water" },
  { id: "family", label: "Family" },
  { id: "hiking", label: "Hiking" },
  { id: "wildlife", label: "Wildlife" },
];
const options = { people, tags };
const assets = [
  {
    id: "a",
    name: "Lake morning.JPG",
    type: "photo",
    personIds: ["Jamie", "Emma", "Jamie"],
    tagIds: ["water", "family"],
    albumIds: ["family"],
    takenAt: "2026-08-01T13:00:00Z",
    city: "Banff",
    state: "Alberta",
    country: "Canada",
    make: "Canon",
    model: "EOS R6",
    lensModel: "RF 24-70",
    rating: 4,
    favorite: true,
    visibility: "timeline",
    description: "Family by a blue lake",
    ocr: "Permit 123",
    originalPath: "/library/2026/lake.JPG",
  },
  {
    id: "b",
    name: "Forest trail.MOV",
    type: "VIDEO",
    personIds: ["Jamie"],
    tagIds: ["hiking"],
    albumIds: [],
    takenAt: "2026-08-31T23:59:59.999Z",
    city: "Canmore",
    state: "Alberta",
    country: "Canada",
    make: "Sony",
    model: "A7 IV",
    rating: 5,
    isFavorite: false,
    visibility: "archive",
    description: "Jamie hiking in a green forest",
    ocr: "",
    originalPath: "/library/2026/forest.MOV",
  },
  {
    id: "c",
    name: "Paris.jpg",
    type: "IMAGE",
    personIds: ["Emma"],
    tagIds: ["water"],
    albumIds: ["family"],
    takenAt: "2026-09-01T00:00:00Z",
    city: "Paris",
    country: "France",
    make: "Canon",
    model: "EOS R6",
    rating: 2,
    favorite: true,
    visibility: "timeline",
    description: "A red boat on the river",
    ocr: "Café receipt 42",
    originalPath: "/trips/france/paris.jpg",
  },
  {
    id: "d",
    name: "Elk.mp4",
    type: "video",
    personIds: [],
    tagIds: ["wildlife"],
    albumIds: [],
    takenAt: "2026-07-31T23:59:59Z",
    city: "Banff",
    country: "Canada",
    make: "Nikon",
    model: "Z6",
    rating: null,
    favorite: false,
    description: "An elk in a meadow",
    ocr: "",
    originalPath: "/wildlife/elk.mp4",
  },
];
const search = (filter = {}, text = "", extra = {}) =>
  searchSampleAssets(assets, { filter, text }, { ...options, ...extra }).map(
    (asset) => asset.id,
  );

test("people any/all/none are distinct and combine with other structured fields", () => {
  assert.deepEqual(search({ personIds: { any: ["Jamie", "Emma"] } }), [
    "a",
    "b",
    "c",
  ]);
  assert.deepEqual(search({ personIds: { all: ["Jamie", "Emma"] } }), ["a"]);
  assert.deepEqual(search({ personIds: { none: ["Jamie", "Emma"] } }), ["d"]);
  assert.deepEqual(
    search({
      personIds: { any: ["Jamie", "Emma"], none: ["Emma"] },
      type: { eq: "VIDEO" },
      country: { eq: "Canada" },
    }),
    ["b"],
  );
  assert.deepEqual(search({ personIds: { any: [] } }), []);
});

test("tags and albums support any/all/exclude; missing albums and people are explicit filters", () => {
  assert.deepEqual(search({ tagIds: { all: ["water", "family"] } }), ["a"]);
  assert.deepEqual(
    search({
      tagIds: { any: ["hiking", "water"] },
      personIds: { none: ["Emma"] },
    }),
    ["b"],
  );
  assert.deepEqual(search({ tagIds: { none: ["water"] } }), ["b", "d"]);
  assert.deepEqual(search({ albumIds: { any: ["family"] } }), ["a", "c"]);
  assert.deepEqual(
    search({ hasAlbums: { eq: false }, hasPeople: { eq: true } }),
    ["b"],
  );
  assert.deepEqual(search({ hasPeople: { eq: false } }), ["d"]);
});

test("dates include the full upper calendar day and reject invalid dates without widening", () => {
  assert.deepEqual(
    search({ takenAt: { gte: "2026-08-01", lte: "2026-08-31" } }),
    ["a", "b"],
  );
  assert.deepEqual(search({ takenAt: { eq: "2026-08-31" } }), ["b"]);
  assert.deepEqual(search({ takenAt: { lt: "2026-08-01" } }), ["d"]);
  assert.deepEqual(
    search({ takenAt: { gte: "2026-09-01", lte: "2026-08-01" } }),
    [],
  );
  assert.deepEqual(search({ takenAt: { ne: "2026-02-30" } }), []);
});

test("camera, place, exact/minimum ratings and local rating changes compose", () => {
  assert.deepEqual(
    search({
      country: { eq: "Canada" },
      make: { eq: "Canon" },
      model: { eq: "EOS R6" },
      rating: { gte: 4 },
    }),
    ["a"],
  );
  assert.deepEqual(search({ rating: { eq: 4 } }), ["a"]);
  assert.deepEqual(search({ rating: { gte: 4 } }), ["a", "b"]);
  assert.deepEqual(search({ rating: { eq: null } }), ["d"]);
  assert.deepEqual(
    search({ rating: { gte: 5 } }, "", { ratings: { a: 5, b: -1 } }),
    ["a"],
  );
  assert.deepEqual(
    search({ city: { ne: "Banff" }, country: { eq: "Canada" } }),
    ["b"],
  );
});

test("legacy prototype aliases normalize into fork-compatible filter names", () => {
  const query = {
    text: "lake",
    mode: "smart",
    spaceId: "space",
    petIds: ["pet"],
    grouping: "months",
    view: "moments",
    filter: {
      person: { eq: "jamie" },
      type: { eq: "photo" },
      favorite: { eq: true },
      rating: { eq: "4" },
      isArchived: { eq: false },
    },
  };
  const normalized = normalizeSearchQuery(query, options);
  assert.deepEqual(normalized.filter, {
    personIds: { any: ["Jamie"] },
    type: { eq: "IMAGE" },
    isFavorite: { eq: true },
    rating: { gte: 4 },
    visibility: { ne: "archive" },
  });
  assert.equal(normalized.spaceId, "space");
  assert.deepEqual(normalized.petIds, ["pet"]);
  assert.equal(normalized.grouping, "months");
  assert.equal(normalized.view, "moments");
  assert.equal(query.filter.type.eq, "photo");
  assert.deepEqual(
    search({ isArchived: { eq: true }, isFavorite: { eq: false } }),
    ["b"],
  );
  assert.deepEqual(search({ isNotInAlbum: { eq: true } }), ["b", "d"]);
});

test("malformed or unsupported filters fail closed, including negative operators", () => {
  for (const filter of [
    null,
    [],
    { unknown: { ne: "anything" } },
    { type: null },
    { personIds: { none: "Jamie" } },
    { rating: { ne: {} } },
    { city: { notIn: [null] } },
    { isFavorite: { eq: "false" } },
    { or: [] },
  ]) {
    assert.deepEqual(search(filter), []);
  }
  assert.deepEqual(
    search({
      or: [{ city: { eq: "Paris" } }, { rating: { gte: 5 } }],
      hasPeople: { eq: true },
    }),
    ["b", "c"],
  );
});

test("text modes stay confined to their stated sample fields; semantic is metadata-only", () => {
  assert.deepEqual(search({}, "lake", { textMode: "filename" }), ["a"]);
  assert.deepEqual(search({}, "receipt", { textMode: "filename" }), []);
  assert.deepEqual(search({}, "cafe receipt", { textMode: "ocr" }), ["c"]);
  assert.deepEqual(search({}, "Permit", { textMode: "description" }), []);
  assert.deepEqual(search({}, "/trips/france", { textMode: "fullPath" }), [
    "c",
  ]);
  assert.deepEqual(search({}, "a red boat", { textMode: "semantic" }), ["c"]);
  assert.deepEqual(search({}, "Permit", { textMode: "semantic" }), []);
  assert.match(sampleSearchModeDescriptions.semantic, /No embeddings/);
});

test("negative words, quoted phrases and structured filename/description/OCR patterns work", () => {
  assert.deepEqual(search({}, "Canada -forest"), ["a", "d"]);
  assert.deepEqual(search({}, '"blue lake"'), ["a"]);
  assert.deepEqual(
    search({
      originalFileName: { like: "%.MOV" },
      description: { matches: "green -lake" },
    }),
    ["b"],
  );
  assert.deepEqual(search({ ocr: { matches: "receipt -permit" } }), ["c"]);
  assert.deepEqual(
    search({
      originalPath: { startsWith: "/library/" },
      type: { ne: "IMAGE" },
    }),
    ["b"],
  );
});

test("facet counts exclude only their own field and count assets once, not face observations", () => {
  const facets = sampleFacets(
    assets,
    { filter: { personIds: { any: ["Jamie"] }, type: { eq: "VIDEO" } } },
    options,
  );
  assert.deepEqual(
    facets.type.map(({ value, count }) => [value, count]).sort(),
    [
      ["IMAGE", 1],
      ["VIDEO", 1],
    ],
  );
  assert.equal(
    facets.personIds.find((value) => value.value === "Jamie").count,
    1,
  );
  assert.deepEqual(
    facets.city.map((value) => value.value),
    ["Canmore"],
  );
  const allPeople = sampleFacets(assets, { filter: {} }, options).personIds;
  assert.equal(allPeople.find((value) => value.value === "Jamie").count, 2);
});

test("selected zero-match choices survive; unselected unavailable people do not appear", () => {
  const facets = sampleFacets(
    assets,
    { filter: { personIds: { any: ["Taylor"] }, type: { eq: "VIDEO" } } },
    options,
  );
  assert.deepEqual(
    facets.personIds.find((value) => value.value === "Taylor"),
    { value: "Taylor", label: "Taylor", count: 0, selected: true },
  );
  assert.equal(
    facets.personIds.some((value) => value.value === "Emma"),
    false,
  );
  assert.equal(facets.type.find((value) => value.value === "VIDEO").count, 0);
});

test("facet search respects passed scope, text, empty inputs and zero-match boolean options", () => {
  const facets = sampleFacets(
    [assets[0]],
    { text: "lake", filter: {} },
    options,
  );
  assert.deepEqual(
    facets.make.map((value) => value.value),
    ["Canon"],
  );
  assert.equal(
    facets.hasAlbums.find((value) => value.value === "false").count,
    0,
  );
  const empty = sampleFacets(
    [],
    { filter: { city: { eq: "Banff" } } },
    options,
  );
  assert.deepEqual(empty.city, [
    { value: "Banff", label: "Banff", count: 0, selected: true },
  ]);
  assert.deepEqual(empty.personIds, []);
  assert.deepEqual(searchSampleAssets([], { filter: {} }, options), []);
});

test("human chips explain any/all/none and bounds without leaking opaque IDs when labels exist", () => {
  const chips = searchChips(
    {
      filter: {
        personIds: { all: ["Jamie", "Emma"], none: ["Taylor"] },
        tagIds: { any: ["water", "hiking"] },
        rating: { gte: 4 },
        hasAlbums: { eq: false },
        takenAt: { gte: "2026-08-01", lte: "2026-08-31" },
      },
    },
    options,
  );
  assert.match(
    chips.find((chip) => chip.field === "personIds").label,
    /Jamie and Emma; without Taylor/,
  );
  assert.match(
    chips.find((chip) => chip.field === "tagIds").label,
    /Water or Hiking/,
  );
  assert.equal(
    chips.find((chip) => chip.field === "rating").label,
    "Rating: 4 stars or more",
  );
  assert.equal(
    chips.find((chip) => chip.field === "hasAlbums").label,
    "Not in an album",
  );
  assert.match(
    chips.find((chip) => chip.field === "takenAt").label,
    /Aug 1, 2026/,
  );
});

const resolverOptions = {
  people,
  places: [
    { city: "Banff", state: "Alberta", country: "Canada" },
    { city: "Paris", country: "France" },
  ],
  now: "2026-09-19T12:00:00Z",
};
test("phrase resolver emits editable sample people/date/type/place constraints and leaves descriptive words", () => {
  const result = resolveSamplePhrase(
    "Show me photos of Jamie and Emma in Banff during August 2026 blue lake",
    resolverOptions,
  );
  assert.deepEqual(result.query.filter.personIds, { all: ["Jamie", "Emma"] });
  assert.deepEqual(result.query.filter.type, { eq: "IMAGE" });
  assert.deepEqual(result.query.filter.city, { eq: "Banff" });
  assert.deepEqual(result.query.filter.takenAt, {
    gte: "2026-08-01T00:00:00.000Z",
    lt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(result.query.text, "blue lake");
  assert.deepEqual(
    searchSampleAssets(assets, result.query, options).map((asset) => asset.id),
    ["a"],
  );
  assert.ok(
    result.recognized.every((item) => item.field && item.phrase && item.value),
  );
  assert.match(result.explanation, /no AI or server request/i);
});

test("phrase resolver preserves exclusions, any-person intent and deterministic relative dates", () => {
  const result = resolveSamplePhrase(
    "Jamie or Emma without Taylor not videos last month",
    resolverOptions,
  );
  assert.deepEqual(result.query.filter.personIds, {
    any: ["Jamie", "Emma"],
    none: ["Taylor"],
  });
  assert.deepEqual(result.query.filter.type, { ne: "VIDEO" });
  assert.deepEqual(result.query.filter.takenAt, {
    gte: "2026-08-01T00:00:00.000Z",
    lt: "2026-09-01T00:00:00.000Z",
  });
  assert.equal(result.query.text, "");
});

test("date phrases respect inclusive ranges and single-day source boundaries", () => {
  const ranged = resolveSamplePhrase(
    "videos from 2026-08-01 through 2026-08-31",
    resolverOptions,
  );
  assert.deepEqual(
    searchSampleAssets(assets, ranged.query, options).map((asset) => asset.id),
    ["b"],
  );
  const day = resolveSamplePhrase("photos on 2026-09-01", resolverOptions);
  assert.deepEqual(
    searchSampleAssets(assets, day.query, options).map((asset) => asset.id),
    ["c"],
  );
  const invalid = resolveSamplePhrase("photos on 2026-02-30", resolverOptions);
  assert.equal(invalid.query.filter.takenAt, undefined);
  assert.match(invalid.query.text, /2026-02-30/);
});

test("unrecognized text and Unicode outside recognized phrases are retained rather than invented", () => {
  const unknown = resolveSamplePhrase(
    "astronauts dancing on Mars",
    resolverOptions,
  );
  assert.deepEqual(unknown.query.filter, {});
  assert.equal(unknown.query.text, "astronauts dancing on Mars");
  const unicode = resolveSamplePhrase(
    "🌲 photos of Jamie in Banff",
    resolverOptions,
  );
  assert.equal(unicode.query.text, "🌲");
  assert.deepEqual(unicode.query.filter.personIds, { all: ["Jamie"] });
});

const enriched = [
  {
    id: "gen",
    description: "A turquoise lake",
    enrichment: {
      description: { status: "generated", model: "local" },
      sensitive: { status: "reviewed", score: 0.02 },
    },
  },
  {
    id: "manual",
    description: "Our campsite",
    enrichment: {
      description: { status: "manual" },
      sensitive: { status: "needs-review", score: 0.61 },
    },
  },
  {
    id: "missing",
    description: "",
    enrichment: { sensitive: { status: "overridden", score: 0.4 } },
  },
  {
    id: "failed",
    description: "",
    enrichment: {
      description: { status: "failed" },
      sensitive: { status: "needs_review" },
    },
  },
  { id: "plain", description: "Typed by hand" },
];
const enrichedSearch = (filter) =>
  searchSampleAssets(enriched, { filter, text: "" }).map((asset) => asset.id);

test("description and sensitivity status derive from enrichment and fail closed on unknown values", () => {
  assert.equal(descriptionStatus(enriched[0]), "generated");
  assert.equal(descriptionStatus(enriched[1]), "manual");
  assert.equal(descriptionStatus(enriched[2]), "missing");
  assert.equal(descriptionStatus(enriched[3]), "failed");
  assert.equal(descriptionStatus(enriched[4]), "manual");
  assert.equal(sensitiveStatus(enriched[3]), "needs-review");
  assert.equal(sensitiveStatus(enriched[4]), null);
  assert.deepEqual(enrichedSearch({ descriptionStatus: { eq: "missing" } }), [
    "missing",
  ]);
  assert.deepEqual(enrichedSearch({ descriptionStatus: { eq: "failed" } }), [
    "failed",
  ]);
  assert.deepEqual(
    enrichedSearch({ descriptionStatus: { in: ["generated", "manual"] } }),
    ["gen", "manual", "plain"],
  );
  assert.deepEqual(
    enrichedSearch({ sensitiveStatus: { eq: "needs-review" } }),
    ["manual", "failed"],
  );
  // Like other metadata, an asset with no review record is "not reviewed".
  assert.deepEqual(enrichedSearch({ sensitiveStatus: { ne: "reviewed" } }), [
    "manual",
    "missing",
    "failed",
    "plain",
  ]);
  assert.deepEqual(enrichedSearch({ sensitiveStatus: { eq: "unknown" } }), []);
  assert.deepEqual(enrichedSearch({ descriptionStatus: { eq: true } }), []);
  assert.deepEqual(descriptionStatuses, [
    "generated",
    "manual",
    "missing",
    "failed",
  ]);
  assert.deepEqual(sensitiveStatuses, ["reviewed", "needs-review", "overridden"]);
});

test("enrichment facets list the full vocabulary in a fixed order with readable chips", () => {
  const facets = sampleFacets(enriched, { filter: {} }, options);
  assert.deepEqual(
    facets.descriptionStatus.map(({ value, count }) => [value, count]),
    [
      ["generated", 1],
      ["manual", 2],
      ["missing", 1],
      ["failed", 1],
    ],
  );
  assert.deepEqual(
    facets.sensitiveStatus.map(({ value, label, count }) => [
      value,
      label,
      count,
    ]),
    [
      ["reviewed", "Reviewed", 1],
      ["needs-review", "Needs review", 2],
      ["overridden", "Overridden", 1],
    ],
  );
  const chips = searchChips(
    {
      filter: {
        descriptionStatus: { eq: "missing" },
        sensitiveStatus: { eq: "needs-review" },
      },
    },
    options,
  );
  assert.deepEqual(
    chips.map((chip) => chip.label),
    ["Description: No description", "Sensitivity: Needs review"],
  );
  assert.equal(statusLabels.descriptionStatus.failed, "Generation failed");
});

test("pagination clamps pages, exposes cumulative slices and summarizes in plain words", () => {
  const items = Array.from({ length: 130 }, (_, index) => index);
  const first = paginate(items, 1, 60);
  assert.deepEqual(
    [first.start, first.end, first.total, first.pageCount, first.hasMore],
    [1, 60, 130, 3, true],
  );
  assert.equal(first.items.length, 60);
  assert.equal(first.visible.length, 60);
  const last = paginate(items, 9, 60);
  assert.deepEqual([last.page, last.start, last.end, last.hasMore], [3, 121, 130, false]);
  assert.equal(last.items.length, 10);
  assert.equal(last.visible.length, 130);
  assert.equal(last.remaining, 0);
  assert.equal(pageSummary(first), "Showing 1–60 of 130 items");
  assert.equal(
    pageSummary(paginate(items, 2, 60), { cumulative: true, noun: "photos" }),
    "Showing 120 of 130 photos",
  );
  assert.equal(pageSummary(last), "Showing all 130 items");
  assert.equal(pageSummary(paginate([], 1, 60)), "No items");
  assert.equal(
    pageSummary(paginate([1], 1, 60), { noun: "results" }),
    "Showing all 1 result",
  );
  const weird = paginate("not-a-list", 0, -5);
  assert.deepEqual([weird.total, weird.page, weird.pageSize, weird.start], [0, 1, 60, 0]);
  assert.equal(paginate(items, 1.5, 0).items.length, 60);
});
