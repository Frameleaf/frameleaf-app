import type { FolderSummaryResponseDto } from '@immich/sdk';

/**
 * The storage-folder tree for the Frameleaf Folders browser (FL-46), ported from the prototype's
 * `folderTree`, `folderAt`, `folderBreadcrumbs` and `formatBytes` (`design/frameleaf/template/src/
 * discovery-data.mjs:750-825`) and `Folders.jsx` `firstUseful`.
 *
 * The prototype builds the tree from every asset in memory; production builds it from
 * `GET /view/folder/summary`, one row per folder holding originals (its direct file count and
 * bytes, counting only the Timeline items the folder views list). Totals and sizes are added up the
 * tree here, so no folder's files are fetched until it is opened. A storage folder is where
 * originals live on disk: it is read-only here and has nothing to do with (nested) albums.
 */

export interface FolderNode {
  /** The folder's path as the server stores it (`/data/library/2026`); "/" is "All folders". */
  path: string;
  /** The last path segment; empty for the root, which the browser names "All folders". */
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
}

export interface FolderTree {
  root: FolderNode;
  byPath: Map<string, FolderNode>;
}

export const FOLDER_ROOT_PATH = '/';

const newNode = (path: string, name: string, parent: FolderNode | null): FolderNode => ({
  path,
  name,
  parent,
  children: [],
  directCount: 0,
  count: 0,
  size: 0,
  depth: parent ? parent.depth + 1 : 0,
});

const compareNames = (a: FolderNode, b: FolderNode) => a.name.localeCompare(b.name, undefined, { numeric: true });

export function buildFolderTree(rows: readonly FolderSummaryResponseDto[]): FolderTree {
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
    for (let up: FolderNode | null = cursor; up; up = up.parent) {
      up.count += count;
      up.size += size;
    }
  }

  const sort = (node: FolderNode) => {
    node.children.sort(compareNames);
    for (const child of node.children) {
      sort(child);
    }
  };
  sort(root);
  return { root, byPath };
}

const normalizeFolderPath = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path);

export const folderAt = (tree: FolderTree, path: string | null | undefined): FolderNode | null =>
  path ? (tree.byPath.get(normalizeFolderPath(path)) ?? null) : null;

/** Prototype `firstUseful`: skip the pass-through folders that only hold a single subfolder. */
export const firstUsefulFolder = (tree: FolderTree): FolderNode => {
  let node = tree.root;
  while (node.children.length === 1 && node.directCount === 0) {
    node = node.children.at(0)!;
  }
  return node;
};

/**
 * The folder an address opens: the folder itself; for a folder that no longer holds anything (its
 * files were moved, deleted or archived), its nearest ancestor that still does; and with no
 * address, the first useful folder, as the prototype opens.
 */
export const resolveFolder = (tree: FolderTree, path: string | null | undefined): FolderNode => {
  if (!path) {
    return firstUsefulFolder(tree);
  }
  let candidate = normalizeFolderPath(path);
  for (;;) {
    const found = tree.byPath.get(candidate);
    if (found) {
      return found;
    }
    const slash = candidate.lastIndexOf('/');
    if (slash <= 0) {
      return tree.root;
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

/** Every folder in tree order (root first), for the keyboard model's parent lookups. */
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

export type FolderSort = 'name' | 'date' | 'size';

export interface FolderFile {
  id: string;
  originalFileName?: string | null;
  localDateTime?: string | null;
  fileSizeInByte?: number | null;
}

/**
 * Prototype `Folders.jsx:154-160`: by file name (numeric), newest capture first, or largest first.
 * Ties keep a stable order by id so the grid never reshuffles between loads.
 */
export const sortFolderFiles = <T extends FolderFile>(files: readonly T[], sort: FolderSort): T[] => {
  const list = [...files];
  const byId = (a: T, b: T) => a.id.localeCompare(b.id);
  switch (sort) {
    case 'name': {
      return list.sort(
        (a, b) =>
          (a.originalFileName ?? '').localeCompare(b.originalFileName ?? '', undefined, { numeric: true }) ||
          byId(a, b),
      );
    }
    case 'size': {
      return list.sort((a, b) => (b.fileSizeInByte ?? 0) - (a.fileSizeInByte ?? 0) || byId(a, b));
    }
    case 'date': {
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

/** Prototype `captureDate(asset).day`: the recorded local calendar day, never shifted by time zone. */
export const captureDay = (localDateTime: string | null | undefined): string | null => {
  const match = localDateTime ? /^(\d{4}-\d{2}-\d{2})/.exec(localDateTime) : null;
  return match ? match[1] : null;
};
