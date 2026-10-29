import type { CaptureAlbumChoice } from '@frameleaf/sdk';

/** Collection colours, matching the Boards palette in the web app. */
export const COLLECTION_COLOURS = {
  grey: '#8b95a1',
  green: '#3fb46a',
  teal: '#0ea5a0',
  blue: '#3b82f6',
  purple: '#8b6cf0',
  pink: '#d9639b',
  amber: '#d9a441',
  red: '#ef5350',
} as const;
export type CollectionColour = keyof typeof COLLECTION_COLOURS;
export const isCollectionColour = (value: unknown): value is CollectionColour =>
  typeof value === 'string' && Object.hasOwn(COLLECTION_COLOURS, value);

/** A collection (album) you can save into; the colour is shown when the server sends one. */
export type CollectionChoice = CaptureAlbumChoice;

export const collectionColour = (collection?: CollectionChoice) =>
  isCollectionColour(collection?.color)
    ? COLLECTION_COLOURS[collection.color]
    : undefined;

/** Names from the top level down to the collection, ignoring cycles. */
export function collectionPath(
  collections: CollectionChoice[],
  id: string,
): string[] {
  const byId = new Map(collections.map((value) => [value.id, value]));
  const names: string[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id) && names.length < 32) {
    seen.add(current.id);
    names.unshift(current.albumName);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return names;
}

/** Collections in tree order (each followed by the ones inside it), with their depth. */
export function collectionTree(
  collections: CollectionChoice[],
): { collection: CollectionChoice; depth: number; hasChildren: boolean }[] {
  const ids = new Set(collections.map((value) => value.id));
  const children = new Map<string | null, CollectionChoice[]>();
  for (const value of collections) {
    const parent =
      value.parentId && ids.has(value.parentId) ? value.parentId : null;
    children.set(parent, [...(children.get(parent) ?? []), value]);
  }
  for (const list of children.values())
    list.sort((a, b) => a.albumName.localeCompare(b.albumName));
  const ordered: {
    collection: CollectionChoice;
    depth: number;
    hasChildren: boolean;
  }[] = [];
  const seen = new Set<string>();
  const walk = (parent: string | null, depth: number) => {
    for (const collection of children.get(parent) ?? []) {
      if (seen.has(collection.id)) continue;
      seen.add(collection.id);
      ordered.push({
        collection,
        depth,
        hasChildren: !!children.get(collection.id)?.length,
      });
      walk(collection.id, Math.min(depth + 1, 8));
    }
  };
  walk(null, 0);
  // Anything left over sits in a cycle; list it at the top level so it can still be chosen.
  for (const collection of collections)
    if (!seen.has(collection.id)) {
      seen.add(collection.id);
      ordered.push({ collection, depth: 0, hasChildren: false });
    }
  return ordered;
}
