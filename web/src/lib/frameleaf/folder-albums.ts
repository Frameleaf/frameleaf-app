/**
 * FL-838 / FL-1837: the albums "Make albums from folders" keeps, for the preview on a folder's page and on Add a
 * folder. The same rules as the server's sync (`planFolderAlbums` in `server/src/utils/folder-albums.ts`), read from
 * the folder estimate: each folder holding photos, and how many it holds directly.
 */
import {
  FolderAlbumNaming,
  FolderAlbumShape,
  FolderAlbumSubfolderRule,
  type FolderAlbumOptionsDto,
} from '@frameleaf/sdk';

export type FolderAlbumNode = {
  name: string;
  path: string;
  kind: 'album' | 'collection';
  parentPath: string | null;
  /** Photos and videos that join the album. */
  photos: number;
};

/** A library from before FL-1837: an album for every folder. */
export const LEGACY_FOLDER_ALBUM_OPTIONS: FolderAlbumOptionsDto = {
  shape: FolderAlbumShape.Every,
  level: 1,
  collectionsAbove: true,
  subfolders: {},
  skipEmpty: true,
  naming: FolderAlbumNaming.Folder,
};

/** Exports and edits repeat photos, so they get an album inside the event (owner 2026-11-27). */
const DEFAULT_RULES: Record<string, FolderAlbumSubfolderRule> = {
  export: FolderAlbumSubfolderRule.Own,
  edits: FolderAlbumSubfolderRule.Own,
};

export const EVENT_FOLDER_ALBUM_OPTIONS: FolderAlbumOptionsDto = {
  ...LEGACY_FOLDER_ALBUM_OPTIONS,
  shape: FolderAlbumShape.Events,
};

const SEPARATOR = ' › ';
const trim = (path: string) => (path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path);
const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

export const subfolderRule = (options: FolderAlbumOptionsDto, name: string): FolderAlbumSubfolderRule => {
  const lower = name.toLowerCase();
  const key = Object.keys(options.subfolders).find((candidate) => candidate.toLowerCase() === lower);
  return key ? options.subfolders[key] : (DEFAULT_RULES[lower] ?? FolderAlbumSubfolderRule.Join);
};

/** The import folder holding `path`, and the folders from it down to `path`; undefined outside them all. */
const walk = (roots: string[], path: string) => {
  const folder = trim(path);
  const root = roots
    .filter((candidate) => folder === candidate || folder.startsWith(candidate === '/' ? '/' : `${candidate}/`))
    .sort((a, b) => b.length - a.length)[0];
  if (root === undefined) {
    return;
  }
  const rest = folder === root ? [] : folder.slice(root === '/' ? 1 : root.length + 1).split('/');
  const chain = [root, ...rest.map((_, index) => `${root === '/' ? '' : root}/${rest.slice(0, index + 1).join('/')}`)];
  return { root, chain };
};

const levelOf = (options: FolderAlbumOptionsDto) =>
  options.shape === FolderAlbumShape.Events ? 1 : Math.min(Math.max(Math.trunc(options.level) || 1, 1), 3);

/** The albums and collections `options` keep for these folders, in the order the sync makes them. */
export const planFolderAlbums = (
  rootsIn: string[],
  folders: { path: string; count: number }[],
  options: FolderAlbumOptionsDto,
  libraryName: string,
): FolderAlbumNode[] => {
  const roots = [...new Set(rootsIn.map((root) => trim(root)))];
  const plan = new Map<string, FolderAlbumNode>();
  const nameOf = (path: string, root: string) => {
    if (path === root) {
      return libraryName;
    }
    return options.naming === FolderAlbumNaming.Path
      ? path
          .slice(root === '/' ? 1 : root.length + 1)
          .split('/')
          .join(SEPARATOR)
      : baseName(path);
  };
  const node = (path: string, root: string, parentPath: string | null) => {
    let found = plan.get(path);
    if (!found) {
      found = { name: nameOf(path, root), path, kind: 'album', parentPath, photos: 0 };
      plan.set(path, found);
    }
    return found;
  };
  const level = levelOf(options);
  const above = options.shape === FolderAlbumShape.Level && level > 1 && options.collectionsAbove;
  for (const { path, count } of folders) {
    const found = walk(roots, path);
    if (!found || count <= 0) {
      continue;
    }
    const { root, chain } = found;
    const down = chain.length - 1;
    if (down === 0) {
      node(root, root, null).photos += count;
      continue;
    }
    if (options.shape === FolderAlbumShape.Every) {
      for (let index = 1; index < down; index++) {
        node(chain[index], root, index === 1 ? null : chain[index - 1]);
      }
      node(chain[down], root, down === 1 ? null : chain[down - 1]).photos += count;
      continue;
    }
    let parentPath: string | null = null;
    if (above) {
      for (let index = 1; index < Math.min(level, down + 1); index++) {
        node(chain[index], root, parentPath);
        parentPath = chain[index];
      }
    }
    if (down < level) {
      node(chain[down], root, above && down > 1 ? chain[down - 1] : null).photos += count;
      continue;
    }
    const album = node(chain[level], root, parentPath);
    if (down === level) {
      album.photos += count;
      continue;
    }
    const rule = subfolderRule(options, baseName(chain[level + 1]));
    if (rule === FolderAlbumSubfolderRule.Own) {
      node(chain[level + 1], root, chain[level]).photos += count;
    } else if (rule === FolderAlbumSubfolderRule.Join) {
      album.photos += count;
    }
  }
  const nodes = [...plan.values()];
  // a folder of folders at the top is a collection: below the album level with "collections above", or with `every`
  const parents = new Set(nodes.map(({ parentPath }) => parentPath));
  for (const item of nodes) {
    const top = item.parentPath === null && !roots.includes(item.path);
    if (top && item.photos === 0 && parents.has(item.path) && (options.shape === FolderAlbumShape.Every || above)) {
      item.kind = 'collection';
    }
  }
  return nodes;
};

