import path from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { StorageFolder } from 'src/enum.js';

/**
 * FL-520: where an unplugged drive or an unmounted share makes every file under it look lost.
 * Frameleaf's own folders, which are reachable while their mount file (`.frameleaf`) is there, and each
 * external library's import folders, reachable while they exist.
 */
export type StorageRoot = {
  kind: 'storage' | 'library';
  name: string;
  /** The folder, without a trailing separator. */
  path: string;
  /** What is looked at to tell: the mount file, or the import path as the library keeps it. */
  probe: string;
};

type Stat = { stat: (path: string) => Promise<unknown> };

const STORAGE_FOLDERS = [StorageFolder.Library, StorageFolder.Upload, StorageFolder.EncodedVideo];

/** Frameleaf's own folders first, then each library's import folders, in the order they are kept. */
export const storageRoots = (libraries: Array<{ name: string; importPaths: string[] }>): StorageRoot[] => [
  ...STORAGE_FOLDERS.map((folder) => {
    const base = StorageCore.getBaseFolder(folder);
    return { kind: 'storage' as const, name: '', path: base, probe: `${base}/.frameleaf` };
  }),
  ...libraries.flatMap((library) =>
    library.importPaths.map((importPath) => ({
      kind: 'library' as const,
      name: library.name,
      path: importPath.replace(/\/+$/, ''),
      probe: importPath,
    })),
  ),
];

/** `missing` only when the filesystem says so; any other failure says nothing. */
export const pathState = async (storage: Stat, target: string): Promise<'present' | 'missing' | 'unknown'> => {
  try {
    await storage.stat(target);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'missing' : 'unknown';
  }
};

/** A root is unreachable when its mount file (Frameleaf's own folders) or its folder (a library) is gone. */
export const isRootUnreachable = async (storage: Stat, root: StorageRoot): Promise<boolean> =>
  (await pathState(storage, root.probe)) === 'missing';

/** The roots that cannot be reached now, in `storageRoots` order. */
export const unreachableRoots = async (
  storage: Stat,
  libraries: Array<{ name: string; importPaths: string[] }>,
): Promise<StorageRoot[]> => {
  const unreachable: StorageRoot[] = [];
  for (const root of storageRoots(libraries)) {
    if (await isRootUnreachable(storage, root)) {
      unreachable.push(root);
    }
  }
  return unreachable;
};

const isWithin = (root: string, candidate: string) => {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
};

/**
 * FL-1337: whether the root a file lives under can be reached. A file under no root says nothing about
 * a drive, so it counts as reachable; inside two roots, the most specific one decides.
 */
export const isFileRootReachable = async (
  storage: Stat,
  filePath: string,
  libraries: Array<{ name: string; importPaths: string[] }>,
): Promise<boolean> => {
  const [root] = storageRoots(libraries)
    .filter((candidate) => isWithin(candidate.path, filePath))
    .sort((a, b) => b.path.length - a.path.length);
  return !root || !(await isRootUnreachable(storage, root));
};
