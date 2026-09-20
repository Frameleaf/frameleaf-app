import {
  SEED_LIBRARIES,
  getScopeOptions,
  loadResourceState,
} from "./account-library-data.mjs";

export const ANALYTICS_SNAPSHOT = "2026-09-19T12:00:00.000Z";
export const ANALYTICS_DISCLOSURE =
  "Illustrative lab dataset · independent of the photo-grid samples · no live server connection";
export const ILLUSTRATIVE_CLOUD_RATE_USD = 0.00003;
export const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
const dayMs = 86_400_000;
const start = Date.UTC(2025, 9, 1);
const end = Date.UTC(2026, 8, 19);
const baseline = {
  taylor: { photos: 39_000, videos: 4_200 },
  other: { photos: 51_000, videos: 4_800 },
};
const sum = (rows, key) => rows.reduce((total, row) => total + row[key], 0);
const iso = (time) => new Date(time).toISOString().slice(0, 10);
export const round = (value, places = 2) => Number(value.toFixed(places));

// Fixed fictional daily journal. No random values, external data or device clock.
const journal = Array.from(
  { length: (end - start) / dayMs + 1 },
  (_, index) => {
    const date = iso(start + index * dayMs);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const photos =
      56 + ((index * 37) % 123) + (weekday === 0 || weekday === 6 ? 84 : 0);
    const videos = 5 + ((index * 11) % 19);
    const taylorPhotos = Math.floor(photos * (0.34 + (index % 5) * 0.035));
    const taylorVideos = Math.floor(videos * 0.44);
    const row = (p, v, offset) => {
      const attempts = (p + v) * 3 + 75 + ((index * 7 + offset) % 62);
      const failed = Math.floor(attempts * (0.008 + (index % 9) / 1500));
      return {
        photos: p,
        videos: v,
        attempts,
        completed: attempts - failed,
        failed,
      };
    };
    return {
      date,
      taylor: row(taylorPhotos, taylorVideos, 0),
      other: row(photos - taylorPhotos, videos - taylorVideos, 13),
    };
  },
);

function stock(photos, videos) {
  const raw = Math.floor(photos * 0.16);
  const photoBytes = (photos - raw) * 5 * MiB + raw * 36 * MiB;
  const videoBytes = videos * 90 * MiB;
  const logicalBytes = photoBytes + videoBytes;
  const physicalBytes = Math.floor((logicalBytes * 0.92) / MiB) * MiB;
  return {
    photos,
    videos,
    items: photos + videos,
    raw,
    hdrVideos: Math.floor(videos * 0.24),
    vfrVideos: Math.floor(videos * 0.61),
    duplicateReferences: Math.floor((photos + videos) * 0.035),
    logicalBytes,
    physicalBytes,
    savedBytes: logicalBytes - physicalBytes,
    thumbnailBytes: (photos + videos) * 80 * 1024,
    proxyBytes: videos * 4 * MiB,
  };
}

function aggregateStocks(stocks) {
  if (!stocks.length) return stock(0, 0);
  return Object.fromEntries(
    Object.keys(stocks[0]).map((key) => [key, sum(stocks, key)]),
  );
}

function ownersFor(scope) {
  return scope === "taylor" ? ["taylor"] : ["taylor", "other"];
}

function currentStock(scope) {
  return aggregateStocks(
    ownersFor(scope).map((owner) =>
      stock(
        baseline[owner].photos +
          journal.reduce((n, row) => n + row[owner].photos, 0),
        baseline[owner].videos +
          journal.reduce((n, row) => n + row[owner].videos, 0),
      ),
    ),
  );
}

const whole = currentStock("all");
const hostFilesBytes = 37 * GiB;
const capacityBytes = 4 * 1024 * GiB;
const volumeUsedBytes =
  whole.physicalBytes +
  whole.thumbnailBytes +
  whole.proxyBytes +
  hostFilesBytes;

export const ANALYTICS_SUMMARY = Object.freeze({
  ...whole,
  capacityBytes,
  volumeUsedBytes,
  usedBytes: volumeUsedBytes,
  freeBytes: capacityBytes - volumeUsedBytes,
  asOf: ANALYTICS_SNAPSHOT,
  illustrative: true,
});

const allocate = (total, weights) => {
  const counts = weights.map((weight) => Math.floor(total * weight));
  counts[counts.length - 1] += total - counts.reduce((a, b) => a + b, 0);
  return counts;
};

