/**
 * The items the trash viewer moves to when the open item leaves the trash (FL-47, FL-71).
 *
 * `known` holds the neighbours the viewer looked up for the open item. A second delete or restore
 * can land before that lookup finishes, leaving them empty; they are then looked up directly from
 * the trash's own order, so the viewer moves on instead of closing.
 */
export const resolveTrashNeighbours = async <T>(
  items: ReadonlyArray<{ id: string }>,
  assetId: string,
  known: { nextAsset?: T; previousAsset?: T },
  loadAsset: (id?: string) => Promise<T | undefined>,
): Promise<{ nextAsset?: T; previousAsset?: T }> => {
  const index = items.findIndex((item) => item.id === assetId);
  const nextAsset = known.nextAsset ?? (index === -1 ? undefined : await loadAsset(items[index + 1]?.id));
  const previousAsset = known.previousAsset ?? (index > 0 ? await loadAsset(items[index - 1]?.id) : undefined);
  return { nextAsset, previousAsset };
};

/**
 * Where the trash viewer goes when the open item leaves the trash elsewhere (FL-47: restored or
 * deleted in another tab or on another device). The candidates, best first: the neighbours the
 * viewer already looked up, then the nearest items in the trash's own order, skipping everything
 * that left in the same change. Empty when nothing is left to show, and the viewer closes.
 */
export const survivingTrashNeighbours = (
  items: ReadonlyArray<{ id: string }>,
  assetId: string,
  known: { nextAsset?: { id: string }; previousAsset?: { id: string } },
  removed: ReadonlyArray<string>,
): string[] => {
  const gone = new Set([assetId, ...removed]);
  const index = items.findIndex((item) => item.id === assetId);
  const after = index === -1 ? undefined : items.slice(index + 1).find((item) => !gone.has(item.id))?.id;
  const before = index === -1 ? undefined : items.slice(0, index).findLast((item) => !gone.has(item.id))?.id;
  const candidates = [known.nextAsset?.id, known.previousAsset?.id, after, before].filter(
    (id): id is string => typeof id === 'string' && !gone.has(id),
  );
  return [...new Set(candidates)];
};
