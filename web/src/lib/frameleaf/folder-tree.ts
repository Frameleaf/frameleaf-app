import type { FolderSummaryResponseDto } from '@frameleaf/sdk';
import { nameMatchesFind } from '$lib/frameleaf/discovery-find';

/**
 * The storage-folder tree for the Frameleaf Folders browser (FL-46; redesigned as a visual browser
 * after the approved mock, `design/frameleaf/template/src/FoldersV2.jsx` and `folderTreeV2` in
 * `discovery-data.mjs`).
 *
 * The mock builds its tree from every asset in memory; production builds it from
 * `GET /view/folder/summary`, one row per folder holding originals: its direct file count and
 * bytes, up to four of its newest files for a cover and the days its files span, counting only the
 * Timeline items the folder views list. Totals, sizes, covers and date ranges are rolled up the
 * tree here, so a folder that holds only subfolders still has a cover, and no folder's files are
 * fetched until it is opened. A storage folder is where originals live on disk: it is read-only
 * here and has nothing to do with (nested) albums.
 */

export interface FolderNode {
  /** The folder's path as the server stores it (`/data/library/2026`); "/" is the root. */
  path: string;
  /** The last path segment, as it is on disk; empty for the root. */
  name: string;
  parent: FolderNode | null;
  children: FolderNode[];
  /** Originals directly in this folder. */
  directCount: number;
  /** Originals in this folder and every folder under it. */
  count: number;
  /** Bytes of the originals in this folder and every folder under it. */
  size: number;
  depth: number;
  /** Up to `FOLDER_COVER_LIMIT` asset ids for the cover: this folder's own newest files, then its subfolders'. */
  coverAssetIds: string[];
  /** The capture day of the oldest original in this folder or under it, or null when unknown. */
  startDate: string | null;
  /** The capture day of the newest original in this folder or under it, or null when unknown. */
  endDate: string | null;
}

export interface FolderTree {
  root: FolderNode;
  byPath: Map<string, FolderNode>;
}

/** A summary row. The cover and the dates are optional: a server from before the redesign sends none. */
export type FolderSummaryRow = Pick<FolderSummaryResponseDto, 'path' | 'count' | 'size'> &
  Partial<Pick<FolderSummaryResponseDto, 'coverAssetIds' | 'startDate' | 'endDate'>>;

export const FOLDER_ROOT_PATH = '/';

/** The most photos a cover draws: the 2 x 2 collage of the columns preview. A card's pile shows three. */
export const FOLDER_COVER_LIMIT = 4;

const newNode = (path: string, name: string, parent: FolderNode | null): FolderNode => ({
  path,
  name,
  parent,
  children: [],
  directCount: 0,
  count: 0,
  size: 0,
  depth: parent ? parent.depth + 1 : 0,
  coverAssetIds: [],
  startDate: null,
  endDate: null,
});

const compareNames = (a: FolderNode, b: FolderNode) => a.name.localeCompare(b.name, undefined, { numeric: true });

// ISO date-times compare correctly as text.
const earlier = (a: string | null, b: string | null | undefined) => (b && (!a || b < a) ? b : a);
const later = (a: string | null, b: string | null | undefined) => (b && (!a || b > a) ? b : a);

/**
 * A folder's cover: its own newest files first, then one from each subfolder in turn (the subfolder
 * with the newest files first), so a folder of trips shows a photo from several trips rather than
 * four from one.
 */
const rollUpCovers = (own: readonly string[], children: readonly FolderNode[]): string[] => {
  const covers = [...new Set(own)].slice(0, FOLDER_COVER_LIMIT);
  if (covers.length === FOLDER_COVER_LIMIT) {
    return covers;
  }
  const newestFirst = children
    .filter((child) => child.coverAssetIds.length > 0)
    .sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? '') || compareNames(a, b));
  for (let rank = 0; rank < FOLDER_COVER_LIMIT; rank++) {
    for (const child of newestFirst) {
      const id = child.coverAssetIds.at(rank);
      if (id === undefined || covers.includes(id)) {
        continue;
      }
      covers.push(id);
      if (covers.length === FOLDER_COVER_LIMIT) {
        return covers;
      }
    }
  }
  return covers;
};

