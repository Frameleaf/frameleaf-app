import { AlbumCollectionResponseDto, AlbumResponseDto, AlbumTreeResponseDto } from 'src/dtos/album.dto.js';
import { AlbumKind } from 'src/enum.js';

/**
 * Arrange the albums a user can see into the directory shape the Albums page
 * and the rail consume: collections with their albums, albums that stand on
 * their own, and shared spaces. The input order (display order from the
 * repository) is preserved inside every group.
 *
 * Rules, applied to whatever is stored:
 * - Every collection is a shelf, even one saved with a parent before the
 *   one-level rule existed; collections never render nested.
 * - An album belongs to a collection only when that collection is visible to
 *   the same user. An album whose parent is invisible (or is not a collection)
 *   stands on its own rather than disappearing.
 * - Shared spaces are always top level.
 */
export const buildAlbumTree = (albums: AlbumResponseDto[]): AlbumTreeResponseDto => {
  const collections = albums.filter((album) => album.kind === AlbumKind.Collection);
  const spaces = albums.filter((album) => album.kind === AlbumKind.Space);
  const collectionIds = new Set(collections.map(({ id }) => id));
  const plainAlbums = albums.filter((album) => album.kind === AlbumKind.Album);

  const shelves: AlbumCollectionResponseDto[] = collections.map((collection) => {
    const members = plainAlbums.filter((album) => album.parentId === collection.id);
    return {
      collection,
      albums: members,
      albumCount: members.length,
      assetCount: members.reduce((total, album) => total + album.assetCount, collection.assetCount),
    };
  });

  const standalone = plainAlbums.filter((album) => !(album.parentId && collectionIds.has(album.parentId)));

  return { collections: shelves, albums: standalone, spaces };
};

/**
 * Put every group of a directory in the person's custom order (FL-52). Items they placed come
 * first, by position; items never placed keep the order they arrived in (the repository's display
 * order) after them, so a new album shows up at the end of its group until it is arranged.
 */
export const orderAlbumTree = (tree: AlbumTreeResponseDto, positions: Map<string, number>): AlbumTreeResponseDto => {
  if (positions.size === 0) {
    return tree;
  }
  const order = <T>(items: T[], idOf: (item: T) => string): T[] =>
    items
      .map((item, index) => ({ item, index, position: positions.get(idOf(item)) }))
      .sort(
        (left, right) =>
          (left.position ?? Number.MAX_SAFE_INTEGER) - (right.position ?? Number.MAX_SAFE_INTEGER) ||
          left.index - right.index,
      )
      .map(({ item }) => item);

  return {
    collections: order(tree.collections, (node) => node.collection.id).map((node) => ({
      ...node,
      albums: order(node.albums, (album) => album.id),
    })),
    albums: order(tree.albums, (album) => album.id),
    spaces: order(tree.spaces, (album) => album.id),
  };
};

type DirectoryItem = { id: string; kind: string; parentId: string | null };

/**
 * The group of a person's directory an order applies to (FL-52): the albums inside one visible
 * collection, or — at the top level — the collections, the albums that stand on their own, or the
 * shared spaces, picked by the kind of the first id. Undefined when the group cannot be named
 * (an unknown collection, or a first id the person cannot see).
 */
export const albumOrderGroup = (
  items: DirectoryItem[],
  parentId: string | null,
  firstId: string,
): string[] | undefined => {
  const collectionIds = new Set(items.filter((item) => item.kind === AlbumKind.Collection).map(({ id }) => id));
  if (parentId !== null) {
    if (!collectionIds.has(parentId)) {
      return undefined;
    }
    return items.filter((item) => item.kind === AlbumKind.Album && item.parentId === parentId).map(({ id }) => id);
  }
  const first = items.find((item) => item.id === firstId);
  if (!first) {
    return undefined;
  }
  switch (first.kind) {
    case AlbumKind.Collection: {
      return items.filter((item) => item.kind === AlbumKind.Collection).map(({ id }) => id);
    }
    case AlbumKind.Space: {
      return items.filter((item) => item.kind === AlbumKind.Space).map(({ id }) => id);
    }
    default: {
      return items
        .filter((item) => item.kind === AlbumKind.Album && !(item.parentId && collectionIds.has(item.parentId)))
        .map(({ id }) => id);
    }
  }
};
