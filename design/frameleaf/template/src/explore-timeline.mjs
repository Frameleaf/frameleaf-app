// Source references: web/src/routes/(user)/explore and components/timeline.
// These helpers derive sample views only from the caller's accessible, scoped assets.
export function captureDate(asset) {
  const value = asset.takenAt || asset.localDateTime || asset.date;
  if (typeof value !== "string") return null;
  // Preserve the recorded local calendar day; parsing a date through the host
  // timezone can incorrectly move a capture to a different day or month.
  const match = /^(\d{4})-(\d{2})-(\d{1,2})(?:T|$)/.exec(value);
  if (!match || Number(match[1]) < 1) return null;
  const [, year, month, day] = match;
  const date = new Date(0);
  date.setUTCFullYear(Number(year), Number(month) - 1, Number(day));
  date.setUTCHours(12, 0, 0, 0);
  if (
    date.getUTCFullYear() !== Number(year) ||
    date.getUTCMonth() !== Number(month) - 1 ||
    date.getUTCDate() !== Number(day)
  )
    return null;
  return {
    year,
    month: `${year}-${month}`,
    day: `${year}-${month}-${day.padStart(2, "0")}`,
    date,
  };
}
export function localCaptureTime(asset) {
  const value = asset.takenAt || asset.localDateTime;
  const match = typeof value === "string" && /T(\d{2}):(\d{2})/.exec(value);
  return match && Number(match[1]) < 24 && Number(match[2]) < 60
    ? `${match[1]}:${match[2]}`
    : null;
}
export const videoAsset = (asset) => ["video", "VIDEO"].includes(asset.type);
const uniqueAssets = (assets) => [
  ...new Map(
    assets
      .filter((asset) => asset && typeof asset.id === "string")
      .map((asset) => [asset.id, asset]),
  ).values(),
];
const format = (date, options) =>
  new Intl.DateTimeFormat("en", { ...options, timeZone: "UTC" }).format(date);
export const monthTitle = (date) =>
  format(date, { month: "long", year: "numeric" });
