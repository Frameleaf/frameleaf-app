import { sql } from 'kysely';
import path from 'node:path';
import { AlbumKind, AssetType, AssetVisibility } from 'src/enum.js';
import { isSameOrInside } from 'src/utils/library-paths.js';
import { isNotLocked } from 'src/utils/locked.js';

/**
 * FL-838: folder albums. A library with `folderAlbums` on keeps an album for each folder under its import folders
 * that holds photos or videos, and for each folder above one, nested as the folders are. The import folder itself
 * gets an album, named after the library, only for photos loose in it; it never holds the others. A top-level folder
 * holding only folders is a collection; deeper, such a folder is an album that holds albums (collections are
 * top-level only).
 */

/** Albums nest at most 32 levels deep; a folder further down than that gets no album. */
export const MAX_FOLDER_DEPTH = 32;

const FOLDER_PATTERN = '^(.*)/[^/]*$';

/**
 * An item's folder: its path without the file name, '/' at the top of the disk. The pattern is a literal so that
 * Postgres sees one expression however often a query names it (GROUP BY, joins).
 */
export const folderOf = (alias: string) =>
  sql<string>`coalesce(nullif(substring(${sql.ref(`${alias}.originalPath`)}, ${sql.lit(FOLDER_PATTERN)}), ''), '/')`;

/** An item a folder album shows: online, not in the trash, a photo or video on the timeline or archive, not Locked. */
export const isFolderPhoto = (alias: string) =>
  sql<boolean>`(${sql.ref(`${alias}.isOffline`)} = false
    AND ${sql.ref(`${alias}.deletedAt`)} IS NULL
    AND ${sql.ref(`${alias}.visibility`)} IN (${sql.lit(AssetVisibility.Timeline)}, ${sql.lit(AssetVisibility.Archive)})
    AND ${sql.ref(`${alias}.type`)} IN (${sql.lit(AssetType.Image)}, ${sql.lit(AssetType.Video)})
    AND ${isNotLocked(alias)})`;

export type FolderNode = {
  folderPath: string;
  /** null for an import folder and the folders directly in it */
  parentPath: string | null;
  /** photos and videos directly in this folder */
  photos: number;
  /** 1 for an import folder */
  depth: number;
};

/** FL-1837: which folders become albums, per library (`library.folderAlbumOptions`). */
export type FolderAlbumShape = 'events' | 'every' | 'level';
/** What a folder directly inside an album's folder does: its photos join that album, get an album inside it, or none. */
export type SubfolderRule = 'join' | 'own' | 'skip';
export type FolderAlbumOptions = {
  shape: FolderAlbumShape;
  /** With `level`: albums start this many folders down (1 is the folders directly in an import folder). */
  level: number;
  /** With `level` above 1: the folders above the albums become collections (else the albums sit at the top). */
  collectionsAbove: boolean;
  /** Per subfolder name, matched without regard to case. A name left out joins its album (Export and Edits: own). */
  subfolders: Record<string, SubfolderRule>;
  /** No album for a folder whose items are all ones a folder album does not show. */
  skipEmpty: boolean;
  /** The folder's own name, or the folders on the way joined with " › ". */
  naming: 'folder' | 'path';
};

/** A library from before FL-1837 makes an album for every folder, as it always has. */
export const LEGACY_FOLDER_ALBUM_OPTIONS: FolderAlbumOptions = {
  shape: 'every',
  level: 1,
  collectionsAbove: true,
  subfolders: {},
  skipEmpty: true,
  naming: 'folder',
};

/** Exports and edits repeat photos, so they get an album inside the event (owner 2026-11-27). */
export const DEFAULT_SUBFOLDER_RULES: Readonly<Record<string, SubfolderRule>> = { export: 'own', edits: 'own' };

/** One album for each event folder, with Frameleaf's subfolder defaults: what the Albums page offers. */
export const EVENT_FOLDER_ALBUM_OPTIONS: FolderAlbumOptions = { ...LEGACY_FOLDER_ALBUM_OPTIONS, shape: 'events' };

