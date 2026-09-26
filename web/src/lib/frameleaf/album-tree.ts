import type { AlbumCollectionResponseDto, AlbumResponseDto, AlbumTreeResponseDto } from '@immich/sdk';

/**
 * Album/collection/shared-space tree adapter for the Frameleaf rail (FL-30, FL-55).
 *
 * Vocabulary (see design/frameleaf/INTERACTION-REQUIREMENTS.md, September 22, 2026):
 * an **album** holds photos, a **collection** is a named group of albums exactly one
 * level deep, and a **shared space** stays at the top level. Nothing is a
 * "subcollection".
 *
 * FL-52 added the real directory endpoint, `GET /albums/tree`, which already applies
 * every classification and access rule server-side (`AlbumTreeResponseDto`: collections
 * with their albums, standalone albums, and top-level shared spaces). This module is now
 * a thin, one-to-one shape adapter from that response to the rail's own node type — it
 * derives nothing and orders nothing; the server response is already in display order.
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

const toNode = (
  album: AlbumResponseDto,
  kind: FrameleafAlbumKind,
  children: FrameleafAlbumNode[] = [],
): FrameleafAlbumNode => ({
  id: album.id,
  name: album.albumName,
  icon: album.icon,
  kind,
  assetCount: album.assetCount,
  shared: album.shared,
  children,
});

const toCollectionNode = (entry: AlbumCollectionResponseDto): FrameleafAlbumNode =>
  toNode(
    entry.collection,
    'collection',
    entry.albums.map((album) => toNode(album, 'album')),
  );

/**
 * Map the real album directory response onto the rail's node shape. One to one:
 * `collections[].collection`/`collections[].albums` become a collection node with its
 * children, `albums` become album nodes, and `spaces` become space nodes — always top
 * level, never nested.
 */
export const buildAlbumTree = (tree: AlbumTreeResponseDto): FrameleafAlbumTree => ({
  collections: tree.collections.map((collection) => toCollectionNode(collection)),
  albums: tree.albums.map((album) => toNode(album, 'album')),
  spaces: tree.spaces.map((album) => toNode(album, 'space')),
});

/** Every node in the tree, in rail order. Used for active-state and palette lookups. */
export const flattenAlbumTree = (tree: FrameleafAlbumTree): FrameleafAlbumNode[] => [
  ...tree.collections.flatMap((collection) => [collection, ...collection.children]),
  ...tree.albums,
  ...tree.spaces,
];