export function buildFolderTree(rows: readonly FolderSummaryRow[]): FolderTree {
  const root = newNode(FOLDER_ROOT_PATH, '', null);
  const byPath = new Map<string, FolderNode>([[FOLDER_ROOT_PATH, root]]);

  for (const row of rows) {
    const absolute = row.path.startsWith('/');
    const parts = row.path.split('/').filter(Boolean);
    let cursor = root;
    for (let index = 0; index < parts.length; index++) {
      const joined = parts.slice(0, index + 1).join('/');
      const path = absolute ? `/${joined}` : joined;
      let next = byPath.get(path);
      if (!next) {
        next = newNode(path, parts[index], cursor);
        byPath.set(path, next);
        cursor.children.push(next);
      }
      cursor = next;
    }
    const count = Math.max(0, row.count);
    const size = Math.max(0, row.size);
    cursor.directCount += count;
    cursor.coverAssetIds.push(...(row.coverAssetIds ?? []));
    cursor.startDate = earlier(cursor.startDate, row.startDate);
    cursor.endDate = later(cursor.endDate, row.endDate);
    for (let up: FolderNode | null = cursor; up; up = up.parent) {
      up.count += count;
      up.size += size;
    }
  }

  // Subfolders first, so each folder takes its cover and its dates from finished ones below it.
  const finish = (node: FolderNode) => {
    node.children.sort(compareNames);
    for (const child of node.children) {
      finish(child);
      node.startDate = earlier(node.startDate, child.startDate);
      node.endDate = later(node.endDate, child.endDate);
    }
    node.coverAssetIds = rollUpCovers(node.coverAssetIds, node.children);
  };
  finish(root);
  return { root, byPath };
}

const normalizeFolderPath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

export const folderAt = (tree: FolderTree, path: string | null | undefined): FolderNode | null =>
  path ? (tree.byPath.get(normalizeFolderPath(path)) ?? null) : null;

/**
 * The top of the browser ("All folders"): the first folder that holds files or branches. A library
 * usually sits several folders deep (`/usr/src/app/upload/library/...`), and the folders above that
 * point only pass through to it, so the browser starts there and never at "/".
 */
export const firstUsefulFolder = (tree: FolderTree): FolderNode => {
  let node = tree.root;
  while (node.children.length === 1 && node.directCount === 0) {
    node = node.children.at(0)!;
  }
  return node;
};

const isAbove = (ancestor: FolderNode, node: FolderNode) => {
  for (let up = node.parent; up; up = up.parent) {
    if (up === ancestor) {
      return true;
    }
  }
  return false;
};

/**
 * The folder an address opens: the folder itself; for a folder that no longer holds anything (its
 * files were moved, deleted or archived), its nearest ancestor that still does; and with no
 * address, or one for a pass-through folder above it, the top of the browser.
 */
export const resolveFolder = (tree: FolderTree, path: string | null | undefined): FolderNode => {
  const top = firstUsefulFolder(tree);
  if (!path) {
    return top;
  }
  let candidate = normalizeFolderPath(path);
  for (;;) {
    const found = tree.byPath.get(candidate);
    if (found) {
      return isAbove(found, top) ? top : found;
    }
    const slash = candidate.lastIndexOf('/');
    if (slash <= 0) {
      return top;
    }
    candidate = candidate.slice(0, slash);
  }
};

/** The folder's ancestors, root first, followed by the folder itself. */
export const folderBreadcrumbs = (node: FolderNode): FolderNode[] => {
  const chain: FolderNode[] = [];
  for (let current: FolderNode | null = node; current; current = current.parent) {
    chain.unshift(current);
  }
  return chain;
};

/**
 * The path the browser draws: from its top (`firstUsefulFolder`) down to the folder. The
 * pass-through folders above the top are left out; the path on disk still names them.
 */
export const folderTrail = (node: FolderNode, top: FolderNode): FolderNode[] => {
  const chain = folderBreadcrumbs(node);
  const start = chain.indexOf(top);
  return start === -1 ? [top] : chain.slice(start);
};

/** The folders beside a folder (itself included), in name order; none for the root. */
export const folderSiblings = (node: FolderNode): FolderNode[] => node.parent?.children ?? [];

/** Every folder in tree order (root first). */
export const flattenFolderTree = (tree: FolderTree): FolderNode[] => {
  const out: FolderNode[] = [];
  const visit = (node: FolderNode) => {
    out.push(node);
    for (const child of node.children) {
      visit(child);
    }
  };
  visit(tree.root);
  return out;
};

/** Account id to display name, for the accounts this session already knows. */
export type FolderAccounts = Readonly<Record<string, string>>;