export const resolveFolderAlbumOptions = (
  stored: Partial<FolderAlbumOptions> | null | undefined,
): FolderAlbumOptions => ({
  ...LEGACY_FOLDER_ALBUM_OPTIONS,
  ...stored,
  subfolders: { ...stored?.subfolders },
});

export const subfolderRule = (options: FolderAlbumOptions, name: string): SubfolderRule => {
  const lower = name.toLowerCase();
  for (const [key, rule] of Object.entries(options.subfolders)) {
    if (key.toLowerCase() === lower) {
      return rule;
    }
  }
  return DEFAULT_SUBFOLDER_RULES[lower] ?? 'join';
};

/** The album name for a folder: its own name, or `libraryName` for an import folder (`roots`). */
export const folderName = (folderPath: string, libraryName: string, roots: string[]) =>
  (!roots.includes(folderPath) && path.posix.basename(folderPath)) || libraryName;

const SEPARATOR = ' › ';

/** The folders from the import folder down to this one, joined with " › "; `libraryName` for an import folder. */
export const folderPathName = (folderPath: string, libraryName: string, roots: string[]) => {
  const root = rootOf(folderPath, roots);
  if (!root || root === folderPath) {
    return libraryName;
  }
  return folderPath
    .slice(root === '/' ? 1 : root.length + 1)
    .split('/')
    .join(SEPARATOR);
};

/** Every name a sync could have given a folder's album, so none of them reads as the owner renaming it. */
export const autoNames = (folderPath: string, libraryName: string, roots: string[]) => {
  const names = new Set([folderName(folderPath, libraryName, roots), folderPathName(folderPath, libraryName, roots)]);
  // before FL-838 decision 2 an import folder's album was named after the folder
  if (roots.includes(folderPath)) {
    names.add(path.posix.basename(folderPath));
  }
  return names;
};

/** A top-level folder holding only folders is a collection; every other folder is an album. */
export const folderKind = (node: Pick<FolderNode, 'photos' | 'depth'>) =>
  node.photos === 0 && node.depth === 2 ? AlbumKind.Collection : AlbumKind.Album;

const depthOf = (folderPath: string) => (folderPath === '/' ? 0 : folderPath.split('/').length - 1);

/** The innermost import folder holding `folderPath`, should one import folder be inside another. */
const rootOf = (folderPath: string, roots: string[]) =>
  roots.filter((candidate) => isSameOrInside(folderPath, candidate)).toSorted((a, b) => b.length - a.length)[0] as
    string | undefined;

/** The folders from `root` down to `folderPath`, both included. */
const chainOf = (folderPath: string, root: string) => {
  const chain: string[] = [folderPath];
  while (chain[0] !== root) {
    const parent = path.posix.dirname(chain[0]);
    if (parent === chain[0]) {
      break;
    }
    chain.unshift(parent);
  }
  return chain;
};

/**
 * Every folder that gets an album: those holding photos, and the folders above them up to (not including) their import
 * folder. The import folder is in only when photos are loose in it.
 */
export const buildFolderTree = (
  roots: string[],
  counts: { folderPath: string; photos: number }[],
  maxDepth = MAX_FOLDER_DEPTH,
): Map<string, FolderNode> => {
  const tree = new Map<string, FolderNode>();
  for (const { folderPath, photos } of counts) {
    if (photos <= 0) {
      continue;
    }
    const root = rootOf(folderPath, roots);
    if (!root) {
      continue;
    }
    const chain = chainOf(folderPath, root);
    if (chain[0] !== root || chain.length > maxDepth) {
      continue;
    }
    for (const [index, current] of chain.entries()) {
      if (index === 0 && current !== folderPath) {
        continue;
      }
      if (!tree.has(current)) {
        tree.set(current, {
          folderPath: current,
          parentPath: index <= 1 ? null : chain[index - 1],
          photos: 0,
          depth: index + 1,
        });
      }
    }
    tree.get(folderPath)!.photos += photos;
  }
  return tree;
};

