import type {
  AlbumCollectionResponseDto,
  AlbumHierarchyNode,
  AlbumHierarchyResponseDto,
  AlbumResponseDto,
  AlbumTreeResponseDto,
} from '@frameleaf/sdk';

/**
 * The eight colours an album or collection may wear (the tag colours; prototype `COLLECTION_COLOURS`),
 * in picker order. `light` is the shade drawn on the light theme, darkened from the prototype's
 * swatch so an icon keeps at least 3:1 against the panel; `dark` is the prototype's swatch (the tag colours, `TAG_COLORS`), which
 * already clears that bar on the dark panel. A colour is never the only signal: pickers name it.
 */
export const ALBUM_COLORS = [
  { id: 'grey', labelKey: 'frameleaf_album_color_grey', light: '#6b7480', dark: '#8b95a1' },
  { id: 'green', labelKey: 'frameleaf_album_color_green', light: '#2f8a50', dark: '#3fb46a' },
  { id: 'teal', labelKey: 'frameleaf_album_color_teal', light: '#0a7673', dark: '#0ea5a0' },
  { id: 'blue', labelKey: 'frameleaf_album_color_blue', light: '#2f6fdb', dark: '#5794f7' },
  { id: 'purple', labelKey: 'frameleaf_album_color_purple', light: '#7656e6', dark: '#8b6cf0' },
  { id: 'pink', labelKey: 'frameleaf_album_color_pink', light: '#c0487f', dark: '#d9639b' },
  { id: 'amber', labelKey: 'frameleaf_album_color_amber', light: '#a8761a', dark: '#d9a441' },
  { id: 'red', labelKey: 'frameleaf_album_color_red', light: '#d93a37', dark: '#f16966' },
] as const;

export type AlbumColor = (typeof ALBUM_COLORS)[number]['id'];
export type AlbumColorSpec = (typeof ALBUM_COLORS)[number];

/** A stored colour name, or null for anything the server did not send or this client does not know. */
export const albumColor = (value: string | null | undefined): AlbumColor | null =>
  ALBUM_COLORS.find(({ id }) => id === value)?.id ?? null;

export const albumColorSpec = (value: string | null | undefined): AlbumColorSpec | undefined =>
  ALBUM_COLORS.find(({ id }) => id === value);

export type FrameleafAlbumKind = 'album' | 'collection' | 'space';

export interface FrameleafAlbumNode {
  id: string;
  name: string;
  /** Stored MDI name or legacy key, or null for the default. Render with `AlbumIcon`. */
  icon: string | null;
  /** One of `ALBUM_COLORS`, or null for the plain look. Render with `AlbumMark`. */
  color: AlbumColor | null;
  kind: FrameleafAlbumKind;
  assetCount: number;
  /** Media plus links: what Boards shows as an album's item count. */
  itemCount: number;
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
  color: albumColor(album.color),
  kind,
  assetCount: album.assetCount,
  itemCount: album.assetCount + (album.bookmarkCount ?? 0),
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

/** Every album that sits inside `albumId`, at any depth (not the album itself). */
export const descendantIds = (albums: Pick<AlbumResponseDto, 'id' | 'parentId'>[], albumId: string): Set<string> => {
  const children = new Map<string, string[]>();
  for (const album of albums) {
    if (album.parentId) {
      children.set(album.parentId, [...(children.get(album.parentId) ?? []), album.id]);
    }
  }
  const found = new Set<string>();
  const queue = [...(children.get(albumId) ?? [])];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (found.has(id) || id === albumId) {
      continue;
    }
    found.add(id);
    queue.push(...(children.get(id) ?? []));
  }
  return found;
};

/** The names above an album, outermost first, for a search result's path ("Brand › Spring"). */
export const albumAncestorNames = (
  albums: Pick<AlbumResponseDto, 'id' | 'parentId' | 'albumName'>[],
  albumId: string,
  unnamed = '',
): string[] => {
  const byId = new Map(albums.map((album) => [album.id, album]));
  const names: string[] = [];
  const seen = new Set([albumId]);
  let parentId = byId.get(albumId)?.parentId;
  while (parentId && !seen.has(parentId) && names.length < 32) {
    const parent = byId.get(parentId);
    if (!parent) {
      break;
    }
    seen.add(parentId);
    names.unshift(parent.albumName || unnamed);
    parentId = parent.parentId;
  }
  return names;
};

/** Why a collection cannot take the one being moved: itself, or inside it. Null when it can. */
export type MoveRefusal = 'self' | 'inside' | null;
export const moveRefusal = (
  albums: Pick<AlbumResponseDto, 'id' | 'parentId'>[],
  movingId: string,
  targetId: string,
): MoveRefusal => {
  if (targetId === movingId) {
    return 'self';
  }
  return descendantIds(albums, movingId).has(targetId) ? 'inside' : null;
};

/**
 * Albums as a tree for a picker, from the flat list: roots are albums whose parent is not in the
 * list. Children keep the list's order.
 */
export interface AlbumPickerNode {
  album: AlbumResponseDto;
  children: AlbumPickerNode[];
}
export const albumPickerTree = (albums: AlbumResponseDto[]): AlbumPickerNode[] => {
  const ids = new Set(albums.map(({ id }) => id));
  const byParent = new Map<string | null, AlbumResponseDto[]>();
  for (const album of albums) {
    const key = album.parentId && ids.has(album.parentId) ? album.parentId : null;
    byParent.set(key, [...(byParent.get(key) ?? []), album]);
  }
  const build = (parentId: string | null, seen: Set<string>): AlbumPickerNode[] =>
    (byParent.get(parentId) ?? [])
      .filter(({ id }) => !seen.has(id))
      .map((album) => ({ album, children: build(album.id, new Set([...seen, album.id])) }));
  return build(null, new Set());
};

/** Albums whose name holds every word of the search, for the picker's flat result list. */
export const searchAlbums = <T extends Pick<AlbumResponseDto, 'albumName'>>(albums: T[], query: string): T[] => {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) {
    return albums;
  }
  return albums.filter((album) => tokens.every((token) => album.albumName.toLowerCase().includes(token)));
};

/** Inline custom properties `AlbumMark` (and wrappers that tint a tile's fallback icon) read. */
export const albumColorStyle = (value: string | null | undefined): string | undefined => {
  const spec = albumColorSpec(value);
  return spec ? `--mark-light: ${spec.light}; --mark-dark: ${spec.dark};` : undefined;
};