export function chronologicalAssets(assets, order = "desc") {
  return uniqueAssets(assets).sort((a, b) => {
    const first = captureDate(a),
      second = captureDate(b);
    if (!first) return second ? 1 : 0;
    if (!second) return -1;
    const comparison =
      first.day.localeCompare(second.day) ||
      (localCaptureTime(a) || "").localeCompare(localCaptureTime(b) || "");
    return order === "asc" ? comparison : -comparison;
  });
}
export function timelineGroups(assets, grouping = "day", order = "desc") {
  const mode = { years: "year", months: "month" }[grouping] || grouping;
  const groups = new Map();
  for (const asset of chronologicalAssets(assets, order)) {
    const captured = captureDate(asset);
    const key =
      mode === "all"
        ? "all"
        : captured
          ? captured[["year", "month"].includes(mode) ? mode : "day"]
          : "undated";
    if (!groups.has(key))
      groups.set(key, {
        id: key,
        title:
          mode === "all"
            ? "All photos and videos"
            : !captured
              ? "Date unknown"
              : mode === "year"
                ? captured.year
                : mode === "month"
                  ? monthTitle(captured.date)
                  : format(captured.date, {
                      weekday: "long",
                      month: "long",
                      day: "numeric",
                      year: "numeric",
                    }),
        assets: [],
      });
    groups.get(key).assets.push(asset);
  }
  return [...groups.values()];
}
export function timelineMonths(assets, order = "desc") {
  const months = new Map();
  for (const asset of chronologicalAssets(assets, order)) {
    const captured = captureDate(asset);
    if (!captured) continue;
    if (!months.has(captured.month))
      months.set(captured.month, {
        id: captured.month,
        year: captured.year,
        label: monthTitle(captured.date),
        shortLabel: format(captured.date, { month: "short" }),
        firstAssetId: asset.id,
        count: 0,
      });
    months.get(captured.month).count++;
  }
  return [...months.values()];
}
const setValues = (asset, key, fallback) => [
  ...new Set(
    (asset[key] || asset[fallback] || []).filter(
      (value) => typeof value === "string" && value.trim(),
    ),
  ),
];
function buckets(assets, values, query) {
  const results = new Map();
  for (const asset of assets)
    for (const value of values(asset)) {
      if (!results.has(value))
        results.set(value, {
          id: value,
          label: value,
          count: 0,
          cover: asset,
          query: query(value),
        });
      results.get(value).count++;
    }
  return [...results.values()].sort(
    (a, b) => b.count - a.count || a.label.localeCompare(b.label),
  );
}
export function exploreSections(input, people = []) {
  const assets = chronologicalAssets(input);
  const persons = buckets(
    assets,
    (asset) => setValues(asset, "personIds", "people"),
    (id) => ({ filter: { personIds: { any: [id] } } }),
  );
  const known = new Map(
    people
      .filter((person) => !person.isHidden && !person.hidden)
      .map((person) => [person.id, person]),
  );
  const places = buckets(
    assets,
    (asset) =>
      typeof asset.city === "string" && asset.city.trim() ? [asset.city] : [],
    (city) => ({ filter: { city: { eq: city } } }),
  );
  const things = buckets(
    assets,
    (asset) => setValues(asset, "tagIds", "tags"),
    (tag) => ({ filter: { tagIds: { any: [tag] } } }),
  );
  const collections = buckets(
    assets,
    (asset) => setValues(asset, "albumIds"),
    () => null,
  );
  const favorites = assets.filter(
    (asset) => asset.isFavorite ?? asset.favorite,
  );
  const videos = assets.filter(videoAsset);
  const photos = assets.filter((asset) => !videoAsset(asset));
  const noPeople = assets.filter(
    (asset) => !setValues(asset, "personIds", "people").length,
  );
  const hasQualityScores = assets.some((asset) =>
    Number.isFinite(asset.bestPhotosScore),
  );
  const best = [...assets]
    .filter((asset) =>
      hasQualityScores
        ? Number.isFinite(asset.bestPhotosScore) && asset.bestPhotosScore >= 90
        : typeof asset.rating === "number" && asset.rating >= 4,
    )
    .sort((a, b) =>
      hasQualityScores
        ? b.bestPhotosScore - a.bestPhotosScore
        : b.rating - a.rating,
    );

  return {
    assets,
    people: persons
      .filter((item) => known.has(item.id))
      .map((item) => ({
        ...item,
        person: known.get(item.id),
        label: known.get(item.id).name,
      })),
    places,
    things,
    collections,
    best,
    hasQualityScores,
    memories: timelineGroups(assets)
      .filter((group) => group.id !== "undated")
      .slice(0, 5)
      .map((group) => {
        const next = captureDate(group.assets[0]).date;
        next.setUTCDate(next.getUTCDate() + 1);
        return {
          ...group,
          cover: group.assets[0],
          query: {
            filter: {
              takenAt: {
                gte: `${group.id}T00:00:00`,
                lt: `${next.toISOString().slice(0, 10)}T00:00:00`,
              },
            },
          },
        };
      }),
    shortcuts: [
      {
        id: "favorites",
        label: "Favorites",
        icon: "mdiHeartOutline",
        count: favorites.length,
        cover: favorites[0],
        query: { filter: { isFavorite: { eq: true } } },
      },
      {
        id: "videos",
        label: "Videos",
        icon: "mdiMovieOpenOutline",
        count: videos.length,
        cover: videos[0],
        query: { filter: { type: { eq: "VIDEO" } } },
      },
      {
        id: "photos",
        label: "Photos",
        icon: "mdiCameraOutline",
        count: photos.length,
        cover: photos[0],
        query: { filter: { type: { eq: "IMAGE" } } },
      },
      {
        id: "without-people",
        label: "Without people",
        icon: "mdiImageSearchOutline",
        count: noPeople.length,
        cover: noPeople[0],
        query: { filter: { hasPeople: { eq: false } } },
      },
    ],
  };
}
/** Calendar month id ("YYYY-MM") for an asset, or null when undated. */
export const assetMonthId = (asset) => captureDate(asset)?.month ?? null;
/**
 * Scrubber model: months and years positioned along a 0..1 track in proportion
 * to how many items they hold, in the same order as the timeline groups.
 */
export function timelineScrubber(assets, order = "desc") {
  const months = timelineMonths(assets, order);
  const total = months.reduce((sum, month) => sum + month.count, 0);
  let offset = 0;
  const marks = months.map((month) => {
    const start = total ? offset / total : 0;
    offset += month.count;
    const end = total ? offset / total : 0;
    return { ...month, start, end, center: (start + end) / 2 };
  });
  const years = [];
  for (const month of marks) {
    const last = years.at(-1);
    if (!last || last.year !== month.year)
      years.push({
        year: month.year,
        start: month.start,
        end: month.end,
        center: 0,
        count: 0,
        firstAssetId: month.firstAssetId,
      });
    const year = years.at(-1);
    year.end = month.end;
    year.count += month.count;
    year.center = (year.start + year.end) / 2;
  }
  return { total, months: marks, years };
}
/** The month covering a 0..1 track position (clamped), or null when empty. */
export function scrubberMonthAt(scrubber, fraction) {
  const months = scrubber?.months || [];
  if (!months.length) return null;
  const value = Math.min(1, Math.max(0, Number(fraction) || 0));
  return (
    months.find((month) => value >= month.start && value < month.end) ||
    months.at(-1)
  );
}
