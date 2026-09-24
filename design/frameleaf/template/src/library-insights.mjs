// Dashboard insights for Library analytics. Every breakdown partitions a total
// from the analytics report (items, photos, videos, geotagged items), so each
// chart adds up to the numbers above it for whichever scope is selected.
// Illustrative, deterministic sample data: no clock, randomness or server.

const allocate = (total, weights) => {
  const sum = weights.reduce((a, b) => a + b, 0) || 1;
  const counts = weights.map((weight) => Math.floor((total * weight) / sum));
  // Hand the rounding remainder to the largest share so small shares stay honest.
  const largest = weights.indexOf(Math.max(...weights));
  counts[largest] += total - counts.reduce((a, b) => a + b, 0);
  return counts;
};
const rows = (names, counts) =>
  names.map((name, index) => ({ name, count: counts[index] }));

export const FIRST_YEAR = 2009;
export const OLDEST_CAPTURE = "2009-06-14";
const LAST_YEAR = 2026;
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

// Camera-phone era growth, with a partial current year.
function yearWeights() {
  return Array.from({ length: LAST_YEAR - FIRST_YEAR + 1 }, (_, index) => {
    const year = FIRST_YEAR + index;
    const growth = (index + 1) ** 1.55;
    return year === LAST_YEAR ? growth * 0.72 : growth;
  });
}

// Mornings, a lunchtime dip, golden hour, quiet nights; weekends shoot more.
const HOUR_CURVE = [
  0.4, 0.2, 0.1, 0.1, 0.1, 0.3, 1.1, 2.4, 3.6, 4.8, 5.6, 5.9, 4.9, 4.6, 5.2,
  5.8, 6.4, 7.1, 7.4, 6.2, 4.4, 3.1, 1.9, 0.9,
];
function punchWeights() {
  return WEEKDAYS.flatMap((_, day) =>
    HOUR_CURVE.map((hour) => hour * (day >= 5 ? 1.75 : 1)),
  );
}

export function longestStreak(days) {
  let best = { length: 0, from: null, through: null };
  let run = { length: 0, from: null };
  for (const day of days) {
    if (day.captured > 0) {
      run = { length: run.length + 1, from: run.from ?? day.date };
      if (run.length > best.length)
        best = { length: run.length, from: run.from, through: day.date };
    } else run = { length: 0, from: null };
  }
  return best;
}

