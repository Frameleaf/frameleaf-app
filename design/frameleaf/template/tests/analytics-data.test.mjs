import test from "node:test";
import assert from "node:assert/strict";
import {
  ANALYTICS_SUMMARY,
  ILLUSTRATIVE_CLOUD_RATE_USD,
  GiB,
  analyticsCsv,
  calendarWeeks,
  getAnalytics,
} from "../src/analytics-data.mjs";

const sum = (rows, key) => rows.reduce((n, row) => n + row[key], 0);

for (const scope of ["all", "taylor"]) {
  for (const range of ["year", "90days"]) {
    test(`${scope}/${range}: arrivals, outcomes, inventory and byte accounting reconcile`, () => {
      const r = getAnalytics({ scope, range });
      const s = r.summary;
      assert.equal(s.photos + s.videos, s.items);
      assert.equal(r.series.at(-1).items, s.items);
      assert.equal(r.series.at(-1).physicalBytes, s.physicalBytes);
      assert.equal(r.series.at(-1).logicalBytes, s.logicalBytes);
      assert.equal(sum(r.series, "photos"), r.period.photos);
      assert.equal(sum(r.series, "videos"), r.period.videos);
      assert.equal(sum(r.days, "captured"), r.period.items);
      assert.equal(
        sum(r.series, "completed") + sum(r.series, "failed"),
        r.period.attempts,
      );
      assert.equal(sum(r.cameras, "count"), s.items);
      assert.equal(sum(r.codecs, "count"), s.videos);
      for (const row of r.metadata)
        assert.equal(row.present + row.missing, s.items);
      assert.equal(s.logicalBytes - s.physicalBytes, s.savedBytes);
      assert.equal(sum(r.storage, "bytes"), s.volumeUsedBytes);
      assert.equal(s.freeBytes + s.volumeUsedBytes, s.capacityBytes);
      assert.ok(s.volumeUsedBytes < s.capacityBytes);
      assert.ok(s.hdrVideos <= s.videos && s.raw <= s.photos);
      assert.ok(s.vfrVideos <= s.videos);
      for (let i = 1; i < r.series.length; i++) {
        assert.equal(
          r.series[i].items - r.series[i - 1].items,
          r.series[i].photos + r.series[i].videos,
        );
      }
      for (const row of r.storage)
        assert.equal(row.gib, Number((row.bytes / GiB).toFixed(2)));
    });
  }
}

test("Taylor is a strict subset while total host volume remains unchanged", () => {
  const all = getAnalytics();
  const taylor = getAnalytics({ scope: "taylor" });
  for (const key of [
    "items",
    "photos",
    "videos",
    "physicalBytes",
    "logicalBytes",
  ])
    assert.ok(taylor.summary[key] < all.summary[key]);
  assert.equal(taylor.summary.volumeUsedBytes, all.summary.volumeUsedBytes);
  assert.ok(taylor.storage.at(-1).bytes > all.storage.at(-1).bytes);
  for (let i = 0; i < all.days.length; i++) {
    assert.equal(all.days[i].date, taylor.days[i].date);
    assert.ok(taylor.days[i].captured < all.days[i].captured);
  }
});

test("date ranges change journal windows, never the ending inventory snapshot", () => {
  const year = getAnalytics();
  const short = getAnalytics({ range: "90days" });
  assert.equal(year.series.length, 12);
  assert.equal(short.days.length, 90);
  assert.equal(short.days[0].date, "2026-06-22");
  assert.equal(short.days.at(-1).date, "2026-09-19");
  assert.deepEqual(short.summary, year.summary);
  assert.deepEqual(short.days, year.days.slice(-90));
  assert.ok(short.period.attempts < year.period.attempts);
  assert.equal(ANALYTICS_SUMMARY.items, year.summary.items);
  assert.equal(ANALYTICS_SUMMARY.usedBytes, year.summary.volumeUsedBytes);
});

test("calendar contains every capture exactly once, including partial weeks", () => {
  for (const range of ["year", "90days"]) {
    const r = getAnalytics({ range });
    const cells = calendarWeeks(r.days)
      .flat()
      .filter((cell) => cell.captured !== null);
    assert.equal(cells.length, r.days.length);
    assert.equal(new Set(cells.map((cell) => cell.date)).size, r.days.length);
    assert.equal(sum(cells, "captured"), r.period.items);
    assert.deepEqual(
      cells.map((cell) => cell.date),
      r.days.map((day) => day.date),
    );
  }
});

test("CSV includes plotted storage values, exact bytes, scope and explicit demo provenance", () => {
  const r = getAnalytics({ scope: "taylor", range: "90days" });
  const csv = analyticsCsv(r, "storage");
  assert.match(csv, /Illustrative lab dataset/);
  assert.ok(csv.includes(`"${r.scopeLabel}"`));
  assert.match(csv, /not billed/);
  for (const row of r.series) {
    assert.ok(csv.includes(`"physical originals","${row.physicalGiB}","GiB"`));
    assert.ok(csv.includes(`"logical originals","${row.logicalGiB}","GiB"`));
  }
  for (const row of r.storage)
    assert.ok(csv.includes(`"${row.name}","${row.bytes}","bytes"`));
  assert.ok(csv.includes('"2026-06-22"'));
  assert.ok(csv.endsWith("\r\n"));
  assert.throws(() => analyticsCsv(r, "made-up"), /Unknown growth metric/);
});