function bucketKey(date, range) {
  if (range === "year") return date.slice(0, 7);
  const time = new Date(`${date}T00:00:00Z`);
  time.setUTCDate(time.getUTCDate() - ((time.getUTCDay() + 6) % 7));
  return iso(time);
}

function bucketLabel(key, range) {
  const date = new Date(`${key}${range === "year" ? "-01" : ""}T00:00:00Z`);
  return new Intl.DateTimeFormat(
    "en-CA",
    range === "year"
      ? { month: "short", year: "2-digit", timeZone: "UTC" }
      : { month: "short", day: "numeric", timeZone: "UTC" },
  ).format(date);
}

function splitMetrics(source, ratio) {
  const first = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [
      key,
      Math.floor(value * ratio),
    ]),
  );
  if (Object.hasOwn(first, "attempts"))
    first.completed = first.attempts - first.failed;
  const second = Object.fromEntries(
    Object.entries(source).map(([key, value]) => [key, value - first[key]]),
  );
  return [first, second];
}

function distributeLibraries(source) {
  const [taylorUploads, taylorExternal] = splitMetrics(source.taylor, 0.7);
  const [jamie, emma] = splitMetrics(source.other, 0.6);
  const [jamieUploads, jamieExternal] = splitMetrics(jamie, 0.65);
  return {
    "upload-taylor": taylorUploads,
    "external-taylor": taylorExternal,
    "upload-jamie": jamieUploads,
    "external-jamie": jamieExternal,
    "upload-emma": emma,
  };
}

function scopedStock(accumulated, libraryCounts, selected) {
  const attributed = distributeLibraries({
    taylor: stock(accumulated.taylor.photos, accumulated.taylor.videos),
    other: stock(accumulated.other.photos, accumulated.other.videos),
  });
  return aggregateStocks(
    selected.map((id) => ({
      ...attributed[id],
      ...libraryCounts[id],
      savedBytes: attributed[id].logicalBytes - attributed[id].physicalBytes,
      items: libraryCounts[id].photos + libraryCounts[id].videos,
    })),
  );
}

// Album roles mirror the source album-statistics contract. Shared and owned
// are overlapping sets; all-scope results deduplicate album identity.
const sampleAlbums = [
  {
    id: "rockies",
    name: "Summer in the Rockies",
    ownerId: "taylor",
    memberIds: ["jamie", "emma"],
    libraryIds: ["upload-taylor", "external-taylor"],
  },
  {
    id: "family",
    name: "Family archive",
    ownerId: "taylor",
    memberIds: ["jamie"],
    libraryIds: ["external-taylor"],
  },
  {
    id: "winter",
    name: "Winter afternoons",
    ownerId: "taylor",
    memberIds: [],
    libraryIds: ["upload-taylor"],
  },
  {
    id: "trails",
    name: "Trail discoveries",
    ownerId: "jamie",
    memberIds: ["taylor"],
    libraryIds: ["external-jamie"],
  },
  {
    id: "selects",
    name: "Jamie’s selects",
    ownerId: "jamie",
    memberIds: [],
    libraryIds: ["upload-jamie"],
  },
  {
    id: "little-things",
    name: "The little things",
    ownerId: "emma",
    memberIds: [],
    libraryIds: ["upload-emma"],
  },
  {
    id: "birthday",
    name: "Birthday weekend",
    ownerId: "emma",
    memberIds: ["taylor", "jamie"],
    libraryIds: ["upload-emma"],
  },
];