export function libraryInsights(report) {
  const { summary, days, metadata } = report;
  const { items, photos, videos, raw } = summary;

  const yearCounts = allocate(items, yearWeights());
  const years = yearCounts.map((count, index) => ({
    year: FIRST_YEAR + index,
    count,
    partial: FIRST_YEAR + index === LAST_YEAR,
  }));

  const punch = allocate(items, punchWeights());
  const punchcard = WEEKDAYS.map((day, row) => ({
    day,
    hours: punch.slice(row * 24, row * 24 + 24),
  }));
  const peak = punch.indexOf(Math.max(...punch));

  const [heic, jpeg, png, otherFormat] = allocate(photos - raw, [58, 37, 3, 2]);
  const photoFormats = rows(
    ["HEIC", "JPEG", "RAW", "PNG", "Other"],
    [heic, jpeg, raw, png, otherFormat],
  );
  const videoResolutions = rows(
    ["4K", "1080p", "720p", "SD"],
    allocate(videos, [46, 41, 9, 4]),
  );
  const orientation = rows(
    ["Landscape", "Portrait", "Square", "Panorama"],
    allocate(photos, [61, 33, 4, 2]),
  );
  const livePhotos = Math.floor(photos * 0.21);
  const hdr = summary.hdrVideos;
  const dolbyVision = Math.floor(hdr * 0.42);

  const withCamera = metadata.find((row) => row.name === "Camera model")
    ?.present ?? Math.floor(items * 0.92);
  const focalLengths = rows(
    ["≤16mm", "17–28mm", "29–40mm", "41–70mm", "71–135mm", "136–300mm", "300mm+"],
    allocate(Math.min(photos, withCamera), [7, 34, 21, 17, 12, 7, 2]),
  );
  const lenses = rows(
    [
      "iPhone 16 Pro · 24mm main",
      "Sony FE 24–70mm f/2.8 GM II",
      "iPhone 16 Pro · 13mm ultra wide",
      "Sony FE 70–200mm f/4 G",
      "Canon RF 35mm f/1.8 Macro",
      "Every other lens",
    ],
    allocate(Math.min(photos, withCamera), [31, 19, 12, 9, 7, 22]),
  );

  const geotagged =
    metadata.find((row) => row.name === "GPS location")?.present ??
    Math.floor(items * 0.64);
  const places = rows(
    [
      "Banff",
      "Lake Louise",
      "Jasper",
      "Vancouver",
      "Toronto",
      "Lisbon",
      "Kyoto",
      "Reykjavík",
      "Everywhere else",
    ],
    allocate(geotagged, [14, 9, 7, 12, 10, 5, 4, 3, 36]),
  );
  const countries = geotagged ? Math.min(23, 6 + Math.floor(geotagged / 9000)) : 0;
  const cities = geotagged ? Math.min(412, 40 + Math.floor(geotagged / 380)) : 0;

  const facesDetected = Math.floor(photos * 1.7);
  const faceShares = allocate(facesDetected, [23, 19, 17, 41]);
  const people = [
    { name: "Emma", image: "/media/avatar-emma.png", count: faceShares[0] },
    { name: "Jamie", image: "/media/avatar-jamie.png", count: faceShares[1] },
    { name: "Taylor", image: "/media/avatar-taylor.png", count: faceShares[2] },
    { name: "Everyone else", image: null, count: faceShares[3] },
  ];
  const namedPeople = items ? Math.min(186, 12 + Math.floor(items / 1100)) : 0;
  const photosWithFaces = Math.floor(photos * 0.58);
  const facesPerPhoto = photosWithFaces
    ? Number((facesDetected / photosWithFaces).toFixed(1))
    : 0;
  const pets = items ? 3 : 0;

  const metadataPercent = (name) =>
    metadata.find((row) => row.name === name)?.percent ?? 0;
  const coverage = [
    { name: "Dated", percent: metadataPercent("Capture date") },
    { name: "Located", percent: metadataPercent("GPS location") },
    { name: "Described by AI", percent: metadataPercent("AI description") },
    { name: "Faces checked", percent: items ? 97.8 : 0 },
    { name: "Search indexed", percent: items ? 99.1 : 0 },
    { name: "Checksummed", percent: metadataPercent("Original checksum") },
  ];

  const busiest = days.reduce(
    (best, day) => (day.captured > (best?.captured ?? -1) ? day : best),
    null,
  );
  const watchSeconds = videos * 41;
  const records = {
    oldest: OLDEST_CAPTURE,
    busiestDay: busiest ? { date: busiest.date, count: busiest.captured } : null,
    streak: longestStreak(days),
    largestFile: videos
      ? { name: "Moraine sunrise, 4K Dolby Vision", bytes: 8.4 * 1024 ** 3 }
      : null,
    longestVideo: videos ? { name: "Kids’ recital", seconds: 6130 } : null,
    watchHours: Math.round(watchSeconds / 3600),
    // 0.3 mm per 6×4 print; 152.4 mm long edge.
    printStackMetres: Number(((photos * 0.3) / 1000).toFixed(1)),
    printLineKm: Number(((photos * 152.4) / 1_000_000).toFixed(1)),
    perDay: days.length
      ? Math.round(days.reduce((n, day) => n + day.captured, 0) / days.length)
      : 0,
  };

  return {
    span: { from: FIRST_YEAR, through: LAST_YEAR, years: LAST_YEAR - FIRST_YEAR + 1 },
    years,
    punchcard,
    peak: { day: WEEKDAYS[Math.floor(peak / 24)], hour: peak % 24 },
    photoFormats,
    videoResolutions,
    orientation,
    livePhotos,
    hdr,
    dolbyVision,
    focalLengths,
    lenses,
    places,
    geotagged,
    countries,
    cities,
    people,
    facesDetected,
    namedPeople,
    photosWithFaces,
    facesPerPhoto,
    pets,
    coverage,
    records,
  };
}
