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