/**
 * Whose uploads a folder holds, when it is named after an account the session knows: uploads are
 * stored under `.../upload/<account id>/...`, and an id means nothing to the person reading it.
 * Null for every other folder, which keeps its name on disk.
 */
export const folderAccountName = (node: Pick<FolderNode, 'name'>, accounts: FolderAccounts): string | null => {
  if (!node.name || !Object.hasOwn(accounts, node.name)) {
    return null;
  }
  return accounts[node.name].trim() || null;
};

export type FolderLabel = (node: FolderNode) => string;

const onDiskName: FolderLabel = (node) => node.name;

export type FolderSort = 'name' | 'newest' | 'largest' | 'items';

export const folderSorts: readonly FolderSort[] = ['name', 'newest', 'largest', 'items'];

/**
 * Mock `folderSorters`: by the name shown (numbers numerically), newest files first, largest first
 * or most items first. Every order falls back to the name, so equal folders never reshuffle.
 */
export const sortFolders = (
  folders: readonly FolderNode[],
  sort: FolderSort,
  label: FolderLabel = onDiskName,
): FolderNode[] => {
  const byName = (a: FolderNode, b: FolderNode) =>
    label(a).localeCompare(label(b), undefined, { numeric: true }) || a.path.localeCompare(b.path);
  const list = [...folders];
  switch (sort) {
    case 'name': {
      return list.sort(byName);
    }
    case 'newest': {
      return list.sort((a, b) => (b.endDate ?? '').localeCompare(a.endDate ?? '') || byName(a, b));
    }
    case 'largest': {
      return list.sort((a, b) => b.size - a.size || byName(a, b));
    }
    case 'items': {
      return list.sort((a, b) => b.count - a.count || byName(a, b));
    }
  }
};

/**
 * "Find a folder": every folder under the top whose shown name or name on disk contains what was
 * typed, in tree order. The top itself is "All folders" and never a match.
 */
export const findFolders = (top: FolderNode, query: string, label: FolderLabel = onDiskName): FolderNode[] => {
  const found: FolderNode[] = [];
  const visit = (node: FolderNode) => {
    for (const child of node.children) {
      if (nameMatchesFind(label(child), query) || nameMatchesFind(child.name, query)) {
        found.push(child);
      }
      visit(child);
    }
  };
  visit(top);
  return found;
};

/** Prototype `formatBytes`: "0 B", "812 KB", "4.2 MB", "12 GB". */
export function formatBytes(bytes: number | null | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes <= 0) {
    return '0 B';
  }
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

export interface FolderFile {
  id: string;
  originalFileName?: string | null;
  localDateTime?: string | null;
  fileSizeInByte?: number | null;
}

/**
 * Mock `fileSorters`: by file name (numeric), newest capture first, or largest first. "Most items"
 * orders folders only, so files stay in name order. Ties keep a stable order by id so the grid
 * never reshuffles between loads.
 */
export const sortFolderFiles = <T extends FolderFile>(files: readonly T[], sort: FolderSort): T[] => {
  const list = [...files];
  const byId = (a: T, b: T) => a.id.localeCompare(b.id);
  switch (sort) {
    case 'name':
    case 'items': {
      return list.sort(
        (a, b) =>
          (a.originalFileName ?? '').localeCompare(b.originalFileName ?? '', undefined, { numeric: true }) ||
          byId(a, b),
      );
    }
    case 'largest': {
      return list.sort((a, b) => (b.fileSizeInByte ?? 0) - (a.fileSizeInByte ?? 0) || byId(a, b));
    }
    case 'newest': {
      return list.sort((a, b) => {
        const first = a.localDateTime ?? '';
        const second = b.localDateTime ?? '';
        if (!first || !second) {
          return first ? -1 : second ? 1 : byId(a, b);
        }
        return second.localeCompare(first) || byId(a, b);
      });
    }
  }
};

export type FoldersViewMode = 'grid' | 'columns';

/** What a viewer chose for the Folders browser, remembered on this device (`foldersView`). */
export interface FoldersView {
  view: FoldersViewMode;
  /** Show each file's name and size under its tile. */
  fileNames: boolean;
}

export const defaultFoldersView: FoldersView = { view: 'grid', fileNames: false };

/** Repairs a stored preference that is stale or was edited by hand. */
export const normalizeFoldersView = (value: unknown): FoldersView => {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Partial<
    Record<keyof FoldersView, unknown>
  >;
  return {
    view: stored.view === 'columns' ? 'columns' : 'grid',
    fileNames: stored.fileNames === true,
  };
};
