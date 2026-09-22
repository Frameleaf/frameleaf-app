import assert from "node:assert/strict";
import { test } from "node:test";
import {
  captureDateControlValue,
  captureDateHasCustomCondition,
  customConditionValue,
  equalityControlValue,
  flagToggleActive,
  moveSetGroup,
  ratingConditionForValue,
  ratingControlValue,
  statusConditionForValue,
  statusControlValue,
  toggleFlagCondition,
  updateCaptureDate,
  updateSetGroup,
} from "../src/filter-state.mjs";
import {
  descriptionStatuses,
  resolveSamplePhrase,
  searchSampleAssets,
  sensitiveStatuses,
} from "../src/search.mjs";

const assets = [
  {
    id: "both",
    personIds: ["Jamie", "Emma"],
    tagIds: ["family", "lake"],
    rating: 4,
    takenAt: "2026-08-03T12:00:00Z",
  },
  {
    id: "jamie",
    personIds: ["Jamie"],
    tagIds: ["family"],
    rating: 5,
    takenAt: "2026-08-31T23:59:59.999Z",
  },
  {
    id: "excluded",
    personIds: ["Jamie", "Emma", "Taylor"],
    tagIds: ["family", "lake", "private"],
    rating: null,
    takenAt: "2026-09-01T00:00:00Z",
  },
  {
    id: "none",
    personIds: [],
    tagIds: [],
    rating: 0,
    takenAt: "2026-08-01T12:00:00Z",
  },
];
const matches = (filter) =>
  searchSampleAssets(assets, { filter, text: "" }).map((asset) => asset.id);

test("checkbox changes keep other person/tag groups and their exclusions active", () => {
  const initial = { any: ["Jamie"], none: ["Taylor"] };
  const next = updateSetGroup(initial, "all", ["Emma"]);
  assert.deepEqual(matches({ personIds: next }), ["both"]);
  assert.deepEqual(initial, { any: ["Jamie"], none: ["Taylor"] });
  assert.deepEqual(matches({ personIds: updateSetGroup(next, "all", []) }), [
    "both",
    "jamie",
  ]);
  assert.deepEqual(
    matches({
      tagIds: updateSetGroup({ any: ["family"], none: ["private"] }, "all", [
        "lake",
      ]),
    }),
    ["both"],
  );
  assert.deepEqual(
    updateSetGroup({ all: ["Emma"], none: ["Taylor"] }, "all", []),
    { none: ["Taylor"] },
  );
  assert.equal(updateSetGroup({ none: ["Taylor"] }, "none", []), null);
});

test("matching changes move only the active group, merging its destination", () => {
  const initial = { all: ["Jamie", "Emma"], none: ["Taylor"] };
  const any = moveSetGroup(initial, "all", "any");
  assert.deepEqual(matches({ personIds: initial }), ["both"]);
  assert.deepEqual(matches({ personIds: any }), ["both", "jamie"]);
  const excluded = moveSetGroup(any, "any", "none");
  assert.deepEqual(excluded, { none: ["Taylor", "Jamie", "Emma"] });
  assert.deepEqual(matches({ personIds: excluded }), ["none"]);
  const merged = moveSetGroup(
    { any: ["Jamie"], all: ["Emma", "Jamie"], none: ["Taylor"] },
    "any",
    "all",
  );
  assert.deepEqual(merged, { all: ["Emma", "Jamie"], none: ["Taylor"] });
  assert.deepEqual(initial, { all: ["Jamie", "Emma"], none: ["Taylor"] });
  assert.deepEqual(moveSetGroup({ none: ["Taylor"] }, "any", "all"), {
    none: ["Taylor"],
  });
});

test("editing From preserves a resolved month's exclusive upper boundary", () => {
  const resolved = resolveSamplePhrase("August 2026").query.filter.takenAt;
  assert.equal(captureDateControlValue(resolved, "gte"), "2026-08-01");
  assert.equal(captureDateControlValue(resolved, "lte"), "2026-08-31");
  const next = updateCaptureDate(resolved, "gte", "2026-08-02");
  assert.equal(next.lt, resolved.lt);
  assert.deepEqual(matches({ takenAt: next }), ["both", "jamie"]);
  assert.deepEqual(matches({ takenAt: updateCaptureDate(next, "gte", "") }), [
    "both",
    "jamie",
    "none",
  ]);
  assert.equal(captureDateHasCustomCondition(resolved), false);
});

test("editing or clearing Through intentionally replaces only the upper boundary", () => {
  const initial = {
    gte: "2026-08-02",
    lt: "2026-09-01T00:00:00.000Z",
    ne: "2026-08-05",
  };
  const next = updateCaptureDate(initial, "lte", "2026-08-03");
  assert.deepEqual(next, {
    gte: "2026-08-02",
    ne: "2026-08-05",
    lte: "2026-08-03",
  });
  assert.deepEqual(matches({ takenAt: next }), ["both"]);
  assert.deepEqual(updateCaptureDate(initial, "lte", ""), {
    gte: "2026-08-02",
    ne: "2026-08-05",
  });
  assert.equal(updateCaptureDate({ lt: "2026-09-01" }, "lte", ""), null);
  assert.equal(initial.lt, "2026-09-01T00:00:00.000Z");
  assert.equal(updateCaptureDate(initial, "gte", "2026-02-30"), initial);
});

