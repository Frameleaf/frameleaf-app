import type {
  AlbumCollectionResponseDto,
  AlbumHierarchyNode,
  AlbumHierarchyResponseDto,
  AlbumResponseDto,
  AlbumTreeResponseDto,
} from '@frameleaf/sdk';

export type FrameleafAlbumKind = 'album' | 'collection' | 'space';

export interface FrameleafAlbumNode {
  id: string;
  name: string;
  /** Stored MDI name or legacy key, or null for the default. Render with `AlbumIcon`. */
  icon: string | null;
  kind: FrameleafAlbumKind;
  assetCount: number;
  shared: boolean;
  /** Visible child albums and collections. */
  children: FrameleafAlbumNode[];
}

export interface FrameleafAlbumTree {
  roots?: FrameleafAlbumNode[];
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

/** Adapt recursive and legacy directory responses to shared navigation nodes. */
export const buildAlbumTree = (tree: AlbumTreeResponseDto | AlbumHierarchyResponseDto): FrameleafAlbumTree => {
  if ('roots' in tree) {
    const convert = (node: AlbumHierarchyNode): FrameleafAlbumNode =>
      toNode(
        node.album,
        node.album.kind as FrameleafAlbumKind,
        node.children.map((child) => convert(child)),
      );
    const nodes = tree.roots.map((root) => convert(root));
    return {
      roots: nodes,
      collections: nodes.filter(({ kind }) => kind === 'collection'),
      albums: nodes.filter(({ kind }) => kind === 'album'),
      spaces: nodes.filter(({ kind }) => kind === 'space'),
    };
  }
  return {
    collections: tree.collections.map((entry) => toCollectionNode(entry)),
    albums: tree.albums.map((album) => toNode(album, 'album')),
    spaces: tree.spaces.map((album) => toNode(album, 'space')),
  };
};

/** Every node in the tree, in rail order. Used for active-state and palette lookups. */
export const flattenAlbumTree = (tree: FrameleafAlbumTree): FrameleafAlbumNode[] => {
  const visit = (node: FrameleafAlbumNode): FrameleafAlbumNode[] => [
    node,
    ...node.children.flatMap((child) => visit(child)),
  ];
  return (tree.roots ?? [...tree.collections, ...tree.albums, ...tree.spaces]).flatMap((root) => visit(root));
};

/** Picker paths name only ancestors present in the authorized album list. */
export const albumSelectionOptions = (albums: AlbumResponseDto[]): { value: string; label: string }[] => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  return albums.map((album) => {
    const names = [album.albumName];
    const seen = new Set([album.id]);
    let parentId = album.parentId;
    while (parentId && !seen.has(parentId) && names.length < 32) {
      const parent = byId.get(parentId);
      if (!parent) {
        break;
      }
      seen.add(parentId);
      names.unshift(parent.albumName);
      parentId = parent.parentId;
    }
    return { value: album.id, label: names.join(' / ') };
  });
};
