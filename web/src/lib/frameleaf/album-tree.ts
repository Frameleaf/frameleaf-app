import type { AlbumResponseDto } from '@immich/sdk';

/**
 * Client-side album/collection tree adapter for the Frameleaf rail (FL-30).
 *
 * Vocabulary (see design/frameleaf/INTERACTION-REQUIREMENTS.md, September 22, 2026):
 * an **album** holds photos, a **collection** is a named group of albums exactly one
 * level deep, and a **shared space** stays at the top level. Nothing is a
 * "subcollection".
 *
 * Production does not yet expose a collection tree endpoint; albums already carry
 * `parentId`, `icon`, `shared` and `sortOrder`, so this module derives the shape the
 * rail needs from the existing albums API. FL-52 replaces the body of
 * {@link buildAlbumTree} with the real tree endpoint. Everything the rail knows about
 * nesting lives in this one file on purpose, so that swap stays a single-file change:
 * the exported types are the contract the rail renders against.
 */

export type FrameleafAlbumKind = 'album' | 'collection' | 'space';

export interface FrameleafAlbumNode {
  id: string;
  name: string;
  /** Stored album icon key, or null for the default. Resolve with `albumIconPath`. */
  icon: string | null;
  kind: FrameleafAlbumKind;
  assetCount: number;
  shared: boolean;
  /** Albums inside a collection. Always empty for `album` and `space` nodes. */
  children: FrameleafAlbumNode[];
}

export interface FrameleafAlbumTree {
  /** Collections (albums that contain other albums), each with its albums. */
  collections: FrameleafAlbumNode[];
  /** Albums that stand on their own. */
  albums: FrameleafAlbumNode[];
  /** Shared spaces, always top level. */
  spaces: FrameleafAlbumNode[];
}

export const emptyAlbumTree = (): FrameleafAlbumTree => ({ collections: [], albums: [], spaces: [] });

/**
 * Siblings order by the explicit `sortOrder` first (nulls last, matching the albums
 * grid), then by name using the caller's locale collation, then by id so the result is
 * stable for two albums that are otherwise identical.
 */
const compareNodes = (a: AlbumResponseDto, b: AlbumResponseDto) => {
  const left = a.sortOrder ?? Number.MAX_SAFE_INTEGER;
  const right = b.sortOrder ?? Number.MAX_SAFE_INTEGER;
  if (left !== right) {
    return left - right;
  }

  const byName = a.albumName.localeCompare(b.albumName);
  return byName === 0 ? a.id.localeCompare(b.id) : byName;
};

/**
 * A shared space has people in it. `albumUsers` starts with the owner, so more than one
 * entry means the album is shared with someone. `shared` alone is not enough: it is
 * also true for an album that merely has a public link.
 */
const isSharedSpace = (album: AlbumResponseDto) => album.albumUsers.length > 1;

const toNode = (album: AlbumResponseDto, kind: FrameleafAlbumKind): FrameleafAlbumNode => ({
  id: album.id,
  name: album.albumName,
  icon: album.icon,
  kind,
  assetCount: album.assetCount,
  shared: album.shared,
  children: [],
});

/**
 * Resolve the top-level ancestor of an album, guarding against a parent that is not in
 * the list (shared away, deleted, or filtered out) and against a cycle in `parentId`.
 * A cycle promotes the album itself to top level, so that corrupt links can never drop
 * an album out of the rail or spin the walk.
 */
const findRootId = (album: AlbumResponseDto, byId: Map<string, AlbumResponseDto>) => {
  const seen = new Set<string>([album.id]);
  let current = album;

  while (current.parentId) {
    const parent = byId.get(current.parentId);
    if (!parent) {
      // Parent shared away, deleted or filtered out: promote the highest album we can
      // still see, as the legacy album tree does.
      return current.id;
    }
    if (seen.has(parent.id)) {
      return album.id;
    }
    seen.add(parent.id);
    current = parent;
  }

  return current.id;
};

/**
 * Build the rail's tree from a flat list of albums.
 *
 * Classification rules, all derived from data that exists today:
 * - a top-level album with other members is a **shared space**. Membership, not a
 *   public link: an album that only carries a shared link stays an album, and its link
 *   is reached from Shared links;
 * - a top-level album that has at least one descendant is a **collection**;
 * - every other top-level album is an **album**;
 * - descendants of a collection are its albums. Deeper descendants are hoisted to that
 *   same level, because a collection is one level deep and a subcollection does not
 *   exist in this product.
 *
 * Callers decide which albums to pass in; the rail passes everything `getAllAlbums({})`
 * returns, which is the account's own albums plus the ones shared with it. The adapter
 * never fetches and never filters by ownership itself.
 */
export const buildAlbumTree = (albums: AlbumResponseDto[]): FrameleafAlbumTree => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const sorted = [...albums].sort(compareNodes);

  const roots: AlbumResponseDto[] = [];
  const descendantsByRoot = new Map<string, AlbumResponseDto[]>();

  for (const album of sorted) {
    const rootId = findRootId(album, byId);
    if (rootId === album.id) {
      roots.push(album);
      continue;
    }

    const existing = descendantsByRoot.get(rootId);
    if (existing) {
      existing.push(album);
    } else {
      descendantsByRoot.set(rootId, [album]);
    }
  }

  const tree = emptyAlbumTree();

  for (const root of roots) {
    const descendants = descendantsByRoot.get(root.id) ?? [];

    if (isSharedSpace(root)) {
      // A shared space stays top level. Albums inside it are reached from its page,
      // not from the rail, so the rail does not nest them under the space.
      tree.spaces.push(toNode(root, 'space'));
      continue;
    }

    if (descendants.length === 0) {
      tree.albums.push(toNode(root, 'album'));
      continue;
    }

    const collection = toNode(root, 'collection');
    collection.children = descendants.map((album) => toNode(album, 'album'));
    tree.collections.push(collection);
  }

  return tree;
};

/** Every node in the tree, in rail order. Used for active-state and palette lookups. */
export const flattenAlbumTree = (tree: FrameleafAlbumTree): FrameleafAlbumNode[] => [
  ...tree.collections.flatMap((collection) => [collection, ...collection.children]),
  ...tree.albums,
  ...tree.spaces,
];
