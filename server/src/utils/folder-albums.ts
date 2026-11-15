import { sql } from 'kysely';
import path from 'node:path';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { isSameOrInside } from 'src/utils/library-paths.js';
import { isNotLocked } from 'src/utils/locked.js';

/**
 * FL-838: folder albums. A library with `folderAlbums` on keeps an album for each folder under its import folders
 * that holds photos or videos, and for each folder above one up to the import folder itself, nested as the folders
 * are. A folder holding only folders is a collection.
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
  /** null for an import folder */
  parentPath: string | null;
  /** photos and videos directly in this folder */
  photos: number;
  /** 1 for an import folder */
  depth: number;
};

/** The album name for a folder: its own name, or `fallback` for the top of the disk. */
export const folderName = (folderPath: string, fallback: string) => path.posix.basename(folderPath) || fallback;

const depthOf = (folderPath: string) => (folderPath === '/' ? 0 : folderPath.split('/').length - 1);

/** Every folder that gets an album: those holding photos, and the folders above them up to their import folder. */
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
    // the innermost import folder holding it, should one import folder be inside another
    const root = roots
      .filter((candidate) => isSameOrInside(folderPath, candidate))
      .toSorted((a, b) => b.length - a.length)[0];
    if (!root) {
      continue;
    }
    const chain: string[] = [folderPath];
    while (chain[0] !== root) {
      const parent = path.posix.dirname(chain[0]);
      if (parent === chain[0]) {
        break;
      }
      chain.unshift(parent);
    }
    if (chain[0] !== root || chain.length > maxDepth) {
      continue;
    }
    for (const [index, current] of chain.entries()) {
      if (!tree.has(current)) {
        tree.set(current, {
          folderPath: current,
          parentPath: index === 0 ? null : chain[index - 1],
          photos: 0,
          depth: index + 1,
        });
      }
    }
    tree.get(folderPath)!.photos += photos;
  }
  return tree;
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
