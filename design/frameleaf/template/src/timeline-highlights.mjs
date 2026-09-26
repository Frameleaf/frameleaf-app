// Curated Years and Months views for the timeline, modelled on Apple Photos:
// one card per period with a key photo, its highlights, a count and the top places.
import {
  captureDate,
  chronologicalAssets,
  localCaptureTime,
  timelineGroups,
} from "./explore-timeline.mjs";

const score = (asset) =>
  Number.isFinite(asset?.bestPhotosScore) ? asset.bestPhotosScore : null;
const rating = (asset) =>
  Number.isFinite(asset?.rating) && asset.rating > 0 ? asset.rating : null;
const sortKey = (asset) =>
  `${captureDate(asset)?.day ?? ""}T${localCaptureTime(asset) ?? ""}`;
// Descending, with missing values last.
const higher = (a, b) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : b - a;

/**
 * Key-photo order: highest bestPhotosScore first, then highest rating, then the
 * most recent capture, then id so the pick is stable across renders.
 */
export function compareKeyAssets(a, b) {
  return (
    higher(score(a), score(b)) ||
    higher(rating(a), rating(b)) ||
    sortKey(b).localeCompare(sortKey(a)) ||
    String(a.id).localeCompare(String(b.id))
  );
}

/** The best `count` assets for a period, key photo first. */
export function keyAssets(assets = [], count = 1) {
  return [...assets]
    .filter((asset) => asset && typeof asset.id === "string")
    .sort(compareKeyAssets)
    .slice(0, Math.max(0, count));
}

/** The single key photo for a period, or null when it has none. */
export const keyAsset = (assets) => keyAssets(assets, 1)[0] ?? null;

/** Most frequent places (city, falling back to state or country), busiest first. */
export function topPlaces(assets = [], limit = 3) {
  const counts = new Map();
  for (const asset of assets) {
    const place = [asset?.city, asset?.state, asset?.country].find(
      (value) => typeof value === "string" && value.trim(),
    );
    if (place) counts.set(place.trim(), (counts.get(place.trim()) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit)
    .map(([place]) => place);
}

/** "Banff, Lake Louise and Jasper" style summary for a card. */
export function placeSummary(places = []) {
  if (places.length < 2) return places[0] ?? "";
  return `${places.slice(0, -1).join(", ")} and ${places.at(-1)}`;
}

/**
 * Cards for the curated Years ("years") or Months ("months") timeline.
 * Each card: { id, kind, title, year, count, key, highlights, places,
 * placeLabel, firstAssetId }. `id` matches the timeline group id ("2026",
 * "2026-08" or "undated"), so it is also the prefix of the finer groups a card
 * opens. Month cards carry up to `highlightCount` more photos as highlights.
 */
export function timelineCards(
  assets = [],
  grouping = "years",
  { order = "desc", highlightCount = 4, placeLimit = 3 } = {},
) {
  const kind = grouping === "months" || grouping === "month" ? "month" : "year";
  return timelineGroups(assets, kind, order).map((group) => {
    const ranked = keyAssets(
      group.assets,
      kind === "month" ? highlightCount + 1 : 1,
    );
    const places = topPlaces(group.assets, placeLimit);
    return {
      id: group.id,
      kind,
      title: group.title,
      year: group.id === "undated" ? null : group.id.slice(0, 4),
      count: group.assets.length,
      key: ranked[0] ?? null,
      // Highlights read left to right in capture order, like a filmstrip.
      highlights:
        kind === "month" ? chronologicalAssets(ranked.slice(1), order) : [],
      places,
      placeLabel: placeSummary(places),
      firstAssetId: group.assets[0]?.id ?? null,
    };
  });
}

/**
 * Where opening a card leads: a year opens Months at that year, a month opens
 * Days at that month. `groupPrefix` is the group id prefix to scroll to.
 */
export function drillTarget(card) {
  if (!card) return null;
  return {
    grouping: card.kind === "year" ? "months" : "days",
    groupPrefix: card.id,
  };
}

/** First group id in `groupIds` that belongs to `prefix` ("2026" → "2026-08"). */
export function firstGroupWithPrefix(groupIds = [], prefix) {
  if (!prefix) return null;
  return (
    groupIds.find(
      (id) =>
        id === prefix || (prefix !== "undated" && id.startsWith(`${prefix}-`)),
    ) ?? null
  );
}
