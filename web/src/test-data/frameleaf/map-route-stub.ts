/** FL-1216: the `onOpenAsset` the map route handed `MapScreenStub.svelte`, so a spec can open an item. */
export const mapRouteStub: {
  open?: (assetId: string, inView: string[], more?: () => Promise<string[]>) => void;
} = {};
