import { AlbumKind, getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
import { canEdit } from '$lib/frameleaf/album-directory';

/**
 * Where "Add to album" may put photos, loaded by the picker itself so it works from every view
 * (Photos, search, the Locked folder, people, pets, spaces, an album) without the caller having to
 * pass a list in.
 *
 * Vocabulary: an album holds photos; a collection groups albums one level deep and is not itself a
 * destination, so it only heads the albums inside it; a shared space stays at the top level and
 * takes photos like an album. Only albums and spaces the signed-in user owns or edits are offered.
 */

export interface AlbumTarget {
  id: string;
  name: string;
  count: number;
  kind: 'album' | 'space';
}

export interface AlbumTargetCollection {
  id: string;
  name: string;
  albums: AlbumTarget[];
}

export interface AlbumTargetDirectory {
  /** Albums that stand on their own (not inside a collection the user can see). */
  albums: AlbumTarget[];
  /** Collections with at least one album the user may add to. */
  collections: AlbumTargetCollection[];
  /** Shared spaces, always top level. */
  spaces: AlbumTarget[];
}

/** One rendered line of the picker: a collection heading or a selectable target. */
export type AlbumTargetRow =
  { type: 'collection'; id: string; name: string } | { type: 'target'; target: AlbumTarget; nested: boolean };

export const emptyAlbumTargets = (): AlbumTargetDirectory => ({ albums: [], collections: [], spaces: [] });

const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

const toTarget = (album: AlbumResponseDto, kind: AlbumTarget['kind'], unnamed: string): AlbumTarget => ({
  id: album.id,
  name: album.albumName || unnamed,
  count: album.assetCount,
  kind,
});

/**
 * Group the flat album list (`GET /albums`: everything the user owns or is a member of) into the
 * picker's shape. An album whose collection is not in the list stands on its own.
 */
export const buildAlbumTargets = (albums: AlbumResponseDto[], userId: string, unnamed = ''): AlbumTargetDirectory => {
  const collections = new Map<string, AlbumTargetCollection>();
  for (const album of albums) {
    if (album.kind === AlbumKind.Collection) {
      collections.set(album.id, { id: album.id, name: album.albumName || unnamed, albums: [] });
    }
  }

  const directory = emptyAlbumTargets();
  for (const album of albums) {
    if (album.kind === AlbumKind.Collection || !canEdit(album, userId)) {
      continue;
    }
    if (album.kind === AlbumKind.Space) {
      directory.spaces.push(toTarget(album, 'space', unnamed));
      continue;
    }
    const collection = album.parentId ? collections.get(album.parentId) : undefined;
    (collection ? collection.albums : directory.albums).push(toTarget(album, 'album', unnamed));
  }

  directory.albums.sort(byName);
  directory.spaces.sort(byName);
  directory.collections = [...collections.values()]
    .filter((collection) => collection.albums.length > 0)
    .map((collection) => ({ ...collection, albums: collection.albums.sort(byName) }))
    .sort(byName);
  return directory;
};

const tokensOf = (query: string) => query.trim().toLowerCase().split(/\s+/).filter(Boolean);
const matches = (name: string, tokens: string[]) => {
  const text = name.toLowerCase();
  return tokens.every((token) => text.includes(token));
};

/**
 * Narrow the directory to a search. A collection whose own name matches keeps every album in it;
 * otherwise it keeps only the albums that match, and disappears when none do.
 */
export const searchAlbumTargets = (directory: AlbumTargetDirectory, query: string): AlbumTargetDirectory => {
  const tokens = tokensOf(query);
  if (tokens.length === 0) {
    return directory;
  }
  const hit = (target: AlbumTarget) => matches(target.name, tokens);
  return {
    albums: directory.albums.filter((target) => hit(target)),
    collections: directory.collections
      .map((collection) =>
        matches(collection.name, tokens)
          ? collection
          : { ...collection, albums: collection.albums.filter((target) => hit(target)) },
      )
      .filter((collection) => collection.albums.length > 0),
    spaces: directory.spaces.filter((target) => hit(target)),
  };
};

/** Every selectable target, in picker order: albums on their own, albums in collections, spaces. */
export const flattenAlbumTargets = (directory: AlbumTargetDirectory): AlbumTarget[] => [
  ...directory.albums,
  ...directory.collections.flatMap((collection) => collection.albums),
  ...directory.spaces,
];

export const countAlbumTargets = (directory: AlbumTargetDirectory) => flattenAlbumTargets(directory).length;

/**
 * The rows the picker renders, capped at `limit` selectable targets so a large library opens
 * quickly; "Show more" raises the cap. A collection heading is shown only above albums that made
 * it into the page. Order: albums on their own, collections, then shared spaces.
 */
export const albumTargetRows = (
  directory: AlbumTargetDirectory,
  limit = Infinity,
): { rows: AlbumTargetRow[]; hasMore: boolean } => {
  const rows: AlbumTargetRow[] = [];
  let shown = 0;
  const push = (target: AlbumTarget, nested: boolean) => {
    if (!(shown < limit)) {
      return;
    }

    rows.push({ type: 'target', target, nested });
    shown++;
  };

  for (const album of directory.albums) {
    push(album, false);
  }
  for (const collection of directory.collections) {
    if (shown >= limit) {
      break;
    }
    rows.push({ type: 'collection', id: collection.id, name: collection.name });
    for (const album of collection.albums) {
      push(album, true);
    }
  }
  for (const space of directory.spaces) {
    push(space, false);
  }

  return { rows, hasMore: shown < countAlbumTargets(directory) };
};

/** Load every album and space the user may add to, straight from the album API. */
export const loadAlbumTargets = async (userId: string, unnamed = ''): Promise<AlbumTargetDirectory> =>
  buildAlbumTargets(await getAllAlbums({}), userId, unnamed);