export function getAnalytics({
  range = "year",
  scope = "all",
  resources = loadResourceState(),
} = {}) {
  if (!["year", "90days"].includes(range))
    throw new Error("Unknown analytics range");
  const option = getScopeOptions(resources).find(
    (option) => option.value === scope,
  );
  if (!option) throw new Error("Unknown analytics scope");
  const selected = SEED_LIBRARIES.filter(
    (library) =>
      scope === "all" ||
      (option.kind === "library"
        ? library.id === option.libraryId
        : library.ownerId === option.userId),
  ).map((library) => library.id);
  const owners = ["taylor", "other"];
  const from = range === "90days" ? iso(end - 89 * dayMs) : iso(start);
  const accumulated = Object.fromEntries(
    owners.map((owner) => [owner, { ...baseline[owner] }]),
  );
  const libraryCounts = distributeLibraries(baseline);
  const buckets = new Map();
  const days = [];
  for (const entry of journal) {
    for (const owner of owners) {
      accumulated[owner].photos += entry[owner].photos;
      accumulated[owner].videos += entry[owner].videos;
    }
    const allocated = distributeLibraries({
      taylor: entry.taylor,
      other: entry.other,
    });
    for (const id of Object.keys(libraryCounts)) {
      libraryCounts[id].photos += allocated[id].photos;
      libraryCounts[id].videos += allocated[id].videos;
    }
    if (entry.date < from) continue;
    const daily = { date: entry.date };
    for (const metric of [
      "photos",
      "videos",
      "attempts",
      "completed",
      "failed",
    ]) {
      daily[metric] = selected.reduce((n, id) => n + allocated[id][metric], 0);
    }
    daily.captured = daily.photos + daily.videos;
    daily.uploaded = daily.photos + daily.videos;
    days.push(daily);
    const key = bucketKey(entry.date, range);
    const bucket = buckets.get(key) ?? {
      key,
      label: bucketLabel(key, range),
      from: entry.date,
      through: entry.date,
      photos: 0,
      videos: 0,
      attempts: 0,
      completed: 0,
      failed: 0,
    };
    for (const metric of [
      "photos",
      "videos",
      "attempts",
      "completed",
      "failed",
    ])
      bucket[metric] += daily[metric];
    bucket.through = entry.date;
    const cumulative = scopedStock(accumulated, libraryCounts, selected);
    Object.assign(bucket, {
      items: cumulative.items,
      cumulativePhotos: cumulative.photos,
      cumulativeVideos: cumulative.videos,
      logicalBytes: cumulative.logicalBytes,
      physicalBytes: cumulative.physicalBytes,
      physicalGiB: round(cumulative.physicalBytes / GiB),
      logicalGiB: round(cumulative.logicalBytes / GiB),
    });
    buckets.set(key, bucket);
  }
  const summary = {
    ...scopedStock(accumulated, libraryCounts, selected),
    capacityBytes,
    volumeUsedBytes,
    freeBytes: capacityBytes - volumeUsedBytes,
    asOf: ANALYTICS_SNAPSHOT,
    illustrative: true,
  };
  const series = [...buckets.values()];
  const cameraNames = [
    "Apple iPhone 16 Pro",
    "Sony α7 IV",
    "Canon EOS R6",
    "Not recorded",
  ];
  const allItems = currentStock("all").items;
  const taylorItems = currentStock("taylor").items;
  // Partition every dimension from the same owner ledger so scoped tables add up.
  const partitionDimension = (all, taylor) =>
    distributeLibraries({
      taylor: { count: taylor },
      other: { count: all - taylor },
    });
  const dimensionCount = (all, taylor) => {
    const rows = partitionDimension(all, taylor);
    return selected.reduce((sum, id) => sum + rows[id].count, 0);
  };
  const allCameras = allocate(allItems, [0.54, 0.25, 0.13, 0.08]);
  const taylorCameras = allocate(taylorItems, [0.38, 0.44, 0.1, 0.08]);
  const cameras = cameraNames.map((name, i) => ({
    name,
    count: dimensionCount(allCameras[i], taylorCameras[i]),
  }));
  // Integer photo/video counts are journal-partitioned; use those per-library
  // counts for exhaustive dimensions to avoid a rounding drift at bucket edges.
  const exhaustiveCounts = (field, weights) => {
    const counts = selected.map((id) =>
      allocate(libraryCounts[id][field], weights),
    );
    return weights.map((_, i) => counts.reduce((sum, row) => sum + row[i], 0));
  };
  const cameraDrift = summary.items - sum(cameras, "count");
  cameras[0].count += cameraDrift;
  const codecCounts = exhaustiveCounts("videos", [0.61, 0.36, 0.03]);
  const codecs = ["HEVC / H.265", "AVC / H.264", "AV1 / other"].map(
    (name, i) => ({ name, count: codecCounts[i] }),
  );
  const metadata = [
    ["Capture date", 0.984],
    ["GPS location", 0.642],
    ["Camera model", 0.92],
    ["AI description", 0.783],
    ["Original checksum", 1],
  ].map(([name, ratio]) => {
    const present =
      name === "Camera model"
        ? summary.items - cameras.at(-1).count
        : ratio === 1
          ? summary.items
          : summary.items -
            dimensionCount(
              allItems - Math.floor(allItems * ratio),
              taylorItems - Math.floor(taylorItems * ratio),
            );
    return {
      name,
      present,
      missing: summary.items - present,
      total: summary.items,
      percent: summary.items ? round((present / summary.items) * 100, 1) : 0,
    };
  });
  const dispositions = ["Timeline", "Archive", "Trash"].map((name, index) => {
    const photos = exhaustiveCounts("photos", [0.88, 0.1, 0.02])[index];
    const videos = exhaustiveCounts("videos", [0.88, 0.1, 0.02])[index];
    return { name, photos, videos, total: photos + videos, overlaps: false };
  });
  const favoriteCounts = selected.map((id) => {
    const p = allocate(libraryCounts[id].photos, [0.88, 0.1, 0.02]);
    const v = allocate(libraryCounts[id].videos, [0.88, 0.1, 0.02]);
    return {
      photos: Math.floor((p[0] + p[1]) * 0.17),
      videos: Math.floor((v[0] + v[1]) * 0.12),
    };
  });
  const favorites = {
    name: "Favorites",
    photos: sum(favoriteCounts, "photos"),
    videos: sum(favoriteCounts, "videos"),
    overlaps: true,
  };
  favorites.total = favorites.photos + favorites.videos;
  const collections = [
    dispositions[0],
    favorites,
    dispositions[1],
    dispositions[2],
  ];
  const albums = sampleAlbums
    .filter((album) => {
      if (option.kind === "system") return true;
      if (option.kind === "library")
        return album.libraryIds.includes(option.libraryId);
      return (
        album.ownerId === option.userId ||
        album.memberIds.includes(option.userId)
      );
    })
    .map((album) => ({
      ...album,
      libraryIds: [...album.libraryIds],
      memberIds: [...album.memberIds],
      ownerName:
        resources.users.find((u) => u.id === album.ownerId)?.name ||
        album.ownerId,
      owned: option.kind === "system" || album.ownerId === option.userId,
      shared: album.memberIds.length > 0,
    }));
  const albumCounts = {
    total: albums.length,
    owned: albums.filter((a) => a.owned).length,
    shared: albums.filter((a) => a.shared).length,
    ownedShared: albums.filter((a) => a.owned && a.shared).length,
    notShared: albums.filter((a) => a.owned && !a.shared).length,
  };
  const allocatedBytes =
    summary.physicalBytes + summary.thumbnailBytes + summary.proxyBytes;
  const storage = [
    { name: "Originals · physical", bytes: summary.physicalBytes },
    { name: "Playback proxies", bytes: summary.proxyBytes },
    { name: "Thumbnails", bytes: summary.thumbnailBytes },
    {
      name:
        scope === "all"
          ? "Database + other host files"
          : "Other libraries + host files",
      bytes: volumeUsedBytes - allocatedBytes,
    },
  ].map((item) => ({ ...item, gib: round(item.bytes / GiB) }));
  const period = {
    photos: sum(days, "photos"),
    videos: sum(days, "videos"),
    attempts: sum(days, "attempts"),
    completed: sum(days, "completed"),
    failed: sum(days, "failed"),
  };
  period.items = period.photos + period.videos;
  period.successPercent = period.attempts
    ? round((period.completed / period.attempts) * 100, 2)
    : 0;
  period.cloudRateUsdPerAttempt = ILLUSTRATIVE_CLOUD_RATE_USD;
  period.cloudEstimateUsd = round(
    period.attempts * period.cloudRateUsdPerAttempt,
  );
  return {
    range,
    scope,
    scopeLabel: scope === "all" ? "All accounts & libraries" : option.label,
    from,
    through: iso(end),
    summary,
    series,
    days,
    cameras,
    codecs,
    storage,
    metadata,
    period,
    collections,
    albums,
    albumCounts,
    // Fictional journal assumes same-day capture/import and no deletion; these
    // intentional simplifications keep all charts reconcilable.
    assumptions:
      "Same-day capture and import; no removals. Physical storage is attributed to an owner in this illustrative model. Volume usage always covers the whole host.",
  };
}

