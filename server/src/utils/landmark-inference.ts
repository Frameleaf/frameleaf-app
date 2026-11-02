export const LANDMARK_INFERENCE_WINDOW_MS = 5 * 60_000;
export const LANDMARK_VISUAL_MAX_DISTANCE = 0.12;

export type TemporalReference = { id: string; takenAt: Date; latitude: number; longitude: number };
export type VisualReference = { id: string; distance: number; landmarkIds: string[] };

/** Adjacent GPS readings must agree to within 200m; never infer along a journey between places. */
export const selectTemporalReference = (candidates: TemporalReference[], at: Date): TemporalReference | undefined => {
  const nearby = candidates.filter(
    (item) => Math.abs(item.takenAt.getTime() - at.getTime()) <= LANDMARK_INFERENCE_WINDOW_MS,
  );
  const before = nearby
    .filter((item) => item.takenAt <= at)
    .sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime())[0];
  const after = nearby.filter((item) => item.takenAt > at).sort((a, b) => a.takenAt.getTime() - b.takenAt.getTime())[0];
  if (before && after) {
    const radians = Math.PI / 180;
    const lat = Math.sin(((after.latitude - before.latitude) * radians) / 2);
    const lon = Math.sin(((after.longitude - before.longitude) * radians) / 2);
    const distance =
      2 *
      6_371_000 *
      Math.asin(
        Math.min(
          1,
          Math.sqrt(lat * lat + Math.cos(before.latitude * radians) * Math.cos(after.latitude * radians) * lon * lon),
        ),
      );
    if (distance > 200) return;
  }
  return [before, after]
    .filter((item): item is TemporalReference => !!item)
    .sort(
      (a, b) =>
        Math.abs(a.takenAt.getTime() - at.getTime()) - Math.abs(b.takenAt.getTime() - at.getTime()) ||
        a.id.localeCompare(b.id),
    )[0];
};

/** Only agreement among the closest independent photos is evidence, never a chain of predictions. */
export const selectVisualLandmarks = (
  candidates: VisualReference[],
): { landmarkIds: string[]; sourceAssetIds: string[] } | undefined => {
  const close = candidates
    .filter((item) => Number.isFinite(item.distance) && item.distance <= LANDMARK_VISUAL_MAX_DISTANCE)
    .slice(0, 3);
  if (close.length < 2) return;
  const landmarkIds = close[0].landmarkIds.filter((id) => close.every((item) => item.landmarkIds.includes(id)));
  if (landmarkIds.length > 0) return { landmarkIds, sourceAssetIds: close.map(({ id }) => id) };
};