test("reports are deterministic, invalid controls rejected, caller edits do not mutate the sample", () => {
  const first = getAnalytics();
  assert.deepEqual(first, getAnalytics());
  first.series[0].items = 0;
  first.summary.items = 0;
  assert.ok(getAnalytics().summary.items > 0);
  assert.ok(getAnalytics().series[0].items > 0);
  assert.throws(
    () => getAnalytics({ range: "forever" }),
    /Unknown analytics range/,
  );
  assert.throws(
    () => getAnalytics({ scope: "unknown" }),
    /Unknown analytics scope/,
  );
});

// Every field is quoted, including commas in metric descriptions. Parse those
// values instead of splitting on commas so the scope checks exercise the CSV.
function readCsv(csv) {
  const rows = csv
    .trimEnd()
    .split("\r\n")
    .map((line) =>
      [...line.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(([, value]) =>
        value.replaceAll('""', '"'),
      ),
    );
  const [header, ...values] = rows;
  for (const row of values)
    assert.equal(row.length, header.length, "CSV must be rectangular");
  return values.map((row) =>
    Object.fromEntries(header.map((key, index) => [key, row[index]])),
  );
}

test("Taylor CSV distinguishes the selection from host and residual measurement scopes", () => {
  const report = getAnalytics({ scope: "taylor", range: "90days" });
  const rows = readCsv(analyticsCsv(report, "storage"));
  assert.ok(rows.every((row) => row.selection_scope === report.scopeLabel));
  for (const key of ["volumeUsedBytes", "capacityBytes", "freeBytes"]) {
    const row = rows.find(
      (row) => row.section === "inventory" && row.metric === key,
    );
    assert.equal(row.measurement_scope, "Whole host");
    assert.equal(Number(row.value), ANALYTICS_SUMMARY[key]);
  }
  const scoped = rows.find(
    (row) => row.section === "inventory" && row.metric === "physicalBytes",
  );
  assert.equal(scoped.measurement_scope, report.scopeLabel);
  const remainder = rows.find(
    (row) =>
      row.section === "storage bytes" &&
      row.metric === "Other libraries + host files",
  );
  assert.equal(remainder.measurement_scope, "Other libraries + host files");
  assert.equal(
    Number(remainder.value) +
      report.summary.physicalBytes +
      report.summary.proxyBytes +
      report.summary.thumbnailBytes,
    ANALYTICS_SUMMARY.volumeUsedBytes,
  );
  assert.ok(
    rows.every((row) => row.dataset.includes("Illustrative lab dataset")),
  );
  for (const metadata of report.metadata) {
    const row = rows.find(
      (row) =>
        row.section === "metadata" &&
        row.metric === `${metadata.name} · complete`,
    );
    assert.equal(Number(row.value), metadata.percent);
    assert.equal(row.unit, "percent");
  }
  assert.equal(
    Number(
      rows.find(
        (row) =>
          row.section === "processing" && row.metric === "completion rate",
      ).value,
    ),
    report.period.successPercent,
  );
});

test("camera completeness excludes only explicitly unrecorded models", () => {
  for (const scope of ["all", "taylor"]) {
    const report = getAnalytics({ scope });
    const unknown = report.cameras.find(
      (camera) => camera.name === "Not recorded",
    );
    const metadata = report.metadata.find((row) => row.name === "Camera model");
    assert.equal(metadata.missing, unknown.count);
    assert.equal(
      metadata.present,
      sum(
        report.cameras.filter((camera) => camera !== unknown),
        "count",
      ),
    );
  }
});

test("cloud scenario discloses its fictional per-attempt rate and all-cloud assumption", () => {
  const report = getAnalytics();
  assert.equal(
    report.period.cloudRateUsdPerAttempt,
    ILLUSTRATIVE_CLOUD_RATE_USD,
  );
  assert.equal(
    report.period.cloudEstimateUsd,
    Number((report.period.attempts * ILLUSTRATIVE_CLOUD_RATE_USD).toFixed(2)),
  );
  const rows = readCsv(analyticsCsv(report));
  const rate = rows.find((row) => row.unit === "USD per attempt");
  assert.equal(Number(rate.value), ILLUSTRATIVE_CLOUD_RATE_USD);
  assert.match(rate.metric, /not a provider quote/);
  const estimate = rows.find((row) => row.unit === "USD");
  assert.match(estimate.metric, /assumes all attempts use cloud; not billed/);
});

test("every account and library partitions the fixed snapshot, daily arrivals and processing exactly", async () => {
  const { createResourceState } =
    await import("../src/account-library-data.mjs");
  const resources = createResourceState();
  const fields = [
    "photos",
    "videos",
    "items",
    "logicalBytes",
    "physicalBytes",
    "savedBytes",
    "raw",
    "hdrVideos",
    "vfrVideos",
    "duplicateReferences",
    "proxyBytes",
    "thumbnailBytes",
  ];
  for (const range of ["year", "90days"]) {
    const all = getAnalytics({ resources, range });
    const users = resources.users.map((u) =>
      getAnalytics({ scope: u.id, range, resources }),
    );
    for (const key of fields)
      assert.equal(
        users.reduce((n, r) => n + r.summary[key], 0),
        all.summary[key],
        key,
      );
    for (const user of resources.users) {
      const r = users.find((r) => r.scope === user.id);
      const libraries = resources.libraries
        .filter((l) => l.ownerId === user.id)
        .map((l) =>
          getAnalytics({ scope: `library:${l.id}`, range, resources }),
        );
      for (const key of fields)
        assert.equal(
          libraries.reduce((n, l) => n + l.summary[key], 0),
          r.summary[key],
          `${user.id}/${key}`,
        );
      for (const key of ["photos", "videos", "attempts", "completed", "failed"])
        assert.equal(
          libraries.reduce((n, l) => n + l.period[key], 0),
          r.period[key],
        );
      for (const library of libraries) {
        assert.equal(sum(library.cameras, "count"), library.summary.items);
        assert.equal(
          library.summary.logicalBytes - library.summary.physicalBytes,
          library.summary.savedBytes,
        );
        assert.equal(library.summary.capacityBytes, all.summary.capacityBytes);
        assert.equal(
          sum(library.storage, "bytes"),
          all.summary.volumeUsedBytes,
        );
        for (const metadata of library.metadata)
          assert.ok(metadata.missing >= 0 && metadata.present >= 0);
      }
    }
    for (let i = 0; i < all.days.length; i++)
      for (const key of ["photos", "videos", "attempts", "completed", "failed"])
        assert.equal(
          users.reduce((n, r) => n + r.days[i][key], 0),
          all.days[i][key],
        );
    for (let i = 0; i < all.cameras.length; i++)
      assert.equal(
        users.reduce((n, r) => n + r.cameras[i].count, 0),
        all.cameras[i].count,
      );
  }
});
test("new accounts have zero historical data; deleted scopes retain dated history and fixed host capacity", async () => {
  const { createResourceState, applyResourceCommand } =
    await import("../src/account-library-data.mjs");
  let resources = applyResourceCommand(createResourceState(), {
    type: "create-user",
    id: "alex",
    fields: {
      name: "Alex",
      email: "alex@example.test",
      storageLabel: "",
      quotaBytes: null,
      password: "private-secret",
    },
  });
  const report = getAnalytics({ resources, scope: "alex" });
  assert.equal(report.summary.items, 0);
  assert.equal(report.period.attempts, 0);
  assert.equal(report.period.successPercent, 0);
  assert.ok(report.metadata.every((row) => row.percent === 0));
  assert.equal(report.summary.capacityBytes, ANALYTICS_SUMMARY.capacityBytes);
  assert.equal(
    getAnalytics({ resources, scope: "library:upload-alex" }).summary.items,
    0,
  );
  const before = getAnalytics({ resources, scope: "jamie" }).summary;
  resources = applyResourceCommand(resources, {
    type: "delete-user",
    userId: "jamie",
    confirmEmail: "jamie@example.test",
  });
  assert.deepEqual(getAnalytics({ resources, scope: "jamie" }).summary, before);
});

test("usage views partition retained items while favorites and album roles remain explicitly overlapping", async () => {
  const { createResourceState } =
    await import("../src/account-library-data.mjs");
  const resources = createResourceState();
  for (const scope of [
    "all",
    ...resources.users.map((u) => u.id),
    ...resources.libraries.map((l) => `library:${l.id}`),
  ]) {
    const report = getAnalytics({ scope, resources });
    const partition = report.collections.filter((row) => !row.overlaps);
    for (const metric of ["photos", "videos"])
      assert.equal(sum(partition, metric), report.summary[metric]);
    const favorite = report.collections.find((row) => row.overlaps);
    const trash = report.collections.find((row) => row.name === "Trash");
    assert.ok(favorite.total <= report.summary.items - trash.total);
    assert.equal(
      report.albumCounts.owned +
        report.albumCounts.shared -
        report.albumCounts.ownedShared,
      report.albumCounts.total,
    );
    assert.equal(
      report.albumCounts.ownedShared + report.albumCounts.notShared,
      report.albumCounts.owned,
    );
    assert.equal(
      new Set(report.albums.map((a) => a.id)).size,
      report.albumCounts.total,
    );
    assert.equal(sum(report.days, "uploaded"), report.period.items);
    const csv = analyticsCsv(report);
    assert.match(csv, /upload calendar/);
    assert.match(csv, /overlaps other views/);
    assert.match(csv, /ownedShared/);
  }
  assert.ok(getAnalytics({ scope: "taylor" }).albumCounts.ownedShared > 0);
});