export function calendarWeeks(days) {
  const byDate = new Map(days.map((day) => [day.date, day]));
  const first = new Date(`${days[0].date}T00:00:00Z`);
  first.setUTCDate(first.getUTCDate() - ((first.getUTCDay() + 6) % 7));
  const last = Date.parse(`${days.at(-1).date}T00:00:00Z`);
  const weeks = [];
  for (let time = first.getTime(); time <= last; time += dayMs * 7) {
    weeks.push(
      Array.from({ length: 7 }, (_, index) => {
        const date = iso(time + index * dayMs);
        return { date, captured: byDate.get(date)?.captured ?? null };
      }),
    );
  }
  return weeks;
}

export function analyticsCsv(report, metric = "items") {
  if (!["items", "storage"].includes(metric))
    throw new Error("Unknown growth metric");
  const records = [];
  const add = (
    section,
    period,
    metricName,
    value,
    unit,
    measurementScope = report.scopeLabel,
  ) =>
    records.push([
      section,
      period,
      metricName,
      value,
      unit,
      report.scopeLabel,
      measurementScope,
      ANALYTICS_SNAPSHOT,
    ]);
  for (const row of report.series) {
    const period = `${row.from} / ${row.through}`;
    add(
      "growth",
      period,
      metric === "items" ? "total items" : "physical originals",
      metric === "items" ? row.items : row.physicalGiB,
      metric === "items" ? "items" : "GiB",
    );
    if (metric === "storage")
      add("growth", period, "logical originals", row.logicalGiB, "GiB");
    for (const key of ["photos", "videos"])
      add("arrivals", period, key, row[key], "items");
    for (const key of ["completed", "failed"])
      add("processing", period, key, row[key], "attempts");
  }
  for (const row of report.storage) {
    const measurementScope =
      row.name === "Other libraries + host files"
        ? "Other libraries + host files"
        : row.name === "Database + other host files"
          ? "Whole host"
          : report.scopeLabel;
    add("storage", report.through, row.name, row.gib, "GiB", measurementScope);
    add(
      "storage bytes",
      report.through,
      row.name,
      row.bytes,
      "bytes",
      measurementScope,
    );
  }
  for (const row of report.cameras)
    add("cameras", report.through, row.name, row.count, "items");
  for (const row of report.metadata) {
    for (const key of ["present", "missing"])
      add(
        "metadata",
        report.through,
        `${row.name} · ${key}`,
        row[key],
        "items",
      );
    add(
      "metadata",
      report.through,
      `${row.name} · complete`,
      row.percent,
      "percent",
    );
  }
  add(
    "processing",
    `${report.from} / ${report.through}`,
    "completion rate",
    report.period.successPercent,
    "percent",
  );
  for (const row of report.days) {
    add("capture calendar", row.date, "captured", row.captured, "items");
    add("upload calendar", row.date, "uploaded", row.uploaded, "items");
  }
  for (const row of report.collections)
    for (const key of ["photos", "videos", "total"])
      add(
        "collections",
        report.through,
        `${row.name} · ${key}${row.overlaps ? " (overlaps other views)" : ""}`,
        row[key],
        "items",
      );
  for (const key of ["owned", "shared", "ownedShared", "notShared", "total"])
    add("albums", report.through, key, report.albumCounts[key], "albums");
  for (const album of report.albums)
    add(
      "album list",
      report.through,
      `${album.name} · ${album.ownerName} · ${album.shared ? "shared" : "private"}`,
      1,
      "album",
    );
  for (const row of report.codecs)
    add("video codecs", report.through, row.name, row.count, "videos");
  for (const key of [
    "items",
    "photos",
    "videos",
    "raw",
    "hdrVideos",
    "vfrVideos",
    "duplicateReferences",
    "logicalBytes",
    "physicalBytes",
    "savedBytes",
    "volumeUsedBytes",
    "capacityBytes",
    "freeBytes",
  ]) {
    add(
      "inventory",
      report.through,
      key,
      report.summary[key],
      key.endsWith("Bytes") ? "bytes" : "items",
      ["volumeUsedBytes", "capacityBytes", "freeBytes"].includes(key)
        ? "Whole host"
        : report.scopeLabel,
    );
  }
  add(
    "estimated cloud processing",
    `${report.from} / ${report.through}`,
    "illustrative estimate, assumes all attempts use cloud; not billed",
    report.period.cloudEstimateUsd,
    "USD",
  );
  add(
    "estimated cloud processing",
    `${report.from} / ${report.through}`,
    "fictional rate; not a provider quote",
    report.period.cloudRateUsdPerAttempt,
    "USD per attempt",
  );
  const escape = (value) => `"${String(value).replaceAll('"', '""')}"`;
  return (
    [
      [
        "section",
        "period",
        "metric",
        "value",
        "unit",
        "selection_scope",
        "measurement_scope",
        "snapshot",
        "dataset",
      ]
        .map(escape)
        .join(","),
      ...records.map((row) =>
        [...row, ANALYTICS_DISCLOSURE].map(escape).join(","),
      ),
    ].join("\r\n") + "\r\n"
  );
}