/** An album the sync keeps for a library: its folder, place, kind, name, and the folders whose photos join it. */
export type FolderAlbumPlanNode = FolderNode & {
  kind: AlbumKind;
  name: string;
  /** The folders whose own photos join this album: its folder, and folders below that join it. */
  members: string[];
};

export type FolderCount = {
  folderPath: string;
  /** photos and videos a folder album shows */
  photos: number;
  /** every item in the folder that is not Locked or trashed; more than `photos` when some are not shown */
  items?: number;
};

/**
 * FL-1837: the albums a library keeps under `options`. With `every`, each folder holding photos is an album and each
 * folder above one an album or (at the top) a collection, as FL-838 made them. With `events` (album level 1) or
 * `level`, the folders that many down are the albums; photos further down join them, unless a folder directly inside
 * an album's folder has its own rule: an album inside it, or no album. A folder above the album level that holds
 * photos of its own gets an album too. Photos loose in an import folder go to an album named after the library.
 */
export const planFolderAlbums = (
  roots: string[],
  counts: FolderCount[],
  options: FolderAlbumOptions,
  libraryName: string,
  maxDepth = MAX_FOLDER_DEPTH,
): Map<string, FolderAlbumPlanNode> => {
  const rows = counts.filter(({ photos, items }) => photos > 0 || (!options.skipEmpty && (items ?? 0) > 0));
  const nameOf = (folderPath: string) =>
    options.naming === 'path'
      ? folderPathName(folderPath, libraryName, roots)
      : folderName(folderPath, libraryName, roots);
  const plan = new Map<string, FolderAlbumPlanNode>();
  const nodeFor = (folderPath: string, parentPath: string | null, depth: number) => {
    let node = plan.get(folderPath);
    if (!node) {
      node = { folderPath, parentPath, photos: 0, depth, kind: AlbumKind.Album, name: nameOf(folderPath), members: [] };
      plan.set(folderPath, node);
    }
    return node;
  };
  const join = (node: FolderAlbumPlanNode, folderPath: string, photos: number) => {
    node.photos += photos;
    if (!node.members.includes(folderPath)) {
      node.members.push(folderPath);
    }
  };

  if (options.shape === 'every') {
    const tree = buildFolderTree(
      roots,
      rows.map(({ folderPath, photos }) => ({ folderPath, photos: Math.max(photos, 0) || 1 })),
      maxDepth,
    );
    const photosOf = new Map(rows.map(({ folderPath, photos }) => [folderPath, photos]));
    const parents = new Set(tree.values().map(({ parentPath }) => parentPath));
    for (const node of tree.values()) {
      const photos = photosOf.get(node.folderPath);
      const planned = nodeFor(node.folderPath, node.parentPath, node.depth);
      if (photos !== undefined) {
        join(planned, node.folderPath, photos);
      }
      // a folder of folders at the top is a collection; an empty folder at the top with nothing inside is an album
      planned.kind =
        photos === undefined && node.depth === 2 && parents.has(node.folderPath)
          ? AlbumKind.Collection
          : AlbumKind.Album;
    }
    return plan;
  }

  const level = options.shape === 'events' ? 1 : Math.min(Math.max(Math.trunc(options.level) || 1, 1), 3);
  const above = level > 1 && options.collectionsAbove;
  for (const { folderPath, photos } of rows) {
    const root = rootOf(folderPath, roots);
    if (!root) {
      continue;
    }
    const chain = chainOf(folderPath, root);
    if (chain[0] !== root || chain.length > maxDepth) {
      continue;
    }
    // chain[i] is i folders down from the import folder
    const down = chain.length - 1;
    if (down === 0) {
      join(nodeFor(root, null, 1), root, photos);
      continue;
    }
    // the folders above the album level, as collections (top) and albums of albums, when asked for
    let parentPath: string | null = null;
    if (above) {
      for (let index = 1; index < Math.min(level, down + 1); index++) {
        const node = nodeFor(chain[index], parentPath, index + 1);
        if (index === 1 && node.photos === 0 && chain[index] !== folderPath) {
          node.kind = AlbumKind.Collection;
        }
        parentPath = chain[index];
      }
    }
    if (down < level) {
      // a folder above the album level holding photos of its own
      const node = nodeFor(folderPath, above ? (chain.at(-2) === root ? null : chain.at(-2)!) : null, down + 1);
      node.kind = AlbumKind.Album;
      join(node, folderPath, photos);
      continue;
    }
    const albumFolder = chain[level];
    const album = nodeFor(albumFolder, parentPath, level + 1);
    album.kind = AlbumKind.Album;
    if (down === level) {
      join(album, folderPath, photos);
      continue;
    }
    const inside = chain[level + 1];
    const rule = subfolderRule(options, path.posix.basename(inside));
    if (rule === 'skip') {
      continue;
    }
    if (rule === 'own') {
      join(nodeFor(inside, albumFolder, level + 2), folderPath, photos);
      continue;
    }
    join(album, folderPath, photos);
  }
  // an album planned before photos showed that its folder of folders holds photos of its own
  for (const node of plan.values()) {
    if (node.kind === AlbumKind.Collection && node.members.length > 0) {
      node.kind = AlbumKind.Album;
    }
  }
  return plan;
};

