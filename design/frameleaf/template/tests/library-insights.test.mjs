import assert from "node:assert/strict";
import { test } from "node:test";
import { getAnalytics } from "../src/analytics-data.mjs";
import { createResourceState, getScopeOptions } from "../src/account-library-data.mjs";
import { libraryInsights, longestStreak } from "../src/library-insights.mjs";

const SEED_RESOURCES = createResourceState();

const total = (list, key = "count") => list.reduce((n, row) => n + row[key], 0);

test("every dashboard breakdown partitions the report totals it claims to", () => {
  for (const option of getScopeOptions(SEED_RESOURCES)) {
    for (const range of ["year", "90days"]) {
      const report = getAnalytics({ range, scope: option.value, resources: SEED_RESOURCES });
      const insights = libraryInsights(report);
      const { items, photos, videos, raw } = report.summary;
      const label = `${option.value}/${range}`;
      assert.equal(total(insights.years), items, `${label} years`);
      assert.equal(
        insights.punchcard.reduce((n, row) => n + row.hours.reduce((a, b) => a + b, 0), 0),
        items,
        `${label} punchcard`,
      );
      assert.equal(total(insights.photoFormats), photos, `${label} formats`);
      assert.equal(insights.photoFormats.find((row) => row.name === "RAW").count, raw);
      assert.equal(total(insights.videoResolutions), videos, `${label} resolutions`);
      assert.equal(total(insights.orientation), photos, `${label} orientation`);
      assert.ok(insights.photosWithFaces <= photos && insights.livePhotos <= photos);
      assert.equal(total(insights.places), insights.geotagged, `${label} places`);
      assert.equal(total(insights.people), insights.facesDetected, `${label} people`);
      assert.equal(total(insights.lenses), total(insights.focalLengths), `${label} lenses`);
      assert.ok(insights.dolbyVision <= insights.hdr && insights.hdr <= videos);
      for (const ring of insights.coverage)
        assert.ok(ring.percent >= 0 && ring.percent <= 100, `${label} ${ring.name}`);
    }
  }
});

test("insights are deterministic and an empty library shows no invented records", () => {
  const report = getAnalytics({ resources: SEED_RESOURCES });
  assert.deepEqual(libraryInsights(report), libraryInsights(report));
  const empty = libraryInsights({
    summary: { items: 0, photos: 0, videos: 0, raw: 0, hdrVideos: 0 },
    days: [],
    metadata: [],
  });
  assert.equal(empty.records.busiestDay, null);
  assert.equal(empty.records.largestFile, null);
  assert.equal(empty.countries, 0);
  assert.equal(total(empty.years), 0);
});

test("longest streak counts consecutive days with captures", () => {
  const days = [
    { date: "2026-01-01", captured: 3 },
    { date: "2026-01-02", captured: 0 },
    { date: "2026-01-03", captured: 1 },
    { date: "2026-01-04", captured: 2 },
    { date: "2026-01-05", captured: 5 },
  ];
  assert.deepEqual(longestStreak(days), {
    length: 3,
    from: "2026-01-03",
    through: "2026-01-05",
  });
});