test("exclusive date display handles leap days and flags intraday/custom conditions", () => {
  assert.equal(
    captureDateControlValue({ lt: "2024-03-01T00:00:00Z" }, "lte"),
    "2024-02-29",
  );
  assert.equal(
    captureDateControlValue({ lt: "2026-01-01" }, "lte"),
    "2025-12-31",
  );
  assert.equal(
    captureDateControlValue({ lt: "2026-08-03T12:00:00Z" }, "lte"),
    "2026-08-03",
  );
  assert.equal(
    captureDateHasCustomCondition({ lt: "2026-08-03T12:00:00Z" }),
    true,
  );
  assert.equal(
    captureDateHasCustomCondition({ lte: "2026-08-03T00:00:00Z" }),
    true,
  );
  assert.equal(captureDateHasCustomCondition({ eq: "2026-08-03" }), true);
  assert.equal(
    captureDateHasCustomCondition({ lt: "2026-08-03", lte: "2026-08-01" }),
    true,
  );
  assert.equal(captureDateControlValue({ lt: "not-a-date" }, "lte"), "");
});

test("simple controls distinguish custom negatives/ranges from Any and exact values", () => {
  assert.equal(equalityControlValue(undefined), "");
  assert.equal(equalityControlValue({}), "");
  assert.equal(equalityControlValue({ eq: "Banff" }), "Banff");
  for (const condition of [
    { ne: "Banff" },
    { eq: "Banff", ne: "Jasper" },
    { in: ["Banff"] },
    { eq: null },
  ]) {
    assert.equal(equalityControlValue(condition), customConditionValue);
  }
  const mediaType = (value) => ["IMAGE", "VIDEO"].includes(value);
  assert.equal(equalityControlValue({ eq: "VIDEO" }, mediaType), "VIDEO");
  assert.equal(
    equalityControlValue({ ne: "VIDEO" }, mediaType),
    customConditionValue,
  );
  assert.equal(
    equalityControlValue({ eq: false }, (value) => typeof value === "boolean"),
    "false",
  );
  assert.equal(
    equalityControlValue({ ne: true }, (value) => typeof value === "boolean"),
    customConditionValue,
  );
});

test("rating choices round-trip exact/minimum/null/zero without changing their result sets", () => {
  for (const value of [
    "",
    "null",
    "-1",
    "0",
    "1",
    "2",
    "3",
    "4",
    "5",
    "min0",
    "min1",
    "min2",
    "min3",
    "min4",
    "min5",
  ]) {
    assert.equal(ratingControlValue(ratingConditionForValue(value)), value);
  }
  assert.deepEqual(matches({ rating: ratingConditionForValue("4") }), ["both"]);
  assert.deepEqual(matches({ rating: ratingConditionForValue("min4") }), [
    "both",
    "jamie",
  ]);
  assert.deepEqual(matches({ rating: ratingConditionForValue("null") }), [
    "excluded",
  ]);
  assert.deepEqual(matches({ rating: ratingConditionForValue("0") }), ["none"]);
  assert.equal(ratingControlValue({ gte: 3, lte: 4 }), customConditionValue);
  assert.equal(ratingControlValue({ ne: 5 }), customConditionValue);
  assert.equal(ratingConditionForValue(customConditionValue), undefined);
});

test("quick toggles set and clear one boolean equality without touching custom conditions", () => {
  assert.equal(flagToggleActive(undefined, false), false);
  assert.deepEqual(toggleFlagCondition(null, false), { eq: false });
  assert.equal(flagToggleActive({ eq: false }, false), true);
  assert.equal(toggleFlagCondition({ eq: false }, false), null);
  assert.deepEqual(toggleFlagCondition({ eq: true }, false), { eq: false });
  assert.equal(flagToggleActive({ ne: false }, false), false);
  assert.deepEqual(toggleFlagCondition({ ne: false }, false), { eq: false });
  assert.deepEqual(toggleFlagCondition({ eq: false }, "false"), { eq: false });
  assert.deepEqual(matches({ hasAlbums: toggleFlagCondition(null, false) }), [
    "both",
    "jamie",
    "excluded",
    "none",
  ]);
});

test("enrichment status controls round-trip fixed vocabularies and flag other conditions", () => {
  for (const value of ["", ...descriptionStatuses]) {
    assert.equal(
      statusControlValue(
        statusConditionForValue(value, descriptionStatuses),
        descriptionStatuses,
      ),
      value,
    );
  }
  assert.equal(
    statusControlValue({ ne: "generated" }, descriptionStatuses),
    customConditionValue,
  );
  assert.equal(
    statusControlValue({ eq: "unknown" }, sensitiveStatuses),
    customConditionValue,
  );
  assert.equal(statusConditionForValue("bogus", sensitiveStatuses), undefined);
  assert.deepEqual(
    statusConditionForValue("needs-review", sensitiveStatuses),
    { eq: "needs-review" },
  );
  const enriched = [
    {
      id: "generated",
      description: "A lake",
      enrichment: {
        description: { status: "generated" },
        sensitive: { status: "reviewed" },
      },
    },
    {
      id: "missing",
      description: "",
      enrichment: { sensitive: { status: "needs-review" } },
    },
  ];
  assert.deepEqual(
    searchSampleAssets(enriched, {
      filter: { descriptionStatus: { eq: "missing" } },
    }).map((asset) => asset.id),
    ["missing"],
  );
  assert.deepEqual(
    searchSampleAssets(enriched, {
      filter: { sensitiveStatus: statusConditionForValue("needs-review", sensitiveStatuses) },
    }).map((asset) => asset.id),
    ["missing"],
  );
});