/** How many albums and collections a plan keeps. */
export const folderAlbumCounts = (plan: FolderAlbumNode[]) => {
  const collections = plan.filter(({ kind }) => kind === 'collection').length;
  return { albums: plan.length - collections, collections };
};

/**
 * The names of the folders directly inside the albums' folders (with `events`, inside each event folder), and in how
 * many album folders each is found, most common first.
 */
export const subfolderNames = (
  rootsIn: string[],
  folders: { path: string; count: number; skipped?: number }[],
  options: FolderAlbumOptionsDto,
) => {
  const roots = [...new Set(rootsIn.map((root) => trim(root)))];
  const level = options.shape === FolderAlbumShape.Every ? 1 : levelOf(options);
  // each folder of that name, with the photos shown and skipped in it and below it
  const found = new Map<string, Map<string, { photos: number; skipped: number }>>();
  const names = new Map<string, string>();
  for (const { path, count, skipped = 0 } of folders) {
    const chain = walk(roots, path)?.chain;
    if (!chain || chain.length < level + 2) {
      continue;
    }
    const name = baseName(chain[level + 1]);
    const key = name.toLowerCase();
    const seen = found.get(key) ?? new Map<string, { photos: number; skipped: number }>();
    const totals = seen.get(chain[level + 1]) ?? { photos: 0, skipped: 0 };
    totals.photos += count;
    totals.skipped += skipped;
    seen.set(chain[level + 1], totals);
    found.set(key, seen);
    // the first spelling found names the row
    if (!names.has(key)) {
      names.set(key, name);
    }
  }
  return [...found]
    .map(([key, instances]) => {
      const empty = [...instances.values()].filter(({ photos }) => photos === 0);
      return {
        name: names.get(key)!,
        folders: instances.size,
        /** folders of this name holding nothing a folder album shows */
        empty: empty.length,
        /** whether those hold photos this folder's skips leave out, such as RAW files */
        skipped: empty.some(({ skipped }) => skipped > 0),
      };
    })
    .sort((a, b) => b.folders - a.folders || a.name.localeCompare(b.name));
};

/** A folder-by-event layout: top folders that share the names of the folders inside them (Capture, RAW, Export). */
export const looksLikeEventFolders = (roots: string[], folders: { path: string; count: number }[]) => {
  const shared = subfolderNames(roots, folders, EVENT_FOLDER_ALBUM_OPTIONS).filter(({ folders }) => folders >= 2);
  return shared.length > 0;
};

/**
 * One event for the before-and-after example: the first top folder with folders inside, what is on the drive (each
 * folder inside it with the photos below it), and the albums the plan keeps for it.
 */
export const folderAlbumExample = (
  rootsIn: string[],
  folders: { path: string; count: number }[],
  plan: FolderAlbumNode[],
) => {
  const roots = [...new Set(rootsIn.map((root) => trim(root)))];
  const tops = new Map<string, Map<string, number>>();
  for (const { path, count } of folders) {
    const chain = walk(roots, path)?.chain;
    if (!chain || chain.length < 3) {
      continue;
    }
    const inside = tops.get(chain[1]) ?? new Map<string, number>();
    inside.set(chain[2], (inside.get(chain[2]) ?? 0) + count);
    tops.set(chain[1], inside);
  }
  const [event] = [...tops].sort(([a, x], [b, y]) => y.size - x.size || a.localeCompare(b));
  if (!event) {
    return;
  }
  const [path, inside] = event;
  const within = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
  const albums = plan.filter((item) => within(item.path));
  const depthOf = (item: FolderAlbumNode) => {
    let depth = 0;
    for (let parent = item.parentPath; parent && within(parent); depth++) {
      parent = plan.find((other) => other.path === parent)?.parentPath ?? null;
    }
    return depth;
  };
  return {
    name: baseName(path),
    drive: [...inside].map(([folder, photos]) => ({ name: baseName(folder), photos })),
    albums: albums.map((item) => ({ ...item, depth: depthOf(item) })),
  };
};
