/**
 * The viewer's "n of N" (V-12, MediaViewer.jsx:949 and 1707-1709): where the open item sits in the
 * collection the viewer moves through. Only what the caller already holds is read, so an item whose
 * place is unknown simply has no position.
 */
export type ViewerPosition = { index: number; total: number };

type Month = { assetsCount: number; getAssets: () => { id: string }[] };

/** The position in a list the caller holds (search results, an album's items). */
export const positionInList = (ids: readonly string[], assetId: string): ViewerPosition | null => {
  const index = ids.indexOf(assetId);
  return index === -1 ? null : { index, total: ids.length };
};

/**
 * The position in a timeline: every item of the months before the open one (their counts are known
 * without loading them), plus the item's place in its own, loaded month.
 */
export const positionInTimeline = (months: readonly Month[] | undefined, assetId: string): ViewerPosition | null => {
  if (!months) {
    return null;
  }
  let before = 0;
  let total = 0;
  let found: number | null = null;
  for (const month of months) {
    if (found === null) {
      const index = month.getAssets().findIndex((asset) => asset.id === assetId);
      if (index === -1) {
        before += month.assetsCount;
      } else {
        found = before + index;
      }
    }
    total += month.assetsCount;
  }
  return found === null ? null : { index: found, total };
};