/**
 * Whether a library looks laid out by event: folders at the top that share the names of the folders inside them
 * (Capture, Videos, RAW, Export). Frameleaf then recommends one album for each event folder.
 */
export const looksLikeEventFolders = (roots: string[], counts: FolderCount[]) => {
  const inside = new Map<string, Set<string>>();
  for (const { folderPath } of counts) {
    const root = rootOf(folderPath, roots);
    if (!root) {
      continue;
    }
    const chain = chainOf(folderPath, root);
    if (chain.length < 3) {
      continue;
    }
    const names = inside.get(chain[1]) ?? new Set<string>();
    names.add(path.posix.basename(chain[2]).toLowerCase());
    inside.set(chain[1], names);
  }
  const seen = new Map<string, number>();
  for (const names of inside.values()) {
    for (const name of names) {
      seen.set(name, (seen.get(name) ?? 0) + 1);
    }
  }
  const sharing = inside
    .values()
    .filter((names) => names.values().some((name) => (seen.get(name) ?? 0) >= 2))
    .toArray();
  return sharing.length >= 2 && sharing.length * 2 >= inside.size;
};

export const fileKey = (originalFileName: string, fileModifiedAt: Date | string) =>
  // a file name never holds '/'
  `${originalFileName}/${new Date(fileModifiedAt).getTime()}`;

/**
 * Folders that went away and where they went. A folder whose album has gone missing moved to the new folder holding
 * at least half of its files (same name and modification time; a library makes new items for moved files). A folder
 * that held only folders follows where its subfolders went. Deepest folders are matched first, and each new folder
 * takes at most one album.
 */
export const matchMovedFolders = (
  gone: { folderPath: string; keys: Set<string> }[],
  candidates: Map<string, Set<string>>,
  free: Set<string>,
): Map<string, string> => {
  const moves = new Map<string, string>();
  const taken = new Set<string>();
  for (const { folderPath, keys } of gone.toSorted((a, b) => depthOf(b.folderPath) - depthOf(a.folderPath))) {
    let best: string | undefined;
    if (keys.size > 0) {
      let bestOverlap = 0;
      for (const [candidate, candidateKeys] of candidates) {
        if (taken.has(candidate)) {
          continue;
        }
        let overlap = 0;
        for (const key of keys) {
          if (candidateKeys.has(key)) {
            overlap++;
          }
        }
        if (overlap > bestOverlap) {
          best = candidate;
          bestOverlap = overlap;
        }
      }
      if (bestOverlap * 2 < keys.size) {
        best = undefined;
      }
    }
    if (!best) {
      for (const [from, to] of moves) {
        if (!from.startsWith(`${folderPath}/`)) {
          continue;
        }
        const rest = from.slice(folderPath.length);
        const target = to.endsWith(rest) ? to.slice(0, to.length - rest.length) : undefined;
        if (target && free.has(target) && !taken.has(target)) {
          best = target;
          break;
        }
      }
    }
    if (best) {
      moves.set(folderPath, best);
      taken.add(best);
    }
  }
  return moves;
};
